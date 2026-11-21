// SPDX-License-Identifier: MPL-2.0

use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

pub struct Srr {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Srr {
    pub fn start(directory: &Path, dataset: &str, ticks_per_second: f64) -> Result<Self, String> {
        let python = env::var_os("CDS_INST_DIR")
            .map(|home| PathBuf::from(home).join("bin/cdspython"))
            .filter(|path| path.is_absolute() && path.is_file())
            .unwrap_or_else(|| "cdspython".into());
        let mut child = Command::new(python)
            .args(["-u", "-c", include_str!("psfxl_srr.py"), dataset])
            .arg(ticks_per_second.to_string())
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| error.to_string())?;
        let input = child.stdin.take().expect("piped SRR input");
        let output = BufReader::new(child.stdout.take().expect("piped SRR output"));
        Ok(Self {
            child,
            input,
            output,
        })
    }

    pub fn read(&mut self, signal: &str, path: &Path) -> Result<(), String> {
        serde_json::to_writer(&mut self.input, &(signal, path))
            .map_err(|error| error.to_string())?;
        self.input
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        let mut line = String::new();
        loop {
            line.clear();
            if self
                .output
                .read_line(&mut line)
                .map_err(|error| error.to_string())?
                == 0
            {
                return Err("Cadence SRR process exited".into());
            }
            let Some(message) = line.strip_prefix("WW-SRR ") else {
                continue;
            };
            let result: serde_json::Value =
                serde_json::from_str(message).map_err(|error| error.to_string())?;
            return if result["ok"].as_bool() == Some(true) {
                Ok(())
            } else {
                Err(result["error"]
                    .as_str()
                    .unwrap_or("Cadence SRR read failed")
                    .into())
            };
        }
    }

    pub fn exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)) | Err(_))
    }
}

impl Drop for Srr {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
