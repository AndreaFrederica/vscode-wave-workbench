#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

"""Read PSFXL transient metadata and sampled values using Blosc."""

import argparse
import ctypes
import ctypes.util
import hashlib
import json
import mmap
import re
import struct
import sys
from pathlib import Path

END_OF_CHAIN = (1 << 64) - 1


class Stub:
    def __init__(self, path):
        self.data = path.read_bytes()
        self.pos = 0
        self.sections = {}
        self.header_tag = self.word()
        self.pos = 0
        if self.header_tag not in (0x300, 0x400):
            raise ValueError("Invalid PSFXL companion header")
        for tag in (self.header_tag, 1, 2, 3):
            if self.word() != tag or self.word() != 0x15:
                raise ValueError(f"Invalid PSF section {tag:#x}")
            end = self.word() - 4
            if not self.pos <= end <= len(self.data):
                raise ValueError("Invalid PSF section extent")
            self.sections[tag] = (self.pos, end)
            self.pos = end
        self.pos, end = self.sections[self.header_tag]
        self.header = self.properties(end)

    def read(self, fmt):
        size = struct.calcsize(fmt)
        result = struct.unpack_from(fmt, self.data, self.pos)
        self.pos += size
        return result

    def word(self):
        return self.read(">I")[0]

    def string(self):
        size = self.word()
        if size > len(self.data) - self.pos:
            raise ValueError("Truncated PSF string")
        result = self.data[self.pos:self.pos + size].split(b"\0", 1)[0].decode()
        self.pos += (size + 3) & ~3
        return result

    def properties(self, end):
        result = {}
        while self.pos + 4 <= end:
            tag = self.word()
            if tag not in (0x21, 0x22, 0x23):
                self.pos -= 4
                break
            name = self.string()
            result[name] = {0x21: self.string, 0x22: self.word,
                            0x23: lambda: self.read(">d")[0]}[tag]()
        return result

    def declaration(self):
        if self.word() != 0x10:
            raise ValueError(f"Invalid PSF declaration at {self.pos - 4:#x}")
        return self.word(), self.string()

    def types(self):
        self.pos, end = self.sections[1]
        if self.word() != 0x16:
            raise ValueError("Invalid PSF type table")
        end = min(end, self.word())
        result = {}
        for _ in range(self.header["PSF types"]):
            type_id, name = self.declaration()
            _, code = self.read(">2I")
            if code == 14:
                self.word()
            result[type_id] = {"name": name, "code": code, **self.properties(end)}
        return result

    def traces(self):
        self.pos, end = self.sections[3]
        if self.word() != 0x16:
            raise ValueError("Invalid PSF trace table")
        end = min(end, self.word())
        result = {}
        members = 0
        while len(result) < self.header["PSF traces"] and self.pos < end:
            if not members and struct.unpack_from(">I", self.data, self.pos)[0] == 0x11:
                self.read(">2I")
                self.string()
                members = self.word()
            signal_id, name = self.declaration()
            type_id, tag = self.read(">2I")
            if tag not in (0x24, 0x25):
                raise ValueError(f"Unsupported PSFXL index {tag:#x} for {name}")
            offset, count, start, end_time, low, high = self.read(">QQdddd")
            result[signal_id] = {
                "name": name, "index": len(result), "type": type_id, "offset": offset,
                "count": count, "time": [start, end_time], "range": [low, high],
            }
            self.properties(end)
            members = max(0, members - 1)
        if len(result) != self.header["PSF traces"]:
            raise ValueError("PSFXL trace count disagrees with its declaration table")
        return result


class Samples:
    def __init__(self, data, library):
        if not data[:12].startswith((b"\0!ngpsf-1.4", b"\0!psfxl-1.4")):
            raise ValueError("Unsupported PSFXL data header")
        self.data = data
        blosc = ctypes.CDLL(library or ctypes.util.find_library("blosc") or "libblosc.so.1")
        self.decompress = blosc.blosc_decompress_ctx
        self.decompress.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        self.decompress.restype = ctypes.c_int
        self.axes = {}

    def frame(self, offset, count, size):
        version, _, _, width, nbytes, _, stored = struct.unpack_from("<4B3I", self.data, offset)
        if (version not in (1, 2, 3, 4) or width not in (4, 8) or nbytes != count * width
                or stored != size or not 16 <= size <= len(self.data) - offset):
            raise ValueError(f"Invalid PSFXL Blosc frame at {offset:#x}")
        output = ctypes.create_string_buffer(nbytes)
        if self.decompress(self.data[offset:offset + size], output, nbytes, 1) != nbytes:
            raise ValueError(f"PSFXL Blosc decompression failed at {offset:#x}")
        if width == 8:
            return output.raw
        return struct.pack(f"<{count}d", *struct.unpack(f"<{count}f", output.raw))

    @staticmethod
    def reference(offset, token):
        distance, size = (int(item, 16) for item in token.split(b"."))
        if not 0 < distance <= offset:
            raise ValueError(f"Invalid PSFXL back-reference at {offset:#x}")
        return offset - distance, size

    def read(self, trace):
        offset, index = trace["offset"], trace["index"]
        segments = []
        remaining = trace["count"]
        while offset != END_OF_CHAIN:
            line_end = self.data.find(b"\n", offset, offset + 256)
            if line_end == -1 or self.data[offset] != 0:
                raise ValueError(f"Missing PSFXL record at {offset:#x}")
            fields = self.data[offset + 1:line_end].split(b":")
            mode, signal, previous, count, size = (int(item, 16) for item in fields[:5])
            body = (line_end + 9) & ~7
            if not 0 < count <= remaining or body + size > len(self.data):
                raise ValueError(f"Truncated or invalid PSFXL record at {offset:#x}")
            if previous != END_OF_CHAIN and previous >= offset:
                raise ValueError(f"Invalid PSFXL predecessor at {offset:#x}")
            remaining -= count
            if mode == 1 and count == 1 and previous == END_OF_CHAIN:
                start = body + (index + 1) * 8
                if start + 8 > body + size:
                    raise ValueError("Invalid PSFXL initial sample table")
                segments.append((self.data[body:body + 8], self.data[start:start + 8]))
            elif mode == 3 and signal == index and len(fields) == 5 and count == 1 and size == 16:
                samples = self.data[body:body + 16]
                segments.append((samples[:8], samples[8:]))
            elif mode == 3 and signal == index and len(fields) >= 7:
                flags = int(fields[5], 16)
                if flags in (0x20, 0x22):
                    x_at, x_size = body, int(fields[6], 16)
                    y_at = body + x_size
                    y_size = size - x_size
                else:
                    x_at, x_size = self.reference(offset, fields[6])
                    y_at, y_size = body, size
                if flags in (0x20, 0xA0):
                    if y_size == 0:
                        y = b"\0" * (8 * count)
                    elif y_size == 8:
                        y = self.data[y_at:y_at + 8] * count
                    elif y_size == 4:
                        y = struct.pack("<d", struct.unpack_from("<f", self.data, y_at)[0]) * count
                    else:
                        raise ValueError(f"Unsupported PSFXL constant width {y_size}")
                elif flags in (0x22, 0xA2, 0xAA):
                    if flags == 0xAA:
                        y_at, y_size = self.reference(offset, fields[7])
                    y = self.frame(y_at, count, y_size)
                else:
                    raise ValueError(f"Unsupported PSFXL flags {flags:#x} at {offset:#x}")
                axis = x_at, count, x_size
                if axis not in self.axes:
                    self.axes[axis] = self.frame(*axis)
                segments.append((self.axes[axis], y))
            else:
                raise ValueError(f"Unsupported PSFXL record at {offset:#x}")
            offset = previous
        if remaining:
            raise ValueError("PSFXL sample count disagrees with its index")
        return list(reversed(segments))


def catalog(path):
    stub = Stub(path)
    types = stub.types()
    traces = stub.traces()
    names = {trace["name"]: trace for trace in traces.values()}
    sig = Path(str(path) + ".sig")
    if sig.is_file():
        for name, signal_id in re.findall(rb"^(.+?) +(\d+) +<> *\r?$", sig.read_bytes().replace(b"\x01", b""), re.M):
            if int(signal_id) in traces:
                names[name.decode()] = traces[int(signal_id)]
    return types, names


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stub", type=Path)
    parser.add_argument("--blosc", help="Path to a Blosc 1 shared library")
    parser.add_argument("--signal", action="append", help="Signal or alias to decode")
    parser.add_argument("--digest-all", action="store_true", help="Hash every signal's binary samples")
    args = parser.parse_args()
    try:
        types, names = catalog(args.stub)
        result = {"types": types, "signals": names}
        if args.signal or args.digest_all:
            result["samples"] = {}
            hashes = {}
            with Path(str(args.stub) + ".psfxl").open("rb") as source, mmap.mmap(
                source.fileno(), 0, access=mmap.ACCESS_READ
            ) as data:
                reader = Samples(data, args.blosc)
                for name in args.signal or names:
                    trace = names[name]
                    if args.digest_all and trace["index"] in hashes:
                        result["samples"][name] = hashes[trace["index"]]
                        continue
                    segments = reader.read(trace)
                    if args.digest_all:
                        digest = [hashlib.sha256(), hashlib.sha256()]
                        for x, y in segments:
                            digest[0].update(x)
                            digest[1].update(y)
                        record = [trace["count"], *(value.hexdigest() for value in digest)]
                        hashes[trace["index"]] = record
                        result["samples"][name] = record
                    else:
                        result["samples"][name] = [
                            [x, y] for axis, values in segments
                            for (x,), (y,) in zip(struct.iter_unpack("<d", axis),
                                                  struct.iter_unpack("<d", values))
                        ]
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
    except (OSError, ValueError, KeyError, struct.error, IndexError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
