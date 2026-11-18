// SPDX-License-Identifier: MPL-2.0

use serde::Serialize;
use std::{collections::HashMap, io::Read};

#[derive(Clone, Serialize)]
pub struct Signal {
    pub id: String,
    pub scope: String,
    pub name: String,
    pub width: u32,
    pub supported: bool,
}
pub type Events = Vec<(u64, String)>;
#[derive(Default)]
pub struct Vcd {
    pub signals: Vec<Signal>,
    data: HashMap<String, Events>,
    pub end: u64,
    pub scale: String,
}
pub fn parse_vcd(text: &str) -> Result<Vcd, String> {
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
pub fn window(events: &[(u64, String)], start: u64, end: u64, limit: usize) -> (Events, bool) {
    let i = events.partition_point(|e| e.0 <= start).saturating_sub(1);
    let tail: Events = events[i..]
        .iter()
        .take_while(|e| e.0 <= end)
        .take(limit.saturating_add(1))
        .cloned()
        .collect();
    let truncated = tail.len() > limit;
    (tail.into_iter().take(limit).collect(), truncated)
}

impl Vcd {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|err| err.to_string())?;
        if file.metadata().map_err(|err| err.to_string())?.len() > 128 * 1024 * 1024 {
            return Err("VCD limit is 128 MiB; use native FSDB for large files".into());
        }
        let mut data = String::new();
        file.take(128 * 1024 * 1024 + 1)
            .read_to_string(&mut data)
            .map_err(|err| err.to_string())?;
        if data.len() > 128 * 1024 * 1024 {
            return Err("VCD limit is 128 MiB; use native FSDB for large files".into());
        }
        parse_vcd(&data)
    }

    pub fn query(
        &self,
        id: &str,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<(Events, bool), String> {
        if start > end || !(1..=100000).contains(&limit) {
            return Err("Invalid VCD query bounds".into());
        }
        Ok(window(
            self.data.get(id).ok_or("Unknown signal")?,
            start,
            end,
            limit,
        ))
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
