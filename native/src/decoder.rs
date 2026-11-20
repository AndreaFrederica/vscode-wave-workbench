// SPDX-License-Identifier: MPL-2.0

use mlua::{Function, Lua, LuaOptions, LuaSerdeExt, StdLib, Table, Value};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use std::cell::RefCell;
use std::io::{self, BufRead, Write};
use std::rc::Rc;

#[derive(Deserialize)]
struct Batch {
    start: String,
    end: String,
    initial: Vec<Option<String>>,
    times: Vec<String>,
    inputs: Vec<u32>,
    offsets: Vec<usize>,
    values: String,
}

struct Runtime {
    lua: Lua,
    module: Table,
    context: Table,
    state: Value,
    transactions: Rc<RefCell<Vec<Json>>>,
    diagnostics: Rc<RefCell<Vec<String>>>,
}

impl Runtime {
    fn new(source: &str, context: Json) -> mlua::Result<Self> {
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
        })
    }

    fn decode(&self, input: Batch) -> mlua::Result<Json> {
        let count = input.times.len();
        if count > 4096
            || count != input.inputs.len()
            || input.offsets.len() != count + 1
            || input.offsets.first() != Some(&0)
            || input.offsets.last() != Some(&input.values.len())
            || input.values.len() > 16 * 1024 * 1024
        {
            return Err(mlua::Error::runtime("Invalid Lua decoder batch"));
        }
        let events = self.lua.create_table_with_capacity(count, 0)?;
        for (i, (tick, input_id)) in input.times.into_iter().zip(input.inputs).enumerate() {
            let value = input
                .values
                .get(input.offsets[i]..input.offsets[i + 1])
                .ok_or_else(|| mlua::Error::runtime("Invalid decoder sample offsets"))?;
            let event = self.lua.create_table()?;
            event.set("tick", tick)?;
            event.set("input", input_id)?;
            event.set("value", value)?;
            events.set(i + 1, event)?;
        }
        let batch = self.lua.create_table()?;
        batch.set("start", input.start)?;
        batch.set("end", input.end)?;
        batch.set("initial", self.lua.to_value(&input.initial)?)?;
        batch.set("events", events)?;
        self.module.get::<Function>("decode")?.call::<()>((
            self.context.clone(),
            self.state.clone(),
            batch,
        ))?;
        Ok(self.take_result())
    }

    fn flush(&self) -> mlua::Result<Json> {
        if let Some(flush) = self.module.get::<Option<Function>>("flush")? {
            flush.call::<()>((self.context.clone(), self.state.clone()))?;
        }
        Ok(self.take_result())
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

    fn take_result(&self) -> Json {
        json!({
            "transactions": self.transactions.take(),
            "warnings": self.diagnostics.take(),
            "truncated": false,
        })
    }
}

pub fn run() -> io::Result<()> {
    let mut output = io::BufWriter::new(io::stdout().lock());
    let mut runtime: Option<Runtime> = None;
    for line in io::stdin().lock().lines() {
        let request: Json = serde_json::from_str(&line?)?;
        let result = match request["method"].as_str() {
            Some("decoderInit") => Runtime::new(
                request["source"].as_str().unwrap_or(""),
                request["context"].clone(),
            )
            .map(|created| {
                runtime = Some(created);
                Json::Null
            }),
            Some("decoderBatch") => runtime
                .as_ref()
                .ok_or_else(|| mlua::Error::runtime("Decoder is not initialized"))
                .and_then(|runtime| {
                    serde_json::from_value(request.clone())
                        .map_err(mlua::Error::external)
                        .and_then(|input| runtime.decode(input))
                }),
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
