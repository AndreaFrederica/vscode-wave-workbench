// SPDX-License-Identifier: MPL-2.0

use super::{
    super::{
        bytes::{invalid, Cursor, Input},
        codec::{Compression, MAX_BLOCK},
    },
    templates::{Atom, Templates},
    FileReader,
};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io,
};

const PAGE: usize = 65536;

#[derive(Clone, Debug, Serialize)]
pub struct Declaration {
    pub native_id: u32,
    pub scope: String,
    pub name: String,
    pub width: u32,
    pub supported: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub real: bool,
}

struct Scope {
    fullname: String,
    template: Option<u32>,
    variables: Option<u32>,
}

enum Variable {
    Typed { id: u32, index: usize },
    Literal { id: u32, atom: Atom, hidden: bool },
}

pub(super) fn declarations(
    file: &mut FileReader,
) -> io::Result<(Vec<Declaration>, Vec<Declaration>)> {
    let templates = Templates::open(file)?;
    let variables = variable_groups(file, &templates)?;
    let mut declarations = Vec::new();
    let mut hidden_declarations = Vec::new();
    let mut referenced = HashSet::new();
    let mut atoms = HashMap::<u32, Vec<Atom>>::new();
    let mut previous = None;
    for ordinal in 0..file.container.snapshots.len() {
        let scope_blocks = &file.container.snapshots[ordinal].scopes;
        let [block] = scope_blocks.as_slice() else {
            return Err(invalid("Expected one FSDB scope block per snapshot"));
        };
        let raw = file.block_at(block.offset, block.stored_bytes, Compression::Lzo1x)?;
        let (scopes, footer) = scope_snapshot(&raw, &templates, (ordinal as u64) << 20, previous)?;
        previous = Some(footer);
        for scope in scopes {
            let Some(offset) = scope.variables else {
                continue;
            };
            let group = variables
                .get(&offset)
                .ok_or_else(|| invalid(format!("Invalid FSDB variable group pointer {offset}")))?;
            referenced.insert(offset);
            if let Some(key) = scope.template {
                if let std::collections::hash_map::Entry::Vacant(entry) = atoms.entry(key) {
                    entry.insert(templates.atoms(key)?);
                }
            }
            for variable in group {
                let (id, atom, hidden) = match variable {
                    Variable::Literal { id, atom, hidden } => (*id, atom, *hidden),
                    Variable::Typed { id, index } => {
                        let atom = scope
                            .template
                            .and_then(|key| atoms.get(&key))
                            .and_then(|atoms| atoms.get(*index))
                            .ok_or_else(|| {
                                invalid(format!(
                                    "FSDB variable slot {index} is missing from scope {}",
                                    scope.fullname
                                ))
                            })?;
                        (*id, atom, false)
                    }
                };
                let declaration = Declaration {
                    native_id: id,
                    scope: scope.fullname.clone(),
                    name: atom.name.clone(),
                    width: u32::try_from(atom.width)
                        .map_err(|_| invalid("FSDB declared width exceeds u32"))?,
                    supported: atom.supported && (1..=65536).contains(&atom.width),
                    real: atom.real,
                };
                if hidden {
                    hidden_declarations.push(declaration);
                } else {
                    declarations.push(declaration);
                }
            }
        }
    }
    if variables.len() != referenced.len() {
        return Err(invalid("Unreferenced FSDB variable lists"));
    }
    Ok((declarations, hidden_declarations))
}

fn scope_snapshot(
    raw: &[u8],
    templates: &Templates,
    virtual_base: u64,
    predecessor: Option<u64>,
) -> io::Result<(Vec<Scope>, u64)> {
    let mut cursor = Cursor::new(raw);
    cursor.expect(0xfe)?;
    cursor.expect(4)?;
    if let Some(previous) = predecessor {
        let descriptor = cursor.byte()?;
        if descriptor > 3 || cursor.uint(1 << descriptor)? != previous {
            return Err(invalid("FSDB scope snapshot predecessor mismatch"));
        }
    }
    let mut rows = Vec::<Scope>::new();
    let mut stack = Vec::<usize>::new();
    loop {
        let start = cursor.pos as u64;
        let code = cursor.byte()?;
        match code {
            0 | 0x1f | 0x21 | 0x22 | 0x80 | 0xfa | 0xfb => {
                let parent = stack.last().map(|&index| &rows[index]);
                let (name, template) = if matches!(code, 0 | 0x1f | 0x21 | 0x22 | 0x80) {
                    if code == 0x80 {
                        cursor.expect(0)?;
                    }
                    let name = cursor.string()?;
                    let definition = cursor.string()?;
                    if code == 0x1f
                        && (parent.is_none()
                            || !name
                                .strip_suffix(']')
                                .and_then(|name| name.rsplit_once('['))
                                .is_some_and(|(base, index)| {
                                    !base.is_empty() && index.parse::<i32>().is_ok()
                                }))
                    {
                        return Err(invalid("Invalid FSDB interface array element scope"));
                    }
                    if matches!(code, 0x21 | 0x22)
                        && (parent.is_none() || !definition.contains("/."))
                    {
                        return Err(invalid("Invalid FSDB interface reference scope"));
                    }
                    cursor.byte()?; // Scope kind.
                    (name, None)
                } else {
                    let name = if code == 0xfa {
                        Some(cursor.string()?)
                    } else {
                        None
                    };
                    let descriptor = cursor.byte()?;
                    if !matches!(descriptor, 0 | 0x10) || code == 0xfa && descriptor != 0 {
                        return Err(invalid("Unrecognized FSDB scope template flags"));
                    }
                    let key = cursor.uint(2)? as u32;
                    templates.scope(key)?;
                    let name = if let Some(name) = name {
                        name
                    } else {
                        let index = cursor.uint(1 << (descriptor >> 4))? as usize;
                        let parent = parent
                            .and_then(|scope| scope.template)
                            .ok_or_else(|| invalid("FSDB indexed child has no parent template"))?;
                        templates
                            .scope(parent)?
                            .children
                            .get(index)
                            .cloned()
                            .ok_or_else(|| invalid("FSDB child index exceeds parent template"))?
                    };
                    (name, Some(key))
                };
                let flags = cursor.byte()?;
                if !matches!(
                    flags,
                    0 | 1 | 4 | 5 | 0xc | 0xd | 0x11 | 0x15 | 0x1d | 0x40 | 0x41 | 0x4c | 0x4d
                ) {
                    return Err(invalid(format!("Unrecognized FSDB scope flags {flags:#x}")));
                }
                let variables = if flags & 1 != 0 {
                    Some(cursor.uint(4)? as u32)
                } else {
                    None
                };
                if flags & 0xc == 4 {
                    let marker = cursor.byte()?;
                    if marker <= 3 {
                        cursor.uint(1 << marker)?;
                    } else if !matches!(marker, 0x40..=0x7f) {
                        return Err(invalid("Unrecognized FSDB scope marker"));
                    }
                }
                let fullname = parent.map_or_else(
                    || name.clone(),
                    |parent| format!("{}.{name}", parent.fullname),
                );
                if stack.len() >= 256 || rows.len() >= 1_000_000 {
                    return Err(invalid("FSDB scope tree exceeds budget"));
                }
                stack.push(rows.len());
                rows.push(Scope {
                    fullname,
                    template,
                    variables,
                });
            }
            0xfd => {
                if stack.pop().is_none() {
                    return Err(invalid("FSDB scope stack underflow"));
                }
                match cursor.byte()? {
                    0 => {}
                    4 => {
                        let descriptor = cursor.byte()?;
                        if !matches!(
                            descriptor,
                            0x40 | 0x41 | 0x42 | 0x50 | 0x51 | 0x52 | 0x55 | 0x56 | 0x5e
                        ) {
                            return Err(invalid("Unrecognized FSDB scope close descriptor"));
                        }
                        cursor.uint(1 << (descriptor & 3))?;
                    }
                    _ => return Err(invalid("Unrecognized FSDB scope close flags")),
                }
            }
            0xff if stack.is_empty() => {
                let descriptor = cursor.uint(2)?;
                if !matches!(descriptor, 0 | 4 | 8 | 0x0a) {
                    return Err(invalid("Unrecognized FSDB scope footer descriptor"));
                }
                let base = cursor.uint((1 << (descriptor & 3)) - 1)? << 8;
                let footer = cursor.uint(1 << ((descriptor >> 2) & 3))?;
                if base != virtual_base
                    || !(virtual_base..virtual_base + start).contains(&footer)
                    || !cursor.remaining().is_empty()
                {
                    return Err(invalid("FSDB scope footer exceeds snapshot"));
                }
                return Ok((rows, virtual_base + start));
            }
            _ => {
                return Err(invalid(format!(
                    "Unrecognized FSDB scope opcode {code:#x} at {start}"
                )))
            }
        }
    }
}

struct VariableCursor<'a> {
    pages: &'a [Vec<u8>],
    address: usize,
    scratch: Vec<u8>,
}

impl VariableCursor<'_> {
    fn string(&mut self) -> io::Result<String> {
        let mut bytes = Vec::new();
        loop {
            let page = self
                .pages
                .get(self.address / PAGE)
                .ok_or_else(|| invalid("FSDB variable string exceeds page table"))?;
            let offset = self.address % PAGE;
            let chunk = page
                .get(offset..)
                .filter(|part| !part.is_empty())
                .ok_or_else(|| invalid("FSDB variable string starts in unmapped page tail"))?;
            let end = chunk.iter().position(|&byte| byte == 0);
            let length = end.unwrap_or(chunk.len());
            if length + bytes.len() > 1 << 20 {
                return Err(invalid("FSDB variable string exceeds bounds"));
            }
            bytes.extend_from_slice(&chunk[..length]);
            self.address += length;
            if end.is_some() {
                self.address += 1;
                return String::from_utf8(bytes)
                    .map_err(|_| invalid("Invalid UTF-8 in FSDB variable name"));
            }
            if page.len() != PAGE {
                return Err(invalid("Unterminated FSDB variable string"));
            }
        }
    }
}

impl Input for VariableCursor<'_> {
    fn take(&mut self, count: usize) -> io::Result<&[u8]> {
        self.scratch.clear();
        while self.scratch.len() < count {
            let offset = self.address % PAGE;
            let amount = (count - self.scratch.len()).min(PAGE - offset);
            let part = self
                .pages
                .get(self.address / PAGE)
                .and_then(|page| page.get(offset..offset + amount))
                .ok_or_else(|| invalid("FSDB variable read enters unmapped page tail"))?;
            self.scratch.extend_from_slice(part);
            self.address += amount;
        }
        Ok(&self.scratch)
    }
}

fn read_id(input: &mut impl Input, descriptor: u8, previous: u32) -> io::Result<u32> {
    let mode = descriptor >> 4 & 3;
    if mode == 3 {
        previous
            .checked_add(1)
            .filter(|_| previous != 0)
            .ok_or_else(|| invalid("Invalid FSDB incremental signal ID"))
    } else {
        Ok(input.uint(1 << mode)? as u32)
    }
}

fn variable_groups(
    file: &mut FileReader,
    templates: &Templates,
) -> io::Result<HashMap<u32, Vec<Variable>>> {
    let blocks: Vec<_> = file
        .container
        .snapshots
        .iter()
        .flat_map(|snapshot| &snapshot.variables)
        .map(|block| (block.offset, block.stored_bytes))
        .collect();
    if blocks.len() > MAX_BLOCK / PAGE {
        return Err(invalid("FSDB variable table exceeds page budget"));
    }
    let mut pages = Vec::new();
    for (offset, length) in blocks {
        let raw = file.block_at(offset, length, Compression::Lzo1x)?;
        if raw.is_empty() || raw.len() > PAGE {
            return Err(invalid("FSDB variable page exceeds capacity"));
        }
        pages.push(raw);
    }

    let mut groups = HashMap::new();
    let mut ordinal = 0;
    let mut previous = 0;
    for snapshot in &file.container.snapshots {
        let count = snapshot.variables.len();
        if count == 0 {
            continue;
        }
        let final_page = ordinal + count - 1;
        if pages[ordinal..final_page]
            .iter()
            .any(|page| page.len() != PAGE)
        {
            return Err(invalid("Non-final FSDB variable page is short"));
        }
        let end = final_page * PAGE + pages[final_page].len();
        let mut input = VariableCursor {
            pages: &pages,
            address: ordinal * PAGE,
            scratch: Vec::new(),
        };
        if ordinal == 0 {
            input.expect(0xbf)?;
        }
        while input.address < end {
            let address = input.address;
            let mut records = Vec::new();
            let mut next_index = 0;
            loop {
                let tag = input.byte()?;
                let (id, variable) = match tag {
                    0xff => break,
                    0xd8 => {
                        let name = input.string()?;
                        input.expect(0x10)?;
                        let id = input.uint(2)? as u32;
                        let template = input.uint(2)? as u32;
                        if input.uint(2)? != 0 {
                            return Err(invalid("Unsupported flags in FSDB selected variable"));
                        }
                        let atom = templates.selected_atom(name, template)?;
                        (
                            id,
                            Variable::Literal {
                                id,
                                atom,
                                hidden: false,
                            },
                        )
                    }
                    0xd5 => {
                        let descriptor = input.byte()?;
                        // Flag 0x02 preserves the ID and template index layout.
                        if descriptor & 0x0d != 0 {
                            return Err(invalid("Unrecognized FSDB variable index descriptor"));
                        }
                        let id = read_id(&mut input, descriptor, previous)?;
                        let mode = descriptor >> 6;
                        let index = if mode == 3 {
                            next_index
                        } else {
                            input.uint(1 << mode)? as usize
                        };
                        next_index = index + 1;
                        (id, Variable::Typed { id, index })
                    }
                    0..=63 => {
                        let name = input.string()?;
                        let shape = input.byte()?;
                        if shape & 0x50 != 0x10 {
                            return Err(invalid(format!(
                                "Unrecognized FSDB literal shape {shape:#x} for {name}"
                            )));
                        }
                        let descriptor = if shape & 0x20 != 0 {
                            input.byte()?
                        } else {
                            0x10
                        };
                        let widths = [0, 1, 2, 4];
                        let left = input.uint(widths[(shape & 3) as usize])?;
                        let right = input.uint(widths[(shape >> 2 & 3) as usize])?;
                        let id = read_id(&mut input, descriptor, previous)?;
                        if shape & 0x80 != 0 {
                            input.uint(2)?;
                        }
                        let atom = Atom {
                            name,
                            width: left.abs_diff(right) as usize + 1,
                            supported: tag != 63,
                            real: tag == 3,
                        };
                        (
                            id,
                            Variable::Literal {
                                id,
                                atom,
                                hidden: descriptor & 4 != 0,
                            },
                        )
                    }
                    _ => {
                        return Err(invalid(format!(
                            "Unrecognized FSDB literal variable kind {tag:#x}"
                        )))
                    }
                };
                if id == 0
                    || id > file.container.header_max_id
                    || records.len() >= 1_000_000
                    || input.address > end
                {
                    return Err(invalid(
                        "FSDB variable list exceeds ID, count or snapshot bounds",
                    ));
                }
                records.push(variable);
                previous = id;
            }
            if input.address > end || groups.insert(address as u32, records).is_some() {
                return Err(invalid("FSDB variable group exceeds snapshot"));
            }
        }
        ordinal += count;
    }
    Ok(groups)
}
