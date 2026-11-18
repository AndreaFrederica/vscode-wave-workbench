// SPDX-License-Identifier: MPL-2.0

use std::{io, str};

pub(super) fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

pub(super) fn le(bytes: &[u8]) -> io::Result<u64> {
    let mut buffer = [0; 8];
    buffer
        .get_mut(..bytes.len())
        .ok_or_else(|| invalid("Integer field is wider than 64 bits"))?
        .copy_from_slice(bytes);
    Ok(u64::from_le_bytes(buffer))
}

pub(super) trait Input {
    fn take(&mut self, count: usize) -> io::Result<&[u8]>;

    fn uint(&mut self, count: usize) -> io::Result<u64> {
        le(self.take(count)?)
    }

    fn byte(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn expect(&mut self, expected: u8) -> io::Result<()> {
        let actual = self.byte()?;
        if actual != expected {
            return Err(invalid(format!(
                "Expected {expected:#04x}, found {actual:#04x}"
            )));
        }
        Ok(())
    }
}

pub(super) struct Cursor<'a> {
    bytes: &'a [u8],
    pub(super) pos: usize,
}

impl<'a> Cursor<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub(super) fn remaining(&self) -> &'a [u8] {
        &self.bytes[self.pos..]
    }

    pub(super) fn string(&mut self) -> io::Result<String> {
        let remaining = self.remaining();
        let length = remaining
            .iter()
            .take(1 << 20)
            .position(|&byte| byte == 0)
            .ok_or_else(|| invalid("Unterminated or oversized string"))?;
        let value =
            str::from_utf8(&remaining[..length]).map_err(|_| invalid("Invalid UTF-8 in string"))?;
        self.pos += length + 1;
        Ok(value.to_owned())
    }
}

impl Input for Cursor<'_> {
    fn take(&mut self, count: usize) -> io::Result<&[u8]> {
        let end = self
            .pos
            .checked_add(count)
            .ok_or_else(|| invalid("Byte offset overflow"))?;
        let bytes = self
            .bytes
            .get(self.pos..end)
            .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?;
        self.pos = end;
        Ok(bytes)
    }
}
