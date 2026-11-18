// SPDX-License-Identifier: MPL-2.0

use super::{
    archive::{file_bytes, framed, libraries, word, Arena, View, ARCHIVE_BUDGET},
    parameters::{Entry, Parameters},
    sdb::{Instance, Master},
    sources::{Position, Sources},
};
use crate::independent::{
    bytes::{invalid, Cursor, Input},
    codec::{Codec, Compression},
};
use std::{
    collections::{HashMap, HashSet},
    io,
    path::{Path, PathBuf},
    str,
    sync::Arc,
};

struct Unit {
    arena: Arena,
    library: String,
}

pub(super) struct Objects {
    directory: PathBuf,
    parameters: Option<Parameters>,
    parameter_refs: HashMap<(u32, u64), u64>,
    codec: Codec,
    units: HashMap<u32, Unit>,
    cache: HashMap<u32, Arc<View>>,
    cached_bytes: usize,
    origins: HashMap<(u32, u64), (u32, u64)>,
    variants: HashMap<(u32, u64), Vec<(u32, u64, u32)>>,
    strings: HashMap<String, Vec<String>>,
    file_tables: HashMap<u32, HashMap<u64, u64>>,
    extended_files: HashMap<u32, HashMap<u64, u64>>,
}

impl Objects {
    pub(super) fn open(directory: &Path) -> io::Result<Self> {
        let codec = Codec::open()?;
        let elab = frames(directory, "_stnElabDB", &codec)?;
        let mut input = Cursor::new(&elab);
        let mut identities = HashMap::<(String, String), HashSet<u32>>::new();
        let mut origins = HashMap::new();
        while !input.remaining().is_empty() {
            let marker = input.uint(2)?;
            let kind = input.uint(2)?;
            let size = word(&mut input)? as usize;
            if !matches!(marker, 29 | 285 | 541) || size < 8 {
                return Err(invalid("Invalid KDB elaboration record header"));
            }
            let mut record = Cursor::new(input.take(size - 8)?);
            match kind {
                15 => {
                    let key = record.uint(8)?;
                    let unit = u32::try_from(record.uint(8)?)
                        .map_err(|_| invalid("KDB source unit overflows u32"))?;
                    let name = record.string()?;
                    let language = record.string()?;
                    let library = record.string()?;
                    if language != "hdl" || !record.remaining().is_empty() {
                        return Err(invalid("Invalid KDB source-unit name record"));
                    }
                    if key == 24 {
                        identities.entry((library, name)).or_default().insert(unit);
                    }
                }
                13 if marker == 541 => {
                    let source = record.uint(8)?;
                    let original = record.uint(8)?;
                    let unit = word(&mut record)?;
                    let original_unit = word(&mut record)?;
                    let origin = (original_unit, original);
                    if !record.remaining().is_empty()
                        || origins
                            .insert((unit, source), origin)
                            .is_some_and(|before| before != origin)
                    {
                        return Err(invalid("Ambiguous KDB source origin"));
                    }
                }
                _ => {}
            }
        }

        let mut strings = HashMap::new();
        let mut units = HashMap::new();
        for library_path in libraries(directory)? {
            let libfile = library_path.join("libfile");
            if !libfile.is_file() {
                continue;
            }
            let library = library_path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("Invalid KDB library path"))?;
            let library_name = library.strip_suffix(".lib++").unwrap();
            let names = long_strings(&library_path.join("SM_LONG_STR_FILE_NAME"), &codec)?;
            strings.insert(library.to_owned(), names);
            let view = Arena::open(&libfile, 0)?.decode(&codec)?;
            if view.uint(24, 4)? != 0x200114 || view.uint(72, 8)? != 1 {
                return Err(invalid("Invalid KDB library root"));
            }
            let group = view.pointer_required(80)?;
            if view.uint(group, 4)? != 0x40016
                || view.string(view.pointer_required(group + 8)?)? != "hdl"
            {
                return Err(invalid("Unrecognized KDB source language group"));
            }
            let mut node = view.pointer(group + 40)?;
            let count = view.uint(56, 8)? as usize;
            let mut seen = HashSet::new();
            while let Some(key) = node {
                if seen.len() >= 100_000 || !seen.insert(key) || view.uint(key, 4)? != 0x80017 {
                    return Err(invalid("Invalid KDB compilation unit list"));
                }
                let descriptor = view.pointer_required(key + 8)?;
                if view.uint(descriptor, 4)? != 21 {
                    return Err(invalid("Invalid KDB compilation unit descriptor"));
                }
                let name = view.string(view.pointer_required(descriptor + 16)?)?;
                let extent = view.pointer_required(key + 40)?;
                if view.uint(key + 56, 4)? != 0x240000 {
                    return Err(invalid("Invalid KDB source arena extent"));
                }
                let root = view.uint(extent, 4)?;
                let first = view.uint(extent + 4, 4)?;
                let last = view.uint(extent + 8, 4)?;
                if root != 24 || last < first {
                    return Err(invalid("Invalid KDB source arena root or range"));
                }
                let ids = identities
                    .get(&(library_name.to_owned(), name.to_owned()))
                    .filter(|ids| ids.len() == 1)
                    .ok_or_else(|| {
                        invalid(format!(
                            "Ambiguous KDB compilation unit {library_name}:{name}"
                        ))
                    })?;
                let unit = *ids.iter().next().unwrap();
                let arena = Arena::open(&library_path.join("oh.etc/_oharch"), first)?;
                if arena.end != last + 1
                    || units
                        .insert(
                            unit,
                            Unit {
                                arena,
                                library: library.to_owned(),
                            },
                        )
                        .is_some()
                {
                    return Err(invalid("KDB source arena identity or extent mismatch"));
                }
                node = view.pointer(key + 32)?;
            }
            if seen.len() != count {
                return Err(invalid("KDB compilation unit count mismatch"));
            }
        }

        let variants_raw = frames(directory, "_nstnElabDB", &codec)?;
        let mut input = Cursor::new(&variants_raw);
        let mut variants = HashMap::<(u32, u64), Vec<(u32, u64, u32)>>::new();
        while !input.remaining().is_empty() {
            let flags = word(&mut input)?;
            let unit = word(&mut input)?;
            let target_unit = word(&mut input)?;
            let kind = word(&mut input)?;
            let source = input.uint(8)?;
            let target = input.uint(8)?;
            if !matches!(flags, 0 | 65536) || !(1..=256).contains(&kind) {
                return Err(invalid("Invalid KDB elaboration variant record"));
            }
            if flags == 0 {
                variants
                    .entry((unit, source))
                    .or_default()
                    .push((target_unit, target, kind));
            }
        }
        Ok(Self {
            directory: directory.to_owned(),
            parameters: None,
            parameter_refs: HashMap::new(),
            codec,
            units,
            cache: HashMap::new(),
            cached_bytes: 0,
            origins,
            variants,
            strings,
            file_tables: HashMap::new(),
            extended_files: HashMap::new(),
        })
    }

    pub(super) fn parameter(
        &mut self,
        variant: (u32, u64),
        unit: u32,
        key: u64,
    ) -> io::Result<Option<Entry>> {
        let (source_unit, source) = variant;
        if source_unit == 0 || source == 0 {
            return Ok(None);
        }
        let reference = match self.parameter_refs.get(&variant) {
            Some(&reference) => reference,
            None => {
                let view = self.view(source_unit)?;
                let reference = if view.uint(source, 1)? == 81 {
                    view.uint(source + 56, 8)?
                } else {
                    0
                };
                self.parameter_refs.insert(variant, reference);
                reference
            }
        };
        if reference == 0 {
            return Ok(None);
        }
        if self.parameters.is_none() {
            self.parameters = Some(Parameters::open(&self.directory, &self.codec)?);
        }
        self.parameters
            .as_ref()
            .unwrap()
            .entry(reference, unit, key)
    }

    pub(super) fn view(&mut self, unit: u32) -> io::Result<Arc<View>> {
        if let Some(view) = self.cache.get(&unit) {
            return Ok(view.clone());
        }
        let arena = &self
            .units
            .get(&unit)
            .ok_or_else(|| invalid("Unknown KDB source unit"))?
            .arena;
        if self.cached_bytes + arena.size > ARCHIVE_BUDGET {
            return Err(invalid("KDB source cache exceeds budget"));
        }
        let view = Arc::new(arena.decode(&self.codec)?);
        self.cached_bytes += arena.size;
        self.cache.insert(unit, view.clone());
        Ok(view)
    }

    pub(super) fn origin(&self, instance: &Instance) -> io::Result<(u32, u64)> {
        let unit = instance.unit as u32;
        let source = instance.source;
        match instance.unit >> 32 {
            0 => Ok((unit, source)),
            2 => self
                .origins
                .get(&(unit, source))
                .copied()
                .ok_or_else(|| invalid("Missing KDB bind source")),
            _ => Err(invalid("Unrecognized KDB source-unit flags")),
        }
    }

    pub(super) fn interface_port(&mut self, instance: &Instance) -> io::Result<bool> {
        let (unit, source) = self.origin(instance)?;
        let view = self.view(unit)?;
        let source = unwrap_instance(&view, source)?;
        Ok(view.uint(source, 1)? == 77)
    }

    pub(super) fn resolve_master(
        &mut self,
        instance: &Instance,
        masters: &[Master],
    ) -> io::Result<Option<Master>> {
        let unit = instance.unit as u32;
        let view = self.view(unit)?;
        let source = unwrap_instance(&view, instance.source)?;
        let kind = view.uint(source, 2)?;
        let mut matches = Vec::new();
        if kind == 0x2051 {
            let original = view.pointer_required(source + 72)?;
            matches.extend(masters.iter().filter(|master| {
                master.unit == u64::from(unit)
                    && master.source == original
                    && matches!(master.category & 0xffff, 7..=9)
            }));
        } else if matches!(kind, 0x12c | 0x12d | 0x2c | 0x2d) {
            let targets = self.variants.get(&(unit, source));
            matches.extend(masters.iter().filter(|master| {
                master.category & 0xffff == 0
                    && targets.is_some_and(|targets| {
                        targets
                            .iter()
                            .any(|&(unit, _, _)| unit != 0 && u64::from(unit) == master.unit)
                    })
            }));
            if matches.is_empty() {
                let statement = view.pointer_required(source + 40)?;
                if view.uint(statement, 2)? != 0x2b {
                    return Err(invalid("Invalid KDB instance declaration statement"));
                }
                let name = view.string(view.pointer_required(statement + 16)?)?;
                matches.extend(masters.iter().filter(|master| {
                    master.name == name && matches!(master.category & 0xffff, 0 | 1)
                }));
            }
        }
        let first = matches.first().copied();
        Ok(first
            .filter(|first| {
                matches.iter().all(|item| {
                    item.name == first.name
                        && item.unit == first.unit
                        && item.source == first.source
                        && item.category == first.category
                })
            })
            .cloned())
    }

    pub(super) fn position(
        &mut self,
        instance: &Instance,
        sources: &Sources,
    ) -> io::Result<Option<Position>> {
        let (unit, source) = self.origin(instance)?;
        let view = self.view(unit)?;
        let mut source = unwrap_instance(&view, source)?;
        if view.uint(source, 1)? == 81 {
            source = view.pointer_required(source + 72)?;
        }
        let header = view.uint(source, 4)?;
        match header & 255 {
            44 | 45 | 64 | 66 | 82 => self.declaration_position(unit, source, header, sources),
            31 | 32 => {
                let name = self.document_from_handle(unit, view.uint(source + 80, 8)?)?;
                let line = view.uint(source + 104, 4)? as u32;
                Ok((line != 0)
                    .then(|| sources.document(&self.units[&unit].library, name))
                    .flatten()
                    .map(|file| Position { file, line }))
            }
            _ => Ok(None),
        }
    }

    pub(super) fn declaration_position(
        &mut self,
        unit: u32,
        key: u64,
        header: u64,
        sources: &Sources,
    ) -> io::Result<Option<Position>> {
        let line = self.view(unit)?.uint(key + 24, 4)? as u32;
        self.known_position(unit, key, header, line, sources)
    }

    pub(super) fn known_position(
        &mut self,
        unit: u32,
        key: u64,
        header: u64,
        line: u32,
        sources: &Sources,
    ) -> io::Result<Option<Position>> {
        let view = self.view(unit)?;
        let mut number = (header >> 8) & 127;
        if number == 0 || line == 0 {
            return Ok(None);
        }
        if number == 127 {
            if !self.extended_files.contains_key(&unit) {
                self.extended_files
                    .insert(unit, file_properties(&view, false)?);
            }
            number = *self.extended_files[&unit]
                .get(&key)
                .ok_or_else(|| invalid("Missing KDB extended source number"))?;
        }
        if !self.file_tables.contains_key(&unit) {
            let mut table = file_properties(&view, true)?;
            table.entry(1).or_insert(view.uint(104, 8)?);
            self.file_tables.insert(unit, table);
        }
        let handle = *self.file_tables[&unit]
            .get(&number)
            .ok_or_else(|| invalid("Unknown KDB source document number"))?;
        let name = self.document_from_handle(unit, handle)?;
        Ok(sources
            .document(&self.units[&unit].library, name)
            .map(|file| Position { file, line }))
    }

    fn document_from_handle(&self, unit: u32, handle: u64) -> io::Result<&str> {
        if handle % 2 != 0 || handle == 0 {
            return Err(invalid("Invalid KDB document string handle"));
        }
        self.strings
            .get(&self.units[&unit].library)
            .and_then(|strings| strings.get((handle / 2 - 1) as usize))
            .map(String::as_str)
            .ok_or_else(|| invalid("KDB document handle out of bounds"))
    }
}

fn file_properties(view: &View, root: bool) -> io::Result<HashMap<u64, u64>> {
    let mut result = HashMap::new();
    for (page, (flags, bytes)) in view.pages.iter().enumerate() {
        if root && *flags != 0 {
            continue;
        }
        for offset in (0..bytes.len().saturating_sub(47)).step_by(8) {
            if bytes[offset..offset + 8] != 11u64.to_le_bytes() {
                continue;
            }
            let key = (page as u64) << 16 | offset as u64;
            let (Ok(Some(owner)), Ok(Some(name))) = (view.pointer(key + 40), view.pointer(key + 8))
            else {
                continue;
            };
            let Ok(name) = view.string(name) else {
                continue;
            };
            let property = if root {
                if owner != 24 {
                    continue;
                }
                let Some(number) = name
                    .strip_prefix("bof")
                    .and_then(|suffix| suffix.parse::<u64>().ok())
                else {
                    continue;
                };
                number
            } else {
                if name != "bofl" {
                    continue;
                }
                if view.uint(key + 24, 8)? != 1 {
                    return Err(invalid("Invalid KDB extended document property"));
                }
                owner
            };
            let handle = view.uint(key + 32, 8)?;
            if result
                .insert(property, handle)
                .is_some_and(|before| before != handle)
            {
                return Err(invalid("Conflicting KDB file properties"));
            }
        }
    }
    Ok(result)
}

fn unwrap_instance(view: &View, source: u64) -> io::Result<u64> {
    if view.uint(source, 1)? == 46 {
        view.pointer_required(source + 8)
    } else {
        Ok(source)
    }
}

fn frames(directory: &Path, file: &str, codec: &Codec) -> io::Result<Vec<u8>> {
    Ok(framed(&directory.join(file), codec)?
        .into_iter()
        .flat_map(|(bytes, _)| bytes)
        .collect())
}

fn long_strings(path: &Path, codec: &Codec) -> io::Result<Vec<String>> {
    let raw = file_bytes(path)?;
    let mut file = Cursor::new(&raw);
    file.take(8)?;
    if word(&mut file)? != 0x01020304 {
        return Err(invalid("Invalid KDB long string table"));
    }
    file.take(36)?;
    let mut bytes = Vec::new();
    while !file.remaining().is_empty() {
        let length = word(&mut file)? as usize;
        let block = codec.lzo(Compression::Lzo1c, file.take(length)?, 4 * 1024 * 1024)?;
        if bytes.len() + block.len() > 16 * 1024 * 1024 {
            return Err(invalid("KDB long string table exceeds budget"));
        }
        bytes.extend(block);
    }
    let mut input = Cursor::new(&bytes);
    let count = word(&mut input)?;
    if count > 100_000 {
        return Err(invalid("KDB long string table exceeds count"));
    }
    let mut names = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let length = word(&mut input)? as usize;
        let name = str::from_utf8(input.take(length)?)
            .map_err(|_| invalid("Invalid UTF-8 in KDB long string table"))?
            .to_owned();
        input.expect(0)?;
        names.push(name);
    }
    if !input.remaining().is_empty() {
        return Err(invalid("Unexpected bytes after KDB strings"));
    }
    Ok(names)
}
