# SPDX-License-Identifier: MPL-2.0
"""Uncompressed-name scope/wire declaration experiment (VCD-style files)."""
import struct
from fsdb_container import Container, MAX_BLOCK
from kdb_records import Unsupported


def cstring(data, offset):
    end = data.find(b"\0", offset, offset + 1048576)
    if end < 0:
        raise Unsupported("unterminated FSDB declaration string")
    return data[offset:end].decode("utf-8"), end + 1


def plain_scopes(raw):
    if raw[:2] != b"\xfe\x00":
        raise Unsupported("compressed/extended FSDB scope names are not implemented")
    rows, stack, offset = [], [], 2
    while offset < len(raw):
        code = raw[offset]
        offset += 1
        if code == 0:
            name, offset = cstring(raw, offset)
            definition, offset = cstring(raw, offset)
            if offset >= len(raw) or raw[offset] != 0:
                raise Unsupported("unrecognized plain scope type/attributes")
            offset += 1
            if offset >= len(raw) or raw[offset] not in (0, 1):
                raise Unsupported("unrecognized scope variable-list presence flag")
            has_variables = raw[offset]
            offset += 1
            variable_offset = None
            if has_variables:
                if offset + 4 > len(raw):
                    raise Unsupported("truncated scope variable-list reference")
                variable_offset = struct.unpack_from("<I", raw, offset)[0]
                offset += 4
            parent = stack[-1]["fullname"] if stack else ""
            row = {"name": name, "definition": definition, "parent": parent,
                   "fullname": parent + "." + name if parent else name, "variableOffset": variable_offset}
            rows.append(row)
            stack.append(row)
            if len(rows) > 1000000 or len(stack) > 256:
                raise Unsupported("FSDB scope budget exceeded")
        elif code == 0xFD:
            if not stack or offset >= len(raw) or raw[offset] != 0:
                raise Unsupported("unrecognized plain scope close")
            stack.pop()
            offset += 1
        elif code == 0xFF and not stack and offset == len(raw):
            return rows
        else:
            raise Unsupported("unrecognized plain scope operation: " + hex(code))
    raise Unsupported("FSDB scope terminator missing")


def wires(raw, offset, signal_id_limit):
    rows = []
    while offset < len(raw) and raw[offset] != 0xFF:
        if raw[offset] != 15:
            raise Unsupported("non-wire FSDB variable kind is not implemented: " + hex(raw[offset]))
        name, offset = cstring(raw, offset + 1)
        if offset >= len(raw) or raw[offset] & 0xF0 != 0x10:
            raise Unsupported("extended FSDB wire range/id encoding is not implemented")
        tag = raw[offset]
        offset += 1
        bounds = []
        for shift in (0, 2):
            code = tag >> shift & 3
            size = (0, 1, 2, 4)[code]
            if offset + size > len(raw):
                raise Unsupported("truncated FSDB wire bound")
            value = int.from_bytes(raw[offset:offset + size], "little")
            bounds.append(value - (1 << 32) if size == 4 and value & 0x80000000 else value)
            offset += size
        if offset + 2 > len(raw):
            raise Unsupported("truncated FSDB wire id")
        signal_id = struct.unpack_from("<H", raw, offset)[0]
        offset += 2
        if not 0 < signal_id < signal_id_limit:
            raise Unsupported("FSDB wire id exceeds directory limit")
        left, right = bounds
        if tag != 0x10 and not name.endswith("[" + str(left) + ":" + str(right) + "]"):
            raise Unsupported("FSDB wire name/range mismatch")
        rows.append({"name": name, "left": left, "right": right, "width": abs(left - right) + 1,
                     "nativeId": signal_id})
        if len(rows) > 1000000:
            raise Unsupported("FSDB variable count exceeds budget")
    if offset >= len(raw) or raw[offset] != 255:
        raise Unsupported("unterminated FSDB wire list")
    return rows, offset + 1


def declarations(filename):
    container = Container(filename)
    if len(container.snapshots) != 1:
        raise Unsupported("plain declaration adapter does not handle multiple snapshots")
    if container.declaration_extensions != bytes(4) or container.signal_word > 65536:
        raise Unsupported("extended FSDB declarations/id widths are not implemented")
    scopes_raw = b"".join(container.block(row, "x") for row in container.scope_blocks)
    variables_raw = b"".join(container.block(row, "x") for row in container.variable_blocks)
    if len(scopes_raw) + len(variables_raw) > MAX_BLOCK or variables_raw[:1] != b"\xbf":
        raise Unsupported("FSDB declaration stream exceeds budget/header mismatch")
    scopes, signals, spans = plain_scopes(scopes_raw), [], []
    for scope in scopes:
        start = scope["variableOffset"]
        if start is None:
            continue
        if not 0 < start < len(variables_raw):
            raise Unsupported("scope variable offset exceeds stream")
        rows, end = wires(variables_raw, start, container.signal_word)
        spans.append((start, end))
        for row in rows:
            signals.append({**row, "scope": scope["fullname"], "fullname": scope["fullname"] + "." + row["name"]})
    cursor = 1
    for start, end in sorted(spans):
        if start != cursor:
            raise Unsupported("declaration lists overlap or leave unparsed bytes")
        cursor = end
    if cursor != len(variables_raw):
        raise Unsupported("unparsed tail in FSDB declaration stream")
    if len({row["fullname"] for row in signals}) != len(signals):
        raise Unsupported("duplicate FSDB signal names")
    return {"scopes": scopes, "signals": signals, "scope": "plain scope names and wire declarations only"}
