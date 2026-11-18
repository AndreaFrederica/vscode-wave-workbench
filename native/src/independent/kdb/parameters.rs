// SPDX-License-Identifier: MPL-2.0

use super::archive::{framed, word};
use crate::independent::{
    bytes::{invalid, Cursor, Input},
    codec::Codec,
};
use std::{
    collections::{HashMap, HashSet},
    io,
    path::Path,
};

#[derive(Clone)]
pub(super) enum ParameterValue {
    Integer(u64),
    Text(String),
}

#[derive(Clone)]
pub(super) struct Entry {
    pub flags: u32,
    pub kind: u64,
    pub value: ParameterValue,
    pub aux: u64,
    pub trailer: u64,
}

struct Set {
    entries: HashMap<(u32, u64), Entry>,
    units: HashSet<u32>,
}

#[derive(Default)]
pub(super) struct Parameters {
    sets: HashMap<u64, Set>,
}

impl Parameters {
    pub(super) fn open(directory: &Path, codec: &Codec) -> io::Result<Self> {
        let file = directory.join("_paramSetElabDB");
        if !file.exists() {
            return Ok(Self::default());
        }
        let frames = framed(&file, codec)?;
        let count = frames.len();
        let mut sets = HashMap::new();
        for (frame, (bytes, metadata)) in frames.into_iter().enumerate() {
            let Some([names, set_count, 0, 0]) = metadata else {
                return Err(invalid("Invalid KDB parameter frame metadata"));
            };
            if names > 1_000_000
                || !(1..=31).contains(&set_count)
                || frame + 1 < count && set_count != 31
            {
                return Err(invalid("KDB parameter frame count exceeds bounds"));
            }
            let mut input = Cursor::new(&bytes);
            let mut names = (0..names)
                .map(|_| input.string())
                .collect::<io::Result<Vec<_>>>()?;
            names.insert(0, String::new());
            for slot in 0..set_count {
                let tag = word(&mut input)?;
                let flags = word(&mut input)?;
                let name = word(&mut input)? as usize;
                let records = word(&mut input)? as usize;
                if tag != 32
                    || flags != 0
                    || name >= names.len()
                    || records * 64 > input.remaining().len()
                {
                    return Err(invalid("Invalid KDB parameter set header"));
                }
                let mut total = 0;
                let mut entries = HashMap::new();
                let mut units = HashSet::new();
                while !input.remaining().is_empty() {
                    let tag = word(&mut input)?;
                    if tag == 32 {
                        input.pos -= 4;
                        break;
                    }
                    if !matches!(tag, 33 | 35) {
                        return Err(invalid("Unrecognized KDB parameter record"));
                    }
                    let flags = word(&mut input)?;
                    let unit = input.uint(8)?;
                    let key = input.uint(8)?;
                    let kind = input.uint(8)?;
                    let literal = input.uint(8)? as usize;
                    let aux = input.uint(8)?;
                    let payload = input.uint(8)?;
                    let trailer = input.uint(8)?;
                    total += 1;
                    if tag == 35 || unit == 0 {
                        continue;
                    }
                    let unit = u32::try_from(unit)
                        .map_err(|_| invalid("KDB parameter unit exceeds range"))?;
                    let value = if (matches!(kind & 0xff_ffff, 4 | 5) || kind == 0x305)
                        && literal < names.len()
                        && payload < names.len() as u64
                    {
                        ParameterValue::Text(names[payload as usize].clone())
                    } else {
                        ParameterValue::Integer(payload)
                    };
                    if entries
                        .insert(
                            (unit, key),
                            Entry {
                                flags,
                                kind,
                                value,
                                aux,
                                trailer,
                            },
                        )
                        .is_some()
                    {
                        return Err(invalid("Duplicate KDB parameter entry"));
                    }
                    units.insert(unit);
                }
                if total < records {
                    return Err(invalid("KDB parameter set record count mismatch"));
                }
                sets.insert(
                    33 + frame as u64 * 32 + u64::from(slot),
                    Set { entries, units },
                );
            }
            if !input.remaining().is_empty() {
                return Err(invalid("Unexpected bytes after KDB parameter sets"));
            }
        }
        Ok(Self { sets })
    }

    pub(super) fn entry(&self, reference: u64, unit: u32, key: u64) -> io::Result<Option<Entry>> {
        if reference == 0 {
            return Ok(None);
        }
        let set = self
            .sets
            .get(&(reference >> 1))
            .filter(|_| reference & 1 != 0)
            .ok_or_else(|| invalid("Invalid KDB parameter set reference"))?;
        if !set.units.contains(&unit) {
            return Err(invalid(
                "KDB parameter set does not include the source unit",
            ));
        }
        Ok(set.entries.get(&(unit, key)).cloned())
    }
}
