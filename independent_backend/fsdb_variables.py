# SPDX-License-Identifier: MPL-2.0
"""Native variable pages and ID-list feasibility decoder, without an SDK."""
from fsdb_container import MAX_BLOCK
from kdb_records import Unsupported

PAGE = 65536


class VariablePages:
    def __init__(self, container):
        self.pages = [container.block(row, "x") for row in container.variable_blocks]
        if len(self.pages) * PAGE > MAX_BLOCK or any(not 0 < len(page) <= PAGE for page in self.pages):
            raise Unsupported("native variable pages exceed budget or capacity")

    def read(self, address, length):
        if address < 0 or length < 0 or length > MAX_BLOCK:
            raise Unsupported("native variable read exceeds budget")
        chunks = []
        while length:
            ordinal, offset = address >> 16, address & 0xFFFF
            if ordinal >= len(self.pages):
                raise Unsupported("native variable pointer exceeds page table")
            size = min(length, PAGE - offset)
            page = self.pages[ordinal]
            if offset + size > len(page):
                raise Unsupported("native variable read enters an unmapped page tail")
            chunks.append(page[offset:offset + size])
            address += size
            length -= size
        return b"".join(chunks)


class VariableCursor:
    def __init__(self, pages, address):
        self.pages, self.offset = pages, address

    def integer(self, size=1):
        raw = self.pages.read(self.offset, size)
        self.offset += size
        return int.from_bytes(raw, "little")

    def string(self):
        chunks, total = [], 0
        while True:
            ordinal, offset = self.offset >> 16, self.offset & 0xFFFF
            if ordinal >= len(self.pages.pages) or offset >= len(self.pages.pages[ordinal]):
                raise Unsupported("native variable string enters an unmapped page tail")
            page = self.pages.pages[ordinal]
            end = page.find(b"\0", offset)
            size = (end if end >= 0 else len(page)) - offset
            chunks.append(page[offset:offset + size])
            total += size
            if total > 1048576:
                raise Unsupported("native variable string exceeds budget")
            self.offset += size
            if end >= 0:
                self.offset += 1
                return b"".join(chunks).decode("utf-8")
            if len(page) != PAGE:
                raise Unsupported("unterminated native variable string")


def literal(cursor, tag, previous_id=None):
    start = cursor.offset - 1
    if tag > 63:
        raise Unsupported(f"unrecognized literal native variable kind {hex(tag)} at {start}, previous id {previous_id}")
    name, shape = cursor.string(), cursor.integer()
    if shape & 0x10 == 0:
        raise Unsupported(f"unrecognized literal variable range shape {hex(shape)}, address {start}, tag {tag}, name {name}")
    if shape & 0x40:
        raise Unsupported("unverified literal variable shape flag 0x40")
    descriptor = cursor.integer() if shape & 0x20 else 0x10
    bounds = []
    for shift in (0, 2):
        width = (0, 1, 2, 4)[shape >> shift & 3]
        bounds.append(cursor.integer(width))
    mode = descriptor >> 4 & 3
    if mode == 3:
        if previous_id is None:
            raise Unsupported("literal incremental ID has no predecessor")
        signal_id = previous_id + 1
    else:
        signal_id = cursor.integer(1 << mode)
    enum_key = cursor.integer(2) if shape & 0x80 else None
    return {"kind": "literal", "nativeId": signal_id, "name": name,
            "width": abs(bounds[0] - bounds[1]) + 1, "supported": tag not in (3, 63),
            "placeholder": bool(descriptor & 4), "idDescriptor": descriptor, "enumKey": enum_key, "varKind": tag}


def variable_groups(container):
    """Decode physical lists once; scopes may reference the same list again."""
    pages = VariablePages(container)
    groups, ordinal, previous_id = {}, 0, None
    for snapshot in container.snapshots:
        count = len(snapshot["variables"])
        if not count:
            continue
        if any(len(page) != PAGE for page in pages.pages[ordinal:ordinal + count - 1]):
            raise Unsupported("nonfinal native variable page has an unrecognized short capacity")
        begin = ordinal << 16
        end = ((ordinal + count - 1) << 16) + len(pages.pages[ordinal + count - 1])
        cursor = VariableCursor(pages, begin)
        if not ordinal:
            if cursor.integer() != 0xBF:
                raise Unsupported("native variable file header missing")
        while cursor.offset < end:
            start, records, previous_index = cursor.offset, [], -1
            while True:
                tag = cursor.integer()
                if tag == 0xFF:
                    break
                if tag == 0xD5:
                    descriptor = cursor.integer()
                    if descriptor & 15:
                        raise Unsupported("native variable ID descriptor low bits are not implemented: " + hex(descriptor))
                    mode = descriptor >> 4 & 3
                    if mode == 3:
                        if previous_id is None:
                            raise Unsupported("native incremental ID has no predecessor")
                        signal_id = previous_id + 1
                    else:
                        signal_id = cursor.integer(1 << mode)
                    index_mode = descriptor >> 6
                    variable_index = previous_index + 1 if index_mode == 3 else cursor.integer(1 << index_mode)
                    records.append({"kind": "typed", "nativeId": signal_id, "variableIndex": variable_index})
                    previous_index = variable_index
                else:
                    record = literal(cursor, tag, previous_id)
                    signal_id = record["nativeId"]
                    records.append(record)
                if not 0 < signal_id <= container.header_max_id:
                    raise Unsupported("native variable id exceeds file header maximum")
                previous_id = signal_id
                if len(records) > 1000000 or cursor.offset > end:
                    raise Unsupported("native variable list exceeds count/snapshot bounds")
            if cursor.offset > end or start in groups:
                raise Unsupported("native variable group overlaps/end mismatch")
            groups[start] = records
        if cursor.offset != end:
            raise Unsupported("native variable snapshot tail not consumed")
        ordinal += count
    return groups
