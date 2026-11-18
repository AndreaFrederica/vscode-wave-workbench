// SPDX-License-Identifier: MPL-2.0

use super::{
    aggregates::{fields, Field},
    cast, cast_width, definition, enum_signed, expression_tag, integer, invalid, lexical,
    operand_list, operands, packed_type, width, Environment, View, TYPE_HEADER_MASK,
};
use num_bigint::BigUint;
use std::{collections::HashMap, io};

type Value = (i64, bool);

enum Returned {
    Integer(Value),
    Structure(BigUint),
}

struct Structure {
    layout: Vec<Field>,
    value: Option<BigUint>,
}

struct Binding {
    value: Option<i64>,
    signed: bool,
    shape: Option<(i64, i64)>,
    written: u32,
}

impl Binding {
    fn new(signed: bool) -> Self {
        Self {
            value: None,
            signed,
            shape: None,
            written: 0,
        }
    }

    fn length(&self) -> usize {
        self.shape
            .map_or(32, |(left, right)| left.abs_diff(right) as usize + 1)
    }

    fn set(&mut self, value: i64) {
        self.value = Some(cast_width(value, self.signed, self.length()));
        self.written = (u32::MAX as u64 >> (32 - self.length())) as u32;
    }

    fn read(&self) -> io::Result<Value> {
        if self.written.count_ones() as usize != self.length() {
            return Err(invalid("Uninitialized KDB constant function variable"));
        }
        Ok((self.value.unwrap_or(0), self.signed))
    }

    fn bit(&self, index: i64) -> io::Result<u32> {
        let (left, right) = self
            .shape
            .ok_or_else(|| invalid("KDB function value is not a vector"))?;
        if !(left.min(right)..=left.max(right)).contains(&index) {
            return Err(invalid("KDB constant function bit outside packed bounds"));
        }
        Ok(index.abs_diff(right) as u32)
    }
}

pub(super) struct Frame {
    unit: u32,
    values: HashMap<u64, Binding>,
    structures: HashMap<u64, Structure>,
    steps: usize,
}

pub(super) fn argument(
    view: &View,
    key: u64,
    tag: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Option<Value>> {
    let Some(frame) = env.frames.last().filter(|frame| frame.unit == env.unit) else {
        return Ok(None);
    };
    if let Some(value) = frame.values.get(&key) {
        return value.read().map(Some);
    }
    if let Some((structure, field)) = structure_field(view, key, tag, frame)? {
        let value = frame.structures[&structure]
            .value
            .as_ref()
            .ok_or_else(|| invalid("Uninitialized KDB constant function structure"))?;
        return Ok(Some(field.read(value)));
    }
    if tag == 0x240123 {
        let args = operands(view, key, 2)?;
        if frame.values.contains_key(&args[1]) {
            let (index, _) = integer(view, args[0], depth + 1, env)?;
            let value = &env.frames.last().unwrap().values[&args[1]];
            let bit = value.bit(index)?;
            if value.written & (1 << bit) == 0 {
                return Err(invalid("Uninitialized KDB constant function bit"));
            }
            return Ok(Some(((value.value.unwrap_or(0) >> bit) & 1, false)));
        }
    }
    Ok(None)
}

pub(super) fn call(
    view: &View,
    key: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Value> {
    match invoke(view, key, depth, None, env)? {
        Returned::Integer(value) => Ok(value),
        Returned::Structure(_) => Err(invalid("KDB function returns a packed structure")),
    }
}

pub(super) fn call_structure(
    view: &View,
    key: u64,
    depth: usize,
    ty: (u32, u64),
    env: &mut Environment,
) -> io::Result<BigUint> {
    match invoke(view, key, depth, Some(ty), env)? {
        Returned::Structure(value) => Ok(value),
        Returned::Integer(_) => Err(invalid("KDB function does not return a packed structure")),
    }
}

fn invoke(
    view: &View,
    key: u64,
    depth: usize,
    ty: Option<(u32, u64)>,
    env: &mut Environment,
) -> io::Result<Returned> {
    let mut args = operand_list(view, key + 24, None)?;
    if args.len() < 2 {
        return Err(invalid("Invalid KDB constant function call"));
    }
    let identifier = args.remove(1);
    args.rotate_left(1);
    let mut arguments = Vec::with_capacity(args.len());
    for arg in args {
        arguments.push(integer(view, arg, depth + 1, env)?.0);
    }
    let header = view.uint(identifier, 4)?;
    if header & 255 == 64 {
        return evaluate(view, identifier, env.unit, arguments, depth + 1, ty, env);
    }
    if !matches!(header, 0x0013013c | 0x1013013c | 0x2403013c | 0x3403013c) {
        return Err(invalid("Unsupported KDB constant function reference"));
    }
    let link = view.uint(identifier + 16, 8)?;
    let unit = (link >> 48) as u32;
    let package = env
        .packages
        .get(&unit)
        .ok_or_else(|| invalid("Unknown KDB constant function package"))?;
    let mut name = view.string(view.pointer_required(identifier + 24)?)?;
    if link >> 32 & 0xffff != 0xffff || link & 0xffffffff == 0 {
        return Err(invalid("Invalid KDB constant function package link"));
    }
    if matches!(header, 0x2403013c | 0x3403013c) {
        let member = view.pointer_required(identifier + 40)?;
        if name != package.fullname
            || view.uint(member, 4)? != 0x2013013c
            || view.uint(member + 16, 8)? != link
            || view.pointer(member + 32)? != Some(identifier)
        {
            return Err(invalid("Invalid KDB qualified constant function"));
        }
        name = view.string(view.pointer_required(member + 24)?)?;
    }
    let target = env.objects.view(unit)?;
    let scope = lexical::source_scope(&target, package.source)?;
    for function in lexical::chain(&target, target.pointer(scope + 168)?)? {
        if target.uint(function, 1)? == 64
            && target.string(target.pointer_required(function + 40)?)? == name
        {
            if header == 0x1013013c
                && view.pointer_into(identifier + 48, &target)? != Some(function)
            {
                return Err(invalid("KDB imported function declaration differs"));
            }
            return evaluate(&target, function, unit, arguments, depth + 1, ty, env);
        }
    }
    Err(invalid("KDB constant function declaration was not found"))
}

fn evaluate(
    view: &View,
    function: u64,
    unit: u32,
    arguments: Vec<i64>,
    depth: usize,
    expected_type: Option<(u32, u64)>,
    env: &mut Environment,
) -> io::Result<Returned> {
    let header = view.uint(function, 4)? & TYPE_HEADER_MASK;
    if !matches!(header, 0x41030040 | 0x410c0040 | 0x610c0040 | 0x410f0040)
        || view.uint(function + 32, 4)? & 0x300 != 0x200
    {
        return Err(invalid("Unsupported KDB constant function declaration"));
    }
    let name = view.string(view.pointer_required(function + 40)?)?;
    let mut declarations = lexical::chain(view, view.pointer(function + 96)?)?;
    if declarations.is_empty() {
        return Err(invalid("KDB constant function has no declarations"));
    }
    declarations.rotate_left(1);
    let previous_unit = std::mem::replace(&mut env.unit, unit);
    env.frames.push(Frame {
        unit,
        values: HashMap::new(),
        structures: HashMap::new(),
        steps: 10_000,
    });
    let result = (|| {
        let mut arguments = arguments.into_iter();
        let mut result_key = None;
        for declaration in declarations {
            let tag = view.uint(declaration, 4)? & TYPE_HEADER_MASK;
            let mut binding = Binding::new(tag & 0x20000000 == 0);
            match tag & 255 {
                56 if view.pointer(declaration + 72)? == Some(function) => {
                    let value = arguments
                        .next()
                        .ok_or_else(|| invalid("Missing KDB constant function argument"))?;
                    let flags = view.uint(declaration + 28, 4)?;
                    let input = view.uint(declaration + 64, 4)? == 0x820000;
                    if flags != 0x8200
                        && flags != 0x9200
                        && !(input && matches!(flags, 0x8300 | 0x18300 | 0x19300))
                    {
                        return Err(invalid(
                            "Unsupported KDB constant function argument direction",
                        ));
                    }
                    match tag {
                        0x01030038 | 0x010c0038 | 0x210c0038 => binding.set(value),
                        0x01070038 => {
                            binding.signed = false;
                            binding.set(value & 1);
                        }
                        0x020f0038 => {
                            let ty = view.pointer_required(declaration + 80)?;
                            let (kind, size, shape) = packed_type(view, ty, 0, env)?;
                            let length = size * width(&shape)?;
                            if !(1..=32).contains(&length) {
                                return Err(invalid(
                                    "KDB constant function formal width exceeds bounds",
                                ));
                            }
                            let [range] = shape.as_slice() else {
                                if kind != "enum" {
                                    return Err(invalid(
                                        "Unsupported KDB constant function argument type",
                                    ));
                                }
                                let (target, ty, _) = definition(view, ty, env.unit, env)?;
                                binding.signed = enum_signed(&target, ty)?;
                                binding.set(cast_width(value, binding.signed, length));
                                env.frames
                                    .last_mut()
                                    .unwrap()
                                    .values
                                    .insert(declaration, binding);
                                continue;
                            };
                            binding.signed = false;
                            binding.shape = Some(*range);
                            binding.set(value);
                        }
                        _ => return Err(invalid("Unsupported KDB constant function formal type")),
                    }
                }
                55 if view.pointer(declaration + 56)? == Some(function) => {
                    let result = view.string(view.pointer_required(declaration + 32)?)? == name;
                    if result {
                        result_key = Some(declaration);
                        binding.signed = header & 0x20000000 == 0;
                    }
                    if tag == 0x020f0037 {
                        let ty = view.pointer_required(declaration + 64)?;
                        let (kind, size, shape) = packed_type(view, ty, 0, env)?;
                        if kind == "struct" && expected_type.is_some() && shape.is_empty() {
                            let (target, ty, unit) = definition(view, ty, env.unit, env)?;
                            if result && Some((unit, ty)) != expected_type {
                                return Err(invalid(
                                    "KDB constant function structure type differs",
                                ));
                            }
                            let previous = std::mem::replace(&mut env.unit, unit);
                            let layout = fields(&target, ty, env);
                            env.unit = previous;
                            env.frames.last_mut().unwrap().structures.insert(
                                declaration,
                                Structure {
                                    layout: layout?,
                                    value: None,
                                },
                            );
                            continue;
                        }
                        let [range] = shape.as_slice() else {
                            return Err(invalid("Unsupported KDB constant function return shape"));
                        };
                        if !kind.is_empty() || size != 1 || width(&shape)? > 32 {
                            return Err(invalid("Unsupported KDB constant function vector type"));
                        }
                        binding.shape = Some(*range);
                        binding.signed = false;
                    } else if !result {
                        let property = declaration + 64;
                        let initial = if view.uint(property, 8)? == 11 {
                            let assignment = view.pointer_required(property + 32)?;
                            if view.string(view.pointer_required(property + 8)?)? != "regDeclAss"
                                || view.pointer(property + 40)? != Some(declaration)
                                || view.uint(assignment, 4)? != 0x144
                                || view.pointer(assignment + 8)? != Some(declaration)
                            {
                                return Err(invalid(
                                    "Invalid KDB constant function local initializer",
                                ));
                            }
                            view.pointer_required(assignment + 32)?
                        } else {
                            property
                        };
                        let value = integer(view, initial, depth + 1, env)?.0;
                        binding.set(value);
                    }
                }
                _ => return Err(invalid("Unsupported KDB constant function variable")),
            }
            env.frames
                .last_mut()
                .unwrap()
                .values
                .insert(declaration, binding);
        }
        if arguments.next().is_some() {
            return Err(invalid("Too many KDB constant function arguments"));
        }
        let result_key =
            result_key.ok_or_else(|| invalid("Missing KDB constant function result"))?;
        let returned = body(view, function + 112, function, depth + 1, env)?;
        let frame = env.frames.last_mut().unwrap();
        if let Some(structure) = frame.structures.get(&result_key) {
            return match returned {
                Some(Returned::Structure(value)) => Ok(Returned::Structure(value)),
                None => structure
                    .value
                    .clone()
                    .map(Returned::Structure)
                    .ok_or_else(|| invalid("Uninitialized KDB constant function result")),
                _ => Err(invalid("KDB constant function result type differs")),
            };
        }
        let binding = frame
            .values
            .get_mut(&result_key)
            .ok_or_else(|| invalid("Missing KDB constant function result binding"))?;
        match returned {
            Some(Returned::Integer((value, _))) => binding.set(value),
            None => (),
            _ => return Err(invalid("KDB constant function result type differs")),
        }
        binding.read().map(Returned::Integer)
    })();
    env.frames.pop();
    env.unit = previous_unit;
    result
}

fn structure_field(
    view: &View,
    key: u64,
    tag: u64,
    frame: &Frame,
) -> io::Result<Option<(u64, Field)>> {
    if tag != 0x0031013e {
        return Ok(None);
    }
    let structure = view.pointer_required(key + 48)?;
    let member = view.pointer_required(key + 40)?;
    if view.uint(member, 4)? != 0x2004013e || view.pointer(member + 32)? != Some(key) {
        return Err(invalid("Invalid KDB constant function structure member"));
    }
    let field = view.pointer_required(member + 48)?;
    frame
        .structures
        .get(&structure)
        .and_then(|entry| entry.layout.iter().find(|item| item.key == field))
        .copied()
        .map(|field| Some((structure, field)))
        .ok_or_else(|| invalid("Missing KDB constant function structure member"))
}

fn body(
    view: &View,
    slot: u64,
    parent: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Option<Returned>> {
    let mut children = lexical::chain(view, view.pointer(slot)?)?;
    if !children.is_empty() {
        children.rotate_left(1);
    }
    for child in children {
        if let Some(value) = statement(view, child, parent, depth + 1, env)? {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn statement(
    view: &View,
    key: u64,
    parent: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Option<Returned>> {
    if depth > 32 || view.pointer(key + 48)? != Some(parent) {
        return Err(invalid("Invalid KDB constant function statement"));
    }
    let frame = env.frames.last_mut().unwrap();
    frame.steps = frame
        .steps
        .checked_sub(1)
        .ok_or_else(|| invalid("KDB constant function exceeds execution budget"))?;
    let header = view.uint(key, 4)?;
    let subtype = view.uint(key + 4, 4)?;
    if header == 0x142 && subtype == 3 {
        return body(view, key + 56, key, depth, env);
    }
    if header != 0x143 {
        return Err(invalid("Unsupported KDB constant function statement"));
    }
    match subtype {
        55 => {
            let expression = operand_list(view, key + 96, Some(1))?[0];
            if let Some(structure) = env.frames.last().unwrap().structures.get(&expression) {
                return structure
                    .value
                    .clone()
                    .map(Returned::Structure)
                    .map(Some)
                    .ok_or_else(|| {
                        invalid("Uninitialized KDB constant function structure result")
                    });
            }
            integer(view, expression, depth + 1, env)
                .map(Returned::Integer)
                .map(Some)
        }
        13 => {
            let args = operand_list(view, key + 96, Some(2))?;
            let target_tag = expression_tag(view, args[1])?;
            let frame = env.frames.last().unwrap();
            if frame.structures.contains_key(&args[1]) {
                let value = if let Some(source) = frame.structures.get(&args[0]) {
                    source
                        .value
                        .clone()
                        .ok_or_else(|| invalid("Uninitialized KDB structure assignment"))?
                } else if integer(view, args[0], depth + 1, env)?.0 == 0 {
                    BigUint::default()
                } else {
                    return Err(invalid("Unsupported KDB structure assignment"));
                };
                env.frames
                    .last_mut()
                    .unwrap()
                    .structures
                    .get_mut(&args[1])
                    .unwrap()
                    .value = Some(value);
                return Ok(None);
            }
            let field = structure_field(view, args[1], target_tag, frame)?;
            let value = integer(view, args[0], depth + 1, env)?.0;
            if let Some((structure, field)) = field {
                let value_ref = env
                    .frames
                    .last_mut()
                    .unwrap()
                    .structures
                    .get_mut(&structure)
                    .unwrap()
                    .value
                    .as_mut()
                    .ok_or_else(|| invalid("Uninitialized KDB structure assignment"))?;
                field.write(value_ref, value);
            } else if target_tag == 0x240123 {
                let parts = operands(view, args[1], 2)?;
                let index = integer(view, parts[0], depth + 1, env)?.0;
                let binding = env
                    .frames
                    .last_mut()
                    .unwrap()
                    .values
                    .get_mut(&parts[1])
                    .ok_or_else(|| invalid("Unknown KDB constant function bit target"))?;
                let mask = 1u32 << binding.bit(index)?;
                binding.value = Some(
                    (binding.value.unwrap_or(0) & !i64::from(mask))
                        | (if value & 1 != 0 { i64::from(mask) } else { 0 }),
                );
                binding.written |= mask;
            } else {
                let binding = env
                    .frames
                    .last_mut()
                    .unwrap()
                    .values
                    .get_mut(&args[1])
                    .ok_or_else(|| invalid("Unknown KDB constant function assignment target"))?;
                binding.set(value);
            }
            Ok(None)
        }
        26 => {
            let condition = operand_list(view, key + 96, Some(1))?[0];
            let (value, _) = integer(view, condition, depth + 1, env)?;
            let branches = lexical::chain(view, view.pointer(key + 56)?)?;
            match branches.as_slice() {
                [yes] if value != 0 => statement(view, *yes, key, depth + 1, env),
                [_, yes] if value != 0 => statement(view, *yes, key, depth + 1, env),
                [no, _] => statement(view, *no, key, depth + 1, env),
                [_] => Ok(None),
                _ => Err(invalid("Invalid KDB constant function branches")),
            }
        }
        32 => loop_statement(view, key, depth, env),
        27 | 283 => case_statement(view, key, depth, env),
        _ => Err(invalid(format!(
            "Unsupported KDB constant function statement {subtype:#x}"
        ))),
    }
}

fn case_statement(
    view: &View,
    key: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Option<Returned>> {
    let selector = operand_list(view, key + 96, Some(1))?[0];
    let (value, _) = integer(view, selector, depth + 1, env)?;
    let mut cases = lexical::chain(view, view.pointer(key + 56)?)?;
    if cases.is_empty() || cases.len() > 1024 {
        return Err(invalid("KDB constant function case count exceeds bounds"));
    }
    cases.rotate_left(1);
    let mut fallback = None;
    for item in cases {
        if view.uint(item, 4)? != 0x143 || view.pointer(item + 48)? != Some(key) {
            return Err(invalid("Invalid KDB constant function case item"));
        }
        let body = view.pointer_required(item + 56)?;
        match view.uint(item + 4, 4)? {
            31 if fallback.is_none() => fallback = Some((body, item)),
            30 => {
                for test in operand_list(view, item + 96, None)? {
                    if integer(view, test, depth + 1, env)?.0 == value {
                        return statement(view, body, item, depth + 1, env);
                    }
                }
            }
            _ => return Err(invalid("Invalid KDB constant function case label")),
        }
    }
    let (body, item) =
        fallback.ok_or_else(|| invalid("KDB constant function case has no match"))?;
    statement(view, body, item, depth + 1, env)
}

fn loop_statement(
    view: &View,
    key: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Option<Returned>> {
    let scope = view.pointer_required(key + 56)?;
    let parts = lexical::chain(view, Some(scope))?;
    let [_, initialize, step] = parts.as_slice() else {
        return Err(invalid("Invalid KDB constant function loop"));
    };
    if view.uint(scope, 8)? != 0xc000000200000142
        || view.pointer(scope + 48)? != Some(key)
        || view.uint(*initialize, 8)? != 0x0000000d00000143
        || view.uint(*step, 8)? != 0x003a003900000143
    {
        return Err(invalid("Unsupported KDB constant function loop"));
    }
    let local = view.pointer_required(scope + 104)?;
    let update = operand_list(view, *step + 96, Some(1))?[0];
    if view.pointer(local + 8)? != Some(local)
        || view.pointer(local + 56)? != Some(scope)
        || expression_tag(view, update)? != 0x3a0123
        || operands(view, update, 1)? != [local]
    {
        return Err(invalid("Unsupported KDB constant function loop increment"));
    }
    let signed = view.uint(local, 4)? & 0x20000000 == 0;
    env.frames
        .last_mut()
        .unwrap()
        .values
        .insert(local, Binding::new(signed));
    let result = (|| {
        statement(view, *initialize, key, depth + 1, env)?;
        let condition = operand_list(view, key + 96, Some(1))?[0];
        let body = view.pointer_required(scope + 56)?;
        while integer(view, condition, depth + 1, env)?.0 != 0 {
            if let Some(returned) = statement(view, body, scope, depth + 1, env)? {
                return Ok(Some(returned));
            }
            let binding = env
                .frames
                .last_mut()
                .unwrap()
                .values
                .get_mut(&local)
                .unwrap();
            let value = binding.read()?.0;
            binding.set(cast((value as u32).wrapping_add(1), signed));
        }
        Ok(None)
    })();
    env.frames.last_mut().unwrap().values.remove(&local);
    result
}
