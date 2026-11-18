// SPDX-License-Identifier: MPL-2.0

use super::bytes::invalid;
use flate2::{Decompress, FlushDecompress, Status};
use libloading::Library;
use std::{env, ffi::c_void, io, path::Path, ptr};

pub(super) const MAX_BLOCK: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum Compression {
    Lzo1c,
    Lzo1x,
    ZlibLzo1c,
}

pub(super) struct Codec {
    lzo: Library,
}

impl Codec {
    pub(super) fn open() -> io::Result<Self> {
        if let Some(path) = env::var_os("WAVE_WORKBENCH_LZO_LIBRARY") {
            if !Path::new(&path).is_absolute() {
                return Err(invalid(
                    "WAVE_WORKBENCH_LZO_LIBRARY must be an absolute path",
                ));
            }
            // This override comes from the backend's environment or machine settings.
            return unsafe { Library::new(&path) }
                .map(|lzo| Self { lzo })
                .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error));
        }
        #[cfg(target_os = "macos")]
        const LIBRARIES: &[&str] = &[
            "/opt/homebrew/opt/lzo/lib/liblzo2.2.dylib",
            "/usr/local/opt/lzo/lib/liblzo2.2.dylib",
            "liblzo2.2.dylib",
        ];
        #[cfg(target_os = "windows")]
        const LIBRARIES: &[&str] = &["lzo2.dll", "liblzo2-2.dll"];
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        const LIBRARIES: &[&str] = &["liblzo2.so.2"];
        for name in LIBRARIES {
            #[cfg(target_os = "windows")]
            let loaded = unsafe {
                use libloading::os::windows::{
                    Library as WindowsLibrary, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                };
                WindowsLibrary::load_with_flags(name, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)
                    .map(Library::from)
            };
            #[cfg(not(target_os = "windows"))]
            let loaded = unsafe { Library::new(name) };
            if let Ok(lzo) = loaded {
                return Ok(Self { lzo });
            }
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("LZO 2 runtime unavailable ({}). Set WAVE_WORKBENCH_LZO_LIBRARY to its absolute path.", LIBRARIES.join(", ")),
        ))
    }

    pub(super) fn lzo(
        &self,
        algorithm: Compression,
        data: &[u8],
        limit: usize,
    ) -> io::Result<Vec<u8>> {
        type Decode =
            unsafe extern "C" fn(*const u8, usize, *mut u8, *mut usize, *mut c_void) -> i32;
        let symbol = match algorithm {
            Compression::Lzo1c => b"lzo1c_decompress_safe\0",
            Compression::Lzo1x => b"lzo1x_decompress_safe\0",
            Compression::ZlibLzo1c => return Err(invalid("Invalid LZO codec")),
        };
        let decode = unsafe { self.lzo.get::<Decode>(symbol) }
            .map_err(|err| io::Error::new(io::ErrorKind::Unsupported, err))?;
        if limit == 0 || limit > MAX_BLOCK || data.is_empty() {
            return Err(invalid("LZO block exceeds bounds"));
        }
        let mut output = Vec::with_capacity(limit);
        let mut size = limit;
        // The callee writes at most size bytes and reports the initialized length.
        let status = unsafe {
            decode(
                data.as_ptr(),
                data.len(),
                output.as_mut_ptr(),
                &mut size,
                ptr::null_mut(),
            )
        };
        if status != 0 || size > limit {
            return Err(invalid(format!("LZO decompression failed ({status})")));
        }
        unsafe { output.set_len(size) };
        // Retain only the decoded size when caching small, highly compressed pages.
        output.shrink_to_fit();
        Ok(output)
    }

    pub(super) fn fsdb(
        &self,
        algorithm: Compression,
        data: &[u8],
        expected: Option<usize>,
    ) -> io::Result<Vec<u8>> {
        if data.len() < 2 || data.iter().fold(0, |checksum, byte| checksum ^ byte) != 0 {
            return Err(invalid("FSDB compressed-block checksum mismatch"));
        }
        let data = &data[..data.len() - 1];
        let (inner, first) = match algorithm {
            Compression::ZlibLzo1c => {
                let first = inflate(data)?;
                (Compression::Lzo1c, first)
            }
            algorithm => (algorithm, self.lzo(algorithm, data, MAX_BLOCK)?),
        };
        let output = self.lzo(inner, &first, expected.unwrap_or(MAX_BLOCK))?;
        if expected.is_some_and(|size| output.len() != size) {
            return Err(invalid("FSDB decoded block length mismatch"));
        }
        Ok(output)
    }
}

pub(super) fn inflate(data: &[u8]) -> io::Result<Vec<u8>> {
    let mut zlib = Decompress::new(true);
    let mut output = Vec::with_capacity(MAX_BLOCK + 1);
    let status = zlib
        .decompress_vec(data, &mut output, FlushDecompress::Finish)
        .map_err(|_| invalid("Invalid zlib stream"))?;
    if status != Status::StreamEnd
        || zlib.total_in() != data.len() as u64
        || output.len() > MAX_BLOCK
    {
        return Err(invalid("Incomplete or oversized zlib stream"));
    }
    output.shrink_to_fit();
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{Codec, Compression};

    #[test]
    #[ignore = "requires the system LZO runtime"]
    fn lzo_runtime_decodes_both_formats() {
        let codec = Codec::open().unwrap();
        let message = b"Wave Workbench LZO runtime";
        for (algorithm, first, last) in [
            (Compression::Lzo1c, 0x1a, 0x21),
            (Compression::Lzo1x, 0x2b, 0x11),
        ] {
            let mut compressed = vec![first];
            compressed.extend(message);
            compressed.extend([last, 0, 0]);
            assert_eq!(codec.lzo(algorithm, &compressed, 32).unwrap(), message);
        }
    }
}
