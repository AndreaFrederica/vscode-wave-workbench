// SPDX-License-Identifier: MPL-2.0

use crate::vcd::{Events, Signal};
use fst_reader::{
    FstFilter, FstHierarchyEntry, FstReader, FstSignalHandle, FstSignalValue, FstVarType,
    ReadSignalsError,
};
use std::{collections::HashMap, fs::File, io::BufReader, path::Path};

pub struct Fst {
    reader: FstReader<BufReader<File>>,
    widths: HashMap<usize, usize>,
    pub signals: Vec<Signal>,
    pub start: u64,
    pub end: u64,
    pub scale: String,
}

impl Fst {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let mut reader = FstReader::open(BufReader::new(file)).map_err(|e| e.to_string())?;
        let header = reader.get_header();
        let exponent = i32::from(header.timescale_exponent);
        let (unit, unit_exponent) = [
            ("s", 0),
            ("ms", -3),
            ("us", -6),
            ("ns", -9),
            ("ps", -12),
            ("fs", -15),
        ]
        .into_iter()
        .find(|&(_, unit_exponent)| exponent >= unit_exponent)
        .unwrap_or(("fs", -15));
        let scale = format!("{}{}", 10f64.powi(exponent - unit_exponent), unit);
        let mut signals = Vec::new();
        let mut scopes = Vec::new();
        let mut scope = String::new();
        let mut widths = HashMap::new();
        reader
            .read_hierarchy(|entry| match entry {
                FstHierarchyEntry::Scope { name, .. } => {
                    scopes.push(scope.len());
                    if !scope.is_empty() {
                        scope.push('.');
                    }
                    scope.push_str(&name);
                }
                FstHierarchyEntry::UpScope => {
                    if let Some(length) = scopes.pop() {
                        scope.truncate(length);
                    }
                }
                FstHierarchyEntry::Var {
                    handle,
                    name,
                    length,
                    tpe,
                    ..
                } => {
                    let supported = !tpe.is_real()
                        && !matches!(tpe, FstVarType::GenericString | FstVarType::Port)
                        && (1..=65536).contains(&length);
                    if supported {
                        widths.insert(handle.get_index(), length as usize);
                    }
                    signals.push(Signal {
                        id: handle.get_index().to_string(),
                        scope: scope.clone(),
                        name: if let Some((name, range)) = name.rsplit_once(" [") {
                            format!("{name}[{range}")
                        } else {
                            name
                        },
                        width: length.max(1),
                        supported,
                    });
                }
                _ => {}
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            reader,
            signals,
            widths,
            start: header.start_time,
            end: header.end_time,
            scale,
        })
    }

    pub fn query(
        &mut self,
        ids: &[&str],
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<Vec<(Events, bool)>, String> {
        self.query_with_order(ids, start, end, limit, false)
    }

    pub fn query_with_order(
        &mut self,
        ids: &[&str],
        start: u64,
        end: u64,
        limit: usize,
        preserve_same_tick: bool,
    ) -> Result<Vec<(Events, bool)>, String> {
        if ids.len() > 64 || end < start || !(1..=100000).contains(&limit) {
            return Err("Invalid FST query bounds".into());
        }
        let mut positions = HashMap::new();
        let mut handles = Vec::with_capacity(ids.len());
        let mut output = Vec::new();
        let mut event_bytes = 0usize;
        for id in ids {
            let index: u32 = id.parse().map_err(|_| "Invalid FST signal ID")?;
            if index == u32::MAX {
                return Err("Invalid FST signal ID".into());
            }
            let handle = FstSignalHandle::from_index(index as usize);
            let width = *self
                .widths
                .get(&handle.get_index())
                .ok_or("Unknown or unsupported FST signal")?;
            if !positions.contains_key(&handle.get_index()) {
                positions.insert(handle.get_index(), (output.len(), width));
                output.push((Events::new(), false));
                event_bytes += width + 32;
            }
            handles.push(handle);
        }
        if handles.is_empty() {
            return Ok(Vec::new());
        }
        // Each response is bounded both by the requested event count and by the
        // maximum size of one event from every queried signal.
        let limit = limit.min((16 * 1024 * 1024 / event_bytes).max(1));
        let filter = FstFilter::new(
            start,
            end,
            positions
                .keys()
                .copied()
                .map(FstSignalHandle::from_index)
                .collect(),
        );
        let mut remaining = output.len();
        let decoded = self.reader.read_signals(&filter, |tick, signal, value| {
            let (index, width) = positions[&signal.get_index()];
            let (events, truncated) = &mut output[index];
            if *truncated {
                return Ok(());
            }
            let FstSignalValue::String(bits) = value else {
                return Err("Invalid digital value in FST");
            };
            if bits.len() != width {
                return Err("Digital value width differs from FST signal declaration");
            }
            let replace = events.last().is_some_and(|(last, _)| {
                if preserve_same_tick {
                    tick < start
                } else {
                    tick <= start || *last == tick
                }
            });
            if !replace && events.len() == limit {
                *truncated = true;
                remaining -= 1;
                return if remaining == 0 { Err("") } else { Ok(()) };
            }
            let value = bit_string(bits);
            if replace {
                *events.last_mut().unwrap() = (tick, value);
            } else {
                events.push((tick, value));
            }
            Ok(())
        });
        match decoded {
            Ok(()) | Err(ReadSignalsError::CallbackError("")) => {}
            Err(ReadSignalsError::CallbackError(error)) => return Err(error.into()),
            Err(ReadSignalsError::ReadError(error)) => return Err(error.to_string()),
        }
        // A section may begin with changes to other signals. In that case the
        // reader can skip its frame and emit no seed for a held signal. Search
        // backwards only for handles without an initial value in this read.
        let mut missing: Vec<_> = positions
            .iter()
            .filter_map(|(&handle, &(index, _))| {
                (!output[index].0.first().is_some_and(|(tick, _)| {
                    *tick < start || (!preserve_same_tick && *tick == start)
                }))
                .then_some(handle)
            })
            .collect();
        let mut seeds = HashMap::new();
        let mut bound = if preserve_same_tick {
            start.saturating_sub(1).min(self.end)
        } else {
            start.min(self.end)
        };
        let mut span = (end - start).max(256);
        while !missing.is_empty() && start > self.start && bound >= self.start {
            let previous = bound.saturating_sub(span).max(self.start);
            let filter = FstFilter::new(
                previous,
                bound,
                missing
                    .iter()
                    .copied()
                    .map(FstSignalHandle::from_index)
                    .collect(),
            );
            self.reader
                .read_signals(&filter, |tick, handle, value| {
                    if let FstSignalValue::String(bits) = value {
                        seeds.insert(handle.get_index(), (tick, bit_string(bits)));
                    }
                    Ok::<_, ()>(())
                })
                .map_err(|error| match error {
                    ReadSignalsError::ReadError(error) => error.to_string(),
                    ReadSignalsError::CallbackError(()) => unreachable!(),
                })?;
            missing.retain(|handle| !seeds.contains_key(handle));
            if previous == self.start {
                break;
            }
            span = span.saturating_mul(4);
            bound = previous;
        }
        for (handle, seed) in seeds {
            let (events, truncated) = &mut output[positions[&handle].0];
            if events.len() == limit {
                events.pop();
                *truncated = true;
            }
            events.insert(0, seed);
        }
        if handles.len() == output.len() {
            Ok(output)
        } else {
            Ok(handles
                .iter()
                .map(|id| output[positions[&id.get_index()].0].clone())
                .collect())
        }
    }
}

fn bit_string(bits: &[u8]) -> String {
    bits.iter()
        .map(|bit| match bit.to_ascii_lowercase() {
            b'0' => '0',
            b'1' => '1',
            b'z' => 'z',
            _ => 'x',
        })
        .collect()
}
