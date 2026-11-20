// SPDX-License-Identifier: MPL-2.0

use super::archive::{file_bytes, libraries, word};
use crate::independent::bytes::{invalid, Cursor, Input};
use std::{collections::HashMap, io, path::Path};

#[derive(Clone, PartialEq, Eq, Hash, serde::Serialize)]
pub(super) struct Position {
    pub file: String,
    pub line: u32,
}

struct Documents {
    exact: HashMap<String, String>,
    basenames: HashMap<String, Option<String>>,
}

pub(super) struct Sources {
    documents: HashMap<String, Documents>,
    units: HashMap<String, Option<Position>>,
}

impl Sources {
    pub(super) fn open(directory: &Path) -> io::Result<Self> {
        let mut sources = Self {
            documents: HashMap::new(),
            units: HashMap::new(),
        };
        for library in libraries(directory)? {
            let filename = library.join("MapTbl");
            if !filename.is_file() {
                continue;
            }
            let name = library
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("Invalid KDB library name"))?;
            let docs = read_documents(&library.join("AbsDocNameTbl"))?;
            sources.documents.insert(name.to_owned(), docs);

            let bytes = file_bytes(&filename)?;
            let mut table = Cursor::new(&bytes);
            if word(&mut table)? != 0x01020304 || word(&mut table)? != 117 {
                return Err(invalid("Unrecognized KDB source table header"));
            }
            let buckets = word(&mut table)?;
            if buckets > 1024 {
                return Err(invalid("KDB source table exceeds bucket bounds"));
            }
            let mut total = 0;
            for _ in 0..buckets {
                let descriptor = word(&mut table)?;
                let count = descriptor >> 10;
                total += count;
                if count == 0 || total > 100_000 {
                    return Err(invalid("KDB source table exceeds record bounds"));
                }
                for _ in 0..count {
                    if word(&mut table)? & 1023 != descriptor & 1023 {
                        return Err(invalid("KDB source hash does not match bucket"));
                    }
                    let unit = table.string()?;
                    let unit = unit
                        .strip_suffix("&hdl")
                        .ok_or_else(|| invalid("Invalid source unit language"))?;
                    let reference = table.string()?;
                    let first = word(&mut table)?;
                    let last = word(&mut table)?;
                    table.take(8)?;
                    if first == 0 || last < first {
                        return Err(invalid("Invalid KDB source line range"));
                    }
                    let position = (reference != "?")
                        .then(|| sources.document(name, &reference))
                        .flatten()
                        .map(|file| Position { file, line: first });
                    sources
                        .units
                        .entry(unit.to_owned())
                        .and_modify(|existing| *existing = None)
                        .or_insert(position);
                }
            }
            let count = word(&mut table)?;
            if count > 100_000 {
                return Err(invalid("KDB source count exceeds bounds"));
            }
            for _ in 0..count {
                table.string()?;
                table.take(4)?;
            }
            if !table.remaining().is_empty() {
                return Err(invalid("Unexpected bytes after KDB source table"));
            }
        }
        Ok(sources)
    }

    pub(super) fn lookup(&self, unit: &str) -> Option<&Position> {
        self.units.get(unit).and_then(Option::as_ref)
    }

    pub(super) fn document(&self, library: &str, name: &str) -> Option<String> {
        let lookup = self.documents.get(library)?;
        let file = lookup.exact.get(name).or_else(|| {
            lookup
                .basenames
                .get(basename(name)?)
                .and_then(Option::as_ref)
        })?;
        Some(strip_include_suffix(file).to_owned())
    }
}

fn read_documents(path: &Path) -> io::Result<Documents> {
    let bytes = file_bytes(path)?;
    let mut input = Cursor::new(&bytes);
    if word(&mut input)? != 0 || word(&mut input)? != 0x01020304 || word(&mut input)? != 4 {
        return Err(invalid("Unrecognized KDB document index header"));
    }
    let count = word(&mut input)?;
    if count > 100_000 {
        return Err(invalid("KDB document index exceeds bounds"));
    }
    let mut exact = HashMap::new();
    let mut basenames = HashMap::new();
    for _ in 0..count {
        let name = complemented_string(&mut input)?;
        let file = complemented_string(&mut input)?;
        input.take(5)?;
        if exact.get(&name).is_some_and(|existing| existing != &file) {
            return Err(invalid("Ambiguous KDB document mapping"));
        }
        if let Some(base) = basename(&name) {
            basenames
                .entry(base.to_owned())
                .and_modify(|value: &mut Option<String>| {
                    if value.as_ref() != Some(&file) {
                        *value = None;
                    }
                })
                .or_insert_with(|| Some(file.clone()));
        }
        exact.insert(name, file);
    }
    if !input.remaining().is_empty() {
        return Err(invalid("Unexpected bytes after KDB document index"));
    }
    Ok(Documents { exact, basenames })
}

fn basename(name: &str) -> Option<&str> {
    Path::new(name).file_name().and_then(|name| name.to_str())
}

fn complemented_string(input: &mut Cursor<'_>) -> io::Result<String> {
    let length = input
        .remaining()
        .iter()
        .take(1 << 20)
        .position(|&byte| byte == 0)
        .ok_or_else(|| invalid("Missing KDB document path terminator"))?;
    let bytes = input.take(length)?.iter().map(|byte| !byte).collect();
    input.expect(0)?;
    String::from_utf8(bytes).map_err(|_| invalid("Invalid UTF-8 in KDB document path"))
}

fn strip_include_suffix(file: &str) -> &str {
    let Some((base, suffix)) = file.rsplit_once("#inc__") else {
        return file;
    };
    let Some(suffix) = suffix.strip_suffix('#') else {
        return file;
    };
    let Some((name, serial)) = suffix.rsplit_once("__") else {
        return file;
    };
    if !name.is_empty()
        && !name.contains('#')
        && !serial.is_empty()
        && serial.bytes().all(|byte| byte.is_ascii_digit())
    {
        base
    } else {
        file
    }
}
