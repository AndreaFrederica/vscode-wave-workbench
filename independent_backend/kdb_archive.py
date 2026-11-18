# SPDX-License-Identifier: MPL-2.0
"""Experimental legacy containers observed in user-generated KDB files.

Uses system open-source LZO through its public safe decompression API.
No vendor libraries or source code. Unrecognized layouts fail explicitly.
"""
import ctypes as c
import ctypes.util
import struct
from pathlib import Path
from kdb_records import Unsupported


class Lzo:
    def __init__(self):
        name = ctypes.util.find_library("lzo2")
        if not name:
            raise Unsupported("system liblzo2 not available")
        self.library = c.CDLL(name)

    def decompress(self, algorithm, data, size):
        if not 0 < size <= 64 * 1024 * 1024:
            raise Unsupported("legacy block exceeds size budget")
        function = getattr(self.library, "lzo1" + algorithm + "_decompress_safe")
        function.argtypes = [c.c_void_p, c.c_size_t, c.c_void_p, c.POINTER(c.c_size_t), c.c_void_p]
        function.restype = c.c_int
        source, target, length = c.create_string_buffer(data), c.create_string_buffer(size), c.c_size_t(size)
        error = function(source, len(data), target, c.byref(length), None)
        if error or length.value != size:
            raise Unsupported(f"LZO1{algorithm.upper()} error {error}, decoded {length.value}, expected {size}")
        return target.raw

    def decompress_bounded(self, algorithm, data, budget=4 * 1024 * 1024):
        function = getattr(self.library, "lzo1" + algorithm + "_decompress_safe")
        function.argtypes = [c.c_void_p, c.c_size_t, c.c_void_p, c.POINTER(c.c_size_t), c.c_void_p]
        function.restype = c.c_int
        source, target, length = c.create_string_buffer(data), c.create_string_buffer(budget), c.c_size_t(budget)
        error = function(source, len(data), target, c.byref(length), None)
        if error:
            raise Unsupported(f"bounded LZO1{algorithm.upper()} decode failed: {error}")
        return target.raw[:length.value]


def read_framed(filename, *, with_metadata=False):
    """24-byte file header, then independently framed LZO1X or raw blocks."""
    data = Path(filename).read_bytes()
    if len(data) < 24:
        raise Unsupported("truncated framed archive")
    magic, version, endian, flags, length = struct.unpack_from("<IIIIQ", data)
    if magic not in (0x95121478, 0x58125541, 0x20062608, 0x11279933) or version != 1 or endian != 0x01020304 or length != len(data):
        raise Unsupported("unrecognized legacy framed archive header")
    if flags not in (0, 65536):
        raise Unsupported("unrecognized legacy framed flags")
    chunks, offset, budget, codec = [], 24, 0, Lzo()
    while offset < len(data):
        if offset + 16 > len(data):
            raise Unsupported("truncated legacy chunk header")
        marker, decoded, stored, block_flags = struct.unpack_from("<IIII", data, offset)
        offset += 16
        if marker != 0x79267383 or block_flags != 0x10000000:
            raise Unsupported("unrecognized legacy chunk marker/flags")
        budget += decoded
        if decoded > 64 * 1024 * 1024 or budget > 256 * 1024 * 1024:
            raise Unsupported("legacy archive exceeds byte budget")
        metadata = None
        if magic == 0x11279933:
            if offset + 16 > len(data):
                raise Unsupported("truncated parameter-set frame metadata")
            metadata = struct.unpack_from("<4I", data, offset)
            offset += 16
        size = stored or decoded
        if offset + size > len(data):
            raise Unsupported("truncated legacy chunk payload")
        payload = data[offset:offset + size]
        offset += size
        decoded_payload = codec.decompress("x", payload, decoded) if stored else payload
        chunks.append((decoded_payload, metadata) if with_metadata else decoded_payload)
    return chunks


class PagedArchive:
    """One indexed LZO1C/raw arena; an _oharch may contain several arenas.

    Logical addressing and object schemas remain experimental. This class
    exposes exact indexed blocks without inventing a logical pointer mapping.
    """
    def __init__(self, filename, base=0):
        self.filename, self.base = Path(filename), base
        with self.filename.open("rb") as stream:
            stream.seek(base)
            header = stream.read(48)
            if len(header) != 48:
                raise Unsupported("truncated arena header")
            words = struct.unpack("<12I", header)
            if words[0:4] != (0, 0x4247D, 0x01020304, 0x25995B80) or words[10] != 0x4B20:
                raise Unsupported("unrecognized arena header")
            count = words[11]
            if not 0 < count <= 100000:
                raise Unsupported("arena index exceeds block budget")
            index = stream.read(count * 28)
            if len(index) != count * 28:
                raise Unsupported("truncated arena index")
        self.header, self.blocks = words, []
        self.end = base + 48 + len(index)
        previous_end = self.end
        file_size = self.filename.stat().st_size
        for i in range(count):
            version, endian, capacity, stored, offset, decoded, flags = struct.unpack_from("<7I", index, i * 28)
            if version not in (1, 2) or endian != 0x01020304 or decoded > capacity or capacity > 64 * 1024 * 1024:
                raise Unsupported("unrecognized arena block header")
            if not stored or offset < previous_end or offset + stored > file_size:
                raise Unsupported("invalid indexed arena extent")
            self.blocks.append({"capacity": capacity, "stored": stored, "offset": offset,
                                "decoded": decoded, "flags": flags})
            previous_end = offset + stored
        self.end = previous_end

    def decode(self):
        codec = Lzo()
        result, budget = [], 0
        with self.filename.open("rb") as stream:
            for block in self.blocks:
                budget += block["decoded"]
                if budget > 256 * 1024 * 1024:
                    raise Unsupported("arena decoded budget exceeded")
                stream.seek(block["offset"])
                data = stream.read(block["stored"])
                if len(data) != block["stored"]:
                    raise Unsupported("truncated arena block")
                if block["stored"] != block["decoded"]:
                    data = codec.decompress("c", data, block["decoded"])
                result.append({**block, "data": data})
        return result


def arenas(filename):
    offset, size = 0, Path(filename).stat().st_size
    while offset < size:
        arena = PagedArchive(filename, offset)
        yield arena
        offset = arena.end
