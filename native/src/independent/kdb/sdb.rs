// SPDX-License-Identifier: MPL-2.0

use super::archive::{file_bytes, ARCHIVE_BUDGET};
use crate::independent::{
    bytes::{invalid, le},
    codec::MAX_BLOCK,
};
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::{Component, Path},
    str,
};

struct Buffer<'a>(&'a [u8]);

impl Buffer<'_> {
    fn bytes(&self, offset: usize, width: usize) -> io::Result<&[u8]> {
        let end = offset
            .checked_add(width)
            .ok_or_else(|| invalid("KDB record offset overflow"))?;
        self.0
            .get(offset..end)
            .ok_or_else(|| invalid("KDB record exceeds buffer"))
    }
    fn int(&self, offset: usize, width: usize) -> io::Result<u64> {
        le(self.bytes(offset, width)?)
    }
    fn word(&self, offset: usize) -> io::Result<u32> {
        Ok(self.int(offset, 4)? as u32)
    }
    fn target(&self, offset: usize) -> io::Result<usize> {
        offset
            .checked_add(self.word(offset)? as usize)
            .ok_or_else(|| invalid("KDB relative pointer overflow"))
    }
    fn vector(&self, slot: usize, stride: usize) -> io::Result<Vec<usize>> {
        if self.bytes(4, 4)? != b"0000" {
            return Err(invalid("Invalid KDB table identifier"));
        }
        let table = self.word(0)? as usize;
        let displacement = self.word(table)? as i32 as i64;
        let vtable = usize::try_from(table as i64 - displacement)
            .map_err(|_| invalid("Invalid KDB vtable address"))?;
        let size = self.int(vtable, 2)? as usize;
        if !(4..=256).contains(&size) || size % 2 != 0 || self.int(vtable + 2, 2)? < 4 {
            return Err(invalid("Invalid KDB vtable layout"));
        }
        if slot >= (size - 4) / 2 {
            return Ok(Vec::new());
        }
        let field = self.int(vtable + 4 + slot * 2, 2)? as usize;
        if field == 0 {
            return Ok(Vec::new());
        }
        let target = self.target(table + field)?;
        let count = self.word(target)? as usize;
        if count > 1_000_000 {
            return Err(invalid("KDB vector exceeds size budget"));
        }
        self.bytes(target + 4, count * stride)?;
        Ok((0..count).map(|i| target + 4 + i * stride).collect())
    }
    fn string(&self, field: usize) -> io::Result<&str> {
        let target = self.target(field)?;
        let length = self.word(target)? as usize;
        if length > 1 << 20 || self.int(target + 4 + length, 1)? != 0 {
            return Err(invalid("Invalid KDB index string"));
        }
        str::from_utf8(self.bytes(target + 4, length)?)
            .map_err(|_| invalid("Invalid UTF-8 in KDB index"))
    }
}

#[derive(Clone)]
pub(super) struct Instance {
    pub name: String,
    pub unit: u64,
    pub source: u64,
}

#[derive(Clone)]
pub(super) struct Master {
    pub name: String,
    pub unit: u64,
    pub source: u64,
    pub category: u32,
}

pub(super) struct Link {
    pub instance: u32,
    pub target: (u32, u32),
    pub parent: u32,
    pub reuse: bool,
}

#[derive(Clone)]
pub(super) struct ArrayShape {
    pub name: String,
    pub left: i32,
    pub right: i32,
    pub unit: u64,
    pub source: u64,
}

impl ArrayShape {
    pub(super) fn ordinal(&self, index: i32) -> Option<u32> {
        (self.left.min(self.right)..=self.left.max(self.right))
            .contains(&index)
            .then(|| self.left.abs_diff(index))
    }

    pub(super) fn index(&self, ordinal: u32) -> Option<i32> {
        (ordinal <= self.left.abs_diff(self.right)).then(|| {
            if self.left <= self.right {
                self.left + ordinal as i32
            } else {
                self.left - ordinal as i32
            }
        })
    }
}

pub(super) struct Sdb {
    pub instances: Vec<Instance>,
    pub masters: Vec<Master>,
    pub variants: Vec<usize>,
    pub variant_sources: Vec<(u32, u64)>,
    pub links: Vec<Link>,
    pub array_targets: HashMap<(u32, u32), (u32, u32)>,
    pub array_shapes: HashMap<(u32, u32), ArrayShape>,
    pub namespace: u32,
}

impl Sdb {
    pub(super) fn open(directory: &Path) -> io::Result<Self> {
        let index = file_bytes(&directory.join("sdb.db"))?;
        let index = Buffer(&index);
        let names = index
            .vector(2, 4)?
            .into_iter()
            .map(|pos| index.string(pos))
            .collect::<io::Result<Vec<_>>>()?;
        if names.iter().any(|&name| {
            let mut components = Path::new(name).components();
            !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some()
        }) {
            return Err(invalid("KDB index contains an invalid file name"));
        }
        let mut total = 0usize;
        let mut chunks = Vec::new();
        for pos in index.vector(4, 24)? {
            let kind = index.int(pos, 1)? as u8;
            let file = index.int(pos + 1, 1)? as usize;
            let decoded = index.word(pos + 8)? as usize;
            let stored = index.word(pos + 12)? as usize;
            let offset = index.int(pos + 16, 8)?;
            total += decoded;
            let name = file
                .checked_sub(1)
                .and_then(|index| names.get(index))
                .ok_or_else(|| invalid("KDB index points to an unknown file"))?;
            if index.bytes(pos + 2, 6)? != [0; 6]
                || decoded > MAX_BLOCK
                || stored > MAX_BLOCK
                || total > ARCHIVE_BUDGET
            {
                return Err(invalid("KDB chunk metadata or size exceeds limits"));
            }
            let mut stream = File::open(directory.join(name))?;
            stream.seek(SeekFrom::Start(offset))?;
            let mut raw = vec![0; stored];
            stream.read_exact(&mut raw)?;
            let data = if raw.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
                let decoder = ruzstd::decoding::StreamingDecoder::new(raw.as_slice())
                    .map_err(|err| invalid(format!("KDB zstd frame: {err}")))?;
                let mut bytes = Vec::with_capacity(decoded);
                decoder.take(decoded as u64 + 1).read_to_end(&mut bytes)?;
                bytes
            } else {
                raw
            };
            if data.len() != decoded {
                return Err(invalid("KDB chunk decoded size mismatch"));
            }
            chunks.push((kind, data));
        }

        let unique = |kind| {
            let mut matches = chunks.iter().filter(|(tag, _)| *tag == kind);
            let slice = matches.next().map(|(_, data)| data.as_slice());
            match (slice, matches.next()) {
                (Some(slice), None) => Ok(slice),
                _ => Err(invalid(format!("KDB requires one table of kind {kind}"))),
            }
        };
        let names = unique(5)?;
        let name = |tag, reference: u32| -> io::Result<String> {
            if tag != 3 {
                return Err(invalid("Unknown KDB name namespace"));
            }
            let tail = reference
                .checked_sub(1)
                .and_then(|offset| names.get(offset as usize..))
                .ok_or_else(|| invalid("KDB name index exceeds bounds"))?;
            let length = tail
                .iter()
                .take(1 << 20)
                .position(|&byte| byte == 0)
                .ok_or_else(|| invalid("Missing KDB name terminator"))?;
            String::from_utf8(tail[..length].to_vec())
                .map_err(|_| invalid("Invalid UTF-8 in KDB name"))
        };
        let instances_table = Buffer(unique(3)?);
        let mut instances = Vec::new();
        for pos in instances_table.vector(0, 24)? {
            instances.push(Instance {
                name: name(instances_table.word(pos)?, instances_table.word(pos + 4)?)?,
                unit: instances_table.int(pos + 8, 8)?,
                source: instances_table.int(pos + 16, 8)?,
            });
        }
        let masters_table = Buffer(unique(1)?);
        let rows = masters_table.vector(0, 40)?;
        let handles = masters_table.vector(9, 8)?;
        if rows.len() != handles.len() {
            return Err(invalid(
                "KDB master names and handles have different counts",
            ));
        }
        let mut masters = Vec::new();
        let mut backlinks = Vec::new();
        let mut namespace = 0;
        for (row, handle) in rows.into_iter().zip(handles) {
            let tag = masters_table.word(handle)?;
            if tag == 0 || namespace != 0 && tag != namespace {
                return Err(invalid("Invalid KDB master namespace"));
            }
            namespace = tag;
            backlinks.push(masters_table.word(handle + 4)?);
            masters.push(Master {
                name: name(masters_table.word(row + 8)?, masters_table.word(row + 12)?)?,
                unit: masters_table.int(row + 24, 8)?,
                source: masters_table.int(row + 32, 8)?,
                category: masters_table.word(row)?,
            });
        }
        let variant_table = Buffer(unique(9)?);
        let rows = variant_table.vector(0, 24)?;
        let sources = variant_table.vector(1, 16)?;
        if sources.len() != rows.len() {
            return Err(invalid("KDB variant and source counts differ"));
        }
        let mut variants = Vec::new();
        let mut variant_sources = Vec::new();
        for (row, source) in rows.into_iter().zip(sources) {
            let id = variant_table.word(row + 4)?;
            if variant_table.word(row)? != 2 || id == 0 || id as usize > masters.len() {
                return Err(invalid("Unknown KDB canonical master"));
            }
            variants.push(id as usize - 1);
            variant_sources.push((
                variant_table.int(source, 8)? as u32,
                variant_table.int(source + 8, 8)?,
            ));
        }
        for (index, &id) in backlinks.iter().enumerate() {
            if id == 0 || variants.get(id as usize - 1) != Some(&index) {
                return Err(invalid("KDB canonical master backlink mismatch"));
            }
        }
        let mut links = Vec::new();
        let mut array_targets = HashMap::new();
        let mut array_shapes = HashMap::new();
        for (kind, bytes) in &chunks {
            let table = Buffer(bytes);
            match kind {
                0 => {
                    let children = table.vector(0, 16)?;
                    let parents = table.vector(2, 8)?;
                    let reuse = table.vector(1, 8)?;
                    if children.len() != parents.len() || reuse.len() > children.len() {
                        return Err(invalid("KDB instance table column counts differ"));
                    }
                    for (index, (child, parent)) in children.into_iter().zip(parents).enumerate() {
                        let tag = table.word(child)?;
                        let target = table.word(child + 4)?;
                        let instance_tag = table.word(child + 8)?;
                        let instance = table.word(child + 12)?;
                        let parent_tag = table.word(parent)?;
                        if tag == 0
                            || instance_tag == 0
                            || instance == 0
                            || instance as usize > instances.len()
                            || ![0, namespace].contains(&parent_tag)
                        {
                            return Err(invalid("Invalid KDB instance link"));
                        }
                        let reuse = reuse
                            .get(index)
                            .map(|&offset| table.int(offset, 8))
                            .transpose()?
                            .unwrap_or(0)
                            != 0;
                        links.push(Link {
                            instance,
                            target: (tag, target),
                            parent: table.word(parent + 4)?,
                            reuse,
                        });
                    }
                }
                2 => {
                    let tags = table.vector(0, 1)?;
                    let references = table.vector(1, 4)?;
                    if tags.len() != references.len() {
                        return Err(invalid("KDB array table column counts differ"));
                    }
                    for (index, (&tag, &reference)) in tags.iter().zip(&references).enumerate() {
                        if table.int(tag, 1)? != 2 {
                            continue;
                        }
                        let record = table.target(reference)?;
                        let target = (table.word(record)?, table.word(record + 4)?);
                        let shape_tag = table.word(record + 8)?;
                        let id = table.word(record + 12)?;
                        let shape_index = id
                            .checked_sub(1)
                            .filter(|&id| (id as usize) < tags.len())
                            .ok_or_else(|| invalid("KDB array shape points outside table"))?
                            as usize;
                        let key = (shape_tag, index as u32 + 1);
                        if target.0 == 0
                            || target.1 == 0
                            || shape_tag == 0
                            || table.int(tags[shape_index], 1)? != 1
                            || array_targets.insert(key, target).is_some()
                        {
                            return Err(invalid("Invalid KDB array master reference"));
                        }
                        let shape = table.target(references[shape_index])?;
                        let right = table.word(shape)? as i32;
                        let left = table.word(shape + 4)? as i32;
                        if right.abs_diff(left) >= 300_000
                            || table.word(shape + 16)? == 0
                            || table.word(shape + 20)? == 0
                        {
                            return Err(invalid("Invalid KDB array shape bounds or owner"));
                        }
                        array_shapes.insert(
                            key,
                            ArrayShape {
                                name: name(table.word(shape + 8)?, table.word(shape + 12)?)?,
                                left,
                                right,
                                unit: table.int(shape + 24, 8)?,
                                source: table.int(shape + 32, 8)?,
                            },
                        );
                    }
                }
                _ => {}
            }
        }
        Ok(Self {
            instances,
            masters,
            variants,
            variant_sources,
            links,
            array_targets,
            array_shapes,
            namespace,
        })
    }
}
