// SPDX-License-Identifier: MPL-2.0

mod connections;
mod declarations;
mod events;
mod plain;
mod templates;

use super::{
    bytes::invalid,
    codec::{Codec, Compression, MAX_BLOCK},
};
use crate::fsdb_container::Container;
pub use declarations::Declaration;
pub use events::Events;
use std::collections::HashMap;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

pub struct FileReader {
    file: File,
    pub container: Container,
    codec: Codec,
}

impl FileReader {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        let container = Container::read(&mut file, length)?;
        let codec = Codec::open()?;
        Ok(Self {
            file,
            container,
            codec,
        })
    }

    fn read(&mut self, offset: u64, length: usize) -> io::Result<Vec<u8>> {
        if length > MAX_BLOCK
            || offset > self.container.file_bytes
            || length as u64 > self.container.file_bytes - offset
        {
            return Err(invalid("FSDB file range exceeds bounds"));
        }
        let mut bytes = vec![0; length];
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    fn block_at(
        &mut self,
        offset: u64,
        stored_bytes: u32,
        algorithm: Compression,
    ) -> io::Result<Vec<u8>> {
        let bytes = self.read(offset, stored_bytes as usize)?;
        self.codec.fsdb(algorithm, &bytes, None)
    }
}

pub struct Session {
    file: FileReader,
    pub declarations: Vec<Declaration>,
    widths: HashMap<u32, (usize, bool)>,
    events: events::EventReader,
    connections: Option<connections::Connections>,
}

impl Session {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let mut file = FileReader::open(path)?;
        let block = file
            .container
            .snapshots
            .first()
            .and_then(|snapshot| snapshot.scopes.first())
            .ok_or_else(|| invalid("Missing FSDB scope declarations"))?;
        let first = file.block_at(block.offset, block.stored_bytes, Compression::Lzo1x)?;
        let (mut declarations, hidden) = if first.starts_with(&[0xfe, 0]) {
            (plain::declarations(&mut file)?, Vec::new())
        } else {
            declarations::declarations(&mut file)?
        };
        let mut widths = HashMap::new();
        for row in declarations.iter().chain(&hidden) {
            let entry = widths
                .entry(row.native_id)
                .or_insert((row.width as usize, row.supported));
            if entry.0 != row.width as usize {
                return Err(invalid("FSDB aliases of the same ID have different widths"));
            }
            entry.1 &= row.supported;
        }
        for row in &mut declarations {
            row.supported = widths[&row.native_id].1;
        }
        let events = events::EventReader::open(&mut file)?;
        Ok(Self {
            file,
            declarations,
            widths,
            events,
            connections: None,
        })
    }

    pub fn container(&self) -> &Container {
        &self.file.container
    }

    pub fn query(
        &mut self,
        id: u32,
        start: u64,
        end: u64,
        limit: usize,
    ) -> io::Result<(Events, bool)> {
        let &(width, supported) = self
            .widths
            .get(&id)
            .ok_or_else(|| invalid("Unknown FSDB signal ID"))?;
        if !supported {
            return Err(invalid("Unsupported FSDB signal encoding"));
        }
        let events = if self.events.indexed(id) {
            std::sync::Arc::new(self.events.events(&mut self.file, id, width, start, end)?)
        } else {
            if self.connections.is_none() {
                self.connections = Some(connections::Connections::open(&mut self.file)?);
            }
            self.connections.as_mut().unwrap().events(
                &mut self.file,
                &mut self.events,
                &self.widths,
                id,
            )?
        };
        let first = events
            .partition_point(|event| event.0 <= start)
            .saturating_sub(1);
        let last = events.partition_point(|event| event.0 <= end);
        let truncated = last.saturating_sub(first) > limit;
        Ok((
            events[first..first + last.saturating_sub(first).min(limit)].to_vec(),
            truncated,
        ))
    }
}
