// SPDX-License-Identifier: MPL-2.0

mod archive;
mod interfaces;
mod lexical;
mod objects;
mod parameters;
mod ports;
mod sdb;
mod sources;
mod values;

use crate::independent::bytes::invalid;
use objects::Objects;
use sdb::{Instance, Master, Sdb};
use serde::Serialize;
use serde_json::{json, Value};
use sources::{Position, Sources};
pub use ports::{InputPortSite, InputPortSource};
use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
};

const SCOPE_LIMIT: usize = 1500;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Location {
    fullname: String,
    kind: &'static str,
    file: String,
    line: u32,
    module: String,
    definition_file: String,
    definition_line: u32,
    instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameter_value: Option<IntegerParameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_range: Option<[i32; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_two_state: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_declaration: Option<Position>,
}

#[derive(Clone, Serialize)]
struct IntegerParameter {
    bits: String,
    signed: bool,
}

#[derive(Clone)]
struct Node {
    fullname: String,
    parent: Option<usize>,
    kind: &'static str,
    module: String,
    unit: u32,
    source: u64,
    variant: (u32, u64),
    instance: Option<u32>,
    array_element: Option<ArrayElement>,
    position: Option<Position>,
    children: Vec<usize>,
}

#[derive(Clone, Copy)]
struct ArrayElement {
    index: i32,
    ordinal: u64,
    count: u64,
}

impl Node {
    fn summary(&self) -> Location {
        Location {
            fullname: self.fullname.clone(),
            kind: self.kind,
            file: String::new(),
            line: 0,
            module: if matches!(self.kind, "npiModule" | "npiInterface" | "npiProgram") {
                self.module.clone()
            } else {
                String::new()
            },
            definition_file: String::new(),
            definition_line: 0,
            instance: self.fullname.clone(),
            parameter_value: None,
            interface_range: None,
            interface_width: None,
            interface_two_state: None,
            interface_declaration: None,
        }
    }
}

pub struct Session {
    objects: Objects,
    sources: Sources,
    nodes: Vec<Node>,
    names: HashMap<String, usize>,
    roots: Vec<usize>,
    definitions: HashMap<String, Vec<usize>>,
    packages: HashMap<u32, Node>,
    instances: Vec<Instance>,
    expanded: HashSet<usize>,
    declarations: values::Declarations,
    interfaces: interfaces::Interfaces,
}

impl Session {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        let nested = path.join("kdb.elab++");
        let directory = if nested.is_dir() {
            nested.as_path()
        } else {
            path
        };
        let sdb = Sdb::open(&directory.join("sdb"))?;
        let sources = Sources::open(directory)?;
        let objects = Objects::open(directory)?;
        let mut session = Self {
            objects,
            sources,
            nodes: Vec::new(),
            names: HashMap::new(),
            roots: Vec::new(),
            definitions: HashMap::new(),
            packages: HashMap::new(),
            instances: sdb.instances.clone(),
            expanded: HashSet::new(),
            declarations: values::Declarations::default(),
            interfaces: interfaces::Interfaces::default(),
        };
        let mut adjacency: HashMap<u32, Vec<usize>> = HashMap::new();
        for (row, link) in sdb.links.iter().enumerate() {
            adjacency.entry(link.parent).or_default().push(row);
        }
        let mut hierarchy = Hierarchy {
            sdb: &sdb,
            adjacency,
            aliases: HashMap::new(),
            active: HashSet::new(),
        };
        hierarchy.visit(&mut session, 0, None)?;
        Ok(session)
    }

    pub fn lookup(&mut self, method: &str, query: &str) -> io::Result<Value> {
        if query.contains('\0') {
            return Err(invalid("Invalid KDB hierarchy name"));
        }
        match method {
            "kdbChildren" => Ok(json!(self.children(query, false)?)),
            "kdbScopes" => Ok(json!(self.children(query, true)?)),
            "kdbResolve" => Ok(json!([self.resolve(query)?])),
            "kdbInterfaceMember" => Ok(json!(self.interface_member(query)?)),
            "kdbInterfaceUsers" => Ok(json!(self.interface_users(query)?)),
            "kdbGenericInterfaceTypes" => Ok(json!(self.generic_interface_types(query)?)),
            "kdbPortLinks" => Ok(json!(self.port_links(query)?)),
            "kdbModuleSources" => {
                let mut files: Vec<_> = self
                    .definitions
                    .keys()
                    .filter_map(|module| self.sources.lookup(module))
                    .map(|source| &source.file)
                    .collect();
                files.sort_unstable();
                files.dedup();
                Ok(json!(files))
            }
            "kdbParent" => {
                if let Ok(index) = self.node(query) {
                    return Ok(match self.nodes[index].parent {
                        Some(parent) => json!([self.resolve_node(parent)?]),
                        None => json!([]),
                    });
                }
                if let Ok((_, parent)) = self.resolve_reference(query) {
                    return Ok(json!([self.resolve(&parent)?]));
                }
                Ok(match self.value(query)?.1 {
                    Some(parent) => json!([self.resolve_node(parent)?]),
                    None => json!([]),
                })
            }
            "kdbInstances" => {
                let mut result = Vec::new();
                if let Some(indices) = self.definitions.get(query) {
                    let position = self
                        .sources
                        .lookup(query)
                        .ok_or_else(|| invalid("KDB definition source location is unavailable"))?;
                    for &index in indices {
                        let mut row = self.nodes[index].summary();
                        row.definition_file = position.file.clone();
                        row.definition_line = position.line;
                        result.push(row);
                    }
                }
                Ok(json!(result))
            }
            _ => Err(invalid("Unknown KDB method")),
        }
    }

    fn insert(&mut self, node: Node) -> io::Result<usize> {
        let index = self.nodes.len();
        if index >= 400_000 || self.names.insert(node.fullname.clone(), index).is_some() {
            return Err(invalid(format!(
                "Duplicate KDB scope or hierarchy exceeds budget: {}",
                node.fullname
            )));
        }
        if let Some(parent) = node.parent {
            self.nodes[parent].children.push(index);
        } else {
            self.roots.push(index);
        }
        if node.instance.is_some()
            && matches!(node.kind, "npiModule" | "npiInterface" | "npiProgram")
        {
            self.definitions
                .entry(node.module.clone())
                .or_default()
                .push(index);
        }
        if node.kind == "npiPackage" {
            self.packages.insert(node.unit, node.clone());
        }
        self.nodes.push(node);
        Ok(index)
    }

    fn expand(&mut self, index: usize) -> io::Result<()> {
        if self.expanded.contains(&index) {
            return Ok(());
        }
        let owner = &self.nodes[index];
        let children =
            lexical::children(&mut self.objects, &self.sources, owner.unit, owner.source)?;
        let unit = owner.unit;
        let fullname = owner.fullname.clone();
        for child in children {
            self.insert(Node {
                fullname: format!("{fullname}.{}", child.name),
                kind: child.kind,
                parent: Some(index),
                module: String::new(),
                unit,
                source: child.key,
                variant: (0, 0),
                instance: None,
                array_element: None,
                position: Some(child.position),
                children: Vec::new(),
            })?;
        }
        self.expanded.insert(index);
        Ok(())
    }

    fn node(&mut self, query: &str) -> io::Result<usize> {
        if let Some(&node) = self.names.get(query) {
            return Ok(node);
        }
        let mut prefix = query;
        while let Some((owner, _)) = prefix.rsplit_once('.') {
            if let Some(&index) = self.names.get(owner) {
                self.expand(index)?;
                if let Some(&node) = self.names.get(query) {
                    return Ok(node);
                }
                if let Some(child) = self.nodes[index]
                    .children
                    .iter()
                    .copied()
                    .filter(|&child| {
                        query
                            .strip_prefix(&self.nodes[child].fullname)
                            .is_some_and(|suffix| suffix.starts_with('.'))
                    })
                    .max_by_key(|&child| self.nodes[child].fullname.len())
                {
                    self.expand(child)?;
                    return self.node_after_expand(query, child);
                }
                break;
            }
            prefix = owner;
        }
        Err(invalid(format!("KDB scope not found: {query}")))
    }

    fn node_after_expand(&mut self, query: &str, mut index: usize) -> io::Result<usize> {
        for _ in 0..256 {
            if let Some(&node) = self.names.get(query) {
                return Ok(node);
            }
            let child = self.nodes[index]
                .children
                .iter()
                .copied()
                .filter(|&child| {
                    query
                        .strip_prefix(&self.nodes[child].fullname)
                        .is_some_and(|suffix| suffix.starts_with('.'))
                })
                .max_by_key(|&child| self.nodes[child].fullname.len());
            let Some(child) = child else {
                break;
            };
            self.expand(child)?;
            index = child;
        }
        Err(invalid(format!("KDB scope not found: {query}")))
    }

    fn children(&mut self, query: &str, include_other: bool) -> io::Result<Vec<Location>> {
        let children = if query.is_empty() {
            &self.roots
        } else {
            let index = match self.node(query) {
                Ok(index) => index,
                Err(_) => {
                    if self.resolve_reference(query).is_err() {
                        self.value(query)?;
                    }
                    return Ok(Vec::new());
                }
            };
            self.expand(index)?;
            &self.nodes[index].children
        };
        Ok(children
            .iter()
            .filter(|&&index| include_other || self.design_scope(index, 0))
            .take(SCOPE_LIMIT)
            .map(|&index| self.nodes[index].summary())
            .collect())
    }

    fn design_scope(&self, index: usize, depth: usize) -> bool {
        match self.nodes[index].kind {
            "npiModule" | "npiProgram" => true,
            "npiGenScope" if depth < 128 => self.nodes[index]
                .children
                .iter()
                .copied()
                .any(|child| self.design_scope(child, depth + 1)),
            _ => false,
        }
    }

    fn context(&self, mut index: usize) -> Option<&Node> {
        loop {
            let node = &self.nodes[index];
            if matches!(node.kind, "npiModule" | "npiInterface") {
                return Some(node);
            }
            index = node.parent?;
        }
    }

    fn location(
        &self,
        fullname: &str,
        kind: &'static str,
        position: Position,
        context: Option<&Node>,
    ) -> Location {
        let definition = context.and_then(|row| self.sources.lookup(&row.module));
        Location {
            fullname: fullname.to_owned(),
            kind,
            file: position.file,
            line: position.line,
            module: context.map_or(String::new(), |row| row.module.clone()),
            definition_file: definition.map_or(String::new(), |position| position.file.clone()),
            definition_line: definition.map_or(0, |position| position.line),
            instance: context.map_or(String::new(), |row| row.fullname.clone()),
            parameter_value: None,
            interface_range: None,
            interface_width: None,
            interface_two_state: None,
            interface_declaration: None,
        }
    }

    fn resolve(&mut self, query: &str) -> io::Result<Location> {
        match self.node(query) {
            Ok(index) => self.resolve_node(index),
            Err(_) => self
                .resolve_reference(query)
                .map(|(location, _)| location)
                .or_else(|_| self.value(query).map(|(location, _)| location)),
        }
    }

    fn resolve_node(&mut self, index: usize) -> io::Result<Location> {
        let node = &self.nodes[index];
        let position = if let Some(instance) = node.instance {
            self.objects
                .position(&self.instances[instance as usize - 1], &self.sources)?
        } else {
            node.position.clone()
        };
        let position = position.ok_or_else(|| {
            invalid(format!(
                "KDB scope source is unavailable: {}",
                node.fullname
            ))
        })?;
        let context = self.context(index);
        if context.is_some_and(|row| self.sources.lookup(&row.module).is_none()) {
            return Err(invalid("KDB source has no module definition"));
        }
        Ok(self.location(&node.fullname, node.kind, position, context))
    }

    fn value(&mut self, query: &str) -> io::Result<(Location, Option<usize>)> {
        let (owner, leaf) = query
            .rsplit_once('.')
            .ok_or_else(|| invalid("KDB value requires a scope"))?;
        let index = self.node(owner)?;
        let values::ResolvedValue {
            kind,
            position,
            scope,
            ..
        } = self.resolve_value(index, leaf)?;
        let mut location = self.location(
            query,
            kind,
            position,
            if scope { self.context(index) } else { None },
        );
        if scope && self.nodes[index].kind == "npiGenScope" {
            location.instance = self.nodes[index].fullname.clone();
        }
        if kind == "npiParameter" {
            location.parameter_value = self.integer_parameter(index, leaf);
        }
        Ok((location, scope.then_some(index)))
    }

    fn resolve_value(&mut self, index: usize, name: &str) -> io::Result<values::ResolvedValue> {
        self.declarations.resolve(
            &mut self.objects,
            &self.sources,
            &scope_contexts(&self.nodes, index),
            &self.packages,
            name,
        )
    }
}

fn scope_contexts(nodes: &[Node], index: usize) -> Vec<&Node> {
    let mut contexts = Vec::new();
    let mut current = Some(index);
    while let Some(index) = current {
        contexts.push(&nodes[index]);
        current = nodes[index].parent;
    }
    contexts
}

struct Hierarchy<'a> {
    sdb: &'a Sdb,
    adjacency: HashMap<u32, Vec<usize>>,
    aliases: HashMap<u32, Master>,
    active: HashSet<u32>,
}

impl Hierarchy<'_> {
    fn visit(
        &mut self,
        session: &mut Session,
        owner: u32,
        parent: Option<usize>,
    ) -> io::Result<()> {
        if self.active.len() > 256 || !self.active.insert(owner) {
            return Err(invalid("Recursive or excessive KDB instance hierarchy"));
        }
        for offset in self.adjacency.get(&owner).cloned().unwrap_or_default() {
            let link = &self.sdb.links[offset];
            let instance = &self.sdb.instances[link.instance as usize - 1];
            let fullname = parent.map_or_else(
                || instance.name.clone(),
                |index| format!("{}.{}", session.nodes[index].fullname, instance.name),
            );
            let target = self
                .sdb
                .array_targets
                .get(&link.target)
                .copied()
                .unwrap_or(link.target);
            let known = if target.0 == self.sdb.namespace {
                self.master(target.1)
            } else {
                None
            };
            let category = known.map(|master| master.category & 0xffff);
            if category == Some(6) {
                continue;
            }
            if let Some(master) = known
                .filter(|master| master.category & 0xffff == 3 && master.category & 0x20_0000 != 0)
            {
                let view = session.objects.view(master.unit as u32)?;
                let header = view.uint(master.source, 4)?;
                if header & 255 != 31 || header >> 8 & 127 != 0 {
                    return Err(invalid("Unrecognized built-in KDB package metadata"));
                }
                continue;
            }
            if (link.reuse || target.0 != self.sdb.namespace || category == Some(1))
                && session.objects.interface_port(instance)?
            {
                if let (Some(parent), Some(shape)) =
                    (parent, self.sdb.array_shapes.get(&link.target))
                {
                    session.interfaces.formal_arrays.insert(
                        (session.nodes[parent].fullname.clone(), shape.name.clone()),
                        shape.clone(),
                    );
                }
                continue;
            }
            if target.0 != self.sdb.namespace {
                return Err(invalid("Unrecognized KDB target namespace"));
            }
            let master = if let Some(master) = known {
                master.clone()
            } else {
                let master = session
                    .objects
                    .resolve_master(instance, &self.sdb.masters)?
                    .ok_or_else(|| {
                        invalid(format!("Unknown elaborated KDB master for {fullname}"))
                    })?;
                self.aliases.insert(target.1, master.clone());
                master
            };
            let kind = match master.category & 0xffff {
                0 => "npiModule",
                1 => "npiInterface",
                3 => "npiPackage",
                4 => "npiProgram",
                7..=9 => "npiGenScope",
                _ => {
                    return Err(invalid(format!(
                        "Unrecognized KDB master category for {fullname}"
                    )))
                }
            };
            let array_element = if kind == "npiModule" {
                self.sdb.array_shapes.get(&link.target).and_then(|shape| {
                    let suffix = instance.name.strip_prefix(&shape.name)?;
                    let element = suffix.strip_prefix('[')?.strip_suffix(']')?.parse().ok()?;
                    Some(ArrayElement {
                        index: element,
                        ordinal: u64::from(shape.ordinal(element)?),
                        count: u64::from(shape.left.abs_diff(shape.right)) + 1,
                    })
                })
            } else {
                None
            };
            let index = session.insert(Node {
                fullname,
                parent,
                kind,
                module: master.name,
                unit: master.unit as u32,
                source: master.source,
                variant: self
                    .sdb
                    .variant_sources
                    .get(target.1.saturating_sub(1) as usize)
                    .copied()
                    .unwrap_or_default(),
                instance: Some(link.instance),
                array_element,
                position: None,
                children: Vec::new(),
            })?;
            if kind == "npiInterface" {
                let origin = session.objects.origin(instance)?;
                session
                    .interfaces
                    .source_instances
                    .entry(origin)
                    .or_default()
                    .push(index);
                if let Some(shape) = self.sdb.array_shapes.get(&link.target) {
                    let (unit, source) = origin;
                    let view = session.objects.view(unit)?;
                    if view.uint(source, 1)? != 46 {
                        return Err(invalid(
                            "KDB interface array element is not a source element",
                        ));
                    }
                    let element = view.uint(source + 4, 4)? as i32;
                    if shape.ordinal(element).is_none()
                        || instance.name != format!("{}[{element}]", shape.name)
                    {
                        return Err(invalid(
                            "KDB interface array element differs from declaration",
                        ));
                    }
                    let fullname = parent.map_or_else(
                        || shape.name.clone(),
                        |parent| format!("{}.{}", session.nodes[parent].fullname, shape.name),
                    );
                    let array = session
                        .interfaces
                        .arrays
                        .entry(fullname.clone())
                        .or_insert_with(|| interfaces::Array {
                            shape: shape.clone(),
                            parent,
                            elements: HashMap::new(),
                        });
                    let first = array.elements.is_empty();
                    if array.elements.insert(element, index).is_some() {
                        return Err(invalid("Duplicate KDB interface array element"));
                    }
                    if first {
                        let origin = session.objects.origin(&Instance {
                            name: shape.name.clone(),
                            unit: shape.unit,
                            source: shape.source,
                        })?;
                        session
                            .interfaces
                            .source_arrays
                            .entry(origin)
                            .or_default()
                            .push(fullname);
                    }
                }
            }
            self.visit(session, target.1, Some(index))?;
        }
        self.active.remove(&owner);
        Ok(())
    }

    fn master(&self, id: u32) -> Option<&Master> {
        self.sdb
            .variants
            .get(id.checked_sub(1)? as usize)
            .map(|&index| &self.sdb.masters[index])
            .or_else(|| self.aliases.get(&id))
    }
}
