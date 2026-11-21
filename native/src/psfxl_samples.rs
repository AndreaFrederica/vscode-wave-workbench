// SPDX-License-Identifier: MPL-2.0

use std::{
    collections::VecDeque,
    fs::File,
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
};
use serde::Serialize;

const RECORD_BYTES: u64 = 16;
const INDEX_STRIDE: u64 = 1024;
const MIB: u64 = 1024 * 1024;
const DEFAULT_BYTES: u64 = 768 * MIB;
const MAX_BYTES: u64 = 1 << 40;
const MEMORY_DEFAULT_BYTES: u64 = 64 * MIB;

pub struct SampleWriter {
    file: BufWriter<File>,
    index: Vec<u64>,
    len: u64,
    max_bytes: u64,
}

impl SampleWriter {
    pub fn new(directory: &Path, max_bytes: u64) -> io::Result<Self> {
        Ok(Self {
            file: BufWriter::with_capacity(128 * 1024, tempfile::tempfile_in(directory)?),
            index: Vec::new(),
            len: 0,
            max_bytes,
        })
    }

    pub fn push(&mut self, tick: u64, value: f64) -> io::Result<()> {
        if self.len == self.max_bytes / RECORD_BYTES {
            return Err(io::Error::other(
                "PSFXL window exceeds the sample cache size",
            ));
        }
        if self.len % INDEX_STRIDE == 0 {
            self.index.push(tick);
        }
        self.file.write_all(&tick.to_le_bytes())?;
        self.file.write_all(&value.to_le_bytes())?;
        self.len += 1;
        Ok(())
    }
}

struct Window {
    id: String,
    start: u64,
    end: u64,
    file: File,
    index: Vec<u64>,
    bytes: u64,
}

#[derive(Default, Serialize)]
pub struct SampleCacheStats {
    pub budget: u64,
    pub bytes: u64,
    pub entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

impl SampleCacheStats {
    fn record_lookup(&mut self, cached: bool) {
        if cached {
            self.hits += 1;
        } else {
            self.misses += 1;
        }
    }
}

type Sample = (u64, f64);

struct MemoryWindow {
    id: String,
    start: u64,
    end: u64,
    samples: Vec<Sample>,
}

impl MemoryWindow {
    fn bytes(&self) -> u64 {
        (std::mem::size_of::<Self>() + self.id.capacity()
            + self.samples.capacity() * std::mem::size_of::<Sample>()) as u64
    }

    fn scan(&self, start: u64, end: u64, visit: &mut impl FnMut(u64, f64)) {
        let first = if start == self.start {
            0
        } else {
            self.samples.partition_point(|&(tick, _)| tick < start)
        };
        if first > 0 && self.samples.get(first).is_none_or(|&(tick, _)| tick > start) {
            visit(start, self.samples[first - 1].1);
        }
        for &(tick, value) in self.samples[first..].iter().take_while(|&&(tick, _)| tick <= end) {
            visit(tick, value);
        }
    }
}

pub struct SampleCollector {
    window: MemoryWindow,
    limit: usize,
}

impl SampleCollector {
    pub fn push(&mut self, tick: u64, value: f64) -> bool {
        let samples = &mut self.window.samples;
        if samples.len() == self.limit {
            return false;
        }
        if samples.len() == samples.capacity() {
            let capacity = (samples.capacity() * 2).max(256).min(self.limit);
            if samples.try_reserve_exact(capacity - samples.len()).is_err() {
                return false;
            }
        }
        samples.push((tick, value));
        true
    }
}

pub struct MemorySampleCache {
    windows: VecDeque<MemoryWindow>,
    stats: SampleCacheStats,
}

impl Default for MemorySampleCache {
    fn default() -> Self {
        Self {
            windows: VecDeque::new(),
            stats: SampleCacheStats { budget: MEMORY_DEFAULT_BYTES, ..SampleCacheStats::default() },
        }
    }
}

impl MemorySampleCache {
    pub fn stats(&self) -> &SampleCacheStats {
        &self.stats
    }

    pub fn configure(&mut self, budget: u64) {
        self.stats.budget = budget.min(MAX_BYTES).min(isize::MAX as u64);
        while self.stats.bytes > self.stats.budget {
            self.evict();
        }
    }

    pub fn scan(&mut self, id: &str, start: u64, end: u64, visit: &mut impl FnMut(u64, f64)) -> bool {
        let position = self.windows.iter().rposition(|window| {
            window.id == id && window.start <= start && window.end >= end
        });
        self.stats.record_lookup(position.is_some());
        let Some(position) = position else {
            return false;
        };
        let window = self.windows.remove(position).unwrap();
        window.scan(start, end, visit);
        self.windows.push_back(window);
        true
    }

    pub fn collector(&self, id: &str, start: u64, end: u64) -> Option<SampleCollector> {
        let window = MemoryWindow { id: id.into(), start, end, samples: Vec::new() };
        let limit = (self.stats.budget.saturating_sub(window.bytes())
            / std::mem::size_of::<Sample>() as u64) as usize;
        (limit > 0 && start < end).then_some(SampleCollector { window, limit })
    }

    pub fn insert(&mut self, collector: SampleCollector) {
        let mut window = collector.window;
        if window.samples.is_empty() {
            return;
        }
        window.samples.shrink_to_fit();
        let bytes = window.bytes();
        if bytes > self.stats.budget {
            return;
        }
        let limit = (self.stats.budget / (4 * MIB)).max(128);
        while self.stats.bytes + bytes > self.stats.budget || self.windows.len() as u64 >= limit {
            self.evict();
        }
        self.stats.bytes += bytes;
        self.windows.push_back(window);
        self.stats.entries = self.windows.len();
    }

    fn evict(&mut self) {
        self.stats.bytes -= self.windows.pop_front().unwrap().bytes();
        self.stats.evictions += 1;
        self.stats.entries = self.windows.len();
    }
}

pub struct SampleCache {
    windows: VecDeque<Window>,
    stats: SampleCacheStats,
}

impl Default for SampleCache {
    fn default() -> Self {
        Self {
            windows: VecDeque::new(),
            stats: SampleCacheStats {
                budget: DEFAULT_BYTES,
                ..SampleCacheStats::default()
            },
        }
    }
}

impl SampleCache {
    pub fn stats(&self) -> &SampleCacheStats {
        &self.stats
    }

    pub fn configure(&mut self, budget: u64) {
        self.stats.budget = budget.min(MAX_BYTES);
        while self.stats.bytes > self.stats.budget {
            self.evict();
        }
    }

    pub fn record_lookup(&mut self, cached: bool) {
        self.stats.record_lookup(cached);
    }

    pub fn insert_file(
        &mut self,
        id: &str,
        start: u64,
        end: u64,
        mut file: File,
    ) -> io::Result<()> {
        let bytes = file.metadata()?.len();
        if bytes == 0 || bytes > self.stats.budget || bytes % RECORD_BYTES != 0 {
            return Err(io::Error::other("invalid SRR sample data length"));
        }
        let mut index = Vec::new();
        let mut tick = [0; 8];
        for offset in (0..bytes).step_by((INDEX_STRIDE * RECORD_BYTES) as usize) {
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut tick)?;
            index.push(u64::from_le_bytes(tick));
        }
        self.store(Window {
            id: id.into(),
            start,
            end,
            file,
            index,
            bytes,
        });
        Ok(())
    }

    pub fn insert(&mut self, id: &str, start: u64, end: u64, writer: SampleWriter) {
        let Ok(file) = writer.file.into_inner() else {
            return;
        };
        let bytes = writer.len * RECORD_BYTES;
        if bytes == 0 || bytes > self.stats.budget {
            return;
        }
        self.store(Window {
            id: id.into(),
            start,
            end,
            file,
            index: writer.index,
            bytes,
        });
    }

    fn store(&mut self, window: Window) {
        let limit = (self.stats.budget / (8 * MIB)).max(128);
        while self.stats.bytes + window.bytes > self.stats.budget || self.windows.len() as u64 >= limit {
            self.evict();
        }
        self.stats.bytes += window.bytes;
        self.windows.push_back(window);
        self.stats.entries = self.windows.len();
    }

    fn evict(&mut self) {
        let oldest = self.windows.pop_front().expect("cache budget exceeded");
        self.stats.bytes -= oldest.bytes;
        self.stats.entries = self.windows.len();
        self.stats.evictions += 1;
    }

    pub fn scan(
        &mut self,
        id: &str,
        start: u64,
        end: u64,
        visit: &mut impl FnMut(u64, f64),
    ) -> io::Result<bool> {
        let Some(position) = self
            .windows
            .iter()
            .rposition(|window| window.id == id && window.start <= start && window.end >= end)
        else {
            return Ok(false);
        };
        let mut window = self.windows.remove(position).expect("indexed cache entry");
        let result = window.scan(start, end, visit);
        if result.is_ok() {
            self.windows.push_back(window);
        } else {
            self.stats.bytes -= window.bytes;
            self.stats.entries = self.windows.len();
        }
        result.map(|_| true)
    }
}

impl Window {
    fn scan(&mut self, start: u64, end: u64, visit: &mut impl FnMut(u64, f64)) -> io::Result<()> {
        let block = self
            .index
            .partition_point(|&tick| tick < start)
            .saturating_sub(1);
        let offset = block as u64 * INDEX_STRIDE * RECORD_BYTES;
        self.file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::with_capacity(128 * 1024, &self.file);
        let mut record = [0; RECORD_BYTES as usize];
        let mut initial = None;
        for _ in 0..(self.bytes - offset) / RECORD_BYTES {
            reader.read_exact(&mut record)?;
            let (time, value) = record.split_at(8);
            let tick = u64::from_le_bytes(time.try_into().unwrap());
            let value = f64::from_le_bytes(value.try_into().unwrap());
            if tick < start {
                initial = Some(value);
                continue;
            }
            if let Some(previous) = initial.take() {
                if tick > start {
                    visit(start, previous);
                }
            }
            if tick > end {
                return Ok(());
            }
            visit(tick, value);
        }
        if let Some(value) = initial {
            visit(start, value);
        }
        Ok(())
    }
}
