// SPDX-License-Identifier: MPL-2.0

mod codec;
mod psfxl;
mod sst2;

use crate::vcd::{Events, Signal};
use psfxl::Psfxl;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;

fn bytes(data: &[u8], start: usize, length: usize) -> Result<&[u8]> {
    start
        .checked_add(length)
        .and_then(|end| data.get(start..end))
        .ok_or_else(|| format!("Truncated SHM data at {start:#x}"))
}

fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

fn scale(exponent: i8) -> Result<String> {
    let units = ["s", "ms", "us", "ns", "ps", "fs", "as", "zs"];
    let digits = i16::from(exponent);
    let index = (-digits).div_euclid(3) + i16::from(digits.rem_euclid(3) != 0);
    let unit = usize::try_from(index)
        .ok()
        .and_then(|index| units.get(index))
        .ok_or("Unsupported SST2 time scale")?;
    let factor = 10u64.pow((digits + index * 3) as u32);
    Ok(format!("{factor}{unit}"))
}

fn raw_psfxl(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".tran.dat"))
}

fn components(path: &Path) -> Result<(Option<(PathBuf, Vec<PathBuf>)>, Vec<PathBuf>)> {
    let directory = if path.is_dir() {
        path
    } else {
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."))
    };
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        files.push(entry.map_err(|error| error.to_string())?.path());
    }
    files.sort();
    let suffix = |path: &Path, ext: &str| {
        path.extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(ext))
    };
    let selected = if suffix(path, "psfxl") || suffix(path, "tran") || raw_psfxl(path) {
        None
    } else if suffix(path, "dsn") || suffix(path, "trn") {
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        files
            .iter()
            .filter(|candidate| suffix(candidate, "dsn"))
            .find(|candidate| {
                let name = candidate
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                name == stem || (suffix(path, "trn") && segment_number(stem, name).is_some())
            })
            .cloned()
            .or_else(|| Some(path.with_extension("dsn")))
    } else {
        let candidates: Vec<_> = files.iter().filter(|path| suffix(path, "dsn")).collect();
        let named = directory.file_stem().and_then(|stem| {
            candidates
                .iter()
                .find(|path| path.file_stem() == Some(stem))
        });
        if named.is_none() && candidates.len() > 1 {
            return Err(
                "Select the DSN component for a directory with multiple SST2 designs".into(),
            );
        }
        named
            .or_else(|| candidates.first())
            .map(|path| (*path).clone())
    };
    let digital = selected.map(|dsn| {
        let stem = dsn
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        let mut recordings: Vec<_> = files
            .iter()
            .filter(|path| suffix(path, "trn"))
            .filter_map(|path| {
                let name = path.file_stem()?.to_str()?;
                let order = if name == stem {
                    0
                } else {
                    segment_number(name, stem)?
                };
                Some((order, path.clone()))
            })
            .collect();
        recordings.sort_by_key(|(order, _)| *order);
        let paths = recordings
            .into_iter()
            .map(|(_, path)| path)
            .collect::<Vec<_>>();
        (dsn, paths)
    });
    let analog = if suffix(path, "psfxl") || raw_psfxl(path) {
        vec![path.with_extension("")]
    } else if suffix(path, "tran") {
        vec![path.to_owned()]
    } else {
        let mut stubs: Vec<_> = files
            .iter()
            .filter(|path| suffix(path, "psfxl") || raw_psfxl(path))
            .map(|path| path.with_extension(""))
            .collect();
        stubs.sort_unstable();
        stubs.dedup();
        stubs
    };
    Ok((digital, analog))
}

fn segment_number(file: &str, design: &str) -> Option<u32> {
    file.strip_prefix(design)?.strip_prefix('-')?.parse().ok()
}

struct Digital {
    recordings: Vec<sst2::Sst2>,
    // One catalogue ID has an optional local ID in each incremental recording.
    bindings: Vec<Vec<(usize, usize)>>,
    signals: Vec<Signal>,
    start: u64,
    end: u64,
    exponent: i8,
}

impl Digital {
    fn open(dsn: &Path, trn: &[PathBuf]) -> Result<Self> {
        if trn.is_empty() {
            return Err(format!("No SST2 transition files for {}", dsn.display()));
        }
        let mut recordings = trn
            .iter()
            .map(|path| sst2::Sst2::open(dsn, path))
            .collect::<Result<Vec<_>>>()?;
        recordings.sort_by_key(|part| part.start);
        let exponent = recordings[0].exponent;
        if recordings.iter().any(|part| part.exponent != exponent) {
            return Err("SST2 transition files use different time scales".into());
        }
        let start = recordings[0].start;
        let end = recordings
            .iter()
            .map(|part| part.end)
            .max()
            .unwrap_or(start);
        let mut signals = Vec::new();
        let mut bindings: Vec<Vec<(usize, usize)>> = Vec::new();
        let mut identifiers = HashMap::new();
        for (part, recording) in recordings.iter().enumerate() {
            for (local, signal) in recording.signals.iter().enumerate() {
                let key = (&signal.scope, &signal.name);
                let id = *identifiers.entry(key).or_insert_with(|| {
                    let id = signals.len();
                    let mut signal = signal.clone();
                    signal.id = id.to_string();
                    signals.push(signal);
                    bindings.push(Vec::new());
                    id
                });
                if signals[id].width != signal.width || signals[id].real != signal.real {
                    return Err(format!(
                        "SST2 signal {} changes type between segments",
                        signal.name
                    ));
                }
                bindings[id].push((part, local));
            }
        }
        Ok(Self {
            recordings,
            bindings,
            signals,
            start,
            end,
            exponent,
        })
    }

    fn query(
        &self,
        id: usize,
        start: u64,
        end: u64,
        limit: usize,
        ordered: bool,
    ) -> Result<(Events, bool)> {
        let segments = self.bindings.get(id).ok_or("Unknown SST2 signal")?;
        if segments.len() == 1 {
            let (part, local) = segments[0];
            return self.recordings[part].query(local, start, end, limit, ordered);
        }
        let mut output = Events::new();
        let mut previous = None;
        for (i, &(part, local)) in segments.iter().enumerate() {
            let recording = &self.recordings[part];
            let upper = segments.get(i + 1).map_or(recording.end, |&(next, _)| {
                recording
                    .end
                    .min(self.recordings[next].start.saturating_sub(1))
            });
            if upper < start {
                if !recording.is_event(local) {
                    let (tail, _) = recording.query(local, upper, upper, 1, false)?;
                    previous = tail.into_iter().last().or(previous);
                }
                continue;
            }
            if recording.start > end {
                break;
            }
            let (events, truncated) = recording.query(
                local,
                start.max(recording.start),
                end.min(upper),
                limit.saturating_add(1),
                ordered,
            )?;
            if output.is_empty() && events.first().is_none_or(|event| event.0 > start) {
                output.extend(previous.take());
            }
            for (tick, value) in events {
                if !ordered
                    && !recording.is_event(local)
                    && output.last().is_some_and(|(_, last)| *last == value)
                {
                    continue;
                }
                if output.len() == limit {
                    return Ok((output, true));
                }
                output.push((tick, value));
            }
            if truncated {
                return Ok((output, true));
            }
        }
        if output.is_empty() {
            output.extend(previous);
        }
        Ok((output, false))
    }

    fn locations(&self) -> Value {
        self.recordings[0].locations(&self.signals)
    }
}

pub struct Shm {
    digital: Option<Digital>,
    source_indexes: Vec<PathBuf>,
    analog: Vec<Psfxl>,
    analog_ids: HashMap<String, (usize, usize)>,
    ticks_per_second: f64,
    pub signals: Vec<Signal>,
    pub warnings: Vec<String>,
    pub start: u64,
    pub end: u64,
    pub scale: String,
}

impl Shm {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let (digital, stubs) = components(path)?;
        let source_indexes = digital.as_ref().map_or_else(Vec::new, |(dsn, _)| {
            let directory = dsn.parent().unwrap_or(Path::new("."));
            let mut indexes = Vec::new();
            if directory
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("shm"))
            {
                for suffix in [".hierarchy.hdl.json", ".hdl.json"] {
                    let mut filename = directory.as_os_str().to_owned();
                    filename.push(suffix);
                    indexes.push(PathBuf::from(filename));
                }
            }
            indexes
        });
        let digital = digital
            .map(|(dsn, trn)| Digital::open(&dsn, &trn))
            .transpose()?;
        let mut analog = Vec::new();
        let mut warnings = Vec::new();
        for stub in &stubs {
            match Psfxl::open(stub, raw_psfxl(path).then_some(path)) {
                Ok(partition) => {
                    if partition.recovered {
                        warnings.push(format!(
                            "{}: using complete blocks before the truncated tail",
                            stub.display()
                        ));
                    }
                    analog.push(partition);
                }
                Err(error) if digital.is_some() => {
                    warnings.push(format!("{}: {error}", stub.display()));
                }
                Err(error) => return Err(error),
            }
        }
        if digital.is_none() && analog.is_empty() {
            return Err("No matching SST2 or PSFXL components".into());
        }
        let exponent = digital.as_ref().map_or(-15, |digital| digital.exponent);
        let ticks_per_second = 10f64.powi(-i32::from(exponent));
        let scale = scale(exponent)?;
        let mut signals = digital
            .as_ref()
            .map_or_else(Vec::new, |digital| digital.signals.clone());
        let mut start = digital.as_ref().map(|digital| digital.start);
        let mut end = digital.as_ref().map_or(0, |digital| digital.end);
        let mut analog_ids = HashMap::new();
        let mut analog_names = HashSet::new();
        for (partition, analysis) in analog.iter().enumerate() {
            for (fullname, index) in &analysis.names {
                let trace = &analysis.traces[*index];
                if trace.count != 0 {
                    let first = (trace.start * ticks_per_second).round() as u64;
                    start = Some(start.map_or(first, |start| start.min(first)));
                    end = end.max((trace.end * ticks_per_second).round() as u64);
                }
                // The vendor path uses the full hierarchical name in its ID.
                // This also keeps saved analog selections stable across readers.
                let id = format!("psfxl:{fullname}");
                if !analog_names.insert(fullname.clone()) {
                    continue;
                }
                let (scope, name) = fullname.rsplit_once('.').unwrap_or(("", fullname));
                analog_ids.insert(id.clone(), (partition, *index));
                signals.push(Signal {
                    id,
                    scope: scope.into(),
                    name: name.into(),
                    width: 64,
                    real: true,
                    supported: trace.count != 0,
                    unit: trace.unit.clone(),
                });
            }
        }
        Ok(Self {
            digital,
            source_indexes,
            analog,
            analog_ids,
            ticks_per_second,
            signals,
            warnings,
            start: start.unwrap_or(0),
            end,
            scale,
        })
    }

    pub fn has_analog(&self, id: &str) -> bool {
        self.analog_ids.contains_key(id)
    }

    pub fn scan_analog(
        &self,
        id: &str,
        start: u64,
        end: u64,
        sample: impl FnMut(u64, f64) -> bool,
    ) -> Result<()> {
        let &(part, trace) = self.analog_ids.get(id).ok_or("Unknown PSFXL signal")?;
        self.analog[part].scan(trace, start, end, self.ticks_per_second, sample)
    }

    pub fn query(&self, id: &str, start: u64, end: u64, limit: usize) -> Result<(Events, bool)> {
        self.query_with_order(id, start, end, limit, false)
    }

    pub fn query_with_order(
        &self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
        ordered: bool,
    ) -> Result<(Events, bool)> {
        if self.has_analog(id) {
            let mut events = Events::new();
            let mut truncated = false;
            self.scan_analog(id, start, end, |tick, value| {
                let tick = tick.max(start);
                if !ordered && events.last().is_some_and(|event| event.0 == tick) {
                    events.pop();
                }
                if events.len() == limit {
                    truncated = true;
                    return false;
                }
                events.push((tick, value.to_string()));
                true
            })?;
            return Ok((events, truncated));
        }
        self.digital.as_ref().ok_or("No SST2 partition")?.query(
            id.parse().map_err(|_| "Unknown SST2 signal")?,
            start,
            end,
            limit,
            ordered,
        )
    }

    pub fn hdl_locations(&self) -> Result<Value> {
        let Some(digital) = &self.digital else {
            return Ok(json!([]));
        };
        let Value::Array(mut rows) = digital.locations() else {
            unreachable!()
        };
        let mut by_name: HashMap<String, usize> = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| Some((row["fullname"].as_str()?.to_owned(), index)))
            .collect();
        for path in &self.source_indexes {
            let metadata = match fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("{}: {error}", path.display())),
            };
            if metadata.len() > 256 * 1024 * 1024 {
                return Err(format!("{}: HDL index exceeds 256 MiB", path.display()));
            }
            let reader = fs::File::open(path).map_err(|error| error.to_string())?;
            let document: Value = serde_json::from_reader(std::io::BufReader::new(reader))
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let locations = document["locations"]
                .as_array()
                .filter(|_| document["version"] == 1)
                .ok_or_else(|| format!("{}: invalid HDL index", path.display()))?;
            for overlay in locations {
                let (Some(name), Some(scope)) =
                    (overlay["fullname"].as_str(), overlay["scope"].as_bool())
                else {
                    continue;
                };
                if !by_name.contains_key(name) {
                    let Some((parent, _)) = name.rsplit_once('.') else {
                        continue;
                    };
                    // Accept elaborated declarations under a scope recorded in this database.
                    if !by_name
                        .get(parent)
                        .is_some_and(|index| rows[*index]["scope"] == true)
                    {
                        continue;
                    }
                    by_name.insert(name.into(), rows.len());
                    rows.push(json!({ "fullname": name, "waveName": name, "parent": parent, "scope": scope }));
                }
                let item = &mut rows[by_name[name]];
                if item["scope"] != scope {
                    continue;
                }
                for key in ["declaration", "instance"] {
                    if overlay[key]["file"]
                        .as_str()
                        .is_some_and(|file| !file.is_empty())
                        && overlay[key]["line"].as_u64().is_some_and(|line| line > 0)
                    {
                        item[key] = overlay[key].clone();
                    }
                }
            }
        }
        // Digital split buses and selected struct fields can share a declaration.
        // Only strip a local selector inside the recorded scope.
        for index in 0..rows.len() {
            if rows[index]["scope"] != false || !rows[index]["declaration"].is_null() {
                continue;
            }
            let Some(parent) = rows[index]["parent"].as_str() else {
                continue;
            };
            let Some(name) = rows[index]["fullname"]
                .as_str()
                .and_then(|name| name.strip_prefix(parent))
                .and_then(|name| name.strip_prefix('.'))
            else {
                continue;
            };
            let position = name
                .char_indices()
                .rev()
                .filter(|(_, c)| matches!(c, '.' | '['))
                .find_map(|(position, _)| {
                    let base = format!("{parent}.{}", &name[..position]);
                    let row = &rows[*by_name.get(&base)?];
                    (!row["declaration"].is_null()).then(|| row["declaration"].clone())
                });
            if let Some(position) = position {
                rows[index]["declaration"] = position;
            }
        }
        Ok(Value::Array(rows))
    }

    pub fn cache_stats(&self) -> Option<Value> {
        if self.analog.is_empty() {
            return None;
        }
        let mut memory = psfxl::CacheUsage::default();
        let mut disk = psfxl::CacheUsage::default();
        for analysis in &self.analog {
            let (memory_usage, disk_usage) = analysis.cache_stats();
            memory.add(memory_usage);
            disk.add(disk_usage);
        }
        let mut stats = json!(disk);
        stats["memory"] = json!(memory);
        Some(stats)
    }

    pub fn configure_cache(&self, disk: Option<u64>, memory: Option<u64>) {
        let count = self.analog.len().max(1) as u64;
        let disk = disk.map(|bytes| bytes / count);
        let memory = memory.map(|bytes| (bytes / count).min(isize::MAX as u64) as usize);
        for analysis in &self.analog {
            analysis.configure_cache(disk, memory);
        }
    }
}
