mod cache;
mod derived;
#[cfg(fsdb)]
mod kdb;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Write},
};
#[derive(Clone, Serialize)]
struct Signal {
    id: String,
    scope: String,
    name: String,
    width: u32,
    supported: bool,
}
type Events = Vec<(u64, String)>;
#[derive(Default)]
struct Vcd {
    signals: Vec<Signal>,
    data: HashMap<String, Events>,
    end: u64,
    scale: String,
}
fn parse_vcd(text: &str) -> Result<Vcd, String> {
    let mut v = Vcd {
        scale: "1ns".into(),
        ..Vcd::default()
    };
    let mut tokens = text.split_whitespace();
    let mut scopes: Vec<String> = vec![];
    let mut time = 0;
    let mut count = 0;
    while let Some(t) = tokens.next() {
        if t.starts_with('$') {
            if matches!(
                t,
                "$dumpvars" | "$dumpall" | "$dumpon" | "$dumpoff" | "$end"
            ) {
                continue;
            }
            let mut args = vec![];
            let mut ended = false;
            for item in tokens.by_ref() {
                if item == "$end" {
                    ended = true;
                    break;
                }
                args.push(item);
            }
            if !ended {
                return Err("Unterminated VCD directive".into());
            }
            match t {
                "$scope" if args.len() >= 2 => scopes.push(args[1].into()),
                "$upscope" => {
                    scopes.pop();
                }
                "$timescale" => v.scale = args.join(""),
                "$var" if args.len() >= 4 => {
                    let width: u32 = args[1].parse().map_err(|_| "Invalid VCD width")?;
                    if width > 65536 || width == 0 {
                        return Err("Unsupported VCD width".into());
                    }
                    let id = args[2].to_string();
                    v.signals.push(Signal {
                        id: id.clone(),
                        scope: scopes.join("."),
                        name: args[3..].join(""),
                        width,
                        supported: args[0] != "real" && args[0] != "string",
                    });
                    v.data.entry(id).or_default();
                    if v.signals.len() > 200_000 {
                        return Err("VCD signal limit exceeded".into());
                    }
                }
                _ => (),
            }
        } else if let Some(n) = t.strip_prefix('#') {
            let next = n.parse().map_err(|_| "Invalid VCD timestamp")?;
            if next < time {
                return Err("VCD timestamps must be monotonic".into());
            }
            time = next;
            v.end = time;
        } else {
            let (id, value) = if matches!(t.as_bytes()[0], b'b' | b'B' | b'r' | b'R' | b's' | b'S')
            {
                (
                    tokens.next().ok_or("Missing VCD identifier")?,
                    t[1..].to_lowercase(),
                )
            } else if matches!(t.as_bytes()[0], b'0' | b'1' | b'x' | b'X' | b'z' | b'Z') {
                (&t[1..], t[..1].to_lowercase())
            } else {
                return Err(format!("Unsupported VCD token: {t}"));
            };
            if let Some(events) = v.data.get_mut(id) {
                if events.last().map(|e| e.0 == time).unwrap_or(false) {
                    events.pop();
                }
                events.push((time, value));
                count += 1;
                if count > 2_000_000 {
                    return Err("VCD transition limit exceeded (2 million)".into());
                }
            }
        }
    }
    if v.signals.is_empty() {
        return Err("No VCD signals found".into());
    }
    Ok(v)
}
fn window(events: &Events, start: u64, end: u64, limit: usize) -> (Events, bool) {
    let i = events.partition_point(|e| e.0 <= start).saturating_sub(1);
    let tail: Events = events[i..]
        .iter()
        .take_while(|e| e.0 <= end)
        .take(limit + 1)
        .cloned()
        .collect();
    let truncated = tail.len() > limit;
    (tail.into_iter().take(limit).collect(), truncated)
}
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
enum Database {
    Vcd(Vcd),
    #[cfg(fsdb)]
    Fsdb(native::Fsdb),
}
impl Database {
    fn signals(&self) -> &Vec<Signal> {
        match self {
            Self::Vcd(v) => &v.signals,
            #[cfg(fsdb)]
            Self::Fsdb(v) => &v.signals,
        }
    }
    fn open(path: &str) -> Result<Self, String> {
        if path.to_lowercase().ends_with(".fsdb") {
            #[cfg(fsdb)]
            {
                return native::Fsdb::open(path).map(Self::Fsdb);
            }
            #[cfg(not(fsdb))]
            {
                return Err("Rebuild with VERDI_HOME to enable native FSDB".into());
            }
        }
        if fs::metadata(path).map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
            return Err("VCD limit is 128 MiB; use native FSDB for large files".into());
        }
        parse_vcd(&fs::read_to_string(path).map_err(|e| e.to_string())?).map(Self::Vcd)
    }
    fn meta(&self) -> Value {
        let (start, end, scale, backend) = match self {
            Self::Vcd(v) => (0, v.end, &v.scale, "rust-vcd"),
            #[cfg(fsdb)]
            Self::Fsdb(v) => (v.start, v.end, &v.scale, "native-fsdb"),
        };
        json!({"signals":self.signals().iter().take(1500).collect::<Vec<_>>(),"total":self.signals().len(),"start":start.to_string(),"end":end.to_string(),"scale":scale,"backend":backend})
    }
    fn read(&self, id: &str, start: u64, end: u64, limit: usize) -> Result<(Events, bool), String> {
        match self {
            Self::Vcd(v) => Ok(window(
                v.data.get(id).ok_or("Unknown signal")?,
                start,
                end,
                limit,
            )),
            #[cfg(fsdb)]
            Self::Fsdb(v) => v.query(id, start, end, limit),
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
    ) -> Result<Value, String> {
        if ids.len() > 64 || start > end || limit == 0 || limit > 100000 {
            return Err("Invalid query bounds (max 64 signals, 100000 events each)".into());
        }
        let mut output = serde_json::Map::new();
        for id in ids {
            let block = self.read_block(id, start, end, limit)?;
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
            if !s.supported {
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
    query: Option<String>,
    offset: Option<usize>,
    descriptors: Option<Vec<Descriptor>>,
    bytes: Option<usize>,
    definition: Option<derived::Definition>,
    name: Option<String>,
    names: Option<Vec<String>>,
}
fn run(r: Request, db: &mut Option<Store>) -> Result<Value, String> {
    match r.method.as_str() {
        #[cfg(fsdb)]
        "kdbOpen" => kdb::open(&r.path.ok_or("Missing KDB directory")?),
        #[cfg(fsdb)]
        "kdbInstances" => kdb::lookup(&r.query.unwrap_or_default(), "instances"),
        #[cfg(fsdb)]
        "kdbResolve" => kdb::lookup(&r.query.ok_or("Missing hierarchy")?, "resolve"),
        #[cfg(fsdb)]
        "kdbParent" => kdb::lookup(&r.query.unwrap_or_default(), "parent"),
        #[cfg(fsdb)]
        "kdbScopes" => kdb::lookup(&r.query.unwrap_or_default(), "scopes"),
        #[cfg(fsdb)]
        "kdbChildren" => kdb::lookup(&r.query.unwrap_or_default(), "children"),
        "open" => {
            let new = Database::open(&r.path.ok_or("Missing path")?)?;
            let result = new.meta();
            let budget = db
                .as_ref()
                .map(|s| s.cache.stats.budget)
                .unwrap_or(64 * 1024 * 1024);
            *db = Some(Store::new(new, budget));
            Ok(result)
        }
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
        ),
        _ => Err("Unknown method".into()),
    }
}
fn main() {
    let mut db = None;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(r) => {
                let id = r.id.clone();
                match run(r, &mut db) {
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_vectors_and_same_time() {
        let v=parse_vcd("$timescale 10 ps $end $scope module top $end $var wire 1 ! clk $end $var wire 1 ! alias $end $var wire 8 # bus [7:0] $end $upscope $end $enddefinitions $end $dumpvars 0! bx # $end #5 1! 0! b101 # #10 1!").unwrap();
        assert_eq!(v.scale, "10ps");
        assert_eq!(v.signals.len(), 3);
        assert_eq!(v.signals[2].name, "bus[7:0]");
        assert_eq!(v.data["!"][1], (5, "0".into()));
        assert_eq!(window(&v.data["!"], 6, 9, 10).0, vec![(5, "0".into())]);
        assert!(window(&v.data["!"], 0, 10, 1).1);
    }
    #[test]
    fn malformed_and_backward_time() {
        assert!(parse_vcd("$var wire 1 ! a").is_err());
        assert!(parse_vcd("#10 #9").is_err());
    }
    #[test]
    fn empty_and_before_first() {
        assert_eq!(window(&vec![], 0, 10, 1).0.len(), 0);
        assert_eq!(window(&vec![(5, "1".into())], 0, 3, 10).0.len(), 0);
    }
}
