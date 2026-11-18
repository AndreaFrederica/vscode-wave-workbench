// SPDX-License-Identifier: MPL-2.0

use super::reader::{invalid, read_at, read_u32, read_u64};
use std::io::{self, Read, Seek};

pub(super) const HEADER_SIZE: usize = 0x900;
const MAX_DIRECTORY: u64 = 16 * 1024 * 1024;

pub(super) struct Header {
    pub(super) start: u64,
    pub(super) end: u64,
    pub(super) timescale: String,
    pub(super) max_id: u32,
    pub(super) directory: u64,
    pub(super) windows: u64,
    pub(super) dictionary: u64,
    pub(super) graph: u64,
    pub(super) window_count: u32,
}

impl Header {
    pub(super) fn read(file: &mut (impl Read + Seek), size: u64) -> io::Result<Self> {
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
        let directory = read_u64(&header, 0x400);
        let windows = read_u64(&header, 0x408);
        let dictionary = read_u64(&header, 0x478);
        let graph = read_u64(&header, 0x508);
        let window_count = read_u32(&header, 0x898);
        if window_count == 0 || window_count > 100_000 {
            return Err(invalid("FSDB window count exceeds budget"));
        }
        if !(HEADER_SIZE as u64 <= directory
            && directory < windows
            && windows < dictionary
            && dictionary < graph
            && graph < size
            && graph - directory <= MAX_DIRECTORY)
        {
            return Err(invalid("FSDB directory pointers exceed bounds"));
        }
        Ok(Self {
            start,
            end,
            timescale,
            max_id: read_u32(&header, 0x8a4),
            directory,
            windows,
            dictionary,
            graph,
            window_count,
        })
    }
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
