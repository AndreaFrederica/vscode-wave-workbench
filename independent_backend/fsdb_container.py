# SPDX-License-Identifier: MPL-2.0
"""Private version-86 directory experiment; not a general FSDB reader.

Only explicitly indexed ranges are read. Uninterpreted directory extensions
remain visible in the result; no search for plausible offsets is performed.
"""
import struct
import zlib
import re
from functools import reduce
from pathlib import Path
from kdb_archive import Lzo
from kdb_records import Unsupported

MAX_BLOCK = 64 * 1024 * 1024
MAX_DIRECTORY = 16 * 1024 * 1024


class Container:
    def __init__(self, filename):
        self.path = Path(filename)
        self.size = self.path.stat().st_size
        header = self.read(0, 0x900)
        if header[4:12] != bytes.fromhex("1c3ed94804030201") or struct.unpack_from("<I", header, 0x28)[0] != 86:
            raise Unsupported("unrecognized FSDB container magic/version")
        scale, terminator, _ = header[0x4C:0x60].partition(b"\0")
        if not terminator or not re.fullmatch(rb"[1-9][0-9]*\s*(?:[munpfaz]?s)", scale):
            raise Unsupported("unverified FSDB timescale")
        self.scale = scale.decode("ascii")
        start_high, start_low, end_high, end_low = struct.unpack_from("<4I", header, 0x800)
        self.start = start_high << 32 | start_low
        self.end = end_high << 32 | end_low
        if self.end < self.start:
            raise Unsupported("FSDB header time bounds are reversed")
        self.directory_offset, self.windows_offset = struct.unpack_from("<QQ", header, 0x400)
        self.dictionary_offset = struct.unpack_from("<Q", header, 0x478)[0]
        self.graph_offset = struct.unpack_from("<Q", header, 0x508)[0]
        self.window_count = struct.unpack_from("<I", header, 0x898)[0]
        if not 0 < self.window_count <= 100000:
            raise Unsupported("FSDB window count exceeds budget")
        if not 0x900 <= self.directory_offset < self.windows_offset < self.dictionary_offset < self.graph_offset < self.size:
            raise Unsupported("FSDB directory pointer order is invalid")
        if self.graph_offset - self.directory_offset > MAX_DIRECTORY or self.read(self.graph_offset, 8) != b"GMAPHEAD":
            raise Unsupported("FSDB directory bounds/graph boundary mismatch")
        self.directory = self.read(self.directory_offset, self.graph_offset - self.directory_offset)
        if self.directory[0] != 0xF0:
            raise Unsupported("unrecognized FSDB directory tag")
        window_start = self.windows_offset - self.directory_offset
        dictionary_start = self.dictionary_offset - self.directory_offset
        offset, self.snapshots, id_offset, first_table_end = 0, [], 0, None
        while offset < window_start:
            if window_start - offset < 9 or self.directory[offset] != 0xF0:
                raise Unsupported("unrecognized declaration snapshot header")
            signal_word = struct.unpack_from("<Q", self.directory, offset + 1)[0]
            if signal_word > 0x100000000 or id_offset + signal_word > 0x100000000:
                raise Unsupported("declaration snapshot ID range exceeds supported budget")
            offset += 9
            scopes, offset = self.table(offset, 4)
            variables, offset = self.table(offset, 4)
            if first_table_end is None:
                first_table_end = offset
            auxiliary, offset = self.table(offset, 4)
            self.snapshots.append({"signalWord": signal_word, "idOffset": id_offset,
                                   "scopes": scopes, "variables": variables, "auxiliary": auxiliary})
            id_offset += signal_word
            if offset > window_start or len(self.snapshots) > 100000:
                raise Unsupported("declaration snapshots overlap time windows/exceed budget")
        if offset != window_start or not self.snapshots:
            raise Unsupported("declaration snapshot boundary mismatch")
        self.signal_word = self.snapshots[0]["signalWord"]  # Legacy single-snapshot subset only.
        self.scope_blocks = [row for snap in self.snapshots for row in snap["scopes"]]
        self.variable_blocks = [row for snap in self.snapshots for row in snap["variables"]]
        self.auxiliary_blocks = [row for snap in self.snapshots for row in snap["auxiliary"]]
        self.header_max_id = struct.unpack_from("<I", header, 0x8A4)[0]
        # Retained for old experiments that explicitly reject extra snapshots.
        self.declaration_extensions = self.directory[first_table_end:window_start]
        self.windows = []
        offset = window_start
        for _ in range(self.window_count):
            if dictionary_start - offset < 26:
                raise Unsupported("truncated FSDB time-window header")
            flags, zero1, anchor, end_low, zero2, value_base = struct.unpack_from("<IBQIBI", self.directory, offset)
            if flags != 15 or zero1 or zero2:
                raise Unsupported("unrecognized FSDB time-window flags")
            values, next_offset = self.table(offset + 22, 2)
            indexes, next_offset = self.table(next_offset, 2)
            if next_offset > dictionary_start or not indexes:
                raise Unsupported("time-window tables exceed dictionary boundary")
            # The anchor is not necessarily the first event time. End low32
            # and the value-page base are separate fields, not a u64 end time.
            self.windows.append({"timeAnchor": anchor, "endLow": end_low, "valuePageBase": value_base,
                                 "values": values, "indexes": indexes})
            offset = next_offset
        if offset > dictionary_start or len(self.directory) - dictionary_start < 12:
            raise Unsupported("FSDB dictionary boundary mismatch")
        self.window_extensions = self.directory[offset:dictionary_start]
        offset = dictionary_start
        self.dictionary_decoded, self.dictionary_stored = struct.unpack_from("<II", self.directory, offset)
        self.dictionary_data_offset = self.dictionary_offset + 8
        if not 0 < self.dictionary_decoded <= MAX_BLOCK or not 1 < self.dictionary_stored <= MAX_BLOCK:
            raise Unsupported("FSDB dictionary length exceeds budget")
        end = offset + 8 + self.dictionary_stored
        if end + 4 > len(self.directory) or self.directory[end:end + 4] != bytes(4):
            raise Unsupported("unrecognized FSDB directory trailer")
        self.dictionary_extensions = self.directory[end + 4:]
        self.codec = Lzo()

    def read(self, offset, size):
        if offset < 0 or size < 0 or size > MAX_BLOCK or offset > self.size - size:
            raise Unsupported("FSDB file range exceeds bounds/budget")
        with self.path.open("rb") as stream:
            stream.seek(offset)
            data = stream.read(size)
        if len(data) != size:
            raise Unsupported("truncated FSDB file range")
        return data

    def table(self, offset, width):
        data = self.directory
        if offset + width > len(data):
            raise Unsupported("truncated FSDB block-table count")
        count = int.from_bytes(data[offset:offset + width], "little")
        offset += width
        if count > 1000000 or count * 12 > len(data) - offset:
            raise Unsupported("FSDB block-table count exceeds bounds")
        rows = []
        for _ in range(count):
            position, size = struct.unpack_from("<QI", data, offset)
            if not 0x900 <= position < self.directory_offset or not 1 < size <= min(MAX_BLOCK, self.directory_offset - position):
                raise Unsupported("FSDB indexed block exceeds data region")
            rows.append({"offset": position, "storedBytes": size, "indexOffset": self.directory_offset + offset})
            offset += 12
        return rows, offset

    def decompress(self, data, algorithm, decoded_size=None):
        if not data or reduce(int.__xor__, data, 0):
            raise Unsupported("FSDB compressed-block checksum mismatch")
        if algorithm == "zlib":
            decoder = zlib.decompressobj()
            first = decoder.decompress(data[:-1], MAX_BLOCK + 1)
            if len(first) > MAX_BLOCK or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise Unsupported("invalid or oversized FSDB zlib block")
            inner = "c"
        else:
            first = self.codec.decompress_bounded(algorithm, data[:-1], MAX_BLOCK)
            inner = algorithm
        return (self.codec.decompress(inner, first, decoded_size) if decoded_size is not None else
                self.codec.decompress_bounded(inner, first, MAX_BLOCK))

    def block(self, row, algorithm):
        return self.decompress(self.read(row["offset"], row["storedBytes"]), algorithm)

    def dictionary(self):
        return self.decompress(self.read(self.dictionary_data_offset, self.dictionary_stored), "c", self.dictionary_decoded)

    def summary(self):
        return {"version": 86, "fileBytes": self.size, "directorySignalWords": [snap["signalWord"] for snap in self.snapshots],
                "declarationSnapshots": len(self.snapshots), "headerMaxId": self.header_max_id,
                "scopeBlocks": len(self.scope_blocks), "variableBlocks": len(self.variable_blocks),
                "auxiliaryBlocks": len(self.auxiliary_blocks),
                "timeWindows": len(self.windows), "valueBlocks": sum(len(w["values"]) for w in self.windows),
                "indexBlocks": sum(len(w["indexes"]) for w in self.windows),
                "declarationExtensionBytes": len(self.declaration_extensions),
                "windowExtensionBytes": len(self.window_extensions),
                "dictionaryExtensionBytes": len(self.dictionary_extensions),
                "dictionaryBytes": self.dictionary_decoded}
