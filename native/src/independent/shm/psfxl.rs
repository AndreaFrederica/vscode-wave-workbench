// SPDX-License-Identifier: MPL-2.0

use super::{bytes, text, Result};
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    fs::File,
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
struct Frame {
    offset: u64,
    size: usize,
    count: usize,
    encoding: FrameEncoding,
}

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
enum FrameEncoding {
    Blosc,
    Lz4,
    Raw64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_each_blosc_codec() {
        let numbers: Vec<f64> = (0..4096).map(|index| f64::from(index % 64)).collect();
        let raw: Vec<u8> = numbers
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        for codec in [c"blosclz", c"lz4", c"lz4hc", c"snappy", c"zlib", c"zstd"] {
            let mut compressed = vec![0; raw.len() + 16];
            // Compression reads raw and writes to the separately allocated destination.
            let size = unsafe {
                blosc_src::blosc_compress_ctx(
                    5,
                    1,
                    8,
                    raw.len(),
                    raw.as_ptr().cast(),
                    compressed.as_mut_ptr().cast(),
                    compressed.len(),
                    codec.as_ptr(),
                    0,
                    1,
                )
            };
            assert!(size > 0 && (size as usize) < raw.len(), "{codec:?}");
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(&compressed[..size as usize]).unwrap();
            let reader = Psfxl {
                data: RefCell::new(BufReader::new(file)),
                size: size as u64,
                traces: Vec::new(),
                names: Vec::new(),
                recovered: false,
                indexes: RefCell::default(),
                axes: RefCell::default(),
                values: RefCell::default(),
                disk: RefCell::default(),
            };
            let actual = reader
                .decompress(Frame {
                    offset: 0,
                    size: size as usize,
                    count: numbers.len(),
                    encoding: FrameEncoding::Blosc,
                })
                .unwrap();
            assert_eq!(actual, numbers, "{codec:?}");
        }
    }
}

#[derive(Clone, Copy)]
enum Column {
    Frame(Frame),
    Constant(f64),
}

#[derive(Clone, Copy)]
struct Block {
    count: usize,
    time: Column,
    value: Column,
}

pub(super) struct Trace {
    pub(super) name: String,
    pub(super) unit: Option<String>,
    pub(super) start: f64,
    pub(super) end: f64,
    pub(super) count: u64,
    last: u64,
}

pub(super) struct Psfxl {
    data: RefCell<BufReader<File>>,
    size: u64,
    pub(super) traces: Vec<Trace>,
    pub(super) names: Vec<(String, usize)>,
    pub(super) recovered: bool,
    indexes: RefCell<HashMap<usize, Arc<Vec<Block>>>>,
    axes: RefCell<FrameCache>,
    values: RefCell<FrameCache>,
    disk: RefCell<DiskCache>,
}

#[derive(Clone, Copy, Default, Serialize)]
pub(super) struct CacheUsage {
    pub bytes: u64,
    pub budget: u64,
    pub entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
}

impl CacheUsage {
    pub(super) fn add(&mut self, other: Self) {
        self.bytes += other.bytes;
        self.budget += other.budget;
        self.entries += other.entries;
        self.hits += other.hits;
        self.misses += other.misses;
        self.evictions += other.evictions;
    }
}

struct DiskCache {
    directory: Option<tempfile::TempDir>,
    entries: VecDeque<(Frame, tempfile::TempPath)>,
    usage: CacheUsage,
}

impl Default for DiskCache {
    fn default() -> Self {
        Self {
            directory: None,
            entries: VecDeque::new(),
            usage: CacheUsage {
                budget: 768 * 1024 * 1024,
                ..CacheUsage::default()
            },
        }
    }
}

impl DiskCache {
    fn trim(&mut self, incoming: u64) {
        while self.usage.bytes + incoming > self.usage.budget {
            let (frame, _) = self.entries.pop_front().unwrap();
            self.usage.bytes -= frame.count as u64 * 8;
            self.usage.evictions += 1;
        }
        self.usage.entries = self.entries.len();
    }

    fn get(&mut self, frame: Frame, decode: impl FnOnce() -> Result<Vec<f64>>) -> Result<Vec<f64>> {
        let size = frame.count as u64 * 8;
        if let Some(index) = self.entries.iter().position(|(key, _)| *key == frame) {
            let entry = self.entries.remove(index).unwrap();
            if let Ok(raw) = std::fs::read(&entry.1) {
                if raw.len() as u64 == size {
                    let values = raw
                        .chunks_exact(8)
                        .map(|sample| f64::from_le_bytes(sample.try_into().unwrap()))
                        .collect();
                    self.entries.push_back(entry);
                    self.usage.hits += 1;
                    return Ok(values);
                }
            }
            self.usage.bytes -= size;
            self.usage.entries = self.entries.len();
        }
        self.usage.misses += 1;
        let values = decode()?;
        if size <= self.usage.budget {
            if let Ok(file) = self.write(&values) {
                self.trim(size);
                self.entries.push_back((frame, file));
                self.usage.bytes += size;
                self.usage.entries = self.entries.len();
            }
        }
        Ok(values)
    }

    fn write(&mut self, values: &[f64]) -> std::io::Result<tempfile::TempPath> {
        if self.directory.is_none() {
            self.directory = Some(tempfile::tempdir()?);
        }
        let mut file = tempfile::NamedTempFile::new_in(self.directory.as_ref().unwrap())?;
        let mut output = BufWriter::new(file.as_file_mut());
        for value in values {
            output.write_all(&value.to_le_bytes())?;
        }
        output.flush()?;
        drop(output);
        Ok(file.into_temp_path())
    }
}

#[derive(Default)]
struct FrameCache {
    limit: usize,
    bytes: usize,
    hits: u64,
    reads: u64,
    evictions: u64,
    entries: VecDeque<(Frame, Arc<Vec<f64>>)>,
}

impl FrameCache {
    fn with_limit(limit: usize) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

    fn trim(&mut self, incoming: usize) {
        while self.bytes.saturating_add(incoming) > self.limit {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.len() * 8;
            self.evictions += 1;
        }
    }

    fn get(
        &mut self,
        frame: Frame,
        read: impl FnOnce() -> Result<Vec<f64>>,
    ) -> Result<Arc<Vec<f64>>> {
        if let Some(index) = self.entries.iter().position(|(key, _)| *key == frame) {
            let entry = self.entries.remove(index).unwrap();
            let value = entry.1.clone();
            self.entries.push_back(entry);
            self.hits += 1;
            return Ok(value);
        }
        let value = Arc::new(read()?);
        self.reads += 1;
        let size = value.len() * 8;
        if size <= self.limit {
            self.trim(size);
            self.bytes += size;
            self.entries.push_back((frame, value.clone()));
        }
        Ok(value)
    }
}

struct Stub<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Stub<'_> {
    fn take(&mut self, size: usize) -> Result<&[u8]> {
        let data = bytes(self.data, self.pos, size)?;
        self.pos += size;
        Ok(data)
    }

    fn word(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn long(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn double(&mut self) -> Result<f64> {
        Ok(f64::from_bits(self.long()?))
    }

    fn string(&mut self) -> Result<String> {
        let len = self.word()? as usize;
        let field = self.take(len.div_ceil(4) * 4)?;
        let name = field[..len]
            .split(|byte| *byte == 0)
            .next()
            .unwrap_or_default();
        Ok(text(name))
    }

    fn properties(&mut self, end: usize) -> Result<HashMap<String, String>> {
        let mut properties = HashMap::new();
        while self.pos + 4 <= end {
            let tag = self.word()?;
            if !(0x21..=0x23).contains(&tag) {
                self.pos -= 4;
                break;
            }
            let name = self.string()?;
            let value = match tag {
                0x21 => self.string()?,
                0x22 => self.word()?.to_string(),
                _ => self.double()?.to_string(),
            };
            if self.pos > end {
                return Err("Truncated PSFXL property".into());
            }
            properties.insert(name, value);
        }
        Ok(properties)
    }

    fn declaration(&mut self) -> Result<(u32, String)> {
        if self.word()? != 0x10 {
            return Err(format!("Invalid PSFXL declaration at {:#x}", self.pos - 4));
        }
        Ok((self.word()?, self.string()?))
    }
}

fn catalog(data: &[u8]) -> Result<(Vec<Trace>, HashMap<u32, usize>, bool)> {
    let mut cursor = Stub { data, pos: 0 };
    let header = cursor.word()?;
    cursor.pos = 0;
    if !matches!(header, 0x300 | 0x400) {
        return Err("Unsupported PSFXL declaration header".into());
    }
    let mut sections = Vec::new();
    for tag in [header, 1, 2, 3] {
        if cursor.word()? != tag || cursor.word()? != 0x15 {
            return Err(format!("Invalid PSFXL section {tag:#x}"));
        }
        let end = (cursor.word()? as usize).saturating_sub(4);
        if !(cursor.pos..=data.len()).contains(&end) {
            return Err("Invalid PSFXL section extent".into());
        }
        sections.push((cursor.pos, end));
        cursor.pos = end;
    }
    cursor.pos = sections[0].0;
    let header = cursor.properties(sections[0].1)?;
    let count = |key: &str| -> Result<usize> {
        header
            .get(key)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| format!("Missing {key}"))
    };
    let mut units = HashMap::new();
    cursor.pos = sections[1].0;
    if cursor.word()? != 0x16 {
        return Err("Invalid PSFXL type table".into());
    }
    let type_end = sections[1].1.min(cursor.word()? as usize);
    for _ in 0..count("PSF types")? {
        let (id, _) = cursor.declaration()?;
        cursor.word()?;
        if cursor.word()? == 14 {
            cursor.word()?;
        }
        if let Some(unit) = cursor.properties(type_end)?.remove("units") {
            units.insert(id, unit);
        }
    }
    cursor.pos = sections[3].0;
    if cursor.word()? != 0x16 {
        return Err("Invalid PSFXL trace table".into());
    }
    let trace_end = sections[3].1.min(cursor.word()? as usize);
    let count = count("PSF traces")?;
    let mut traces = Vec::new();
    let mut ids = HashMap::new();
    let mut members = 0usize;
    let mut indexed = true;
    while traces.len() < count && cursor.pos < trace_end {
        if members == 0 && bytes(data, cursor.pos, 4)? == [0, 0, 0, 0x11] {
            cursor.take(8)?;
            cursor.string()?;
            members = cursor.word()? as usize;
        }
        let (id, name) = cursor.declaration()?;
        let type_id = cursor.word()?;
        let index_position = cursor.pos;
        let (last, count, start, end) =
            if cursor.pos < trace_end && matches!(cursor.word()?, 0x24 | 0x25) {
                let fields = (
                    cursor.long()?,
                    cursor.long()?,
                    cursor.double()?,
                    cursor.double()?,
                );
                cursor.take(16)?;
                fields
            } else {
                // Older stubs declare the traces without storing any sample locations.
                cursor.pos = index_position;
                indexed = false;
                (0, 0, 0.0, 0.0)
            };
        if cursor.pos > trace_end || !start.is_finite() || !end.is_finite() || start > end {
            return Err(format!("Invalid PSFXL index for {name}"));
        }
        cursor.properties(trace_end)?;
        members = members.saturating_sub(1);
        ids.insert(id, traces.len());
        traces.push(Trace {
            name,
            unit: units.get(&type_id).cloned(),
            start,
            end,
            count,
            last,
        });
    }
    if traces.len() != count {
        return Err("PSFXL declaration and trace counts disagree".into());
    }
    Ok((traces, ids, indexed))
}

fn companion(stub: &Path, extension: &str) -> PathBuf {
    let mut name = stub.as_os_str().to_owned();
    name.push(extension);
    name.into()
}

fn hex(token: &str) -> Result<u64> {
    u64::from_str_radix(token, 16).map_err(|_| "Invalid PSFXL chunk field".into())
}

fn reference(offset: u64, token: &str, count: usize, encoding: FrameEncoding) -> Result<Frame> {
    let (distance, size) = token
        .split_once('.')
        .ok_or("Invalid PSFXL buffer reference")?;
    let distance = hex(distance)?;
    let offset = offset
        .checked_sub(distance)
        .filter(|_| distance != 0)
        .ok_or("Invalid PSFXL buffer distance")?;
    let size = usize::try_from(hex(size)?).map_err(|_| "PSFXL buffer size overflows")?;
    Ok(Frame {
        offset,
        size,
        count,
        encoding,
    })
}

impl Psfxl {
    pub(super) fn open(stub: &Path, raw_file: Option<&Path>) -> Result<Self> {
        let (traces, ids, indexed) =
            catalog(&std::fs::read(stub).map_err(|error| error.to_string())?)?;
        let mut names: Vec<_> = traces
            .iter()
            .enumerate()
            .map(|(index, trace)| (trace.name.clone(), index))
            .collect();
        if let Ok(sig) = std::fs::read(companion(stub, ".sig")) {
            let sig = sig
                .into_iter()
                .filter(|&byte| byte != 1)
                .collect::<Vec<_>>();
            for line in String::from_utf8_lossy(&sig).lines() {
                if let Some((name, id)) = line
                    .trim_end()
                    .strip_suffix(" <>")
                    .and_then(|line| line.rsplit_once(' '))
                {
                    if let Some(index) = id.parse::<u32>().ok().and_then(|id| ids.get(&id)) {
                        names.push((name.to_owned(), *index));
                    }
                }
            }
        }
        names.sort();
        names.dedup_by(|a, b| a.0 == b.0);
        let file = match raw_file {
            Some(path) => File::open(path),
            None => File::open(companion(stub, ".psfxl")).or_else(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    File::open(companion(stub, ".dat"))
                } else {
                    Err(error)
                }
            }),
        }
        .map_err(|error| error.to_string())?;
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        let mut data = BufReader::new(file);
        let mut magic = [0; 12];
        data.read_exact(&mut magic)
            .map_err(|error| error.to_string())?;
        if ![b"\0!ngpsf-1.1", b"\0!ngpsf-1.4", b"\0!psfxl-1.4"]
            .iter()
            .any(|signature| magic.starts_with(*signature))
        {
            return Err("Unsupported PSFXL data header".into());
        }
        let mut reader = Self {
            data: RefCell::new(data),
            size,
            traces,
            names,
            recovered: false,
            indexes: RefCell::default(),
            axes: RefCell::new(FrameCache::with_limit(16 * 1024 * 1024)),
            values: RefCell::new(FrameCache::with_limit(48 * 1024 * 1024)),
            disk: RefCell::default(),
        };
        if !indexed {
            reader.recovered = reader.scan_blocks()?;
        } else if let Some((index, trace)) = reader
            .traces
            .iter()
            .enumerate()
            .filter(|(_, trace)| trace.count > 0)
            .max_by_key(|(_, trace)| trace.last)
        {
            if trace.last >= size || reader.chunk_extent(trace.last).is_err() {
                reader.scan_blocks()?;
                reader.recovered = true;
            } else {
                reader.block(trace.last, index)?;
            }
        }
        Ok(reader)
    }

    fn read(&self, offset: u64, size: usize) -> Result<Vec<u8>> {
        if size as u64 > self.size.saturating_sub(offset) || offset > self.size {
            return Err(format!("Truncated PSFXL buffer at {offset:#x}"));
        }
        let mut file = self.data.borrow_mut();
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = vec![0; size];
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
    }

    fn constant(&self, offset: u64, size: usize) -> Result<f64> {
        match size {
            0 => Ok(0.0),
            4 => Ok(f32::from_le_bytes(self.read(offset, 4)?.try_into().unwrap()).into()),
            8 => Ok(f64::from_le_bytes(
                self.read(offset, 8)?.try_into().unwrap(),
            )),
            _ => Err(format!("Unsupported PSFXL constant width {size}")),
        }
    }

    fn record_line(&self, offset: u64) -> Result<Vec<u8>> {
        let mut line = Vec::new();
        {
            let mut file = self.data.borrow_mut();
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| error.to_string())?;
            file.by_ref()
                .take(256)
                .read_until(b'\n', &mut line)
                .map_err(|error| error.to_string())?;
        }
        if line.first() != Some(&0) || line.last() != Some(&b'\n') {
            return Err(format!("Missing PSFXL chunk at {offset:#x}"));
        }
        Ok(line)
    }

    fn chunk_extent(&self, offset: u64) -> Result<(u64, usize, u64)> {
        let line = self.record_line(offset)?;
        let header =
            std::str::from_utf8(&line[1..line.len() - 1]).map_err(|error| error.to_string())?;
        let mut fields = header.split(':');
        let kind = fields
            .next()
            .ok_or("Missing PSFXL record kind")?
            .trim_start_matches('\0');
        let kind = if kind.starts_with('!') && offset == 0 {
            0
        } else if matches!(
            kind,
            "VersionIdent" | "SubVersion" | "size_t = 8" | "db source version"
        ) {
            0
        } else {
            hex(kind)?
        };
        let index = usize::try_from(hex(fields.next().ok_or("Missing PSFXL channel")?)?)
            .map_err(|_| "Invalid PSFXL channel")?;
        let size = hex(fields.nth(2).ok_or("Missing PSFXL record size")?)?;
        let body = (offset + line.len() as u64 + 8) & !7;
        let end = body
            .checked_add(size)
            .filter(|end| *end <= self.size)
            .ok_or("Truncated PSFXL record")?;
        Ok((kind, index, end))
    }

    fn scan_blocks(&mut self) -> Result<bool> {
        let (_, _, mut offset) = self.chunk_extent(0)?;
        let mut histories = vec![Vec::new(); self.traces.len()];
        while offset < self.size {
            let Ok((kind, index, next)) = self.chunk_extent(offset) else {
                break;
            };
            if kind == 1 {
                for (index, history) in histories.iter_mut().enumerate() {
                    if let Ok((_, block)) = self.block(offset, index) {
                        history.push(block);
                    }
                }
            } else if kind == 3 && index < histories.len() {
                let (_, block) = self.block(offset, index)?;
                histories[index].push(block);
            } else if kind != 0 {
                break;
            }
            offset = next;
        }
        if histories.iter().all(Vec::is_empty) {
            return Err("Truncated PSFXL has no complete sample blocks".into());
        }
        for (index, history) in histories.into_iter().enumerate() {
            let start = match history.first() {
                Some(block) => match block.time {
                    Column::Constant(time) => Some(time),
                    Column::Frame(_) => self
                        .frame(block.time, true)?
                        .and_then(|times| times.first().copied()),
                },
                None => None,
            };
            let end = match history.last() {
                Some(block) => match block.time {
                    Column::Constant(time) => Some(time),
                    Column::Frame(_) => self
                        .frame(block.time, true)?
                        .and_then(|times| times.last().copied()),
                },
                None => None,
            };
            let trace = &mut self.traces[index];
            trace.count = history.iter().map(|block| block.count as u64).sum();
            trace.start = start.unwrap_or(trace.start);
            trace.end = end.unwrap_or(trace.start);
            self.indexes.get_mut().insert(index, Arc::new(history));
        }
        Ok(offset != self.size)
    }

    fn block(&self, offset: u64, index: usize) -> Result<(u64, Block)> {
        let line = self.record_line(offset)?;
        let header =
            std::str::from_utf8(&line[1..line.len() - 1]).map_err(|error| error.to_string())?;
        let fields: Vec<_> = header.split(':').collect();
        let field = |index: usize| -> Result<u64> {
            hex(fields
                .get(index)
                .copied()
                .ok_or("Incomplete PSFXL chunk header")?)
        };
        let mode = field(0)?;
        let channel = field(1)?;
        let previous = field(2)?;
        let count = usize::try_from(field(3)?).map_err(|_| "Invalid PSFXL sample count")?;
        let size = usize::try_from(field(4)?).map_err(|_| "Invalid PSFXL payload size")?;
        let body = (offset + line.len() as u64 + 8) & !7;
        if count == 0
            || body > self.size
            || size as u64 > self.size - body
            || previous != u64::MAX && previous >= offset
        {
            return Err(format!("Truncated or invalid PSFXL chunk at {offset:#x}"));
        }
        let (time, value) = match mode {
            1 if count == 1 && (index + 2) * 8 <= size => (
                Column::Constant(self.constant(body, 8)?),
                Column::Constant(self.constant(body + (index as u64 + 1) * 8, 8)?),
            ),
            1 => {
                let width = count
                    .checked_mul(8)
                    .ok_or("PSFXL raw column exceeds address space")?;
                if size % width != 0 || index + 2 > size / width {
                    return Err(format!("Invalid PSFXL raw columns at {offset:#x}"));
                }
                let column = |index| {
                    Column::Frame(Frame {
                        offset: body + (index * width) as u64,
                        size: width,
                        count,
                        encoding: FrameEncoding::Raw64,
                    })
                };
                (column(0), column(index + 1))
            }
            3 if channel == index as u64 && fields.len() == 5 && count == 1 && size == 16 => (
                Column::Constant(self.constant(body, 8)?),
                Column::Constant(self.constant(body + 8, 8)?),
            ),
            3 if channel == index as u64 && fields.len() >= 7 => {
                let flags = field(5)?;
                let time_encoding = match (flags >> 4) & 7 {
                    1 => FrameEncoding::Lz4,
                    2 => FrameEncoding::Blosc,
                    _ => {
                        return Err(format!(
                            "Unsupported PSFXL time encoding {flags:#x} at {offset:#x}"
                        ))
                    }
                };
                let (time, value_offset, value_size) = if flags & 0x80 == 0 {
                    let time_size =
                        usize::try_from(field(6)?).map_err(|_| "Invalid PSFXL time frame size")?;
                    let value_size = size
                        .checked_sub(time_size)
                        .ok_or("Invalid PSFXL frame split")?;
                    (
                        Frame {
                            offset: body,
                            size: time_size,
                            count,
                            encoding: time_encoding,
                        },
                        body + time_size as u64,
                        value_size,
                    )
                } else {
                    (
                        reference(offset, fields[6], count, time_encoding)?,
                        body,
                        size,
                    )
                };
                let value = match flags & 0xf {
                    0 => Column::Constant(self.constant(value_offset, value_size)?),
                    kind @ (1 | 2) => Column::Frame(Frame {
                        offset: value_offset,
                        size: value_size,
                        count,
                        encoding: if kind == 1 {
                            FrameEncoding::Lz4
                        } else {
                            FrameEncoding::Blosc
                        },
                    }),
                    kind @ (9 | 10) => Column::Frame(reference(
                        offset,
                        fields.get(7).ok_or("Missing PSFXL value reference")?,
                        count,
                        if kind == 9 {
                            FrameEncoding::Lz4
                        } else {
                            FrameEncoding::Blosc
                        },
                    )?),
                    _ => return Err(format!("Unsupported PSFXL flags {flags:#x} at {offset:#x}")),
                };
                (Column::Frame(time), value)
            }
            _ => return Err(format!("Unsupported PSFXL chunk at {offset:#x}")),
        };
        Ok((previous, Block { count, time, value }))
    }

    fn blocks(&self, index: usize) -> Result<Arc<Vec<Block>>> {
        if let Some(blocks) = self.indexes.borrow().get(&index) {
            return Ok(blocks.clone());
        }
        let trace = &self.traces[index];
        let mut remaining = trace.count;
        let mut offset = trace.last;
        let mut blocks = Vec::new();
        while offset != u64::MAX && remaining != 0 {
            let (previous, block) = self.block(offset, index)?;
            remaining = remaining
                .checked_sub(block.count as u64)
                .ok_or("Invalid PSFXL indexed sample count")?;
            blocks.push(block);
            offset = previous;
        }
        if remaining != 0 || trace.count != 0 && offset != u64::MAX {
            return Err("PSFXL index and sample count disagree".into());
        }
        blocks.reverse();
        let blocks = Arc::new(blocks);
        self.indexes.borrow_mut().insert(index, blocks.clone());
        Ok(blocks)
    }

    fn decompress(&self, frame: Frame) -> Result<Vec<f64>> {
        let (output, width) = match frame.encoding {
            FrameEncoding::Blosc => self.decompress_blosc(frame)?,
            FrameEncoding::Lz4 => {
                let max_len = frame
                    .count
                    .checked_mul(8)
                    .filter(|size| *size <= i32::MAX as usize)
                    .ok_or("PSFXL LZ4 output size overflows")?;
                let mut output = vec![0; max_len];
                let input = self.read(frame.offset, frame.size)?;
                let length =
                    lz4_flex::block::decompress_into(&input, &mut output).map_err(|error| {
                        format!("Invalid PSFXL LZ4 block at {:#x}: {error}", frame.offset)
                    })?;
                if length != max_len && length != max_len / 2 {
                    return Err(format!(
                        "Invalid PSFXL LZ4 sample count at {:#x}",
                        frame.offset
                    ));
                }
                output.truncate(length);
                (output, if length == max_len { 8 } else { 4 })
            }
            FrameEncoding::Raw64 => (self.read(frame.offset, frame.size)?, 8),
        };
        Ok(if width == 8 {
            output
                .chunks_exact(8)
                .map(|bytes| f64::from_le_bytes(bytes.try_into().unwrap()))
                .collect()
        } else {
            output
                .chunks_exact(4)
                .map(|bytes| f64::from(f32::from_le_bytes(bytes.try_into().unwrap())))
                .collect()
        })
    }

    fn decompress_blosc(&self, frame: Frame) -> Result<(Vec<u8>, usize)> {
        let header = self.read(frame.offset, 16)?;
        let width = usize::from(header[3]);
        let output_len = frame
            .count
            .checked_mul(width)
            .ok_or("PSFXL output size overflows")?;
        if !matches!(width, 4 | 8)
            || u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize != output_len
            || u32::from_le_bytes(header[12..16].try_into().unwrap()) as usize != frame.size
            || frame.size < 16
            || output_len > i32::MAX as usize
        {
            return Err(format!("Invalid PSFXL Blosc frame at {:#x}", frame.offset));
        }
        let data = self.read(frame.offset, frame.size)?;
        let mut validated = 0usize;
        // Both C operations are confined to the validated compressed buffer and sized output allocation.
        let valid = unsafe {
            blosc_src::blosc_cbuffer_validate(data.as_ptr().cast(), data.len(), &mut validated)
        };
        if valid != 0 || validated != output_len {
            return Err(format!(
                "Invalid PSFXL compressed buffer at {:#x}",
                frame.offset
            ));
        }
        let mut output = vec![0u8; output_len];
        let written = unsafe {
            blosc_src::blosc_decompress_ctx(
                data.as_ptr().cast(),
                output.as_mut_ptr().cast(),
                output_len,
                1,
            )
        };
        if written < 0 || written as usize != output_len {
            return Err(format!(
                "PSFXL Blosc decompression failed at {:#x}",
                frame.offset
            ));
        }
        Ok((output, width))
    }

    fn frame(&self, column: Column, time: bool) -> Result<Option<Arc<Vec<f64>>>> {
        let Column::Frame(frame) = column else {
            return Ok(None);
        };
        let cache = if time { &self.axes } else { &self.values };
        cache
            .borrow_mut()
            .get(frame, || {
                self.disk.borrow_mut().get(frame, || self.decompress(frame))
            })
            .map(Some)
    }

    pub(super) fn scan(
        &self,
        index: usize,
        start: u64,
        end: u64,
        ticks_per_second: f64,
        mut sample: impl FnMut(u64, f64) -> bool,
    ) -> Result<()> {
        let trace = &self.traces[index];
        let tick = |t: f64| (t * ticks_per_second).round() as u64;
        if end < tick(trace.start) || start > tick(trace.end) {
            return Ok(());
        }
        let blocks = self.blocks(index)?;
        let mut prior = None;
        let mut visited = false;
        for block in blocks.iter().copied() {
            let time_frame = self.frame(block.time, true)?;
            let time = |i| match &time_frame {
                Some(times) => tick(times[i]),
                None => match block.time {
                    Column::Constant(value) => tick(value),
                    _ => unreachable!(),
                },
            };
            if time(0) > end {
                break;
            }
            if time(block.count - 1) < start {
                prior = Some((block, time(block.count - 1), block.count - 1));
                continue;
            }
            let first = time_frame
                .as_ref()
                .map_or(0, |times| times.partition_point(|&t| tick(t) < start));
            let value_frame = self.frame(block.value, false)?;
            let value = |i| match &value_frame {
                Some(values) => values[i],
                None => match block.value {
                    Column::Constant(value) => value,
                    _ => unreachable!(),
                },
            };
            if !visited {
                if first > 0 {
                    if !sample(time(first - 1), value(first - 1)) {
                        return Ok(());
                    }
                } else if time(0) > start {
                    if let Some((block, tick, index)) = prior.take() {
                        let value = match block.value {
                            Column::Constant(value) => value,
                            Column::Frame(_) => self.frame(block.value, false)?.unwrap()[index],
                        };
                        if !sample(tick, value) {
                            return Ok(());
                        }
                    }
                }
            }
            visited = true;
            for i in first..block.count {
                let tick = time(i);
                if tick > end || !sample(tick, value(i)) {
                    return Ok(());
                }
            }
        }
        if !visited {
            if let Some((block, tick, index)) = prior {
                let value = match block.value {
                    Column::Constant(value) => value,
                    Column::Frame(_) => self.frame(block.value, false)?.unwrap()[index],
                };
                sample(tick, value);
            }
        }
        Ok(())
    }

    pub(super) fn configure_cache(&self, disk: Option<u64>, memory: Option<usize>) {
        if let Some(budget) = memory {
            let mut axes = self.axes.borrow_mut();
            let mut values = self.values.borrow_mut();
            axes.limit = budget / 4;
            values.limit = budget - axes.limit;
            axes.trim(0);
            values.trim(0);
        }
        if let Some(budget) = disk {
            let mut disk = self.disk.borrow_mut();
            disk.usage.budget = budget;
            disk.trim(0);
        }
    }

    pub(super) fn cache_stats(&self) -> (CacheUsage, CacheUsage) {
        let axes = self.axes.borrow();
        let values = self.values.borrow();
        let disk = self.disk.borrow();
        (
            CacheUsage {
                bytes: (axes.bytes + values.bytes) as u64,
                budget: (axes.limit + values.limit) as u64,
                entries: axes.entries.len() + values.entries.len(),
                hits: axes.hits + values.hits,
                misses: axes.reads + values.reads,
                evictions: axes.evictions + values.evictions,
            },
            disk.usage,
        )
    }
}
