// SPDX-License-Identifier: MPL-2.0

use super::{SpiceRaw, SweepAxis};
use psfkit::{Properties, PsfFile, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use wavebench_reader::vcd::{Events, Signal};

fn unit(properties: &Properties) -> Option<String> {
    properties.get("units")?.as_str().map(str::to_owned)
}

fn scalar_traces(
    name: &str,
    values: Vec<Value>,
    unit: Option<String>,
    emit: &mut impl FnMut(String, Vec<f64>, Option<String>),
) {
    let Some(first) = values.first() else { return };
    match first {
        Value::Int(_) | Value::Float(_) => {
            emit(
                name.into(),
                values
                    .iter()
                    .map(|value| value.as_f64().unwrap_or(f64::NAN))
                    .collect(),
                unit,
            );
        }
        Value::Complex(..) => {
            let (re, im): (Vec<_>, Vec<_>) = values
                .into_iter()
                .map(|value| match value {
                    Value::Complex(re, im) => (re, im),
                    _ => (f64::NAN, f64::NAN),
                })
                .unzip();
            emit(format!("{name}.real"), re.clone(), unit.clone());
            emit(format!("{name}.imag"), im.clone(), unit.clone());
            emit(
                format!("{name}.mag"),
                re.iter().zip(&im).map(|(re, im)| re.hypot(*im)).collect(),
                unit,
            );
            emit(
                format!("{name}.phase"),
                re.iter()
                    .zip(&im)
                    .map(|(re, im)| im.atan2(*re).to_degrees())
                    .collect(),
                Some("°".into()),
            );
        }
        Value::Struct(fields) => {
            let names: Vec<_> = fields.iter().map(|(field, _)| field.clone()).collect();
            for field in names {
                let column = values
                    .iter()
                    .map(|value| value.field(&field).cloned())
                    .collect::<Option<Vec<_>>>();
                if let Some(column) = column {
                    scalar_traces(&format!("{name}.{field}"), column, unit.clone(), emit);
                }
            }
        }
        Value::Array(items) => {
            for index in 0..items.len() {
                let column = values
                    .iter()
                    .map(|value| match value {
                        Value::Array(items) => items.get(index).cloned(),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>();
                if let Some(column) = column {
                    scalar_traces(&format!("{name}[{index}]"), column, unit.clone(), emit);
                }
            }
        }
        _ => {}
    }
}

fn plot_ticks(
    points: &[f64],
    kind: &str,
    axis_unit: Option<String>,
) -> Result<(Vec<u64>, String, Option<SweepAxis>), String> {
    if points.is_empty() || points.iter().any(|value| !value.is_finite()) {
        return Err("Missing or invalid PSF sweep samples".into());
    }
    let minimum = points.iter().copied().reduce(f64::min).unwrap();
    let maximum = points.iter().copied().reduce(f64::max).unwrap();
    let origin = if matches!(kind, "time" | "freq" | "frequency") {
        0.0
    } else {
        minimum
    };
    if minimum < origin {
        return Err(format!("PSF {kind} sweep contains a negative sample"));
    }
    let span = maximum - origin;
    if !span.is_finite() {
        return Err("PSF sweep range exceeds numeric precision".into());
    }
    let nominal: f64 = match kind {
        "time" => 1e-15,
        "freq" | "frequency" => 1e-6,
        _ if span != 0.0 => 10f64.powf(span.log10().floor() - 12.0),
        _ => 1.0,
    };
    let mut step = nominal.max(f64::MIN_POSITIVE);
    while span / step >= (1u64 << 52) as f64 {
        step *= 10.0
    }
    let ticks = points
        .iter()
        .map(|value| ((value - origin) / step).round() as u64)
        .collect();
    let (scale, axis) = match kind {
        "time" => {
            let units = [
                (1e-15, "fs"),
                (1e-12, "ps"),
                (1e-9, "ns"),
                (1e-6, "us"),
                (1e-3, "ms"),
                (1.0, "s"),
            ];
            let (factor, unit) = units
                .into_iter()
                .rev()
                .find(|(factor, _)| step >= *factor)
                .unwrap_or(units[0]);
            (format!("{}{unit}", (step / factor).round()), None)
        }
        "freq" | "frequency" => (format!("{step:e}Hz"), None),
        _ => (
            kind.to_owned(),
            Some(SweepAxis {
                origin,
                step,
                name: kind.to_owned(),
                unit: axis_unit,
            }),
        ),
    };
    Ok((ticks, scale, axis))
}

impl SpiceRaw {
    pub fn open_psf_sweep(path: &str) -> Result<Self, String> {
        let path = Path::new(path);
        let directory = path.parent().ok_or("Missing Spectre results folder")?;
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid sweep filename")?;
        let log = PsfFile::open(directory.join("logFile")).map_err(|error| error.to_string())?;
        let values = log.values().map_err(|error| error.to_string())?;
        let field = |item: &psfkit::NamedValue, key| {
            item.value
                .field(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        let root = values
            .iter()
            .find(|entry| field(entry, "dataFile") == filename)
            .ok_or("Spectre logFile has no entry for this sweep")?;
        let by_name: HashMap<_, _> = values
            .iter()
            .map(|entry| (entry.name.as_str(), entry))
            .collect();
        // A nested sweep stores only its own coordinate on each child entry.
        let sweep_parameters = |name: &str| match by_name
            .get(name)
            .and_then(|entry| entry.value.field("sweepVariable"))
        {
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let mut merged: Option<Self> = None;
        for leaf in values {
            if leaf.props.get_str("sweep_tree_type") != Some("leafNode") {
                continue;
            }
            let mut coordinates = Vec::new();
            let mut current = leaf;
            for _ in 0..values.len() {
                let parent = field(current, "parent");
                for parameter in sweep_parameters(&parent) {
                    if let Some(value) = current.props.get_f64(parameter) {
                        let label = if value != 0.0 && value.abs() < 0.001 {
                            format!("{value:e}")
                        } else {
                            value.to_string()
                        };
                        coordinates.push(format!("{parameter}={label}"));
                    }
                }
                if parent == root.name {
                    break;
                }
                let Some(entry) = by_name.get(parent.as_str()) else {
                    break;
                };
                current = entry;
            }
            if field(current, "parent") != root.name {
                continue;
            }
            coordinates.reverse();
            let child = PathBuf::from(field(leaf, "dataFile"));
            let Some(child_name) = child.file_name().filter(|name| child.as_os_str() == *name)
            else {
                return Err("Invalid Spectre sweep data filename".into());
            };
            let file = directory.join(child_name);
            let mut branch =
                Self::open_psf_analysis(file.to_str().ok_or("Invalid Spectre results path")?)?;
            let label = if coordinates.is_empty() {
                leaf.name.clone()
            } else {
                coordinates.join(", ")
            };
            for signal in &mut branch.signals {
                signal.scope = format!("{}.{}", signal.scope, label);
            }
            if let Some(output) = &mut merged {
                if output.scale != branch.scale || output.sweep_axis != branch.sweep_axis {
                    return Err("Spectre sweep branches use different axis scales".into());
                }
                output.start = output.start.min(branch.start);
                output.end = output.end.max(branch.end);
                for mut signal in branch.signals {
                    signal.id = output.signals.len().to_string();
                    output.signals.push(signal);
                }
                output.data.extend(branch.data);
            } else {
                merged = Some(branch);
            }
        }
        merged.ok_or_else(|| "Spectre sweep has no numeric result files".into())
    }

    pub fn open_psf_analysis(path: &str) -> Result<Self, String> {
        let psf = match PsfFile::open(path) {
            Ok(psf) => psf,
            Err(psfkit::Error::Unsupported(error))
                if error.starts_with("type code 14 at ")
                    && path.to_ascii_lowercase().ends_with(".margin.stb") =>
            {
                return open_binary_margins(path);
            }
            Err(error) => return Err(error.to_string()),
        };
        let analysis = psf
            .header()
            .get("analysis type")
            .and_then(|value| value.as_str())
            .unwrap_or("psf");
        let (ticks, scale, sweep_axis, columns, units) = if psf.is_swept() {
            let declarations: HashMap<_, _> = psf
                .traces()
                .iter()
                .map(|trace| {
                    let units = unit(&trace.props).or_else(|| {
                        psf.types()
                            .iter()
                            .find(|item| item.name == trace.type_name)
                            .and_then(|item| unit(&item.props))
                    });
                    (trace.name.as_str(), units)
                })
                .collect();
            let sweep = psf.read_all().map_err(|error| error.to_string())?;
            let points = sweep
                .sweep
                .to_f64()
                .ok_or("PSF sweep coordinate must be numeric")?;
            let sweep_unit = psf.sweeps().first().and_then(|sweep| unit(&sweep.props));
            let (ticks, scale, axis) = plot_ticks(&points, &sweep.sweep_name, sweep_unit)?;
            (ticks, scale, axis, sweep.traces, declarations)
        } else {
            let values = psf.values().map_err(|error| error.to_string())?;
            let properties: HashMap<_, _> = values
                .iter()
                .map(|value| (value.name.as_str(), unit(&value.props)))
                .collect();
            let mut signals = Vec::new();
            let mut data = Vec::new();
            for item in values {
                scalar_traces(
                    &item.name,
                    vec![item.value.clone()],
                    properties[item.name.as_str()].clone(),
                    &mut |name, values, unit| {
                        push_trace(
                            &mut signals,
                            &mut data,
                            analysis,
                            name,
                            unit,
                            &[(0, 0)],
                            &values,
                        )
                    },
                );
            }
            return finish(
                signals,
                data,
                0,
                0,
                "point".into(),
                Some(SweepAxis {
                    origin: 0.0,
                    step: 1.0,
                    name: "point".into(),
                    unit: None,
                }),
            );
        };
        let mut order: Vec<_> = ticks
            .into_iter()
            .enumerate()
            .map(|(index, tick)| (tick, index))
            .collect();
        order.sort_by_key(|&(tick, _)| tick);
        let start = order.first().unwrap().0;
        let end = order.last().unwrap().0;
        let mut signals = Vec::new();
        let mut data = Vec::new();
        for (name, column) in columns {
            let unit = units.get(name.as_str()).cloned().flatten();
            let add = &mut |name, values: Vec<f64>, unit| {
                push_trace(
                    &mut signals,
                    &mut data,
                    analysis,
                    name,
                    unit,
                    &order,
                    &values,
                )
            };
            if let Some(values) = column.to_f64() {
                add(name, values, unit);
            } else {
                let values = (0..column.len())
                    .map(|index| column.get(index))
                    .collect::<Option<Vec<_>>>();
                if let Some(values) = values {
                    scalar_traces(&name, values, unit, add);
                }
            }
        }
        finish(signals, data, start, end, scale, sweep_axis)
    }
}

// Spectre's margin file uses a string status value alongside the numeric results.
// The PSF dependency does not currently recognize the binary string declaration.
fn open_binary_margins(path: &str) -> Result<SpiceRaw, String> {
    fn take<'a>(data: &mut &'a [u8], count: usize) -> Result<&'a [u8], String> {
        let (field, rest) = data
            .split_at_checked(count)
            .ok_or("Truncated PSF margin section")?;
        *data = rest;
        Ok(field)
    }
    fn word(data: &mut &[u8]) -> Result<u32, String> {
        Ok(u32::from_be_bytes(take(data, 4)?.try_into().unwrap()))
    }
    fn text(data: &mut &[u8]) -> Result<String, String> {
        let length = word(data)? as usize;
        let padded = length.checked_add(3).ok_or("Invalid PSF margin string")? & !3;
        Ok(String::from_utf8_lossy(&take(data, padded)?[..length]).into_owned())
    }
    fn properties(data: &mut &[u8]) -> Result<Option<String>, String> {
        let mut units = None;
        while matches!(data.get(..4), Some([0, 0, 0, 0x21..=0x23])) {
            let kind = word(data)?;
            let key = text(data)?;
            match kind {
                0x21 => {
                    let value = text(data)?;
                    if key == "units" {
                        units = Some(value);
                    }
                }
                0x22 => {
                    take(data, 4)?;
                }
                _ => {
                    take(data, 8)?;
                }
            }
        }
        Ok(units)
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let mut offset = 0;
    let mut types = HashMap::new();
    let mut signals = Vec::new();
    let mut samples = Vec::new();
    loop {
        let mut section = bytes
            .get(offset..)
            .ok_or("Invalid PSF margin section offset")?;
        let code = word(&mut section)?;
        if word(&mut section)? != 0x15 {
            return Err("Invalid PSF margin section link".into());
        }
        let next = (word(&mut section)? as usize)
            .checked_sub(4)
            .filter(|next| *next >= offset + 12 && *next <= bytes.len())
            .ok_or("Invalid PSF margin section extent")?;
        let mut entries = &bytes[offset + 12..next];
        if matches!(entries.get(..4), Some([0, 0, 0, 0x16])) {
            word(&mut entries)?;
            let end = word(&mut entries)? as usize;
            entries = bytes
                .get(offset + 20..end.min(next))
                .ok_or("Invalid PSF margin table extent")?;
        }
        while matches!(entries.get(..4), Some([0, 0, 0, 0x10])) && matches!(code, 1 | 4) {
            word(&mut entries)?;
            let id = word(&mut entries)?;
            let name = text(&mut entries)?;
            if code == 1 {
                if word(&mut entries)? != 0 {
                    return Err("Unexpected PSF margin array".into());
                }
                let kind = word(&mut entries)?;
                if kind == 14 {
                    word(&mut entries)?;
                }
                types.insert(id, (kind, properties(&mut entries)?));
            } else {
                let (kind, unit) = types
                    .get(&word(&mut entries)?)
                    .ok_or("Unknown PSF margin type")?;
                match kind {
                    9 | 11 => {
                        let value = if *kind == 9 {
                            f64::from(f32::from_be_bytes(
                                take(&mut entries, 4)?.try_into().unwrap(),
                            ))
                        } else {
                            f64::from_be_bytes(take(&mut entries, 8)?.try_into().unwrap())
                        };
                        let units = properties(&mut entries)?.or_else(|| unit.clone());
                        push_trace(
                            &mut signals,
                            &mut samples,
                            "margin.stb",
                            name,
                            units,
                            &[(0, 0)],
                            &[value],
                        );
                    }
                    14 => {
                        text(&mut entries)?;
                        properties(&mut entries)?;
                    }
                    _ => return Err(format!("Unsupported PSF margin value type {kind}")),
                }
            }
        }
        if code == 4 {
            break;
        }
        offset = next;
    }
    finish(
        signals,
        samples,
        0,
        0,
        "point".into(),
        Some(SweepAxis {
            origin: 0.0,
            step: 1.0,
            name: "point".into(),
            unit: None,
        }),
    )
}

fn push_trace(
    signals: &mut Vec<Signal>,
    data: &mut Vec<Events>,
    scope: &str,
    name: String,
    unit: Option<String>,
    order: &[(u64, usize)],
    values: &[f64],
) {
    if values.len() != order.len() {
        return;
    }
    signals.push(Signal {
        id: signals.len().to_string(),
        scope: scope.into(),
        name,
        width: 64,
        supported: true,
        real: true,
        unit,
    });
    data.push(
        order
            .iter()
            .map(|&(tick, index)| (tick, values[index].to_string()))
            .collect(),
    );
}

fn finish(
    signals: Vec<Signal>,
    data: Vec<Events>,
    start: u64,
    end: u64,
    scale: String,
    sweep_axis: Option<SweepAxis>,
) -> Result<SpiceRaw, String> {
    if signals.is_empty() {
        return Err("PSF analysis contains no numeric traces".into());
    }
    Ok(SpiceRaw {
        signals,
        data,
        start,
        end,
        scale,
        sweep_axis,
        backend: "rust-psf",
    })
}
