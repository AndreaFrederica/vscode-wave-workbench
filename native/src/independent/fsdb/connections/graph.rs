// SPDX-License-Identifier: MPL-2.0

use super::Vertex;
use crate::independent::bytes::{invalid, Cursor, Input};
use std::{collections::HashMap, io};

pub(super) struct Program {
    pub arguments: usize,
    pub code: Vec<u8>,
    pub text: bool,
}

pub(super) fn u32(input: &mut Cursor<'_>) -> io::Result<u32> {
    Ok(input.uint(4)? as u32)
}

pub(super) fn programs(bytes: &[u8]) -> io::Result<HashMap<u32, Program>> {
    let mut input = Cursor::new(bytes);
    let tagged = u32(&mut input)?;
    let count = tagged & 0x7fff_ffff;
    let text = u32(&mut input)?;
    if tagged >> 31 != 1 || !(1..=100_000).contains(&(u64::from(count) + u64::from(text))) {
        return Err(invalid("Invalid FSDB connection program count"));
    }
    let mut programs = HashMap::new();
    for ordinal in 0..count + text {
        let word = match input.byte()? {
            0 => 2,
            0xc0 => 4,
            _ => return Err(invalid("Unrecognized FSDB connection program descriptor")),
        };
        let arguments = input.uint(word)? as usize;
        let size = input.uint(word)? as usize;
        if arguments > 65536 || size == 0 {
            return Err(invalid("Invalid FSDB connection program length/arity"));
        }
        let key = if ordinal < count {
            ordinal
        } else {
            0x1000_0000 + ordinal - count
        };
        programs.insert(
            key,
            Program {
                arguments,
                code: input.take(size)?.to_vec(),
                text: ordinal >= count,
            },
        );
    }
    const FOOTER: &[u8] = b"\x01\x00\x00\x01\x00\xc0\x00\x01\x00\x02\x00\x95\xc0\x00\x01\x00\x02\x00\x81\xc0\x00\x01\x00\x02\x00\x82\xc0\x00\x01\x00\x02\x00\x94\xc0";
    if input.remaining() != FOOTER {
        return Err(invalid("Unrecognized FSDB built-in connection table"));
    }
    let builtins: [&[u8]; 5] = [b"\xc0", b"\x95\xc0", b"\x81\xc0", b"\x82\xc0", b"\x94\xc0"];
    for (ordinal, code) in builtins.into_iter().enumerate() {
        programs.insert(
            0x2000_0000 + ordinal as u32,
            Program {
                arguments: 1,
                code: code.to_vec(),
                text: false,
            },
        );
    }
    Ok(programs)
}

pub(super) struct Edge {
    pub operation: u32,
    pub program: u32,
    pub sources: Vec<u32>,
}

pub(super) struct Slice {
    pub source: u32,
    pub start: usize,
    pub width: usize,
}

pub(super) struct Graph {
    pub widths: Vec<usize>,
    pub attributes: Vec<u8>,
    pub edges: HashMap<u32, Vec<Edge>>,
    pub composites: HashMap<u32, Vec<Slice>>,
    pub secondary: u32,
}

impl Graph {
    pub(super) fn parse(
        bytes: &[u8],
        composite_bytes: &[u8],
        programs: &HashMap<u32, Program>,
    ) -> io::Result<Self> {
        let mut input = Cursor::new(bytes);
        let count = u32(&mut input)?;
        let secondary = u32(&mut input)?;
        if !(1..=1_000_000).contains(&count) || secondary > 1_000_000 {
            return Err(invalid("Invalid FSDB connection vertex count"));
        }
        let mut widths = Vec::with_capacity(count as usize);
        while widths.len() < count as usize {
            let descriptor = u32(&mut input)?;
            let width = (descriptor & 0x3fff_ffff) as usize;
            if width == 0 {
                return Err(invalid("Zero FSDB connection vertex width"));
            }
            match descriptor >> 30 {
                0 | 2 => widths.push(width),
                3 if width + widths.len() <= count as usize => {
                    widths.resize(widths.len() + width, 1)
                }
                _ => return Err(invalid("Invalid FSDB connection width descriptor")),
            }
        }
        let attributes = input.take(count as usize)?.to_vec();
        let edges = u32(&mut input)?;
        if edges > count {
            return Err(invalid("FSDB connection edge count exceeds vertices"));
        }
        let mut by_node = HashMap::<u32, Vec<Edge>>::new();
        for _ in 0..edges {
            let node = u32(&mut input)?;
            let operation = u32(&mut input)?;
            let mut program = operation & 0x3fff_ffff;
            if operation >> 30 == 2 {
                if program > 4 {
                    return Err(invalid("Invalid FSDB connection built-in index"));
                }
                program |= 0x2000_0000;
            }
            let descriptor = programs
                .get(&program)
                .ok_or_else(|| invalid("Unknown FSDB connection program"))?;
            if descriptor.text {
                let id = u32(&mut input)?;
                let expected = super::expression::text_header(&descriptor.code)?.0;
                // Some VCS records set bit 30 on the graph copy of the bcid.
                if id != expected && id != (expected | 0x4000_0000) {
                    return Err(invalid("FSDB text program ID does not match the graph"));
                }
            }
            let sources = (0..descriptor.arguments)
                .map(|_| u32(&mut input))
                .collect::<io::Result<Vec<_>>>()?;
            if node >= count || sources.iter().any(|&source| source >= count + secondary) {
                return Err(invalid("FSDB connection vertex reference out of bounds"));
            }
            by_node.entry(node).or_default().push(Edge {
                operation,
                program,
                sources,
            });
        }
        if !input.remaining().is_empty() {
            return Err(invalid("Unexpected bytes after FSDB connection graph"));
        }
        let composites = composites(composite_bytes, &widths)?;
        Ok(Self {
            widths,
            attributes,
            edges: by_node,
            composites,
            secondary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Graph, Program};
    use std::collections::HashMap;

    #[test]
    fn accepts_tagged_text_ids_and_rejects_different_ids() {
        let program = 0x1000_0000u32;
        let programs = HashMap::from([(
            program,
            Program {
                arguments: 1,
                code: b"bcid 526 1 WIDTH,1 CALL_ARG_VAL,2,0 RET".to_vec(),
                text: true,
            },
        )]);
        for (id, valid) in [
            (526, true),
            (0x4000_020e, true),
            (0x4000_020f, false),
            (0x8000_020e, false),
        ] {
            let mut bytes = [2u32, 0, 0xc000_0002].map(u32::to_le_bytes).concat();
            bytes.extend([0, 0]);
            for word in [1, 0, program, id, 1] {
                bytes.extend(word.to_le_bytes());
            }
            match Graph::parse(&bytes, &[], &programs) {
                Ok(graph) if valid => assert_eq!(graph.edges[&0][0].sources, [1]),
                Err(error) if !valid => {
                    assert_eq!(
                        error.to_string(),
                        "FSDB text program ID does not match the graph"
                    );
                }
                _ => panic!("Unexpected validation result for text program ID {id:#x}"),
            }
        }
    }
}

fn composites(bytes: &[u8], widths: &[usize]) -> io::Result<HashMap<u32, Vec<Slice>>> {
    let mut input = Cursor::new(bytes);
    let mut composites = HashMap::new();
    while !input.remaining().is_empty() {
        let node = u32(&mut input)?;
        let count = u32(&mut input)? as usize;
        let width = *widths
            .get(node as usize)
            .ok_or_else(|| invalid("FSDB composite destination out of bounds"))?;
        if count > 1_000_000 || count > input.remaining().len() / 4 {
            return Err(invalid("FSDB composite slice count exceeds bounds"));
        }
        let mut slices = Vec::with_capacity(count);
        let mut total = 0usize;
        for _ in 0..count {
            let tagged = u32(&mut input)?;
            let source = tagged & 0x7fff_ffff;
            let source_width = *widths
                .get(source as usize)
                .ok_or_else(|| invalid("FSDB composite source out of bounds"))?;
            let (start, width) = if tagged >> 31 == 0 {
                (0, source_width)
            } else {
                let start = u32(&mut input)?;
                let width = if start >> 31 == 0 {
                    1
                } else {
                    u32(&mut input)? as usize
                };
                ((start & 0x7fff_ffff) as usize, width)
            };
            if width == 0 || start + width > source_width {
                return Err(invalid("FSDB composite slice exceeds source width"));
            }
            total = total
                .checked_add(width)
                .ok_or_else(|| invalid("FSDB composite width overflow"))?;
            slices.push(Slice {
                source,
                start,
                width,
            });
        }
        if total != width || composites.insert(node, slices).is_some() {
            return Err(invalid(
                "FSDB composite width mismatch or duplicate destination",
            ));
        }
    }
    Ok(composites)
}

pub(super) fn models(bytes: &[u8]) -> io::Result<HashMap<u32, (u32, u32)>> {
    let mut input = Cursor::new(bytes);
    if u32(&mut input)? != 1 {
        return Err(invalid("Invalid FSDB connection model version"));
    }
    for _ in 0..2 {
        let size = u32(&mut input)? as usize;
        if size > 1 << 20 {
            return Err(invalid("FSDB source provenance is too long"));
        }
        input.take(size)?;
    }
    if u32(&mut input)? != 0 || u32(&mut input)? != 0 {
        return Err(invalid("Invalid FSDB model directory flags"));
    }
    u32(&mut input)?;
    let instances = u32(&mut input)?;
    let groups = u32(&mut input)?;
    if groups > 100_000 || instances > 1_000_000 {
        return Err(invalid("FSDB model directory exceeds bounds"));
    }
    let mut models = HashMap::new();
    for _ in 0..groups {
        let prototype = u32(&mut input)?;
        let source = u32(&mut input)?;
        u32(&mut input)?;
        let count = u32(&mut input)? as usize;
        if count > 1_000_000 || count > input.remaining().len() / 4 {
            return Err(invalid("FSDB connection instance list exceeds bounds"));
        }
        for _ in 0..count {
            let instance = u32(&mut input)?;
            if instance >= instances || models.insert(instance + 1, (prototype, source)).is_some() {
                return Err(invalid("Invalid or duplicate FSDB connection instance"));
            }
        }
    }
    if !input.remaining().is_empty() {
        return Err(invalid("Unexpected bytes after FSDB model directory"));
    }
    Ok(models)
}

pub(super) fn bindings(bytes: &[u8]) -> io::Result<HashMap<Vertex, Vertex>> {
    let mut input = Cursor::new(bytes);
    let mut bindings = HashMap::new();
    while !input.remaining().is_empty() {
        let target = (u32(&mut input)?, u32(&mut input)?);
        let source = (u32(&mut input)?, u32(&mut input)?);
        if bindings.insert(target, source).is_some() {
            return Err(invalid("Duplicate FSDB connection binding destination"));
        }
    }
    Ok(bindings)
}
