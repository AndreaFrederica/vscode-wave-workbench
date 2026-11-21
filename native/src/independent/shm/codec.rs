// SPDX-License-Identifier: MPL-2.0

use super::{sst2::Slice, Result};
use std::sync::{Arc, OnceLock};

#[derive(Clone)]
pub(super) struct Bits<'a> {
    data: &'a [u8],
    position: usize,
    end: usize,
}

impl<'a> Bits<'a> {
    pub(super) fn new(data: &'a [u8], start: usize, end: usize) -> Result<Self> {
        if start > end || end > data.len() {
            return Err("Invalid SST2 bit stream range".into());
        }
        Ok(Self {
            data,
            position: start * 8,
            end: end * 8,
        })
    }

    pub(super) fn read(&mut self, width: usize) -> Result<u64> {
        let end = self.position + width;
        if width > 64 || end > self.end {
            return Err("Truncated SST2 bit stream".into());
        }
        if width == 0 {
            return Ok(0);
        }
        let start = self.position;
        self.position = end;
        let last = end.div_ceil(8);
        let mut word = 0u128;
        for &byte in &self.data[start / 8..last] {
            word = (word << 8) | u128::from(byte);
        }
        Ok(((word >> (last * 8 - end)) & ((1u128 << width) - 1)) as u64)
    }

    pub(super) fn rewind_two(&mut self) {
        self.position -= 2;
    }

    fn prefix(&mut self, prefix: &Prefix) -> Result<usize> {
        // Prefix tables repeat entries so that a code can be decoded by one
        // lookup. Pad a partial final byte only for the lookup.
        let available = prefix.width.min(self.end - self.position);
        let saved = self.position;
        let index = (self.read(available)? as usize) << (prefix.width - available);
        let (width, value) = prefix.codes[index];
        if width == 17 || width > available {
            return Err(format!("Invalid SST2 prefix at bit {saved}"));
        }
        self.position = saved + width;
        Ok(value)
    }
}

struct Prefix {
    width: usize,
    codes: Vec<(usize, usize)>,
}

impl Prefix {
    fn new(codes: &[(usize, usize, usize)]) -> Result<Self> {
        let width = codes.iter().map(|&(width, _, _)| width).max().unwrap_or(0);
        if width > 16 {
            return Err("Invalid SST2 code width".into());
        }
        let mut table = vec![(17, 0); 1 << width];
        for &(code_width, code, value) in codes {
            let offset = width - code_width;
            let begin = code << offset;
            let end = begin + (1 << offset);
            let slots = table.get_mut(begin..end).ok_or("Invalid SST2 code")?;
            if slots.iter().any(|slot| slot.0 != 17) {
                return Err("Overlapping SST2 prefix codes".into());
            }
            slots.fill((code_width, value));
        }
        Ok(Self {
            width,
            codes: table,
        })
    }

    fn ordered(ranges: &[(usize, usize, usize)]) -> Self {
        let values = ranges
            .iter()
            .flat_map(|&(width, start, end)| (start..end).map(move |code| (width, code)));
        let codes: Vec<_> = values
            .enumerate()
            .map(|(value, (width, code))| (width, code, value))
            .collect();
        Self::new(&codes).unwrap()
    }
}

fn lengths() -> &'static Prefix {
    static TABLE: OnceLock<Prefix> = OnceLock::new();
    TABLE.get_or_init(|| {
        Prefix::ordered(&[
            (4, 0, 3),
            (5, 14, 20),
            (6, 48, 56),
            (4, 3, 7),
            (5, 20, 24),
            (6, 56, 60),
            (9, 480, 496),
            (10, 992, 1012),
        ])
    })
}

fn raw_values() -> &'static Prefix {
    static TABLE: OnceLock<Prefix> = OnceLock::new();
    TABLE.get_or_init(|| {
        Prefix::ordered(&[
            (5, 16, 20),
            (6, 56, 60),
            (7, 120, 128),
            (5, 20, 28),
            (1, 0, 1),
        ])
    })
}

fn modes() -> &'static Prefix {
    static TABLE: OnceLock<Prefix> = OnceLock::new();
    TABLE.get_or_init(|| Prefix::ordered(&[(1, 0, 2)]))
}

fn length(reader: &mut Bits<'_>, table: &Prefix) -> Result<usize> {
    let symbol = reader.prefix(table)?;
    match symbol {
        0..=16 => Ok(symbol),
        17..=44 => {
            let width = symbol - 13;
            usize::try_from((1u64 << width) + reader.read(width)? + 1)
                .map_err(|_| "SST2 length overflows".into())
        }
        _ => Err(format!("Unsupported SST2 extended length symbol {symbol}")),
    }
}

pub(super) fn default_length(reader: &mut Bits<'_>) -> Result<usize> {
    length(reader, lengths())
}

fn code_lengths(reader: &mut Bits<'_>, count: usize) -> Result<Prefix> {
    static TABLE: OnceLock<Prefix> = OnceLock::new();
    let prefix = TABLE.get_or_init(|| {
        let mut codes = vec![(3, 0, 17)];
        codes.extend((2..10).map(|code| (4, code, code + 2)));
        codes.extend(
            (20..32)
                .zip([0, 1, 2, 3, 12, 13, 14, 15, 16, 18, 19, 20])
                .map(|(code, symbol)| (5, code, symbol)),
        );
        Prefix::new(&codes).unwrap()
    });
    let mut widths = Vec::with_capacity(count);
    let mut previous = 1;
    while widths.len() < count {
        let symbol = reader.prefix(prefix)?;
        match symbol {
            0..=16 => {
                previous = symbol;
                widths.push(symbol);
            }
            17 => widths.push(symbol),
            _ => {
                let (bits, base, width) = match symbol {
                    18 => (3, 2, previous),
                    19 => (3, 3, 17),
                    _ => (8, 12, 17),
                };
                let run = base + reader.read(bits)? as usize;
                widths.resize((widths.len() + run).min(count), width);
            }
        }
    }
    let mut ordered: Vec<_> = widths
        .into_iter()
        .enumerate()
        .filter_map(|(i, width)| (width != 17).then_some((width, i)))
        .collect();
    ordered.sort_unstable();
    let mut previous_width = 0;
    let mut code = 0;
    let mut codes = Vec::with_capacity(ordered.len());
    for (width, symbol) in ordered {
        code <<= width - previous_width;
        codes.push((width, code, symbol));
        code += 1;
        previous_width = width;
    }
    Prefix::new(&codes)
}

fn read_table(data: &[u8], offset: usize, end: usize) -> Result<(usize, Prefix)> {
    let mut reader = Bits::new(data, offset, end)?;
    let version = reader.read(4)? as usize;
    let count = reader.read(8)? as usize + 1;
    Ok((version, code_lengths(&mut reader, count)?))
}

struct Selector {
    choices: Prefix,
    tables: Vec<(usize, Prefix)>,
}

pub(super) struct Index {
    global: [Option<Prefix>; 7],
    selectors: [Option<Selector>; 6],
    positions: Vec<usize>,
    sequence_first: bool,
}

impl Index {
    pub(super) fn read(data: &[u8], slice: &Slice) -> Result<Self> {
        let mut index = Self {
            global: std::array::from_fn(|_| None),
            selectors: std::array::from_fn(|_| None),
            positions: Vec::new(),
            sequence_first: true,
        };
        if slice.tables != 0 {
            let mut reader = Bits::new(data, slice.tables, slice.offset)?;
            loop {
                let kind = reader.read(5)? as usize;
                if kind == 0 {
                    break;
                }
                let size = default_length(&mut reader)?;
                match kind {
                    1..=6 if size == 0 => {}
                    1..=6 => {
                        if size > 256 {
                            return Err("Too many SST2 compression tables".into());
                        }
                        let mut tables = Vec::with_capacity(size);
                        for _ in 0..size {
                            let offset = slice
                                .tables
                                .checked_sub(default_length(&mut reader)?)
                                .ok_or("Invalid SST2 compression table reference")?;
                            tables.push(read_table(data, offset, slice.offset)?);
                        }
                        index.selectors[kind - 1] = Some(Selector {
                            choices: code_lengths(&mut reader, size + 1)?,
                            tables,
                        });
                    }
                    9..=15 if size > 0 => {
                        let offset = slice
                            .tables
                            .checked_sub(size)
                            .ok_or("Invalid SST2 global table reference")?;
                        let (version, table) = read_table(data, offset, slice.offset)?;
                        if kind == 10 {
                            match version {
                                0 => index.sequence_first = true,
                                1 => index.sequence_first = false,
                                _ => {
                                    return Err(format!(
                                        "Unsupported SST2 transition table version {version}"
                                    ))
                                }
                            }
                        }
                        index.global[kind - 9] = Some(table);
                    }
                    _ => return Err(format!("Unsupported SST2 compression table kind {kind}")),
                }
            }
        }
        if slice.count == 0 {
            return Ok(index);
        }
        let mut reader = Bits::new(data, slice.variable_index, slice.offset)?;
        if default_length(&mut reader)? != 0 {
            return Err("Unsupported multilevel SST2 variable index".into());
        }
        let padding = default_length(&mut reader)?;
        let mut end = slice.stream_base;
        if slice.count > data.len() {
            return Err("Invalid SST2 stream count".into());
        }
        index.positions.reserve(slice.count + 1);
        index.positions.push(end);
        for _ in 0..slice.count {
            end = end
                .checked_add(length(&mut reader, index.global(13, lengths()))?)
                .ok_or("SST2 stream offset overflows")?;
            if end > slice.variable_index {
                return Err("SST2 variable stream extends beyond its index".into());
            }
            index.positions.push(end);
        }
        if end.checked_add(padding) != Some(slice.variable_index) {
            return Err("SST2 index extent disagrees with its slice".into());
        }
        Ok(index)
    }

    fn global<'a>(&'a self, kind: usize, default: &'a Prefix) -> &'a Prefix {
        self.global[kind - 9].as_ref().unwrap_or(default)
    }

    fn selected<'a>(
        &'a self,
        reader: &mut Bits<'_>,
        kind: usize,
        expected: usize,
        default: Option<&'a Prefix>,
    ) -> Result<Option<&'a Prefix>> {
        let Some(selector) = &self.selectors[kind - 1] else {
            return Ok(default);
        };
        let choice = reader.prefix(&selector.choices)?;
        if choice == 0 {
            return Ok(default);
        }
        let (version, table) = selector
            .tables
            .get(choice - 1)
            .ok_or("Invalid SST2 table choice")?;
        if *version != expected {
            return Err(format!(
                "Unsupported SST2 table version {version} for group {kind}"
            ));
        }
        Ok(Some(table))
    }

    fn stream<'a>(&self, data: &'a [u8], id: usize) -> Result<Option<(Bits<'a>, usize)>> {
        let start = *self
            .positions
            .get(id)
            .ok_or("Invalid SST2 stream reference")?;
        let end = *self
            .positions
            .get(id + 1)
            .ok_or("Invalid SST2 stream reference")?;
        if start == end {
            return Ok(None);
        }
        let mut reader = Bits::new(data, start, end)?;
        let mode = reader.prefix(self.global(10, modes()))?;
        Ok(Some((reader, mode)))
    }

    fn reference(&self, reader: &mut Bits<'_>) -> Result<usize> {
        length(reader, self.global(12, lengths()))
    }

    // Keep carry-in entries so the reader can answer a window beginning
    // between changes without walking the preceding slices.
    fn times<'a>(
        &self,
        data: &'a [u8],
        id: usize,
        start: u64,
        depth: usize,
    ) -> Result<Option<(Bits<'a>, usize, Vec<i128>)>> {
        if depth >= 32 {
            return Err("Cyclic SST2 time reference".into());
        }
        let Some((mut reader, mode)) = self.stream(data, id)? else {
            return Ok(None);
        };
        if matches!(mode, 3 | 7 | 8) {
            let original = reader.clone();
            let ref_id = self.reference(&mut reader)?;
            let Some((_, _, times)) = self.times(data, ref_id, start, depth + 1)? else {
                return Ok(None);
            };
            return Ok(Some((
                if mode == 3 { reader } else { original },
                mode,
                times,
            )));
        }
        if !matches!(mode, 0 | 1 | 4 | 5) {
            return Err(format!("Unsupported SST2 transition mode {mode}"));
        }
        let count = length(&mut reader, self.global(11, lengths()))?;
        if count == 0 {
            return Ok(None);
        }
        if count > 8_000_000 {
            return Err("SST2 transition count exceeds the per-record limit".into());
        }
        let control = self
            .selected(&mut reader, 1, 1, None)?
            .ok_or("Missing SST2 time code table")?;
        let repeats = self.selected(&mut reader, 3, 0, Some(lengths()))?.unwrap();
        let mut deltas = Vec::with_capacity(count);
        while deltas.len() < count {
            let symbol = reader.prefix(control)?;
            match symbol {
                0..=27 => repeat(&mut deltas, symbol, count, &mut reader, repeats)?,
                28..=43 => deltas.push((symbol - 28) as i128),
                44..=103 => {
                    let bits = symbol - 40;
                    deltas.push((1i128 << bits) + i128::from(reader.read(bits)?));
                }
                _ => return Err(format!("Unsupported SST2 time symbol {symbol}")),
            }
        }
        let mut tick = i128::from(start) - if mode & 1 != 0 { 2 * deltas[0] } else { 0 };
        for delta in &mut deltas {
            tick += *delta;
            *delta = tick;
        }
        Ok(Some((reader, mode, deltas)))
    }

    fn unpack_values<'a>(
        &self,
        data: &'a [u8],
        mut reader: Bits<'a>,
        mode: usize,
        start: u64,
        count: usize,
        depth: usize,
    ) -> Result<(Vec<Arc<[u8]>>, Bits<'a>)> {
        if depth >= 32 {
            return Err("Cyclic SST2 value reference".into());
        }
        if matches!(mode, 4 | 5 | 7 | 8) {
            let mut reference = self.reference(&mut reader)?;
            if mode == 7 {
                reference = self.reference(&mut reader)?;
            }
            let Some((source, source_mode, _)) = self.times(data, reference, start, 0)? else {
                return Err("Empty SST2 value reference".into());
            };
            let (values, _) =
                self.unpack_values(data, source, source_mode, start, count, depth + 1)?;
            return Ok((values, reader));
        }
        let free = self
            .selected(&mut reader, 2, 0, Some(raw_values()))?
            .unwrap();
        let repeats = self.selected(&mut reader, 3, 0, Some(lengths()))?.unwrap();
        let widths = self.selected(&mut reader, 4, 0, Some(lengths()))?.unwrap();
        let bytes = self.selected(&mut reader, 5, 0, None)?;
        let mut width = 1;
        let mut values = Vec::with_capacity(count);
        while values.len() < count {
            let symbol = reader.prefix(free)?;
            match symbol {
                0..=21 => repeat(&mut values, symbol, count, &mut reader, repeats)?,
                22 => values.push(Arc::from([])),
                23 | 24 => {
                    if symbol == 23 {
                        width = length(&mut reader, widths)?;
                    }
                    if !(1..=16384).contains(&width) {
                        return Err("Invalid SST2 stored value width".into());
                    }
                    let raw = (0..width)
                        .map(|_| match bytes {
                            Some(table) => Ok(reader.prefix(table)? as u8),
                            None => Ok(reader.read(8)? as u8),
                        })
                        .collect::<Result<Vec<_>>>()?;
                    values.push(Arc::from(raw));
                }
                _ => return Err(format!("Unsupported SST2 value symbol {symbol}")),
            }
        }
        Ok((values, reader))
    }

    fn sequence(&self, reader: &mut Bits<'_>, width: usize, count: usize) -> Result<Vec<u64>> {
        let Some(table) = self.selected(reader, 6, 1, None)? else {
            return (0..count).map(|_| reader.read(width)).collect();
        };
        let repeats = self.selected(reader, 3, 0, Some(lengths()))?.unwrap();
        let mut values = Vec::with_capacity(count);
        while values.len() < count {
            let symbol = reader.prefix(table)?;
            match symbol {
                0..=27 => repeat(&mut values, symbol, count, reader, repeats)?,
                28..=43 => values.push((symbol - 28) as u64),
                44..=103 => {
                    let bits = symbol - 40;
                    values.push((1u64 << bits) + reader.read(bits)?);
                }
                _ => return Err(format!("Unsupported SST2 sequence symbol {symbol}")),
            }
        }
        Ok(values)
    }

    pub(super) fn decode(
        &self,
        data: &[u8],
        slice: &Slice,
        id: usize,
        ordered: bool,
    ) -> Result<Vec<(i128, u64, Arc<[u8]>)>> {
        let Some((mut reader, mode, times)) = self.times(data, id, slice.start, 0)? else {
            return Ok(Vec::new());
        };
        let mut sequences = None;
        if self.sequence_first && slice.sequence_width != 0 {
            // Version 0 places sequence numbers between the timestamps and values.
            sequences = Some(self.sequence(&mut reader, slice.sequence_width, times.len())?);
        }
        let (values, mut after_values) =
            self.unpack_values(data, reader, mode, slice.start, times.len(), 0)?;
        if !self.sequence_first && ordered && slice.sequence_width != 0 {
            sequences =
                Some(self.sequence(&mut after_values, slice.sequence_width, times.len())?);
        }
        if times
            .last()
            .is_some_and(|&tick| tick > i128::from(slice.end))
        {
            return Err(format!(
                "SST2 transition falls outside slice at {:#x}",
                slice.offset
            ));
        }
        Ok(times
            .into_iter()
            .zip(values)
            .enumerate()
            .map(|(index, (time, value))| {
                let sequence = sequences
                    .as_ref()
                    .filter(|_| ordered)
                    .map_or(0, |values| values[index]);
                (time, sequence, value)
            })
            .collect())
    }
}

fn repeat<T: Clone>(
    values: &mut Vec<T>,
    symbol: usize,
    count: usize,
    reader: &mut Bits<'_>,
    table: &Prefix,
) -> Result<()> {
    let length_of_pattern = if symbol <= 15 {
        symbol + 1
    } else {
        let width = symbol - 12;
        (1 << width) + reader.read(width)? as usize + 1
    };
    let copies = length(reader, table)?;
    let remaining = count - values.len();
    let copies = if copies == 0 {
        remaining
    } else {
        copies.min(remaining)
    };
    let offset = values
        .len()
        .checked_sub(length_of_pattern)
        .ok_or("Invalid SST2 repeat range")?;
    for i in 0..copies {
        values.push(values[offset + i % length_of_pattern].clone());
    }
    Ok(())
}
