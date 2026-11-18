// SPDX-License-Identifier: MPL-2.0

use super::{
    super::{FileReader, MAX_BLOCK},
    Vertex,
};
use crate::independent::{
    bytes::{invalid, le, Cursor, Input},
    codec::{inflate, Compression},
};
use std::{collections::HashMap, io};

pub(super) fn records(file: &mut FileReader) -> io::Result<HashMap<u64, Vec<u8>>> {
    let start = le(&file.read(0x538, 8)?)?;
    if start == 0 {
        return Ok(HashMap::new());
    }
    let end = le(&file.read(0x410, 8)?)?;
    if start < 0x900 || start >= end || end - start > MAX_BLOCK as u64 {
        return Err(invalid("FSDB connection archive bounds"));
    }
    let raw = file.read(start, (end - start) as usize)?;
    let mut input = Cursor::new(&raw);
    if input.take(4)? != [0x21, 0x43, 0x65, 0x87] {
        return Err(invalid("FSDB connection archive signature mismatch"));
    }
    let version_size = input.uint(4)? as usize;
    if !(1..=1024).contains(&version_size) || input.take(version_size)?.last() != Some(&0) {
        return Err(invalid("Invalid FSDB connection archive version"));
    }
    let offset = input.pos;
    if input.uint(4)? != 0x300 || input.uint(4)? != offset as u64 {
        return Err(invalid("FSDB connection archive framing mismatch"));
    }

    let mut records = HashMap::new();
    loop {
        let size = input.uint(8)? as usize;
        if size == 0 {
            if !input.remaining().is_empty() {
                return Err(invalid("Unexpected bytes after FSDB connection archive"));
            }
            return Ok(records);
        }
        let section = input.take(size)?;
        if size < 34 {
            return Err(invalid("Short FSDB connection section"));
        }
        let count = le(&section[size - 4..])? as usize;
        if count == 0 || count > 100_000 || 24 * count + 10 > size {
            return Err(invalid("FSDB connection directory bounds"));
        }
        let directory = size - 4 - 24 * count;
        let mut frames = Cursor::new(&section[..directory]);
        if frames.take(2)? != [0xe3, 0] {
            return Err(invalid("Unrecognized FSDB connection compression flags"));
        }
        let mut anchors = HashMap::new();
        let mut decoded = Vec::new();
        while !frames.remaining().is_empty() {
            let frame = frames.pos;
            let size = frames.uint(4)? as usize;
            let block = inflate(frames.take(size)?)?;
            if decoded.len() + block.len() > MAX_BLOCK
                || !frames.remaining().is_empty() && block.len() != 262_144
            {
                return Err(invalid("Invalid FSDB connection frame length"));
            }
            anchors.insert(frame, (decoded.len(), block.len()));
            decoded.extend(block);
        }

        let mut intervals = Vec::with_capacity(count);
        let mut table = Cursor::new(&section[directory..size - 4]);
        for _ in 0..count {
            let anchor = table.uint(8)? as usize;
            let within = table.uint(4)? as usize;
            let length = table.uint(4)? as usize;
            let key = table.uint(8)?;
            let &(base, block_size) = anchors
                .get(&anchor)
                .ok_or_else(|| invalid("FSDB connection directory references unknown frame"))?;
            let start = base + within;
            let end = start + length;
            if within >= block_size
                || length == 0
                || end > decoded.len()
                || records.insert(key, decoded[start..end].to_vec()).is_some()
            {
                return Err(invalid("Invalid FSDB connection record bounds or key"));
            }
            intervals.push((start, end));
        }
        intervals.sort_unstable();
        if intervals[0].0 != 0
            || intervals[count - 1].1 != decoded.len()
            || intervals.windows(2).any(|pair| pair[0].1 != pair[1].0)
        {
            return Err(invalid(
                "FSDB connection records do not cover the decoded section",
            ));
        }
    }
}

pub(super) fn maps(file: &mut FileReader) -> io::Result<[HashMap<u32, Vertex>; 2]> {
    let raw = file.read(0x4f0, 16)?;
    let mut header = Cursor::new(&raw);
    let mut offset = header.uint(8)?;
    let sizes = [header.uint(4)? as usize, header.uint(4)? as usize];
    let mut maps = [HashMap::new(), HashMap::new()];
    if offset == 0 && sizes == [0, 0] {
        return Ok(maps);
    }
    if offset < 0x900 || sizes.iter().sum::<usize>() > MAX_BLOCK {
        return Err(invalid("FSDB connection map section bounds"));
    }
    for (map, size) in maps.iter_mut().zip(sizes) {
        let packed = file.read(offset, size)?;
        offset += size as u64;
        let mut input = Cursor::new(&packed);
        let mut bytes = Vec::new();
        while !input.remaining().is_empty() {
            let length = input.uint(4)? as usize;
            if length == 0 {
                break;
            }
            let block = file
                .codec
                .fsdb(Compression::Lzo1c, input.take(length)?, None)?;
            if block.len() + bytes.len() > MAX_BLOCK {
                return Err(invalid("FSDB connection map decoded bytes exceed bounds"));
            }
            bytes.extend(block);
        }
        if !input.remaining().is_empty() {
            return Err(invalid("Unexpected bytes in FSDB connection map"));
        }
        let mut input = Cursor::new(&bytes);
        while !input.remaining().is_empty() {
            let descriptor = input.byte()?;
            if descriptor & 0xc0 != 0xc0
                || [0, 2, 4].iter().any(|shift| (descriptor >> shift & 3) == 3)
            {
                return Err(invalid("Invalid FSDB connection map descriptor"));
            }
            let signal = input.uint(1 << (descriptor & 3))? as u32;
            let context = input.uint(1 << ((descriptor >> 2) & 3))? as u32;
            let node = input.uint(1 << ((descriptor >> 4) & 3))? as u32;
            if signal == 0
                || signal > file.container.header_max_id
                || map.insert(signal, (context, node)).is_some()
            {
                return Err(invalid("Invalid or duplicate FSDB connection signal ID"));
            }
        }
    }
    Ok(maps)
}
