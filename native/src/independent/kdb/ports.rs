// SPDX-License-Identifier: MPL-2.0

use super::{archive::View, lexical, values, ArrayElement, Session};
use crate::independent::bytes::invalid;
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, io};

const PORT_LIMIT: usize = 4096;
const MAX_PORT_WIDTH: u64 = 4096;
mod expressions;
mod literals;

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
struct Endpoint {
    instance: String,
    signal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<[i32; 2]>,
    #[serde(skip)]
    shape: Option<PortShape>,
    #[serde(skip)]
    select_index: Option<SelectIndex>,
}

impl Endpoint {
    fn new(instance: String, signal: String) -> Self {
        Self {
            instance,
            signal,
            field: None,
            bit: None,
            range: None,
            shape: None,
            select_index: None,
        }
    }

    fn subrange(&self, offset: u64, width: u64) -> Option<Self> {
        let shape = self.shape?;
        if width == 0 || offset.checked_add(width)? > shape.width() {
            return None;
        }
        if offset == 0 && width == shape.width() {
            return Some(self.clone());
        }
        let (left, right) = shape.bounds;
        // A packed range is ordered from the most significant bit.
        let direction = if left <= right { 1 } else { -1 };
        let first = i32::try_from(left.checked_add(direction * offset as i64)?).ok()?;
        let last = i32::try_from(left.checked_add(direction * (offset + width - 1) as i64)?).ok()?;
        let mut endpoint = self.clone();
        endpoint.bit = None;
        endpoint.range = Some([first, last]);
        endpoint.shape = Some(PortShape {
            bounds: (i64::from(first), i64::from(last)),
            two_state: shape.two_state,
        });
        Some(endpoint)
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
struct Link {
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<Endpoint>,
    to: Endpoint,
    file: String,
    line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversion: Option<Conversion>,
    #[serde(rename = "selectIndex", skip_serializing_if = "Option::is_none")]
    select_index: Option<SelectIndex>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expression: Option<expressions::PortExpression>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
struct SelectIndex {
    instance: String,
    signal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    part: Option<IndexedPart>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedPart {
    width: i64,
    ascending_indices: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct PortShape {
    bounds: (i64, i64),
    two_state: bool,
}

impl PortShape {
    fn whole(value: &values::ResolvedValue) -> Option<Self> {
        let shape = Self {
            bounds: value.packed?,
            two_state: value.two_state,
        };
        (shape.width() <= MAX_PORT_WIDTH).then_some(shape)
    }

    fn width(self) -> u64 {
        self.bounds.0.abs_diff(self.bounds.1).saturating_add(1)
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
struct Conversion {
    from_width: u64,
    to_width: u64,
    two_state: bool,
}

impl Conversion {
    fn between(from_width: u64, target: PortShape) -> Option<Self> {
        (from_width != target.width() || target.two_state).then_some(Self {
            from_width,
            to_width: target.width(),
            two_state: target.two_state,
        })
    }
}

impl Link {
    fn new(mut from: Endpoint, to: Endpoint, file: String, line: u32) -> Self {
        let conversion = from
            .shape
            .zip(to.shape)
            .and_then(|(from, to)| Conversion::between(from.width(), to));
        let select_index = from.select_index.take();
        Self {
            from: Some(from),
            to,
            file,
            line,
            conversion,
            select_index,
            expression: None,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
struct Gap {
    instance: String,
    signal: Option<String>,
    direction: &'static str,
}

#[derive(Serialize)]
struct Constant {
    instance: String,
    signal: String,
    bits: String,
    signed: bool,
    file: String,
    line: u32,
    #[serde(skip)]
    literal: literals::Literal,
}

#[derive(Serialize)]
struct PortDeclaration {
    instance: String,
    signal: String,
    direction: &'static str,
}

#[derive(Default, Serialize)]
pub(super) struct PortLinks {
    ports: Vec<PortDeclaration>,
    #[serde(rename = "portsIncomplete")]
    ports_incomplete: bool,
    links: Vec<Link>,
    gaps: Vec<Gap>,
    constants: Vec<Constant>,
    truncated: bool,
}

pub enum InputPortSource<'a> {
    IndexedBase((&'a str, &'a str)),
    Literal { bits: &'a str, signed: bool },
    Expression {
        operands: &'a [(String, String)],
        complete: bool,
        width: u64,
    },
}

pub struct InputPortSite<'a> {
    pub source: InputPortSource<'a>,
    pub target: (&'a str, &'a str),
    pub file: &'a str,
    pub line: u32,
    pub width: u64,
}

struct Formal {
    name: String,
    ordinal: u64,
    input: bool,
    output: bool,
}

enum PortKey<'a> {
    Name(&'a str),
    Ordinal(u64),
}

impl Session {
    pub fn resolve_input_ports(
        &mut self,
        query: &str,
        sites: &[InputPortSite<'_>],
    ) -> io::Result<Vec<Option<serde_json::Value>>> {
        let scan = self.port_links(query)?;
        if scan.truncated {
            return Ok(vec![None; sites.len()]);
        }
        let mut constants = HashMap::new();
        for constant in &scan.constants {
            let key = (
                (constant.instance.as_str(), constant.signal.as_str()),
                constant.file.as_str(),
                constant.line,
                constant.bits.len() as u64,
            );
            constants.entry(key).or_insert_with(Vec::new).push(constant);
        }
        let mut matches = HashMap::new();
        for link in &scan.links {
            let Some(shape) = link.to.shape else {
                continue;
            };
            if link.to.field.is_some()
                || link.to.bit.is_some()
                || link.to.range.is_some()
                || (link.expression.is_none() && link.select_index.is_none())
            {
                continue;
            }
            let key = (
                (link.to.instance.as_str(), link.to.signal.as_str()),
                link.file.as_str(),
                link.line,
                shape.width(),
            );
            matches.entry(key).or_insert_with(Vec::new).push(link);
        }
        Ok(sites
            .iter()
            .map(|site| {
                let key = (site.target, site.file, site.line, site.width);
                if let InputPortSource::Literal { bits, signed } = site.source {
                    let mut compatible = constants.get(&key)?.iter().filter(|constant| {
                        constant.literal.bits.eq_ignore_ascii_case(bits)
                            && constant.literal.signed == signed
                    });
                    let constant = compatible.next()?;
                    return compatible.next().is_none().then(|| serde_json::json!(constant));
                }
                let candidates = matches.get(&key)?;
                let mut compatible = candidates.iter().filter(|link| {
                    let from_width = link
                        .conversion
                        .as_ref()
                        .map_or(site.width, |conversion| conversion.from_width);
                    match site.source {
                        InputPortSource::Literal { .. } => false,
                        InputPortSource::IndexedBase(base) => {
                            let source = link
                                .expression
                                .as_ref()
                                .and_then(expressions::PortExpression::indexed_base)
                                .or_else(|| {
                                    link.from.as_ref().map(|from| {
                                        (from.instance.as_str(), from.signal.as_str())
                                    })
                                });
                            from_width == site.width && source == Some(base)
                        }
                        InputPortSource::Expression { operands, complete, width } => {
                            from_width == width
                                && link.expression.as_ref().is_some_and(|expression| {
                                    expression.matches_operands(operands, complete)
                                })
                        }
                    }
                });
                let link = compatible.next()?;
                compatible.next().is_none().then(|| serde_json::json!(link))
            })
            .collect())
    }

    pub(super) fn port_links(&mut self, query: &str) -> io::Result<PortLinks> {
        let owner = self.node(query)?;
        let mut result = PortLinks::default();
        let mut scopes = vec![owner];
        let mut remaining = PORT_LIMIT;
        if self.nodes[owner].kind == "npiModule" {
            self.scan_instance_ports(owner, &mut remaining, &mut result)?;
        }
        while let Some(index) = scopes.pop() {
            if remaining == 0 {
                result.truncated = true;
                break;
            }
            for child in self.nodes[index].children.clone() {
                remaining = remaining.saturating_sub(1);
                if remaining == 0 {
                    result.truncated = true;
                    break;
                }
                match self.nodes[child].kind {
                    "npiGenScope" => scopes.push(child),
                    "npiModule" => self.scan_instance_ports(child, &mut remaining, &mut result)?,
                    _ => {}
                }
            }
        }
        let mut seen = HashSet::new();
        result.links.retain(|link| seen.insert(link.clone()));
        let mut seen = HashSet::new();
        result.gaps.retain(|gap| seen.insert(gap.clone()));
        Ok(result)
    }

    fn scan_instance_ports(
        &mut self,
        index: usize,
        remaining: &mut usize,
        result: &mut PortLinks,
    ) -> io::Result<()> {
        if self.port_declarations(index, result).is_err() {
            result.ports_incomplete = true;
        }
        match self.instance_ports(index, remaining, result) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                self.note_incomplete_ports(index, None, result);
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn port_declarations(&mut self, index: usize, result: &mut PortLinks) -> io::Result<()> {
        let owner = &self.nodes[index];
        let view = self.objects.view(owner.unit)?;
        let module = lexical::source_scope(&view, owner.source)?;
        if view.uint(module, 1)? != 31 {
            return Ok(());
        }
        for port in lexical::chain(&view, view.pointer(module + 56)?)? {
            if result.ports.len() == PORT_LIMIT {
                result.truncated = true;
                break;
            }
            if let Some(formal) = read_formal_port(&view, port, None)? {
                result.ports.push(PortDeclaration {
                    instance: owner.fullname.clone(),
                    signal: formal.name,
                    direction: if formal.input && formal.output {
                        "inout"
                    } else if formal.input {
                        "input"
                    } else {
                        "output"
                    },
                });
            }
        }
        Ok(())
    }

    fn note_incomplete_ports(&self, index: usize, formal: Option<&Formal>, result: &mut PortLinks) {
        let mut scope = index;
        loop {
            let node = &self.nodes[scope];
            let (input, output) = formal.map_or((true, true), |port| (port.input, port.output));
            let directions = if scope == index {
                [("drivers", input), ("loads", output)]
            } else {
                [("drivers", output), ("loads", input)]
            };
            for (direction, applies) in directions {
                if applies {
                    result.gaps.push(Gap {
                        instance: node.fullname.clone(),
                        signal: formal
                            .filter(|_| scope == index)
                            .map(|port| port.name.clone()),
                        direction,
                    });
                }
            }
            let Some(parent) = node.parent else {
                break;
            };
            if scope != index && node.kind != "npiGenScope" {
                break;
            }
            scope = parent;
        }
    }

    fn instance_ports(
        &mut self,
        index: usize,
        remaining: &mut usize,
        result: &mut PortLinks,
    ) -> io::Result<()> {
        let owner = &self.nodes[index];
        let (Some(caller), Some(instance)) = (owner.parent, owner.instance) else {
            return Ok(());
        };
        let instance_name = owner.fullname.clone();
        let array_element = owner.array_element;
        let definition = self.objects.view(owner.unit)?;
        let module = lexical::source_scope(&definition, owner.source)?;
        if definition.uint(module, 1)? != 31 {
            return Ok(());
        }
        let formals = lexical::chain(&definition, definition.pointer(module + 56)?)?;
        let (unit, origin) = self
            .objects
            .origin(&self.instances[instance as usize - 1])?;
        let view = self.objects.view(unit)?;
        let array_source = view.uint(origin, 1)? == 46;
        let array = array_source || array_element.is_some();
        let array_element = if array_source {
            array_element.filter(|element| {
                view.uint(origin + 4, 4).ok().map(|index| index as i32) == Some(element.index)
            })
        } else {
            None
        };
        let call = lexical::source_scope(&view, origin)?;
        if !matches!(view.uint(call, 1)?, 44 | 45) {
            return Ok(());
        }
        let mut matched = HashSet::new();
        for connection in lexical::chain(&view, view.pointer(call + 48)?)? {
            *remaining = remaining.saturating_sub(1);
            if *remaining == 0 {
                result.truncated = true;
                break;
            }
            let mut known_formal = None;
            let decoded = (|| -> io::Result<()> {
                let header = view.uint(connection, 4)?;
                if !matches!(header & 255, 49 | 50) {
                    return Err(invalid("Unrecognized KDB port connection"));
                }
                let Some(expression) = view.pointer(connection + 48)? else {
                    return Ok(());
                };
                let selector = if header & 0x8000_0000 != 0 {
                    PortKey::Name(view.string(view.pointer_required(connection + 32)?)?)
                } else {
                    PortKey::Ordinal(view.uint(connection + 32, 4)?)
                };
                let Some(formal) = formal_port(&definition, &formals, selector)? else {
                    return Ok(());
                };
                if !matched.insert(formal.ordinal) {
                    return Err(invalid("Duplicate KDB port connection"));
                }
                let formal = known_formal.insert(formal);
                let mut internal = Endpoint::new(instance_name.clone(), formal.name.clone());
                let line = view.uint(connection + 4, 4)? as u32;
                let position =
                    self.objects
                        .known_position(unit, connection, header, line, &self.sources)?;
                if (!array || array_element.is_some()) && formal.input && !formal.output {
                    if let (Some(position), Some(literal)) =
                        (position.as_ref(), literals::read(&view, expression)?)
                    {
                        if let Some((bits, signed)) = self
                            .resolve_value(index, &internal.signal)
                            .ok()
                            .as_ref()
                            .and_then(PortShape::whole)
                            .and_then(|target| literal.to_port(target, array_element))
                        {
                            result.constants.push(Constant {
                                instance: internal.instance,
                                signal: internal.signal,
                                bits,
                                signed,
                                file: position.file.clone(),
                                line: position.line,
                                literal,
                            });
                            return Ok(());
                        }
                    }
                }
                let mut actual =
                    self.port_actual(&view, unit, caller, expression, index, &mut internal)?;
                if (array || !formal.input || formal.output)
                    && actual
                        .as_ref()
                        .is_some_and(|actual| actual.select_index.is_some())
                {
                    actual = None;
                }
                if array {
                    actual = actual.and_then(|endpoint| {
                        array_endpoint(endpoint, internal.shape?, array_element?)
                    });
                }
                if actual.is_none() && !array && formal.input != formal.output {
                    if let (Some(position), Ok(formal_value)) = (
                        position.as_ref(),
                        self.resolve_value(index, &internal.signal),
                    ) {
                        if let Some(shape) = PortShape::whole(&formal_value) {
                            if let Some(parts) = self.struct_port_concat(
                                &view, unit, caller, expression, internal.clone(), shape,
                            )? {
                                for (member, slice) in parts {
                                    let (from, to) = if formal.input { (member, slice) } else { (slice, member) };
                                    result.links.push(Link::new(from, to, position.file.clone(), position.line));
                                }
                                return Ok(());
                            }
                            if formal.output {
                                if let Some(links) = self.output_port_concat(
                                    &view, unit, caller, expression, internal.clone(), shape,
                                    formal_value.packed_signed, position,
                                )? {
                                    result.links.extend(links);
                                    return Ok(());
                                }
                            }
                        }
                    }
                }
                if actual.is_none() && !array && formal.input && !formal.output {
                    if let (Some(position), Some(target_shape)) = (
                        position.as_ref(),
                        self.resolve_value(index, &internal.signal)
                            .ok()
                            .as_ref()
                            .and_then(PortShape::whole),
                    ) {
                        if let Some((expression, width)) =
                            expressions::read(self, &view, unit, caller, expression)?
                        {
                            internal.shape = Some(target_shape);
                            result.links.push(Link {
                                from: None,
                                to: internal,
                                file: position.file.clone(),
                                line: position.line,
                                conversion: Conversion::between(width, target_shape),
                                select_index: None,
                                expression: Some(expression),
                            });
                            return Ok(());
                        }
                    }
                }
                match (actual, position) {
                    (Some(external), Some(position)) => {
                        if formal.input {
                            result.links.push(Link::new(
                                external.clone(),
                                internal.clone(),
                                position.file.clone(),
                                position.line,
                            ));
                        }
                        if formal.output {
                            result.links.push(Link::new(
                                internal,
                                external,
                                position.file,
                                position.line,
                            ));
                        }
                    }
                    _ => {
                        if formal.input {
                            result.gaps.push(Gap {
                                instance: internal.instance.clone(),
                                signal: Some(internal.signal.clone()),
                                direction: "drivers",
                            });
                        }
                        if formal.output {
                            result.gaps.push(Gap {
                                instance: internal.instance,
                                signal: Some(internal.signal),
                                direction: "loads",
                            });
                        }
                        let mut dependencies = Vec::new();
                        let complete = self.actual_dependencies(
                            &view,
                            unit,
                            caller,
                            expression,
                            0,
                            &mut dependencies,
                        )?;
                        let mut actuals: Vec<_> = dependencies
                            .into_iter()
                            .map(|endpoint| (endpoint.instance, Some(endpoint.signal)))
                            .collect();
                        if !complete {
                            let mut scope = caller;
                            loop {
                                let node = &self.nodes[scope];
                                actuals.push((node.fullname.clone(), None));
                                if node.kind != "npiGenScope" {
                                    break;
                                }
                                let Some(parent) = node.parent else {
                                    break;
                                };
                                scope = parent;
                            }
                        }
                        for (instance, signal) in actuals {
                            if formal.input {
                                result.gaps.push(Gap {
                                    instance: instance.clone(),
                                    signal: signal.clone(),
                                    direction: "loads",
                                });
                            }
                            if formal.output {
                                result.gaps.push(Gap {
                                    instance,
                                    signal,
                                    direction: "drivers",
                                });
                            }
                        }
                    }
                }
                Ok(())
            })();
            match decoded {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                    self.note_incomplete_ports(index, known_formal.as_ref(), result);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn direct_actual(
        &mut self,
        view: &View,
        unit: u32,
        mut caller: usize,
        expression: u64,
    ) -> io::Result<Option<(Endpoint, usize)>> {
        if !matches!(view.uint(expression, 1)?, 51..=56) {
            return Ok(None);
        }
        let name = view.string(view.pointer_required(expression + 32)?)?;
        loop {
            let node = &self.nodes[caller];
            if node.unit == unit
                && self
                    .declarations
                    .scope(view, node)?
                    .get(name)
                    .is_some_and(|&(key, _)| key == expression)
            {
                return Ok(Some((
                    Endpoint::new(node.fullname.clone(), name.to_owned()),
                    caller,
                )));
            }
            if node.kind != "npiGenScope" {
                return Ok(None);
            }
            let Some(parent) = node.parent else {
                return Ok(None);
            };
            caller = parent;
        }
    }

    fn port_actual(
        &mut self,
        view: &View,
        unit: u32,
        caller: usize,
        expression: u64,
        formal: usize,
        internal: &mut Endpoint,
    ) -> io::Result<Option<Endpoint>> {
        let Some(endpoint) = self.port_operand(view, unit, caller, expression)? else {
            return Ok(None);
        };
        if endpoint.shape.is_some() {
            internal.shape = self
                .resolve_value(formal, &internal.signal)
                .ok()
                .as_ref()
                .and_then(PortShape::whole);
        }
        if internal.shape.is_none()
            && (endpoint.bit.is_some()
                || endpoint.range.is_some()
                || endpoint.select_index.is_some())
        {
            return Ok(None);
        }
        Ok(Some(endpoint))
    }

    fn struct_port_concat(
        &mut self, view: &View, unit: u32, caller: usize, expression: u64,
        internal: Endpoint, shape: PortShape,
    ) -> io::Result<Option<Vec<(Endpoint, Endpoint)>>> {
        if view.uint(expression, 4)? & 0xffff80ff != 0x290023 {
            return Ok(None);
        }
        let mut children = values::operand_list(view, expression + 24, None)?;
        if children.is_empty() || children.len() > 64 {
            return Ok(None);
        }
        children.rotate_left(1);
        let mut consumed = 0;
        let (left, right) = shape.bounds;
        let direction = if left >= right { 1 } else { -1 };
        let mut parts = Vec::new();
        let mut members = HashSet::new();
        for child in children.into_iter().rev() {
            if view.uint(child, 4)? != 0x31013e
                || view.pointer(child + 32)? != Some(expression)
            {
                return Ok(None);
            }
            let declaration = view.pointer_required(child + 48)?;
            let Some((mut endpoint, owner)) = self.direct_actual(view, unit, caller, declaration)? else {
                return Ok(None);
            };
            if view.string(view.pointer_required(child + 24)?)? != endpoint.signal {
                return Ok(None);
            }
            let reference = view.pointer_required(child + 40)?;
            if !matches!(view.uint(reference, 4)?, 0x2004013e | 0x2024013e)
                || view.pointer(reference + 32)? != Some(child)
            {
                return Ok(None);
            }
            let name = view.string(view.pointer_required(reference + 24)?)?;
            let Some((width, two_state)) = self.port_struct_member(owner, view, declaration, reference, name)? else {
                return Ok(None);
            };
            let first = consumed;
            consumed += width;
            if consumed > shape.width() || !members.insert((endpoint.instance.clone(), endpoint.signal.clone(), name.to_owned())) {
                return Ok(None);
            }
            let start = right + direction * (consumed as i64 - 1);
            let end = right + direction * first as i64;
            let (Ok(start), Ok(end)) = (i32::try_from(start), i32::try_from(end)) else {
                return Ok(None);
            };
            endpoint.field = Some(name.to_owned());
            endpoint.shape = Some(PortShape { bounds: (width as i64 - 1, 0), two_state });
            let mut slice = internal.clone();
            slice.range = Some([start, end]);
            slice.shape = Some(PortShape { bounds: (i64::from(start), i64::from(end)), two_state: shape.two_state });
            parts.push((endpoint, slice));
        }
        if consumed != shape.width() {
            return Ok(None);
        }
        Ok(Some(parts))
    }

    fn output_port_concat(
        &mut self,
        view: &View,
        unit: u32,
        caller: usize,
        expression: u64,
        internal: Endpoint,
        shape: PortShape,
        signed: Option<bool>,
        position: &super::Position,
    ) -> io::Result<Option<Vec<Link>>> {
        if view.uint(expression, 4)? & 0xffff80ff != 0x290023 {
            return Ok(None);
        }
        let mut members = Vec::new();
        let mut remaining = 64;
        if !self.collect_output_members(view, unit, caller, expression, 0, &mut remaining, &mut members)? {
            return Ok(None);
        }
        let target_width: u64 = members.iter().map(|(_, width)| width).sum();
        let source_width = shape.width();
        if target_width > MAX_PORT_WIDTH || (target_width > source_width && signed.is_none()) {
            return Ok(None);
        }
        let (left, right) = shape.bounds;
        if i32::try_from(left).is_err() || i32::try_from(right).is_err() {
            return Ok(None);
        }
        let direction = if left <= right { 1 } else { -1 };
        // Assignment sizing aligns the least significant ends of the formal and concatenation.
        let mut source_offset = source_width.saturating_sub(target_width);
        let mut extension = target_width.saturating_sub(source_width);
        let mut links = Vec::new();
        for (member, width) in members {
            let prefix = extension.min(width);
            extension -= prefix;
            if prefix > 0 {
                let Some(endpoint) = member.subrange(0, prefix) else {
                    return Ok(None);
                };
                let source = (signed == Some(true)).then(|| {
                    let bit = (source_width > 1).then_some(left as i32);
                    (internal.instance.clone(), internal.signal.clone(), bit)
                });
                links.push(Link {
                    from: None,
                    conversion: endpoint.shape.and_then(|target| Conversion::between(prefix, target)),
                    to: endpoint,
                    file: position.file.clone(),
                    line: position.line,
                    select_index: None,
                    expression: Some(expressions::PortExpression::extension(prefix, source)),
                });
            }
            if prefix < width {
                let Some(target) = member.subrange(prefix, width - prefix) else {
                    return Ok(None);
                };
                let start = left + direction * source_offset as i64;
                source_offset += width - prefix;
                let end = left + direction * (source_offset as i64 - 1);
                let mut slice = internal.clone();
                if source_width > 1 {
                    slice.range = Some([start as i32, end as i32]);
                }
                slice.shape = Some(PortShape { bounds: (start, end), two_state: shape.two_state });
                links.push(Link::new(
                    slice, target, position.file.clone(), position.line,
                ));
            }
        }
        Ok((!links.is_empty() && source_offset == source_width).then_some(links))
    }

    fn collect_output_members(
        &mut self,
        view: &View,
        unit: u32,
        caller: usize,
        expression: u64,
        depth: usize,
        remaining: &mut usize,
        members: &mut Vec<(Endpoint, u64)>,
    ) -> io::Result<bool> {
        if depth >= 16 || *remaining == 0 {
            return Ok(false);
        }
        *remaining -= 1;
        if view.uint(expression, 4)? & 0xffff80ff != 0x290023 {
            let Some(member) = self.port_operand(view, unit, caller, expression)? else {
                return Ok(false);
            };
            let Some(shape) = member.shape.filter(|_| member.select_index.is_none()) else {
                return Ok(false);
            };
            members.push((member, shape.width()));
            return Ok(true);
        }
        let mut children = values::operand_list(view, expression + 24, None)?;
        if children.is_empty() || children.len() > *remaining {
            return Ok(false);
        }
        // The archive stores the last concatenation operand first.
        children.rotate_left(1);
        for child in children {
            if !self.collect_output_members(view, unit, caller, child, depth + 1, remaining, members)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn port_operand(
        &mut self,
        view: &View,
        unit: u32,
        caller: usize,
        expression: u64,
    ) -> io::Result<Option<Endpoint>> {
        if let Some((mut endpoint, owner)) = self.direct_actual(view, unit, caller, expression)? {
            endpoint.shape = self
                .resolve_value(owner, &endpoint.signal)
                .ok()
                .as_ref()
                .and_then(PortShape::whole);
            return Ok(Some(endpoint));
        }
        let Some((base, selection)) = Selection::read(view, expression)? else {
            return Ok(None);
        };
        let Some((mut endpoint, owner)) = self.direct_actual(view, unit, caller, base)? else {
            return Ok(None);
        };
        let Ok(actual) = self.resolve_value(owner, &endpoint.signal) else {
            return Ok(None);
        };
        let Some(bounds) = actual.packed else {
            return Ok(None);
        };
        let mut eval = |key| self.port_index(caller, view, unit, key);
        let (left, right, bit) = match selection.indices(bounds, &mut eval) {
            Some(selection) => selection,
            None => {
                let (index, part) = match selection {
                    Selection::BitExpression(index) => (index, None),
                    Selection::Indexed(index, width, ascending_indices) => {
                        let Some(width) =
                            eval(width).filter(|width| (1..=MAX_PORT_WIDTH as i64).contains(width))
                        else {
                            return Ok(None);
                        };
                        (
                            index,
                            Some(IndexedPart {
                                width,
                                ascending_indices,
                            }),
                        )
                    }
                    _ => return Ok(None),
                };
                let Some((index, owner)) = self.direct_actual(view, unit, caller, index)? else {
                    return Ok(None);
                };
                if self
                    .resolve_value(owner, &index.signal)
                    .ok()
                    .as_ref()
                    .and_then(PortShape::whole)
                    .is_none()
                {
                    return Ok(None);
                }
                endpoint.select_index = Some(SelectIndex {
                    instance: index.instance,
                    signal: index.signal,
                    part,
                });
                endpoint.shape = Some(PortShape {
                    bounds: (part.map_or(0, |part| part.width - 1), 0),
                    two_state: false,
                });
                return Ok(Some(endpoint));
            }
        };
        let valid = bounds.0.min(bounds.1)..=bounds.0.max(bounds.1);
        let width = left.abs_diff(right).saturating_add(1);
        if !valid.contains(&left)
            || !valid.contains(&right)
            || left != right && (bounds.0 < bounds.1) != (left < right)
            || width > MAX_PORT_WIDTH
        {
            return Ok(None);
        }
        let (Ok(left), Ok(right)) = (i32::try_from(left), i32::try_from(right)) else {
            return Ok(None);
        };
        if bit {
            endpoint.bit = Some(left);
        } else {
            endpoint.range = Some([left, right]);
        }
        endpoint.shape = Some(PortShape {
            bounds: (i64::from(left), i64::from(right)),
            two_state: actual.two_state,
        });
        Ok(Some(endpoint))
    }

    fn actual_dependencies(
        &mut self,
        view: &View,
        unit: u32,
        caller: usize,
        expression: u64,
        depth: usize,
        dependencies: &mut Vec<Endpoint>,
    ) -> io::Result<bool> {
        if depth >= 16 || dependencies.len() >= 64 {
            return Ok(false);
        }
        if let Some((actual, _)) = self.direct_actual(view, unit, caller, expression)? {
            dependencies.push(actual);
            return Ok(true);
        }
        let header = view.uint(expression, 4)?;
        if header & 255 == 0x28 {
            return Ok(true);
        }
        let children = if let Some((base, selection)) = Selection::read(view, expression)? {
            let mut operands = vec![base];
            match selection {
                Selection::BitExpression(index) => operands.push(index),
                Selection::RangeExpression(left, right) | Selection::Indexed(left, right, _) => {
                    operands.extend([left, right]);
                }
                _ => {}
            }
            operands
        } else {
            match header & 0xffff80ff {
                0x290023 => values::operand_list(view, expression + 24, None)?,
                0x2a0023 => {
                    let mut children = values::operand_list(view, expression + 24, None)?;
                    if children.len() < 2 {
                        return Ok(false);
                    }
                    children.remove(1); // The multiplier is an elaboration-time constant.
                    children
                }
                0x0e0023..=0x220023 => values::operands(view, expression, 2)?,
                _ => return Ok(false),
            }
        };
        let mut complete = true;
        for child in children {
            complete &=
                self.actual_dependencies(view, unit, caller, child, depth + 1, dependencies)?;
        }
        Ok(complete)
    }
}

fn array_endpoint(
    mut endpoint: Endpoint,
    formal: PortShape,
    element: ArrayElement,
) -> Option<Endpoint> {
    let shape = endpoint.shape?;
    let width = formal.width();
    if shape.width() == width {
        return Some(endpoint);
    }
    if shape.width() != width.checked_mul(element.count)? {
        return None;
    }
    let (left, right) = shape.bounds;
    let step = if left <= right { 1 } else { -1 };
    let first = left.checked_add(step * i64::try_from(element.ordinal * width).ok()?)?;
    let last = first.checked_add(step * i64::try_from(width - 1).ok()?)?;
    if width == 1 {
        endpoint.bit = Some(i32::try_from(first).ok()?);
        endpoint.range = None;
    } else {
        endpoint.range = Some([i32::try_from(first).ok()?, i32::try_from(last).ok()?]);
    }
    endpoint.shape = Some(PortShape {
        bounds: (first, last),
        ..shape
    });
    Some(endpoint)
}

#[derive(Clone, Copy)]
pub(super) enum Selection {
    Bit(i64),
    Range(i64, i64),
    BitExpression(u64),
    RangeExpression(u64, u64),
    Indexed(u64, u64, bool),
}

impl Selection {
    pub(super) fn read(view: &View, key: u64) -> io::Result<Option<(u64, Self)>> {
        let header = view.uint(key, 4)?;
        let opcode = header & 0xffff80ff;
        let compact = header & 255;
        if matches!(compact, 0x24 | 0x25) {
            let range = view.uint(key + 4, 4)? & 0x8000_0000 != 0;
            let selection = match (compact, range) {
                (0x24, false) => Self::Bit((header >> 16) as i64),
                (0x24, true) => Self::Range((header >> 16 & 255) as i64, (header >> 24) as i64),
                (0x25, true) => Self::Range(
                    view.uint(key + 24, 2)? as i64,
                    view.uint(key + 26, 2)? as i64,
                ),
                _ => return Ok(None),
            };
            return Ok(view.pointer(key + 16)?.map(|base| (base, selection)));
        }
        let arity = match opcode {
            0x240023 => 2,
            0x260023 | 0x310023 | 0x320023 => 3,
            _ => return Ok(None),
        };
        // Selector operands are stored right-to-left, with the base repeated in
        // the operand chain and in a separate slot.
        let operands = values::operands(view, key, arity)?;
        let (base, selection) = match operands.as_slice() {
            [index, base] => (*base, Self::BitExpression(*index)),
            [right, base, left] if opcode == 0x260023 => {
                (*base, Self::RangeExpression(*left, *right))
            }
            [width, base, start] => (*base, Self::Indexed(*start, *width, opcode == 0x310023)),
            _ => return Ok(None),
        };
        Ok((view.pointer(key + 48)? == Some(base)).then_some((base, selection)))
    }

    pub(super) fn indices(
        self,
        (decl_left, decl_right): (i64, i64),
        mut eval: impl FnMut(u64) -> Option<i64>,
    ) -> Option<(i64, i64, bool)> {
        Some(match self {
            Self::Bit(index) => (index, index, true),
            Self::Range(left, right) => (left, right, false),
            Self::BitExpression(index) => {
                let index = eval(index)?;
                (index, index, true)
            }
            Self::RangeExpression(left, right) => (eval(left)?, eval(right)?, false),
            Self::Indexed(base, width, ascending_indices) => {
                let base = eval(base)?;
                let width = eval(width)?;
                if !(1..=MAX_PORT_WIDTH as i64).contains(&width) {
                    return None;
                }
                let (low, high) = if ascending_indices {
                    (base, base.checked_add(width - 1)?)
                } else {
                    (base.checked_sub(width - 1)?, base)
                };
                if decl_left <= decl_right {
                    (low, high, false)
                } else {
                    (high, low, false)
                }
            }
        })
    }
}

fn formal_port(view: &View, formals: &[u64], selector: PortKey<'_>) -> io::Result<Option<Formal>> {
    for &port in formals {
        if let Some(formal) = read_formal_port(view, port, Some(&selector))? {
            return Ok(Some(formal));
        }
    }
    Ok(None)
}

fn read_formal_port(
    view: &View,
    port: u64,
    selector: Option<&PortKey<'_>>,
) -> io::Result<Option<Formal>> {
    if view.uint(port, 1)? != 47 {
        return Err(invalid("Unrecognized KDB formal port"));
    }
    let ordinal = view.uint(port + 16, 4)?;
    if matches!(selector, Some(PortKey::Ordinal(wanted)) if *wanted != ordinal) {
        return Ok(None);
    }
    let declaration = view.pointer_required(port + 24)?;
    if !matches!(view.uint(declaration, 1)?, 51..=56) {
        return Ok(None);
    }
    let name = view.string(view.pointer_required(declaration + 32)?)?;
    if matches!(selector, Some(PortKey::Name(wanted)) if name != *wanted) {
        return Ok(None);
    }
    // ANSI and non-ANSI declarations share the direction field. ANSI sets bit 7.
    let direction = if view.pointer(declaration + 56)? == Some(port) {
        view.uint(declaration + 64, 4)? >> 16 & 127
    } else {
        0
    };
    if !matches!(direction, 2..=4) {
        return Ok(None);
    }
    Ok(Some(Formal {
        name: name.to_owned(),
        ordinal,
        input: direction != 3,
        output: direction != 2,
    }))
}
