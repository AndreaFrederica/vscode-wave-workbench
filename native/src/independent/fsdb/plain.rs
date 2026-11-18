// SPDX-License-Identifier: MPL-2.0

use super::{Declaration, FileReader};
use crate::independent::{
    bytes::{invalid, Cursor, Input},
    codec::{Compression, MAX_BLOCK},
};
use std::{collections::HashSet, io};

pub(super) fn declarations(file: &mut FileReader) -> io::Result<Vec<Declaration>> {
    let [snapshot] = file.container.snapshots.as_slice() else {
        return Err(invalid("Plain FSDB expects a single declaration snapshot"));
    };
    let signal_count = snapshot.signal_word;
    if signal_count > 65536 {
        return Err(invalid("Plain FSDB signal ID width exceeds bounds"));
    }
    let scopes = snapshot
        .scopes
        .iter()
        .map(|block| (block.offset, block.stored_bytes))
        .collect::<Vec<_>>();
    let variables = snapshot
        .variables
        .iter()
        .map(|block| (block.offset, block.stored_bytes))
        .collect::<Vec<_>>();
    let scopes = stream(file, scopes)?;
    let variables = stream(file, variables)?;
    if scopes.len() + variables.len() > MAX_BLOCK || variables.first() != Some(&0xbf) {
        return Err(invalid("Invalid plain FSDB declaration stream"));
    }
    let mut input = Cursor::new(&scopes);
    input.expect(0xfe)?;
    input.expect(0)?;
    let mut stack = Vec::<String>::new();
    let mut spans = Vec::new();
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    let mut scopes = 0;
    loop {
        match input.byte()? {
            0 => {
                let name = input.string()?;
                input.string()?; // Module definition.
                input.expect(0)?;
                let full = if let Some(parent) = stack.last() {
                    format!("{parent}.{name}")
                } else {
                    name
                };
                scopes += 1;
                if stack.len() >= 256 || scopes > 1_000_000 {
                    return Err(invalid("Plain FSDB hierarchy exceeds bounds"));
                }
                match input.byte()? {
                    0 => {}
                    1 => {
                        let start = input.uint(4)? as usize;
                        let tail = variables
                            .get(start..)
                            .filter(|_| start != 0)
                            .ok_or_else(|| invalid("Plain FSDB variable group exceeds stream"))?;
                        let mut cursor = Cursor::new(tail);
                        loop {
                            let tag = cursor.byte()?;
                            if tag == 255 {
                                break;
                            }
                            if tag != 15 || output.len() >= 1_000_000 {
                                return Err(invalid("Invalid plain FSDB wire declaration"));
                            }
                            let name = cursor.string()?;
                            let shape = cursor.byte()?;
                            if shape & 0xf0 != 0x10 {
                                return Err(invalid("Invalid plain FSDB wire range"));
                            }
                            let left = bound(&mut cursor, shape & 3)?;
                            let right = bound(&mut cursor, shape >> 2 & 3)?;
                            let id = cursor.uint(2)?;
                            if !(1..signal_count).contains(&id)
                                || shape != 0x10 && !name.ends_with(&format!("[{left}:{right}]"))
                                || !seen.insert((full.clone(), name.clone()))
                            {
                                return Err(invalid("Plain FSDB wire ID, name or range mismatch"));
                            }
                            let width = left.abs_diff(right) + 1;
                            output.push(Declaration {
                                native_id: id as u32,
                                scope: full.clone(),
                                name,
                                width: u32::try_from(width)
                                    .map_err(|_| invalid("Plain FSDB wire width overflow"))?,
                                supported: width <= 65536,
                            });
                        }
                        spans.push((start, start + cursor.pos));
                    }
                    _ => return Err(invalid("Invalid plain FSDB variable group flag")),
                }
                stack.push(full);
            }
            0xfd => {
                if stack.pop().is_none() {
                    return Err(invalid("Plain FSDB scope stack underflow"));
                }
                input.expect(0)?;
            }
            0xff if stack.is_empty() && input.remaining().is_empty() => break,
            _ => return Err(invalid("Unrecognized plain FSDB scope opcode")),
        }
    }
    spans.sort_unstable();
    let mut cursor = 1;
    for (start, end) in spans {
        if start != cursor {
            return Err(invalid("Plain FSDB variable groups leave a gap"));
        }
        cursor = end;
    }
    if cursor != variables.len() {
        return Err(invalid("Unexpected bytes after plain FSDB declarations"));
    }
    Ok(output)
}

fn stream(file: &mut FileReader, blocks: Vec<(u64, u32)>) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    for (offset, size) in blocks {
        let block = file.block_at(offset, size, Compression::Lzo1x)?;
        if bytes.len() + block.len() > MAX_BLOCK {
            return Err(invalid("Plain FSDB declaration stream exceeds bounds"));
        }
        bytes.extend(block);
    }
    Ok(bytes)
}

fn bound(input: &mut Cursor<'_>, encoding: u8) -> io::Result<i64> {
    let width = [0, 1, 2, 4][encoding as usize];
    let value = input.uint(width)?;
    Ok(if width == 4 {
        i64::from(value as i32)
    } else {
        value as i64
    })
}
