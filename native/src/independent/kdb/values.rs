// SPDX-License-Identifier: MPL-2.0

use super::{
    archive::View,
    lexical,
    objects::Objects,
    parameters::ParameterValue,
    sources::{Position, Sources},
    Node,
};
use crate::independent::bytes::invalid;
use std::{collections::HashMap, io};

mod aggregates;
mod functions;

const TYPE_HEADER_MASK: u64 = 0xffff80ff;
const TYPE_PARAMETER_MASK: u64 = 0x00ff00ff;
const TYPE_PARAMETER: u64 = 0x00400039;
type Dimensions = Vec<(i64, i64)>;

pub(super) struct ResolvedValue {
    pub kind: &'static str,
    pub position: Position,
    pub scope: bool,
    pub packed: Option<(i64, i64)>,
    pub two_state: bool,
    pub packed_signed: Option<bool>,
}

#[derive(Default)]
pub(super) struct Declarations {
    scopes: HashMap<(u32, u64), HashMap<String, (u64, u64)>>,
}

impl Declarations {
    pub(super) fn scope(
        &mut self,
        view: &View,
        owner: &Node,
    ) -> io::Result<&HashMap<String, (u64, u64)>> {
        let source = lexical::source_scope(view, owner.source)?;
        let slots: &[u64] = match view.uint(source, 1)? {
            31 | 32 => &[64, 128],
            66 if owner.kind == "npiGenScope" => &[104, 112],
            66 if owner.kind == "npiNamedBegin" => &[104],
            _ => return Err(invalid("Unrecognized KDB value scope kind")),
        };
        Ok(match self.scopes.entry((owner.unit, source)) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let mut declarations = HashMap::new();
                for slot in slots {
                    for key in lexical::chain(view, view.pointer(source + slot)?)? {
                        let header = view.uint(key, 4)?;
                        if !(51..=58).contains(&(header & 255)) {
                            return Err(invalid("Unrecognized KDB declaration kind"));
                        }
                        let name = view.string(view.pointer_required(key + 32)?)?;
                        if declarations
                            .insert(name.to_owned(), (key, header))
                            .is_some()
                        {
                            return Err(invalid("Ambiguous KDB value declaration"));
                        }
                    }
                }
                entry.insert(declarations)
            }
        })
    }

    pub(super) fn resolve(
        &mut self,
        objects: &mut Objects,
        sources: &Sources,
        contexts: &[&Node],
        packages: &HashMap<u32, Node>,
        name: &str,
    ) -> io::Result<ResolvedValue> {
        let owner = contexts[0];
        let view = objects.view(owner.unit)?;
        let declarations = self.scope(&view, owner)?;
        let (key, header, indices) = if let Some(&(key, header)) = declarations.get(name) {
            (key, header, Vec::new())
        } else {
            let (base, indices) = indices(name)?;
            let &(key, header) = declarations
                .get(base)
                .ok_or_else(|| invalid(format!("KDB declaration not found: {name}")))?;
            (key, header, indices)
        };
        let mut environment = Environment {
            objects,
            contexts,
            unit: owner.unit,
            packages,
            defaults: false,
            frames: Vec::new(),
        };
        let tag = header & 255;
        let dtype = header >> 16 & 255;
        let flags = view.uint(key + 28, 4)?;
        let lexical = flags & 0x8000 != 0 && matches!(owner.kind, "npiGenScope" | "npiNamedBegin");
        let mut type_dimensions = Vec::new();
        let mut type_parameter = false;
        let (mut kind, width) = if header & TYPE_PARAMETER_MASK == TYPE_PARAMETER {
            ("npiTypeParameter", 1)
        } else if matches!(tag, 57 | 58) {
            ("npiParameter", 1)
        } else if matches!(tag, 51..=53) && dtype == 2
            || tag == 53 && dtype == 1 && flags & 0x10 != 0
        {
            ("npiNet", 1)
        } else if tag == 56 && dtype == 7 && matches!(view.uint(key + 64, 4)?, 0x820000 | 0x830000)
        {
            (
                if view.uint(key + 64, 4)? == 0x820000 {
                    "npiNet"
                } else {
                    "npiReg"
                },
                1,
            )
        } else if tag == 56 && matches!(dtype, 2 | 7) && flags == 0x4210
            || tag == 56 && dtype == 2 && flags == 0x210 && view.uint(key + 64, 4)? >> 16 == 3
        {
            let direction = view.uint(key + 64, 4)? >> 16;
            let port = view.pointer_required(key + 56)?;
            if !matches!(direction, 2 | 3)
                || view.uint(port, 1)? != 47
                || view.pointer(port + 24)? != Some(key)
            {
                return Err(invalid("Invalid KDB port direction"));
            }
            (if direction == 2 { "npiNet" } else { "npiReg" }, 1)
        } else if matches!(tag, 55 | 56) && dtype == 15 && flags & 0x1000 != 0 {
            let mut slot = if tag == 56 {
                72
            } else if lexical {
                64
            } else {
                56
            };
            if flags & 0x2000 != 0 {
                slot += 8;
            }
            if flags & 0x4000 != 0 {
                slot += 8;
            }
            let ty = view.pointer_required(key + slot)?;
            type_parameter = view.uint(ty, 4)? & TYPE_PARAMETER_MASK == TYPE_PARAMETER;
            let (kind, width, shape) = packed_type(&view, ty, 0, &mut environment)?;
            type_dimensions = shape;
            let is_input = tag == 56 && view.uint(key + 64, 4)? == 0x820000;
            let kind = match (kind, is_input) {
                ("enum", false) => "npiEnumVar",
                ("enum", true) => "npiEnumNet",
                ("struct", false) => "npiStructVar",
                ("struct", true) => "npiStructNet",
                ("union", false) => "npiUnionVar",
                ("union", true) => "npiUnionNet",
                (_, false) => "npiReg",
                (_, true) => "npiNet",
            };
            (kind, width)
        } else if matches!(tag, 54 | 55) || tag == 56 && dtype == 8 {
            match dtype {
                2 | 7 => ("npiReg", 1),
                3 => ("npiIntegerVar", 32),
                5 => ("npiRealVar", 64),
                8 => ("npiBitVar", 1),
                12 => ("npiIntVar", 32),
                13 => ("npiLongIntVar", 64),
                32 => ("npiStringVar", 1),
                _ => {
                    return Err(invalid(format!(
                        "Unrecognized KDB variable data type {dtype} for {name} (declaration tag {tag})"
                    )))
                }
            }
        } else {
            return Err(invalid(format!(
                "Unrecognized KDB declaration storage for {name}"
            )));
        };
        let mut packed_slot = if lexical { 64 } else { 56 };
        if matches!(tag, 53 | 56) {
            if let Some(port) = view.pointer(key + 56)? {
                if view.uint(port, 1)? == 47 {
                    if view.pointer(port + 24)? != Some(key) {
                        return Err(invalid("KDB port dimension owner mismatch"));
                    }
                    packed_slot = 72;
                }
            }
        }
        let mut packed = Vec::new();
        let mut unpacked = Vec::new();
        if matches!(tag, 52 | 53 | 55 | 56) && flags & 0x4000 != 0 {
            packed = dimensions(
                &view,
                view.pointer_required(key + packed_slot)?,
                key,
                packed_slot,
                &mut environment,
            )?;
        }
        if matches!(tag, 51..=56) && flags & 0x2000 != 0 {
            let slot = packed_slot + if flags & 0x4000 != 0 { 8 } else { 0 };
            unpacked = dimensions(
                &view,
                view.pointer_required(key + slot)?,
                key,
                slot,
                &mut environment,
            )?;
        }
        let aggregate = matches!(kind, "npiEnumVar" | "npiStructVar" | "npiUnionVar");
        let boundary = unpacked.len() + packed.len() + type_dimensions.len();
        packed.extend(type_dimensions);
        let packed_shape = if indices.is_empty()
            && unpacked.is_empty()
            && !aggregate
            && matches!(
                kind,
                "npiNet" | "npiReg" | "npiBitVar" | "npiIntegerVar" | "npiIntVar"
            ) {
            match packed.as_slice() {
                [] => Some((width as i64 - 1, 0)),
                [range] => Some(*range),
                _ => None,
            }
        } else {
            None
        };
        if aggregate && indices.len() > boundary {
            packed.push((width as i64 - 1, 0));
        } else if aggregate && !packed.is_empty() && indices.is_empty() && unpacked.is_empty() {
            kind = "npiPackedArrayVar";
        }
        if indices.len() > unpacked.len() + packed.len()
            || indices
                .iter()
                .zip(unpacked.iter().chain(&packed))
                .any(|(index, (left, right))| index < left.min(right) || index > left.max(right))
        {
            return Err(invalid("KDB value index exceeds declaration range"));
        }
        let mut scope = true;
        if indices.len() < unpacked.len() {
            kind = if indices.is_empty() {
                "npiArrayVar"
            } else {
                "npiVarSelect"
            };
            scope = indices.is_empty();
        } else if aggregate && indices.len() > boundary {
            if kind == "npiEnumVar" && type_parameter {
                kind = "npiBitSelect";
                scope = false;
            } else {
                kind = "npiRegBit";
            }
        } else if width == 1 && !packed.is_empty() && indices.len() == packed.len() + unpacked.len()
        {
            kind = match kind {
                "npiNet" => "npiNetBit",
                "npiReg" => "npiRegBit",
                _ => return Err(invalid("Unrecognized KDB packed bit storage")),
            };
        }
        let position = objects
            .declaration_position(owner.unit, key, header, sources)?
            .ok_or_else(|| invalid("KDB declaration source is unavailable"))?;
        Ok(ResolvedValue {
            kind,
            position,
            scope,
            packed: packed_shape,
            two_state: kind == "npiBitVar",
            // Simple packed net and logic declarations carry signedness in the header.
            packed_signed: (packed_shape.is_some()
                && matches!(tag, 51..=53 | 55 | 56)
                && matches!(dtype, 2 | 7 | 8))
                .then_some(header & 0x1000_0000 != 0),
        })
    }
}

impl super::Session {
    pub(super) fn port_struct_member(
        &mut self, owner: usize, view: &View, declaration: u64, reference: u64, name: &str,
    ) -> io::Result<Option<(u64, bool)>> {
        let node = &self.nodes[owner];
        let tag = view.uint(declaration, 1)?;
        let dtype = view.uint(declaration + 2, 1)?;
        let flags = view.uint(declaration + 28, 4)?;
        if !matches!(tag, 55 | 56) || dtype != 15 || flags & 0x7000 != 0x1000 {
            return Ok(None);
        }
        let slot = if tag == 56 { 72 }
            else if flags & 0x8000 != 0 && matches!(node.kind, "npiGenScope" | "npiNamedBegin") { 64 }
            else { 56 };
        let mut contexts = Vec::new();
        let mut current = Some(owner);
        while let Some(index) = current {
            let node = &self.nodes[index];
            contexts.push(node);
            current = node.parent;
        }
        let mut env = Environment {
            objects: &mut self.objects,
            contexts: &contexts,
            unit: node.unit,
            packages: &self.packages,
            defaults: false,
            frames: Vec::new(),
        };
        let ty = view.pointer_required(declaration + slot)?;
        let (type_view, ty, unit) = definition(view, ty, node.unit, &mut env)?;
        env.unit = unit;
        let Some(field_key) = view.pointer_into(reference + 48, &type_view)? else {
            return Ok(None);
        };
        let fields = aggregates::layout(&type_view, ty, &mut env, false)?;
        let Some(field) = fields.iter().find(|field| field.key == field_key) else {
            return Ok(None);
        };
        if type_view.string(type_view.pointer_required(field.key + 32)?)? != name {
            return Ok(None);
        }
        Ok(Some((field.width as u64, false)))
    }
}

fn indices(name: &str) -> io::Result<(&str, Vec<i64>)> {
    let start = name
        .find('[')
        .ok_or_else(|| invalid(format!("KDB declaration not found: {name}")))?;
    let mut tail = &name[start..];
    let mut indexes = Vec::new();
    while let Some(start) = tail.strip_prefix('[') {
        let (index, remaining) = start
            .split_once(']')
            .ok_or_else(|| invalid("Malformed KDB declaration index"))?;
        indexes.push(
            index
                .parse()
                .map_err(|_| invalid("Malformed KDB declaration index"))?,
        );
        tail = remaining;
    }
    if !tail.is_empty() {
        return Err(invalid("Malformed KDB declaration index"));
    }
    Ok((&name[..start], indexes))
}

fn expression_tag(view: &View, key: u64) -> io::Result<u64> {
    let header = view.uint(key, 4)?;
    Ok(if header & 255 == 0x23 {
        (header & TYPE_HEADER_MASK) | 0x100
    } else {
        header
    })
}

pub(super) fn operands(view: &View, key: u64, count: usize) -> io::Result<Vec<u64>> {
    operand_list(view, key + 24, Some(count))
}

pub(super) fn operand_list(view: &View, slot: u64, count: Option<usize>) -> io::Result<Vec<u64>> {
    let wrappers = lexical::chain(view, view.pointer(slot)?)?;
    if wrappers.len() > 65 || count.is_some_and(|count| wrappers.len() != count) {
        return Err(invalid("KDB expression arity mismatch"));
    }
    wrappers
        .into_iter()
        .map(|wrapper| {
            if view.uint(wrapper, 4)? & 0xffffff != 26 {
                return Err(invalid("Invalid KDB expression wrapper"));
            }
            view.pointer_required(wrapper + 16)
        })
        .collect()
}

fn immediate(view: &View, key: u64) -> io::Result<(i64, i64)> {
    let header = view.uint(key, 4)?;
    if header & TYPE_HEADER_MASK == 0x27 {
        return Ok((view.uint(key + 4, 2)? as i64, view.uint(key + 6, 2)? as i64));
    }
    if header & 0x80ff == 0x26 {
        return Ok(((header >> 16 & 255) as i64, (header >> 24) as i64));
    }
    Err(invalid("Unrecognized KDB immediate range"))
}

fn bounds(view: &View, key: u64, env: &mut Environment) -> io::Result<(i64, i64)> {
    if expression_tag(view, key)? != 0x250123 {
        return immediate(view, key);
    }
    let pair = operands(view, key, 2)?;
    Ok((
        integer(view, pair[1], 0, env)?.0,
        integer(view, pair[0], 0, env)?.0,
    ))
}

fn dimensions(
    view: &View,
    key: u64,
    declaration: u64,
    slot: u64,
    env: &mut Environment,
) -> io::Result<Dimensions> {
    let header = expression_tag(view, key)?;
    if header & 0x80ff == 0x26 || header & TYPE_HEADER_MASK == 0x27 {
        return Ok(vec![immediate(view, key)?]);
    }
    if !matches!(header, 0x250123 | 0x360123) {
        return Err(invalid("Unrecognized KDB dimension record"));
    }
    if view.pointer(key + 16)? != Some(declaration) {
        let owner = view.pointer_required(key + 16)?;
        if !(51..=56).contains(&view.uint(owner, 1)?) || view.pointer(owner + slot)? != Some(key) {
            return Err(invalid("KDB shared dimension owner mismatch"));
        }
    }
    if header == 0x250123 {
        return Ok(vec![bounds(view, key, env)?]);
    }
    let chain = lexical::chain(view, view.pointer(key + 24)?)?;
    if !(2..=32).contains(&chain.len()) {
        return Err(invalid("Invalid KDB dimension group size"));
    }
    let mut ranges: Dimensions = chain
        .into_iter()
        .map(|wrapper| {
            if view.uint(wrapper, 4)? & 0xffffff != 26 {
                return Err(invalid("Invalid KDB dimension wrapper"));
            }
            bounds(view, view.pointer_required(wrapper + 16)?, env)
        })
        .collect::<io::Result<_>>()?;
    ranges.rotate_left(1);
    Ok(ranges)
}

fn width(ranges: &[(i64, i64)]) -> io::Result<usize> {
    ranges.iter().try_fold(1usize, |width, (left, right)| {
        width
            .checked_mul((left.abs_diff(*right) + 1) as usize)
            .filter(|&width| width <= 1 << 20)
            .ok_or_else(|| invalid("KDB dimension width exceeds bounds"))
    })
}

fn packed_type(
    view: &View,
    key: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<(&'static str, usize, Dimensions)> {
    if depth > 20 {
        return Err(invalid("KDB packed type nesting exceeds bounds"));
    }
    let raw = view.uint(key, 4)?;
    let header = raw & TYPE_HEADER_MASK;
    if matches!(header, 0x60000048 | 0x60200048) {
        let flags = view.uint(key + 4, 4)?;
        let unit = view.uint(key + 36, 4)? as u32;
        if unit == 0 && flags == 0 {
            let (kind, size, mut shape) =
                packed_type(view, view.pointer_required(key + 48)?, depth + 1, env)?;
            if let Some(dimension) = view.pointer(key + 72)? {
                let outer = dimensions(view, dimension, key, 72, env)?;
                shape.splice(0..0, outer);
            }
            return Ok((kind, size, shape));
        }
        if flags == 0x4000 && env.packages.contains_key(&unit) {
            let target = env.objects.view(unit)?;
            let key = view
                .pointer_into(key + 48, &target)?
                .ok_or_else(|| invalid("Missing KDB imported type"))?;
            let previous = std::mem::replace(&mut env.unit, unit);
            let result = packed_type(&target, key, depth + 1, env);
            env.unit = previous;
            return result;
        }
        return Err(invalid("Unrecognized KDB imported type source"));
    }
    if raw & TYPE_PARAMETER_MASK == TYPE_PARAMETER {
        let name = view.string(view.pointer_required(key + 32)?)?;
        if let Some(entry) = env.entry(view, key, name)? {
            if entry.flags != 1 || entry.kind != 11 || entry.aux != 0 || entry.trailer == 0 {
                return Err(invalid("Invalid KDB type parameter override"));
            }
            let ParameterValue::Integer(unit) = entry.value else {
                return Err(invalid("Invalid KDB type parameter source unit"));
            };
            let unit = u32::try_from(unit)
                .map_err(|_| invalid("Invalid KDB type parameter source unit"))?;
            if !env.contexts.iter().any(|context| context.unit == unit) {
                return Err(invalid(
                    "KDB type parameter source is outside instance ancestry",
                ));
            }
            let target_view = env.objects.view(unit)?;
            let previous = std::mem::replace(&mut env.unit, unit);
            let result = type_expression(&target_view, entry.trailer, depth + 1, env);
            env.unit = previous;
            return result;
        }
        return type_expression(view, view.pointer_required(key + 48)?, depth + 1, env);
    }
    match header {
        0x40000048 => {
            let dtype = view.uint(key + 28, 4)? >> 16 & 255;
            let width = if let Some(range) = view.pointer(key + 72)? {
                width(&[bounds(view, range, env)?])?
            } else if matches!(dtype, 7 | 8) {
                1
            } else {
                32
            };
            Ok(("enum", width, Vec::new()))
        }
        0x50000048 => {
            let shape = if let Some(range) = view.pointer(key + 72)? {
                dimensions(view, range, key, 72, env)?
            } else {
                Vec::new()
            };
            Ok(("", 1, shape))
        }
        0x20000048 | 0x30000048 => {
            let mut widths = Vec::new();
            for field in lexical::chain(view, view.pointer(key + 48)?)? {
                let field_header = view.uint(field, 4)?;
                if field_header & 255 != 73 || view.pointer(field + 40)? != Some(key) {
                    return Err(invalid("Invalid KDB packed type field"));
                }
                let size = match field_header >> 16 & 255 {
                    15 => {
                        let (_, width, shape) =
                            packed_type(view, view.pointer_required(field + 48)?, depth + 1, env)?;
                        width * self::width(&shape)?
                    }
                    3 | 12 => 32,
                    7 | 8 if field_header & 0x0200_0000 != 0 => {
                        self::width(&[bounds(view, view.pointer_required(field + 48)?, env)?])?
                    }
                    7 | 8 => 1,
                    _ => return Err(invalid("Unrecognized KDB packed type field")),
                };
                widths.push(size);
            }
            let width = if header == 0x20000048 {
                widths.iter().sum::<usize>()
            } else {
                let first = widths.first().copied().unwrap_or(0);
                if widths.iter().any(|&width| width != first) {
                    return Err(invalid("KDB union field widths differ"));
                }
                first
            };
            if !(1..=1 << 20).contains(&width) {
                return Err(invalid("KDB packed type width exceeds bounds"));
            }
            Ok((
                if header == 0x20000048 {
                    "struct"
                } else {
                    "union"
                },
                width,
                Vec::new(),
            ))
        }
        _ => Err(invalid(format!(
            "Unrecognized KDB packed type tag {header:#x}"
        ))),
    }
}

fn type_expression(
    view: &View,
    key: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<(&'static str, usize, Dimensions)> {
    if depth > 20 || view.uint(key, 4)? != 0x550123 {
        return Err(invalid("Invalid KDB type substitution expression"));
    }
    match view.uint(key + 8, 8)? {
        0x07000000 if view.pointer(key + 24)?.is_none() => Ok(("", 1, Vec::new())),
        0x07000000 => Ok(("", 1, vec![bounds(view, operands(view, key, 1)?[0], env)?])),
        0x0f000000 => packed_type(view, operands(view, key, 1)?[0], depth + 1, env),
        _ => Err(invalid("Unsupported KDB type substitution base")),
    }
}

fn type_width(view: &View, key: u64, env: &mut Environment) -> io::Result<usize> {
    let (_, scalar, bounds) = type_expression(view, key, 0, env)?;
    scalar
        .checked_mul(width(&bounds)?)
        .ok_or_else(|| invalid("KDB type width overflow"))
}

struct Environment<'a, 'b> {
    objects: &'a mut Objects,
    contexts: &'a [&'b Node],
    unit: u32,
    packages: &'a HashMap<u32, Node>,
    defaults: bool,
    frames: Vec<functions::Frame>,
}

impl Environment<'_, '_> {
    fn entry(
        &mut self,
        view: &View,
        key: u64,
        _name: &str,
    ) -> io::Result<Option<super::parameters::Entry>> {
        if self.defaults {
            return Ok(None);
        }
        let header = view.uint(key, 4)?;
        let declaration_owner = if header & 0x1fffffff == 0x010c013a {
            view.pointer(key + 56)?
        } else {
            None
        };
        let owners = self
            .contexts
            .iter()
            .filter(|node| node.unit == self.unit && node.variant != (0, 0));
        for owner in owners {
            if declaration_owner.is_some()
                && declaration_owner != Some(lexical::source_scope(view, owner.source)?)
            {
                continue;
            }
            if let Some(entry) = self.objects.parameter(owner.variant, self.unit, key)? {
                return Ok(Some(entry));
            }
        }
        Ok(None)
    }
}

fn package_integer(
    view: &View,
    source: u64,
    name: &str,
    depth: usize,
    env: &mut Environment,
) -> io::Result<(i64, bool)> {
    for slot in [64, 128] {
        for key in lexical::chain(view, view.pointer(source + slot)?)? {
            if view.string(view.pointer_required(key + 32)?)? == name {
                return integer(view, key, depth + 1, env);
            }
        }
    }
    for ty in lexical::chain(view, view.pointer(source + 200)?)? {
        if view.uint(ty, 4)? & TYPE_HEADER_MASK != 0x40000048 {
            continue;
        }
        for item in lexical::chain(view, view.pointer(ty + 48)?)? {
            if view.string(view.pointer_required(item + 32)?)? == name {
                return enum_item(view, item, depth + 1, env);
            }
        }
    }
    Err(invalid("KDB package member was not found"))
}

fn enum_signed(view: &View, key: u64) -> io::Result<bool> {
    Ok(matches!(
        view.uint(key + 28, 4)? & 0xffff0000,
        0 | 0x1070000 | 0xc0000
    ))
}

fn definition(
    view: &View,
    key: u64,
    unit: u32,
    env: &mut Environment,
) -> io::Result<(std::sync::Arc<View>, u64, u32)> {
    let mut target = env.objects.view(unit)?;
    let mut definition_unit = unit;
    let mut key = key;
    if !std::ptr::eq(view, target.as_ref()) {
        return Err(invalid("KDB definition source unit differs"));
    }
    for _ in 0..20 {
        if !matches!(
            target.uint(key, 4)? & TYPE_HEADER_MASK,
            0x60000048 | 0x60200048
        ) {
            return Ok((target, key, definition_unit));
        }
        let flags = target.uint(key + 4, 4)?;
        let unit = target.uint(key + 36, 4)? as u32;
        if unit == 0 && flags == 0 {
            key = target.pointer_required(key + 48)?;
        } else if flags == 0x4000 && env.packages.contains_key(&unit) {
            let imported = env.objects.view(unit)?;
            key = target
                .pointer_into(key + 48, &imported)?
                .ok_or_else(|| invalid("Missing KDB imported type"))?;
            target = imported;
            definition_unit = unit;
        } else {
            return Err(invalid("Unrecognized KDB imported type source"));
        }
    }
    Err(invalid("KDB type alias nesting exceeds bounds"))
}

fn enum_item(
    view: &View,
    key: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<(i64, bool)> {
    if depth > 32 {
        return Err(invalid("KDB enumeration nesting exceeds bounds"));
    }
    let ty = view.pointer_required(key + 40)?;
    let (kind, width, shape) = packed_type(view, ty, 0, env)?;
    if kind != "enum" || !shape.is_empty() || !(1..=32).contains(&width) {
        return Err(invalid("Invalid KDB enum item owner type"));
    }
    let signed = enum_signed(view, ty)?;
    let mut items = lexical::chain(view, view.pointer(ty + 48)?)?;
    if items.is_empty() {
        return Err(invalid("Empty KDB enumeration"));
    }
    items.rotate_left(1);
    let mut value = -1;
    let mut negative_cast = false;
    for (index, item) in items.into_iter().enumerate() {
        if view.uint(item, 4)? != 0x14a
            || view.uint(item + 4, 4)? != index as u64 + 1
            || view.pointer(item + 40)? != Some(ty)
        {
            return Err(invalid("Invalid KDB enum item ordinal"));
        }
        if let Some(initializer) = view.pointer(item + 48)? {
            let (number, expression_signed) = integer(view, initializer, depth + 1, env)?;
            value = number;
            negative_cast = !signed
                && expression_signed
                && number < 0
                && expression_tag(view, initializer)? == 0xc80123;
            if negative_cast && item == key {
                return Ok((value, true));
            }
        } else {
            let previous = value;
            value += 1;
            if item == key && previous < 0 && negative_cast {
                let width = 65 - (!previous as u64).leading_zeros() as usize;
                return Ok((cast_width(value, false, width), false));
            }
        }
        if !negative_cast {
            value = cast_width(value, false, width);
        }
        if item == key {
            return Ok((cast_width(value, signed, width), signed));
        }
    }
    Err(invalid("KDB enumeration item outside owner"))
}

fn cast_width(value: i64, signed: bool, width: usize) -> i64 {
    let modulus = 1i64 << width;
    let value = value & (modulus - 1);
    if signed && value >= modulus / 2 {
        value - modulus
    } else {
        value
    }
}

impl super::Session {
    pub(super) fn integer_parameter(
        &mut self,
        scope: usize,
        name: &str,
    ) -> Option<super::IntegerParameter> {
        let owner = &self.nodes[scope];
        let unit = owner.unit;
        let view = self.objects.view(unit).ok()?;
        let &(key, _) = self.declarations.scope(&view, owner).ok()?.get(name)?;
        let (value, signed, width) = self.port_integer_parameter(scope, &view, unit, key)?;
        let bits = format!("{:0width$b}", value as u64 & ((1u64 << width) - 1));
        Some(super::IntegerParameter { bits, signed })
    }

    pub(super) fn port_index(
        &mut self,
        scope: usize,
        view: &View,
        unit: u32,
        expression: u64,
    ) -> Option<i64> {
        self.in_port_context(scope, unit, |env| integer(view, expression, 0, env))
            .ok()
            .map(|(value, _)| value)
    }

    pub(super) fn port_integer_parameter(
        &mut self,
        scope: usize,
        view: &View,
        unit: u32,
        key: u64,
    ) -> Option<(i64, bool, usize)> {
        let tag = expression_tag(view, key).ok()?;
        if !matches!(tag & 255, 57 | 58) {
            return None;
        }
        self.in_port_context(scope, unit, |env| parameter_integer(view, key, tag, 0, env))
            .ok()
    }

    fn in_port_context<T>(
        &mut self,
        scope: usize,
        unit: u32,
        evaluate: impl FnOnce(&mut Environment<'_, '_>) -> T,
    ) -> T {
        let contexts = super::scope_contexts(&self.nodes, scope);
        let mut environment = Environment {
            objects: &mut self.objects,
            contexts: &contexts,
            unit,
            packages: &self.packages,
            defaults: false,
            frames: Vec::new(),
        };
        evaluate(&mut environment)
    }
}

fn cast(value: u32, signed: bool) -> i64 {
    if signed {
        i64::from(value as i32)
    } else {
        i64::from(value)
    }
}

fn parameter_integer(
    view: &View,
    key: u64,
    tag: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<(i64, bool, usize)> {
    let dtype = tag >> 16 & 255;
    let name = view.string(view.pointer_required(key + 32)?)?;
    let entry = env.entry(view, key, name)?;
    let is_untyped_bits = tag & TYPE_HEADER_MASK == 0x40010039
        && entry
            .as_ref()
            .is_some_and(|entry| matches!(entry.kind, 5 | 0x1000005));
    let (width, signed) = if is_untyped_bits {
        let entry = entry.as_ref().unwrap();
        let ParameterValue::Text(bits) = &entry.value else {
            return Err(invalid("Invalid untyped KDB bit parameter"));
        };
        (bits.len(), entry.kind >> 24 != 0)
    } else if tag & TYPE_HEADER_MASK == 0x0107003a || tag & TYPE_HEADER_MASK == 0x4107003a {
        (
            width(&[bounds(view, view.pointer_required(key + 56)?, env)?])?,
            tag >> 28 & 1 != 0,
        )
    } else if matches!(tag & TYPE_HEADER_MASK, 0x410f003a | 0x010f003a | 0x020f003a) {
        let slot = if tag & TYPE_HEADER_MASK == 0x020f003a {
            64
        } else {
            56
        };
        let target = view.pointer_required(key + slot)?;
        let (category, size, shape) = packed_type(view, target, 0, env)?;
        let length = size * width(&shape)?;
        let signed = if category == "enum" {
            let (view, ty, _) = definition(view, target, env.unit, env)?;
            enum_signed(&view, ty)?
        } else {
            false
        };
        (length, signed)
    } else {
        let width = match dtype {
            1 | 3 | 12 => 32,
            7 | 8 => 1,
            _ => return Err(invalid("Unsupported KDB integer parameter type")),
        };
        (width, width == 32 && tag & 0x20000000 == 0)
    };
    if !(1..=32).contains(&width) {
        return Err(invalid("KDB integer parameter width exceeds bounds"));
    }
    let payload = match entry {
        Some(entry) => {
            if entry.flags != 1 || entry.aux != 0 || entry.trailer != 0 {
                return Err(invalid("Invalid KDB integer parameter flags"));
            }
            match entry.value {
                ParameterValue::Integer(number) if matches!(entry.kind, 1 | 0x1000001) => {
                    number as i64
                }
                ParameterValue::Text(bits)
                    if matches!(entry.kind, 5 | 0x1000005) && bits.len() == width =>
                {
                    i64::from_str_radix(&bits, 2)
                        .map_err(|_| invalid("Unknown bits in KDB integer parameter"))?
                }
                _ => return Err(invalid("Unsupported KDB integer parameter entry")),
            }
        }
        None => integer(view, view.pointer_required(key + 48)?, depth + 1, env)?.0,
    };
    Ok((cast_width(payload, signed, width), signed, width))
}

fn integer(view: &View, key: u64, depth: usize, env: &mut Environment) -> io::Result<(i64, bool)> {
    if depth > 32 {
        return Err(invalid("KDB expression depth exceeds bounds"));
    }
    let tag = expression_tag(view, key)?;
    if let Some(value) = functions::argument(view, key, tag, depth, env)? {
        return Ok(value);
    }
    if matches!(tag & 255, 57 | 58) {
        return parameter_integer(view, key, tag, depth, env)
            .map(|(value, signed, _)| (value, signed));
    }
    if let Some(radix) = match tag & !0x10010000 {
        0x020228 => Some(2),
        0x040228 => Some(8),
        0x060228 => Some(10),
        0x080228 => Some(16),
        _ => None,
    } {
        let width = view.uint(key + 4, 4)? as usize;
        let digits = view.string(view.pointer_required(key + 16)?)?;
        if !(1..=32).contains(&width) || digits.len() > 32 {
            return Err(invalid("KDB integer literal width exceeds bounds"));
        }
        let value = u64::from_str_radix(digits, radix)
            .map_err(|_| invalid("Invalid KDB integer literal"))?;
        let signed = tag & 0x10000000 != 0;
        return Ok((cast_width(value as i64, signed, width), signed));
    }
    match tag {
        0x2b0123 => functions::call(view, key, depth, env),
        0x2c0123 => {
            let args = operands(view, key, 2)?;
            let arg = args[0];
            let identifier = args[1];
            if view.uint(identifier, 8)? != 27 {
                return Err(invalid("Unrecognized KDB built-in function identifier"));
            }
            let name = view.string(view.pointer_required(identifier + 24)?)?;
            if name == "$bits" {
                let header = view.uint(arg, 4)?;
                let width = match header {
                    0x550123 => type_width(view, arg, env)?,
                    0x10000328 => 32,
                    _ if header & 255 == 57 => match header >> 16 & 255 {
                        1 | 12 => 32,
                        7 | 8 => 1,
                        _ => return Err(invalid("Unsupported KDB bits parameter type")),
                    },
                    _ if header & 0xffff00ff == 0x4107003a => {
                        width(&[bounds(view, view.pointer_required(arg + 56)?, env)?])?
                    }
                    _ => return Err(invalid("Unsupported KDB bits operand")),
                };
                return Ok((width as i64, true));
            }
            let (value, _) = integer(view, arg, depth + 1, env)?;
            match name {
                "$clog2" => Ok((
                    i64::from(32 - (value as u32).saturating_sub(1).leading_zeros()),
                    true,
                )),
                "$signed" => Ok((cast(value as u32, true), true)),
                "$unsigned" => Ok((cast(value as u32, false), false)),
                _ => Err(invalid(format!("Unsupported KDB integer built-in {name}"))),
            }
        }
        0x0004013c | 0x0011013c | 0x1011013c | 0x2403013c | 0x3403013c => {
            if let Some(value) = aggregates::field(view, key, tag, depth, env)? {
                return Ok(value);
            }
            let link = view.uint(key + 16, 8)?;
            let unit = (link >> 48) as u32;
            let package = env
                .packages
                .get(&unit)
                .ok_or_else(|| invalid("KDB package link has no source unit"))?;
            if link >> 32 & 0xffff != 0xffff || link & 0xffffffff == 0 {
                return Err(invalid("Invalid KDB package link"));
            }
            let mut name = view.string(view.pointer_required(key + 24)?)?;
            if matches!(tag, 0x2403013c | 0x3403013c) {
                let member = view.pointer_required(key + 40)?;
                if name != package.fullname
                    || !matches!(view.uint(member, 4)?, 0x2011013c | 0x2004013c)
                    || view.uint(member + 16, 8)? != link
                    || view.pointer(member + 32)? != Some(key)
                {
                    return Err(invalid("Invalid KDB qualified package link"));
                }
                name = view.string(view.pointer_required(member + 24)?)?;
            }
            let target = env.objects.view(unit)?;
            let previous = std::mem::replace(&mut env.unit, unit);
            let result = package_integer(&target, package.source, name, depth + 1, env);
            env.unit = previous;
            result
        }
        0x14a => enum_item(view, key, depth + 1, env),
        0x240123 => {
            let args = operands(view, key, 2)?;
            let target = args[1];
            if !matches!(
                view.uint(target, 4)? & TYPE_HEADER_MASK,
                0x010f003a | 0x410f003a
            ) {
                return Err(invalid("Unsupported KDB constant bit selection"));
            }
            let ty = view.pointer_required(target + 56)?;
            let (category, _, shape) = packed_type(view, ty, 0, env)?;
            let [(left, right)] = shape.as_slice() else {
                return Err(invalid("Unsupported KDB constant bit selection shape"));
            };
            let (index, _) = integer(view, args[0], depth + 1, env)?;
            if !category.is_empty() || !((*left).min(*right)..=(*left).max(*right)).contains(&index)
            {
                return Err(invalid("KDB constant bit selection exceeds bounds"));
            }
            let bit = index.abs_diff(*right);
            let (value, _) = integer(view, target, depth + 1, env)?;
            Ok(((value >> bit) & 1, false))
        }
        0x270123 => {
            let args = operands(view, key, 3)?;
            let (no, signed_no) = integer(view, args[0], depth + 1, env)?;
            let (select, _) = integer(view, args[1], depth + 1, env)?;
            let (yes, signed_yes) = integer(view, args[2], depth + 1, env)?;
            let signed = signed_no && signed_yes;
            Ok((
                cast(if select != 0 { yes as u32 } else { no as u32 }, signed),
                signed,
            ))
        }
        0x4d0123 | 0x4e0123 => {
            let arg = operands(view, key, 1)?[0];
            let signed = tag == 0x4e0123;
            Ok((
                cast(integer(view, arg, depth + 1, env)?.0 as u32, signed),
                signed,
            ))
        }
        0x4f0123 => {
            let args = operands(view, key, 2)?;
            let (category, width, shape) = packed_type(view, args[1], 0, env)?;
            if category != "enum" || !(1..=32).contains(&width) || !shape.is_empty() {
                return Err(invalid("Unsupported KDB constant enumeration cast"));
            }
            let (target, key, _) = definition(view, args[1], env.unit, env)?;
            let signed = enum_signed(&target, key)?;
            let (value, _) = integer(view, args[0], depth + 1, env)?;
            Ok((cast_width(value, signed, width), signed))
        }
        0xc80123 => {
            let args = operands(view, key, 2)?;
            let (size, _) = integer(view, args[1], depth + 1, env)?;
            if !(1..=32).contains(&size) {
                return Err(invalid("Invalid KDB integer cast width"));
            }
            let (value, signed) = integer(view, args[0], depth + 1, env)?;
            Ok((cast_width(value, signed, size as usize), signed))
        }
        0x10000328 | 0x10010328 => {
            let signed = tag == 0x10000328;
            Ok((cast(view.uint(key + 16, 4)? as u32, signed), signed))
        }
        0xaa0228 => match view.string(view.pointer_required(key + 16)?)? {
            "0" => Ok((0, false)),
            "1" => Ok((-1, false)),
            _ => Err(invalid("Unknown bits in KDB integer literal")),
        },
        0x030123 => {
            let (value, signed) = integer(view, operands(view, key, 1)?[0], depth + 1, env)?;
            Ok((cast((value as u32).wrapping_neg(), signed), signed))
        }
        0x0e0123..=0x220123 | 0x300123 | 0x350123 if tag & 0xffff == 0x0123 => {
            let pair = operands(view, key, 2)?;
            let (left, left_signed) = integer(view, pair[1], depth + 1, env)?;
            let (right, right_signed) = integer(view, pair[0], depth + 1, env)?;
            let mut signed = left_signed && right_signed;
            let a = left as u32;
            let b = right as u32;
            let result = match tag >> 16 {
                0x0e => a.wrapping_add(b),
                0x0f => a.wrapping_sub(b),
                0x10 => a.wrapping_mul(b),
                0x11 | 0x12
                    if right != 0 && (left_signed == right_signed || left.min(right) >= 0) =>
                {
                    if tag >> 16 == 0x11 {
                        (left / right) as u32
                    } else {
                        (left % right) as u32
                    }
                }
                0x13 | 0x14 | 0x1a | 0x1c | 0x1d => {
                    let a = cast(a, signed);
                    let b = cast(b, signed);
                    signed = false;
                    u32::from(match tag >> 16 {
                        0x13 => a == b,
                        0x14 => a != b,
                        0x1a => a < b,
                        0x1c => a > b,
                        _ => a >= b,
                    })
                }
                0x17 | 0x18 => {
                    signed = false;
                    u32::from(if tag >> 16 == 0x17 {
                        a != 0 && b != 0
                    } else {
                        a != 0 || b != 0
                    })
                }
                0x1e => a & b,
                0x1f => a | b,
                0x21 => {
                    signed = left_signed;
                    a.checked_shl(b).unwrap_or(0)
                }
                0x22 => {
                    signed = left_signed;
                    a.checked_shr(b).unwrap_or(0)
                }
                0x30 if right >= 0 => {
                    signed = left_signed;
                    a.wrapping_pow(b)
                }
                0x35 => {
                    signed = left_signed;
                    (cast(a, signed) >> b.min(32)) as u32
                }
                _ => {
                    return Err(invalid(format!(
                        "Unrecognized KDB integer operator {tag:#x}"
                    )))
                }
            };
            Ok((cast(result, signed), signed))
        }
        _ => Err(invalid(format!(
            "Unrecognized KDB dimension expression {tag:#x}"
        ))),
    }
}
