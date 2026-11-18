// SPDX-License-Identifier: MPL-2.0

use super::{
    lexical,
    sdb::{ArrayShape, Instance},
    sources::Position,
    Location, Session,
};
use crate::independent::bytes::invalid;
use std::{
    collections::{HashMap, HashSet},
    io,
};

#[derive(Clone)]
pub(super) struct Array {
    pub shape: ArrayShape,
    pub parent: Option<usize>,
    pub elements: HashMap<i32, usize>,
}

#[derive(Default)]
pub(super) struct Interfaces {
    pub source_instances: HashMap<(u32, u64), Vec<usize>>,
    pub source_arrays: HashMap<(u32, u64), Vec<String>>,
    pub arrays: HashMap<String, Array>,
    pub formal_arrays: HashMap<(String, String), ArrayShape>,
}

struct Formal {
    ordinal: u32,
    position: Position,
    array: bool,
    modport: Option<(u32, u64)>,
}

enum Target {
    Scalar(usize),
    Array(String),
}

impl Session {
    pub(super) fn resolve_reference(&mut self, query: &str) -> io::Result<(Location, String)> {
        let mut owner = query;
        let owner_index = loop {
            let Some((parent, _)) = owner.rsplit_once('.') else {
                return Err(invalid("KDB interface reference has no owner"));
            };
            owner = parent;
            if let Some(&index) = self.names.get(owner) {
                break index;
            }
        };
        let tail = &query[owner.len() + 1..];
        let split = tail.find(['.', '[']).unwrap_or(tail.len());
        let name = &tail[..split];
        let formal = self.formal(owner_index, name)?;
        let mut suffix = &tail[split..];
        let mut target = self.actual(owner_index, name, &mut HashSet::new())?;
        if let Some(index) = suffix.strip_prefix('[') {
            let (index, rest) = index
                .split_once(']')
                .ok_or_else(|| invalid("Invalid KDB interface array index"))?;
            let index: i32 = index
                .parse()
                .map_err(|_| invalid("Invalid KDB interface array index"))?;
            let shape = self
                .interfaces
                .formal_arrays
                .get(&(owner.to_owned(), name.to_owned()))
                .filter(|_| formal.array)
                .ok_or_else(|| invalid("KDB interface formal is not an array"))?;
            let ordinal = shape
                .ordinal(index)
                .ok_or_else(|| invalid("KDB interface formal index is out of bounds"))?;
            let Target::Array(array) = target else {
                return Err(invalid("KDB interface actual is not an array"));
            };
            let array = &self.interfaces.arrays[&array];
            let index = array
                .shape
                .index(ordinal)
                .and_then(|index| array.elements.get(&index))
                .ok_or_else(|| invalid("KDB interface actual index is out of bounds"))?;
            target = Target::Scalar(*index);
            suffix = rest;
        }
        if !suffix.is_empty() {
            let member = suffix
                .strip_prefix('.')
                .filter(|member| !member.contains('.'))
                .ok_or_else(|| invalid("Unrecognized KDB interface member path"))?;
            if let Some((unit, key)) = formal.modport {
                let view = self.objects.view(unit)?;
                let mut found = false;
                for item in lexical::chain(&view, view.pointer(key + 56)?)? {
                    if view.uint(item, 1)? != 76 {
                        return Err(invalid("Unrecognized KDB modport member"));
                    }
                    if view.string(view.pointer_required(item + 24)?)? == member {
                        if found {
                            return Err(invalid("Ambiguous KDB modport member"));
                        }
                        found = true;
                    }
                }
                if !found {
                    return Err(invalid("KDB modport member is absent"));
                }
            } else {
                let index = match target {
                    Target::Scalar(index) => index,
                    Target::Array(array) => *self.interfaces.arrays[&array]
                        .elements
                        .values()
                        .next()
                        .ok_or_else(|| invalid("KDB interface array has no elements"))?,
                };
                let node = &self.nodes[index];
                let value = format!("{}.{}", node.fullname, member);
                if !self.names.contains_key(&value) {
                    self.value(&value)?;
                }
            }
        }
        let location = self.location(
            query,
            "npiRefObj",
            formal.position,
            self.context(owner_index),
        );
        let parent = if suffix.is_empty() {
            owner
        } else {
            query.rsplit_once('.').unwrap().0
        };
        Ok((location, parent.to_owned()))
    }

    fn formal(&mut self, index: usize, name: &str) -> io::Result<Formal> {
        let owner = &self.nodes[index];
        if !matches!(owner.kind, "npiModule" | "npiInterface" | "npiProgram") {
            return Err(invalid(
                "KDB interface formal owner is not a design instance",
            ));
        }
        let view = self.objects.view(owner.unit)?;
        for port in lexical::chain(&view, view.pointer(owner.source + 56)?)? {
            if view.uint(port, 1)? != 47 {
                return Err(invalid("Invalid KDB formal port object"));
            }
            let declaration = view.pointer_required(port + 24)?;
            let header = view.uint(declaration, 4)?;
            if header & 255 != 77 || view.string(view.pointer_required(declaration + 24)?)? != name
            {
                continue;
            }
            let line = view.uint(declaration + 4, 4)? as u32;
            let position = self
                .objects
                .known_position(owner.unit, declaration, header, line, &self.sources)?
                .ok_or_else(|| invalid("KDB interface formal source is unavailable"))?;
            let mut parts = Vec::new();
            for part in lexical::chain(&view, view.pointer(declaration + 32)?)? {
                if view.uint(part, 4)? != 27 {
                    return Err(invalid("Invalid KDB interface type name"));
                }
                parts.push(view.string(view.pointer_required(part + 24)?)?);
            }
            let modport = if header & 0x80000000 != 0 {
                if !parts.is_empty() {
                    return Err(invalid("Generic KDB interface has a named type"));
                }
                None
            } else {
                let [base, ..] = parts.as_slice() else {
                    return Err(invalid("Missing KDB interface type name"));
                };
                if parts.len() > 2 {
                    return Err(invalid("Unrecognized KDB qualified interface type"));
                }
                let mut definitions = self
                    .definitions
                    .get(*base)
                    .into_iter()
                    .flatten()
                    .filter_map(|&index| {
                        let node = &self.nodes[index];
                        (node.kind == "npiInterface").then_some((node.unit, node.source))
                    });
                let first = definitions
                    .next()
                    .ok_or_else(|| invalid("KDB interface definition is missing"))?;
                if definitions.any(|subsequent| subsequent != first) {
                    return Err(invalid("Ambiguous KDB interface definition"));
                }
                let (unit, root) = first;
                let target_view = self.objects.view(unit)?;
                let target = view
                    .pointer_into(declaration + 48, &target_view)?
                    .ok_or_else(|| invalid("Missing KDB interface type target"))?;
                if parts.len() == 1 {
                    if target != root || target_view.uint(target, 1)? != 32 {
                        return Err(invalid("KDB interface type target mismatch"));
                    }
                    None
                } else {
                    if target_view.uint(target, 1)? != 75
                        || target_view.pointer(target + 48)? != Some(root)
                        || target_view.string(target_view.pointer_required(target + 32)?)?
                            != parts[1]
                    {
                        return Err(invalid("KDB interface modport type target mismatch"));
                    }
                    Some((unit, target))
                }
            };
            return Ok(Formal {
                ordinal: view.uint(port + 16, 4)? as u32,
                position,
                array: header & 0x40000000 != 0,
                modport,
            });
        }
        Err(invalid("KDB interface formal not found"))
    }

    fn actual(
        &mut self,
        index: usize,
        name: &str,
        active: &mut HashSet<(usize, String)>,
    ) -> io::Result<Target> {
        if active.len() >= 128 || !active.insert((index, name.to_owned())) {
            return Err(invalid("Cyclic KDB interface binding"));
        }
        let formal = self.formal(index, name)?;
        let owner = &self.nodes[index];
        let caller = owner
            .parent
            .ok_or_else(|| invalid("KDB interface binding has no caller"))?;
        let instance = owner
            .instance
            .ok_or_else(|| invalid("KDB interface binding has no instance"))?;
        let (unit, source) = self
            .objects
            .origin(&self.instances[instance as usize - 1])?;
        let view = self.objects.view(unit)?;
        let source = if view.uint(source, 1)? == 46 {
            view.pointer_required(source + 8)?
        } else {
            source
        };
        if !matches!(view.uint(source, 1)?, 44 | 45) {
            return Err(invalid("Unrecognized KDB interface call object"));
        }
        let mut target = None;
        for connection in lexical::chain(&view, view.pointer(source + 48)?)? {
            let header = view.uint(connection, 4)?;
            if header & 255 != 49 {
                return Err(invalid("Unrecognized KDB actual port object"));
            }
            let matches = if header & 0x80000000 != 0 {
                view.string(view.pointer_required(connection + 32)?)? == name
            } else {
                view.uint(connection + 32, 4)? == u64::from(formal.ordinal)
            };
            if matches
                && target
                    .replace(view.pointer_required(connection + 48)?)
                    .is_some()
            {
                return Err(invalid("Ambiguous KDB actual port connection"));
            }
        }
        let source = target.ok_or_else(|| invalid("Missing KDB actual port connection"))?;
        let target = match view.uint(source, 1)? {
            77 => self.actual(
                caller,
                view.string(view.pointer_required(source + 24)?)?,
                active,
            )?,
            44 | 45 | 46 => self.nearest_actual(caller, (unit, source))?,
            60 => self.hierarchical_actual(caller, unit, source)?,
            _ => return Err(invalid("Unrecognized KDB interface actual expression")),
        };
        match &target {
            Target::Array(array) if formal.array => {
                let shape = self
                    .interfaces
                    .formal_arrays
                    .get(&(self.nodes[index].fullname.clone(), name.to_owned()))
                    .ok_or_else(|| invalid("KDB interface formal array shape missing"))?;
                if shape.left.abs_diff(shape.right) as usize + 1
                    != self.interfaces.arrays[array].elements.len()
                {
                    return Err(invalid(
                        "KDB interface array formal and actual shapes differ",
                    ));
                }
            }
            Target::Scalar(_) if !formal.array => {}
            _ => return Err(invalid("KDB interface formal and actual categories differ")),
        }
        active.remove(&(index, name.to_owned()));
        Ok(target)
    }

    fn nearest_actual(&self, caller: usize, source: (u32, u64)) -> io::Result<Target> {
        let scalar = self
            .interfaces
            .source_instances
            .get(&source)
            .into_iter()
            .flatten()
            .map(|&index| (self.nodes[index].parent, Target::Scalar(index)));
        let arrays = self
            .interfaces
            .source_arrays
            .get(&source)
            .into_iter()
            .flatten()
            .map(|name| {
                (
                    self.interfaces.arrays[name].parent,
                    Target::Array(name.clone()),
                )
            });
        let candidates: Vec<_> = scalar.chain(arrays).collect();
        let mut parent = Some(caller);
        loop {
            let mut matches = candidates
                .iter()
                .filter(|(candidate, _)| *candidate == parent);
            if let Some((_, target)) = matches.next() {
                if matches.next().is_some() {
                    return Err(invalid("Ambiguous KDB interface actual object"));
                }
                return Ok(match target {
                    Target::Scalar(index) => Target::Scalar(*index),
                    Target::Array(name) => Target::Array(name.clone()),
                });
            }
            parent = match parent {
                Some(index) => self.nodes[index].parent,
                None => break,
            };
        }
        Err(invalid("KDB interface actual lies outside caller ancestry"))
    }

    fn hierarchical_actual(&mut self, caller: usize, unit: u32, source: u64) -> io::Result<Target> {
        let view = self.objects.view(unit)?;
        let mut next = Some(source);
        let mut segments = Vec::new();
        let mut seen = HashSet::new();
        let mut identity = (0, 0);
        while let Some(key) = next {
            if seen.len() >= 128 || !seen.insert(key) || view.uint(key, 1)? != 60 {
                return Err(invalid("Invalid KDB hierarchical interface path"));
            }
            segments.push(view.string(view.pointer_required(key + 24)?)?);
            let declaration_unit = (view.uint(key + 20, 4)? >> 16) as u32;
            let declaration_unit = if declaration_unit == 0 {
                unit
            } else {
                declaration_unit
            };
            let declaration_view = self.objects.view(declaration_unit)?;
            let declaration = view.pointer_into(key + 48, &declaration_view)?;
            identity = (
                declaration_unit,
                declaration.ok_or_else(|| invalid("Missing KDB hierarchical declaration"))?,
            );
            next = view.pointer(key + 40)?;
        }
        let path = segments.join(".");
        let mut parent = Some(caller);
        loop {
            let query = parent.map_or_else(
                || path.clone(),
                |index| format!("{}.{}", self.nodes[index].fullname, path),
            );
            if let Some(&index) = self.names.get(&query) {
                let node = &self.nodes[index];
                let source = node
                    .instance
                    .map(|instance| self.objects.origin(&self.instances[instance as usize - 1]))
                    .transpose()?;
                if node.kind != "npiInterface" || source != Some(identity) {
                    return Err(invalid(
                        "KDB hierarchical actual disagrees with declaration",
                    ));
                }
                return Ok(Target::Scalar(index));
            }
            if let Some(array) = self.interfaces.arrays.get(&query) {
                let shape = &array.shape;
                let source = self.objects.origin(&Instance {
                    name: shape.name.clone(),
                    unit: shape.unit,
                    source: shape.source,
                })?;
                if source != identity {
                    return Err(invalid("KDB hierarchical array disagrees with declaration"));
                }
                return Ok(Target::Array(query));
            }
            parent = match parent {
                Some(index) => self.nodes[index].parent,
                None => break,
            };
        }
        Err(invalid("KDB hierarchical actual has no runtime instance"))
    }
}
