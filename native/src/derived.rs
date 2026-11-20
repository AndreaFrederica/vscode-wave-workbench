// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{cache::Block, Events};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub id: String,
    pub bit_offset: Option<u32>,
    pub scope: Option<String>,
    pub name: Option<String>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Definition {
    pub op: String,
    pub inputs: Vec<Input>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub samples: Option<Vec<(String, String)>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real: Option<bool>,
}

pub const MAX_REAL_SAMPLES: usize = 16_384;

impl Definition {
    pub fn width(&self, widths: &[u32]) -> Result<u32, String> {
        if self.op == "samples" {
            let width = self
                .width
                .filter(|n| (1..=256).contains(n))
                .ok_or("Invalid sampled virtual width")?;
            let samples = self.samples.as_ref().ok_or("Missing virtual samples")?;
            let real = self.real == Some(true);
            if !self
                .source
                .as_ref()
                .is_some_and(|name| !name.is_empty() && name.len() <= 130)
                || !self.inputs.is_empty()
                || samples.is_empty()
                || samples.len() > if real { MAX_REAL_SAMPLES } else { 4097 }
                || (real && width != 64)
                || samples.iter().any(|(tick, value)| {
                    tick.parse::<u64>().is_err()
                        || if real {
                            value != "NaN"
                                && (value.len() > 32
                                    || !value.parse::<f64>().is_ok_and(f64::is_finite))
                        } else {
                            value.len() != width as usize
                                || !value.bytes().all(|c| b"01xz".contains(&c))
                        }
                })
                || samples
                    .windows(2)
                    .any(|pair| pair[0].0.parse::<u64>().ok() >= pair[1].0.parse::<u64>().ok())
            {
                return Err("Invalid sampled virtual definition".into());
            }
            return Ok(width);
        }
        if self.width.is_some()
            || self.samples.is_some()
            || self.source.is_some()
            || self.real.is_some()
        {
            return Err("Virtual expression cannot have recorded samples".into());
        }
        if self.inputs.is_empty() || self.inputs.len() > 64 {
            return Err("Select 1–64 operands".into());
        }
        if self.op == "not" && widths.len() != 1 {
            return Err("NOT requires one operand".into());
        }
        if !["concat", "and", "or", "xor", "not"].contains(&self.op.as_str()) {
            return Err("Unsupported virtual signal operation".into());
        }
        let width = if self.op == "concat" {
            widths.iter().sum()
        } else {
            *widths.iter().max().ok_or("Missing inputs")?
        };
        if width == 0 || width > 65536 {
            return Err("Virtual signal width must be 1–65536".into());
        }
        Ok(width)
    }
    pub fn id(&self) -> String {
        let text = serde_json::to_vec(self).unwrap();
        let hash = text.iter().fold(14695981039346656037u64, |h, b| {
            (h ^ u64::from(*b)).wrapping_mul(1099511628211)
        });
        format!("@virtual:{hash:016x}")
    }
}
fn bits(raw: &str, width: u32, bit: Option<u32>) -> Result<String, String> {
    let raw = raw.to_lowercase();
    if raw.is_empty() || !raw.bytes().all(|c| b"01xz".contains(&c)) {
        return Err("Virtual operations require digital four-state values".into());
    }
    let fill = if raw.starts_with(['x', 'z']) {
        &raw[0..1]
    } else {
        "0"
    };
    let value = fill.repeat((width as usize).saturating_sub(raw.len())) + &raw;
    let value = if value.len() > width as usize {
        value[value.len() - width as usize..].to_string()
    } else {
        value
    };
    if let Some(bit) = bit {
        return Ok((value.as_bytes()[value.len() - 1 - bit as usize] as char).to_string());
    }
    Ok(value)
}
fn evaluate(op: &str, values: &[String], width: u32) -> String {
    if op == "concat" {
        return values.concat();
    }
    let values: Vec<_> = values
        .iter()
        .map(|s| "0".repeat(width as usize - s.len()) + s)
        .collect();
    (0..width as usize)
        .map(|i| {
            let column: Vec<_> = values.iter().map(|v| v.as_bytes()[i]).collect();
            match op {
                "not" => match column[0] {
                    b'0' => '1',
                    b'1' => '0',
                    _ => 'x',
                },
                "and" => {
                    if column.contains(&b'0') {
                        '0'
                    } else if column.iter().all(|v| *v == b'1') {
                        '1'
                    } else {
                        'x'
                    }
                }
                "or" => {
                    if column.contains(&b'1') {
                        '1'
                    } else if column.iter().all(|v| *v == b'0') {
                        '0'
                    } else {
                        'x'
                    }
                }
                "xor" => {
                    if column.iter().any(|v| *v == b'x' || *v == b'z') {
                        'x'
                    } else if column.iter().filter(|v| **v == b'1').count() % 2 == 1 {
                        '1'
                    } else {
                        '0'
                    }
                }
                _ => 'x',
            }
        })
        .collect()
}
pub fn compute(
    def: &Definition,
    widths: &[u32],
    blocks: &[Arc<Block>],
    start: u64,
    end: u64,
    limit: usize,
) -> Result<Block, String> {
    let projected: Vec<_> = widths
        .iter()
        .zip(&def.inputs)
        .map(|(w, i)| if i.bit_offset.is_some() { 1 } else { *w })
        .collect();
    let width = def.width(&projected)?;
    if let Some(samples) = &def.samples {
        let events: Events = samples
            .iter()
            .map(|(tick, value)| (tick.parse().unwrap(), value.clone()))
            .collect();
        let (events, truncated) = wavebench_reader::vcd::window(&events, start, end, limit);
        return Ok(Block { events, truncated });
    }
    let mut safe_end = end;
    let mut truncated = false;
    for b in blocks {
        if b.truncated {
            truncated = true;
            let t = b.events.last().map(|v| v.0).unwrap_or(start);
            if t <= start {
                return Ok(Block {
                    events: vec![],
                    truncated: true,
                });
            }
            safe_end = safe_end.min(t - 1);
        }
    }
    let mut times = BTreeSet::from([start]);
    for b in blocks {
        for (t, _) in &b.events {
            if *t >= start && *t <= safe_end {
                times.insert(*t);
            }
        }
    }
    if (times.len() as u64) * (width as u64) * (blocks.len() as u64) > 50_000_000 {
        return Err("Virtual computation budget exceeded; zoom in or select fewer operands".into());
    }
    let mut cursors = vec![0; blocks.len()];
    let mut values: Vec<_> = widths.iter().map(|w| "x".repeat(*w as usize)).collect();
    let mut events: Events = vec![];
    for t in times {
        for (i, b) in blocks.iter().enumerate() {
            while cursors[i] < b.events.len() && b.events[cursors[i]].0 <= t {
                values[i] = b.events[cursors[i]].1.clone();
                cursors[i] += 1;
            }
        }
        let inputs: Vec<_> = values
            .iter()
            .zip(widths)
            .zip(&def.inputs)
            .map(|((v, w), input)| bits(v, *w, input.bit_offset))
            .collect::<Result<_, _>>()?;
        let value = evaluate(&def.op, &inputs, width);
        if events.last().map(|v| v.1 != value).unwrap_or(true) {
            if events.len() == limit {
                truncated = true;
                break;
            }
            events.push((t, value));
        }
    }
    Ok(Block { events, truncated })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn four_states() {
        assert_eq!(evaluate("and", &["0x1z".into(), "z011".into()], 4), "001x");
        assert_eq!(evaluate("or", &["1x0z".into(), "z100".into()], 4), "110x");
        assert_eq!(evaluate("xor", &["1x0z".into(), "1100".into()], 4), "0x0x");
        assert_eq!(evaluate("not", &["01xz".into()], 4), "10xx");
        assert_eq!(evaluate("concat", &["1z".into(), "0x".into()], 4), "1z0x");
    }
    #[test]
    fn simultaneous_changes_and_truncation() {
        let d = Definition {
            real: None,
            width: None,
            source: None,
            samples: None,
            op: "xor".into(),
            inputs: vec![
                Input {
                    id: "a".into(),
                    bit_offset: None,
                    scope: None,
                    name: None,
                },
                Input {
                    id: "b".into(),
                    bit_offset: None,
                    scope: None,
                    name: None,
                },
            ],
        };
        let a = Arc::new(Block {
            events: vec![(0, "0".into()), (5, "1".into())],
            truncated: false,
        });
        let b = a.clone();
        let result = compute(&d, &[1, 1], &[a.clone(), b], 0, 10, 20).unwrap();
        assert_eq!(result.events, vec![(0, "0".into())]);
        let clipped = Arc::new(Block {
            events: a.events.clone(),
            truncated: true,
        });
        let result = compute(&d, &[1, 1], &[a, clipped], 0, 10, 20).unwrap();
        assert!(result.truncated);
        assert!(result.events.iter().all(|v| v.0 < 5));
    }
}
