// SPDX-License-Identifier: MPL-2.0

use super::{
    bounds, cast_width, definition, enum_signed, expression_tag, functions, integer, invalid,
    lexical, operand_list, operands, packed_type, width, Environment, ParameterValue, View,
    TYPE_HEADER_MASK,
};
use num_bigint::BigUint;
use num_traits::{One, ToPrimitive};
use std::io;

#[derive(Clone, Copy)]
pub(super) struct Field {
    pub key: u64,
    pub width: usize,
    pub offset: usize,
    pub signed: bool,
}

impl Field {
    pub(super) fn read(self, value: &BigUint) -> (i64, bool) {
        let bits = ((value >> self.offset) & self.mask()).to_u32().unwrap_or(0);
        (
            cast_width(i64::from(bits), self.signed, self.width),
            self.signed,
        )
    }

    pub(super) fn write(self, packed: &mut BigUint, value: i64) {
        let mask = self.mask();
        *packed -= ((&*packed >> self.offset) & &mask) << self.offset;
        *packed |= (BigUint::from(value as u32) & mask) << self.offset;
    }

    fn mask(self) -> BigUint {
        (BigUint::one() << self.width) - BigUint::one()
    }
}

pub(super) fn fields(view: &View, ty: u64, env: &mut Environment) -> io::Result<Vec<Field>> {
    layout(view, ty, env, true)
}

pub(super) fn layout(
    view: &View, ty: u64, env: &mut Environment, integers_only: bool,
) -> io::Result<Vec<Field>> {
    if view.uint(ty, 4)? & TYPE_HEADER_MASK != 0x20000048 {
        return Err(invalid("KDB aggregate type is not a packed structure"));
    }
    let mut members = lexical::chain(view, view.pointer(ty + 48)?)?;
    if members.is_empty() || members.len() > 128 {
        return Err(invalid("KDB structure field count exceeds bounds"));
    }
    members.rotate_left(1);
    let mut offset = 0;
    let mut fields = Vec::with_capacity(members.len());
    for key in members.into_iter().rev() {
        let header = view.uint(key, 4)?;
        if header & 255 != 73 || view.pointer(key + 40)? != Some(ty) {
            return Err(invalid("Invalid KDB structure field owner"));
        }
        let (size, signed) = match header >> 16 & 255 {
            3 | 12 => (32, header & 0x20000000 == 0),
            7 | 8 => {
                let size = if header & 0x02000000 == 0 {
                    1
                } else {
                    width(&[bounds(view, view.pointer_required(key + 48)?, env)?])?
                };
                (size, header & 0x40000000 != 0)
            }
            15 => {
                let ty = view.pointer_required(key + 48)?;
                let (kind, size, shape) = packed_type(view, ty, 0, env)?;
                let signed = if kind == "enum" {
                    let (target, key, _) = definition(view, ty, env.unit, env)?;
                    enum_signed(&target, key)?
                } else if !integers_only || kind.is_empty() && !shape.is_empty() {
                    false
                } else {
                    return Err(invalid("Unsupported KDB integer structure field type"));
                };
                (size * width(&shape)?, signed)
            }
            _ => return Err(invalid("Unsupported KDB integer structure field type")),
        };
        if !(1..=if integers_only { 32 } else { 4096 }).contains(&size) {
            return Err(invalid("KDB integer structure field width exceeds bounds"));
        }
        fields.push(Field {
            key,
            width: size,
            offset,
            signed,
        });
        offset += size;
    }
    fields.reverse();
    Ok(fields)
}

fn pattern(view: &View, key: u64) -> io::Result<Vec<u64>> {
    if expression_tag(view, key)? != 0x9b0123 {
        return Err(invalid("Invalid KDB structure assignment pattern"));
    }
    let mut args = operand_list(view, key + 24, None)?;
    if args.is_empty() {
        return Err(invalid("Empty KDB structure assignment pattern"));
    }
    args.rotate_left(1);
    Ok(args)
}

pub(super) fn field(
    view: &View,
    mut key: u64,
    tag: u64,
    depth: usize,
    env: &mut Environment,
) -> io::Result<Option<(i64, bool)>> {
    if matches!(tag, 0x2403013c | 0x3403013c) {
        let term = view.pointer_required(key + 40)?;
        if view.uint(term, 4)? != 0x2011013c || view.pointer(term + 32)? != Some(key) {
            return Ok(None);
        }
        key = term;
    } else if !matches!(tag, 0x0011013c | 0x1011013c) {
        return Ok(None);
    }
    let Some(member) = view.pointer(key + 40)? else {
        return Ok(None);
    };
    if view.uint(member, 4)? != 0x2004013c || view.pointer(member + 32)? != Some(key) {
        return Ok(None);
    }
    let unit = (view.uint(key + 16, 8)? >> 48) as u32;
    let unit = if unit == 0 { env.unit } else { unit };
    let source = env.objects.view(unit)?;
    let declaration = view
        .pointer_into(key + 48, &source)?
        .ok_or_else(|| invalid("Missing KDB structure parameter declaration"))?;
    let header = source.uint(declaration, 4)? & TYPE_HEADER_MASK;
    if !matches!(header, 0x010f003a | 0x020f003a | 0x410f003a)
        || source.string(source.pointer_required(declaration + 32)?)?
            != view.string(view.pointer_required(key + 24)?)?
    {
        return Err(invalid("Invalid KDB structure parameter declaration"));
    }
    let array = header == 0x020f003a;
    let index = if array {
        let reference = view.pointer_required(key + 56)?;
        let tag = expression_tag(view, reference)?;
        if tag == 0x240123 {
            let args = operands(view, reference, 2)?;
            if args[1] != key {
                return Err(invalid("KDB structure array index reference differs"));
            }
            Some(integer(view, args[0], depth + 1, env)?.0)
        } else if tag & 0xffff == 0x124
            && view.pointer(reference + 8)? == Some(key)
            && view.pointer(reference + 16)? == Some(key)
        {
            Some(i64::from(view.uint(reference + 2, 2)? as i16))
        } else {
            return Err(invalid("Unsupported KDB structure array index"));
        }
    } else {
        None
    };
    let previous = std::mem::replace(&mut env.unit, unit);
    let result = (|| {
        let type_key = source.pointer_required(declaration + if array { 64 } else { 56 })?;
        let (type_view, type_key, type_unit) = definition(&source, type_key, unit, env)?;
        env.unit = type_unit;
        let layout = fields(&type_view, type_key, env)?;
        env.unit = unit;
        let field_key = view
            .pointer_into(member + 48, &type_view)?
            .ok_or_else(|| invalid("Missing KDB structure field declaration"))?;
        let field = layout
            .iter()
            .find(|field| field.key == field_key)
            .ok_or_else(|| invalid("Unknown KDB structure field declaration"))?;
        let name = view.string(view.pointer_required(member + 24)?)?;
        if type_view.string(type_view.pointer_required(field_key + 32)?)? != name {
            return Err(invalid("KDB structure field names differ"));
        }
        let aggregate_name = source.string(source.pointer_required(declaration + 32)?)?;
        if let Some(entry) = env.entry(&source, declaration, aggregate_name)? {
            let ParameterValue::Text(bits) = entry.value else {
                return Err(invalid("Invalid KDB structure parameter storage"));
            };
            let size = layout.iter().map(|field| field.width).sum::<usize>();
            if entry.flags != 1
                || !matches!(entry.kind, 5 | 0x305)
                || entry.aux != 0
                || entry.trailer != 0
                || bits.len() != size
                || !bits.is_ascii()
                || array
            {
                return Err(invalid("Invalid KDB structure parameter value"));
            }
            let end = size - field.offset;
            let value = i64::from_str_radix(&bits[end - field.width..end], 2)
                .map_err(|_| invalid("Unknown bits in KDB structure field"))?;
            return Ok(Some((
                cast_width(value, field.signed, field.width),
                field.signed,
            )));
        }
        let mut initializer = source.pointer_required(declaration + 48)?;
        if let Some(index) = index {
            let (left, right) = bounds(&source, source.pointer_required(declaration + 56)?, env)?;
            let initializers = pattern(&source, initializer)?;
            if !(left.min(right)..=left.max(right)).contains(&index)
                || initializers.len() as u64 != left.abs_diff(right) + 1
            {
                return Err(invalid("KDB structure array initializer exceeds bounds"));
            }
            initializer = initializers[index.abs_diff(left) as usize];
        }
        if expression_tag(&source, initializer)? == 0x2b0123 {
            let packed = functions::call_structure(
                &source,
                initializer,
                depth + 1,
                (type_unit, type_key),
                env,
            )?;
            return Ok(Some(field.read(&packed)));
        }
        let values = pattern(&source, initializer)?;
        let expr = if expression_tag(&source, values[0])? == 0x530123 {
            let mut matching = None;
            for value in values {
                if expression_tag(&source, value)? != 0x530123 {
                    return Err(invalid("Mixed KDB structure initializer entries"));
                }
                let pair = operands(&source, value, 2)?;
                if source.uint(pair[1], 4)? != 0x1004013c
                    || source.pointer(pair[1] + 32)? != Some(value)
                {
                    return Err(invalid("Invalid KDB named structure initializer"));
                }
                if source.string(source.pointer_required(pair[1] + 24)?)? == name
                    && matching.replace(pair[0]).is_some()
                {
                    return Err(invalid("Duplicate KDB structure initializer"));
                }
            }
            matching.ok_or_else(|| invalid("Missing KDB structure initializer field"))?
        } else {
            if values.len() != layout.len() {
                return Err(invalid("KDB structure initializer field count differs"));
            }
            let index = layout
                .iter()
                .position(|field| field.key == field_key)
                .unwrap();
            values[index]
        };
        let (value, _) = integer(&source, expr, depth + 1, env)?;
        Ok(Some((
            cast_width(value, field.signed, field.width),
            field.signed,
        )))
    })();
    env.unit = previous;
    result
}
