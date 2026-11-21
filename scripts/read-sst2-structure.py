#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

"""Read SST2 design records, stream indexes and supported digital transitions."""

import argparse
import itertools
import json
import mmap
import re
import struct
import sys
from pathlib import Path


MAGIC = 0xA19511BF
ROOT_SCOPE = 0x18
SCOPE_RECORD = 0x2705
SIGNAL_RECORD = 0x2907
SERIES_RECORD = 0x192100
SLICE_RECORD = 0x1B2200
NO_SEQUENCE = (1 << 64) - 1


class BitReader:
    def __init__(self, data, start, end):
        self.data = data
        self.position = start * 8
        self.end = end * 8

    def read(self, width):
        start = self.position
        self.position += width
        if self.position > self.end:
            raise ValueError("Truncated SST2 bit stream")
        end_byte = (self.position + 7) // 8
        word = int.from_bytes(self.data[start // 8:end_byte], "big")
        return (word >> (end_byte * 8 - self.position)) & ((1 << width) - 1)

    def prefix(self, table):
        if (0, 0) in table:
            return table[0, 0]
        code = 0
        for width in range(1, 17):
            code = (code << 1) | self.read(1)
            symbol = table.get((width, code))
            if symbol is not None:
                return symbol
        raise ValueError(f"Invalid SST2 prefix at bit {self.position}")


# SST2's fixed prefix table for encoded lengths, ordered by symbol.
LENGTH_CODES = [
    (4, range(0, 3)), (5, range(14, 20)), (6, range(48, 56)),
    (4, range(3, 7)), (5, range(20, 24)), (6, range(56, 60)),
    (9, range(480, 496)), (10, range(992, 1012)),
]
DEFAULT_LENGTHS = {
    key: symbol
    for symbol, key in enumerate(
        (width, code) for width, codes in LENGTH_CODES for code in codes
    )
}
FREE_CODES = (
    [(5, code) for code in range(16, 20)]
    + [(6, code) for code in range(56, 60)]
    + [(7, code) for code in range(120, 128)]
    + [(5, code) for code in range(20, 28)]
    + [(1, 0)]
)
DEFAULT_FREE = {key: symbol for symbol, key in enumerate(FREE_CODES)}
DEFAULT_MODE = {(1, 0): 0, (1, 1): 1}
MAX_EVENTS_PER_COMMAND = 8_000_000


def encoded_length(reader, table=DEFAULT_LENGTHS):
    symbol = reader.prefix(table)
    if symbol <= 16:
        return symbol
    if symbol <= 44:
        width = symbol - 13
        return (1 << width) + reader.read(width) + 1
    # Extended length codes use the symbol to select the bit length.
    raise ValueError(f"Unsupported SST2 extended length symbol {symbol}")


def code_lengths(reader, count):
    prefix = {
        (3, 0): 17,
        **{(4, code): code + 2 for code in range(2, 10)},
        **dict(zip(((5, code) for code in range(20, 32)),
                   (*range(4), *range(12, 17), 18, 19, 20))),
    }
    lengths = []
    previous = 1
    while len(lengths) < count:
        symbol = reader.prefix(prefix)
        if symbol <= 16:
            previous = symbol
            lengths.append(symbol)
        elif symbol == 17:
            lengths.append(17)
        else:
            bits, base = {18: (3, 2), 19: (3, 3), 20: (8, 12)}[symbol]
            length = previous if symbol == 18 else 17
            lengths.extend([length] * (base + reader.read(bits)))
    return lengths[:count]


def canonical_codes(lengths):
    codes = {}
    code = 0
    last_width = 0
    for width, symbol in sorted((width, i) for i, width in enumerate(lengths) if width != 17):
        code <<= width - last_width
        if code >= 1 << width:
            raise ValueError("Invalid SST2 prefix table")
        codes[width, code] = symbol
        last_width = width
        code += 1
    return codes


def compression_tables(data, offset, end):
    if not offset:
        return {}, {}
    reader = BitReader(data, offset, end)
    global_tables = {}
    selectors = {}
    while kind := reader.read(5):
        size = encoded_length(reader)
        if 1 <= kind <= 6:
            if size:
                offsets = [offset - encoded_length(reader) for _ in range(size)]
                if any(not 0 <= item <= offset for item in offsets):
                    raise ValueError("Invalid SST2 compression table reference")
                selectors[kind] = (canonical_codes(code_lengths(reader, size + 1)), offsets)
        elif 9 <= kind <= 15 and 0 < size <= offset:
            global_tables[kind] = offset - size
        else:
            raise ValueError(f"Unsupported SST2 compression table kind {kind}")
    return global_tables, selectors


def read_table(data, offset, end):
    table = BitReader(data, offset, end)
    version = table.read(4)
    count = table.read(8) + 1
    return version, canonical_codes(code_lengths(table, count))


def global_table(data, time_slice, tables, kind, default):
    if kind not in tables:
        return default
    _, table = read_table(data, tables[kind], time_slice["offset"])
    return table


def selected_table(reader, selectors, kind, version, default=None):
    if kind not in selectors:
        return default
    selector, offsets = selectors[kind]
    choice = reader.prefix(selector)
    if choice == 0:
        return default
    actual, table = read_table(reader.data, offsets[choice - 1], len(reader.data))
    if actual != version:
        raise ValueError(f"Unsupported SST2 table version {actual} for group {kind}")
    return table


def stream_index(data, time_slice, global_tables):
    count = time_slice["indexCount"]
    if not count:
        return []
    offset = time_slice["variableIndexOffset"]
    base = time_slice["streamBase"]
    lengths = global_table(data, time_slice, global_tables, 13, DEFAULT_LENGTHS)
    reader = BitReader(data, offset, time_slice["offset"])
    if encoded_length(reader) != 0:
        raise ValueError("Unsupported multilevel SST2 variable index")
    padding = encoded_length(reader)
    positions = [base]
    for _ in range(count):
        end = positions[-1] + encoded_length(reader, lengths)
        if end > offset:
            raise ValueError("SST2 variable stream extends beyond its index")
        positions.append(end)
    if positions[-1] + padding != offset:
        raise ValueError("SST2 variable index extent disagrees with slice")
    return positions


def append_pattern(items, symbol, count, reader, repeat_table):
    if symbol <= 15:
        length = symbol + 1
    else:
        width = symbol - 12
        length = (1 << width) + reader.read(width) + 1
    copies = encoded_length(reader, repeat_table)
    remaining = count - len(items)
    if length > len(items):
        raise ValueError("SST2 repeat references data before the start of the record")
    items.extend(itertools.islice(itertools.cycle(items[-length:]), min(copies or remaining, remaining)))


def stream_reader(data, time_slice, positions, variable_id, tables, depth):
    if depth >= 32 or not 0 <= variable_id < len(positions) - 1:
        raise ValueError("Invalid SST2 stream reference")
    start, end = positions[variable_id:variable_id + 2]
    if start == end:
        return None, None
    reader = BitReader(data, start, end)
    mode = reader.prefix(global_table(data, time_slice, tables[0], 10, DEFAULT_MODE))
    return reader, mode


def stream_reference(reader, time_slice, tables):
    code = global_table(reader.data, time_slice, tables[0], 12, DEFAULT_LENGTHS)
    return encoded_length(reader, code)


def decode_times(data, time_slice, positions, variable_id, tables, remaining, depth=0):
    reader, mode = stream_reader(data, time_slice, positions, variable_id, tables, depth)
    if reader is None:
        return None, [], 0
    if mode in (3, 7, 8):
        reference = stream_reference(reader, time_slice, tables)
        _, ticks, first = decode_times(
            data, time_slice, positions, reference, tables, remaining, depth + 1
        )
        return reader, ticks, first
    if mode not in (0, 1, 4, 5):
        raise ValueError(f"Unsupported SST2 transition mode {mode} at {positions[variable_id]:#x}")
    global_tables, selectors = tables
    count = encoded_length(reader, global_table(data, time_slice, global_tables, 11, DEFAULT_LENGTHS))
    if count == 0:
        return reader, [], 0
    if count > remaining:
        raise ValueError("SST2 event count exceeds the command limit")
    control = selected_table(reader, selectors, 1, 1)
    if control is None:
        raise ValueError(f"Unsupported SST2 time encoding at {positions[variable_id]:#x}")
    repeat = selected_table(reader, selectors, 3, 0, DEFAULT_LENGTHS)
    deltas = []
    while len(deltas) < count:
        symbol = reader.prefix(control)
        if symbol <= 27:
            append_pattern(deltas, symbol, count, reader, repeat)
        elif symbol <= 43:
            deltas.append(symbol - 28)
        elif symbol <= 103:
            bits = symbol - 40
            deltas.append((1 << bits) + reader.read(bits))
        else:
            raise ValueError(f"Unsupported SST2 time symbol {symbol}")
    # Odd inline time modes begin with a carry-in dated before the slice start.
    first = mode & 1
    origin = time_slice["start"] - (2 * deltas[0] if first else 0)
    ticks = list(itertools.accumulate(deltas, initial=origin))
    return reader, ticks[1:], first


def decode_values(data, time_slice, positions, variable_id, tables, remaining, count, depth=0):
    reader, mode = stream_reader(data, time_slice, positions, variable_id, tables, depth)
    if reader is None:
        return []
    if mode in (7, 8):
        reference = stream_reference(reader, time_slice, tables)
        if mode == 7:
            reference = stream_reference(reader, time_slice, tables)
        return decode_values(data, time_slice, positions, reference, tables, remaining, count, depth + 1)
    reader, ticks, _ = decode_times(data, time_slice, positions, variable_id, tables, remaining, depth)
    if not ticks or not count:
        return []
    if mode in (4, 5):
        reference = stream_reference(reader, time_slice, tables)
        return decode_values(data, time_slice, positions, reference, tables, remaining, count, depth + 1)
    selectors = tables[1]
    free = selected_table(reader, selectors, 2, 0, DEFAULT_FREE)
    repeat = selected_table(reader, selectors, 3, 0, DEFAULT_LENGTHS)
    widths = selected_table(reader, selectors, 4, 0, DEFAULT_LENGTHS)
    bytes_table = selected_table(reader, selectors, 5, 0)
    storage_width = 1
    values = []
    while len(values) < count:
        symbol = reader.prefix(free)
        if symbol in (23, 24):
            if symbol == 23:
                storage_width = encoded_length(reader, widths)
            if not 0 < storage_width <= 16384:
                raise ValueError("SST2 stored value exceeds the supported width")
            packed = bytes(
                reader.prefix(bytes_table) if bytes_table is not None else reader.read(8)
                for _ in range(storage_width)
            )
            values.append(packed)
        elif symbol <= 21:
            append_pattern(values, symbol, count, reader, repeat)
        else:
            raise ValueError(f"Unsupported SST2 value symbol {symbol}")

    return values


def decode_logic(data, time_slice, positions, variable_id, width, tables, remaining, encoding="logic"):
    _, ticks, first = decode_times(data, time_slice, positions, variable_id, tables, remaining)
    values = decode_values(data, time_slice, positions, variable_id, tables, remaining, len(ticks))
    if len(values) != len(ticks):
        raise ValueError(f"SST2 time and value counts differ for variable {variable_id}")
    events = []
    for tick, value in zip(itertools.islice(ticks, first, None), itertools.islice(values, first, None)):
        if not time_slice["start"] <= tick <= time_slice["end"]:
            raise ValueError(f"SST2 event falls outside its time slice at {tick}")
        if encoding == "logic":
            bits = "".join("01xz"[(byte >> shift) & 3] for byte in value for shift in (6, 4, 2, 0))
            value = bits[-width:].rjust(width, "0")
        elif encoding == "bit":
            value = "".join(f"{byte:08b}" for byte in value)[-width:].rjust(width, "0")
        elif encoding == "real":
            if len(value) > 8:
                raise ValueError("Invalid SST2 real value width")
            value = repr(struct.unpack(">d", value.rjust(8, b"\0"))[0])
        elif encoding == "string":
            value = value.decode("utf-8", errors="replace")
        elif encoding == "event":
            value = "1" if any(value) else "0"
        events.append((tick, value))
    return events


def u32(data, offset):
    return struct.unpack_from(">I", data, offset)[0]


def locator_node(reader, id_width, depth=0):
    if depth == 32:
        raise ValueError("SST2 locator tree is nested too deeply")
    element = 0
    while True:
        element += encoded_length(reader)
        kind = reader.read(3)
        if kind < 4:
            reader.position -= 2
            count = 1
            yield (element,), reader.read(id_width)
        elif kind == 7:
            count = 1
            for path, variable_id in locator_node(reader, id_width, depth + 1):
                yield (element, *path), variable_id
        else:
            count = encoded_length(reader)
            start = reader.read(id_width)
            step = -1 if kind == 6 else 1
            for index in range(count):
                variable_id = start + index * step
                if variable_id < 0:
                    raise ValueError("Invalid SST2 locator range")
                yield (element + index,), variable_id
        element += count
        if not reader.read(1):
            break


def locator_index(data, series, declarations):
    offset = series["dataStart"]
    entries = []
    visited_blocks = set()
    while offset:
        tag, next_offset = struct.unpack_from(">2I", data, offset)
        if tag == SLICE_RECORD:
            break
        if offset in visited_blocks:
            raise ValueError(f"Cycle in SST2 locator blocks at {offset:#x}")
        visited_blocks.add(offset)
        if tag == 0x1F2400:
            if not offset + 8 <= next_offset <= len(data):
                raise ValueError(f"Invalid SST2 locator extent at {offset:#x}")
            reader = BitReader(data, offset + 8, next_offset)
            if encoded_length(reader) != 1 or reader.read(4) != 0:
                raise ValueError(f"Unsupported SST2 locator partition at {offset:#x}")
            id_width = encoded_length(reader)
            if id_width > 32:
                raise ValueError("Invalid SST2 series ID width")
            locator = 0
            while delta := encoded_length(reader):
                locator += 4 * delta
                if locator not in declarations:
                    raise ValueError(f"Unknown SST2 declaration at {locator:#x}")
                if reader.read(1):
                    for elements, variable_id in locator_node(reader, id_width):
                        entries.append({"locator": locator, "id": variable_id, "elements": elements})
                else:
                    entries.append({"locator": locator, "id": reader.read(id_width)})
        elif tag != 0x212500:
            raise ValueError(f"Unknown SST2 locator record {tag:#x} at {offset:#x}")
        offset = next_offset
    return entries


def string(data, offset):
    if offset == 0:
        return ""
    end = data.find(b"\0", offset, min(len(data), offset + 65536))
    if end < 0:
        raise ValueError(f"Invalid SST2 string at {offset:#x}")
    return data[offset:end].decode()


def check_header(data, kind):
    if (u32(data, 0), u32(data, 4)) != (MAGIC, kind):
        raise ValueError(f"Unexpected SST2 header for component type {kind}")


def signal_type(data, offset, depth=0):
    if not offset:
        return {}
    tag = u32(data, offset)
    if depth >= 32:
        return {"typeRecord": tag}
    if tag == 0x100B02:
        encoding = "bit" if u32(data, offset + 4) == 1 else "logic"
        return {"encoding": encoding, "width": 1}
    if tag == 0x100B01:
        return {"encoding": "event", "width": 1}
    if tag == 0x020C08 and u32(data, u32(data, offset + 4)) == 0x100B04:
        return {"encoding": "string"}
    if tag == 0x220B15 and u32(data, u32(data, offset + 4)) == 0x100B06:
        return {"encoding": "real", "width": 64}
    if tag in (0x020C05, 0x020C06, 0x020C07, 0x0E0C12, 0x1E0C13):
        layout = signal_type(data, u32(data, offset + 4), depth + 1)
        if tag == 0x0E0C12 and layout.get("encoding") in ("logic", "bit"):
            labels = []
            field = u32(data, offset + 8)
            seen = set()
            while field and field not in seen and u32(data, field) == 0x170D05:
                seen.add(field)
                _, field, name = struct.unpack_from(">3I", data, field)
                labels.append(string(data, name))
            return {**layout, "enumLabels": labels}
        if tag == 0x1E0C13:
            fields = signal_type(data, u32(data, offset + 8), depth + 1)
            if fields.get("encoding") in ("logic", "bit") and layout.get("width") == fields.get("width"):
                return fields
        elif layout:
            return layout
    if tag == 0x140B07:
        _, flags, item_offset, _, bound_offset, count = struct.unpack_from(">6I", data, offset)
        item = signal_type(data, item_offset, depth + 1)
        if bound_offset and count and item:
            bound = struct.unpack_from(">i", data, bound_offset)[0]
            last = bound + (count - 1 if flags & 2 else 1 - count)
            layout = {"range": [bound, last], "elementType": item}
            if flags & 0x20:
                return {"encoding": "array", **layout}
            if item.get("encoding") in ("logic", "bit"):
                return {"encoding": item["encoding"], "width": count * item["width"], **layout}
    if tag == 0x180B08:
        field = u32(data, offset + 4)
        members = []
        visited = set()
        packed = None
        while field:
            kind, next_field, name, _, item_offset = struct.unpack_from(">5I", data, field)
            if kind not in (0x150D02, 0x150D03, 0x150D0B, 0x150D0D) or field in visited:
                return {"typeRecord": tag}
            is_packed = kind == 0x150D03
            if packed is not None and packed != is_packed:
                return {"typeRecord": tag}
            packed = is_packed
            visited.add(field)
            member_type = signal_type(data, item_offset, depth + 1)
            members.append({"name": string(data, name), **member_type})
            field = next_field
        if packed and all(item.get("encoding") in ("logic", "bit") for item in members):
            encoding = "logic" if any(item["encoding"] == "logic" for item in members) else "bit"
            return {"encoding": encoding, "width": sum(item["width"] for item in members), "members": members}
        if packed is False:
            return {"encoding": "struct", "members": members}
    return {"typeRecord": tag}


def locator_path(path, layout, elements):
    for ordinal in elements:
        if layout.get("encoding") == "array":
            first, last = layout["range"]
            if ordinal > abs(last - first):
                return None
            path += f"[{first + ordinal if first <= last else first - ordinal}]"
            layout = layout["elementType"]
        elif layout.get("encoding") == "struct":
            if ordinal >= len(layout["members"]):
                return None
            layout = layout["members"][ordinal]
            path += "." + layout["name"]
        else:
            return None
    return path, layout


def packed_projection(path, layout, name):
    start = 0
    while path != name and name.startswith((path + ".", path + "[")):
        if "members" in layout:
            for member in layout["members"]:
                member_path = path + "." + member["name"]
                if name == member_path or name.startswith((member_path + ".", member_path + "[")):
                    path, layout = member_path, member
                    break
                start += member["width"]
            else:
                return None
        elif "range" in layout:
            match = re.match(r"\[(-?\d+)\]", name[len(path):])
            if not match:
                return None
            first, last = layout["range"]
            index = int(match[1])
            if not min(first, last) <= index <= max(first, last):
                return None
            layout = layout["elementType"]
            start += abs(first - index) * layout["width"]
            path += match[0]
        else:
            return None
    if path == name:
        return start, start + layout["width"]
    return None


def design(data):
    check_header(data, 1)
    scopes = {}
    signals = {}
    definitions = {}
    types = {}
    pending = [(u32(data, 0x2C), ROOT_SCOPE)]
    while pending:
        offset, parent_offset = pending.pop()
        if not offset:
            continue
        tag, sibling, name_offset, source_ref, parent, child, variable = struct.unpack_from(
            ">7I", data, offset
        )
        if tag >> 8 != SCOPE_RECORD or parent != parent_offset or offset in scopes:
            raise ValueError(f"Invalid SST2 scope link at {offset:#x}")
        name = string(data, name_offset)
        parent_path = scopes[parent]["path"] if parent != ROOT_SCOPE else ""
        if parent_path and tag == 0x270528 and re.fullmatch(r"-?\d+", name):
            path = f"{parent_path}[{name}]"
        else:
            path = f"{parent_path}.{name}" if parent_path else name
        scope = {
            "offset": offset, "parentOffset": parent, "path": path,
            "name": name, "recordKind": tag & 0xFF,
            "visible": tag != 0x270513,
        }
        if tag == 0x270501:
            definition = u32(data, offset + 28)
            if definition and definition not in definitions:
                def_tag, _, module_offset, file_record = struct.unpack_from(
                    ">4I", data, definition
                )
                if def_tag == 0x070601:
                    module = string(data, module_offset)
                    module = re.sub(r":0x[0-9a-fA-F]+$", "", module)
                    source = None
                    if file_record and u32(data, file_record) == 0x0F0400:
                        source = string(data, u32(data, file_record + 8))
                    definitions[definition] = {"module": module, "definitionFile": source}
                    line = u32(data, definition + 16)
                    if source and line:
                        definitions[definition]["definitionLine"] = line
            if definition in definitions:
                scope.update(definitions[definition])
        if tag == 0x270513 and source_ref and u32(data, source_ref) == 0x2B1104:
            file_record, line = struct.unpack_from(">2I", data, source_ref + 8)
            if file_record and line and u32(data, file_record) == 0x0F0400:
                scope["sourceFile"] = string(data, u32(data, file_record + 8))
                scope["sourceLine"] = line
        if tag == 0x270528 and parent in scopes and "sourceLine" in scopes[parent]:
            scope.update({key: scopes[parent][key] for key in ("sourceFile", "sourceLine")})
        scopes[offset] = scope
        while variable:
            var_tag, next_variable, var_name, _, owner, type_offset = struct.unpack_from(
                ">6I", data, variable
            )
            if var_tag >> 8 != SIGNAL_RECORD or owner != offset or variable in signals:
                raise ValueError(f"Invalid SST2 declaration link at {variable:#x}")
            if type_offset not in types:
                types[type_offset] = signal_type(data, type_offset)
            signals[variable] = {
                "locator": variable, "scopeOffset": offset,
                "name": string(data, var_name), "typeOffset": type_offset,
                "recordKind": var_tag & 0xFF,
                **types[type_offset],
            }
            variable = next_variable
        pending.append((sibling, parent))
        pending.append((child, offset))
    return list(scopes.values()), list(signals.values())


def time_exponent(data):
    directory = u32(data, 0x14)
    if not directory or u32(data, directory) != 0x031101:
        return None
    end = u32(data, directory + 4)
    if directory + 16 <= end <= len(data) and u32(data, end - 16) == 0x120C0B:
        return struct.unpack_from(">b", data, end - 6)[0]
    return None


def series_index(data):
    check_header(data, 4)
    series = []
    seen_series = set()
    offset = u32(data, 20)
    while offset:
        if offset in seen_series:
            raise ValueError(f"Cycle in SST2 series at {offset:#x}")
        seen_series.add(offset)
        tag, next_offset = struct.unpack_from(">2I", data, offset)
        if tag == SERIES_RECORD:
            name_offset = u32(data, offset + 28)
            first_slice, data_start, last_slice = struct.unpack_from(
                ">3I", data, offset + 72
            )
            slices = []
            seen_slices = set()
            cursor = first_slice
            while cursor:
                (
                    tag, next_slice, start, start_sequence, end, end_sequence,
                    index_count, _, compression_tables, stream_base, var_index, flags,
                ) = struct.unpack_from(">II4Q6I", data, cursor)
                if (
                    tag != SLICE_RECORD or cursor in seen_slices or start > end
                    or any(pointer >= len(data) for pointer in (
                        var_index, stream_base, compression_tables
                    ))
                ):
                    raise ValueError(f"Invalid SST2 slice at {cursor:#x}")
                seen_slices.add(cursor)
                slices.append({
                    "offset": cursor, "start": start, "end": end,
                    "startSequence": start_sequence,
                    "endSequence": None if end_sequence == NO_SEQUENCE else end_sequence,
                    "indexCount": index_count, "variableIndexOffset": var_index,
                    "streamBase": stream_base, "compressionTablesOffset": compression_tables,
                    "flags": flags,
                })
                cursor = next_slice
            if slices and slices[-1]["offset"] != last_slice:
                raise ValueError(f"Last SST2 slice disagrees with series at {offset:#x}")
            series.append({
                "offset": offset, "name": string(data, name_offset),
                "dataStart": data_start, "slices": slices,
            })
        elif tag != 0x031101:
            raise ValueError(f"Unknown SST2 series record {tag:#x} at {offset:#x}")
        offset = next_offset
    return series


def read_streams(data, series, stream_requests, event_requests):
    requested = {}
    for series_id, variable_id in stream_requests:
        requested.setdefault(series_id, {})[variable_id] = None
    for series_id, variable_id, width, encoding in event_requests:
        if not 1 <= width <= 65536:
            raise ValueError("SST2 HDL width must be between 1 and 65536")
        requested.setdefault(series_id, {})[variable_id] = (width, encoding)
    remaining = MAX_EVENTS_PER_COMMAND
    for series_id, variables in requested.items():
        if not 0 <= series_id < len(series) or min(variables) < 0:
            raise ValueError("Invalid SST2 series or variable ID")
        slices = series[series_id]["slices"]
        if max(variables) >= max((item["indexCount"] for item in slices), default=0):
            raise ValueError(f"Unknown variable ID in SST2 series {series_id}")
        for time_slice in slices:
            available = {id_: width for id_, width in variables.items()
                         if id_ < time_slice["indexCount"]}
            if not available:
                continue
            tables = compression_tables(
                data, time_slice["compressionTablesOffset"], time_slice["offset"]
            )
            positions = stream_index(data, time_slice, tables[0])
            streams = []
            for variable_id, codec in available.items():
                start, end = positions[variable_id:variable_id + 2]
                stream = {"id": variable_id, "offset": start, "byteLength": end - start}
                if codec is not None:
                    width, encoding = codec
                    events = decode_logic(
                        data, time_slice, positions, variable_id, width, tables, remaining, encoding
                    )
                    stream["events"] = events
                    remaining -= len(events)
                streams.append(stream)
            time_slice["streams"] = streams


def named_streams(names, scopes, signals, series):
    scope_paths = {scope["offset"]: scope["path"] for scope in scopes}
    by_locator = {}
    for signal in signals:
        path = f'{scope_paths[signal["scopeOffset"]]}.{signal["name"]}'
        if any(name == path or name.startswith((path + ".", path + "[")) for name in names):
            by_locator[signal["locator"]] = (path, signal)
    requests = []
    resolved = {}
    for series_id, item in enumerate(series):
        split = {}
        for entry in item["signals"]:
            target = by_locator.get(entry["locator"])
            if target is None:
                continue
            path, layout = target
            elements = entry.get("elements", ())
            while elements and layout.get("encoding") in ("array", "struct"):
                member = locator_path(path, layout, elements[:1])
                if member is None:
                    break
                path, layout = member
                elements = elements[1:]
            encoding = layout.get("encoding")
            width = layout.get("width", 1 if encoding == "string" else None)
            if width is None:
                continue
            projections = {path: None} if path in names else {}
            if encoding in ("logic", "bit"):
                for name in names:
                    if name != path:
                        projection = packed_projection(path, layout, name)
                        if projection is not None:
                            projections[name] = projection
            if projections and not elements:
                requests.append((series_id, entry["id"], width, encoding))
                for name, projection in projections.items():
                    resolved[name] = (series_id, [entry["id"]], False, projection)
            elif projections and len(elements) == 1 and encoding in ("logic", "bit"):
                slots = split.setdefault(path, (width, encoding, {}, projections))[2]
                slots[elements[0]] = entry["id"]
        for width, encoding, slots, projections in split.values():
            if set(slots) == set(range(width)) and projections.keys() - resolved.keys():
                ids = [slots[i] for i in range(width)]
                requests.extend((series_id, variable_id, 1, encoding) for variable_id in ids)
                for name, projection in projections.items():
                    resolved.setdefault(name, (series_id, ids, True, projection))
    pending = set(names) - resolved.keys()
    if pending:
        raise ValueError("No supported recorded stream for " + ", ".join(sorted(pending)))
    return requests, resolved


def join_bit_streams(slices, ids):
    changes = {}
    slots = {}
    for slot, variable_id in enumerate(ids):
        slots.setdefault(variable_id, []).append(slot)
    for time_slice in slices:
        for stream in time_slice.get("streams", []):
            for slot in slots.get(stream["id"], []):
                for tick, value in stream["events"]:
                    changes.setdefault(tick, {})[slot] = value
    level = ["x"] * len(ids)
    events = []
    for tick in sorted(changes):
        for slot, value in changes[tick].items():
            level[slot] = value
        value = "".join(level)
        if not events or value != events[-1][1]:
            events.append((tick, value))
    return events


def named_result(series, binding):
    series_id, ids, split, projection = binding
    record = {"series": series_id, "ids": ids}
    if not split and projection is None:
        return record
    slices = series[series_id]["slices"]
    if split:
        events = join_bit_streams(slices, ids)
    else:
        events = [
            event for time_slice in slices
            for stream in time_slice.get("streams", []) if stream["id"] == ids[0]
            for event in stream["events"]
        ]
    if projection is not None:
        start, end = projection
        events = [(tick, value[start:end]) for tick, value in events]
        events = [next(group) for _, group in itertools.groupby(events, key=lambda event: event[1])]
    record["events"] = events
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dsn", type=Path, help="SST2 .dsn component")
    parser.add_argument("trn", type=Path, help="Matching SST2 .trn component")
    parser.add_argument(
        "--stream", nargs=2, type=int, action="append", metavar=("SERIES", "ID"),
        help="Include each slice's byte range for a numeric series and variable ID",
    )
    parser.add_argument(
        "--events", nargs=3, type=int, action="append", metavar=("SERIES", "ID", "WIDTH"),
        help="Decode an indexed four-state stream with the given HDL width",
    )
    parser.add_argument(
        "--signal", action="append", metavar="PATH",
        help="Decode a recorded value by full hierarchical name",
    )
    args = parser.parse_args()
    try:
        with args.dsn.open("rb") as source, mmap.mmap(
            source.fileno(), 0, access=mmap.ACCESS_READ
        ) as data:
            scopes, signals = design(data)
            design_id = string(data, u32(data, 0x28))
        with args.trn.open("rb") as source, mmap.mmap(
            source.fileno(), 0, access=mmap.ACCESS_READ
        ) as data:
            series = series_index(data)
            exponent = time_exponent(data)
            matching_id = any(
                string(data, u32(data, row["offset"] + 32)) == design_id
                for row in series
            )
            if not design_id or not matching_id:
                raise ValueError("SST2 design ID differs between DSN and TRN")
            declarations = {signal["locator"] for signal in signals}
            for item in series:
                item["signals"] = locator_index(data, item, declarations)
            by_name, resolved = named_streams(
                set(args.signal), scopes, signals, series
            ) if args.signal else ([], {})
            raw_requests = [(*request, "logic") for request in args.events or []]
            read_streams(data, series, args.stream or [], raw_requests + by_name)
        result = {"scopes": scopes, "signals": signals, "series": series}
        if exponent is not None:
            result["secondsPerTickExponent"] = exponent
        if resolved:
            result["requestedSignals"] = {
                path: named_result(series, binding) for path, binding in resolved.items()
            }
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
    except (OSError, ValueError, struct.error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
