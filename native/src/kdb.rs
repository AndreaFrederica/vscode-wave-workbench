// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use serde::Serialize;
use std::ffi::{c_char, c_void, CStr, CString};
use wavebench_reader::independent::kdb::{InputPortSite, InputPortSource, Session as IndependentKdb};

enum PortExpressionSource {
    Unopened(String),
    Open(Box<IndependentKdb>),
}

#[derive(Default)]
pub struct NativeKdb {
    expressions: Option<PortExpressionSource>,
}
type LocationCallback = extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *const c_char,
    i32,
    *const c_char,
    *const c_char,
    i32,
    *const c_char,
    *const i32,
    *const AliasSource,
    *const ParameterValue,
);
#[repr(C)]
struct AliasSource {
    file: *const c_char,
    line: i32,
    width: i32,
    two_state: i32,
}

#[repr(C)]
struct ParameterValue {
    bits: *const c_char,
    is_signed: bool,
}

#[derive(Serialize)]
struct IntegerParameter {
    bits: String,
    signed: bool,
}

#[derive(Serialize)]
struct SourceLocation {
    file: String,
    line: i32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub fullname: String,
    pub kind: String,
    pub file: String,
    pub line: i32,
    pub module: String,
    pub definition_file: String,
    pub definition_line: i32,
    pub instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_range: Option<[i32; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_width: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_two_state: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interface_declaration: Option<SourceLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameter_value: Option<IntegerParameter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    packed_range: Option<[i32; 2]>,
}

#[derive(Serialize)]
struct PortEndpoint {
    instance: String,
    signal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<[i32; 2]>,
}

#[derive(Serialize)]
struct PortLink {
    from: PortEndpoint,
    to: PortEndpoint,
    file: String,
    line: i32,
}

#[derive(Serialize)]
struct PortGap {
    instance: String,
    signal: String,
    direction: &'static str,
}

#[derive(Serialize)]
struct PortDeclaration {
    instance: String,
    signal: String,
    direction: String,
}

#[derive(Default)]
struct PortScan {
    ports: Vec<PortDeclaration>,
    links: Vec<serde_json::Value>,
    gaps: Vec<PortGap>,
    expressions: Vec<PendingInputPort>,
}

enum PendingSource {
    IndexedBase(String, String),
    Literal { bits: String, signed: bool },
    Expression {
        operands: Vec<(String, String)>,
        complete: bool,
        width: u64,
    },
}

struct PendingInputPort {
    source: PendingSource,
    target: PortEndpoint,
    file: String,
    line: u32,
    width: u64,
}

#[repr(C)]
struct RawPortOperand {
    instance: *const c_char,
    signal: *const c_char,
}

type PortLinkCallback = extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *const i32,
    *const c_char,
    *const c_char,
    *const i32,
    *const c_char,
    i32,
    i32,
    i32,
);
type PortDeclarationCallback =
    extern "C" fn(*mut c_void, *const c_char, *const c_char, *const c_char);
type PortGapCallback = extern "C" fn(*mut c_void, *const c_char, *const c_char, bool);
type PortExpressionCallback = extern "C" fn(
    *mut c_void,
    *const c_char,
    *const c_char,
    *const c_char,
    i32,
    i32,
    i32,
    *const RawPortOperand,
    usize,
    bool,
    *const c_char,
    bool,
);
extern "C" {
    fn wave_kdb_load(home: *const c_char, path: *const c_char) -> i32;
    fn wave_kdb_error() -> *const c_char;
    fn wave_kdb_module_sources(
        callback: extern "C" fn(*mut c_void, *const c_char),
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_interface_member(
        name: *const c_char,
        callback: LocationCallback,
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_interface_users(
        name: *const c_char,
        callback: LocationCallback,
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_ports(
        instance: *const c_char,
        declaration: PortDeclarationCallback,
        link: PortLinkCallback,
        gap: PortGapCallback,
        expression: PortExpressionCallback,
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_instances(
        name: *const c_char,
        cb: LocationCallback,
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_resolve(
        name: *const c_char,
        cb: LocationCallback,
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_parent(
        name: *const c_char,
        cb: LocationCallback,
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_children(
        name: *const c_char,
        all: i32,
        cb: LocationCallback,
        user: *mut c_void,
    ) -> i32;
}
fn string(p: *const c_char) -> String {
    unsafe { CStr::from_ptr(p).to_string_lossy().into_owned() }
}
extern "C" fn location(
    user: *mut c_void,
    fullname: *const c_char,
    kind: *const c_char,
    file: *const c_char,
    line: i32,
    module: *const c_char,
    definition_file: *const c_char,
    definition_line: i32,
    instance: *const c_char,
    interface_range: *const i32,
    alias: *const AliasSource,
    parameter: *const ParameterValue,
) {
    unsafe {
        let alias = alias.as_ref();
        (&mut *(user as *mut Vec<Location>)).push(Location {
            fullname: string(fullname),
            kind: string(kind),
            file: string(file),
            line,
            module: string(module),
            definition_file: string(definition_file),
            definition_line,
            instance: string(instance),
            interface_range: (!interface_range.is_null())
                .then(|| [*interface_range, *interface_range.add(1)]),
            interface_width: alias.map(|source| source.width),
            interface_two_state: alias.map(|source| source.two_state != 0),
            interface_declaration: alias.filter(|source| source.line > 0).map(|source| {
                SourceLocation { file: string(source.file), line: source.line }
            }),
            parameter_value: parameter.as_ref().map(|value| IntegerParameter {
                bits: string(value.bits),
                signed: value.is_signed,
            }),
            packed_range: None,
        });
    }
}
fn error() -> String {
    string(unsafe { wave_kdb_error() })
}

extern "C" fn port_link(
    user: *mut c_void,
    from_instance: *const c_char,
    from_signal: *const c_char,
    from_range: *const i32,
    to_instance: *const c_char,
    to_signal: *const c_char,
    to_range: *const i32,
    file: *const c_char,
    line: i32,
    unresolved_width: i32,
    extension_width: i32,
) {
    let range = |ptr: *const i32| {
        (!ptr.is_null()).then(|| unsafe { [*ptr, *ptr.add(1)] })
    };
    let to = PortEndpoint {
        instance: string(to_instance),
        signal: string(to_signal),
        range: range(to_range),
    };
    let file = string(file);
    let scan = unsafe { &mut *(user as *mut PortScan) };
    if extension_width > 0 {
        use serde_json::json;
        // A zero extension has no source endpoint. A sign extension repeats one source bit.
        let (operands, value) = if from_instance.is_null() {
            let bits = "0".repeat(extension_width as usize);
            (json!([]), json!({"op":"literal", "args":[bits, false]}))
        } else {
            let sign = match range(from_range) {
                Some([bit, _]) => json!({"op":"select", "args":[0, bit, bit]}),
                None => json!({"op":"signal", "args":0}),
            };
            (
                json!([{"instance":string(from_instance), "signal":string(from_signal)}]),
                json!({"op":"repeat", "args":[extension_width, sign]}),
            )
        };
        scan.links.push(json!({
            "to":to, "file":file, "line":line,
            "expression":{"operands":operands, "value":value},
        }));
    } else if unresolved_width > 0 {
        scan.expressions.push(PendingInputPort {
            source: PendingSource::IndexedBase(string(from_instance), string(from_signal)),
            target: to,
            file,
            line: line as u32,
            width: unresolved_width as u64,
        });
    } else {
        scan.links.push(serde_json::json!(PortLink {
            from: PortEndpoint {
                instance: string(from_instance),
                signal: string(from_signal),
                range: range(from_range),
            },
            to,
            file,
            line,
        }));
    }
}

extern "C" fn port_declaration(
    user: *mut c_void,
    instance: *const c_char,
    signal: *const c_char,
    direction: *const c_char,
) {
    unsafe {
        (&mut *(user as *mut PortScan)).ports.push(PortDeclaration {
            instance: string(instance),
            signal: string(signal),
            direction: string(direction),
        });
    }
}

extern "C" fn port_gap(user: *mut c_void, instance: *const c_char, signal: *const c_char, drivers: bool) {
    unsafe {
        (&mut *(user as *mut PortScan)).gaps.push(PortGap {
            instance: string(instance),
            signal: string(signal),
            direction: if drivers { "drivers" } else { "loads" },
        });
    }
}

extern "C" fn port_expression(
    user: *mut c_void,
    target_instance: *const c_char,
    target_signal: *const c_char,
    file: *const c_char,
    line: i32,
    from_width: i32,
    to_width: i32,
    operands: *const RawPortOperand,
    count: usize,
    complete: bool,
    literal: *const c_char,
    literal_signed: bool,
) {
    let source = if literal.is_null() {
        // For an expression the bridge passes a nonempty array valid for this callback.
        let operands = unsafe { std::slice::from_raw_parts(operands, count) };
        PendingSource::Expression {
            operands: operands
                .iter()
                .map(|item| (string(item.instance), string(item.signal)))
                .collect(),
            complete,
            width: from_width as u64,
        }
    } else {
        PendingSource::Literal { bits: string(literal), signed: literal_signed }
    };
    let scan = unsafe { &mut *(user as *mut PortScan) };
    scan.expressions.push(PendingInputPort {
        source,
        target: PortEndpoint {
            instance: string(target_instance),
            signal: string(target_signal),
            range: None,
        },
        file: string(file),
        line: line as u32,
        width: to_width as u64,
    });
}

fn scan_ports(instance: &str) -> Result<(PortScan, bool), String> {
    let name = CString::new(instance).map_err(|_| "Invalid module instance")?;
    let mut scan = PortScan::default();
    let status = unsafe {
        wave_kdb_ports(
            name.as_ptr(),
            port_declaration,
            port_link,
            port_gap,
            port_expression,
            &mut scan as *mut PortScan as *mut c_void,
        )
    };
    if status == 0 {
        return Err(error());
    }
    Ok((scan, status == 2))
}
impl NativeKdb {
    pub fn resolve(&mut self, name: &str) -> Result<serde_json::Value, String> {
        let mut results = lookup_locations(name, "resolve")?;
        for location in results
            .iter_mut()
            .filter(|location| location.fullname == name)
        {
            self.fill_packed_range(location);
        }
        Ok(serde_json::json!(results))
    }

    pub fn interface_member(&mut self, name: &str) -> Result<serde_json::Value, String> {
        let mut results = lookup_locations(name, "interfaceMember")?;
        for location in &mut results {
            self.fill_packed_range(location);
        }
        Ok(serde_json::json!(results))
    }

    fn fill_packed_range(&mut self, location: &mut Location) {
        if location.line <= 0
            || !matches!(location.kind.as_str(), "npiNet" | "npiReg" | "npiBitVar")
        {
            return;
        }
        location.packed_range = self.expression_reader().and_then(|reader| {
            reader.checked_packed_range(
                &location.fullname,
                &location.instance,
                &location.file,
                location.line as u32,
            )
        });
    }

    pub fn ports(&mut self, instance: &str) -> Result<serde_json::Value, String> {
        let (mut scan, truncated) = scan_ports(instance)?;
        let mut links = scan.links;
        let mut constants = Vec::new();
        if !scan.expressions.is_empty() {
            let sites: Vec<_> = scan
                .expressions
                .iter()
                .map(|link| InputPortSite {
                    source: match &link.source {
                        PendingSource::Literal { bits, signed } => InputPortSource::Literal {
                            bits,
                            signed: *signed,
                        },
                        PendingSource::IndexedBase(instance, signal) => {
                            InputPortSource::IndexedBase((instance, signal))
                        }
                        PendingSource::Expression { operands, complete, width } => InputPortSource::Expression {
                            operands,
                            complete: *complete,
                            width: *width,
                        },
                    },
                    target: (&link.target.instance, &link.target.signal),
                    file: &link.file,
                    line: link.line,
                    width: link.width,
                })
                .collect();
            let resolved = if truncated {
                None
            } else {
                self.expression_reader()
                    .and_then(|reader| reader.resolve_input_ports(instance, &sites).ok())
            };
            let mut resolved = resolved.into_iter().flatten();
            for link in scan.expressions {
                if let Some(Some(expression)) = resolved.next() {
                    if matches!(link.source, PendingSource::Literal { .. }) {
                        constants.push(expression);
                    } else {
                        links.push(expression);
                    }
                } else {
                    scan.gaps.push(PortGap {
                        instance: link.target.instance,
                        signal: link.target.signal,
                        direction: "drivers",
                    });
                    let operands = match link.source {
                        PendingSource::Literal { .. } => Vec::new(),
                        PendingSource::IndexedBase(instance, signal) => vec![(instance, signal)],
                        PendingSource::Expression { operands, .. } => operands,
                    };
                    scan.gaps.extend(operands.into_iter().map(|(instance, signal)| PortGap {
                        instance,
                        signal,
                        direction: "loads",
                    }));
                }
            }
        }
        Ok(serde_json::json!({"ports":scan.ports,"links":links,"constants":constants,"gaps":scan.gaps,"truncated":truncated}))
    }

    fn expression_reader(&mut self) -> Option<&mut IndependentKdb> {
        self.expressions = match self.expressions.take() {
            Some(PortExpressionSource::Unopened(path)) => IndependentKdb::open(path)
                .ok()
                .map(|reader| PortExpressionSource::Open(Box::new(reader))),
            source => source,
        };
        match self.expressions.as_mut()? {
            PortExpressionSource::Open(reader) => Some(reader),
            PortExpressionSource::Unopened(_) => None,
        }
    }

    pub fn open(&mut self, path: &str) -> Result<serde_json::Value, String> {
        let home = std::env::var("VERDI_HOME")
            .or_else(|_| std::env::var("NOVAS_HOME"))
            .map_err(|_| "Set VERDI_HOME for NPI/KDB")?;
        let home = CString::new(home).map_err(|_| "Invalid home")?;
        let native_path = CString::new(path).map_err(|_| "Invalid path")?;
        if unsafe { wave_kdb_load(home.as_ptr(), native_path.as_ptr()) } == 0 {
            return Err(error());
        }
        self.expressions = Some(PortExpressionSource::Unopened(path.to_owned()));
        Ok(serde_json::json!({"attached":true,"backend":"native-npi-kdb","portLinks":true,"interfaceMembers":true}))
    }
}
pub fn module_sources() -> Result<serde_json::Value, String> {
    extern "C" fn collect(user: *mut c_void, file: *const c_char) {
        unsafe { (&mut *(user as *mut Vec<String>)).push(string(file)) }
    }
    let mut files = Vec::<String>::new();
    if unsafe { wave_kdb_module_sources(collect, &mut files as *mut _ as *mut c_void) } == 0 {
        return Err(error());
    }
    Ok(serde_json::json!(files))
}
pub fn lookup(name: &str, mode: &str) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!(lookup_locations(name, mode)?))
}

fn lookup_locations(name: &str, mode: &str) -> Result<Vec<Location>, String> {
    let name = CString::new(name).map_err(|_| "Invalid hierarchy name")?;
    let mut results: Vec<Location> = vec![];
    let result = unsafe {
        if mode == "instances" {
            wave_kdb_instances(
                name.as_ptr(),
                location,
                &mut results as *mut _ as *mut c_void,
            )
        } else if mode == "parent" {
            wave_kdb_parent(
                name.as_ptr(),
                location,
                &mut results as *mut _ as *mut c_void,
            )
        } else if mode == "children" || mode == "scopes" {
            wave_kdb_children(
                name.as_ptr(),
                if mode == "scopes" { 1 } else { 0 },
                location,
                &mut results as *mut _ as *mut c_void,
            )
        } else if mode == "interfaceMember" {
            wave_kdb_interface_member(
                name.as_ptr(),
                location,
                &mut results as *mut _ as *mut c_void,
            )
        } else if mode == "interfaceUsers" {
            wave_kdb_interface_users(
                name.as_ptr(),
                location,
                &mut results as *mut _ as *mut c_void,
            )
        } else {
            wave_kdb_resolve(
                name.as_ptr(),
                location,
                &mut results as *mut _ as *mut c_void,
            )
        }
    };
    if result == 0 {
        return Err(error());
    }
    Ok(results)
}
