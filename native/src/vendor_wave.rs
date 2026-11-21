// SPDX-License-Identifier: MPL-2.0

use ondas::{Encoding, ScanRef, Time, TimeRange, TimeUnit, ValueRef, Waveform};
use std::{cell::RefCell, collections::HashMap, ops::ControlFlow, path::Path};
use wavebench_reader::vcd::{Events, Signal};

use crate::shm_psfxl::ShmPsfxl;

pub struct VendorWave {
    wave: RefCell<Waveform>,
    ids: HashMap<String, ondas::Signal>,
    analog: Option<ShmPsfxl>,
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
            "dsn" | "trn" => {
                let parent = source
                    .parent()
                    .filter(|parent| {
                        parent
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("shm"))
                    })
                    .ok_or("Select the SST2 component inside a .shm directory")?;
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
        let (unit, units_per_second) = match scale.unit() {
            TimeUnit::Second => ("s", 1.0),
            TimeUnit::Millisecond => ("ms", 1e3),
            TimeUnit::Microsecond => ("us", 1e6),
            TimeUnit::Nanosecond => ("ns", 1e9),
            TimeUnit::Picosecond => ("ps", 1e12),
            TimeUnit::Femtosecond => ("fs", 1e15),
            TimeUnit::Attosecond => ("as", 1e18),
            TimeUnit::Zeptosecond => ("zs", 1e21),
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
        let analog = if backend == "shm-lib" {
            match ShmPsfxl::open(
                source,
                span.first().ticks()..=span.last().ticks(),
                (scale.factor(), unit),
                units_per_second / f64::from(scale.factor()),
                &mut signals,
            ) {
                Ok(analog) => analog,
                Err(error) => {
                    eprintln!("Could not load SHM analog partition: {error}");
                    None
                }
            }
        } else {
            None
        };
        Ok(Self {
            start: span.first().ticks(),
            end: span.last().ticks(),
            scale: format!("{}{unit}", scale.factor()),
            wave: RefCell::new(wave),
            ids,
            analog,
            signals,
            backend,
        })
    }

    pub fn hdl_locations(&self) -> Result<serde_json::Value, String> {
        fn position(value: Option<ondas::HdlPosition>) -> serde_json::Value {
            value.map_or(serde_json::Value::Null, |position| {
                serde_json::json!({ "file": position.file.to_string_lossy(), "line": position.line })
            })
        }
        let locations = self
            .wave
            .borrow()
            .hdl_locations()
            .map_err(|error| error.to_string())?;
        Ok(serde_json::Value::Array(
            locations
                .into_iter()
                .map(|location| {
                    serde_json::json!({
                        "fullname": location.path.to_string(),
                        "parent": location.path.parent().map(|path| path.to_string()),
                    "waveName": location.path.parent().zip(location.path.name()).map(|(parent, name)| {
                        if parent.is_empty() { name.to_owned() } else { format!("{parent}.{name}") }
                    }),
                        "scope": location.scope,
                        "declaration": position(location.declaration),
                        "instance": position(location.instance),
                    })
                })
                .collect(),
        ))
    }

    pub fn query(
        &self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<(Events, bool), String> {
        if id.starts_with("psfxl:") {
            return self
                .analog
                .as_ref()
                .ok_or("No SHM analog partition")?
                .query(id, start, end, limit);
        }
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

    pub fn psfxl_cache_stats(&self) -> Option<serde_json::Value> {
        self.analog.as_ref().map(ShmPsfxl::cache_stats)
    }

    pub fn configure_psfxl_cache(&self, disk: Option<u64>, memory: Option<u64>) {
        if let Some(analog) = &self.analog {
            analog.configure_cache(disk, memory);
        }
    }

    pub fn psfxl_overview(
        &self,
        id: &str,
        start: u64,
        end: u64,
        bins: usize,
    ) -> Result<serde_json::Value, String> {
        self.analog
            .as_ref()
            .ok_or("No SHM analog partition")?
            .overview(id, start, end, bins)
    }
}
