# SPDX-License-Identifier: MPL-2.0
"""Single-signal event feasibility decoder for original generated FSDB samples.

It is NOT a general FSDB reader: multiple signals, multiple time blocks and
unrecognized declarations/operations are explicitly unsupported. The known
version-86 container directory is followed directly, without index scanning.
No oracle/VCD/SDK is used by the decoder.
"""
import struct
from pathlib import Path
from kdb_records import Unsupported
from fsdb_container import Container
from fsdb_declarations import wires


def dictionary_vector(data, start=0):
    if len(data) - start < 6 or data[start] != 0xFE or data[start + 5] not in (4, 8):
        raise Unsupported("unrecognized time-dictionary vector header")
    mode = data[start + 5]
    count = struct.unpack_from("<I", data, start + 1)[0]
    if not 0 < count <= 1000000:
        raise Unsupported("time-dictionary count exceeds budget")
    offset, values = start + 6, []
    while len(values) < count:
        if offset >= len(data):
            raise Unsupported("truncated time-dictionary width descriptor")
        widths = data[offset]
        offset += 1
        group_count = min(4, count - len(values))
        for i in range(group_count):
            width = 1 << (widths >> (i * 2) & 3)
            if width > mode:
                raise Unsupported("integer width exceeds dictionary mode")
            if offset + width > len(data):
                raise Unsupported("truncated time-dictionary integer")
            if mode == 8 and width == 8:
                # 64-bit time tags serialize two little-endian u32 words in
                # (high, low) order; they are not a little-endian u64.
                high, low = struct.unpack_from("<II", data, offset)
                values.append(high << 32 | low)
            else:
                values.append(int.from_bytes(data[offset:offset + width], "little"))
            offset += width
        if widths >> (group_count * 2):
            raise Unsupported("nonzero unused dictionary width bits")
    if values[0] != 0 or len(set(values)) != len(values):
        raise Unsupported("inconsistent time-dictionary vector")
    return {"mode": mode, "values": values}, offset


def time_dictionaries(data):
    offset, result = 0, []
    while offset < len(data):
        vector, offset = dictionary_vector(data, offset)
        result.append(vector)
        if len(result) > 2:
            raise Unsupported("more than two time-dictionary modes")
    if len({vector["mode"] for vector in result}) != len(result):
        raise Unsupported("duplicate time-dictionary modes")
    return result


def time_dictionary(data):
    vectors = time_dictionaries(data)
    if len(vectors) != 1 or vectors[0]["mode"] != 4:
        raise Unsupported("lab scalar reader only handles one 32-bit delta dictionary")
    return vectors[0]["values"]


def wire_declarations(raw):
    if not raw or raw[0] != 0xBF:
        raise Unsupported("unrecognized scalar declaration block")
    rows, end = wires(raw, 1, 2)
    if not rows or end != len(raw):
        raise Unsupported("scalar declaration terminator mismatch")
    if len({row["width"] for row in rows}) != 1:
        raise Unsupported("alias widths differ")
    return rows


class PacketTruncated(Unsupported):
    """The current contiguous bytes end before the packet does."""


def vector_packet(raw, offset, deltas, count, state_flags, width):
    encoding = raw[offset:offset + 2]
    if len(raw) - offset < 7:
        raise PacketTruncated("truncated external vector prefix")
    if encoding not in (b"\x04\x00", b"\x0a\x00", b"\x0b\x00", b"\x19\x00", b"\x1a\x00") or int.from_bytes(raw[offset + 2:offset + 6], "little") != width:
        raise Unsupported("external vector width/prefix mismatch")
    events, current, max_delta, seen_states, previous_value, previous_mask = [], 0, 0, 0, 0, 0
    offset += 6
    states = "01xz"
    while offset < len(raw):
        code = raw[offset]
        offset += 1
        if code == 0xC1:
            if len(events) != count or seen_states != state_flags:
                raise Unsupported("vector count/state mismatch")
            return events, max_delta, offset
        elif not events and code in ((0x30,) if encoding[0] == 4 else (0x30, 0x38)):
            delta = 0
        elif code in ((0, 0x10, 0x20) if encoding[0] == 4 else (0, 8, 0x10, 0x18, 0x20, 0x28)):
            index_width = 1 << (code >> 4)
            if offset + index_width > len(raw) - 1:
                raise PacketTruncated("truncated vector delta reference")
            index = int.from_bytes(raw[offset:offset + index_width], "little")
            offset += index_width
            if index >= len(deltas):
                raise Unsupported("unrecognized vector delta reference")
            delta = deltas[index]
        else:
            raise Unsupported("unrecognized vector operation: " + hex(code))
        word_bytes = (width + 7) // 8 if encoding[0] in (0x0B, 0x1A) else ((width + 31) // 32) * 4
        unknown = encoding[0] != 4 and not code & 8
        literal_bytes = width if encoding[0] == 4 else word_bytes * (2 if unknown else 1)
        if offset + literal_bytes > len(raw) - 1:
            raise PacketTruncated("truncated vector literal")
        if len(events) >= count:
            raise Unsupported("vector literal exceeds packet/event bounds")
        literal = raw[offset:offset + literal_bytes]
        offset += literal_bytes
        if encoding[0] == 4:
            if any(value > 3 for value in literal):
                raise Unsupported("unrecognized four-state vector literal")
            seen_states |= (8 if 2 in literal else 0) | (16 if 3 in literal else 0)
            bits = "".join(states[value] for value in literal)
        else:
            if unknown and encoding[0] in (0x0A, 0x19):
                # Original wide-vector controls store (mask, value) pairs per
                # 32-bit word. Prefix 19 uses XOR deltas for both planes.
                mask = sum(int.from_bytes(literal[i * 8:i * 8 + 4], "little") << (i * 32) for i in range(word_bytes // 4))
                value = sum(int.from_bytes(literal[i * 8 + 4:i * 8 + 8], "little") << (i * 32) for i in range(word_bytes // 4))
            elif unknown and encoding[0] in (0x0B, 0x1A):
                # Byte-packed array payloads store the complete value plane
                # before the complete mask plane, including a partial byte.
                value = int.from_bytes(literal[:word_bytes], "little")
                mask = int.from_bytes(literal[word_bytes:], "little")
            else:
                mask = 0
                value = int.from_bytes(literal, "little")
            if encoding[0] in (0x19, 0x1A):
                value ^= previous_value
                mask ^= previous_mask
            previous_value = value
            previous_mask = mask
            # The final physical word/byte may retain padding outside the
            # declared bit count (observed in real packed slices). Only the
            # declared bits are values; padding is not a format error.
            bits = "".join(("x" if value >> bit & 1 else "z") if mask >> bit & 1 else
                           ("1" if value >> bit & 1 else "0") for bit in range(width - 1, -1, -1))
            # Presence flags describe physical packed storage, including its
            # padding; the SDK returns only the declared visible bit count.
            seen_states |= (8 if mask & value else 0) | (16 if mask & ~value else 0)
        current += delta
        if events:
            max_delta = max(max_delta, delta)
        events.append([str(current), bits])
    raise PacketTruncated("vector packet terminator missing")


def vector_events(raw, deltas, count, state_flags, width):
    events, max_delta, end = vector_packet(raw, 0, deltas, count, state_flags, width)
    if end != len(raw):
        raise Unsupported("unparsed bytes after vector packet")
    return events, max_delta


def scalar_packet(raw, offset, deltas, count, state_flags, initial_time=0):
    current, events, history, seen_states = initial_time, [], [], 0
    states = {1: "0", 2: "1", 3: "x", 4: "z"}

    def append(state, delta):
        nonlocal current, seen_states
        if len(events) >= count:
            raise Unsupported("scalar operations exceed declared event count")
        current += delta
        events.append([str(current), state])
        history.append((state, delta))
        seen_states |= 8 if state == "x" else 16 if state == "z" else 0

    while offset < len(raw):
        code = raw[offset]
        offset += 1
        if code == 0xC1:
            if len(events) != count or seen_states != state_flags:
                raise Unsupported("scalar count/state mismatch")
            return events, max((delta for _, delta in history[1:]), default=0), offset
        elif not events and not initial_time and 0x31 <= code <= 0x34:
            append(states[code & 15], 0)
        elif code & 15 in states and code >> 4 in (0, 1, 2):
            index_width = 1 << (code >> 4)
            if offset + index_width > len(raw) - 1:
                raise PacketTruncated("truncated scalar time-delta reference")
            index = int.from_bytes(raw[offset:offset + index_width], "little")
            offset += index_width
            if index >= len(deltas):
                raise Unsupported("unsupported scalar time-delta reference")
            append(states[code & 15], deltas[index])
        elif 0x40 <= code <= 0x4F or code == 0x50:
            # Clock run: repeat the preceding two alternating transitions,
            # preserving independently encoded high/low durations.
            if 0x41 <= code <= 0x4F:
                repeat = (code & 15) - 1
            else:
                width = 1 if code == 0x40 else 2
                if offset + width > len(raw) - 1:
                    raise PacketTruncated("truncated clock-run length")
                repeat = int.from_bytes(raw[offset:offset + width], "little")
                offset += width
            if repeat <= 0 or len(history) < 2:
                raise Unsupported("unverified clock-run history")
            pattern = history[-2:]
            if {state for state, _ in pattern} != {"0", "1"}:
                raise Unsupported("clock run requires alternating binary states")
            for i in range(repeat):
                append(*pattern[i & 1])
        else:
            raise Unsupported("unsupported scalar event operation: " + hex(code))
    raise PacketTruncated("scalar packet terminator missing")


def scalar_events(raw, offset, deltas, count, state_flags, initial_time=0):
    events, max_delta, end = scalar_packet(raw, offset, deltas, count, state_flags, initial_time)
    if end != len(raw):
        raise Unsupported("unparsed bytes after scalar packet")
    return events, max_delta


def decode_window(container, window, dictionaries, width, initial_time):
    if len(window["indexes"]) != 1 or len(window["values"]) > 1:
        raise Unsupported("lab decoder requires one event index and at most one value block")
    raw = container.block(window["indexes"][0], "x")
    if len(raw) < 7:
        raise Unsupported("truncated inline event packet")
    if raw[0] & ~0x18 == 0xC5:
        if width != 1 or window["values"] or raw[2:5] != b"\xff\xff\x00" or 8 not in dictionaries:
            raise Unsupported("unrecognized wide-delta inline packet")
        count = raw[1]
        if not 0 < count <= 8:
            raise Unsupported("unrecognized wide-delta inline count")
        # Each window starts its accumulator at zero. Its first dictionary
        # entry is an absolute first-event time, subsequent entries are deltas.
        events, _ = scalar_events(raw, 5, dictionaries[8], count, raw[0] & 0x18)
        return events
    if raw[0] != 0x11 or initial_time or 4 not in dictionaries:
        raise Unsupported("unrecognized first-window packet or continued external values")
    deltas = dictionaries[4]
    packed = struct.unpack_from("<I", raw, 1)[0]
    flags = packed & 255
    inline = flags & ~0x18 == 0xC0
    if inline and window["values"]:
        raise Unsupported("additional value/time blocks after an inline packet are not implemented")
    if inline:
        count = packed >> 8
        if not 0 < count <= 8 or width != 1:
            raise Unsupported("unrecognized inline scalar event count")
        events, _ = scalar_events(raw, 5, deltas, count, flags & 0x18)
    else:
        if packed & ~(0x30 | 0xC0 | 0xC00 | 0x3000) or len(window["values"]) != 1:
            raise Unsupported("unrecognized external scalar metadata flags")
        offset, metadata = 5, []
        for shift in (4, 6, 10):
            field_width = 1 << (packed >> shift & 3)
            if field_width > 4 or offset + field_width > len(raw):
                raise Unsupported("external scalar metadata exceeds supported width")
            metadata.append(int.from_bytes(raw[offset:offset + field_width], "little"))
            offset += field_width
            if shift == 6:
                if offset >= len(raw) or raw[offset] != 0:
                    raise Unsupported("unrecognized external scalar reserved byte")
                offset += 1
        max_delta, count, last_time = metadata
        if offset != len(raw) or not 0 < count <= 1000000:
            raise Unsupported("external scalar metadata length/count mismatch")
        values = container.block(window["values"][0], "zlib")
        state_flags = ((8 if packed & 0x1000 else 0) | (16 if packed & 0x2000 else 0))
        if width == 1:
            if not values or values[0] != 0:
                raise Unsupported("unrecognized scalar value prefix")
            events, decoded_delta = scalar_events(values, 1, deltas, count, state_flags)
        else:
            events, decoded_delta = vector_events(values, deltas, count, state_flags, width)
        if int(events[-1][0]) != last_time or decoded_delta != max_delta:
            raise Unsupported("external scalar final time/maximum delta mismatch")
    return events


def read_scalar(filename):
    container = Container(Path(filename))
    if (container.signal_word != 2 or len(container.variable_blocks) != 1 or len(container.scope_blocks) != 1 or
            container.declaration_extensions != bytes(4) or container.window_extensions or container.dictionary_extensions):
        raise Unsupported("lab decoder requires one signal and no unrecognized metadata extensions")
    declarations = wire_declarations(container.block(container.variable_blocks[0], "x"))
    names = [row["name"] for row in declarations]
    width = declarations[0]["width"]
    dictionaries = {row["mode"]: row["values"] for row in time_dictionaries(container.dictionary())}
    events = []
    for window in container.windows:
        decoded = decode_window(container, window, dictionaries, width, int(events[-1][0]) if events else 0)
        if events and int(decoded[0][0]) <= int(events[-1][0]):
            raise Unsupported("time-window events are not strictly increasing")
        events.extend(decoded)
    return {"backend": "experimental-fsdb-single-signal-lab", "events": events,
            "names": names, "timeDictionaries": dictionaries, "eventCount": len(events), "timeWindows": len(container.windows),
            "width": width,
            "limitations": "one signal, version 86, limited wire/event forms and wide-delta continuation; no general FSDB API"}


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument("filename", type=Path)
    args = parser.parse_args()
    print(json.dumps(read_scalar(args.filename), indent=2))
