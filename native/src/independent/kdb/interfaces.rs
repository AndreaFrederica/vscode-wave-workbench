// SPDX-License-Identifier: MPL-2.0

use super::{
    lexical,
    ports::Selection,
    sdb::{ArrayShape, Instance},
    sources::Position,
    Location, Session,
};
use crate::independent::bytes::invalid;
use serde::Serialize;
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
    bindings_by_instance: Option<HashMap<usize, Vec<BoundFormal>>>,
}

#[derive(Clone)]
struct Formal {
    ordinal: u32,
    position: Position,
    array: bool,
    modport: Option<(u32, u64)>,
    generic: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GenericInterfaceType {
    pub formal: String,
    pub formal_file: String,
    pub formal_line: u32,
    pub interface: String,
    pub interface_file: String,
    pub interface_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modport: Option<String>,
}

struct BoundFormal {
    owner: usize,
    name: String,
    formal: Formal,
}

enum Target {
    Scalar(usize),
    Array(String),
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct ModportMember {
    backing: String,
    range: Option<[i32; 2]>,
    width: Option<u32>,
    two_state: Option<bool>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct ModportAlias {
    parts: Vec<ModportMember>,
    declaration: Option<Position>,
}

impl Session {
    pub(super) fn generic_interface_types(
        &mut self,
        query: &str,
    ) -> io::Result<Vec<GenericInterfaceType>> {
        let owner = self.node(query)?;
        let node = &self.nodes[owner];
        if !matches!(node.kind, "npiModule" | "npiInterface" | "npiProgram") {
            return Ok(Vec::new());
        }
        let names = self.interface_formal_names(node.unit, node.source)?;
        let mut types = Vec::new();
        for name in names {
            let Ok((formal, target)) = self.actual(owner, &name, &mut HashSet::new()) else {
                continue;
            };
            if !formal.generic {
                continue;
            }
            let actual = match target {
                Target::Scalar(index) => &self.nodes[index],
                Target::Array(array) => {
                    let mut elements = self.interfaces.arrays[&array]
                        .elements
                        .values()
                        .map(|&index| &self.nodes[index]);
                    let Some(first) = elements.next() else {
                        continue;
                    };
                    if elements.any(|element| {
                        element.kind != first.kind
                            || element.module != first.module
                            || (element.unit, element.source) != (first.unit, first.source)
                    }) {
                        continue;
                    }
                    first
                }
            };
            let Some(definition) = self.sources.lookup(&actual.module) else {
                continue;
            };
            types.push(GenericInterfaceType {
                formal: name,
                formal_file: formal.position.file,
                formal_line: formal.position.line,
                interface: actual.module.clone(),
                interface_file: definition.file.clone(),
                interface_line: definition.line,
                modport: formal
                    .modport
                    .map(|(unit, key)| {
                        let view = self.objects.view(unit)?;
                        Ok::<_, io::Error>(
                            view.string(view.pointer_required(key + 32)?)?.to_owned(),
                        )
                    })
                    .transpose()?,
            });
        }
        Ok(types)
    }

    pub(super) fn resolve_reference(&mut self, query: &str) -> io::Result<(Location, String)> {
        let (owner_index, owner, formal, target, suffix) = self.reference_binding(query)?;
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

    fn reference_binding<'a>(
        &mut self,
        query: &'a str,
    ) -> io::Result<(usize, &'a str, Formal, Target, &'a str)> {
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
        let mut suffix = &tail[split..];
        let (formal, mut target) = self.actual(owner_index, name, &mut HashSet::new())?;
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
        Ok((owner_index, owner, formal, target, suffix))
    }

    fn modport_members(
        &mut self,
        (unit, key): (u32, u64),
        instance: usize,
    ) -> io::Result<Vec<(String, ModportAlias)>> {
        let view = self.objects.view(unit)?;
        let mut members = Vec::new();
        for item in lexical::chain(&view, view.pointer(key + 56)?)? {
            if view.uint(item, 1)? != 76 {
                return Err(invalid("Unrecognized KDB modport member"));
            }
            let alias = view.string(view.pointer_required(item + 24)?)?;
            let Some(expression) = view.pointer(item + 32)? else {
                continue;
            };
            let compound = view.uint(expression, 4)? == 0x290123;
            let mut operands = Vec::new();
            if compound {
                let Some(parts) = Self::modport_concat_parts(&view, item, expression)? else {
                    continue;
                };
                operands.reserve(parts.len());
                for (owner, part) in parts {
                    let Some(member) =
                        self.modport_operand(&view, unit, instance, owner, part, true)?
                    else {
                        operands.clear();
                        break;
                    };
                    operands.push(member);
                }
            } else if let Some(member) =
                self.modport_operand(&view, unit, instance, item, expression, false)?
            {
                operands.push(member);
            }
            if !operands.is_empty() {
                let declaration = if compound {
                    let header = view.uint(item, 8)?;
                    self.objects
                        .known_position(unit, item, header, (header >> 32) as u32, &self.sources)
                        .ok()
                        .flatten()
                } else {
                    None
                };
                members.push((
                    alias.to_owned(),
                    ModportAlias {
                        parts: operands,
                        declaration,
                    },
                ));
            }
        }
        Ok(members)
    }

    fn modport_concat_parts(
        view: &super::archive::View,
        item: u64,
        expression: u64,
    ) -> io::Result<Option<Vec<(u64, u64)>>> {
        let mut pending = vec![(item, expression, 0)];
        let mut parts = Vec::new();
        while let Some((owner, expression, depth)) = pending.pop() {
            if depth >= 32 || parts.len() >= 64 {
                return Ok(None);
            }
            if view.uint(expression, 4)? != 0x290123 {
                parts.push((owner, expression));
                continue;
            }
            if view.pointer(expression + 16)? != Some(owner) {
                return Ok(None);
            }
            let mut children = super::values::operand_list(view, expression + 24, None)?;
            if children.is_empty() || children.len() + pending.len() + parts.len() > 64 {
                return Ok(None);
            }
            // A KDB concatenation lists the last child first, then the others in source order.
            children.rotate_left(1);
            pending.extend(
                children
                    .into_iter()
                    .rev()
                    .map(|child| (expression, child, depth + 1)),
            );
        }
        Ok((parts.len() >= 2).then_some(parts))
    }

    fn modport_operand(
        &mut self,
        view: &super::archive::View,
        unit: u32,
        instance: usize,
        owner: u64,
        expression: u64,
        compound: bool,
    ) -> io::Result<Option<ModportMember>> {
        let selection = match view.uint(expression, 4)? {
            header if matches!(header & 0xffff, 0x124 | 0x125) => {
                if view.pointer(expression + 8)? != Some(owner) {
                    return Ok(None);
                }
                Selection::read(view, expression)?
            }
            0x240123 | 0x260123 => {
                if view.pointer(expression + 16)? != Some(owner) {
                    return Ok(None);
                }
                Selection::read(view, expression)?
            }
            _ => None,
        };
        let declaration = selection.map_or(expression, |(declaration, _)| declaration);
        if !matches!(view.uint(declaration, 1)?, 51..=56) {
            return Ok(None);
        }
        let backing = view.string(view.pointer_required(declaration + 32)?)?;
        let mut range = None;
        let mut width = None;
        let mut two_state = None;
        if selection.is_some() || compound {
            let Ok(actual) = self.resolve_value(instance, backing) else {
                return Ok(None);
            };
            let Some(bounds) = actual.packed else {
                return Ok(None);
            };
            let (msb, lsb) = bounds;
            let (left, right) = if let Some((_, selection)) = selection {
                let Some((left, right, _)) = selection.indices(bounds, |expression| {
                    self.port_index(instance, view, unit, expression)
                }) else {
                    return Ok(None);
                };
                let interval = msb.min(lsb)..=msb.max(lsb);
                if !interval.contains(&left)
                    || !interval.contains(&right)
                    || left != right && left.cmp(&right) != msb.cmp(&lsb)
                {
                    return Ok(None);
                }
                let (Ok(left_index), Ok(right_index)) = (i32::try_from(left), i32::try_from(right))
                else {
                    return Ok(None);
                };
                range = Some([left_index, right_index]);
                (left, right)
            } else {
                bounds
            };
            if compound {
                // Only one-dimensional packed vectors or scalar data have a reliable width.
                let bits = left.abs_diff(right) + 1;
                if bits > 4096 {
                    return Ok(None);
                }
                width = Some(bits as u32);
                two_state = Some(actual.two_state);
            }
        }
        Ok(Some(ModportMember {
            backing: backing.to_owned(),
            range,
            width,
            two_state,
        }))
    }

    pub(super) fn interface_member(&mut self, query: &str) -> io::Result<Vec<Location>> {
        if let Some((scope, member)) = query.rsplit_once('.') {
            if let Some((instance, name)) = scope.rsplit_once('.') {
                if let Some(&index) = self.names.get(instance) {
                    if self.nodes[index].kind == "npiInterface" {
                        let ports = self
                            .interface_bindings()?
                            .get(&index)
                            .into_iter()
                            .flatten()
                            .filter_map(|binding| binding.formal.modport)
                            .collect::<HashSet<_>>();
                        let mut backing = HashSet::new();
                        for (unit, key) in ports {
                            let view = self.objects.view(unit)?;
                            if view.string(view.pointer_required(key + 32)?)? == name {
                                for (alias, physical) in self.modport_members((unit, key), index)? {
                                    if alias == member {
                                        backing.insert(physical);
                                    }
                                }
                            }
                        }
                        if backing.len() > 1 {
                            return Err(invalid("Ambiguous KDB modport alias"));
                        }
                        return match backing.into_iter().next() {
                            Some(alias) => self.modport_locations(index, &alias),
                            None => Ok(Vec::new()),
                        };
                    }
                }
            }
        }
        let (_, _, formal, target, suffix) = self.reference_binding(query)?;
        let Target::Scalar(index) = target else {
            return Ok(Vec::new());
        };
        let Some(member) = suffix
            .strip_prefix('.')
            .filter(|member| !member.contains('.'))
        else {
            return Ok(Vec::new());
        };
        if let Some(modport) = formal.modport {
            let members = self.modport_members(modport, index)?;
            let mut candidates = members.iter().filter(|(alias, _)| alias == member);
            let Some((_, target)) = candidates.next() else {
                return Ok(Vec::new());
            };
            if candidates.next().is_some() {
                return Err(invalid("Ambiguous KDB modport alias"));
            }
            self.modport_locations(index, target)
        } else {
            Ok(vec![self.modport_location(index, member, None)?])
        }
    }

    fn modport_locations(
        &mut self,
        index: usize,
        alias: &ModportAlias,
    ) -> io::Result<Vec<Location>> {
        alias
            .parts
            .iter()
            .map(|member| {
                let mut location = self.modport_location(index, &member.backing, member.range)?;
                location.interface_width = member.width;
                location.interface_two_state = member.two_state;
                location.interface_declaration = alias.declaration.clone();
                Ok(location)
            })
            .collect()
    }

    fn modport_location(
        &mut self,
        index: usize,
        member: &str,
        range: Option<[i32; 2]>,
    ) -> io::Result<Location> {
        let name = format!("{}.{member}", self.nodes[index].fullname);
        let mut location = self.value(&name)?.0;
        location.interface_range = range;
        Ok(location)
    }

    pub(super) fn interface_users(&mut self, query: &str) -> io::Result<Vec<Location>> {
        let (instance, member) = query
            .rsplit_once('.')
            .ok_or_else(|| invalid("KDB interface member requires an instance"))?;
        let index = self.node(instance)?;
        if self.nodes[index].kind != "npiInterface" {
            return Ok(Vec::new());
        }
        self.value(query)?;
        let bindings: Vec<_> = self
            .interface_bindings()?
            .get(&index)
            .into_iter()
            .flatten()
            .map(|binding| (binding.owner, binding.name.clone(), binding.formal.clone()))
            .collect();
        let mut users = Vec::new();
        for (owner, name, formal) in bindings {
            let aliases = if let Some(modport) = formal.modport {
                self.modport_members(modport, index)?
                    .into_iter()
                    .filter_map(|(alias, target)| {
                        let reads_member =
                            target.parts.iter().any(|operand| operand.backing == member);
                        reads_member.then(|| {
                            let range = (target.parts.len() == 1)
                                .then(|| target.parts[0].range)
                                .flatten();
                            (alias, range)
                        })
                    })
                    .collect()
            } else {
                vec![(member.to_owned(), None)]
            };
            for (alias, range) in aliases {
                let node = &self.nodes[owner];
                let fullname = format!("{}.{name}.{alias}", node.fullname);
                let mut location = self.location(
                    &fullname,
                    "npiRefObj",
                    formal.position.clone(),
                    self.context(owner),
                );
                location.interface_range = range;
                users.push(location);
            }
        }
        users.sort_unstable_by(|left, right| left.fullname.cmp(&right.fullname));
        users.dedup_by(|left, right| left.fullname == right.fullname);
        Ok(users)
    }

    fn interface_bindings(&mut self) -> io::Result<&HashMap<usize, Vec<BoundFormal>>> {
        if self.interfaces.bindings_by_instance.is_none() {
            let mut bindings: HashMap<usize, Vec<BoundFormal>> = HashMap::new();
            let mut remaining = 16384usize;
            let mut names_by_definition = HashMap::new();
            for owner in 0..self.nodes.len() {
                let node = &self.nodes[owner];
                if !matches!(node.kind, "npiModule" | "npiInterface" | "npiProgram")
                    || node.parent.is_none()
                {
                    continue;
                }
                let (unit, source) = (node.unit, node.source);
                let names = names_by_definition
                    .entry((unit, source))
                    .or_insert_with(|| {
                        self.interface_formal_names(unit, source)
                            .unwrap_or_default()
                    });
                for name in names.iter() {
                    remaining = remaining
                        .checked_sub(1)
                        .ok_or_else(|| invalid("KDB interface binding scan exceeded its budget"))?;
                    let Ok((formal, target)) = self.actual(owner, name, &mut HashSet::new()) else {
                        continue;
                    };
                    match target {
                        Target::Scalar(index) => {
                            bindings.entry(index).or_default().push(BoundFormal {
                                owner,
                                name: name.clone(),
                                formal,
                            });
                        }
                        Target::Array(array) => {
                            let key = (self.nodes[owner].fullname.clone(), name.clone());
                            let shape = &self.interfaces.formal_arrays[&key];
                            let actual = &self.interfaces.arrays[&array];
                            remaining =
                                remaining
                                    .checked_sub(actual.elements.len())
                                    .ok_or_else(|| {
                                        invalid("KDB interface binding scan exceeded its budget")
                                    })?;
                            for (&actual_index, &instance) in &actual.elements {
                                let index = actual
                                    .shape
                                    .ordinal(actual_index)
                                    .and_then(|ordinal| shape.index(ordinal))
                                    .ok_or_else(|| {
                                        invalid("KDB interface array index is out of bounds")
                                    })?;
                                bindings.entry(instance).or_default().push(BoundFormal {
                                    owner,
                                    name: format!("{name}[{index}]"),
                                    formal: formal.clone(),
                                });
                            }
                        }
                    }
                }
            }
            self.interfaces.bindings_by_instance = Some(bindings);
        }
        Ok(self.interfaces.bindings_by_instance.as_ref().unwrap())
    }

    fn interface_formal_names(&mut self, unit: u32, source: u64) -> io::Result<Vec<String>> {
        let view = self.objects.view(unit)?;
        let mut names = Vec::new();
        for port in lexical::chain(&view, view.pointer(source + 56)?)? {
            if view.uint(port, 1)? == 47 {
                let declaration = view.pointer_required(port + 24)?;
                if view.uint(declaration, 1)? == 77 {
                    names.push(
                        view.string(view.pointer_required(declaration + 24)?)?
                            .to_owned(),
                    );
                }
            }
        }
        Ok(names)
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
                generic: header & 0x80000000 != 0,
            });
        }
        Err(invalid("KDB interface formal not found"))
    }

    fn actual(
        &mut self,
        index: usize,
        name: &str,
        active: &mut HashSet<(usize, String)>,
    ) -> io::Result<(Formal, Target)> {
        if active.len() >= 128 || !active.insert((index, name.to_owned())) {
            return Err(invalid("Cyclic KDB interface binding"));
        }
        let mut formal = self.formal(index, name)?;
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
        let (target, actual_modport) = match view.uint(source, 1)? {
            77 => {
                let forwarded = view.string(view.pointer_required(source + 24)?)?;
                let (parent, target) = self.actual(caller, forwarded, active)?;
                (target, parent.modport)
            }
            44 | 45 | 46 => (self.nearest_actual(caller, (unit, source))?, None),
            60 => self.hierarchical_actual(caller, unit, source)?,
            _ => return Err(invalid("Unrecognized KDB interface actual expression")),
        };
        if let Some(modport) = actual_modport {
            if formal.modport.is_some_and(|declared| declared != modport) {
                return Err(invalid("Conflicting KDB modport views"));
            }
            formal.modport = Some(modport);
        }
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
        Ok((formal, target))
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

    fn hierarchical_actual(
        &mut self,
        caller: usize,
        unit: u32,
        source: u64,
    ) -> io::Result<(Target, Option<(u32, u64)>)> {
        let view = self.objects.view(unit)?;
        let mut next = Some(source);
        let mut segments = Vec::new();
        let mut seen = HashSet::new();
        let mut declarations = Vec::new();
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
            let identity = (
                declaration_unit,
                declaration.ok_or_else(|| invalid("Missing KDB hierarchical declaration"))?,
            );
            declarations.push(identity);
            next = view.pointer(key + 40)?;
        }
        let &(declaration_unit, declaration) = declarations
            .last()
            .ok_or_else(|| invalid("Empty KDB interface path"))?;
        let declaration_view = self.objects.view(declaration_unit)?;
        let modport = if declaration_view.uint(declaration, 1)? == 75 {
            let name =
                declaration_view.string(declaration_view.pointer_required(declaration + 32)?)?;
            if segments.pop() != Some(name) {
                return Err(invalid("KDB modport name differs from the actual path"));
            }
            declarations.pop();
            let interface = declaration_view.pointer_required(declaration + 48)?;
            Some(((declaration_unit, declaration), interface))
        } else {
            None
        };
        let &identity = declarations
            .last()
            .ok_or_else(|| invalid("KDB modport has no interface instance"))?;
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
                if let Some(((unit, _), interface)) = modport {
                    if node.unit != unit
                        || lexical::source_scope(&declaration_view, node.source)? != interface
                    {
                        return Err(invalid(
                            "KDB modport differs from the elaborated interface type",
                        ));
                    }
                }
                return Ok((Target::Scalar(index), modport.map(|(port, _)| port)));
            }
            if let Some(array) = self.interfaces.arrays.get(&query) {
                let shape = &array.shape;
                let source = self.objects.origin(&Instance {
                    name: shape.name.clone(),
                    unit: shape.unit,
                    source: shape.source,
                })?;
                if source != identity || modport.is_some() {
                    return Err(invalid("KDB hierarchical array disagrees with declaration"));
                }
                return Ok((Target::Array(query), None));
            }
            parent = match parent {
                Some(index) => self.nodes[index].parent,
                None => break,
            };
        }
        Err(invalid("KDB hierarchical actual has no runtime instance"))
    }
}
