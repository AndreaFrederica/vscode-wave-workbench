// SPDX-License-Identifier: MPL-2.0

mod directory;
mod header;
mod reader;

pub use directory::{Block, Snapshot, TimeWindow};

use self::{
    directory::Directory,
    header::Header,
    reader::{invalid, read_at},
};
use serde::Serialize;
use std::{
    fs::File,
    io::{self, Read, Seek},
    ops::Range,
    path::Path,
};

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
        let header = Header::read(file, size)?;
        let mut graph_tag = [0; 8];
        read_at(file, size, header.graph, &mut graph_tag)?;
        if &graph_tag != b"GMAPHEAD" {
            return Err(invalid("FSDB graph boundary mismatch"));
        }

        let mut bytes = vec![0; (header.graph - header.directory) as usize];
        read_at(file, size, header.directory, &mut bytes)?;
        let directory = Directory::parse(&bytes, &header)?;

        Ok(Self {
            file_bytes: size,
            start: header.start,
            end: header.end,
            timescale: header.timescale,
            header_max_id: header.max_id,
            graph_offset: header.graph,
            dictionary_offset: header.dictionary + 8,
            dictionary_decoded_bytes: directory.dictionary_decoded_bytes,
            dictionary_stored_bytes: directory.dictionary_stored_bytes,
            dictionary_extensions: directory.dictionary_extensions,
            window_extensions: directory.window_extensions,
            snapshots: directory.snapshots,
            windows: directory.windows,
        })
    }
}
