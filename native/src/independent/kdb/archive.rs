// SPDX-License-Identifier: MPL-2.0

use crate::independent::{
    bytes::{invalid, le, Cursor, Input},
    codec::{Codec, Compression, MAX_BLOCK},
};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    str,
};

pub(super) const ARCHIVE_BUDGET: usize = 256 * 1024 * 1024;

pub(super) fn file_bytes(path: &Path) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut data = Vec::new();
    file.take(ARCHIVE_BUDGET as u64 + 1)
        .read_to_end(&mut data)?;
    if data.len() > ARCHIVE_BUDGET {
        return Err(invalid("KDB file exceeds archive budget"));
    }
    Ok(data)
}

pub(super) fn framed(path: &Path, codec: &Codec) -> io::Result<Vec<(Vec<u8>, Option<[u32; 4]>)>> {
    let bytes = file_bytes(path)?;
    let mut input = Cursor::new(&bytes);
    let magic = input.uint(4)?;
    if !matches!(magic, 0x95121478 | 0x58125541 | 0x20062608 | 0x11279933)
        || input.uint(4)? != 1
        || input.uint(4)? != 0x01020304
        || !matches!(input.uint(4)?, 0 | 65536)
        || input.uint(8)? != bytes.len() as u64
    {
        return Err(invalid("Invalid KDB framed file header"));
    }
    let mut total = 0usize;
    let mut frames = Vec::new();
    while !input.remaining().is_empty() {
        if input.uint(4)? != 0x79267383 {
            return Err(invalid("Invalid KDB frame marker"));
        }
        let decoded = input.uint(4)? as usize;
        let stored = input.uint(4)? as usize;
        if input.uint(4)? != 0x10000000 {
            return Err(invalid("Invalid KDB chunk flags"));
        }
        total += decoded;
        if decoded > MAX_BLOCK || total > ARCHIVE_BUDGET {
            return Err(invalid("KDB framed output exceeds budget"));
        }
        let metadata = if magic == 0x11279933 {
            Some([
                word(&mut input)?,
                word(&mut input)?,
                word(&mut input)?,
                word(&mut input)?,
            ])
        } else {
            None
        };
        let raw = if stored == 0 {
            input.take(decoded)?.to_vec()
        } else {
            let raw = codec.lzo(Compression::Lzo1x, input.take(stored)?, decoded)?;
            if raw.len() != decoded {
                return Err(invalid("KDB framed length mismatch"));
            }
            raw
        };
        frames.push((raw, metadata));
    }
    Ok(frames)
}

pub(super) fn word(input: &mut Cursor<'_>) -> io::Result<u32> {
    Ok(input.uint(4)? as u32)
}

pub(super) fn libraries(directory: &Path) -> io::Result<Vec<PathBuf>> {
    let mut libraries = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(".lib++"))
            && entry.file_type()?.is_dir()
        {
            libraries.push(entry.path());
        }
    }
    libraries.sort();
    Ok(libraries)
}

#[derive(Clone)]
pub(super) struct Extent {
    offset: u64,
    stored: usize,
    pub decoded: usize,
    pub flags: u32,
}

#[derive(Clone)]
pub(super) struct Arena {
    path: PathBuf,
    records: Vec<Extent>,
    pub end: u64,
    pub size: usize,
}

impl Arena {
    pub(super) fn open(path: &Path, base: u64) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let file_size = file.metadata()?.len();
        file.seek(SeekFrom::Start(base))?;
        let mut header = [0u8; 48];
        file.read_exact(&mut header)?;
        let mut input = Cursor::new(&header);
        if word(&mut input)? != 0
            || word(&mut input)? != 0x4247d
            || word(&mut input)? != 0x01020304
            || word(&mut input)? != 0x25995b80
        {
            return Err(invalid("Invalid KDB arena header"));
        }
        input.take(24)?;
        if word(&mut input)? != 0x4b20 {
            return Err(invalid("Invalid KDB arena format"));
        }
        let count = word(&mut input)? as usize;
        if !(1..=100_000).contains(&count) {
            return Err(invalid("KDB arena page count exceeds budget"));
        }
        let mut end = base
            .checked_add(48 + count as u64 * 28)
            .ok_or_else(|| invalid("KDB arena offset overflow"))?;
        let mut size = 0;
        let mut records = Vec::with_capacity(count);
        for _ in 0..count {
            let mut buffer = [0u8; 28];
            file.read_exact(&mut buffer)?;
            let mut input = Cursor::new(&buffer);
            if !matches!(word(&mut input)?, 1 | 2) || word(&mut input)? != 0x01020304 {
                return Err(invalid("Unknown KDB arena page format"));
            }
            let capacity = word(&mut input)? as usize;
            let stored = word(&mut input)? as usize;
            let offset = u64::from(word(&mut input)?);
            let decoded = word(&mut input)? as usize;
            let flags = word(&mut input)?;
            size += decoded;
            if decoded > capacity
                || capacity > MAX_BLOCK
                || size > ARCHIVE_BUDGET
                || stored == 0
                || stored > MAX_BLOCK
                || offset < end
                || offset + stored as u64 > file_size
            {
                return Err(invalid("KDB arena page exceeds file or memory bounds"));
            }
            end = offset + stored as u64;
            records.push(Extent {
                offset,
                stored,
                decoded,
                flags,
            });
        }
        Ok(Self {
            path: path.to_owned(),
            records,
            end,
            size,
        })
    }

    pub(super) fn decode(&self, codec: &Codec) -> io::Result<View> {
        let mut file = File::open(&self.path)?;
        let mut pages = Vec::with_capacity(self.records.len());
        for record in &self.records {
            file.seek(SeekFrom::Start(record.offset))?;
            let mut data = vec![0; record.stored];
            file.read_exact(&mut data)?;
            if record.stored != record.decoded {
                data = codec.lzo(Compression::Lzo1c, &data, record.decoded)?;
            }
            if data.len() != record.decoded {
                return Err(invalid("KDB arena page length mismatch"));
            }
            pages.push((record.flags, data));
        }
        Ok(View { pages })
    }
}

pub(super) struct View {
    pub(super) pages: Vec<(u32, Vec<u8>)>,
}

impl View {
    pub(super) fn bytes(&self, key: u64, length: usize) -> io::Result<&[u8]> {
        let offset = (key & 65535) as usize;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid("KDB object size overflow"))?;
        self.pages
            .get((key >> 16) as usize)
            .and_then(|(_, page)| page.get(offset..end))
            .ok_or_else(|| invalid(format!("KDB object {key:#x} exceeds its page")))
    }

    pub(super) fn at(&self, key: u64, length: usize) -> io::Result<Cursor<'_>> {
        Ok(Cursor::new(self.bytes(key, length)?))
    }

    pub(super) fn uint(&self, key: u64, length: usize) -> io::Result<u64> {
        le(self.bytes(key, length)?)
    }

    pub(super) fn pointer(&self, key: u64) -> io::Result<Option<u64>> {
        self.pointer_into(key, self)
    }

    pub(super) fn pointer_into(&self, key: u64, view: &View) -> io::Result<Option<u64>> {
        let mut input = self.at(key, 8)?;
        let offset = input.uint(4)?;
        let page = input.uint(4)?;
        if offset == 0 && page == 0 {
            return Ok(None);
        }
        if offset & 3 != 1 || page == 0 || page > view.pages.len() as u64 || offset > 65536 {
            return Err(invalid("Unrecognized KDB arena pointer"));
        }
        Ok(Some((page - 1) << 16 | (offset & !3)))
    }

    pub(super) fn pointer_required(&self, key: u64) -> io::Result<u64> {
        self.pointer(key)?
            .ok_or_else(|| invalid("Missing KDB object pointer"))
    }

    pub(super) fn string(&self, key: u64) -> io::Result<&str> {
        let offset = (key & 65535) as usize;
        let tail = self
            .pages
            .get((key >> 16) as usize)
            .and_then(|(_, page)| page.get(offset..))
            .ok_or_else(|| invalid("KDB string starts outside its page"))?;
        let length = tail
            .iter()
            .take(1 << 20)
            .position(|&byte| byte == 0)
            .ok_or_else(|| invalid("Missing KDB string terminator"))?;
        str::from_utf8(&tail[..length]).map_err(|_| invalid("Invalid UTF-8 in KDB object name"))
    }
}
