// SPDX-License-Identifier: MPL-2.0

use serde_json::Value;
use std::{
    cell::RefCell,
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Read},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tempfile::TempDir;
use wavebench_reader::vcd::{Events, Signal};

use crate::overview::Overview;
use crate::psfxl_samples::{MemorySampleCache, SampleCache, SampleWriter};
use crate::psfxl_srr::Srr;

const VIEWPORT_BINS: usize = 3072;
const MAX_CACHED_OVERVIEWS: usize = 64;

struct CachedOverview {
    start: u64,
    end: u64,
    bins: Value,
}

pub struct ShmPsfxl {
    tool: PathBuf,
    directory: TempDir,
    start_tick: u64,
    end_tick: u64,
    tick_unit: (u32, &'static str),
    ticks_per_second: f64,
    names: HashMap<String, String>,
    overviews: RefCell<HashMap<String, CachedOverview>>,
    samples: RefCell<SampleCache>,
    memory_samples: RefCell<MemorySampleCache>,
    dataset: RefCell<Option<String>>,
    srr: RefCell<Option<Srr>>,
    srr_failed: RefCell<std::collections::HashSet<String>>,
    oversized_srr: RefCell<HashMap<String, u64>>,
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

// SimVision opens PSFXL through the SHM result directory and its logFile.
// Exposing only the analog components lets it enumerate the analog catalogue
// and keeps an analog net with a digital namesake bound to the PSFXL data.
fn stage(source: &Path, directory: &Path, selected: Option<&Path>) -> Result<bool, String> {
    let log = source.join("logFile");
    if !log.is_file() {
        return Ok(false);
    }
    let mut components = Vec::new();
    for entry in fs::read_dir(source).map_err(io_error)? {
        let path = entry.map_err(io_error)?.path();
        let kind = path.extension().and_then(|ext| ext.to_str());
        let raw = kind == Some("dat")
            && path
                .with_extension("")
                .extension()
                .is_some_and(|ext| ext == "tran");
        if (kind == Some("psfxl") || raw)
            && selected.is_none_or(|file| {
                file.file_name() == path.file_name()
                    || file.file_name() == path.with_extension("").file_name()
            })
        {
            let data = path.with_extension("");
            let signature = path.with_extension("sig");
            if data.is_file() && signature.is_file() {
                components.extend([path, data, signature]);
            }
        }
    }
    if components.is_empty() {
        return Ok(false);
    }
    fs::create_dir(directory).map_err(io_error)?;
    for component in components.into_iter().chain([log]) {
        let name = component
            .file_name()
            .ok_or("Invalid PSFXL component name")?;
        let target = directory.join(name);
        if component
            .extension()
            .is_some_and(|ext| ext == "psfxl" || ext == "dat")
        {
            symlink(&component, target).map_err(io_error)?;
        } else {
            fs::copy(&component, target).map_err(io_error)?;
        }
    }
    Ok(true)
}

fn csv_header(line: &str) -> Result<Vec<String>, String> {
    let mut fields = Vec::new();
    let mut rest = line.trim_end_matches(['\r', '\n']);
    loop {
        if let Some(quoted) = rest.strip_prefix('"') {
            let mut parts = quoted.splitn(2, '"');
            let mut field = parts.next().unwrap_or_default().to_owned();
            rest = parts.next().ok_or("Unclosed SimVision CSV field")?;
            while let Some(escaped) = rest.strip_prefix('"') {
                let (part, after) = escaped
                    .split_once('"')
                    .ok_or("Unclosed SimVision CSV field")?;
                field.push('"');
                field.push_str(part);
                rest = after;
            }
            fields.push(field);
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            fields.push(rest[..end].to_owned());
            rest = &rest[end..];
        }
        if rest.is_empty() {
            break;
        }
        rest = rest
            .strip_prefix(',')
            .ok_or("Invalid SimVision CSV field")?;
    }
    if fields.first().is_none_or(|name| name != "SimTime") {
        return Err("SimVision CSV is missing the time column".into());
    }
    Ok(fields)
}

fn srr_catalog(directory: &Path) -> Option<(String, Vec<String>)> {
    let tool = env::var_os("CDS_INST_DIR")
        .map(|home| PathBuf::from(home).join("bin/srrutil"))
        .filter(|path| path.is_file())
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| "srrutil".into());
    let output = Command::new(tool)
        .current_dir(directory)
        .args(["-print-signal-name", "-read-only", "-dbase", "analog.shm"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let list = String::from_utf8(output.stdout).ok()?;
    let mut lines = list.lines();
    // Use the CSV catalogue when SRR sees multiple datasets. The CSV
    // exporter applies the same dataset selection as our sample reader.
    let (dataset, count) = lines
        .next()?
        .strip_prefix("#dataset ")?
        .rsplit_once(" nbsignal ")?;
    let expected = count.trim().parse::<usize>().ok()?;
    let names: Vec<_> = lines.map(str::to_owned).collect();
    (!dataset.is_empty()
        && expected != 0
        && names.len() == expected
        && names
            .iter()
            .all(|name| !name.is_empty() && !name.starts_with("#dataset ")))
    .then(|| (dataset.to_owned(), names))
}

impl ShmPsfxl {
    pub fn open(
        source: &Path,
        selected: Option<&Path>,
        span: std::ops::RangeInclusive<u64>,
        tick_unit: (u32, &'static str),
        ticks_per_second: f64,
        signals: &mut Vec<Signal>,
    ) -> Result<Option<Self>, String> {
        if !source.join("logFile").is_file() {
            return Ok(None);
        }
        let directory = tempfile::tempdir().map_err(io_error)?;
        if !stage(
            &source.canonicalize().map_err(io_error)?,
            &directory.path().join("analog.shm"),
            selected,
        )? {
            return Ok(None);
        }
        let tool = env::var_os("XCELIUM_HOME")
            .map(|home| PathBuf::from(home).join("tools/bin/simvisdbutil"))
            .filter(|path| path.is_file())
            .map(|path| path.canonicalize())
            .transpose()
            .map_err(io_error)?
            .unwrap_or_else(|| "simvisdbutil".into());
        let mut reader = Self {
            tool,
            directory,
            start_tick: *span.start(),
            end_tick: *span.end(),
            tick_unit,
            ticks_per_second,
            names: HashMap::new(),
            overviews: RefCell::new(HashMap::new()),
            samples: RefCell::new(SampleCache::default()),
            memory_samples: RefCell::default(),
            dataset: RefCell::new(None),
            srr: RefCell::new(None),
            srr_failed: RefCell::new(std::collections::HashSet::new()),
            oversized_srr: RefCell::default(),
        };
        let exported = match srr_catalog(reader.directory.path()) {
            Some((dataset, names)) => {
                *reader.dataset.get_mut() = Some(dataset);
                names
            }
            None => {
                let mut header = String::new();
                let start = *span.start();
                let (_output, file) = reader.export(start, start.saturating_add(1), None)?;
                BufReader::new(file)
                    .take(4 * 1024 * 1024)
                    .read_line(&mut header)
                    .map_err(io_error)?;
                csv_header(&header)?.into_iter().skip(1).collect()
            }
        };
        if exported.is_empty() {
            return Err("SimVision reported no PSFXL signals".into());
        }
        let mut used: std::collections::HashSet<_> = signals
            .iter()
            .map(|signal| (signal.scope.clone(), signal.name.clone()))
            .collect();
        for full_name in exported {
            if full_name.is_empty() {
                continue;
            }
            let (scope, name) = full_name.rsplit_once('.').unwrap_or(("", &full_name));
            let mut scope = scope.to_owned();
            while !used.insert((scope.clone(), name.to_owned())) {
                scope = if scope.is_empty() {
                    "psfxl".into()
                } else {
                    format!("psfxl.{scope}")
                };
            }
            let id = format!("psfxl:{full_name}");
            signals.push(Signal {
                id: id.clone(),
                scope,
                name: name.into(),
                width: 64,
                real: true,
                unit: None,
                supported: true,
            });
            reader.names.insert(id, full_name);
        }
        Ok(Some(reader))
    }

    fn export(
        &self,
        start: u64,
        end: u64,
        signal: Option<&str>,
    ) -> Result<(TempDir, fs::File), String> {
        let output = tempfile::tempdir_in(self.directory.path()).map_err(io_error)?;
        let csv = output.path().join("samples.csv");
        // A floating-point conversion to seconds can round the last tick past
        // the recorded end. Pass integral values in the waveform's time unit.
        let (factor, unit) = self.tick_unit;
        let timestamp = |tick: u64| format!("{}{unit}", u128::from(tick) * u128::from(factor));
        let end = if end >= self.end_tick {
            "end".to_owned()
        } else {
            timestamp(end)
        };
        let range = format!("{}:{end}", timestamp(start));
        let mut command = Command::new(&self.tool);
        command
            .current_dir(self.directory.path())
            .args(["-nolog", "-csv", "-timeunits", "s", "-range", &range])
            .arg("-output")
            .arg(&csv)
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        if let Some(signal) = signal {
            command.args(["-signal", signal]);
        }
        let result = command
            .arg("analog.shm")
            .output()
            .map_err(|error| format!("Could not start simvisdbutil. Configure Xcelium: {error}"))?;
        if !result.status.success() {
            return Err(format!(
                "simvisdbutil {}: {}",
                result.status,
                String::from_utf8_lossy(&result.stderr).trim()
            ));
        }
        let file = fs::File::open(csv).map_err(io_error)?;
        Ok((output, file))
    }

    pub fn query(
        &self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<(Events, bool), String> {
        let mut samples = Events::new();
        let mut overview: Option<Overview> = None;
        self.scan(id, start, end, |tick, value| {
            if let Some(overview) = &mut overview {
                overview.real(tick, value);
                return;
            }
            if samples
                .last()
                .is_some_and(|(previous, _)| *previous == tick)
            {
                samples.pop();
            }
            if samples.len() == limit {
                // SimVision has already exported the full interval. Reduce
                // the rest of that stream for the viewport, avoiding another
                // export when it asks for an overview.
                let mut summary = Overview::with_real_samples(start, end, VIEWPORT_BINS);
                for (tick, value) in &samples {
                    summary.real(*tick, value.parse().unwrap_or(f64::NAN));
                }
                summary.real(tick, value);
                overview = Some(summary);
                return;
            }
            samples.push((tick, value.to_string()));
        })?;
        let truncated = overview.is_some();
        if let Some(overview) = overview {
            let mut cache = self.overviews.borrow_mut();
            if !cache.contains_key(id) && cache.len() >= MAX_CACHED_OVERVIEWS {
                cache.clear();
            }
            cache.insert(
                id.to_owned(),
                CachedOverview {
                    start,
                    end,
                    bins: overview.finish(),
                },
            );
        }
        Ok((samples, truncated))
    }

    pub fn overview(&self, id: &str, start: u64, end: u64, bins: usize) -> Result<Value, String> {
        if bins == VIEWPORT_BINS {
            if let Some(cached) = self.overviews.borrow().get(id) {
                if cached.start == start && cached.end == end {
                    return Ok(cached.bins.clone());
                }
            }
        }
        let mut overview = if bins > 1 {
            Overview::with_real_samples(start, end, bins)
        } else {
            Overview::new(start, end, bins, true)
        };
        self.scan(id, start, end, |tick, value| {
            overview.real(tick, value);
        })?;
        Ok(overview.finish())
    }

    pub fn cache_stats(&self) -> Value {
        let mut stats = serde_json::json!(self.samples.borrow().stats());
        stats["memory"] = serde_json::json!(self.memory_samples.borrow().stats());
        stats
    }

    pub fn configure_cache(&self, disk: Option<u64>, memory: Option<u64>) {
        if let Some(budget) = disk {
            self.samples.borrow_mut().configure(budget);
        }
        if let Some(budget) = memory {
            self.memory_samples.borrow_mut().configure(budget);
        }
    }

    fn load_srr_samples(&self, id: &str, name: &str, budget: u64) -> Result<bool, String> {
        let mut dataset = self.dataset.borrow_mut();
        let Some(name_of_dataset) = dataset.as_deref() else {
            return Ok(false);
        };
        if budget < 16
            || self.srr_failed.borrow().contains(id)
            || self
                .oversized_srr
                .borrow()
                .get(id)
                .is_some_and(|&size| size > budget)
        {
            return Ok(false);
        }
        let mut srr = self.srr.borrow_mut();
        if srr.is_none() {
            match Srr::start(
                self.directory.path(),
                name_of_dataset,
                self.ticks_per_second,
            ) {
                Ok(worker) => *srr = Some(worker),
                Err(error) => {
                    *dataset = None;
                    return Err(error);
                }
            }
        }
        let temp = tempfile::tempdir_in(self.directory.path()).map_err(io_error)?;
        let file = temp.path().join("samples.bin");
        let worker = srr.as_mut().unwrap();
        if let Err(error) = worker.read(name, &file) {
            if worker.exited() {
                *dataset = None;
                *srr = None;
            } else {
                self.srr_failed.borrow_mut().insert(id.into());
            }
            return Err(error);
        }
        let file = fs::File::open(file).map_err(io_error)?;
        let size = file.metadata().map_err(io_error)?.len();
        if size > budget {
            self.oversized_srr.borrow_mut().insert(id.into(), size);
            return Ok(false);
        }
        self.samples
            .borrow_mut()
            .insert_file(id, self.start_tick, self.end_tick, file)
            .map_err(io_error)?;
        Ok(true)
    }

    fn scan(
        &self,
        id: &str,
        start: u64,
        end: u64,
        mut visit: impl FnMut(u64, f64),
    ) -> Result<(), String> {
        let name = self.names.get(id).ok_or("Unknown PSFXL signal")?;
        if start > self.end_tick {
            return Ok(());
        }
        let mut collector = {
            let mut cache = self.memory_samples.borrow_mut();
            if cache.scan(id, start, end, &mut visit) {
                return Ok(());
            }
            cache.collector(id, start, end)
        };
        self.scan_source(id, name, start, end, |tick, value| {
            if collector
                .as_mut()
                .is_some_and(|buffer| !buffer.push(tick, value))
            {
                collector = None;
            }
            visit(tick, value);
        })?;
        if let Some(collector) = collector {
            self.memory_samples.borrow_mut().insert(collector);
        }
        Ok(())
    }

    fn scan_source(
        &self,
        id: &str,
        name: &str,
        start: u64,
        end: u64,
        mut visit: impl FnMut(u64, f64),
    ) -> Result<(), String> {
        let budget = {
            let mut cache = self.samples.borrow_mut();
            let cached = cache.scan(id, start, end, &mut visit).map_err(io_error)?;
            cache.record_lookup(cached);
            if cached {
                return Ok(());
            }
            cache.stats().budget
        };
        match self.load_srr_samples(id, name, budget) {
            Ok(true)
                if self
                    .samples
                    .borrow_mut()
                    .scan(id, start, end, &mut visit)
                    .map_err(io_error)? =>
            {
                return Ok(());
            }
            Err(error) => eprintln!("PSFXL SRR: {error}; using SimVision export"),
            _ => {}
        }
        // SimVision appends a value at the requested end. Export one extra
        // tick for interior ranges. At the tail, export through the recorded end.
        let (_output, file) = self.export(start, end.saturating_add(1), Some(name))?;
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(io_error)?;
        if csv_header(&line)?.get(1).is_none_or(|label| label != name) {
            return Err(format!("SimVision did not export PSFXL signal {name}"));
        }
        let mut cache = (start < end && budget >= 16)
            .then(|| SampleWriter::new(self.directory.path(), budget).ok())
            .flatten();
        loop {
            line.clear();
            if reader.read_line(&mut line).map_err(io_error)? == 0 {
                break;
            }
            let (seconds, value) = line.split_once(',').ok_or("Invalid SimVision sample")?;
            let seconds: f64 = seconds.parse().map_err(|_| "Invalid SimVision time")?;
            let tick = (seconds * self.ticks_per_second).round();
            if !(0.0..=(u64::MAX as f64)).contains(&tick) {
                return Err("SimVision time is outside the supported range".into());
            }
            let tick = tick as u64;
            if tick > end {
                break;
            }
            let value: f64 = value
                .trim()
                .parse()
                .map_err(|_| "Invalid SimVision real value")?;
            if cache
                .as_mut()
                .is_some_and(|writer| writer.push(tick, value).is_err())
            {
                cache = None;
            }
            visit(tick, value);
        }
        if let Some(cache) = cache {
            self.samples.borrow_mut().insert(id, start, end, cache);
        }
        Ok(())
    }
}
