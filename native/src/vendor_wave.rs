// SPDX-License-Identifier: MPL-2.0

use ondas::{Encoding, ScanRef, Time, TimeRange, TimeUnit, ValueRef, Waveform};
use std::{cell::RefCell, collections::HashMap, ops::ControlFlow, path::Path};
use wavebench_reader::vcd::{Events, Signal};

pub struct VendorWave {
    wave: RefCell<Waveform>,
    ids: HashMap<String, ondas::Signal>,
    pub signals: Vec<Signal>,
    pub start: u64,
    pub end: u64,
    pub scale: String,
    pub backend: &'static str,
}

impl VendorWave {
    pub fn open(path: &str, kind: &str) -> Result<Self, String> {
        let source = Path::new(path);
        let (source, backend) = match kind {
            "dsn" => {
                let parent = source
                    .parent()
                    .filter(|parent| {
                        parent
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("shm"))
                    })
                    .ok_or("Select the DSN component inside a .shm directory")?;
                (parent, "shm-lib")
            }
            "shm" => (source, "shm-lib"),
            "wdb" => (source, "wdb-lib"),
            _ => return Err("Unsupported vendor waveform".into()),
        };
        let wave = ondas::open_with(source, backend).map_err(|error| error.to_string())?;
        let meta = wave.metadata();
        let span = meta.time_span().ok_or("Waveform has no time span")?;
        let scale = meta.timescale().ok_or("Waveform has no timescale")?;
        let unit = match scale.unit() {
            TimeUnit::Second => "s",
            TimeUnit::Millisecond => "ms",
            TimeUnit::Microsecond => "us",
            TimeUnit::Nanosecond => "ns",
            TimeUnit::Picosecond => "ps",
            TimeUnit::Femtosecond => "fs",
            TimeUnit::Attosecond => "as",
            TimeUnit::Zeptosecond => "zs",
            _ => return Err("Unsupported waveform time unit".into()),
        };
        let mut ids = HashMap::new();
        let mut signals = Vec::new();
        for var in wave.hierarchy().variables() {
            let Some(handle) = var.signal() else { continue };
            let (width, real, supported) = match handle.encoding() {
                Encoding::Real => (64, true, true),
                Encoding::Bits { width } => (width, false, width > 0 && width <= 65536),
                _ => (1, false, false),
            };
            let scope = var
                .parent()
                .map(|scope| scope.path().to_string())
                .unwrap_or_default();
            let id = signals.len().to_string();
            ids.insert(id.clone(), handle);
            signals.push(Signal {
                id,
                scope,
                name: var.name().into(),
                width,
                real,
                unit: None,
                supported,
            });
        }
        Ok(Self {
            start: span.first().ticks(),
            end: span.last().ticks(),
            scale: format!("{}{unit}", scale.factor()),
            wave: RefCell::new(wave),
            ids,
            signals,
            backend,
        })
    }

    pub fn query(
        &self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<(Events, bool), String> {
        let signal = self.ids.get(id).ok_or("Unknown signal")?;
        let mut samples = Vec::new();
        let mut truncated = false;
        let _ = self
            .wave
            .borrow_mut()
            .scan(
                &[*signal],
                TimeRange::closed(Time::from_ticks(start), Time::from_ticks(end)),
                |record| {
                    let (tick, value) = match record {
                        ScanRef::Initial {
                            value, changed_at, ..
                        } => (changed_at.map_or(start, Time::ticks), value),
                        ScanRef::Change { time, value, .. } => (time.ticks(), value),
                        _ => return ControlFlow::Continue(()),
                    };
                    if samples.len() >= limit {
                        truncated = true;
                        return ControlFlow::Break(());
                    }
                    let value = match value {
                        ValueRef::Bits(bits) => bits.to_string(),
                        ValueRef::Real(value) => value.to_string(),
                        _ => return ControlFlow::Continue(()),
                    };
                    if samples
                        .last()
                        .is_some_and(|(previous, _)| *previous == tick)
                    {
                        samples.pop();
                    }
                    samples.push((tick, value));
                    ControlFlow::Continue(())
                },
            )
            .map_err(|error| error.to_string())?;
        Ok((samples, truncated))
    }
}
