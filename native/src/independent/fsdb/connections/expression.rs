// SPDX-License-Identifier: MPL-2.0

use super::graph::{u32, Program};
use crate::independent::bytes::{invalid, Cursor, Input};
use num_bigint::BigInt;
use num_traits::ToPrimitive;
use std::{
    collections::{BTreeSet, HashMap},
    io, str,
};

const BITS: &[u8; 4] = b"01zx";
const MAX_WIDTH: usize = 1 << 20;

pub(super) fn constants(bytes: &[u8]) -> io::Result<Vec<Vec<u8>>> {
    let mut input = Cursor::new(bytes);
    let count = u32(&mut input)? as usize;
    if count > 1_000_000 || count * 12 + 4 > input.remaining().len() {
        return Err(invalid("FSDB constant pool count exceeds bounds"));
    }
    let vector = (0..count)
        .map(|_| u32(&mut input))
        .collect::<io::Result<Vec<_>>>()?;
    let scalar = (0..count)
        .map(|_| u32(&mut input))
        .collect::<io::Result<Vec<_>>>()?;
    let length = u32(&mut input)? as usize;
    let payload = input.take(length)?.to_vec();
    let mut values = Vec::with_capacity(count);
    let mut segments = Vec::with_capacity(count);
    for (vector, scalar) in vector.into_iter().zip(scalar) {
        let width = u32(&mut input)? as usize;
        if !(1..=MAX_WIDTH).contains(&width) || (vector == u32::MAX) == (scalar == u32::MAX) {
            return Err(invalid("Invalid FSDB constant storage descriptor"));
        }
        if vector != u32::MAX {
            let length = width.div_ceil(32) * 8;
            let start = vector as usize;
            let lanes = payload
                .get(start..start + length)
                .ok_or_else(|| invalid("FSDB vector exceeds constant pool"))?;
            let value = (0..width)
                .rev()
                .map(|bit| {
                    let lane = bit / 32 * 8 + bit % 32 / 8;
                    BITS[(((lanes[lane] >> (bit % 8) & 1) << 1)
                        | (lanes[lane + 4] >> (bit % 8) & 1)) as usize]
                })
                .collect();
            values.push(value);
            segments.push((start, start + length));
        } else {
            let start = scalar as usize;
            let raw = payload
                .get(start..start + 4)
                .filter(|_| width == 1)
                .ok_or_else(|| invalid("FSDB scalar exceeds constant pool"))?;
            let bits = b"01xz"
                .get(raw[0] as usize)
                .ok_or_else(|| invalid("Invalid FSDB scalar constant"))?;
            values.push(vec![*bits]);
            segments.push((start, start + 4));
        }
    }
    segments.sort_unstable();
    if !input.remaining().is_empty()
        || !segments.is_empty()
            && (segments[0].0 != 0
                || segments[count - 1].1 != payload.len()
                || segments.windows(2).any(|pair| pair[0].1 != pair[1].0))
    {
        return Err(invalid("FSDB constant pool layout mismatch"));
    }
    Ok(values)
}

enum Node {
    Argument(usize),
    Literal(Vec<u8>),
    Concat(usize, Vec<Node>),
    Operator(u16, Vec<Node>),
}

impl Node {
    fn parse(
        input: &mut Cursor<'_>,
        pool: &[Vec<u8>],
        depth: usize,
        budget: &mut usize,
    ) -> io::Result<Self> {
        if depth > 256 || *budget == 0 {
            return Err(invalid("FSDB expression exceeds depth or node budget"));
        }
        *budget -= 1;
        let opcode = input.byte()?;
        let (operation, count) = match opcode {
            0..=3 => return Ok(Self::Literal(vec![BITS[opcode as usize]])),
            0xc0..=0xff => {
                let mut slot = usize::from(opcode - 0xc0);
                if opcode >= 0xe0 {
                    let descriptor = input.byte()?;
                    if descriptor < 0x81 {
                        return Err(invalid("Invalid FSDB extended argument number"));
                    }
                    slot += usize::from(descriptor - 0x81) * 32;
                }
                return Ok(Self::Argument(slot));
            }
            0xb2 => {
                let index = aligned(input)? as usize;
                return Ok(Self::Literal(
                    pool.get(index)
                        .cloned()
                        .ok_or_else(|| invalid("FSDB literal index exceeds pool"))?,
                ));
            }
            0x81 | 0x82 | 0x94 | 0x95 | 0xb9 => (u16::from(opcode), 1),
            0x83..=0x86 | 0x8a | 0x9b | 0x9c => (u16::from(opcode), 2),
            0x93 => (u16::from(opcode), 3),
            0xbf => match input.byte()? {
                0x82 => {
                    let repeat = aligned(input)? as usize;
                    let count = aligned(input)? as usize;
                    if !(1..=65536).contains(&count) || !(1..=65536).contains(&repeat) {
                        return Err(invalid("FSDB concatenation exceeds bounds"));
                    }
                    let children = (0..count)
                        .map(|_| Self::parse(input, pool, depth + 1, budget))
                        .collect::<io::Result<_>>()?;
                    return Ok(Self::Concat(repeat, children));
                }
                0x85 => (0xbf85, 2),
                0x86 => (0xbf86, 3),
                0x9b => (0xbf9b, 2),
                code => {
                    return Err(invalid(format!(
                        "Unrecognized FSDB extended operator {code:#x}"
                    )))
                }
            },
            code => {
                return Err(invalid(format!(
                    "Unrecognized FSDB expression operator {code:#x}"
                )))
            }
        };
        let children = (0..count)
            .map(|_| Self::parse(input, pool, depth + 1, budget))
            .collect::<io::Result<_>>()?;
        Ok(Self::Operator(operation, children))
    }

    fn tokens(&self, lvalue: bool, output: &mut BTreeSet<usize>) {
        match self {
            Self::Argument(token) if !lvalue => {
                output.insert(*token);
            }
            Self::Concat(_, children) => {
                for child in children {
                    child.tokens(lvalue, output);
                }
            }
            Self::Operator(op, children) => {
                for (index, child) in children.iter().enumerate() {
                    let inherited = match *op {
                        0xbf9b => index == 0,
                        0xbf85 | 0xbf86 => lvalue && index == 0,
                        0x94 | 0x95 => lvalue,
                        _ => false,
                    };
                    child.tokens(inherited, output);
                }
            }
            _ => {}
        }
    }

    fn evaluate(&self, args: &Arguments<'_>, width: usize) -> io::Result<Vec<u8>> {
        let value = match self {
            Self::Argument(token) => args
                .map
                .get(token)
                .and_then(|&slot| args.values.get(slot))
                .map(|value| value.to_vec())
                .ok_or_else(|| invalid("FSDB expression references a missing argument"))?,
            Self::Literal(value) => value.clone(),
            Self::Concat(repeat, children) => {
                let mut value = Vec::new();
                for child in children {
                    let bits = child.evaluate(args, width)?;
                    if value.len() + bits.len() > MAX_WIDTH / repeat {
                        return Err(invalid("FSDB expression concatenation exceeds budget"));
                    }
                    value.extend(bits);
                }
                value.repeat(*repeat)
            }
            Self::Operator(op, children) => {
                let first = children[0].evaluate(args, width)?;
                match *op {
                    0x94 | 0x95 => first,
                    0x81 => first
                        .into_iter()
                        .map(|bit| if bit == b'z' { b'x' } else { bit })
                        .collect(),
                    0x82 => invert(first),
                    0xb9 => vec![parity(&first)],
                    0x93 if args.scalar => conditional(
                        &first,
                        children[1].evaluate(args, width)?,
                        children[2].evaluate(args, width)?,
                        width,
                    ),
                    0x8a if args.scalar => {
                        let a = truth(&first);
                        let b = truth(&children[1].evaluate(args, width)?);
                        vec![if a == b'x' || b == b'x' {
                            b'x'
                        } else {
                            bool_bit(a == b)
                        }]
                    }
                    0x8a | 0x93 => first,
                    0xbf85 | 0xbf86 => {
                        let index = index(&children[1], args, width)?;
                        if *op == 0xbf85 {
                            vec![index.map_or(b'x', |index| bit(&first, index))]
                        } else {
                            match (index, self::index(&children[2], args, width)?) {
                                (Some(index), Some(delta)) => range(index, delta)?
                                    .into_iter()
                                    .map(|index| bit(&first, index))
                                    .collect(),
                                _ => vec![b'x'; width],
                            }
                        }
                    }
                    0xbf9b => return Err(invalid("FSDB partial assignment used as expression")),
                    _ => {
                        let second = children[1].evaluate(args, width)?;
                        let width = first.len().max(second.len());
                        match *op {
                            0x83 => bitwise("AND", first, second, width),
                            0x84 => bitwise("OR", first, second, width),
                            0x85 => bitwise("XOR", first, second, width),
                            0x86 if args.scalar => bitwise("XNOR", first, second, width),
                            0x9b => arithmetic("ADD", &first, &second, width)?,
                            0x9c => arithmetic("SUBTRACT", &first, &second, width)?,
                            _ => return Err(invalid("Unsupported FSDB vector operator")),
                        }
                    }
                }
            }
        };
        Ok(value)
    }

    fn destinations(&self, args: &Arguments<'_>, width: usize) -> io::Result<Vec<usize>> {
        match self {
            Self::Argument(0) => Ok((0..width).rev().collect()),
            Self::Concat(repeat, children) => {
                let mut dest = Vec::new();
                for child in children {
                    let indexes = child.destinations(args, width)?;
                    if dest.len() + indexes.len() > width / repeat {
                        return Err(invalid("FSDB partial assignment exceeds destination width"));
                    }
                    dest.extend(indexes);
                }
                Ok(dest.repeat(*repeat))
            }
            Self::Operator(op @ (0xbf85 | 0xbf86), children) => {
                let base = children[0].destinations(args, width)?;
                let first = index(&children[1], args, width)?
                    .ok_or_else(|| invalid("Unknown FSDB assignment index"))?;
                let delta = if *op == 0xbf85 {
                    0
                } else {
                    index(&children[2], args, width)?
                        .ok_or_else(|| invalid("Unknown FSDB assignment range"))?
                };
                range(first, delta)?
                    .into_iter()
                    .map(|index| {
                        usize::try_from(index)
                            .ok()
                            .filter(|&index| index < base.len())
                            .map(|index| base[base.len() - 1 - index])
                            .ok_or_else(|| invalid("FSDB assignment index exceeds destination"))
                    })
                    .collect()
            }
            _ => Err(invalid("Unsupported FSDB partial assignment target")),
        }
    }
}

struct Arguments<'a> {
    map: &'a HashMap<usize, usize>,
    values: &'a [&'a [u8]],
    scalar: bool,
}

fn aligned(input: &mut Cursor<'_>) -> io::Result<u32> {
    let padding = (4 - input.pos % 4) % 4;
    if input.take(padding)?.iter().any(|&byte| byte != 0) {
        return Err(invalid("FSDB aligned integer padding is nonzero"));
    }
    u32(input)
}

fn index(node: &Node, args: &Arguments<'_>, width: usize) -> io::Result<Option<i64>> {
    Ok(integer_index(&node.evaluate(args, width)?))
}

fn integer_index(bits: &[u8]) -> Option<i64> {
    numeric(bits, bits.len() == 32).and_then(|value| value.to_i64())
}

fn range(start: i64, delta: i64) -> io::Result<Vec<i64>> {
    if delta.unsigned_abs() >= 65536 || start.checked_add(delta).is_none() {
        return Err(invalid("FSDB part select exceeds bounds"));
    }
    let step = if delta < 0 { -1 } else { 1 };
    Ok((0..=delta.abs()).map(|i| start + step * i).collect())
}

fn bit(bits: &[u8], index: i64) -> u8 {
    usize::try_from(index)
        .ok()
        .filter(|&index| index < bits.len())
        .map_or(b'x', |index| bits[bits.len() - 1 - index])
}

fn fit(mut bits: Vec<u8>, width: usize, fill: u8) -> Vec<u8> {
    if bits.len() >= width {
        bits.drain(..bits.len() - width);
        bits
    } else {
        let mut result = vec![fill; width - bits.len()];
        result.extend(bits);
        result
    }
}

fn truth(bits: &[u8]) -> u8 {
    if bits.contains(&b'1') {
        b'1'
    } else if unknown(bits) {
        b'x'
    } else {
        b'0'
    }
}

fn bool_bit(value: bool) -> u8 {
    if value {
        b'1'
    } else {
        b'0'
    }
}

fn unknown(bits: &[u8]) -> bool {
    bits.iter().any(|&bit| !matches!(bit, b'0' | b'1'))
}

fn parity(bits: &[u8]) -> u8 {
    if unknown(bits) {
        b'x'
    } else {
        bool_bit(bits.iter().filter(|&&bit| bit == b'1').count() % 2 == 1)
    }
}

fn invert(mut bits: Vec<u8>) -> Vec<u8> {
    for bit in &mut bits {
        *bit = match *bit {
            b'0' => b'1',
            b'1' => b'0',
            _ => b'x',
        };
    }
    bits
}

fn conditional(condition: &[u8], positive: Vec<u8>, negative: Vec<u8>, width: usize) -> Vec<u8> {
    match truth(condition) {
        b'1' => positive,
        b'0' => negative,
        _ => {
            let width = width.max(positive.len()).max(negative.len());
            fit(positive, width, b'0')
                .into_iter()
                .zip(fit(negative, width, b'0'))
                .map(|(a, b)| if a == b { a } else { b'x' })
                .collect()
        }
    }
}

fn bitwise(op: &str, a: Vec<u8>, b: Vec<u8>, width: usize) -> Vec<u8> {
    fit(a, width, b'0')
        .into_iter()
        .zip(fit(b, width, b'0'))
        .map(|(a, b)| match op {
            "AND" if a == b'0' || b == b'0' => b'0',
            "OR" if a == b'1' || b == b'1' => b'1',
            _ if !matches!(a, b'0' | b'1') || !matches!(b, b'0' | b'1') => b'x',
            "AND" => b'1',
            "OR" => b'0',
            "XOR" => bool_bit(a != b),
            _ => bool_bit(a == b),
        })
        .collect()
}

fn numeric(bits: &[u8], signed: bool) -> Option<BigInt> {
    let number = BigInt::parse_bytes(bits, 2)?;
    if signed && bits.first() == Some(&b'1') {
        Some(number - (BigInt::from(1) << bits.len()))
    } else {
        Some(number)
    }
}

fn encode(number: BigInt, width: usize) -> Vec<u8> {
    let mask = (BigInt::from(1) << width) - BigInt::from(1);
    let wrapped: BigInt = number & mask;
    fit(wrapped.to_str_radix(2).into_bytes(), width, b'0')
}

fn arithmetic(op: &str, a: &[u8], b: &[u8], width: usize) -> io::Result<Vec<u8>> {
    let signed = op == "SMULTIPLY";
    match (numeric(a, signed), numeric(b, signed)) {
        (Some(a), Some(b)) => Ok(encode(
            match op {
                "ADD" => a + b,
                "SUBTRACT" => a - b,
                "SMULTIPLY" => a * b,
                _ => return Err(invalid("Unknown FSDB arithmetic operator")),
            },
            width,
        )),
        _ => Ok(vec![b'x'; width]),
    }
}

pub(super) struct Expression {
    body: Body,
}

enum Body {
    Binary {
        node: Node,
        slots: HashMap<usize, usize>,
    },
    Text(Text),
}

impl Expression {
    pub(super) fn parse(program: &Program, constants: &[Vec<u8>]) -> io::Result<Self> {
        if program.text {
            return Ok(Self {
                body: Body::Text(Text::parse(&program.code, program.arguments)?),
            });
        }
        let mut input = Cursor::new(&program.code);
        let node = Node::parse(&mut input, constants, 0, &mut 100_000)?;
        if !input.remaining().is_empty() {
            return Err(invalid("Unexpected bytes after FSDB expression"));
        }
        let mut tokens = BTreeSet::new();
        node.tokens(false, &mut tokens);
        let slots = if tokens.iter().all(|&token| token < program.arguments) {
            tokens.into_iter().map(|token| (token, token)).collect()
        } else if tokens.len() == program.arguments {
            tokens
                .into_iter()
                .enumerate()
                .map(|(slot, token)| (token, slot))
                .collect()
        } else {
            return Err(invalid("FSDB expression slots do not match graph arity"));
        };
        Ok(Self {
            body: Body::Binary { node, slots },
        })
    }

    fn assignment_node(node: &Node) -> Option<&[Node]> {
        let mut node = node;
        loop {
            match node {
                Node::Operator(0x95 | 0x94, children) => node = &children[0],
                Node::Operator(0xbf9b, children) => return Some(children),
                _ => return None,
            }
        }
    }

    pub(super) fn partial(&self) -> bool {
        match &self.body {
            Body::Text(text) => text.destination.is_some(),
            Body::Binary { node, .. } => Self::assignment_node(node).is_some(),
        }
    }

    pub(super) fn assign(
        &self,
        values: &[&[u8]],
        width: usize,
        scalar: bool,
    ) -> io::Result<Vec<(usize, u8)>> {
        let (dest, bits) = match &self.body {
            Body::Text(text) => {
                let dest: Vec<_> = match text.destination {
                    Some((index, delta)) => range(index, delta)?
                        .into_iter()
                        .map(|index| {
                            usize::try_from(index)
                                .ok()
                                .filter(|&index| index < width)
                                .ok_or_else(|| invalid("FSDB text assignment exceeds destination"))
                        })
                        .collect::<io::Result<_>>()?,
                    None => (0..width).rev().collect(),
                };
                let bits = text.evaluate(values, dest.len())?;
                (dest, bits)
            }
            Body::Binary { node, slots } => {
                let args = Arguments {
                    map: slots,
                    values,
                    scalar,
                };
                if let Some(assignment) = Self::assignment_node(node) {
                    let dest = assignment[0].destinations(&args, width)?;
                    if dest.is_empty() || BTreeSet::from_iter(dest.iter()).len() != dest.len() {
                        return Err(invalid(
                            "FSDB partial assignment repeats or omits the destination",
                        ));
                    }
                    let bits = fit(assignment[1].evaluate(&args, dest.len())?, dest.len(), b'0');
                    (dest, bits)
                } else {
                    let bits = fit(node.evaluate(&args, width)?, width, b'0');
                    ((0..width).rev().collect(), bits)
                }
            }
        };
        Ok(dest.into_iter().zip(bits).collect())
    }
}

type TextHeader<'a> = (u32, Option<(i64, i64)>, &'a str);

pub(super) fn text_header(bytes: &[u8]) -> io::Result<TextHeader<'_>> {
    let text = str::from_utf8(bytes).map_err(|_| invalid("Invalid FSDB text expression"))?;
    if !text.is_ascii() {
        return Err(invalid("Non-ASCII FSDB text expression"));
    }
    let (destination, text) = if let Some(text) = text.strip_prefix("Out[") {
        let (selection, remaining) = text
            .split_once("] = ")
            .ok_or_else(|| invalid("Invalid FSDB text assignment prefix"))?;
        let (start, delta) = selection.split_once(":+").unwrap_or((selection, "0"));
        let start = start
            .parse::<u32>()
            .map_err(|_| invalid("Invalid FSDB text assignment index"))?;
        let delta = delta
            .parse::<i64>()
            .map_err(|_| invalid("Invalid FSDB text assignment width"))?;
        (Some((i64::from(start), delta)), remaining)
    } else {
        (None, text)
    };
    let text = text
        .strip_prefix("bcid ")
        .ok_or_else(|| invalid("Invalid FSDB text graph header"))?;
    let (id, tail) = text
        .split_once(' ')
        .ok_or_else(|| invalid("Missing FSDB text graph ID"))?;
    let id = id
        .parse()
        .map_err(|_| invalid("Invalid FSDB text graph ID"))?;
    let (number, body) = tail
        .split_once(char::is_whitespace)
        .ok_or_else(|| invalid("Missing FSDB text expression body"))?;
    number
        .parse::<u32>()
        .map_err(|_| invalid("Invalid FSDB text expression header field"))?;
    Ok((id, destination, body))
}

struct Text {
    destination: Option<(i64, i64)>,
    instructions: Vec<(String, Vec<i64>)>,
}

impl Text {
    fn parse(bytes: &[u8], arguments: usize) -> io::Result<Self> {
        let (_, destination, body) = text_header(bytes)?;
        let mut instructions = Vec::new();
        for token in body.split_ascii_whitespace() {
            let mut fields = token.split(',');
            let name = fields.next().unwrap();
            let operands = fields
                .map(|field| {
                    field
                        .parse::<i64>()
                        .map_err(|_| invalid("Invalid FSDB text operand"))
                })
                .collect::<io::Result<Vec<_>>>()?;
            let valid = match name {
                "WIDTH" => matches!(operands.as_slice(), [1..=65536]),
                "CALL_ARG_VAL" => {
                    matches!(operands.as_slice(), [arg, 0] if *arg >= 2 && (*arg - 2) < arguments as i64)
                }
                "OPT_CONST" | "CONCATENATE" => operands.len() == 1,
                "OPT_CONST_4ST" => operands.len() == 2,
                "CONST" => operands.len() >= 2,
                "MULTI_CONCATENATE" => operands.len() == 2,
                "SLICE" => operands == [1],
                "MITECONDNOINSTR" => operands == [4],
                "M_EQU" | "M_NEQU" | "EQU" | "M_LT" | "M_GT" | "M_LE" | "M_GE" | "SM_GT"
                | "SHIFT_L" | "SHIFT_R" | "SASHIFT_R" | "ADD" | "SUBTRACT" | "SMULTIPLY"
                | "RET" | "AND" | "OR" | "LOGAND" | "LOGOR" | "XOR" | "XNOR" | "NOT"
                | "XOR_REDUCE" | "PAD" | "FOURTOTWOSTATE" => operands.is_empty(),
                _ => false,
            };
            if !valid || instructions.len() >= 100_000 {
                return Err(invalid(format!(
                    "Invalid or unsupported FSDB text operation {name}"
                )));
            }
            instructions.push((name.to_owned(), operands));
        }
        if instructions.last().is_none_or(|(name, _)| name != "RET") {
            return Err(invalid("Missing FSDB text return"));
        }
        Ok(Self {
            destination,
            instructions,
        })
    }

    fn evaluate(&self, args: &[&[u8]], result_width: usize) -> io::Result<Vec<u8>> {
        let mut stack = Vec::<Vec<u8>>::new();
        let mut width = 0;
        let mut live_bytes = 0;
        for (code, args_for_op) in &self.instructions {
            let op = code.as_str();
            if op == "WIDTH" {
                width = args_for_op[0] as usize;
                continue;
            }
            if width == 0 {
                return Err(invalid("Missing FSDB expression width"));
            }
            let mut pop = || {
                let value = stack
                    .pop()
                    .ok_or_else(|| invalid("FSDB expression stack underflow"))?;
                live_bytes -= value.len();
                Ok::<_, io::Error>(value)
            };
            let value = match op {
                "CALL_ARG_VAL" => fit(args[args_for_op[0] as usize - 2].to_vec(), width, b'0'),
                "OPT_CONST" => encode(BigInt::from(args_for_op[0]), width),
                "OPT_CONST_4ST" => literal_words(args_for_op, width)?,
                "CONST" => literal(args_for_op, width)?,
                "FOURTOTWOSTATE" => fit(pop()?, width, b'0')
                    .into_iter()
                    .map(|bit| if bit == b'1' { b'1' } else { b'0' })
                    .collect(),
                "NOT" => invert(fit(pop()?, width, b'0')),
                "XOR_REDUCE" => vec![parity(&pop()?)],
                "PAD" => fit(pop()?, width, b'0'),
                "CONCATENATE" | "MULTI_CONCATENATE" => {
                    let count = args_for_op[0];
                    let repeat = args_for_op.get(1).copied().unwrap_or(1);
                    if count <= 0 || count as usize > stack.len() || !(1..=65536).contains(&repeat)
                    {
                        return Err(invalid("FSDB text concatenation arguments out of bounds"));
                    }
                    let start = stack.len() - count as usize;
                    let bits = stack.split_off(start).concat();
                    live_bytes -= bits.len();
                    if bits.len() > 65536 / repeat as usize {
                        return Err(invalid("FSDB text concatenation exceeds budget"));
                    }
                    bits.repeat(repeat as usize)
                }
                "MITECONDNOINSTR" => {
                    let negative = pop()?;
                    let positive = pop()?;
                    let condition = pop()?;
                    fit(
                        conditional(&condition, positive, negative, width),
                        width,
                        b'0',
                    )
                }
                "RET" => {
                    if stack.len() != 1 {
                        return Err(invalid("FSDB return stack mismatch"));
                    }
                    return Ok(fit(stack.pop().unwrap(), result_width, b'0'));
                }
                _ => {
                    let b = pop()?;
                    let a = pop()?;
                    match op {
                        "AND" | "OR" | "XOR" | "XNOR" => bitwise(op, a, b, width),
                        "LOGAND" | "LOGOR" => {
                            let (a, b) = (truth(&a), truth(&b));
                            vec![match op {
                                "LOGAND" if a == b'0' || b == b'0' => b'0',
                                "LOGOR" if a == b'1' || b == b'1' => b'1',
                                _ if a == b'x' || b == b'x' => b'x',
                                "LOGAND" => b'1',
                                _ => b'0',
                            }]
                        }
                        "ADD" | "SUBTRACT" | "SMULTIPLY" => arithmetic(op, &a, &b, width)?,
                        "SHIFT_L" | "SHIFT_R" | "SASHIFT_R" => shift(op, a, &b, width),
                        "SLICE" => match integer_index(&b) {
                            Some(index) => (0..width as i64)
                                .rev()
                                .map(|offset| bit(&a, index.saturating_add(offset)))
                                .collect(),
                            None => vec![b'x'; width],
                        },
                        _ => vec![compare(op, a, b)],
                    }
                }
            };
            live_bytes += value.len();
            if stack.len() >= 65536 || live_bytes > 64 * 1024 * 1024 {
                return Err(invalid("FSDB expression stack exceeds bounds"));
            }
            stack.push(value);
        }
        Err(invalid("Missing FSDB expression result"))
    }
}

#[cfg(test)]
mod text_tests {
    use super::Text;

    #[test]
    fn logical_operators_use_four_state_truth_of_each_operand() {
        let and = Text::parse(
            b"bcid 0 0 WIDTH,2 CALL_ARG_VAL,2,0 CALL_ARG_VAL,3,0 WIDTH,1 LOGAND RET",
            2,
        )
        .unwrap();
        let or = Text::parse(
            b"bcid 0 0 WIDTH,2 CALL_ARG_VAL,2,0 CALL_ARG_VAL,3,0 WIDTH,1 LOGOR RET",
            2,
        )
        .unwrap();
        assert_eq!(and.evaluate(&[b"00", b"xz"], 1).unwrap(), b"0");
        assert_eq!(and.evaluate(&[b"10", b"xz"], 1).unwrap(), b"x");
        assert_eq!(and.evaluate(&[b"10", b"1z"], 1).unwrap(), b"1");
        assert_eq!(or.evaluate(&[b"00", b"xz"], 1).unwrap(), b"x");
        assert_eq!(or.evaluate(&[b"10", b"xz"], 1).unwrap(), b"1");
    }
}

fn literal(fields: &[i64], width: usize) -> io::Result<Vec<u8>> {
    if fields[1] != 0 || fields[0] != fields.len() as i64 - 2 || fields.len() % 2 != 0 {
        return Err(invalid("Invalid FSDB text constant layout"));
    }
    literal_words(&fields[2..], width)
}

fn literal_words(words: &[i64], width: usize) -> io::Result<Vec<u8>> {
    if words
        .iter()
        .any(|&word| !(i64::from(i32::MIN)..=i64::from(u32::MAX)).contains(&word))
    {
        return Err(invalid("Invalid FSDB text constant word"));
    }
    Ok((0..width)
        .rev()
        .map(|bit| {
            let shift = bit % 32;
            let back = bit / 32 * 2;
            if back >= words.len() {
                return b'0';
            }
            let value = words[words.len() - back - 1] as u32;
            let mask = words[words.len() - back - 2] as u32;
            BITS[(((mask >> shift & 1) << 1) | (value >> shift & 1)) as usize]
        })
        .collect())
}

fn shift(op: &str, a: Vec<u8>, b: &[u8], width: usize) -> Vec<u8> {
    let fill = if op == "SASHIFT_R" {
        a.first().copied().unwrap_or(b'0')
    } else {
        b'0'
    };
    let Some(amount) = numeric(b, false) else {
        return vec![b'x'; width];
    };
    let amount = amount.to_usize().unwrap_or(width).min(width);
    let mut bits = fit(a, width, fill);
    if op == "SHIFT_L" {
        bits.rotate_left(amount);
        bits[width - amount..].fill(b'0');
    } else {
        bits.rotate_right(amount);
        bits[..amount].fill(fill);
    }
    bits
}

fn compare(op: &str, a: Vec<u8>, b: Vec<u8>) -> u8 {
    let signed = op == "SM_GT";
    let width = a.len().max(b.len());
    let fill_a = if signed { a[0] } else { b'0' };
    let fill_b = if signed { b[0] } else { b'0' };
    let a = fit(a, width, fill_a);
    let b = fit(b, width, fill_b);
    if op == "EQU" {
        return bool_bit(a == b);
    }
    let unknown = unknown(&a) || unknown(&b);
    if matches!(op, "M_EQU" | "M_NEQU") {
        let mismatch = a
            .iter()
            .zip(&b)
            .any(|(&a, &b)| a != b && matches!(a, b'0' | b'1') && matches!(b, b'0' | b'1'));
        if mismatch {
            return bool_bit(op == "M_NEQU");
        }
        return if unknown {
            b'x'
        } else {
            bool_bit(op == "M_EQU")
        };
    }
    if unknown {
        return b'x';
    }
    if signed && a[0] != b[0] {
        return bool_bit(a[0] == b'0');
    }
    bool_bit(match op {
        "M_LT" => a < b,
        "M_LE" => a <= b,
        "M_GE" => a >= b,
        _ => a > b,
    })
}
