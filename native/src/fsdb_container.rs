// SPDX-License-Identifier: MPL-2.0

use serde::Serialize;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    ops::Range,
    path::Path,
};

const HEADER_SIZE: usize = 0x900;
const MAX_BLOCK: usize = 64 * 1024 * 1024;
const MAX_DIRECTORY: u64 = 16 * 1024 * 1024;

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub offset: u64,
    pub stored_bytes: u32,
    pub table_offset: u64,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub signal_word: u64,
    pub id_offset: u64,
    pub scopes: Vec<Block>,
    pub variables: Vec<Block>,
    pub auxiliary: Vec<Block>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    pub anchor: u64,
    pub end_low: u32,
    pub value_page_base: u32,
    pub values: Vec<Block>,
    pub indexes: Vec<Block>,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub file_bytes: u64,
    pub start: u64,
    pub end: u64,
    pub timescale: String,
    pub header_max_id: u32,
    pub graph_offset: u64,
    pub dictionary_offset: u64,
    pub dictionary_decoded_bytes: u32,
    pub dictionary_stored_bytes: u32,
    pub dictionary_extensions: Range<u64>,
    pub window_extensions: Range<u64>,
    pub snapshots: Vec<Snapshot>,
    pub windows: Vec<TimeWindow>,
}

impl Container {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let size = file.metadata()?.len();
        Self::read(&mut file, size)
    }

    pub fn read(file: &mut (impl Read + Seek), size: u64) -> io::Result<Self> {
        let mut header = [0; HEADER_SIZE];
        read_at(file, size, 0, &mut header)?;
        if header[4..12] != [0x1c, 0x3e, 0xd9, 0x48, 4, 3, 2, 1] || read_u32(&header, 0x28) != 86 {
            return Err(invalid("unrecognized FSDB container magic/version"));
        }
        let timescale = timescale(&header[0x4c..0x60])?;
        let start = timestamp(&header, 0x800);
        let end = timestamp(&header, 0x808);
        if start > end {
            return Err(invalid("FSDB header time bounds are reversed"));
        }
        let base = read_u64(&header, 0x400);
        let windows = read_u64(&header, 0x408);
        let dictionary = read_u64(&header, 0x478);
        let graph = read_u64(&header, 0x508);
        let window_count = read_u32(&header, 0x898);
        if window_count == 0 || window_count > 100_000 {
            return Err(invalid("FSDB window count exceeds budget"));
        }
        if !(HEADER_SIZE as u64 <= base
            && base < windows
            && windows < dictionary
            && dictionary < graph
            && graph < size
            && graph - base <= MAX_DIRECTORY)
        {
            return Err(invalid("FSDB directory pointers exceed bounds"));
        }
        let mut graph_tag = [0; 8];
        read_at(file, size, graph, &mut graph_tag)?;
        if &graph_tag != b"GMAPHEAD" {
            return Err(invalid("FSDB graph boundary mismatch"));
        }
        let mut bytes = vec![0; (graph - base) as usize];
        read_at(file, size, base, &mut bytes)?;
        let mut snapshot_reader = Directory::new(&bytes[..(windows - base) as usize], base, base);
        let mut snapshots = Vec::new();
        let mut id_offset = 0;
        while !snapshot_reader.finished() {
            if snapshots.len() >= 100_000 || snapshot_reader.bytes(1)? != [0xf0] {
                return Err(invalid("unrecognized FSDB declaration snapshot"));
            }
            let signal_word = snapshot_reader.u64()?;
            if signal_word > (1 << 32) - id_offset {
                return Err(invalid("FSDB declaration snapshot ID range exceeds bounds"));
            }
            snapshots.push(Snapshot {
                signal_word,
                id_offset,
                scopes: snapshot_reader.table(4)?,
                variables: snapshot_reader.table(4)?,
                auxiliary: snapshot_reader.table(4)?,
            });
            id_offset += signal_word;
        }

        let mut window_reader = Directory::new(
            &bytes[(windows - base) as usize..(dictionary - base) as usize],
            windows,
            base,
        );
        let mut time_windows = Vec::new();
        for _ in 0..window_count {
            let header = window_reader.bytes(22)?;
            if read_u32(header, 0) != 15 || header[4] != 0 || header[17] != 0 {
                return Err(invalid("unrecognized FSDB time-window flags"));
            }
            let window = TimeWindow {
                anchor: read_u64(header, 5),
                end_low: read_u32(header, 13),
                value_page_base: read_u32(header, 18),
                values: window_reader.table(2)?,
                indexes: window_reader.table(2)?,
            };
            if window.indexes.is_empty() {
                return Err(invalid("FSDB time window has no index blocks"));
            }
            time_windows.push(window);
        }
        let mut dictionary_reader =
            Directory::new(&bytes[(dictionary - base) as usize..], dictionary, base);
        let decoded_bytes = dictionary_reader.u32()?;
        let stored_bytes = dictionary_reader.u32()?;
        if !(1..=MAX_BLOCK as u32).contains(&decoded_bytes)
            || !(2..=MAX_BLOCK as u32).contains(&stored_bytes)
        {
            return Err(invalid("FSDB dictionary length exceeds budget"));
        }
        dictionary_reader.bytes(stored_bytes as usize)?;
        if dictionary_reader.bytes(4)? != [0; 4] {
            return Err(invalid("unrecognized FSDB directory trailer"));
        }
        Ok(Self {
            file_bytes: size,
            start,
            end,
            timescale,
            header_max_id: read_u32(&header, 0x8a4),
            graph_offset: graph,
            dictionary_offset: dictionary + 8,
            dictionary_decoded_bytes: decoded_bytes,
            dictionary_stored_bytes: stored_bytes,
            dictionary_extensions: dictionary_reader.position()..graph,
            window_extensions: window_reader.position()..dictionary,
            snapshots,
            windows: time_windows,
        })
    }
}

struct Directory<'a> {
    remaining: &'a [u8],
    position: u64,
    data_limit: u64,
}

impl<'a> Directory<'a> {
    fn new(remaining: &'a [u8], position: u64, data_limit: u64) -> Self {
        Self {
            remaining,
            position,
            data_limit,
        }
    }

    fn position(&self) -> u64 {
        self.position
    }

    fn finished(&self) -> bool {
        self.remaining.is_empty()
    }

    fn bytes(&mut self, count: usize) -> io::Result<&'a [u8]> {
        if count > self.remaining.len() {
            return Err(invalid("truncated FSDB directory field"));
        }
        let (prefix, rest) = self.remaining.split_at(count);
        self.remaining = rest;
        self.position += count as u64;
        Ok(prefix)
    }

    fn u32(&mut self) -> io::Result<u32> {
        Ok(read_u32(self.bytes(4)?, 0))
    }

    fn u64(&mut self) -> io::Result<u64> {
        Ok(read_u64(self.bytes(8)?, 0))
    }

    fn table(&mut self, count_width: usize) -> io::Result<Vec<Block>> {
        let count = if count_width == 4 {
            self.u32()? as usize
        } else {
            u16::from_le_bytes(self.bytes(2)?.try_into().unwrap()) as usize
        };
        if count > 1_000_000 || count > self.remaining.len() / 12 {
            return Err(invalid("FSDB block-table count exceeds bounds"));
        }
        let mut blocks = Vec::with_capacity(count);
        for _ in 0..count {
            let table_offset = self.position();
            let offset = self.u64()?;
            let stored_bytes = self.u32()?;
            if !(HEADER_SIZE as u64..self.data_limit).contains(&offset)
                || !(2..=MAX_BLOCK as u32).contains(&stored_bytes)
                || u64::from(stored_bytes) > self.data_limit - offset
            {
                return Err(invalid("FSDB indexed block exceeds data region"));
            }
            blocks.push(Block {
                offset,
                stored_bytes,
                table_offset,
            });
        }
        Ok(blocks)
    }
}

fn read_at(
    file: &mut (impl Read + Seek),
    size: u64,
    offset: u64,
    output: &mut [u8],
) -> io::Result<()> {
    if offset > size || output.len() as u64 > size - offset {
        return Err(invalid("FSDB file range exceeds bounds"));
    }
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(output)
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn timestamp(bytes: &[u8], offset: usize) -> u64 {
    u64::from(read_u32(bytes, offset)) << 32 | u64::from(read_u32(bytes, offset + 4))
}

fn timescale(field: &[u8]) -> io::Result<String> {
    let length = field
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| invalid("unterminated FSDB timescale"))?;
    let value =
        std::str::from_utf8(&field[..length]).map_err(|_| invalid("invalid FSDB timescale"))?;
    let digits = value
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0
        || value.starts_with('0')
        || !matches!(
            value[digits..].trim_start_matches(|c: char| c.is_ascii_whitespace()),
            "s" | "ms" | "us" | "ns" | "ps" | "fs" | "as" | "zs"
        )
    {
        return Err(invalid("unverified FSDB timescale"));
    }
    Ok(value.to_owned())
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
