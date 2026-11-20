// SPDX-License-Identifier: MPL-2.0

use super::{
    super::{
        bytes::{invalid, Cursor, Input},
        codec::{Compression, MAX_BLOCK},
    },
    FileReader,
};
use std::{
    collections::{HashSet, VecDeque},
    io,
    sync::Arc,
};

pub type Events = Vec<(u64, String)>;
const PAGE: usize = 65536;
const STATES: &[u8; 4] = b"01xz";

struct Dictionary {
    mode: usize,
    deltas: Vec<u64>,
}

fn dictionaries(bytes: &[u8]) -> io::Result<Vec<Dictionary>> {
    let mut input = Cursor::new(bytes);
    let mut dictionaries = Vec::new();
    while !input.remaining().is_empty() {
        input.expect(0xfe)?;
        let count = input.uint(4)? as usize;
        let mode = input.byte()? as usize;
        if !(1..=1_000_000).contains(&count) || !matches!(mode, 4 | 8) {
            return Err(invalid("Invalid FSDB time dictionary header"));
        }
        let mut deltas = Vec::with_capacity(count);
        let mut seen = HashSet::new();
        while deltas.len() < count {
            let widths = input.byte()?;
            let group_count = (count - deltas.len()).min(4);
            for i in 0..group_count {
                let size = 1 << ((widths >> (i * 2)) & 3);
                if size > mode {
                    return Err(invalid("FSDB delta exceeds time dictionary width"));
                }
                let delta = timestamp(&mut input, size)?;
                if !seen.insert(delta) {
                    return Err(invalid("Duplicate FSDB time dictionary entry"));
                }
                deltas.push(delta);
            }
            if u16::from(widths) >> (group_count * 2) != 0 {
                return Err(invalid("Nonzero unused time dictionary width bits"));
            }
        }
        if deltas[0] != 0 {
            return Err(invalid("Missing zero entry in FSDB time dictionary"));
        }
        dictionaries.push(Dictionary { mode, deltas });
    }
    Ok(dictionaries)
}

fn timestamp(input: &mut impl Input, size: usize) -> io::Result<u64> {
    let time = input.uint(size)?;
    // The file stores the high word first for full-width timestamps.
    Ok(if size == 8 {
        time.rotate_left(32)
    } else {
        time
    })
}

fn delta(input: &mut impl Input, deltas: &[u64], width: usize) -> io::Result<u64> {
    let index = input.uint(width)? as usize;
    deltas
        .get(index)
        .copied()
        .ok_or_else(|| invalid("FSDB time delta index out of bounds"))
}

struct Packet {
    events: Events,
    max_delta: u64,
    time: u64,
    states: u8,
    count: usize,
}

impl Packet {
    fn new(count: usize) -> Self {
        Self {
            events: Vec::with_capacity(count),
            max_delta: 0,
            time: 0,
            states: 0,
            count,
        }
    }

    fn push(&mut self, value: String, delta: u64, state_flags: u8) -> io::Result<()> {
        if self.events.len() >= self.count {
            return Err(invalid(
                "FSDB value packet exceeds its declared event count",
            ));
        }
        self.time = self
            .time
            .checked_add(delta)
            .ok_or_else(|| invalid("FSDB timestamp overflow"))?;
        if !self.events.is_empty() {
            self.max_delta = self.max_delta.max(delta);
        }
        self.states |= state_flags;
        self.events.push((self.time, value));
        Ok(())
    }

    fn finish(self, states: u8) -> io::Result<(Events, u64)> {
        if self.events.len() != self.count || self.states != states {
            return Err(invalid(
                "FSDB packet event count or four-state flags disagree with record",
            ));
        }
        Ok((self.events, self.max_delta))
    }
}

fn scalar_packet(
    input: &mut impl Input,
    deltas: &[u64],
    count: usize,
    states: u8,
) -> io::Result<(Events, u64)> {
    let mut packet = Packet::new(count);
    let mut history = [(0, 0); 2];
    loop {
        let opcode = input.byte()?;
        let state = opcode & 15;
        if opcode == 0xc1 {
            return packet.finish(states);
        }
        if matches!(opcode, 0x40..=0x50) {
            let repeat = match opcode {
                0x40 => input.uint(1)?,
                0x50 => input.uint(2)?,
                _ => u64::from((opcode & 15) - 1),
            };
            if repeat == 0
                || packet.events.len() < 2
                || !matches!((history[0].0, history[1].0), (1, 2) | (2, 1))
            {
                return Err(invalid(
                    "FSDB clock run requires alternating binary history",
                ));
            }
            let pattern = history;
            for i in 0..repeat as usize {
                let (state, delay) = pattern[i & 1];
                push_scalar(&mut packet, &mut history, state, delay)?;
            }
            continue;
        }
        if !(1..=4).contains(&state) {
            return Err(invalid(format!(
                "Unrecognized FSDB scalar operation {opcode:#x}"
            )));
        }
        let delay = match opcode >> 4 {
            0..=2 => delta(input, deltas, 1 << (opcode >> 4))?,
            3 if packet.events.is_empty() => 0,
            _ => {
                return Err(invalid(format!(
                    "Unrecognized FSDB scalar operation {opcode:#x}"
                )))
            }
        };
        push_scalar(&mut packet, &mut history, state, delay)?;
    }
}

fn push_scalar(
    packet: &mut Packet,
    history: &mut [(u8, u64); 2],
    state: u8,
    delta: u64,
) -> io::Result<()> {
    let flags = match state {
        3 => 8,
        4 => 16,
        _ => 0,
    };
    packet.push(
        char::from(STATES[state as usize - 1]).to_string(),
        delta,
        flags,
    )?;
    *history = [history[1], (state, delta)];
    Ok(())
}

fn vector_packet(
    input: &mut impl Input,
    deltas: &[u64],
    count: usize,
    states: u8,
    width: usize,
) -> io::Result<(Events, u64)> {
    let encoding = input.uint(2)?;
    if !matches!(encoding, 4 | 0x0a | 0x0b | 0x19 | 0x1a) || input.uint(4)? != width as u64 {
        return Err(invalid("FSDB vector width or encoding mismatch"));
    }
    let byte_packed = matches!(encoding, 0x0b | 0x1a);
    let xor = matches!(encoding, 0x19 | 0x1a);
    let plane_bytes = if byte_packed {
        width.div_ceil(8)
    } else {
        width.div_ceil(32) * 4
    };
    let mut packet = Packet::new(count);
    let mut previous_value = vec![0; plane_bytes];
    let mut previous_mask = vec![0; plane_bytes];
    let mut value = vec![0; plane_bytes];
    let mut mask = vec![0; plane_bytes];
    loop {
        let opcode = input.byte()?;
        let delay = match opcode {
            0xc1 => return packet.finish(states),
            0x30 | 0x38 if packet.events.is_empty() && (opcode == 0x30 || encoding != 4) => 0,
            0 | 0x10 | 0x20 => delta(input, deltas, 1 << (opcode >> 4))?,
            8 | 0x18 | 0x28 if encoding != 4 => delta(input, deltas, 1 << (opcode >> 4))?,
            _ => {
                return Err(invalid(format!(
                    "Unrecognized FSDB vector operation {opcode:#x}"
                )))
            }
        };
        if encoding == 4 {
            let literal = input.take(width)?;
            let mut bits = String::with_capacity(width);
            let mut flags = 0;
            for state in literal {
                let byte = STATES
                    .get(*state as usize)
                    .ok_or_else(|| invalid("Invalid four-state literal"))?;
                bits.push(char::from(*byte));
                flags |= match state {
                    2 => 8,
                    3 => 16,
                    _ => 0,
                };
            }
            packet.push(bits, delay, flags)?;
            continue;
        }
        if opcode & 8 != 0 {
            value.copy_from_slice(input.take(plane_bytes)?);
            mask.fill(0);
        } else if byte_packed {
            value.copy_from_slice(input.take(plane_bytes)?);
            mask.copy_from_slice(input.take(plane_bytes)?);
        } else {
            for (m, v) in mask.chunks_exact_mut(4).zip(value.chunks_exact_mut(4)) {
                m.copy_from_slice(input.take(4)?);
                v.copy_from_slice(input.take(4)?);
            }
        }
        let mut flags = 0;
        for i in 0..plane_bytes {
            if xor {
                value[i] ^= previous_value[i];
                mask[i] ^= previous_mask[i];
                previous_value[i] = value[i];
                previous_mask[i] = mask[i];
            }
            // Presence flags cover physical padding as well as the declared bits.
            if value[i] & mask[i] != 0 {
                flags |= 8;
            }
            if !value[i] & mask[i] != 0 {
                flags |= 16;
            }
        }
        let bits: String = (0..width)
            .rev()
            .map(|bit| {
                let local = bit % 8;
                let index = ((mask[bit / 8] >> local & 1) << 1)
                    | ((value[bit / 8] >> local & 1) ^ (mask[bit / 8] >> local & 1));
                char::from(STATES[index as usize])
            })
            .collect();
        packet.push(bits, delay, flags)?;
    }
}

#[derive(Clone, Copy)]
pub(super) enum Encoding {
    Digital(usize),
    Real,
}

fn real_packet(
    input: &mut impl Input,
    deltas: &[u64],
    count: usize,
    states: u8,
) -> io::Result<(Events, u64)> {
    if input.uint(2)? != 0x0304 || input.uint(4)? != 8 || states != 0 {
        return Err(invalid("Unrecognized FSDB real packet header"));
    }
    let mut packet = Packet::new(count);
    loop {
        let opcode = input.byte()?;
        let delay = match opcode {
            0xc1 => return packet.finish(states),
            0x30 if packet.events.is_empty() => 0,
            0 | 0x10 | 0x20 => delta(input, deltas, 1 << (opcode >> 4))?,
            _ => {
                return Err(invalid(format!(
                    "Unrecognized FSDB real operation {opcode:#x}"
                )))
            }
        };
        let bits = input.uint(8)?;
        let sample = f64::from_bits(bits);
        packet.push(format!("{sample:e}"), delay, 0)?;
    }
}

fn packet(
    input: &mut impl Input,
    deltas: &[u64],
    count: usize,
    states: u8,
    encoding: Encoding,
) -> io::Result<(Events, u64)> {
    let Encoding::Digital(width) = encoding else {
        return real_packet(input, deltas, count, states);
    };
    if count.checked_mul(width).is_none_or(|size| size > MAX_BLOCK) {
        return Err(invalid("FSDB packet exceeds decoded bit budget"));
    }
    if width == 1 {
        input.expect(0)?;
        scalar_packet(input, deltas, count, states)
    } else {
        vector_packet(input, deltas, count, states, width)
    }
}

#[derive(Clone, Copy)]
struct Location {
    address: u64,
    state_flags: u8,
}

fn locations(file: &mut FileReader) -> io::Result<Vec<Location>> {
    let start = Cursor::new(&file.read(0x410, 8)?).uint(8)?;
    if start < 0x900 {
        return Err(invalid("FSDB index-location pointer outside data region"));
    }
    let size = Cursor::new(&file.read(start, 8)?).uint(8)?;
    if !(12..=MAX_BLOCK as u64).contains(&size) || size > file.container.file_bytes - start {
        return Err(invalid("FSDB index-location section exceeds bounds"));
    }
    let packed = file.read(start + 8, size as usize - 8)?;
    let mut cursor = Cursor::new(&packed);
    let mut bytes = Vec::new();
    while !cursor.remaining().is_empty() {
        let length = cursor.uint(4)? as usize;
        let block = file
            .codec
            .fsdb(Compression::Lzo1c, cursor.take(length)?, None)?;
        if !cursor.remaining().is_empty() && block.len() != 1_048_572 {
            return Err(invalid("Unrecognized FSDB index-location block capacity"));
        }
        if bytes.len() + block.len() > MAX_BLOCK {
            return Err(invalid("FSDB index-location table exceeds bounds"));
        }
        bytes.extend(block);
    }
    if bytes.len() as u64 != (u64::from(file.container.header_max_id) + 1) * 9 {
        return Err(invalid(
            "FSDB index-location length disagrees with the header",
        ));
    }
    let mut cursor = Cursor::new(&bytes);
    let mut records = Vec::with_capacity(bytes.len() / 9);
    while !cursor.remaining().is_empty() {
        let address = cursor.uint(8)?;
        let flags = cursor.byte()?;
        if flags & !3 != 0 || records.is_empty() && address != 0 {
            return Err(invalid(
                "Invalid FSDB index-location flags or initial address",
            ));
        }
        records.push(Location {
            address,
            state_flags: flags << 3,
        });
    }
    Ok(records)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PageKind {
    Index,
    Value,
}

struct PageCache {
    pages: VecDeque<((PageKind, usize, usize), Arc<[u8]>)>,
    used: usize,
}

impl PageCache {
    fn get(
        &mut self,
        file: &mut FileReader,
        kind: PageKind,
        window: usize,
        page: usize,
    ) -> io::Result<Arc<[u8]>> {
        let key = (kind, window, page);
        if let Some(index) = self.pages.iter().position(|(stored, _)| *stored == key) {
            let entry = self.pages.remove(index).unwrap();
            let bytes = entry.1.clone();
            self.pages.push_back(entry);
            return Ok(bytes);
        }
        let window_blocks = file
            .container
            .windows
            .get(window)
            .ok_or_else(|| invalid("FSDB page window out of bounds"))?;
        let (blocks, compression) = match kind {
            PageKind::Index => (&window_blocks.indexes, Compression::Lzo1x),
            PageKind::Value => (&window_blocks.values, Compression::ZlibLzo1c),
        };
        let block = blocks
            .get(page)
            .ok_or_else(|| invalid("FSDB record continues beyond its page table"))?;
        let bytes: Arc<[u8]> = file
            .block_at(block.offset, block.stored_bytes, compression)?
            .into();
        if bytes.is_empty()
            || bytes.len() > PAGE
            || kind == PageKind::Index && window == 0 && page == 0 && bytes[0] != 0x11
        {
            return Err(invalid("Invalid FSDB data page"));
        }
        while self.used + bytes.len() > 24 * 1024 * 1024 {
            self.used -= self.pages.pop_front().unwrap().1.len();
        }
        self.used += bytes.len();
        self.pages.push_back((key, bytes.clone()));
        Ok(bytes)
    }
}

struct PagedInput<'a> {
    file: &'a mut FileReader,
    cache: &'a mut PageCache,
    kind: PageKind,
    window: usize,
    page_index: usize,
    page: Arc<[u8]>,
    position: usize,
    total: usize,
    scratch: Vec<u8>,
}

impl<'a> PagedInput<'a> {
    fn new(
        file: &'a mut FileReader,
        cache: &'a mut PageCache,
        kind: PageKind,
        window: usize,
        page_index: usize,
        position: usize,
    ) -> io::Result<Self> {
        let page = cache.get(file, kind, window, page_index)?;
        if position >= page.len() {
            return Err(invalid("FSDB record points to the unmapped tail of a page"));
        }
        Ok(Self {
            file,
            cache,
            kind,
            window,
            page_index,
            page,
            position,
            total: 0,
            scratch: Vec::new(),
        })
    }
}

impl Input for PagedInput<'_> {
    fn take(&mut self, count: usize) -> io::Result<&[u8]> {
        self.total = self
            .total
            .checked_add(count)
            .filter(|&total| total <= MAX_BLOCK)
            .ok_or_else(|| invalid("FSDB record exceeds byte budget"))?;
        if count <= self.page.len() - self.position {
            let begin = self.position;
            self.position += count;
            return Ok(&self.page[begin..self.position]);
        }
        self.scratch.clear();
        while self.scratch.len() < count {
            let amount = (self.page.len() - self.position).min(count - self.scratch.len());
            self.scratch
                .extend_from_slice(&self.page[self.position..self.position + amount]);
            self.position += amount;
            if self.scratch.len() == count {
                break;
            }
            if self.kind == PageKind::Value && self.page.len() != PAGE {
                return Err(invalid("FSDB value record extends past a short page"));
            }
            self.page_index += 1;
            self.page = self
                .cache
                .get(self.file, self.kind, self.window, self.page_index)?;
            self.position = 0;
        }
        Ok(&self.scratch)
    }
}

pub(super) struct EventReader {
    table: Vec<Location>,
    dictionaries: Vec<Dictionary>,
    index_bases: Vec<usize>,
    cache: PageCache,
}

impl EventReader {
    pub(super) fn open(file: &mut FileReader) -> io::Result<Self> {
        let bytes = file.read(
            file.container.dictionary_offset,
            file.container.dictionary_stored_bytes as usize,
        )?;
        let dictionary = file.codec.fsdb(
            Compression::Lzo1c,
            &bytes,
            Some(file.container.dictionary_decoded_bytes as usize),
        )?;
        let dictionaries = dictionaries(&dictionary)?;
        if dictionaries.len() != file.container.windows.len() {
            return Err(invalid("FSDB time dictionary/window count mismatch"));
        }
        let mut index_bases = vec![0usize];
        for window in &file.container.windows {
            index_bases.push(index_bases.last().unwrap() + window.indexes.len());
        }
        Ok(Self {
            table: locations(file)?,
            dictionaries,
            index_bases,
            cache: PageCache {
                pages: VecDeque::new(),
                used: 0,
            },
        })
    }

    fn record(
        &mut self,
        file: &mut FileReader,
        address: u64,
        encoding: Encoding,
        latest: u64,
    ) -> io::Result<(Events, u64, u8)> {
        let page = (address >> 16) as usize;
        let window = index_window(&self.index_bases, page)?;
        let local = page - self.index_bases[window];
        let position = (address & 0xffff) as usize;
        let mut input = PagedInput::new(
            file,
            &mut self.cache,
            PageKind::Index,
            window,
            local,
            position,
        )?;
        let dictionary = &self.dictionaries[window];
        let flags = input.uint(2)?;
        let backwards = input.uint(1 << (flags & 3))?;
        let previous = if backwards == 0 {
            0
        } else {
            address
                .checked_sub(backwards)
                .ok_or_else(|| invalid("FSDB backward record link underflows"))?
        };
        if previous != 0 && index_window(&self.index_bases, (previous >> 16) as usize)? >= window {
            return Err(invalid("FSDB backlink does not refer to an earlier window"));
        }

        if flags & 0xc0 == 0xc0 {
            let count = (flags >> 8) as usize;
            let states = (flags & 0x18) as u8;
            let wide = flags & 4 != 0;
            if !(1..=8).contains(&count)
                || if wide {
                    dictionary.mode != 8
                        || previous == 0
                        || !matches!(encoding, Encoding::Digital(1) | Encoding::Real)
                        || flags & 0x20 != 0
                } else {
                    dictionary.mode != 4 || flags & 0x20 != 0
                }
            {
                return Err(invalid("Unrecognized FSDB inline event record"));
            }
            let (events, _) = packet(&mut input, &dictionary.deltas, count, states, encoding)?;
            return Ok((events, previous, states));
        }
        if flags & !0x3fff != 0 {
            return Err(invalid("Unrecognized FSDB external event record flags"));
        }
        let value_address = input.uint(1 << ((flags >> 2) & 3))?;
        let max_delta = timestamp(&mut input, 1 << ((flags >> 4) & 3))?;
        let count = input.uint(1 << ((flags >> 6) & 3))?;
        let first_time = timestamp(&mut input, 1 << ((flags >> 8) & 3))?;
        let last_time = timestamp(&mut input, 1 << ((flags >> 10) & 3))?;
        if !(1..=1_000_000).contains(&count) || first_time > last_time {
            return Err(invalid("Invalid FSDB external event count or bounds"));
        }
        let states = ((flags >> 9) & 0x18) as u8;
        let value_page = (value_address >> 16)
            .checked_sub(u64::from(file.container.windows[window].value_page_base))
            .ok_or_else(|| invalid("FSDB value page precedes the window"))?
            as usize;
        if value_page >= file.container.windows[window].values.len() {
            return Err(invalid("FSDB value page lies outside the window"));
        }
        if first_time > latest {
            return Ok((Vec::new(), previous, states));
        }
        let mut values = PagedInput::new(
            file,
            &mut self.cache,
            PageKind::Value,
            window,
            value_page,
            (value_address & 0xffff) as usize,
        )?;
        let (events, actual_delta) = packet(
            &mut values,
            &dictionary.deltas,
            count as usize,
            states,
            encoding,
        )?;
        if actual_delta != max_delta
            || events[0].0 != first_time
            || events.last().unwrap().0 != last_time
        {
            return Err(invalid(
                "FSDB event timestamps disagree with record metadata",
            ));
        }
        Ok((events, previous, states))
    }

    pub(super) fn indexed(&self, signal: u32) -> bool {
        self.table
            .get(signal as usize)
            .is_some_and(|entry| entry.address != 0)
    }

    pub(super) fn events(
        &mut self,
        file: &mut FileReader,
        signal: u32,
        encoding: Encoding,
        start: u64,
        end: u64,
    ) -> io::Result<Events> {
        let location = *self
            .table
            .get(signal as usize)
            .ok_or_else(|| invalid("Unknown FSDB signal ID"))?;
        let mut address = location.address;
        let mut segments = Vec::new();
        let mut states = 0;
        while address != 0 {
            let (segment, previous, flags) = self.record(file, address, encoding, end)?;
            states |= flags;
            address = previous;
            if let Some(first) = segment.first() {
                let seeded = first.0 <= start;
                segments.push(segment);
                if seeded {
                    break;
                }
            }
        }
        if start == 0 && end == u64::MAX && states != location.state_flags {
            return Err(invalid(
                "FSDB event chain flags disagree with index-location table",
            ));
        }
        let events: Events = segments.into_iter().rev().flatten().collect();
        if events.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
            return Err(invalid("FSDB event chain time does not increase"));
        }
        Ok(events)
    }
}

fn index_window(bases: &[usize], page: usize) -> io::Result<usize> {
    if page >= *bases.last().unwrap() {
        return Err(invalid("FSDB index page is out of bounds"));
    }
    Ok(bases.partition_point(|&base| base <= page) - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_value_packet_preserves_samples_and_checks_boundaries() {
        let mut bytes = vec![4, 3, 8, 0, 0, 0, 0x30];
        bytes.extend_from_slice(&(-0.125_f64).to_le_bytes());
        bytes.extend_from_slice(&[0, 1]);
        bytes.extend_from_slice(&(0.9_f64).to_le_bytes());
        bytes.push(0xc1);
        let (samples, largest_delta) =
            real_packet(&mut Cursor::new(&bytes), &[0, 14], 2, 0).unwrap();
        assert_eq!(samples, [(0, "-1.25e-1".into()), (14, "9e-1".into())]);
        assert_eq!(largest_delta, 14);
        assert!(real_packet(&mut Cursor::new(&bytes), &[0], 2, 0).is_err());
        assert!(real_packet(&mut Cursor::new(&bytes[..bytes.len() - 1]), &[0, 14], 2, 0).is_err());
        assert!(real_packet(&mut Cursor::new(&bytes), &[0, 14], 1, 0).is_err());
    }
}
