// SPDX-License-Identifier: MPL-2.0

use super::{literals, values, IndexedPart, PortShape, Selection, Session, View, MAX_PORT_WIDTH};
use serde::Serialize;
use std::{collections::BTreeSet, io};

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
pub(super) struct PortExpression {
    operands: Vec<Operand>,
    value: Value,
    #[serde(rename = "indexOperands", skip_serializing_if = "BTreeSet::is_empty")]
    index_operands: BTreeSet<usize>,
}

impl PortExpression {
    pub(super) fn extension(width: u64, source: Option<(String, String, Option<i32>)>) -> Self {
        let (operands, value) = match source {
            Some((instance, signal, bit)) => {
                let sign = bit.map_or(Value::Signal(0), |bit| Value::Select(0, bit, bit));
                (vec![Operand { instance, signal }], Value::Repeat(width, Box::new(sign)))
            }
            None => (Vec::new(), Value::Literal("0".repeat(width as usize), false)),
        };
        Self { operands, value, index_operands: BTreeSet::new() }
    }

    pub(super) fn matches_operands(&self, operands: &[(String, String)], complete: bool) -> bool {
        operands.iter().all(|(instance, signal)| {
            self.operands
                .iter()
                .any(|operand| &operand.instance == instance && &operand.signal == signal)
        }) && self.operands.iter().enumerate().all(|(index, operand)| {
            operands.iter().any(|(instance, signal)| {
                instance == &operand.instance && signal == &operand.signal
            }) || (!complete && self.index_operands.contains(&index))
        })
    }

    pub(super) fn indexed_base(&self) -> Option<(&str, &str)> {
        let operand = match self.value {
            Value::BitSelect(operand, _) | Value::IndexedPartSelect(operand, _, _) => operand,
            _ => return None,
        };
        let base = self.operands.get(operand)?;
        (!self.index_operands.is_empty()).then_some((&base.instance, &base.signal))
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
struct Operand {
    instance: String,
    signal: String,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(tag = "op", content = "args", rename_all = "camelCase")]
enum Value {
    Signal(usize),
    Literal(String, bool),
    Select(usize, i32, i32),
    BitSelect(usize, Box<Value>),
    IndexedPartSelect(usize, Box<Value>, IndexedPart),
    Concat(Vec<Value>),
    Repeat(u64, Box<Value>),
    Unary(&'static str, Box<Value>),
    Binary(&'static str, Box<Value>, Box<Value>),
    Conditional(Box<Value>, Box<Value>, Box<Value>),
}

pub(super) fn read(
    session: &mut Session,
    view: &View,
    unit: u32,
    caller: usize,
    expression: u64,
) -> io::Result<Option<(PortExpression, u64)>> {
    let mut reader = Reader {
        session,
        view,
        unit,
        caller,
        operands: Vec::new(),
        index_operands: BTreeSet::new(),
        in_index: false,
        remaining: 64,
        literal_bits: MAX_PORT_WIDTH as usize,
    };
    Ok(reader
        .value(expression, 0)?
        .filter(|(_, width)| *width != 0)
        .map(|(value, width)| {
            (
                PortExpression {
                    operands: reader.operands,
                    value,
                    index_operands: reader.index_operands,
                },
                width,
            )
        }))
}

struct Reader<'a> {
    session: &'a mut Session,
    view: &'a View,
    unit: u32,
    caller: usize,
    operands: Vec<Operand>,
    index_operands: BTreeSet<usize>,
    in_index: bool,
    remaining: usize,
    literal_bits: usize,
}

impl Reader<'_> {
    fn operand(&mut self, instance: String, signal: String) -> usize {
        let operand = Operand { instance, signal };
        let index = match self.operands.iter().position(|item| item == &operand) {
            Some(index) => index,
            None => {
                let index = self.operands.len();
                self.operands.push(operand);
                index
            }
        };
        if self.in_index {
            self.index_operands.insert(index);
        }
        index
    }

    fn value(&mut self, key: u64, depth: usize) -> io::Result<Option<(Value, u64)>> {
        if depth >= 16 || self.remaining == 0 {
            return Ok(None);
        }
        self.remaining -= 1;
        if let Some(endpoint) = self
            .session
            .port_operand(self.view, self.unit, self.caller, key)?
        {
            let Some(shape) = endpoint.shape else {
                return Ok(None);
            };
            let data = self.operand(endpoint.instance, endpoint.signal);
            let value = if let Some(index) = endpoint.select_index {
                let index_operand = self.operand(index.instance, index.signal);
                self.index_operands.insert(index_operand);
                let index_value = Box::new(Value::Signal(index_operand));
                match index.part {
                    Some(part) => Value::IndexedPartSelect(data, index_value, part),
                    None => Value::BitSelect(data, index_value),
                }
            } else if let Some([left, right]) = endpoint.range {
                Value::Select(data, left, right)
            } else if let Some(bit) = endpoint.bit {
                Value::Select(data, bit, bit)
            } else {
                Value::Signal(data)
            };
            return Ok(Some((value, shape.width())));
        }
        if let Some(literal) = literals::read(self.view, key)? {
            let width = literal.bits.len();
            if literal.fill || width > self.literal_bits {
                return Ok(None);
            }
            self.literal_bits -= width;
            return Ok(Some((
                Value::Literal(literal.bits, literal.signed),
                width as u64,
            )));
        }
        if let Some((value, signed, width)) =
            self.session
                .port_integer_parameter(self.caller, self.view, self.unit, key)
        {
            if width > self.literal_bits {
                return Ok(None);
            }
            self.literal_bits -= width;
            let bits = value as u64 & ((1u64 << width) - 1);
            return Ok(Some((
                Value::Literal(format!("{bits:0width$b}"), signed),
                width as u64,
            )));
        }

        if let Some((base, selection)) = Selection::read(self.view, key)? {
            return self.select(base, selection, depth);
        }

        let opcode = self.view.uint(key, 4)? & 0xffff80ff;
        if matches!(opcode, 0x290023 | 0x2a0023) {
            return self.concat(key, opcode == 0x2a0023, depth);
        }
        if opcode == 0x050023 {
            let child = values::operands(self.view, key, 1)?[0];
            return Ok(self
                .value(child, depth + 1)?
                .map(|(value, width)| (Value::Unary("bitNot", Box::new(value)), width)));
        }
        if opcode == 0x270023 {
            let operands = values::operands(self.view, key, 3)?;
            // The KDB chain starts with the last operand.
            let Some((condition, _)) = self.value(operands[1], depth + 1)? else {
                return Ok(None);
            };
            let Some((yes, yes_width)) = self.value(operands[2], depth + 1)? else {
                return Ok(None);
            };
            let Some((no, no_width)) = self.value(operands[0], depth + 1)? else {
                return Ok(None);
            };
            return Ok(Some((
                Value::Conditional(Box::new(condition), Box::new(yes), Box::new(no)),
                yes_width.max(no_width),
            )));
        }
        let operator = match opcode {
            0x0e0023 => "add",
            0x0f0023 => "subtract",
            0x100023 => "multiply",
            0x1e0023 => "bitAnd",
            0x1f0023 => "bitOr",
            0x200023 => "bitXor",
            0x210023 => "shiftLeft",
            0x220023 => "shiftRight",
            _ => return Ok(None),
        };
        let operands = values::operands(self.view, key, 2)?;
        let Some((left, left_width)) = self.value(operands[1], depth + 1)? else {
            return Ok(None);
        };
        let Some((right, right_width)) = self.value(operands[0], depth + 1)? else {
            return Ok(None);
        };
        let width = if matches!(operator, "shiftLeft" | "shiftRight") {
            left_width
        } else {
            left_width.max(right_width)
        };
        Ok(Some((
            Value::Binary(operator, Box::new(left), Box::new(right)),
            width,
        )))
    }

    fn concat(
        &mut self,
        key: u64,
        replicated: bool,
        depth: usize,
    ) -> io::Result<Option<(Value, u64)>> {
        let mut children = values::operand_list(self.view, key + 24, None)?;
        if children.len() <= usize::from(replicated) {
            return Ok(None);
        }
        // The list starts with the last member, then the repeat count if present.
        children.rotate_left(1);
        let mut children = children.into_iter();
        let count = if replicated {
            let multiplier = children.next().unwrap();
            let Some(count) = self
                .session
                .port_index(self.caller, self.view, self.unit, multiplier)
                .filter(|count| (0..=MAX_PORT_WIDTH as i64).contains(count))
            else {
                return Ok(None);
            };
            count as u64
        } else {
            1
        };
        let mut parts = Vec::new();
        let mut width = 0;
        if count == 0 {
            return Ok(Some((Value::Concat(parts), 0)));
        }
        for child in children {
            let Some((part, size)) = self.value(child, depth + 1)? else {
                return Ok(None);
            };
            if size == 0 {
                continue;
            }
            width += size;
            if width * count > MAX_PORT_WIDTH {
                return Ok(None);
            }
            parts.push(part);
        }
        let value = Value::Concat(parts);
        if replicated && width != 0 {
            Ok(Some((Value::Repeat(count, Box::new(value)), width * count)))
        } else {
            Ok(Some((value, width)))
        }
    }

    fn select(
        &mut self,
        base: u64,
        selection: Selection,
        depth: usize,
    ) -> io::Result<Option<(Value, u64)>> {
        let (index, part) = match selection {
            Selection::BitExpression(index) => (index, None),
            Selection::Indexed(index, width, ascending_indices) => {
                let Some(width) = self
                    .session
                    .port_index(self.caller, self.view, self.unit, width)
                    .filter(|width| (1..=MAX_PORT_WIDTH as i64).contains(width))
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
        let Some((endpoint, owner)) =
            self.session
                .direct_actual(self.view, self.unit, self.caller, base)?
        else {
            return Ok(None);
        };
        if self
            .session
            .resolve_value(owner, &endpoint.signal)
            .ok()
            .as_ref()
            .and_then(PortShape::whole)
            .is_none()
        {
            return Ok(None);
        }
        let base = self.operand(endpoint.instance, endpoint.signal);
        let outer_index = std::mem::replace(&mut self.in_index, true);
        let index = self.value(index, depth + 1);
        self.in_index = outer_index;
        let Some((index, _)) = index? else {
            return Ok(None);
        };
        Ok(Some(match part {
            Some(part) => (
                Value::IndexedPartSelect(base, Box::new(index), part),
                part.width as u64,
            ),
            None => (Value::BitSelect(base, Box::new(index)), 1),
        }))
    }
}
