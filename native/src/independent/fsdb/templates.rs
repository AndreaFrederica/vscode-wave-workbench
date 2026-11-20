// SPDX-License-Identifier: MPL-2.0

use super::{
    super::{
        bytes::{invalid, Cursor, Input},
        codec::{Compression, MAX_BLOCK},
    },
    FileReader,
};
use std::{collections::HashMap, io};

const MAX_ENTRIES: usize = 1_000_000;

#[derive(Clone, Copy)]
enum ValueType {
    Primitive(u8),
    Template(u32),
}

struct Variable {
    name: String,
    value: ValueType,
}

pub(super) struct Scope {
    pub(super) children: Vec<String>,
    variables: Vec<Variable>,
}

type Ranges = Vec<(i64, i64)>;
enum Template {
    Packed(Ranges),
    Array(ValueType, Ranges, bool),
    Aggregate(Vec<Variable>, usize),
    Enum(ValueType),
    Scope(Scope),
}

pub(super) struct Atom {
    pub(super) name: String,
    pub(super) width: usize,
    pub(super) supported: bool,
    pub(super) real: bool,
}

pub(super) struct Templates(HashMap<u32, Template>);

impl Templates {
    pub(super) fn open(file: &mut FileReader) -> io::Result<Self> {
        let range = file.container.dictionary_extensions.clone();
        if range.is_empty() {
            return Ok(Self(HashMap::new()));
        }
        let ext = file.read(range.start, (range.end - range.start) as usize)?;
        let mut input = Cursor::new(&ext);
        if input.uint(4)? as usize != input.remaining().len() {
            return Err(invalid("FSDB template section length mismatch"));
        }

        let mut bytes = Vec::new();
        loop {
            let size = input.uint(4)? as usize;
            if size == 0 {
                break;
            }
            let block = file
                .codec
                .fsdb(Compression::Lzo1x, input.take(size)?, None)?;
            if bytes.len() + block.len() > MAX_BLOCK {
                return Err(invalid("FSDB template table exceeds budget"));
            }
            bytes.extend(block);
        }
        if !input.remaining().is_empty() {
            return Err(invalid("Unexpected bytes after FSDB template section"));
        }

        let mut templates = Self(HashMap::new());
        let mut input = Cursor::new(&bytes);
        loop {
            let offset = input.pos;
            let tag = input.byte()?;
            if tag == 0x80 {
                if input.remaining().is_empty() {
                    return Ok(templates);
                }
                continue;
            }
            let (key, template) = templates
                .record(tag, &mut input)
                .map_err(|error| invalid(format!("FSDB template byte {offset}: {error}")))?;
            if templates.0.len() >= MAX_ENTRIES || templates.0.insert(key, template).is_some() {
                return Err(invalid("Duplicate or excessive FSDB template keys"));
            }
        }
    }

    fn record(&self, tag: u8, input: &mut Cursor<'_>) -> io::Result<(u32, Template)> {
        let result = match tag {
            0x0f | 0x10 => {
                let flags = input.byte()?;
                let key = input.uint(2)? as u32;
                let value = value_type(input, flags)?;
                let dimensions = input.byte()?;
                let ranges = parse_ranges(input, dimensions)?;
                let template = match (tag, value) {
                    (0x0f, ValueType::Primitive(0 | 4)) => Template::Packed(ranges),
                    (0x0f, ValueType::Primitive(_)) => {
                        return Err(invalid("Unrecognized FSDB packed vector type"))
                    }
                    _ => Template::Array(value, ranges, tag == 0x0f),
                };
                (key, template)
            }
            0x11..=0x13 => {
                let descriptor = input.byte()?;
                if descriptor > 1 {
                    return Err(invalid("Unrecognized FSDB structure descriptor"));
                }
                let key = input.uint(2)? as u32;
                let count = input.byte()? as usize;
                let width = input.uint(1 << descriptor)? as usize;
                let mut values = Vec::with_capacity(count);
                while values.len() < count {
                    let bitmap = input.byte()?;
                    let group = (count - values.len()).min(8);
                    if u16::from(bitmap) >> group != 0 {
                        return Err(invalid("FSDB structure descriptor exceeds member count"));
                    }
                    for index in 0..group {
                        let value = if bitmap >> index & 1 != 0 {
                            ValueType::Template(input.uint(4)? as u32)
                        } else {
                            ValueType::Primitive(input.byte()?)
                        };
                        values.push(value);
                    }
                }
                let mut members = Vec::with_capacity(count);
                let mut total_width = 0usize;
                for value in values {
                    total_width = total_width
                        .checked_add(self.width(value, 0)?)
                        .ok_or_else(|| invalid("FSDB structure width overflow"))?;
                    members.push(Variable {
                        name: input.string()?,
                        value,
                    });
                }
                if count == 0 || width != total_width {
                    return Err(invalid("FSDB structure width disagrees with member widths"));
                }
                (key, Template::Aggregate(members, width))
            }
            1 => {
                let flags = input.byte()?;
                let key = input.uint(2)? as u32;
                let value = value_type(input, flags)?;
                if let ValueType::Primitive(dtype) = value {
                    if !matches!(dtype, 0 | 4 | 6 | 8 | 10 | 12 | 14) {
                        return Err(invalid("Unrecognized FSDB enum base type"));
                    }
                }
                let count = input.byte()? as usize;
                for _ in 0..count {
                    input.string()?;
                }
                let size = count
                    .checked_mul(self.width(value, 0)?)
                    .filter(|&size| size != 0 && size <= MAX_BLOCK)
                    .ok_or_else(|| invalid("FSDB enum value table exceeds bounds"))?;
                if input.take(size)?.iter().any(|&value| value > 3) {
                    return Err(invalid("Unrecognized FSDB enum value encoding"));
                }
                (key, Template::Enum(value))
            }
            0x15 => {
                input.byte()?; // Scope kind.
                let descriptor = input.byte()?;
                if !matches!(descriptor, 0 | 4 | 0x10 | 0x14 | 0x20) {
                    return Err(invalid("Unrecognized FSDB scope template descriptor"));
                }
                let key = input.uint(2)? as u32;
                let var_count = input.uint(1 << ((descriptor >> 4) & 3))? as usize;
                let child_count = input.uint(1 << ((descriptor >> 2) & 3))? as usize;
                if var_count > MAX_ENTRIES || child_count > MAX_ENTRIES {
                    return Err(invalid("FSDB scope template exceeds entry budget"));
                }
                input.string()?; // Module definition name.
                let children = (0..child_count)
                    .map(|_| input.string())
                    .collect::<io::Result<_>>()?;
                let mut types = Vec::with_capacity(var_count);
                while types.len() < var_count {
                    let descriptor = input.byte()?;
                    let count = (var_count - types.len()).min(4);
                    for index in 0..count {
                        let value = match descriptor >> (6 - index * 2) & 3 {
                            0 => ValueType::Primitive(input.byte()?),
                            1 => ValueType::Template(input.uint(2)? as u32),
                            _ => return Err(invalid("Unrecognized FSDB scope variable type")),
                        };
                        input.take(2)?; // Direction and declaration flags.
                        types.push(value);
                    }
                    if u16::from(descriptor) & ((1 << (8 - count * 2)) - 1) != 0 {
                        return Err(invalid("Nonzero unused FSDB variable descriptor bits"));
                    }
                }
                let variables = types
                    .into_iter()
                    .map(|value| {
                        Ok(Variable {
                            name: input.string()?,
                            value,
                        })
                    })
                    .collect::<io::Result<_>>()?;
                (
                    key,
                    Template::Scope(Scope {
                        children,
                        variables,
                    }),
                )
            }
            _ => return Err(invalid(format!("Unrecognized FSDB template tag {tag:#x}"))),
        };
        Ok(result)
    }

    fn get(&self, key: u32) -> io::Result<&Template> {
        self.0
            .get(&key)
            .ok_or_else(|| invalid(format!("Unknown FSDB template {key}")))
    }

    fn width(&self, value: ValueType, depth: usize) -> io::Result<usize> {
        if depth > 32 {
            return Err(invalid("FSDB type depth exceeds limit"));
        }
        match value {
            ValueType::Primitive(dtype) => primitive_width(dtype),
            ValueType::Template(key) => match self.get(key)? {
                Template::Packed(ranges) => range_width(ranges, 1),
                Template::Array(value, ranges, true) => {
                    range_width(ranges, self.width(*value, depth + 1)?)
                }
                Template::Aggregate(_, width) => Ok(*width),
                Template::Enum(value) => self.width(*value, depth + 1),
                _ => Err(invalid("FSDB template does not have a packed width")),
            },
        }
    }

    pub(super) fn scope(&self, key: u32) -> io::Result<&Scope> {
        match self.get(key)? {
            Template::Scope(scope) => Ok(scope),
            _ => Err(invalid("Expected FSDB scope template")),
        }
    }

    pub(super) fn atoms(&self, key: u32) -> io::Result<Vec<Atom>> {
        let mut atoms = Vec::new();
        for variable in &self.scope(key)?.variables {
            self.expand(&variable.name, variable.value, &mut Vec::new(), &mut atoms)?;
        }
        Ok(atoms)
    }

    pub(super) fn selected_atom(&self, name: String, key: u32) -> io::Result<Atom> {
        if key == 0 {
            return Ok(Atom {
                name,
                width: 1,
                supported: true,
                real: false,
            });
        }
        if !matches!(self.get(key)?, Template::Packed(_)) {
            return Err(invalid("Unsupported type in FSDB selected variable"));
        }
        let mut atoms = Vec::new();
        self.expand(&name, ValueType::Template(key), &mut Vec::new(), &mut atoms)?;
        atoms
            .pop()
            .ok_or_else(|| invalid("Missing FSDB selected variable type"))
    }

    fn expand(
        &self,
        name: &str,
        value: ValueType,
        active: &mut Vec<u32>,
        atoms: &mut Vec<Atom>,
    ) -> io::Result<()> {
        if atoms.len() >= MAX_ENTRIES || active.len() > 32 {
            return Err(invalid("FSDB template expansion exceeds budget"));
        }
        let key = match value {
            ValueType::Template(key) => key,
            ValueType::Primitive(dtype) => {
                let supported = !matches!(dtype, 16 | 19);
                let width = if supported {
                    primitive_width(dtype)?
                } else {
                    1
                };
                let name = if width > 1 {
                    format!("{name}[{}:0]", width - 1)
                } else {
                    name.to_owned()
                };
                atoms.push(Atom {
                    name,
                    width,
                    supported: supported || dtype == 16,
                    real: dtype == 16,
                });
                return Ok(());
            }
        };
        if active.contains(&key) {
            return Err(invalid("Cyclic FSDB template reference"));
        }
        active.push(key);
        match self.get(key)? {
            Template::Packed(ranges) => {
                let mut name = name.to_owned();
                for (left, right) in ranges {
                    name.push_str(&format!("[{left}:{right}]"));
                }
                atoms.push(Atom {
                    name,
                    width: range_width(ranges, 1)?,
                    supported: true,
                real: false,
                });
            }
            Template::Enum(value) => self.expand(name, *value, active, atoms)?,
            Template::Aggregate(members, _) => {
                for member in members {
                    self.expand(&member.name, member.value, active, atoms)?;
                }
            }
            Template::Array(value, ranges, _) => {
                let count = range_width(ranges, 1)?;
                if count > MAX_ENTRIES {
                    return Err(invalid("FSDB array exceeds expansion budget"));
                }
                let mut names = vec![name.to_owned()];
                for &(left, right) in ranges {
                    let size = left.abs_diff(right);
                    let mut expanded = Vec::with_capacity(names.len() * (size + 1) as usize);
                    for name in &names {
                        for i in 0..=size as i64 {
                            let index = if left <= right { left + i } else { left - i };
                            expanded.push(format!("{name}[{index}]"));
                        }
                    }
                    names = expanded;
                }
                for name in names {
                    self.expand(&name, *value, active, atoms)?;
                }
            }
            Template::Scope(_) => return Err(invalid("FSDB scope template used as value")),
        }
        active.pop();
        Ok(())
    }
}

fn value_type(input: &mut Cursor<'_>, flags: u8) -> io::Result<ValueType> {
    match flags {
        0 => Ok(ValueType::Primitive(input.byte()?)),
        0x10 => Ok(ValueType::Template(input.uint(2)? as u32)),
        _ => Err(invalid("Unrecognized FSDB value type flags")),
    }
}

fn parse_ranges(input: &mut Cursor<'_>, count: u8) -> io::Result<Ranges> {
    if !(1..=8).contains(&count) {
        return Err(invalid("Invalid FSDB dimension count"));
    }
    let mut ranges = Vec::new();
    for _ in 0..count {
        let descriptor = input.byte()?;
        if descriptor & 15 != 0 {
            return Err(invalid("Unrecognized FSDB dimension descriptor"));
        }
        let mut bound = |shift| {
            let size = [0, 1, 2, 4][(descriptor >> shift & 3u8) as usize];
            let value = input.uint(size)?;
            Ok::<i64, io::Error>(if size == 4 {
                value as i32 as i64
            } else {
                value as i64
            })
        };
        ranges.push((bound(6)?, bound(4)?));
    }
    Ok(ranges)
}

fn range_width(ranges: &Ranges, initial: usize) -> io::Result<usize> {
    ranges.iter().try_fold(initial, |width, (left, right)| {
        width
            .checked_mul((left.abs_diff(*right) + 1) as usize)
            .ok_or_else(|| invalid("FSDB packed width overflow"))
    })
}

fn primitive_width(dtype: u8) -> io::Result<usize> {
    match dtype {
        0 | 4 => Ok(1),
        6 | 18 => Ok(64),
        8 | 10 => Ok(32),
        12 => Ok(16),
        14 => Ok(8),
        _ => Err(invalid(format!("Unrecognized FSDB primitive type {dtype}"))),
    }
}
