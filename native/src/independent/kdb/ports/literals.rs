// SPDX-License-Identifier: MPL-2.0

use super::super::archive::View;
use super::{ArrayElement, PortShape, MAX_PORT_WIDTH};
use num_bigint::BigUint;
use std::io;

pub(super) struct Literal {
    pub(super) bits: String,
    pub(super) signed: bool,
    pub(super) fill: bool,
}

impl Literal {
    pub(super) fn to_port(
        &self,
        target: PortShape,
        element: Option<ArrayElement>,
    ) -> Option<(String, bool)> {
        let width = target.width() as usize;
        let (bits, signed) = match element {
            None => (
                resize(&self.bits, width, self.signed || self.fill),
                self.signed,
            ),
            Some(_) if self.fill => return None,
            Some(_) if self.bits.len() == width => (self.bits.clone(), self.signed),
            Some(element) if element.count.checked_mul(width as u64)? == self.bits.len() as u64 => {
                let start = usize::try_from(element.ordinal).ok()?.checked_mul(width)?;
                (self.bits.get(start..start + width)?.to_owned(), false)
            }
            Some(_) => return None,
        };
        let bits = if target.two_state {
            bits.replace(['x', 'z'], "0")
        } else {
            bits
        };
        Some((bits, signed))
    }
}

pub(super) fn read(view: &View, key: u64) -> io::Result<Option<Literal>> {
    let tag = view.uint(key, 4)?;
    if tag & 255 != 0x28 {
        return Ok(None);
    }
    let signed = tag & 0x1000_0000 != 0;
    let based = tag & !0x1001_0000;
    let bits = match tag {
        0x10000328 | 0x10010328 => format!("{:032b}", view.uint(key + 16, 4)?),
        0xaa0228 => {
            let value = view
                .string(view.pointer_required(key + 16)?)?
                .to_ascii_lowercase();
            return Ok(
                matches!(value.as_str(), "0" | "1" | "x" | "z").then_some(Literal {
                    bits: value,
                    signed: false,
                    fill: true,
                }),
            );
        }
        _ => {
            let group = match based {
                0x020228 => 1,
                0x040228 => 3,
                0x060228 => 0,
                0x080228 => 4,
                _ => return Ok(None),
            };
            let width = view.uint(key + 4, 4)?;
            if !(1..=MAX_PORT_WIDTH).contains(&width) {
                return Ok(None);
            }
            let digits = view.string(view.pointer_required(key + 16)?)?;
            if digits.is_empty() || digits.len() > MAX_PORT_WIDTH as usize {
                return Ok(None);
            }
            let mut bits = String::new();
            if group == 0 {
                if let Some(value) = BigUint::parse_bytes(digits.as_bytes(), 10) {
                    bits = value.to_str_radix(2);
                } else if matches!(digits, "x" | "X" | "z" | "Z" | "?") {
                    bits.push(unknown_digit(digits.as_bytes()[0] as char));
                } else {
                    return Ok(None);
                }
            } else {
                for digit in digits.chars().filter(|digit| *digit != '_') {
                    let digit = unknown_digit(digit);
                    if matches!(digit, 'x' | 'z') {
                        bits.extend(std::iter::repeat_n(digit, group));
                    } else if let Some(value) = digit.to_digit(1 << group) {
                        bits.push_str(&format!("{value:0group$b}"));
                    } else {
                        return Ok(None);
                    }
                }
            }
            if bits.is_empty() {
                return Ok(None);
            }
            let fill_unknown = bits.starts_with(['x', 'z']);
            resize(&bits, width as usize, fill_unknown)
        }
    };
    Ok(Some(Literal {
        bits,
        signed,
        fill: false,
    }))
}

fn unknown_digit(digit: char) -> char {
    if digit == '?' {
        'z'
    } else {
        digit.to_ascii_lowercase()
    }
}

fn resize(bits: &str, width: usize, extend: bool) -> String {
    if bits.len() >= width {
        return bits[bits.len() - width..].to_owned();
    }
    let fill = if extend {
        bits.as_bytes()[0] as char
    } else {
        '0'
    };
    format!("{}{}", fill.to_string().repeat(width - bits.len()), bits)
}
