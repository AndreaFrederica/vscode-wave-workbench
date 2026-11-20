// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

mod cache;
mod derived;
mod spice_raw;
#[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
mod vendor_wave;
#[cfg(fsdb)]
mod kdb;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    io::{self, BufRead, Write},
    sync::Arc,
};
use wavebench_reader::fst::Fst;
use wavebench_reader::vcd::{Events, Signal, Vcd};
#[cfg(fsdb)]
mod native {
    use super::*;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        ptr::NonNull,
    };
    extern "C" {
        fn wave_open(
            path: *const c_char,
            cb: extern "C" fn(*mut c_void, u32, *const c_char, *const c_char, u32, i32),
            user: *mut c_void,
        ) -> *mut c_void;
        fn wave_close(p: *mut c_void);
        fn wave_scale(p: *mut c_void) -> *const c_char;
        fn wave_bound(p: *mut c_void, max: i32) -> u64;
        fn wave_query(
            p: *mut c_void,
            id: u32,
            start: u64,
            end: u64,
            cb: extern "C" fn(*mut c_void, u64, *const c_char) -> i32,
            user: *mut c_void,
        ) -> i32;
    }
    extern "C" fn signal(
        user: *mut c_void,
        id: u32,
        scope: *const c_char,
        name: *const c_char,
        width: u32,
        supported: i32,
    ) {
        unsafe {
            (&mut *(user as *mut Vec<Signal>)).push(Signal {
                id: id.to_string(),
                scope: CStr::from_ptr(scope).to_string_lossy().into_owned(),
                name: CStr::from_ptr(name).to_string_lossy().into_owned(),
                width,
                supported: supported != 0,
                real: supported == 2,
                unit: None,
            });
        }
    }
    struct Collector {
        events: Events,
        limit: usize,
    }
    extern "C" fn event(user: *mut c_void, time: u64, value: *const c_char) -> i32 {
        unsafe {
            let c = &mut *(user as *mut Collector);
            if c.events.len() >= c.limit {
                return 0;
            }
            c.events
                .push((time, CStr::from_ptr(value).to_string_lossy().into_owned()));
        }
        1
    }
    pub struct Fsdb {
        ptr: NonNull<c_void>,
        pub signals: Vec<Signal>,
        pub start: u64,
        pub end: u64,
        pub scale: String,
    }
    impl Fsdb {
        pub fn open(path: &str) -> Result<Self, String> {
            let path = CString::new(path).map_err(|_| "Invalid path")?;
            let mut signals = vec![];
            let ptr = NonNull::new(unsafe {
                wave_open(path.as_ptr(), signal, &mut signals as *mut _ as *mut c_void)
            })
            .ok_or("FSDB Reader failed to open file; check SDK compatibility/licensing")?;
            Ok(Self {
                ptr,
                signals,
                start: unsafe { wave_bound(ptr.as_ptr(), 0) },
                end: unsafe { wave_bound(ptr.as_ptr(), 1) },
                scale: unsafe {
                    CStr::from_ptr(wave_scale(ptr.as_ptr()))
                        .to_string_lossy()
                        .into_owned()
                },
            })
        }
        pub fn query(
            &self,
            id: &str,
            start: u64,
            end: u64,
            limit: usize,
        ) -> Result<(Events, bool), String> {
            let mut c = Collector {
                events: vec![],
                limit,
            };
            let result = unsafe {
                wave_query(
                    self.ptr.as_ptr(),
                    id.parse().map_err(|_| "Invalid id")?,
                    start,
                    end,
                    event,
                    &mut c as *mut _ as *mut c_void,
                )
            };
            if result < 0 {
                return Err(format!(
                    "FSDB signal {id}: unsupported encoding or read failure ({result})"
                ));
            }
            Ok((c.events, result == 1))
        }
    }
    impl Drop for Fsdb {
        fn drop(&mut self) {
            unsafe { wave_close(self.ptr.as_ptr()) }
        }
    }
}
struct IndependentFsdb {
    session: std::cell::RefCell<wavebench_reader::independent::fsdb::Session>,
    signals: Vec<Signal>,
    start: u64,
    end: u64,
    scale: String,
}

impl IndependentFsdb {
    fn open(path: &str) -> Result<Self, String> {
        let session = wavebench_reader::independent::fsdb::Session::open(path)
            .map_err(|err| err.to_string())?;
        let signals = session
            .declarations
            .iter()
            .map(|row| Signal {
                id: row.native_id.to_string(),
                scope: row.scope.clone(),
                name: row.name.clone(),
                width: row.width,
                supported: row.supported,
                real: row.real,
                unit: None,
            })
            .collect();
        Ok(Self {
            signals,
            start: session.container().start,
            end: session.container().end,
            scale: session.container().timescale.clone(),
            session: std::cell::RefCell::new(session),
        })
    }
}

enum Database {
    Raw(spice_raw::SpiceRaw),
    #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
    Vendor(vendor_wave::VendorWave),
    Vcd(Vcd),
    Fst(RefCell<Fst>, Vec<Signal>),
    IndependentFsdb(IndependentFsdb),
    #[cfg(fsdb)]
    Fsdb(native::Fsdb),
}
impl Database {
    fn signals(&self) -> &Vec<Signal> {
        match self {
            #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
            Self::Vendor(v) => &v.signals,
            Self::Raw(v) => &v.signals,
            Self::Vcd(v) => &v.signals,
            Self::Fst(_, signals) => signals,
            Self::IndependentFsdb(v) => &v.signals,
            #[cfg(fsdb)]
            Self::Fsdb(v) => &v.signals,
        }
    }
    fn open(path: &str, independent: bool) -> Result<Self, String> {
        let kind = std::path::Path::new(path).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
        if kind == "wlf" {
            let converter = std::env::var_os("WAVE_WORKBENCH_WLF2VCD")
                .ok_or("Set waveWorkbench.wlf2vcdPath to the installed Questa converter")?;
            if !std::path::Path::new(&converter).is_absolute() {
                return Err("wlf2vcd must be configured with an absolute path".into());
            }
            let input = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
            let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
            let vcd = temp.path().join("trace.vcd");
            let status = std::process::Command::new(converter)
                .arg("-o").arg(&vcd).arg(&input)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .status().map_err(|error| format!("Cannot run wlf2vcd: {error}"))?;
            if !status.success() {
                return Err(format!("wlf2vcd failed: {status}"));
            }
            return Vcd::open(vcd).map(Self::Vcd);
        }
        if matches!(kind.as_str(), "psfascii" | "tran") {
            return spice_raw::SpiceRaw::open_psf(path).map(Self::Raw);
        }
        if kind == "raw" {
            return spice_raw::SpiceRaw::open(path).map(Self::Raw);
        }
        if matches!(kind.as_str(), "shm" | "dsn" | "wdb") {
            #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
            return vendor_wave::VendorWave::open(path, &kind).map(Self::Vendor);
            #[cfg(not(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu")))]
            return Err("SHM and WDB require the Linux x64 SDK reader".into());
        }
        if path.to_lowercase().ends_with(".fst") {
            let mut reader = Fst::open(path)?;
            let signals = std::mem::take(&mut reader.signals);
            return Ok(Self::Fst(RefCell::new(reader), signals));
        }
        if path.to_lowercase().ends_with(".fsdb") {
            if independent {
                return IndependentFsdb::open(path).map(Self::IndependentFsdb);
            }
            #[cfg(fsdb)]
            {
                return native::Fsdb::open(path).map(Self::Fsdb);
            }
            #[cfg(not(fsdb))]
            {
                return Err("Rebuild with VERDI_HOME to enable native FSDB".into());
            }
        }
        Vcd::open(path).map(Self::Vcd)
    }
    fn meta(&self) -> Value {
        let (start, end, scale, backend) = match self {
            #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
            Self::Vendor(v) => (v.start, v.end, v.scale.clone(), v.backend),
            Self::Raw(v) => (v.start, v.end, v.scale.clone(), v.backend),
            Self::Vcd(v) => (0, v.end, v.scale.clone(), "rust-vcd"),
            Self::Fst(reader, _) => {
                let reader = reader.borrow();
                (reader.start, reader.end, reader.scale.clone(), "rust-fst")
            }
            Self::IndependentFsdb(v) => (v.start, v.end, v.scale.clone(), "rust-independent-fsdb"),
            #[cfg(fsdb)]
            Self::Fsdb(v) => (v.start, v.end, v.scale.clone(), "native-fsdb"),
        };
        json!({
            "signals": self.signals().iter().take(1500).collect::<Vec<_>>(),
            "total": self.signals().len(),
            "start": start.to_string(),
            "end": end.to_string(),
            "scale": scale,
            "axis": if scale.ends_with("Hz") { "frequency" } else { "time" },
            "backend": backend,
            "supportsOrderedHistory": matches!(self, Self::Vcd(_) | Self::Fst(_, _)),
        })
    }
    fn read(&self, id: &str, start: u64, end: u64, limit: usize) -> Result<(Events, bool), String> {
        match self {
            #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
            Self::Vendor(v) => v.query(id, start, end, limit),
            Self::Raw(v) => v.query(id, start, end, limit),
            Self::Vcd(v) => v.query(id, start, end, limit),
            Self::Fst(reader, _) => Ok(reader
                .borrow_mut()
                .query(&[id], start, end, limit)?
                .remove(0)),
            #[cfg(fsdb)]
            Self::Fsdb(v) => v.query(id, start, end, limit),
            Self::IndependentFsdb(v) => v
                .session
                .borrow_mut()
                .query(
                    id.parse().map_err(|_| "Invalid FSDB signal ID")?,
                    start,
                    end,
                    limit,
                )
                .map_err(|err| err.to_string()),
        }
    }
}
struct Virtual {
    signal: Signal,
    definition: derived::Definition,
    depth: usize,
}
struct Store {
    virtuals: HashMap<String, Virtual>,
    database: Database,
    cache: cache::Cache,
    ids: HashMap<String, Vec<usize>>,
    search: Option<(String, Vec<usize>)>,
    scope_search: Option<(String, Vec<usize>)>,
}
impl Store {
    fn new(database: Database, budget: usize) -> Self {
        let mut ids: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, s) in database.signals().iter().enumerate() {
            ids.entry(s.id.clone()).or_default().push(i);
        }
        Self {
            database,
            ids,
            virtuals: HashMap::new(),
            cache: cache::Cache::new(budget),
            search: None,
            scope_search: None,
        }
    }
    fn query(
        &mut self,
        ids: &[String],
        start: u64,
        end: u64,
        limit: usize,
        preserve_same_tick: bool,
    ) -> Result<Value, String> {
        if ids.len() > 64 || start > end || limit == 0 || limit > 100000 {
            return Err("Invalid query bounds (max 64 signals, 100000 events each)".into());
        }
        let mut output = serde_json::Map::new();
        let mut physical_blocks = HashMap::new();
        if let Database::Fst(reader, _) = &self.database {
            let mut missing = Vec::new();
            for id in ids {
                if self.virtuals.contains_key(id)
                    || physical_blocks.contains_key(id)
                    || missing.iter().any(|key: &cache::Key| key.signal == *id)
                {
                    continue;
                }
                if !self.signal(id).ok_or("Unknown signal")?.supported {
                    return Err("Unsupported signal encoding".into());
                }
                let key = cache::Key {
                    signal: id.clone(),
                    start,
                    end,
                    limit,
                    ordered: preserve_same_tick,
                };
                if let Some(block) = self.cache.get(&key) {
                    physical_blocks.insert(id.clone(), block);
                } else {
                    missing.push(key);
                }
            }
            if !missing.is_empty() {
                let requests: Vec<_> = missing.iter().map(|key| key.signal.as_str()).collect();
                let decoded = reader.borrow_mut().query_with_order(
                    &requests,
                    start,
                    end,
                    limit,
                    preserve_same_tick,
                )?;
                self.cache.stats.reads += 1;
                for (key, (events, truncated)) in missing.into_iter().zip(decoded) {
                    let block = Arc::new(cache::Block { events, truncated });
                    physical_blocks.insert(key.signal.clone(), block.clone());
                    self.cache.insert(key, block);
                }
            }
        }
        for id in ids {
            let block = match physical_blocks.get(id) {
                Some(block) => block.clone(),
                None if preserve_same_tick
                    && !self.virtuals.contains_key(id)
                    && matches!(self.database, Database::Vcd(_)) =>
                {
                    if !self.signal(id).ok_or("Unknown signal")?.supported {
                        return Err("Unsupported signal encoding".into());
                    }
                    let Database::Vcd(vcd) = &self.database else {
                        unreachable!()
                    };
                    let key = cache::Key {
                        signal: id.clone(),
                        start,
                        end,
                        limit,
                        ordered: true,
                    };
                    if let Some(block) = self.cache.get(&key) {
                        block
                    } else {
                        let (events, truncated) = vcd.query_with_order(id, start, end, limit, true)?;
                        self.cache.stats.reads += 1;
                        let block = Arc::new(cache::Block { events, truncated });
                        self.cache.insert(key, block.clone());
                        block
                    }
                }
                None => self.read_block(id, start, end, limit)?,
            };
            output.insert(id.clone(),json!({"events":block.events.iter().map(|(t,v)|(t.to_string(),v)).collect::<Vec<_>>(),"truncated":block.truncated}));
        }
        Ok(Value::Object(output))
    }
    fn signal(&self, id: &str) -> Option<&Signal> {
        self.ids
            .get(id)
            .map(|i| &self.database.signals()[i[0]])
            .or_else(|| self.virtuals.get(id).map(|v| &v.signal))
    }
    fn define(&mut self, definition: derived::Definition, name: String) -> Result<Value, String> {
        let mut widths = vec![];
        let mut depth = 1;
        for input in &definition.inputs {
            let s = self.signal(&input.id).ok_or("Virtual input not found")?;
            let matches = |s: &Signal| {
                input.scope.as_ref().map(|v| v == &s.scope).unwrap_or(true)
                    && input.name.as_ref().map(|v| v == &s.name).unwrap_or(true)
            };
            let identity_ok = self
                .ids
                .get(&input.id)
                .map(|ids| ids.iter().any(|i| matches(&self.database.signals()[*i])))
                .unwrap_or_else(|| matches(s));
            if !identity_ok {
                return Err("Virtual source identity mismatch".into());
            }
            if !s.supported || s.real {
                return Err("Unsupported virtual operand".into());
            }
            if let Some(bit) = input.bit_offset {
                if bit >= s.width {
                    return Err("Virtual bit outside source width".into());
                }
            }
            widths.push(if input.bit_offset.is_some() {
                1
            } else {
                s.width
            });
            if let Some(v) = self.virtuals.get(&input.id) {
                depth = depth.max(v.depth + 1);
            }
        }
        if depth > 16 {
            return Err("Virtual expression nesting limit is 16".into());
        }
        let width = definition.width(&widths)?;
        let id = definition.id();
        if self.ids.contains_key(&id) {
            return Err("Virtual ID conflicts with a source signal".into());
        }
        if let Some(v) = self.virtuals.get(&id) {
            if v.definition != definition {
                return Err("Virtual definition hash collision".into());
            }
            return Ok(self.virtual_description(v));
        }
        if self.virtuals.len() >= 4096 {
            return Err("Maximum 4096 virtual definitions per waveform".into());
        }
        if definition.real == Some(true)
            && self.virtuals.values()
                .filter(|v| v.signal.real)
                .filter_map(|v| v.definition.samples.as_ref())
                .map(Vec::len)
                .sum::<usize>()
                + definition.samples.as_ref().map_or(0, Vec::len) > 131_072
        {
            return Err("Maximum 131072 derived real samples per waveform".into());
        }
        let signal = Signal {
            id: id.clone(),
            scope: "$virtual".into(),
            name: if name.is_empty() {
                format!("{}_{}", definition.op, &id[9..])
            } else {
                name
            },
            width,
            supported: true,
            real: definition.real == Some(true),
            unit: None,
        };
        let v = Virtual {
            signal,
            definition,
            depth,
        };
        let result = self.virtual_description(&v);
        self.virtuals.insert(id, v);
        Ok(result)
    }
    fn virtual_description(&self, v: &Virtual) -> Value {
        let mut value = json!(v.signal);
        value["definition"] = json!(v.definition);
        value
    }
    fn read_block(
        &mut self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<std::sync::Arc<cache::Block>, String> {
        if !self.signal(id).ok_or("Unknown signal")?.supported {
            return Err("Unsupported signal encoding".into());
        }
        let key = cache::Key {
            signal: id.into(),
            start,
            end,
            limit,
            ordered: false,
        };
        if let Some(block) = self.cache.get(&key) {
            return Ok(block);
        }
        let block = if let Some(v) = self.virtuals.get(id) {
            let def = v.definition.clone();
            let widths: Vec<_> = def
                .inputs
                .iter()
                .map(|i| self.signal(&i.id).unwrap().width)
                .collect();
            let input_limit = limit.min(
                (16 * 1024 * 1024 / widths.iter().map(|w| *w as usize).sum::<usize>().max(1))
                    .max(1),
            );
            let mut blocks = vec![];
            let mut inputs = HashMap::new();
            for input in &def.inputs {
                let block = if let Some(b) = inputs.get(&input.id) {
                    std::sync::Arc::clone(b)
                } else {
                    let b = self.read_block(&input.id, start, end, input_limit)?;
                    inputs.insert(input.id.clone(), b.clone());
                    b
                };
                blocks.push(block);
            }
            derived::compute(&def, &widths, &blocks, start, end, limit)?
        } else {
            let (events, truncated) = self.database.read(id, start, end, limit)?;
            self.cache.stats.reads += 1;
            cache::Block { events, truncated }
        };
        let block = std::sync::Arc::new(block);
        self.cache.insert(key, block.clone());
        Ok(block)
    }
    fn match_names(&self, names: Vec<String>, scope: String) -> Result<Value, String> {
        use std::collections::HashSet;
        if names.len() > 20000 || names.iter().any(|s| s.len() > 4096) {
            return Err("Too many RTL identifiers".into());
        }
        let requested: HashSet<_> = names.iter().cloned().collect();
        let mut matches: HashMap<String, Vec<&Signal>> = HashMap::new();
        let mut truncated = false;
        let mut count = 0;
        let dotted = requested.iter().any(|n| n.contains('.'));
        let tails: HashSet<_> = requested
            .iter()
            .filter_map(|n| n.rsplit_once('.').map(|(_, v)| v))
            .collect();
        let prefix = scope.clone() + ".";
        for s in self.database.signals() {
            let mut base = s.name.trim_start_matches('\\');
            if base.ends_with(']') {
                if let Some(start) = base.rfind('[') {
                    if base[start..].contains(':') {
                        base = &base[..start];
                    }
                }
            }
            if !requested.contains(base) && !tails.contains(base) {
                continue;
            }
            let plain_allowed = scope.is_empty() || s.scope == scope;
            let full = if dotted {
                Some(format!("{}.{}", s.scope, base))
            } else {
                None
            };
            let relative = if !scope.is_empty() {
                s.scope.strip_prefix(&prefix).map(|v| format!("{v}.{base}"))
            } else {
                None
            };
            let mut keys = vec![];
            if plain_allowed && requested.contains(base) {
                keys.push(base.to_string());
            }
            if let Some(full) = full {
                if requested.contains(&full) {
                    keys.push(full);
                }
            }
            if let Some(relative) = relative {
                if requested.contains(&relative) {
                    keys.push(relative);
                }
            }
            for name in keys {
                let rows = matches.entry(name).or_default();
                if rows.contains(&s) {
                    continue;
                }
                if rows.len() >= 200 || count >= 100000 {
                    truncated = true;
                    continue;
                }
                rows.push(s);
                count += 1;
            }
        }
        Ok(json!({"matches":matches,"truncated":truncated}))
    }
    fn scope_signals(&mut self, scope: String, offset: usize, limit: usize) -> Value {
        if self
            .scope_search
            .as_ref()
            .map(|(s, _)| s != &scope)
            .unwrap_or(true)
        {
            let found = self
                .database
                .signals()
                .iter()
                .enumerate()
                .filter(|(_, s)| s.scope == scope)
                .map(|(i, _)| i)
                .collect();
            self.scope_search = Some((scope.clone(), found));
        }
        let found = &self.scope_search.as_ref().unwrap().1;
        json!({"scope":scope,"offset":offset,"total":found.len(),"signals":found.iter().skip(offset).take(limit).map(|&i|&self.database.signals()[i]).collect::<Vec<_>>()})
    }
    fn search(&mut self, query: String, offset: usize, limit: usize) -> Value {
        if self
            .search
            .as_ref()
            .map(|(q, _)| q != &query)
            .unwrap_or(true)
        {
            let found = self
                .database
                .signals()
                .iter()
                .enumerate()
                .filter(|(_, s)| {
                    query.is_empty()
                        || format!("{}.{}", s.scope, s.name)
                            .to_lowercase()
                            .contains(&query)
                })
                .map(|(i, _)| i)
                .collect();
            self.search = Some((query, found));
        }
        let indices = &self.search.as_ref().unwrap().1;
        json!({"signals":indices.iter().skip(offset).take(limit).map(|&i|&self.database.signals()[i]).collect::<Vec<_>>(),"total":indices.len(),"offset":offset})
    }
}
#[derive(Deserialize)]
struct Descriptor {
    id: String,
    scope: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct Request {
    id: Value,
    method: String,
    path: Option<String>,
    signals: Option<Vec<String>>,
    start: Option<String>,
    end: Option<String>,
    limit: Option<usize>,
    #[serde(rename = "preserveSameTick")]
    preserve_same_tick: Option<bool>,
    query: Option<String>,
    offset: Option<usize>,
    descriptors: Option<Vec<Descriptor>>,
    bytes: Option<usize>,
    definition: Option<derived::Definition>,
    name: Option<String>,
    names: Option<Vec<String>>,
}
fn run(
    r: Request,
    db: &mut Option<Store>,
    independent_kdb: Option<&mut Option<wavebench_reader::independent::kdb::Session>>,
    #[cfg(fsdb)] native_kdb: &mut kdb::NativeKdb,
) -> Result<Value, String> {
    let independent = independent_kdb.is_some();
    match r.method.as_str() {
        method if independent && method.starts_with("kdb") => {
            let session = independent_kdb.unwrap();
            if method == "kdbOpen" {
                if session.is_some() {
                    return Err("KDB already attached".into());
                }
                let path = r.path.ok_or("Missing KDB directory")?;
                let opened = wavebench_reader::independent::kdb::Session::open(&path)
                    .map_err(|err| err.to_string())?;
                *session = Some(opened);
                return Ok(json!({"attached":true, "backend":"rust-independent-kdb", "portLinks":true, "interfaceMembers":true, "genericInterfaceTypes":true}));
            }
            let query = if method == "kdbResolve" {
                r.query.ok_or("Missing KDB hierarchy")?
            } else {
                r.query.unwrap_or_default()
            };
            session
                .as_mut()
                .ok_or("No KDB attached")?
                .lookup(method, &query)
                .map_err(|err| err.to_string())
        }
        #[cfg(fsdb)]
        "kdbOpen" => native_kdb.open(&r.path.ok_or("Missing KDB directory")?),
        #[cfg(fsdb)]
        "kdbInstances" => kdb::lookup(&r.query.unwrap_or_default(), "instances"),
        #[cfg(fsdb)]
        "kdbModuleSources" => kdb::module_sources(),
        #[cfg(fsdb)]
        "kdbResolve" => kdb::lookup(&r.query.ok_or("Missing hierarchy")?, "resolve"),
        #[cfg(fsdb)]
        "kdbInterfaceMember" => kdb::lookup(&r.query.ok_or("Missing interface member")?, "interfaceMember"),
        #[cfg(fsdb)]
        "kdbInterfaceUsers" => kdb::lookup(&r.query.ok_or("Missing interface member")?, "interfaceUsers"),
        #[cfg(fsdb)]
        "kdbParent" => kdb::lookup(&r.query.unwrap_or_default(), "parent"),
        #[cfg(fsdb)]
        "kdbScopes" => kdb::lookup(&r.query.unwrap_or_default(), "scopes"),
        #[cfg(fsdb)]
        "kdbChildren" => kdb::lookup(&r.query.unwrap_or_default(), "children"),
        #[cfg(fsdb)]
        "kdbPortLinks" => native_kdb.ports(&r.query.ok_or("Missing module instance")?),
        "open" => {
            let new = Database::open(&r.path.ok_or("Missing path")?, independent)?;
            let result = new.meta();
            let budget = db
                .as_ref()
                .map(|s| s.cache.stats.budget)
                .unwrap_or(64 * 1024 * 1024);
            *db = Some(Store::new(new, budget));
            Ok(result)
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64", target_env = "gnu"))]
        "hdlLocations" => match &db.as_ref().ok_or("No open database")?.database {
            Database::Vendor(wave) => wave.hdl_locations(),
            _ => Ok(json!([])),
        },
        "scopeSignals" => Ok(db.as_mut().ok_or("No open database")?.scope_signals(
            r.query.unwrap_or_default(),
            r.offset.unwrap_or(0),
            r.limit.unwrap_or(512).clamp(1, 1500),
        )),
        "search" => {
            let store = db.as_mut().ok_or("No open database")?;
            Ok(store.search(
                r.query.unwrap_or_default().to_lowercase(),
                r.offset.unwrap_or(0),
                r.limit.unwrap_or(1500).clamp(1, 1500),
            ))
        }
        "cacheStats" => Ok(json!(&db.as_ref().ok_or("No open database")?.cache.stats)),
        "cacheConfigure" => {
            let store = db.as_mut().ok_or("No open database")?;
            store
                .cache
                .configure(r.bytes.unwrap_or(64 * 1024 * 1024).min(512 * 1024 * 1024));
            Ok(json!(&store.cache.stats))
        }
        "describe" => {
            let store = db.as_ref().ok_or("No open database")?;
            let descriptors = r.descriptors.unwrap_or_else(|| {
                r.signals
                    .unwrap_or_default()
                    .into_iter()
                    .map(|id| Descriptor {
                        id,
                        scope: None,
                        name: None,
                    })
                    .collect()
            });
            if descriptors.len() > 100000 {
                return Err("Too many descriptors (max 100000)".into());
            }
            let found: Vec<_> = descriptors
                .iter()
                .filter_map(|d| {
                    if let Some(v) = store.virtuals.get(&d.id) {
                        if d.scope
                            .as_ref()
                            .map(|s| s != &v.signal.scope)
                            .unwrap_or(false)
                            || d.name
                                .as_ref()
                                .map(|s| s != &v.signal.name)
                                .unwrap_or(false)
                        {
                            return None;
                        }
                        return Some(store.virtual_description(v));
                    }
                    store
                        .ids
                        .get(&d.id)
                        .and_then(|indices| {
                            indices
                                .iter()
                                .map(|&i| &store.database.signals()[i])
                                .find(|s| {
                                    d.scope.as_ref().map(|v| v == &s.scope).unwrap_or(true)
                                        && d.name.as_ref().map(|v| v == &s.name).unwrap_or(true)
                                        && r.query
                                            .as_ref()
                                            .map(|q| format!("{}.{}", s.scope, s.name) == *q)
                                            .unwrap_or(true)
                                })
                        })
                        .map(|s| json!(s))
                })
                .collect();
            Ok(json!(found))
        }
        "matchNames" => db
            .as_ref()
            .ok_or("No open database")?
            .match_names(r.names.ok_or("Missing names")?, r.query.unwrap_or_default()),
        "defineVirtual" => {
            let store = db.as_mut().ok_or("No open database")?;
            let signal = store.define(
                r.definition.ok_or("Missing definition")?,
                r.name.unwrap_or_default(),
            )?;
            let mut definitions: Vec<_> = store.virtuals.values().collect();
            definitions.sort_by_key(|v| v.depth);
            Ok(
                json!({"signal":signal,"definitions":definitions.iter().map(|v|store.virtual_description(v)).collect::<Vec<_>>()}),
            )
        }
        "query" => db.as_mut().ok_or("No open database")?.query(
            &r.signals.ok_or("Missing signals")?,
            r.start
                .ok_or("Missing start")?
                .parse()
                .map_err(|_| "Invalid start")?,
            r.end
                .ok_or("Missing end")?
                .parse()
                .map_err(|_| "Invalid end")?,
            r.limit.unwrap_or(20000),
            r.preserve_same_tick.unwrap_or(false),
        ),
        _ => Err("Unknown method".into()),
    }
}
mod decoder;

fn main() {
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "--decoder-lua") {
        if let Err(error) = decoder::run() {
            eprintln!("Lua decoder: {error}");
            std::process::exit(1);
        }
        return;
    }
    let independent = std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--independent");
    let mut db = None;
    let mut kdb = None;
    #[cfg(fsdb)]
    let mut native_kdb = kdb::NativeKdb::default();
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(r) => {
                let id = r.id.clone();
                match run(
                    r,
                    &mut db,
                    independent.then_some(&mut kdb),
                    #[cfg(fsdb)]
                    &mut native_kdb,
                ) {
                    Ok(result) => json!({"id":id,"result":result}),
                    Err(e) => json!({"id":id,"error":e}),
                }
            }
            Err(e) => json!({"id":null,"error":e.to_string()}),
        };
        if writeln!(stdout, "{response}")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}
