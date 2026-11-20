// SPDX-License-Identifier: MPL-2.0

use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
};
use wavebench_reader::vcd::{window, Events, Signal};

pub struct SpiceRaw {
    pub signals: Vec<Signal>,
    pub start: u64,
    pub end: u64,
    pub scale: &'static str,
    pub backend: &'static str,
    data: Vec<Events>,
}

fn line(reader: &mut impl BufRead) -> Result<String, String> {
    let mut line = String::new();
    let len = reader
        .take(8193)
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    if len == 0 || len > 8192 {
        return Err("Unexpected end of RAW file or oversized line".into());
    }
    Ok(line)
}

fn read_value(
    reader: &mut impl BufRead,
    binary: bool,
    complex: bool,
    index: Option<usize>,
) -> Result<(f64, f64), String> {
    fn double(reader: &mut impl Read) -> Result<f64, String> {
        let mut bytes = [0; 8];
        reader
            .read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(f64::from_le_bytes(bytes))
    }
    if binary {
        let re = double(reader)?;
        let im = if complex { double(reader)? } else { 0.0 };
        return Ok((re, im));
    }
    let mut entry = line(reader)?;
    while entry.trim().is_empty() {
        entry = line(reader)?;
    }
    let text = if let Some(index) = index {
        let fields = entry
            .trim()
            .split_once(char::is_whitespace)
            .ok_or("Missing RAW point value")?;
        if fields.0.parse::<usize>().ok() != Some(index) {
            return Err("Unexpected RAW point index".into());
        }
        fields.1.trim()
    } else {
        entry.trim()
    };
    let number = |text: &str| {
        text.trim()
            .parse::<f64>()
            .map_err(|_| "Invalid RAW numeric value".to_string())
    };
    if complex {
        let (real, imag) = text.split_once(',').ok_or("Missing imaginary RAW value")?;
        Ok((number(real)?, number(imag)?))
    } else {
        Ok((number(text)?, 0.0))
    }
}

impl SpiceRaw {
    pub fn open(path: &str) -> Result<Self, String> {
        let file = File::open(path).map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(file);
        let mut names = Vec::new();
        let mut vars = 0usize;
        let mut points = 0usize;
        let mut complex = false;
        let binary = loop {
            let entry = line(&mut reader)?;
            let Some((key, value)) = entry.trim().split_once(':') else {
                continue;
            };
            let value = value.trim();
            match key {
                "Flags" => {
                    let mut flags = value.split_whitespace();
                    complex = match flags.next() {
                        Some("real") => false,
                        Some("complex") => true,
                        _ => return Err("Unsupported RAW flags".into()),
                    };
                    if flags.any(|value| value == "unpadded") {
                        return Err("Unpadded RAW vectors are unsupported".into());
                    }
                }
                "No. Variables" => {
                    vars = value.parse().map_err(|_| "Invalid RAW variable count")?
                }
                "No. Points" => points = value.parse().map_err(|_| "Invalid RAW point count")?,
                "Variables" => {
                    if !(2..=16384).contains(&vars) {
                        return Err("Invalid RAW variable count".into());
                    }
                    for index in 0..vars {
                        let entry = line(&mut reader)?;
                        let mut fields = entry.split_whitespace();
                        if fields.next().and_then(|index| index.parse::<usize>().ok())
                            != Some(index)
                        {
                            return Err("Unexpected RAW variable index".into());
                        }
                        let name = fields.next().ok_or("Missing RAW variable")?;
                        let kind = fields.next().ok_or("Missing RAW variable kind")?;
                        names.push((name.to_owned(), kind.to_owned()));
                    }
                }
                "Values" => break false,
                "Binary" => break true,
                _ => {}
            }
        };
        if names.len() != vars
            || points == 0
            || points
                .saturating_mul(vars)
                .saturating_mul(if complex { 2 } else { 1 })
                > 4_000_000
        {
            return Err("RAW file is empty or exceeds the 4 million sample limit".into());
        }
        let (scope, scale, ticks_per_unit) = match names[0].1.as_str() {
            "time" if !complex => ("tran", "1fs", 1e15),
            "frequency" => ("ac", "1mHz", 1e3),
            _ => return Err("RAW requires a transient time or AC frequency axis".into()),
        };
        let mut data = vec![Events::new(); (vars - 1) * if complex { 2 } else { 1 }];
        let mut signals = Vec::with_capacity(data.len());
        for (name, kind) in names.iter().skip(1) {
            for component in if complex {
                &[".re", ".im"][..]
            } else {
                &[""][..]
            } {
                signals.push(Signal {
                    id: signals.len().to_string(),
                    scope: scope.into(),
                    name: format!("{name}{component}"),
                    width: 64,
                    supported: true,
                    real: true,
                    unit: match kind.as_str() {
                        "voltage" => Some("V".into()),
                        "current" => Some("A".into()),
                        _ => None,
                    },
                });
            }
        }
        let mut start = 0;
        let mut end = 0;
        let mut previous = None;
        for index in 0..points {
            let (axis, _) = read_value(&mut reader, binary, complex, Some(index))?;
            let scaled = (axis * ticks_per_unit).round();
            if !scaled.is_finite() || !(0.0..=(1u64 << 53) as f64 - 1.0).contains(&scaled) {
                return Err("RAW axis exceeds the supported coordinate range".into());
            }
            let tick = scaled as u64;
            if previous.is_some_and(|old| axis < old || (axis > old && tick == end)) {
                return Err(
                    "RAW coordinates are out of order or finer than the axis resolution".into(),
                );
            }
            previous = Some(axis);
            if index == 0 {
                start = tick;
            }
            end = tick;
            if complex {
                for pair in data.chunks_exact_mut(2) {
                    let (re, im) = read_value(&mut reader, binary, true, None)?;
                    pair[0].push((tick, re.to_string()));
                    pair[1].push((tick, im.to_string()));
                }
            } else {
                for channel in &mut data {
                    channel.push((
                        tick,
                        read_value(&mut reader, binary, false, None)?.0.to_string(),
                    ));
                }
            }
        }
        if reader
            .bytes()
            .any(|byte| !byte.is_ok_and(|byte| byte.is_ascii_whitespace()))
        {
            return Err("RAW file contains additional plot data; export one plot per file".into());
        }
        Ok(Self {
            signals,
            start,
            end,
            scale,
            backend: "rust-ngspice-raw",
            data,
        })
    }

    pub fn open_psf(path: &str) -> Result<Self, String> {
        let file = File::open(path).map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(file);
        if line(&mut reader)?.trim() != "HEADER" {
            return Err("PSF requires a Spectre psfascii transient export".into());
        }
        fn quoted(entry: &str) -> Option<(&str, &str)> {
            entry.trim_start().strip_prefix('"')?.split_once('"')
        }
        let mut signals = Vec::new();
        let mut in_trace = false;
        let mut time_sweep = false;
        let mut in_sweep = false;
        loop {
            let entry = line(&mut reader)?;
            match entry.trim() {
                "SWEEP" => in_sweep = true,
                "TRACE" => {
                    if !time_sweep {
                        return Err("PSF ASCII requires a time sweep".into());
                    }
                    in_sweep = false;
                    in_trace = true;
                }
                "VALUE" => break,
                entry if in_sweep => {
                    if let Some(("time", kind)) = quoted(entry) {
                        time_sweep = quoted(kind).is_some_and(|(kind, _)| kind == "sweep");
                    }
                }
                entry if in_trace => {
                    let (name, kind) = quoted(entry).ok_or("Invalid PSF trace declaration")?;
                    let (kind, rest) = quoted(kind).ok_or("Missing PSF trace type")?;
                    if !rest.trim().is_empty() || signals.len() >= 16384 {
                        return Err("Unsupported PSF trace declaration".into());
                    }
                    signals.push(Signal {
                        id: signals.len().to_string(),
                        scope: "tran".into(),
                        name: name.into(),
                        width: 64,
                        supported: true,
                        real: true,
                        unit: match kind {
                            "V" | "I" => Some(if kind == "V" { "V" } else { "A" }.into()),
                            _ => None,
                        },
                    });
                }
                _ => {}
            }
        }
        if signals.is_empty() {
            return Err("PSF ASCII contains no signals".into());
        }
        let ids: std::collections::HashMap<_, _> = signals
            .iter()
            .enumerate()
            .map(|(index, signal)| (signal.name.as_str(), index))
            .collect();
        if ids.len() != signals.len() || ids.contains_key("time") {
            return Err("Non-unique PSF trace declaration".into());
        }
        let mut data = vec![Events::new(); signals.len()];
        let mut first: Option<u64> = None;
        let mut last: Option<u64> = None;
        let mut sample_count = 0;
        let mut time = None;
        let mut seen = std::collections::HashSet::new();
        loop {
            let entry = line(&mut reader)?;
            if entry.trim() == "END" {
                break;
            }
            let (name, value) = quoted(&entry).ok_or("Invalid PSF ASCII sample")?;
            let value: f64 = value
                .trim()
                .parse()
                .map_err(|_| "Unsupported PSF ASCII sample value")?;
            if name == "time" {
                if time.is_some() && seen.len() != signals.len() {
                    return Err("Incomplete PSF ASCII sample".into());
                }
                let scaled = (value * 1e15).round();
                if !(0.0..=(1u64 << 53) as f64 - 1.0).contains(&scaled) {
                    return Err("PSF time exceeds the supported coordinate range".into());
                }
                let ticks = scaled as u64;
                if last.is_some_and(|old| ticks < old) {
                    return Err("PSF time sweep is out of order".into());
                }
                first.get_or_insert(ticks);
                last = Some(ticks);
                time = Some(ticks);
                seen.clear();
            } else {
                let id = *ids.get(name).ok_or("Unknown PSF trace name")?;
                let tick = time.ok_or("PSF sample appears before the time value")?;
                if !seen.insert(id) {
                    return Err("Duplicate PSF sample in one point".into());
                }
                sample_count += 1;
                if sample_count > 4_000_000 {
                    return Err("PSF exceeds the 4 million sample limit".into());
                }
                data[id].push((tick, value.to_string()));
            }
        }
        if seen.len() != signals.len() || first.is_none() {
            return Err("PSF ASCII has no complete samples".into());
        }
        Ok(Self {
            signals,
            start: first.unwrap(),
            end: last.unwrap(),
            scale: "1fs",
            backend: "rust-psfascii",
            data,
        })
    }

    pub fn query(
        &self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<(Events, bool), String> {
        let index = id.parse::<usize>().map_err(|_| "Invalid RAW signal")?;
        let events = self.data.get(index).ok_or("Unknown RAW signal")?;
        Ok(window(events, start, end, limit))
    }
}
