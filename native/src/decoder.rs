// SPDX-License-Identifier: MPL-2.0

use mlua::{Function, Lua, LuaOptions, LuaSerdeExt, StdLib, Table, Value};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use std::cell::RefCell;
use std::io::{self, BufRead, Read, Write};
use std::rc::Rc;
use std::time::Instant;

const EVENT_BATCH_VERSION: u32 = 2;
const MAX_EVENTS: usize = 4096;
const MAX_VALUE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum TimeEncoding {
    U64,
    Decimal,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchHeader {
    version: u32,
    start: String,
    end: String,
    initial: Vec<Option<String>>,
    real_inputs: Option<Vec<bool>>,
    count: usize,
    time_encoding: TimeEncoding,
    time_bytes: usize,
    value_bytes: usize,
}

impl BatchHeader {
    fn payload_size(&self) -> io::Result<usize> {
        if self.version != EVENT_BATCH_VERSION
            || self.count > MAX_EVENTS
            || self.initial.len() > 64
            || self
                .real_inputs
                .as_ref()
                .is_some_and(|values| values.len() != self.initial.len())
            || self.start.len() > 80
            || self.end.len() > 80
            || self.value_bytes > MAX_VALUE_BYTES
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid decoder batch header",
            ));
        }
        let valid_time_bytes = match self.time_encoding {
            TimeEncoding::U64 => self.time_bytes == self.count * 8,
            TimeEncoding::Decimal => (self.count * 2..=self.count * 81).contains(&self.time_bytes),
        };
        if !valid_time_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid decoder time column size",
            ));
        }
        Ok(self.time_bytes + (self.count * 2 + 1) * 4 + self.value_bytes)
    }
}

fn read_tick<'a>(
    encoding: &TimeEncoding,
    times: &mut &'a [u8],
) -> mlua::Result<std::borrow::Cow<'a, str>> {
    let invalid = || mlua::Error::runtime("Invalid decoder timestamp");
    match encoding {
        TimeEncoding::U64 => {
            let (tick, rest) = times.split_first_chunk::<8>().ok_or_else(invalid)?;
            *times = rest;
            Ok(u64::from_le_bytes(*tick).to_string().into())
        }
        TimeEncoding::Decimal => {
            let (&length, rest) = times.split_first().ok_or_else(invalid)?;
            let length = usize::from(length);
            let (digits, rest) = rest.split_at_checked(length).ok_or_else(invalid)?;
            if length == 0
                || length > 80
                || (length > 1 && digits[0] == b'0')
                || !digits.iter().all(u8::is_ascii_digit)
            {
                return Err(invalid());
            }
            *times = rest;
            Ok(std::str::from_utf8(digits)
                .map_err(mlua::Error::external)?
                .into())
        }
    }
}

struct Runtime {
    lua: Lua,
    module: Table,
    context: Table,
    state: Value,
    transactions: Rc<RefCell<Vec<Json>>>,
    diagnostics: Rc<RefCell<Vec<String>>>,
    virtual_samples: Rc<RefCell<Vec<Json>>>,
    measure: bool,
}

impl Runtime {
    fn new(source: &str, context: Json, measure: bool) -> mlua::Result<Self> {
        let lua = Lua::new_with(
            StdLib::TABLE | StdLib::STRING | StdLib::MATH,
            LuaOptions::default(),
        )?;
        lua.set_memory_limit(64 * 1024 * 1024)?;
        for name in ["dofile", "loadfile", "load", "loadstring", "print"] {
            lua.globals().set(name, Value::Nil)?;
        }
        let context = match lua.to_value(&context)? {
            Value::Table(table) => table,
            _ => return Err(mlua::Error::runtime("Expected decoder context")),
        };
        let transactions = Rc::new(RefCell::new(Vec::new()));
        let output = transactions.clone();
        context.set(
            "emit",
            lua.create_function(move |lua, value: Value| {
                let mut output = output.borrow_mut();
                if output.len() >= 4096 {
                    return Err(mlua::Error::runtime("Decoder transaction limit exceeded"));
                }
                let value: Json = lua.from_value(value)?;
                if value.to_string().len() > 16_384 {
                    return Err(mlua::Error::runtime("Decoder transaction is too large"));
                }
                output.push(value);
                Ok(())
            })?,
        )?;
        let virtual_samples = Rc::new(RefCell::new(Vec::new()));
        let samples = virtual_samples.clone();
        context.set(
            "emitVirtualSample",
            lua.create_function(
                move |_, (id, width, tick, value): (String, u32, String, String)| {
                    let mut samples = samples.borrow_mut();
                    if samples.len() >= 4096
                        || id.len() > 64
                        || tick.len() > 80
                        || value.len() > 256
                    {
                        return Err(mlua::Error::runtime(
                            "Decoder virtual sample limit exceeded",
                        ));
                    }
                    samples.push(json!({ "id": id, "width": width, "tick": tick, "value": value }));
                    Ok(())
                },
            )?,
        )?;
        let diagnostics = Rc::new(RefCell::new(Vec::new()));
        let warnings = diagnostics.clone();
        context.set(
            "reportDiagnostic",
            lua.create_function(move |_, message: String| {
                let mut warnings = warnings.borrow_mut();
                if warnings.len() >= 64 || message.len() > 1024 {
                    return Err(mlua::Error::runtime("Decoder diagnostic limit exceeded"));
                }
                warnings.push(message);
                Ok(())
            })?,
        )?;
        let options: Table = context.get("options")?;
        context.set(
            "getOption",
            lua.create_function(move |_, name: String| options.get::<Value>(name))?,
        )?;
        let inputs: Table = context.get("inputs")?;
        context.set(
            "getInput",
            lua.create_function(move |_, name: String| {
                for input in inputs.clone().sequence_values::<Value>() {
                    if let Value::Table(input) = input? {
                        if input.get::<String>("id")? == name {
                            return Ok(Value::Table(input));
                        }
                    }
                }
                Ok(Value::Nil)
            })?,
        )?;
        let module: Table = lua
            .load(source)
            .set_mode(mlua::chunk::ChunkMode::Text)
            .eval()?;
        module.get::<Function>("decode")?;
        let state = match module.get::<Option<Function>>("init")? {
            Some(init) => init.call(context.clone())?,
            None => Value::Nil,
        };
        Ok(Self {
            lua,
            module,
            context,
            state,
            transactions,
            diagnostics,
            virtual_samples,
            measure,
        })
    }

    fn decode(&self, header: BatchHeader, payload: &[u8]) -> mlua::Result<Json> {
        let prepare_started = self.measure.then(Instant::now);
        let (mut times, rest) = payload.split_at(header.time_bytes);
        let (inputs, rest) = rest.split_at(header.count * 4);
        let (offsets, values) = rest.split_at((header.count + 1) * 4);
        let offset = |index: usize| {
            u32::from_le_bytes(offsets[index * 4..][..4].try_into().unwrap()) as usize
        };
        if offset(0) != 0 || offset(header.count) != values.len() {
            return Err(mlua::Error::runtime("Invalid decoder sample offsets"));
        }

        let events = self.lua.create_table_with_capacity(header.count, 0)?;
        let mut previous_offset = 0;
        for (index, input) in inputs.chunks_exact(4).enumerate() {
            let input = u32::from_le_bytes(input.try_into().unwrap());
            if input as usize >= header.initial.len() {
                return Err(mlua::Error::runtime("Invalid decoder input index"));
            }
            let end = offset(index + 1);
            let value = values
                .get(previous_offset..end)
                .ok_or_else(|| mlua::Error::runtime("Invalid decoder sample offsets"))?;
            previous_offset = end;
            let tick = read_tick(&header.time_encoding, &mut times)?;
            let event = self.lua.create_table()?;
            event.set("tick", tick.as_ref())?;
            event.set("input", input)?;
            if header
                .real_inputs
                .as_ref()
                .is_some_and(|inputs| inputs[input as usize])
            {
                let number = f64::from_le_bytes(
                    value
                        .try_into()
                        .map_err(|_| mlua::Error::runtime("Invalid real decoder sample size"))?,
                );
                event.set(
                    "value",
                    if number.is_finite() {
                        number.to_string()
                    } else {
                        "NaN".into()
                    },
                )?;
                if number.is_finite() {
                    event.set("real", number)?;
                }
            } else {
                event.set(
                    "value",
                    std::str::from_utf8(value).map_err(mlua::Error::external)?,
                )?;
            }
            events.set(index + 1, event)?;
        }
        if !times.is_empty() {
            return Err(mlua::Error::runtime("Trailing decoder timestamp bytes"));
        }
        let batch = self.lua.create_table()?;
        batch.set("start", header.start)?;
        batch.set("end", header.end)?;
        batch.set("initial", self.lua.to_value(&header.initial)?)?;
        if let Some(inputs) = header.real_inputs {
            let initial_real: Vec<_> = header
                .initial
                .iter()
                .zip(inputs)
                .map(|(value, real)| {
                    if real {
                        value
                            .as_deref()
                            .and_then(|value| value.parse::<f64>().ok())
                            .filter(|value| value.is_finite())
                    } else {
                        None
                    }
                })
                .collect();
            batch.set("initialReal", self.lua.to_value(&initial_real)?)?;
        }
        batch.set("events", events)?;
        let started = self.measure.then(Instant::now);
        self.module.get::<Function>("decode")?.call::<()>((
            self.context.clone(),
            self.state.clone(),
            batch,
        ))?;
        let mut result = self.take_result(started);
        if let (Some(started), Some(prepare_started)) = (started, prepare_started) {
            result["preparationMs"] = json!((started - prepare_started).as_secs_f64() * 1000.0);
        }
        Ok(result)
    }

    fn flush(&self) -> mlua::Result<Json> {
        let started = self.measure.then(Instant::now);
        if let Some(flush) = self.module.get::<Option<Function>>("flush")? {
            flush.call::<()>((self.context.clone(), self.state.clone()))?;
        }
        Ok(self.take_result(started))
    }

    fn save(&self) -> mlua::Result<Json> {
        let value: Value = self
            .module
            .get::<Function>("save_state")?
            .call(self.state.clone())?;
        let data: Json = self.lua.from_value(value)?;
        if data.to_string().len() > 64 * 1024 {
            return Err(mlua::Error::runtime("Decoder checkpoint is too large"));
        }
        Ok(data)
    }

    fn restore(&mut self, state: &Json) -> mlua::Result<Json> {
        self.state = self
            .module
            .get::<Function>("restore_state")?
            .call(self.lua.to_value(state)?)?;
        Ok(Json::Null)
    }

    fn take_result(&self, started: Option<Instant>) -> Json {
        let elapsed = started.map(|t| t.elapsed().as_secs_f64() * 1000.0);
        let mut result = json!({
            "transactions": self.transactions.take(),
            "warnings": self.diagnostics.take(),
            "truncated": false,
        });
        if let Some(milliseconds) = elapsed {
            result["engineMs"] = json!(milliseconds);
        }
        let samples = self.virtual_samples.take();
        if !samples.is_empty() {
            result["virtualSamples"] = json!(samples);
        }
        result
    }
}

pub fn run() -> io::Result<()> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut runtime: Option<Runtime> = None;
    let mut input = io::stdin().lock();
    let mut line = String::new();
    let mut payload = Vec::new();
    while input.read_line(&mut line)? != 0 {
        let request: Json = serde_json::from_str(&line)?;
        line.clear();
        let result = match request["method"].as_str() {
            Some("decoderInit") => Runtime::new(
                request["source"].as_str().unwrap_or(""),
                request["context"].clone(),
                request["measure"].as_bool().unwrap_or(false),
            )
            .map(|created| {
                runtime = Some(created);
                json!(EVENT_BATCH_VERSION)
            }),
            Some("decoderBatch") => {
                // An invalid header ends the stream because the next frame boundary is unknown.
                let header = BatchHeader::deserialize(&request)?;
                payload.resize(header.payload_size()?, 0);
                input.read_exact(&mut payload)?;
                runtime
                    .as_ref()
                    .ok_or_else(|| mlua::Error::runtime("Decoder is not initialized"))
                    .and_then(|runtime| runtime.decode(header, &payload))
            }
            Some("decoderFlush") => runtime
                .as_ref()
                .ok_or_else(|| mlua::Error::runtime("Decoder is not initialized"))
                .and_then(Runtime::flush),
            Some("decoderSaveState") => runtime
                .as_ref()
                .ok_or_else(|| mlua::Error::runtime("Decoder is not initialized"))
                .and_then(Runtime::save),
            Some("decoderRestoreState") => runtime
                .as_mut()
                .ok_or_else(|| mlua::Error::runtime("Decoder is not initialized"))
                .and_then(|runtime| runtime.restore(&request["state"])),
            _ => Err(mlua::Error::runtime("Unknown Lua decoder operation")),
        };
        let response = match result {
            Ok(result) => json!({ "id": request["id"], "result": result }),
            Err(error) => json!({ "id": request["id"], "error": error.to_string() }),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}
