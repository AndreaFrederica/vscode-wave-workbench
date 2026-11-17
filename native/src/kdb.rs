use serde::Serialize;
use std::ffi::{c_char, c_void, CStr, CString};
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
}
extern "C" {
    fn wave_kdb_load(home: *const c_char, path: *const c_char) -> i32;
    fn wave_kdb_error() -> *const c_char;
    fn wave_kdb_instances(
        name: *const c_char,
        cb: extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
        ),
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_resolve(
        name: *const c_char,
        cb: extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
        ),
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_parent(
        name: *const c_char,
        cb: extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
        ),
        user: *mut c_void,
    ) -> i32;
    fn wave_kdb_children(
        name: *const c_char,
        all: i32,
        cb: extern "C" fn(
            *mut c_void,
            *const c_char,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
            *const c_char,
            i32,
            *const c_char,
        ),
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
) {
    unsafe {
        (&mut *(user as *mut Vec<Location>)).push(Location {
            fullname: string(fullname),
            kind: string(kind),
            file: string(file),
            line,
            module: string(module),
            definition_file: string(definition_file),
            definition_line,
            instance: string(instance),
        });
    }
}
fn error() -> String {
    string(unsafe { wave_kdb_error() })
}
pub fn open(path: &str) -> Result<serde_json::Value, String> {
    let home = std::env::var("VERDI_HOME")
        .or_else(|_| std::env::var("NOVAS_HOME"))
        .map_err(|_| "Set VERDI_HOME for NPI/KDB")?;
    let home = CString::new(home).map_err(|_| "Invalid home")?;
    let path = CString::new(path).map_err(|_| "Invalid path")?;
    if unsafe { wave_kdb_load(home.as_ptr(), path.as_ptr()) } == 0 {
        return Err(error());
    }
    Ok(serde_json::json!({"attached":true,"backend":"native-npi-kdb"}))
}
pub fn lookup(name: &str, mode: &str) -> Result<serde_json::Value, String> {
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
    Ok(serde_json::json!(results))
}
