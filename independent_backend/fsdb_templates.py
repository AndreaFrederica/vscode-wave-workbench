# SPDX-License-Identifier: MPL-2.0
"""Small native template experiment; unrecognized records fail explicitly."""
from dataclasses import dataclass
from fsdb_container import MAX_BLOCK
from kdb_records import Unsupported


@dataclass
class Cursor:
    data: bytes
    offset: int = 0

    def integer(self, size=1):
        if size < 0 or self.offset + size > len(self.data):
            raise Unsupported("truncated native FSDB template")
        value = int.from_bytes(self.data[self.offset:self.offset + size], "little")
        self.offset += size
        return value

    def string(self):
        end = self.data.find(b"\0", self.offset, self.offset + 1048576)
        if end < 0:
            raise Unsupported("unterminated native template string")
        result = self.data[self.offset:end].decode("utf-8")
        self.offset = end + 1
        return result

    def require(self, value, size=1):
        actual = self.integer(size)
        if actual != value:
            raise Unsupported(f"unrecognized template field at {self.offset - size}: {actual}, expected {value}")


def template_bytes(container):
    cursor = Cursor(container.dictionary_extensions)
    section_size = cursor.integer(4)
    if section_size != len(cursor.data) - 4 or section_size > MAX_BLOCK:
        raise Unsupported("unrecognized native template section size")
    blocks, total = [], 0
    while cursor.offset < len(cursor.data):
        size = cursor.integer(4)
        if not size:
            if cursor.offset != len(cursor.data):
                raise Unsupported("trailing native template sections are not implemented")
            return b"".join(blocks)
        if size > len(cursor.data) - cursor.offset:
            raise Unsupported("native template compressed block exceeds section")
        raw = container.decompress(cursor.data[cursor.offset:cursor.offset + size], "x")
        cursor.offset += size
        total += len(raw)
        if total > MAX_BLOCK:
            raise Unsupported("native template output exceeds budget")
        blocks.append(raw)
    raise Unsupported("native template section terminator missing")


def ranges(cursor, count):
    if not 0 < count <= 8:
        raise Unsupported("native template dimension count exceeds supported range")
    result = []
    for _ in range(count):
        descriptor = cursor.integer()
        if descriptor & 15:
            raise Unsupported("signed/extended native bounds are not implemented")
        bounds = []
        for shift in (6, 4):
            width = (0, 1, 2, 4)[descriptor >> shift & 3]
            value = cursor.integer(width)
            bounds.append(value - (1 << 32) if width == 4 and value & 0x80000000 else value)
        left, right = bounds
        result.append((left, right))
    return result


def parse_templates(raw):
    cursor, records = Cursor(raw), {}
    while cursor.offset < len(raw):
        start, tag = cursor.offset, cursor.integer()
        if tag == 0x80:
            if cursor.offset == len(raw):
                return records
            # Each independently compressed native table segment has its own
            # end marker. Full files concatenate several such segments.
            continue
        try:
            if tag == 0x0F:
                flags, key = cursor.integer(), cursor.integer(2)
                if flags == 0:
                    dtype, dimensions = cursor.integer(), cursor.integer()
                    if dtype not in (0, 4):
                        raise Unsupported("non-logic packed vector templates are not implemented")
                    row = {"kind": "packed", "dtype": dtype, "ranges": ranges(cursor, dimensions)}
                elif flags == 0x10:
                    element, dimensions = cursor.integer(2), cursor.integer()
                    row = {"kind": "packed-elements", "element": element, "ranges": ranges(cursor, dimensions)}
                else:
                    raise Unsupported("unrecognized native packed-type flags")
            elif tag == 0x10:
                flags, key = cursor.integer(), cursor.integer(2)
                if flags == 0x10:
                    element, dtype = cursor.integer(2), None
                elif flags == 0:
                    element, dtype = None, cursor.integer()
                else:
                    raise Unsupported("unrecognized native unpacked-array base flags")
                row = {"kind": "unpacked", "element": element, "dtype": dtype, "ranges": ranges(cursor, cursor.integer())}
            elif tag in (0x11, 0x12, 0x13):
                descriptor = cursor.integer()
                if descriptor not in (0, 1):
                    raise Unsupported("unverified wide struct template header")
                key, count = cursor.integer(2), cursor.integer()
                bit_width = cursor.integer(1 << descriptor)
                if not 0 < count <= 255:
                    raise Unsupported("native struct member count exceeds supported form")
                members = []
                for base in range(0, count, 8):
                    bitmap = cursor.integer()
                    group_count = min(8, count - base)
                    if bitmap >> group_count:
                        raise Unsupported("nonzero unused struct descriptor bits")
                    for member in range(group_count):
                        members.append({"type": cursor.integer(4)} if bitmap >> member & 1 else {"dtype": cursor.integer()})
                for member in members:
                    member["name"] = cursor.string()
                # This total is the sum of callback member widths, including
                # every union view. It is not SystemVerilog $bits(union).
                row = {"kind": "union" if tag == 0x13 else "struct",
                       "packed": None if tag == 0x13 else tag == 0x11,
                       "flatBitWidth": bit_width, "members": members}
                if sum(value_width(records, member.get("type"), member.get("dtype")) for member in members) != bit_width:
                    raise Unsupported("native struct member widths do not match recorded total")
            elif tag == 1:
                flags, key = cursor.integer(), cursor.integer(2)
                if flags == 0x10:
                    element, dtype = cursor.integer(2), None
                elif flags == 0:
                    element, dtype = None, cursor.integer()
                    if dtype not in (0, 4, 6, 8, 10, 12, 14):
                        raise Unsupported("unverified native primitive enum base")
                else:
                    raise Unsupported("unrecognized native enum base flags")
                count = cursor.integer()
                names = [cursor.string() for _ in range(count)]
                width = value_width(records, element, dtype)
                if not 0 < count <= 255 or count * width > MAX_BLOCK:
                    raise Unsupported("native enum constant table exceeds budget")
                constants = []
                for _ in names:
                    values = [cursor.integer() for _ in range(width)]
                    if any(value > 3 for value in values):
                        raise Unsupported("unrecognized enum four-state constant encoding")
                    constants.append("".join("01xz"[value] for value in values))
                row = {"kind": "enum", "element": element, "dtype": dtype, "constants": dict(zip(names, constants))}
            elif tag == 0x15:
                scope_kind = cursor.integer()
                descriptor = cursor.integer()
                if descriptor not in (0, 4, 0x10, 0x14, 0x20):
                    raise Unsupported("unverified wide native scope-template counts/keys")
                key = cursor.integer(2)
                variable_count = cursor.integer(1 << (descriptor >> 4 & 3))
                child_count = cursor.integer(1 << (descriptor >> 2 & 3))
                definition = cursor.string()
                children = [cursor.string() for _ in range(child_count)]
                variables = []
                for base in range(0, variable_count, 4):
                    descriptor = cursor.integer()
                    count = min(4, variable_count - base)
                    for item in range(count):
                        kind = descriptor >> (6 - item * 2) & 3
                        if kind == 0:
                            dtype = cursor.integer()
                            reference = {"dtype": dtype}
                        elif kind == 1:
                            reference = {"type": cursor.integer(2)}
                        else:
                            raise Unsupported("unrecognized native variable type class: " + str(kind))
                        reference.update(direction=cursor.integer(), flags=cursor.integer())
                        variables.append(reference)
                    if descriptor & ((1 << (8 - count * 2)) - 1):
                        raise Unsupported("nonzero unused native variable descriptor bits")
                for variable in variables:
                    variable["name"] = cursor.string()
                row = {"kind": "scope", "scopeKind": scope_kind, "definition": definition,
                       "children": children, "variables": variables}
            else:
                raise Unsupported("native template record is not implemented: " + hex(tag))
            if key in records or len(records) > 1000000:
                raise Unsupported("duplicate/excessive native template keys")
            records[key] = row
        except Unsupported as error:
            raise Unsupported(f"native template byte {start}: {error}") from error
    raise Unsupported("native template stream terminator missing")


def value_width(records, type_key=None, dtype=None):
    if type_key is None:
        widths = {0: 1, 4: 1, 6: 64, 8: 32, 10: 32, 12: 16, 14: 8, 18: 64}
        if dtype not in widths:
            raise Unsupported("unverified native primitive width: " + str(dtype))
        return widths[dtype]
    value = records[type_key]
    if value["kind"] == "packed":
        width = 1
        for left, right in value["ranges"]:
            width *= abs(left - right) + 1
        return width
    if value["kind"] in ("struct", "union"):
        return value["flatBitWidth"]
    if value["kind"] == "enum":
        return value_width(records, value["element"], value["dtype"])
    if value["kind"] == "packed-elements":
        width = value_width(records, value["element"])
        for left, right in value["ranges"]:
            width *= abs(left - right) + 1
        return width
    raise Unsupported("value width for native type is not implemented: " + value["kind"])


def atom_variables(records, key):
    row = records[key]
    if row["kind"] != "scope":
        raise Unsupported("scope template key refers to a value type")
    results = []

    def expand(name, type_key=None, dtype=None, active=()):
        if len(active) > 32 or type_key in active:
            raise Unsupported("recursive or deep native value template")
        if type_key is None:
            if dtype in (16, 19):
                # Both real and shortreal controls are surfaced by the
                # current bridge as one unsupported (non-1B/bit) variable.
                results.append({"name": name, "width": 1, "supported": False})
                return
            if dtype not in (0, 4, 6, 8, 10, 12, 14, 18):
                raise Unsupported("non-logic primitive variable templates are not implemented")
            width = value_width(records, dtype=dtype)
            results.append({"name": name + (f"[{width - 1}:0]" if width > 1 else ""), "width": width})
            return
        value = records[type_key]
        if value["kind"] == "packed":
            suffix, width = "", 1
            for left, right in value["ranges"]:
                suffix += f"[{left}:{right}]"
                width *= abs(left - right) + 1
            results.append({"name": name + suffix, "width": width})
        elif value["kind"] == "enum":
            expand(name, value["element"], value["dtype"], active + (type_key,))
        elif value["kind"] in ("struct", "union"):
            # The existing SDK bridge ignores struct begin/end callbacks, so
            # its VAR names are member names within the surrounding scope.
            # Retain the template separately; do not invent a different path.
            for member in value["members"]:
                expand(member["name"], member.get("type"), member.get("dtype"), active + (type_key,))
        elif value["kind"] in ("unpacked", "packed-elements"):
            names = [name]
            for left, right in value["ranges"]:
                if len(names) * (abs(left - right) + 1) > 1000000:
                    raise Unsupported(f"native unpacked array exceeds budget: {name}, type {type_key}, range {left}:{right}")
                step = 1 if right >= left else -1
                names = [prefix + f"[{index}]" for prefix in names for index in range(left, right + step, step)]
            for element_name in names:
                expand(element_name, value["element"], value.get("dtype"), active + (type_key,))
        else:
            raise Unsupported("native variable value kind is not implemented: " + value["kind"])
    for variable in row["variables"]:
        begin = len(results)
        expand(variable["name"], variable.get("type"), variable.get("dtype"))
        for result in results[begin:]:
            result["parameter"] = bool(variable["flags"] & 1)
    return results
