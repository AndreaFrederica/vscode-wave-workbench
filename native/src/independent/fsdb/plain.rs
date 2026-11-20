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
    let mut stack = Vec::<(String, u8)>::new();
    let mut groups = Groups {
        stream: &variables,
        signal_count,
        spans: Vec::new(),
        output: Vec::new(),
        seen: HashSet::new(),
    };
    let mut scopes = 0;
    loop {
        match input.byte()? {
            kind @ (0 | 1 | 3) => {
                let name = input.string()?;
                input.string()?; // Module definition.
                input.expect(0)?;
                let full = if let Some((parent, _)) = stack.last() {
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
                    1 => groups.read(&full, input.uint(4)? as usize, false)?,
                    _ => return Err(invalid("Invalid plain FSDB variable group flag")),
                }
                stack.push((full, kind));
            }
            0xfd => {
                let (scope, kind) = stack
                    .pop()
                    .ok_or_else(|| invalid("Plain FSDB scope stack underflow"))?;
                match input.byte()? {
                    0 => {}
                    1 => {
                        // A task scope can carry its parent's deferred variable declarations.
                        let owner = if kind == 1 {
                            stack.last().map_or(scope.as_str(), |(parent, _)| parent)
                        } else {
                            &scope
                        };
                        groups.read(owner, input.uint(4)? as usize, true)?;
                    }
                    _ => return Err(invalid("Invalid plain FSDB scope close flag")),
                }
            }
            0xff if stack.is_empty() && input.remaining().is_empty() => break,
            _ => return Err(invalid("Unrecognized plain FSDB scope opcode")),
        }
    }
    groups.spans.sort_unstable();
    let mut cursor = 1;
    for (start, end) in groups.spans {
        if start != cursor {
            return Err(invalid("Plain FSDB variable groups leave a gap"));
        }
        cursor = end;
    }
    if cursor != variables.len() {
        return Err(invalid("Unexpected bytes after plain FSDB declarations"));
    }
    Ok(groups.output)
}

struct Groups<'a> {
    stream: &'a [u8],
    signal_count: u64,
    spans: Vec<(usize, usize)>,
    output: Vec<Declaration>,
    seen: HashSet<(String, String)>,
}

impl Groups<'_> {
    fn read(&mut self, scope: &str, start: usize, closing: bool) -> io::Result<()> {
        let tail = self
            .stream
            .get(start..)
            .filter(|_| start != 0)
            .ok_or_else(|| invalid("Plain FSDB variable group exceeds stream"))?;
        let mut cursor = Cursor::new(tail);
        let mut remaining_children = Vec::<u64>::new();
        loop {
            match cursor.byte()? {
                0xff if remaining_children.is_empty() => break,
                4 | 15 if remaining_children.is_empty() => self.variable(scope, &mut cursor)?,
                // A closing group can also contain a named structure tree.
                0xc7 if closing && remaining_children.len() < 256 => {
                    cursor.expect(0x0a)?;
                    let children = cursor.uint(4)?;
                    cursor.string()?;
                    if let Some(remaining) = remaining_children.last_mut() {
                        *remaining = remaining
                            .checked_sub(1)
                            .ok_or_else(|| invalid("Invalid plain FSDB structure arity"))?;
                    }
                    remaining_children.push(children);
                }
                0xc8 if closing && remaining_children.last() == Some(&0) => {
                    remaining_children.pop();
                }
                _ => return Err(invalid("Invalid plain FSDB variable group record")),
            }
        }
        self.spans.push((start, start + cursor.pos));
        Ok(())
    }

    fn variable(&mut self, scope: &str, cursor: &mut Cursor<'_>) -> io::Result<()> {
        if self.output.len() >= 1_000_000 {
            return Err(invalid("Plain FSDB declarations exceed bounds"));
        }
        let name = cursor.string()?;
        let shape = cursor.byte()?;
        if shape & 0xf0 != 0x10 {
            return Err(invalid("Invalid plain FSDB wire range"));
        }
        let left = bound(cursor, shape & 3)?;
        let right = bound(cursor, shape >> 2 & 3)?;
        let id = cursor.uint(2)?;
        if !(1..self.signal_count).contains(&id)
            || shape != 0x10 && !name.ends_with(&format!("[{left}:{right}]"))
            || !self.seen.insert((scope.to_owned(), name.clone()))
        {
            return Err(invalid("Plain FSDB wire ID, name or range mismatch"));
        }
        let width = left.abs_diff(right) + 1;
        self.output.push(Declaration {
            native_id: id as u32,
            scope: scope.to_owned(),
            name,
            width: u32::try_from(width).map_err(|_| invalid("Plain FSDB wire width overflow"))?,
            supported: width <= 65536,
            real: false,
        });
        Ok(())
    }
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
