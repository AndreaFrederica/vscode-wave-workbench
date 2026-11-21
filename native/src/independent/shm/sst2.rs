// SPDX-License-Identifier: MPL-2.0

use super::{
    bytes,
    codec::{default_length, Bits, Index},
    text, Result,
};
use crate::vcd::{Events, Signal};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
    sync::Arc,
};

const MAGIC: u32 = 0xa19511bf;
const SLICE: u32 = 0x1b2200;

fn word(data: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_be_bytes(
        bytes(data, offset, 4)?.try_into().unwrap(),
    ))
}

fn pointer(data: &[u8], offset: usize) -> Result<usize> {
    Ok(word(data, offset)? as usize)
}

fn long(data: &[u8], offset: usize) -> Result<u64> {
    Ok(u64::from_be_bytes(
        bytes(data, offset, 8)?.try_into().unwrap(),
    ))
}

fn string(data: &[u8], offset: usize) -> Result<String> {
    if offset == 0 {
        return Ok(String::new());
    }
    let tail = data.get(offset..).ok_or("Invalid SST2 string offset")?;
    let end = tail
        .iter()
        .take(65536)
        .position(|&byte| byte == 0)
        .ok_or("Unterminated SST2 string")?;
    Ok(text(&tail[..end]))
}

fn header(data: &[u8], kind: u32) -> Result<()> {
    if word(data, 0)? != MAGIC || word(data, 4)? != kind {
        return Err(format!("Invalid SST2 component header for type {kind}"));
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Encoding {
    Logic,
    Bit,
    Real,
    ShortReal,
    DynamicSize,
    String,
    Event,
}

#[derive(Clone, Copy, Debug)]
struct Format {
    encoding: Encoding,
    width: u32,
}

#[derive(Clone)]
struct Layout {
    format: Option<Format>,
    shape: Shape,
}

#[derive(Clone)]
enum Shape {
    Leaf,
    Array {
        first: i32,
        last: i32,
        element: Arc<Layout>,
    },
    Struct(Vec<(String, Arc<Layout>)>),
    Union(Vec<(String, Arc<Layout>)>),
    Dynamic {
        size: Arc<Layout>,
        item: Arc<Layout>,
    },
}

impl Layout {
    fn leaf(encoding: Encoding, width: u32) -> Self {
        Self {
            format: Some(Format { encoding, width }),
            shape: Shape::Leaf,
        }
    }

    fn member(&self, ordinal: usize) -> Option<(String, &Self)> {
        match &self.shape {
            Shape::Array {
                first,
                last,
                element,
            } if ordinal <= first.abs_diff(*last) as usize => {
                let step = if first <= last { 1 } else { -1 };
                let subscript = i64::from(*first) + ordinal as i64 * step;
                Some((format!("[{subscript}]"), element))
            }
            Shape::Dynamic { size, item } => {
                if ordinal == 0 {
                    Some(("[]".into(), size))
                } else {
                    Some((format!("[${ordinal}]"), item))
                }
            }
            Shape::Struct(members) | Shape::Union(members) => members
                .get(ordinal)
                .map(|(name, ty)| (format!(".{name}"), ty.as_ref())),
            _ => None,
        }
    }
}

fn layout(data: &[u8], offset: usize, depth: usize) -> Result<Layout> {
    let unknown = Layout {
        format: None,
        shape: Shape::Leaf,
    };
    if offset == 0 || depth >= 32 {
        return Ok(unknown);
    }
    let tag = word(data, offset)?;
    let first = || pointer(data, offset + 4);
    Ok(match tag {
        0x100b01 => Layout::leaf(Encoding::Event, 1),
        0x300b0f => Layout::leaf(Encoding::Bit, 32),
        0x100b02 => Layout::leaf(
            if first()? == 1 {
                Encoding::Bit
            } else {
                Encoding::Logic
            },
            1,
        ),
        0x020c08 if word(data, first()?)? == 0x100b04 => Layout::leaf(Encoding::String, 1),
        0x220b15 if word(data, first()?)? == 0x100b06 => match word(data, first()? + 4)? {
            32 => Layout::leaf(Encoding::ShortReal, 32),
            64 => Layout::leaf(Encoding::Real, 64),
            _ => unknown,
        },
        0x020c05 | 0x020c06 | 0x020c07 | 0x0e0c12 => layout(data, first()?, depth + 1)?,
        0x1e0c13 => {
            let backing = layout(data, first()?, depth + 1)?;
            let members = layout(data, pointer(data, offset + 8)?, depth + 1)?;
            if matches!((backing.format, members.format), (Some(a), Some(b)) if a.width == b.width)
            {
                members
            } else {
                backing
            }
        }
        0x140b07 => {
            let flags = first()?;
            let element = Arc::new(layout(data, pointer(data, offset + 8)?, depth + 1)?);
            if matches!(flags, 0x200a2 | 0x201a2 | 0x202a2) {
                let item = if flags == 0x202a2 {
                    let key_type = pointer(data, offset + 12)?;
                    let key = Arc::new(if word(data, key_type)? == 0x100b04 {
                        Layout::leaf(Encoding::Bit, 64)
                    } else {
                        layout(data, key_type, depth + 1)?
                    });
                    Arc::new(Layout {
                        format: None,
                        shape: Shape::Struct(vec![("key".into(), key), ("val".into(), element)]),
                    })
                } else {
                    element
                };
                return Ok(Layout {
                    format: None,
                    shape: Shape::Dynamic {
                        size: Arc::new(Layout::leaf(Encoding::DynamicSize, 32)),
                        item,
                    },
                });
            }
            let bounds = pointer(data, offset + 16)?;
            let count = word(data, offset + 20)?;
            if count == 0 || bounds == 0 {
                return Ok(unknown);
            }
            let first = word(data, bounds)? as i32;
            let delta = i64::from(count - 1);
            let last =
                i32::try_from(i64::from(first) + if flags & 2 != 0 { delta } else { -delta })
                    .map_err(|_| "Invalid SST2 array range")?;
            let format = element.format.and_then(|item| {
                if flags & 0x20 == 0 && matches!(item.encoding, Encoding::Logic | Encoding::Bit) {
                    Some(Format {
                        encoding: item.encoding,
                        width: item.width.checked_mul(count)?,
                    })
                } else {
                    None
                }
            });
            Layout {
                format,
                shape: Shape::Array {
                    first,
                    last,
                    element,
                },
            }
        }
        0x180b08 | 0x180b09 | 0x2c0b08 => {
            let union = tag == 0x180b09;
            let mut member = if tag == 0x2c0b08 {
                pointer(data, offset + 8)?
            } else {
                first()?
            };
            let mut members = Vec::new();
            let mut seen = HashSet::new();
            let mut packed = None;
            while member != 0 {
                let kind = word(data, member)?;
                let is_packed = matches!(kind, 0x150d03 | 0x150d04);
                if !matches!(
                    kind,
                    0x150d02 | 0x150d03 | 0x150d04 | 0x150d0b | 0x150d0d | 0x150d13
                ) || !seen.insert(member)
                    || packed.is_some_and(|old| old != is_packed)
                {
                    return Ok(unknown);
                }
                packed = Some(is_packed);
                let name = string(data, pointer(data, member + 8)?)?;
                let ty = layout(data, pointer(data, member + 16)?, depth + 1)?;
                members.push((name, Arc::new(ty)));
                member = pointer(data, member + 4)?;
            }
            let format = if packed == Some(true) {
                members.iter().try_fold(
                    Format {
                        encoding: Encoding::Bit,
                        width: 0,
                    },
                    |acc, (_, member)| {
                        let ty = member.format?;
                        Some(Format {
                            encoding: if acc.encoding == Encoding::Logic
                                || ty.encoding == Encoding::Logic
                            {
                                Encoding::Logic
                            } else {
                                Encoding::Bit
                            },
                            width: if union {
                                acc.width.max(ty.width)
                            } else {
                                acc.width.checked_add(ty.width)?
                            },
                        })
                    },
                )
            } else {
                None
            };
            Layout {
                format,
                shape: if union {
                    Shape::Union(members)
                } else {
                    Shape::Struct(members)
                },
            }
        }
        _ => unknown,
    })
}

#[derive(Clone)]
struct Source {
    file: Arc<str>,
    line: u32,
}

struct Scope {
    path: String,
    parent: Option<usize>,
    visible: bool,
    generated: bool,
    module: Option<Arc<str>>,
    declaration: Option<Source>,
    instance: Option<Source>,
}

struct Decl {
    scope: usize,
    name: String,
    layout: Arc<Layout>,
}

struct Design {
    scopes: Vec<Scope>,
    declarations: Vec<Decl>,
    locators: HashMap<usize, usize>,
    id: String,
}

fn source(data: &[u8], file_record: usize, line: u32) -> Result<Option<Source>> {
    if file_record == 0 || line == 0 || word(data, file_record)? != 0x0f0400 {
        return Ok(None);
    }
    let file = string(data, pointer(data, file_record + 8)?)?;
    Ok(Some(Source {
        file: file.into(),
        line,
    }))
}

impl Design {
    fn read(data: &[u8]) -> Result<Self> {
        header(data, 1)?;
        let id = string(data, pointer(data, 0x28)?)?;
        let mut design = Self {
            scopes: Vec::new(),
            declarations: Vec::new(),
            locators: HashMap::new(),
            id,
        };
        let mut pending = vec![(pointer(data, 0x2c)?, 0x18, None::<usize>)];
        let mut seen = HashSet::new();
        let mut types: HashMap<usize, Arc<Layout>> = HashMap::new();
        let mut definitions: HashMap<usize, (Arc<str>, Option<Source>)> = HashMap::new();
        while let Some((offset, parent_offset, parent)) = pending.pop() {
            if offset == 0 {
                continue;
            }
            let tag = word(data, offset)?;
            if tag >> 8 != 0x2705
                || pointer(data, offset + 16)? != parent_offset
                || !seen.insert(offset)
            {
                return Err(format!("Invalid SST2 scope at {offset:#x}"));
            }
            let name = string(data, pointer(data, offset + 8)?)?;
            let path = match parent {
                Some(index) if tag == 0x270528 && name.parse::<i64>().is_ok() => {
                    format!("{}[{name}]", design.scopes[index].path)
                }
                Some(index) => format!("{}.{name}", design.scopes[index].path),
                None => name,
            };
            let mut declaration = None;
            let mut module = None;
            let source_ref = pointer(data, offset + 12)?;
            let mut instance = None;
            if tag == 0x270501 {
                let reference = pointer(data, offset + 28)?;
                if reference != 0 && word(data, reference)? == 0x070601 {
                    if let std::collections::hash_map::Entry::Vacant(entry) =
                        definitions.entry(reference)
                    {
                        let name = string(data, pointer(data, reference + 8)?)?;
                        let name = name.split(":0x").next().unwrap_or(&name);
                        let name = name.rsplit('.').next().unwrap_or(name);
                        let name = name.split(':').next().unwrap_or(name);
                        let location = source(
                            data,
                            pointer(data, reference + 12)?,
                            word(data, reference + 16)?,
                        )?;
                        entry.insert((name.into(), location));
                    }
                    let definition = &definitions[&reference];
                    module = Some(definition.0.clone());
                    declaration = definition.1.clone();
                }
            }
            if tag == 0x270513 && source_ref != 0 && word(data, source_ref)? == 0x2b1104 {
                instance = source(
                    data,
                    pointer(data, source_ref + 8)?,
                    word(data, source_ref + 12)?,
                )?;
            }
            if tag == 0x270528 {
                instance = parent.and_then(|index| design.scopes[index].instance.clone());
            }
            let scope = design.scopes.len();
            design.scopes.push(Scope {
                path,
                parent,
                visible: tag != 0x270513,
                generated: tag == 0x270528,
                module,
                declaration,
                instance,
            });
            design.read_declarations(data, offset, scope, &mut types)?;
            if tag == 0x270523 {
                let mut object = pointer(data, offset + 12)?;
                let mut objects = HashSet::new();
                while object != 0 {
                    if word(data, object)? != 0x271107
                        || pointer(data, object + 16)? != offset
                        || !objects.insert(object)
                    {
                        return Err(format!("Invalid SST2 class object at {object:#x}"));
                    }
                    let variable = pointer(data, object + 24)?;
                    let identifier = string(data, pointer(data, variable + 8)?)?;
                    let class = &design.scopes[scope].path;
                    let name = if let Some((package, class)) = class.rsplit_once("::.") {
                        format!("{package}::{class}@{identifier}")
                    } else {
                        format!("{class}@{identifier}")
                    };
                    let instance = design.scopes.len();
                    design.scopes.push(Scope {
                        path: name,
                        parent: Some(scope),
                        visible: true,
                        generated: false,
                        module: None,
                        declaration: None,
                        instance: None,
                    });
                    design.read_declarations(data, object, instance, &mut types)?;
                    object = pointer(data, object + 4)?;
                }
            }
            pending.push((pointer(data, offset + 4)?, parent_offset, parent));
            pending.push((pointer(data, offset + 20)?, offset, Some(scope)));
        }
        Ok(design)
    }

    fn read_declarations(
        &mut self,
        data: &[u8],
        offset: usize,
        scope: usize,
        types: &mut HashMap<usize, Arc<Layout>>,
    ) -> Result<()> {
        let mut variable = pointer(data, offset + 24)?;
        while variable != 0 {
            if word(data, variable)? >> 8 != 0x2907
                || pointer(data, variable + 16)? != offset
                || self
                    .locators
                    .insert(variable, self.declarations.len())
                    .is_some()
            {
                return Err(format!("Invalid SST2 declaration at {variable:#x}"));
            }
            let name = if word(data, offset)? == 0x271107 {
                String::new()
            } else {
                string(data, pointer(data, variable + 8)?)?
            };
            let type_offset = pointer(data, variable + 20)?;
            if let std::collections::hash_map::Entry::Vacant(entry) = types.entry(type_offset) {
                entry.insert(Arc::new(layout(data, type_offset, 0)?));
            }
            self.declarations.push(Decl {
                name,
                scope,
                layout: types[&type_offset].clone(),
            });
            variable = pointer(data, variable + 4)?;
        }
        Ok(())
    }

    fn locations(&self, signals: &[Signal]) -> Value {
        let source_record = |source: &Option<Source>| {
            source
                .as_ref()
                .map(|source| json!({"file": source.file.as_ref(), "line": source.line}))
        };
        let mut locations = Vec::new();
        for scope in self.scopes.iter().filter(|scope| scope.visible) {
            let parent = scope.parent.and_then(|index| {
                let parent = &self.scopes[index];
                if parent.visible {
                    Some(parent.path.as_str())
                } else {
                    parent.parent.map(|index| self.scopes[index].path.as_str())
                }
            });
            locations.push(json!({
                "fullname": scope.path, "parent": parent, "waveName": scope.path, "scope": true,
                "module": scope.module.as_deref(), "generate": scope.generated,
                "declaration": source_record(&scope.declaration),
                "instance": source_record(&scope.instance)
            }));
        }
        for signal in signals {
            let fullname = if signal.scope.is_empty() {
                signal.name.clone()
            } else {
                format!("{}.{}", signal.scope, signal.name)
            };
            locations.push(json!({
                "fullname": fullname, "parent": signal.scope, "waveName": fullname,
                "scope": false, "declaration": null, "instance": null
            }));
        }
        Value::Array(locations)
    }
}

pub(super) struct Slice {
    pub(super) offset: usize,
    pub(super) start: u64,
    pub(super) end: u64,
    pub(super) count: usize,
    pub(super) sequence_width: usize,
    pub(super) tables: usize,
    pub(super) stream_base: usize,
    pub(super) variable_index: usize,
    index: RefCell<Option<Arc<Index>>>,
}

struct Series {
    slices: Vec<Slice>,
    locator_start: usize,
}

fn series(data: &[u8], design_id: &str) -> Result<(i8, Vec<Series>)> {
    header(data, 4)?;
    let mut offset = pointer(data, 0x14)?;
    let mut exponent = if offset >= 16 && word(data, offset - 16)? == 0x120c0b {
        Some(bytes(data, offset - 6, 1)?[0] as i8)
    } else {
        None
    };
    let mut matches_design = false;
    let mut series = Vec::new();
    let mut seen = HashSet::new();
    while offset != 0 {
        if !seen.insert(offset) {
            return Err("Cycle in SST2 series".into());
        }
        let tag = word(data, offset)?;
        let next = pointer(data, offset + 4)?;
        match tag {
            0x031101 => {
                if next >= offset + 16 && word(data, next - 16)? == 0x120c0b {
                    exponent = Some(bytes(data, next - 6, 1)?[0] as i8);
                }
            }
            0x192100 => {
                matches_design |= string(data, pointer(data, offset + 32)?)? == design_id;
                let mut slice_offset = pointer(data, offset + 72)?;
                let locator_start = pointer(data, offset + 76)?;
                let expected_last = pointer(data, offset + 80)?;
                let mut slices: Vec<Slice> = Vec::new();
                let mut slice_seen = HashSet::new();
                while slice_offset != 0 {
                    if !slice_seen.insert(slice_offset) || word(data, slice_offset)? != SLICE {
                        return Err(format!("Invalid SST2 slice at {slice_offset:#x}"));
                    }
                    let slice = Slice {
                        offset: slice_offset,
                        start: long(data, slice_offset + 8)?,
                        end: long(data, slice_offset + 24)?,
                        count: pointer(data, slice_offset + 40)?,
                        sequence_width: pointer(data, slice_offset + 44)?,
                        tables: pointer(data, slice_offset + 48)?,
                        stream_base: pointer(data, slice_offset + 52)?,
                        variable_index: pointer(data, slice_offset + 56)?,
                        index: RefCell::default(),
                    };
                    if slice.start > slice.end
                        || slices.last().is_some_and(|prev| prev.start > slice.start)
                    {
                        return Err("Invalid SST2 slice time bounds".into());
                    }
                    slices.push(slice);
                    slice_offset = pointer(data, slice_offset + 4)?;
                }
                if slices
                    .last()
                    .is_some_and(|slice| slice.offset != expected_last)
                {
                    return Err("Last SST2 slice disagrees with series".into());
                }
                series.push(Series {
                    slices,
                    locator_start,
                });
            }
            _ => return Err(format!("Unknown SST2 series record {tag:#x}")),
        }
        offset = next;
    }
    if design_id.is_empty() || !matches_design {
        return Err("SST2 design ID differs between DSN and TRN".into());
    }
    Ok((exponent.ok_or("Missing SST2 time scale")?, series))
}

fn locator_node(
    reader: &mut Bits<'_>,
    width: usize,
    path: &mut Vec<usize>,
    visitor: &mut impl FnMut(&[usize], usize) -> Result<()>,
) -> Result<()> {
    if path.len() >= 32 {
        return Err("SST2 locator tree is too deeply nested".into());
    }
    let mut element = 0usize;
    loop {
        element = element
            .checked_add(default_length(reader)?)
            .ok_or("SST2 locator element overflows")?;
        let kind = reader.read(3)?;
        let count = match kind {
            0..=3 => {
                reader.rewind_two();
                path.push(element);
                visitor(path, reader.read(width)? as usize)?;
                path.pop();
                1
            }
            7 => {
                path.push(element);
                locator_node(reader, width, path, visitor)?;
                path.pop();
                1
            }
            _ => {
                let count = default_length(reader)?;
                if count > 1_000_000 {
                    return Err("Invalid SST2 locator run length".into());
                }
                let first = reader.read(width)? as usize;
                for index in 0..count {
                    path.push(
                        element
                            .checked_add(index)
                            .ok_or("Invalid SST2 locator ordinal")?,
                    );
                    let id = if kind == 6 {
                        first.checked_sub(index)
                    } else {
                        first.checked_add(index)
                    }
                    .ok_or("Invalid SST2 locator ID")?;
                    visitor(path, id)?;
                    path.pop();
                }
                count
            }
        };
        element = element
            .checked_add(count)
            .ok_or("SST2 locator element overflows")?;
        if reader.read(1)? == 0 {
            return Ok(());
        }
    }
}

fn locators(
    data: &[u8],
    mut offset: usize,
    mut visit: impl FnMut(usize, &[usize], usize) -> Result<()>,
) -> Result<()> {
    let mut seen = HashSet::new();
    while offset != 0 {
        let tag = word(data, offset)?;
        if tag == SLICE {
            break;
        }
        if !seen.insert(offset) {
            return Err("Cycle in SST2 locator blocks".into());
        }
        let next = pointer(data, offset + 4)?;
        match tag {
            0x1f2400 => {
                let mut reader = Bits::new(data, offset + 8, next)?;
                let partition = default_length(&mut reader)?;
                let flags = reader.read(4)?;
                if !matches!((partition, flags), (1, 0) | (2, 1)) {
                    return Err(format!(
                        "Unsupported SST2 locator partition {partition}/{flags}"
                    ));
                }
                let width = default_length(&mut reader)?;
                if width > 32 {
                    return Err("Invalid SST2 series ID width".into());
                }
                let mut locator = 0usize;
                loop {
                    let delta = default_length(&mut reader)?;
                    if delta == 0 {
                        break;
                    }
                    locator = locator
                        .checked_add(delta.checked_mul(4).ok_or("Invalid SST2 locator delta")?)
                        .ok_or("Invalid SST2 locator offset")?;
                    if reader.read(1)? != 0 {
                        locator_node(&mut reader, width, &mut Vec::new(), &mut |path, id| {
                            visit(locator, path, id)
                        })?;
                    } else {
                        visit(locator, &[], reader.read(width)? as usize)?;
                    }
                }
            }
            0x212500 => {}
            _ => return Err(format!("Unknown SST2 locator record {tag:#x}")),
        }
        offset = next;
    }
    Ok(())
}

#[derive(Clone)]
enum Stream {
    Direct(usize),
    Split(Vec<(usize, usize)>),
}

#[derive(Clone)]
struct Binding {
    series: usize,
    format: Format,
    stream: Stream,
    project: Option<(usize, usize)>,
}

fn formatted(bytes: &[u8], format: Format) -> Result<String> {
    if bytes.is_empty() {
        return Ok(match format.encoding {
            Encoding::String => String::new(),
            Encoding::Real | Encoding::ShortReal => f64::NAN.to_string(),
            Encoding::Event => "0".into(),
            _ => "x".repeat(format.width as usize),
        });
    }
    match format.encoding {
        Encoding::String => Ok(if bytes == [0] {
            String::new()
        } else {
            text(bytes)
        }),
        Encoding::DynamicSize => {
            let size = match bytes {
                [0] => 0,
                [1..=3, a, b, c, d] => u32::from_be_bytes([*a, *b, *c, *d]),
                _ => return Err("Invalid SST2 dynamic object size".into()),
            };
            Ok(format!("{size:032b}"))
        }
        Encoding::ShortReal => {
            let mut word = [0; 4];
            if bytes.len() != word.len() {
                return Err("Invalid SST2 shortreal width".into());
            }
            word.copy_from_slice(bytes);
            Ok(f64::from(f32::from_be_bytes(word)).to_string())
        }
        Encoding::Event => Ok(if bytes.iter().any(|&byte| byte != 0) {
            "1"
        } else {
            "0"
        }
        .into()),
        Encoding::Real => {
            let mut word = [0u8; 8];
            word.get_mut(8usize.saturating_sub(bytes.len())..)
                .filter(|target| target.len() == bytes.len())
                .ok_or("Invalid SST2 real width")?
                .copy_from_slice(bytes);
            Ok(f64::from_be_bytes(word).to_string())
        }
        Encoding::Logic | Encoding::Bit => {
            let bits = if format.encoding == Encoding::Logic {
                2
            } else {
                1
            };
            let per_byte = 8 / bits;
            let digits = b"01xz";
            let mut value = vec![b'0'; format.width as usize];
            for (index, output) in value.iter_mut().rev().enumerate() {
                let Some(offset) = bytes.len().checked_sub(index / per_byte + 1) else {
                    break;
                };
                let byte = bytes[offset];
                *output =
                    digits[usize::from((byte >> ((index % per_byte) * bits)) & ((1 << bits) - 1))];
            }
            Ok(String::from_utf8(value).unwrap())
        }
    }
}

type Target = (usize, String);
type BitsByTarget = HashMap<Target, (Format, BTreeMap<usize, usize>)>;

fn add_members(
    bindings: &mut BTreeMap<Target, Binding>,
    target: &Target,
    layout: &Layout,
    binding: &Binding,
    offset: usize,
) {
    let count = match &layout.shape {
        Shape::Struct(members) | Shape::Union(members) => members.len(),
        Shape::Array {
            first,
            last,
            element,
        } if offset > 0 || binding.project.is_some() || !matches!(element.shape, Shape::Leaf) => {
            first.abs_diff(*last) as usize + 1
        }
        _ => return,
    };
    let mut cursor = offset;
    for ordinal in 0..count {
        let Some((suffix, member)) = layout.member(ordinal) else {
            return;
        };
        let Some(format) = member.format else { return };
        let child = (target.0, format!("{}{suffix}", target.1));
        let width = format.width as usize;
        let mut projected = binding.clone();
        projected.project = Some((cursor, cursor + width));
        bindings
            .entry(child.clone())
            .or_insert_with(|| projected.clone());
        add_members(bindings, &child, member, &projected, cursor);
        if !matches!(layout.shape, Shape::Union(_)) {
            cursor += width;
        }
    }
}

pub(super) struct Sst2 {
    data: Vec<u8>,
    design: Design,
    series: Vec<Series>,
    bindings: Vec<Binding>,
    pub(super) signals: Vec<Signal>,
    pub(super) exponent: i8,
    pub(super) start: u64,
    pub(super) end: u64,
}

impl Sst2 {
    pub(super) fn open(dsn: &Path, trn: &Path) -> Result<Self> {
        let read = |path: &Path| {
            std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
        };
        let design = Design::read(&read(dsn)?)?;
        let data = read(trn)?;
        let (exponent, series) = series(&data, &design.id)?;
        let start = series
            .iter()
            .filter_map(|item| item.slices.first().map(|slice| slice.start))
            .min()
            .unwrap_or(0);
        let end = series
            .iter()
            .filter_map(|item| item.slices.last().map(|slice| slice.end))
            .max()
            .unwrap_or(start);
        let mut bindings = BTreeMap::new();
        for (series_id, item) in series.iter().enumerate() {
            let mut splits: BitsByTarget = HashMap::new();
            let capacity = item
                .slices
                .iter()
                .map(|slice| slice.count)
                .max()
                .unwrap_or(0);
            locators(&data, item.locator_start, |locator, elements, id| {
                let decl = &design.declarations[*design
                    .locators
                    .get(&locator)
                    .ok_or("Unknown SST2 declaration locator")?];
                if id >= capacity {
                    return Ok(());
                }
                let mut name = decl.name.clone();
                let mut ty = decl.layout.as_ref();
                let mut elements = elements;
                while !elements.is_empty() && ty.format.is_none() {
                    let Some((suffix, member)) = ty.member(elements[0]) else {
                        return Ok(());
                    };
                    name += &suffix;
                    ty = member;
                    elements = &elements[1..];
                }
                let Some(format) = ty
                    .format
                    .filter(|format| (1..=65536).contains(&format.width))
                else {
                    return Ok(());
                };
                let target = (
                    decl.scope,
                    name.strip_prefix('.').unwrap_or(&name).to_owned(),
                );
                match elements {
                    [] => {
                        let binding = Binding {
                            series: series_id,
                            format,
                            stream: Stream::Direct(id),
                            project: None,
                        };
                        bindings.insert(target.clone(), binding.clone());
                        add_members(&mut bindings, &target, ty, &binding, 0);
                    }
                    [ordinal]
                        if *ordinal < format.width as usize
                            && matches!(format.encoding, Encoding::Logic | Encoding::Bit) =>
                    {
                        splits
                            .entry(target)
                            .or_insert_with(|| (format, BTreeMap::new()))
                            .1
                            .insert(*ordinal, id);
                    }
                    _ => {}
                }
                Ok(())
            })?;
            for (target, (format, slots)) in splits {
                // A parent with a partial recording exposes the recorded bits,
                // without synthesizing a value for the rest of the bus.
                if slots.len() == format.width as usize {
                    bindings.entry(target).or_insert_with(|| Binding {
                        series: series_id,
                        format,
                        stream: Stream::Split(slots.into_iter().collect()),
                        project: None,
                    });
                }
            }
        }
        let mut signals = Vec::with_capacity(bindings.len());
        let mut ordered = Vec::with_capacity(bindings.len());
        for ((scope, name), binding) in bindings {
            let width = binding
                .project
                .map_or(binding.format.width, |(lo, hi)| (hi - lo) as u32);
            signals.push(Signal {
                id: ordered.len().to_string(),
                scope: design.scopes[scope].path.clone(),
                name,
                width,
                real: matches!(
                    binding.format.encoding,
                    Encoding::Real | Encoding::ShortReal
                ),
                supported: true,
                unit: None,
            });
            ordered.push(binding);
        }
        Ok(Self {
            data,
            design,
            series,
            bindings: ordered,
            signals,
            exponent,
            start,
            end,
        })
    }

    pub(super) fn locations(&self, signals: &[Signal]) -> Value {
        self.design.locations(signals)
    }

    pub(super) fn is_event(&self, id: usize) -> bool {
        self.bindings[id].format.encoding == Encoding::Event
    }

    fn index(&self, slice: &Slice) -> Result<Arc<Index>> {
        if let Some(index) = slice.index.borrow().as_ref() {
            return Ok(index.clone());
        }
        let index = Arc::new(Index::read(&self.data, slice)?);
        *slice.index.borrow_mut() = Some(index.clone());
        Ok(index)
    }

    fn events(
        &self,
        slice: &Slice,
        id: usize,
        ordered: bool,
    ) -> Result<Vec<(i128, u64, Arc<[u8]>)>> {
        if id >= slice.count {
            return Ok(Vec::new());
        }
        self.index(slice)?.decode(&self.data, slice, id, ordered)
    }

    pub(super) fn query(
        &self,
        id: usize,
        start: u64,
        end: u64,
        limit: usize,
        ordered: bool,
    ) -> Result<(Events, bool)> {
        let binding = self.bindings.get(id).ok_or("Unknown SST2 signal")?;
        let slices = &self.series[binding.series].slices;
        if slices.is_empty() {
            return Ok((Vec::new(), false));
        }
        let first = slices
            .partition_point(|slice| slice.end < start)
            .min(slices.len() - 1);
        let mut events = Events::new();
        let mut state = None;
        let mut source_slice = first;

        // An empty record can span multiple slices when a signal stays stable.
        // Consult earlier slices only when the chosen slice has no carry-in.
        loop {
            let slice = &slices[source_slice];
            let samples = self.slice_events(slice, binding, ordered)?;
            if samples
                .first()
                .is_some_and(|(tick, _)| *tick <= i128::from(start))
                || source_slice == 0
                || binding.format.encoding == Encoding::Event
            {
                break;
            }
            source_slice -= 1;
        }
        for slice in &slices[source_slice..] {
            if slice.start > end {
                break;
            }
            for (time, value) in self.slice_events(slice, binding, ordered)? {
                if time > i128::from(end) {
                    break;
                }
                if time < i128::from(slice.start) && slice.offset != slices[source_slice].offset {
                    continue;
                }
                let tick = time.max(0) as u64;
                if tick < start {
                    if binding.format.encoding != Encoding::Event {
                        state = Some((tick, value));
                    }
                    continue;
                }
                if events.is_empty() && tick > start {
                    if let Some(carry) = state.take() {
                        events.push(carry);
                    }
                }
                if !ordered
                    && events.last().is_some_and(|item| item.0 == tick)
                    && binding.format.encoding != Encoding::Event
                {
                    events.pop();
                }
                if !ordered
                    && binding.format.encoding != Encoding::Event
                    && events.last().is_some_and(|item| item.1 == value)
                {
                    continue;
                }
                if events.len() == limit {
                    return Ok((events, true));
                }
                events.push((tick, value));
            }
        }
        if events.is_empty() {
            events.extend(state);
        }
        Ok((events, false))
    }

    fn slice_events(
        &self,
        slice: &Slice,
        binding: &Binding,
        ordered: bool,
    ) -> Result<Vec<(i128, String)>> {
        match &binding.stream {
            Stream::Direct(id) => self
                .events(slice, *id, false)?
                .into_iter()
                .map(|(time, _, bytes)| {
                    let mut value = formatted(&bytes, binding.format)?;
                    if let Some((first, last)) = binding.project {
                        value = value[first..last].to_owned();
                    }
                    Ok((time, value))
                })
                .collect(),
            Stream::Split(ids) => {
                let mut changes = BTreeMap::new();
                let item = Format {
                    width: 1,
                    ..binding.format
                };
                for &(slot, id) in ids {
                    for (time, sequence, raw) in self.events(slice, id, ordered)? {
                        let value = formatted(&raw, item)?.into_bytes()[0];
                        changes
                            .entry((time, sequence))
                            .or_insert_with(Vec::new)
                            .push((slot, value));
                    }
                }
                let mut value = vec![b'x'; binding.format.width as usize];
                Ok(changes
                    .into_iter()
                    .map(|((time, _), changes)| {
                        for (slot, level) in changes {
                            value[slot] = level;
                        }
                        (time, String::from_utf8(value.clone()).unwrap())
                    })
                    .collect())
            }
        }
    }
}
