// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-env-changed=VERDI_HOME");
    println!("cargo:rerun-if-env-changed=FSDB_LIB_DIR");
    println!("cargo:rerun-if-changed=bridge.cpp");
    println!("cargo:rerun-if-changed=kdb_bridge.cpp");
    println!("cargo:rustc-check-cfg=cfg(fsdb)");
    let Ok(home) = env::var("VERDI_HOME") else {
        return;
    };
    let sdk = PathBuf::from(home).join("share/FsdbReader");
    let lib = env::var("FSDB_LIB_DIR")
        .map(PathBuf::from)
        .unwrap_or(sdk.join("linux64"));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let status = Command::new(env::var("CXX").unwrap_or("/usr/bin/g++".into()))
        .args([
            "-std=c++11",
            "-O2",
            "-fPIC",
            "-DPPORT_LINUX",
            "-DPORT_LINUXAMD64",
            "-c",
            "bridge.cpp",
            "-o",
        ])
        .arg(out.join("bridge.o"))
        .arg("-I")
        .arg(&sdk)
        .status()
        .expect("C++ compiler required");
    assert!(status.success(), "FSDB bridge compilation failed");
    let npi = sdk.parent().unwrap().join("NPI/inc");
    assert!(Command::new("/usr/bin/g++")
        .args(["-std=c++11", "-O2", "-fPIC", "-c", "kdb_bridge.cpp", "-o"])
        .arg(out.join("kdb_bridge.o"))
        .arg("-I")
        .arg(npi)
        .status()
        .unwrap()
        .success());
    assert!(Command::new("ar")
        .arg("crs")
        .arg(out.join("libwave_bridge.a"))
        .arg(out.join("bridge.o"))
        .arg(out.join("kdb_bridge.o"))
        .status()
        .unwrap()
        .success());
    println!("cargo:rustc-cfg=fsdb");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=wave_bridge");
    println!("cargo:rustc-link-search=native={}", lib.display());
    for name in ["nffr", "nsys", "stdc++", "z"] {
        println!("cargo:rustc-link-lib=dylib={name}");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    println!("cargo:rustc-link-arg=-Wl,--no-as-needed,-ldl,-lrt,-lz,-lstdc++,--as-needed");
}
