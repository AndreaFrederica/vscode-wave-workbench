// SPDX-License-Identifier: MPL-2.0

use super::{
    header::{Header, HEADER_SIZE},
    reader::{invalid, read_u32, read_u64},
};
use serde::Serialize;
use std::{io, ops::Range};

const MAX_BLOCK: usize = 64 * 1024 * 1024;

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

pub(super) struct Directory {
    pub(super) dictionary_decoded_bytes: u32,
    pub(super) dictionary_stored_bytes: u32,
    pub(super) dictionary_extensions: Range<u64>,
    pub(super) window_extensions: Range<u64>,
    pub(super) snapshots: Vec<Snapshot>,
    pub(super) windows: Vec<TimeWindow>,
}

impl Directory {
    pub(super) fn parse(bytes: &[u8], header: &Header) -> io::Result<Self> {
        let (base, windows, dictionary) = (header.directory, header.windows, header.dictionary);
        let mut snapshot_reader = TableReader::new(&bytes[..(windows - base) as usize], base, base);
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

        let mut window_reader = TableReader::new(
            &bytes[(windows - base) as usize..(dictionary - base) as usize],
            windows,
            base,
        );
        let mut windows_data = Vec::new();
        for _ in 0..header.window_count {
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
            windows_data.push(window);
        }
        let mut dictionary_reader =
            TableReader::new(&bytes[(dictionary - base) as usize..], dictionary, base);
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
            dictionary_decoded_bytes: decoded_bytes,
            dictionary_stored_bytes: stored_bytes,
            dictionary_extensions: dictionary_reader.position()..header.graph,
            window_extensions: window_reader.position()..dictionary,
            snapshots,
            windows: windows_data,
        })
    }
}

struct TableReader<'a> {
    remaining: &'a [u8],
    position: u64,
    data_limit: u64,
}

impl<'a> TableReader<'a> {
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
