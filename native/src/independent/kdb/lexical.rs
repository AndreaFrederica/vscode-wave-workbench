// SPDX-License-Identifier: MPL-2.0

use super::{
    archive::View,
    objects::Objects,
    sdb::Instance,
    sources::{Position, Sources},
};
use crate::independent::bytes::invalid;
use std::{collections::HashSet, io};

pub(super) fn chain(view: &View, head: Option<u64>) -> io::Result<Vec<u64>> {
    let mut node = head;
    let mut visited = HashSet::new();
    let mut result = Vec::new();
    while let Some(key) = node {
        if !visited.insert(key) {
            if node == head {
                break;
            }
            return Err(invalid("KDB declaration chain has a non-root cycle"));
        }
        if result.len() >= 100_000 {
            return Err(invalid("KDB declaration chain exceeds budget"));
        }
        result.push(key);
        node = view.pointer(key + 8)?;
    }
    Ok(result)
}

pub(super) fn source_scope(view: &View, mut source: u64) -> io::Result<u64> {
    if view.uint(source, 1)? == 81 {
        source = view.pointer_required(source + 72)?;
    }
    if view.uint(source, 1)? == 46 {
        source = view.pointer_required(source + 8)?;
    }
    Ok(source)
}

pub(super) struct Child {
    pub name: String,
    pub kind: &'static str,
    pub key: u64,
    pub position: Position,
}

pub(super) fn children(
    objects: &mut Objects,
    sources: &Sources,
    unit: u32,
    source: u64,
) -> io::Result<Vec<Child>> {
    let view = objects.view(unit)?;
    let source = source_scope(&view, source)?;
    let (subroutines, wrappers, classes) = match view.uint(source, 1)? {
        31 | 32 => (
            view.pointer(source + 168)?,
            view.pointer(source + 176)?,
            view.pointer(source + 272)?,
        ),
        64 => (None, view.pointer(source + 80)?, None),
        66 => (
            view.pointer(source + 136)?,
            view.pointer(source + 88)?,
            view.pointer(source + 144)?,
        ),
        82 => (
            view.pointer(source + 56)?,
            None,
            view.pointer(source + 112)?,
        ),
        _ => return Err(invalid("Unrecognized KDB lexical scope owner")),
    };
    let mut keys = Vec::new();
    let mut seen = HashSet::new();
    for child in chain(&view, subroutines)? {
        let key = match view.uint(child, 1)? {
            64 => child,
            65 => {
                let Some(definition) = view.pointer(child + 88)? else {
                    continue;
                };
                if view.uint(definition, 1)? != 64
                    || view.string(view.pointer_required(child + 40)?)?
                        != view.string(view.pointer_required(definition + 40)?)?
                    || view.pointer(child + 56)? != view.pointer(definition + 56)?
                {
                    return Err(invalid("KDB subroutine prototype and definition differ"));
                }
                definition
            }
            _ => return Err(invalid("Unrecognized KDB subroutine object")),
        };
        if seen.insert(key) {
            keys.push(key);
        }
    }
    for wrapper in chain(&view, wrappers)? {
        if view.uint(wrapper, 1)? != 26 {
            return Err(invalid("Unrecognized KDB lexical scope wrapper"));
        }
        keys.push(view.pointer_required(wrapper + 16)?);
    }
    for child in chain(&view, classes)? {
        if view.uint(child, 1)? != 82 {
            return Err(invalid("Unrecognized KDB class object"));
        }
        keys.push(child);
    }
    let mut children = Vec::new();
    for key in keys {
        let (name_slot, owner_slot, kind) = match view.uint(key, 1)? {
            64 => {
                let flags = view.uint(key + 32, 4)?;
                if flags & 0x800 != 0 {
                    continue;
                }
                let kind = match flags & 0x300 {
                    0x100 => "npiTask",
                    0x200 => "npiFunction",
                    _ => return Err(invalid("Unrecognized KDB subroutine flags")),
                };
                (40, 56, kind)
            }
            66 => {
                let flags = view.uint(key + 4, 4)?;
                let statement = view.pointer(key + 48)?;
                let foreach = if let Some(statement) = statement {
                    flags & 0x4000_0000 != 0
                        && view.uint(statement, 1)? == 67
                        && view.uint(statement + 4, 1)? == 66
                } else {
                    false
                };
                let kind = if foreach {
                    "npiForeachStmt"
                } else if flags & 0x8000_0000 != 0 {
                    "npiFor"
                } else if flags & 16 != 0 {
                    if flags & 0x4000_0000 != 0 {
                        "npiFork"
                    } else {
                        "npiNamedFork"
                    }
                } else if flags & 0x4000_0000 != 0 {
                    "npiBegin"
                } else {
                    "npiNamedBegin"
                };
                (32, 80, kind)
            }
            82 => (32, 104, "npiClassDefn"),
            _ => return Err(invalid("Unrecognized KDB lexical scope object")),
        };
        if view.pointer(key + owner_slot)? != Some(source) {
            return Err(invalid("KDB lexical child owner mismatch"));
        }
        let name = view
            .string(view.pointer_required(key + name_slot)?)?
            .to_owned();
        let position = objects
            .position(
                &Instance {
                    name: name.clone(),
                    unit: u64::from(unit),
                    source: key,
                },
                sources,
            )?
            .ok_or_else(|| invalid("KDB lexical scope source location is unavailable"))?;
        children.push(Child {
            name,
            kind,
            key,
            position,
        });
    }
    children.sort_by_key(|child| (child.position.line, child.key));
    Ok(children)
}
