// SPDX-License-Identifier: MPL-2.0

use std::io::{self, Read, Seek, SeekFrom};

pub(super) fn read_at(
    file: &mut (impl Read + Seek),
    size: u64,
    offset: u64,
    output: &mut [u8],
) -> io::Result<()> {
    if offset > size || output.len() as u64 > size - offset {
        return Err(invalid("FSDB file range exceeds bounds"));
    }
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(output)
}

pub(super) fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

pub(super) fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

pub(super) fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
