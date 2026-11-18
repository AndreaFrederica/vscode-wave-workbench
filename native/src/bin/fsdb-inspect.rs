// SPDX-License-Identifier: MPL-2.0

use std::{env, error::Error, io, path::PathBuf};
use wavebench_reader::fsdb_container::Container;

fn main() -> Result<(), Box<dyn Error>> {
    let mut paths = env::args_os().skip(1).map(PathBuf::from);
    let path = match (paths.next(), paths.next()) {
        (Some(path), None) => path,
        _ => return Err("usage: fsdb-inspect <file.fsdb>".into()),
    };
    let container = Container::open(path)?;
    serde_json::to_writer(io::stdout().lock(), &container)?;
    Ok(())
}
