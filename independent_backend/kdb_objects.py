# SPDX-License-Identifier: MPL-2.0
"""Partial source-object and elaboration-variant mapping from user databases.

Independent of RTL content, reference JSON, and proprietary SDK libraries.
"""
import struct
from pathlib import Path
from kdb_archive import read_framed, PagedArchive, Lzo
from kdb_records import Unsupported


class ArenaView:
    def __init__(self, archive):
        self.blocks = archive.decode()

    def bytes(self, key, length):
        if not isinstance(key, int) or key < 0:
            raise Unsupported("null or invalid source-object key")
        page, offset = key >> 16, key & 65535
        if not 0 <= page < len(self.blocks):
            raise Unsupported("object page outside arena")
        data = self.blocks[page]["data"]
        if offset + length > len(data):
            raise Unsupported("object outside decoded page")
        return data[offset:offset + length]

    def read(self, key, fmt):
        return struct.unpack(fmt, self.bytes(key, struct.calcsize(fmt)))

    def pointer(self, key, target_view=None):
        low, page = self.read(key, "<II")
        if low == page == 0:
            return None
        target_view = self if target_view is None else target_view
        if low & 3 != 1 or not 1 <= page <= len(target_view.blocks) or low > 65536:
            raise Unsupported("unrecognized object pointer encoding")
        return ((page - 1) << 16) | (low & ~3)

    def string(self, key):
        self.bytes(key, 1)
        page, offset = key >> 16, key & 65535
        data = self.blocks[page]["data"]
        end = data.find(b"\0", offset)
        if end < 0 or end - offset > 1048576:
            raise Unsupported("unterminated arena string")
        return data[offset:end].decode("utf-8")


def elaboration_records(directory):
    raw = b"".join(read_framed(Path(directory) / "_stnElabDB"))
    offset = 0
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise Unsupported("truncated elaboration record")
        marker, kind, size = struct.unpack_from("<HHI", raw, offset)
        if marker not in (29, 285, 541) or size < 8 or offset + size > len(raw):
            raise Unsupported("unrecognized elaboration record header")
        yield marker, kind, raw[offset + 8:offset + size]
        offset += size


def source_unit_records(directory):
    records = []
    for marker, kind, payload in elaboration_records(directory):
        if kind == 15:
            size = len(payload) + 8
            if size < 27:
                raise Unsupported("truncated elaboration source-unit record")
            key, unit = struct.unpack_from("<QQ", payload)
            names = payload[16:].split(b"\0")
            if len(names) != 4 or names[-1] or names[1] != b"hdl":
                raise Unsupported("unrecognized source-unit name record")
            records.append({"key": key, "unit": unit, "name": names[0].decode(), "library": names[2].decode()})
    return records


class ObjectDatabase:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.units, self.cache, self.variants = {}, {}, {}
        self.origins, self.unit_names = {}, {}
        self.unit_libraries, self.long_strings, self.file_tables = {}, {}, {}
        self.extended_files = {}
        self.cached_bytes = 0
        identities = {}
        for item in source_unit_records(directory):
            if item["key"] == 24:
                identity = (item["library"], item["name"])
                identities.setdefault(identity, set()).add(item["unit"])
                self.unit_names[item["unit"]] = item["name"]
        for marker, kind, payload in elaboration_records(directory):
            if kind == 13 and marker == 541:
                if len(payload) != 24:
                    raise Unsupported("unrecognized source clone mapping size")
                source, original, unit, original_unit = struct.unpack("<QQII", payload)
                key = (unit, source)
                if key in self.origins and self.origins[key] != (original_unit, original):
                    raise Unsupported("ambiguous source clone origin")
                self.origins[key] = (original_unit, original)
        for libfile in sorted(self.directory.glob("*.lib++/libfile")):
            library = libfile.parent.name[:-6]
            strings = (libfile.parent / "SM_LONG_STR_FILE_NAME").read_bytes()
            if len(strings) < 52 or struct.unpack_from("<I", strings, 8)[0] != 0x01020304:
                raise Unsupported("unrecognized long-string table header")
            parts, stored_offset, decoded_budget = [], 48, 0
            while stored_offset < len(strings):
                if stored_offset + 4 > len(strings):
                    raise Unsupported("truncated long-string chunk size")
                stored_size = struct.unpack_from("<I", strings, stored_offset)[0]
                stored_offset += 4
                if not stored_size or stored_offset + stored_size > len(strings):
                    raise Unsupported("long-string stored size mismatch")
                part = Lzo().decompress_bounded("c", strings[stored_offset:stored_offset + stored_size])
                decoded_budget += len(part)
                if decoded_budget > 16 * 1024 * 1024:
                    raise Unsupported("long-string table exceeds decoded budget")
                parts.append(part)
                stored_offset += stored_size
            plain = b"".join(parts)
            count, offset = struct.unpack_from("<I", plain)[0], 4
            names = []
            if count > 100000:
                raise Unsupported("long-string count exceeds budget")
            for _ in range(count):
                if offset + 4 > len(plain):
                    raise Unsupported("truncated long-string size")
                size = struct.unpack_from("<I", plain, offset)[0]
                offset += 4
                if offset + size >= len(plain) or plain[offset + size] != 0:
                    raise Unsupported("truncated long-string data")
                names.append(plain[offset:offset + size].decode("utf-8"))
                offset += size + 1
            if offset != len(plain):
                raise Unsupported("unparsed long-string table tail")
            self.long_strings[libfile.parent.name] = names
            view = ArenaView(PagedArchive(libfile))
            if view.read(24, "<I")[0] != 0x200114:
                raise Unsupported("unrecognized library root object")
            if view.read(24 + 48, "<Q")[0] != 1:
                raise Unsupported("multiple source-language groups unsupported")
            group = view.pointer(24 + 56)
            if group is None or view.read(group, "<I")[0] != 0x40016:
                raise Unsupported("unrecognized source-language group")
            if view.string(view.pointer(group + 8)) != "hdl":
                raise Unsupported("unsupported source language")
            node, seen = view.pointer(group + 40), set()
            count = view.read(24 + 32, "<Q")[0]
            while node is not None:
                if node in seen or len(seen) >= 100000:
                    raise Unsupported("invalid compilation-unit chain")
                seen.add(node)
                if view.read(node, "<I")[0] != 0x80017:
                    raise Unsupported("unrecognized compilation-unit metadata")
                descriptor = view.pointer(node + 8)
                if view.read(descriptor, "<I")[0] != 21:
                    raise Unsupported("unrecognized compilation-unit descriptor")
                name = view.string(view.pointer(descriptor + 16))
                extent = view.pointer(node + 40)
                if extent is None or view.read(node + 56, "<I")[0] != 0x240000:
                    raise Unsupported("unrecognized source arena extent")
                root, first, last = view.read(extent, "<III")
                if root != 24 or last < first:
                    raise Unsupported("unrecognized source arena root/range")
                ids = identities.get((library, name), set())
                if len(ids) != 1:
                    raise Unsupported("ambiguous compilation-unit identity: " + library + ":" + name)
                unit = next(iter(ids))
                archive = PagedArchive(libfile.parent / "oh.etc/_oharch", first)
                if archive.end != last + 1 or unit in self.units:
                    raise Unsupported("source arena identity/extent mismatch")
                self.units[unit] = archive
                self.unit_libraries[unit] = libfile.parent.name
                node = view.pointer(node + 32)
            if len(seen) != count:
                raise Unsupported("compilation-unit count mismatch")
        raw = b"".join(read_framed(self.directory / "_nstnElabDB"))
        if len(raw) % 32:
            raise Unsupported("unrecognized elaboration variant record size")
        for offset in range(0, len(raw), 32):
            flags, unit, target_unit, kind, source, target = struct.unpack_from("<IIIIQQ", raw, offset)
            if flags not in (0, 65536) or not 1 <= kind <= 256:
                raise Unsupported("unrecognized elaboration variant record")
            if not flags:
                self.variants.setdefault((unit, source), []).append((target_unit, target, kind))

    def view(self, unit):
        unit &= 0xFFFFFFFF
        if unit not in self.cache:
            if unit not in self.units:
                raise Unsupported("unknown source object unit")
            estimate = sum(b["decoded"] for b in self.units[unit].blocks)
            if self.cached_bytes + estimate > 256 * 1024 * 1024:
                raise Unsupported("source-object cache exceeds decoded-byte budget")
            self.cache[unit] = ArenaView(self.units[unit])
            self.cached_bytes += estimate
        return self.cache[unit]

    def resolve_master(self, instance, masters):
        """Return an existing canonical definition only when records identify it."""
        unit, source = instance["scopeKey"] & 0xFFFFFFFF, instance["sourceKey"]
        view = self.view(unit)
        header = view.read(source, "<I")[0]
        if header & 0xFFFF == 0x2E:
            source = view.pointer(source + 8)
            header = view.read(source, "<I")[0]
        if header & 0xFFFF == 0x2051:
            original = view.pointer(source + 72)
            matches = [m for m in masters if m["scopeKey"] == unit and m["sourceKey"] == original
                       and m["category"] & 0xFFFF in (7, 8, 9)]
        elif header & 0xFFFF in (0x12C, 0x12D, 0x2C, 0x2D):
            target_units = {t for t, _, _ in self.variants.get((unit, source), []) if t}
            matches = [m for m in masters if m["scopeKey"] in target_units and m["category"] & 0xFFFF == 0]
            if not matches:
                statement = view.pointer(source + 40)
                if statement is None or view.read(statement, "<I")[0] & 0xFFFF != 0x2B:
                    raise Unsupported("unrecognized instance declaration statement")
                name = view.string(view.pointer(statement + 16))
                matches = [m for m in masters if m["name"] == name and m["category"] & 0xFFFF in (0, 1)]
        else:
            matches = []
        signatures = {(m["name"], m["scopeKey"], m["sourceKey"], m["category"]) for m in matches}
        if len(signatures) == 1:
            return matches[0]
        return None

    def instance_line(self, instance):
        unit, source = self.original_source(instance)
        view = self.view(unit)
        header = view.read(source, "<I")[0]
        if header & 0xFFFF == 0x2E:
            source = view.pointer(source + 8)
            header = view.read(source, "<I")[0]
        if header & 0xFFFF in (0x1051, 0x2051):
            source = view.pointer(source + 72)
            header = view.read(source, "<I")[0]
        if header & 0xFFFF in (0x12C, 0x12D, 0x2C, 0x2D, 0x142):
            return view.read(source + 24, "<I")[0]
        if header & 0xFFFF == 0x11F:
            return view.read(source + 104, "<I")[0]
        return None

    def original_source(self, instance):
        unit, source = instance["scopeKey"] & 0xFFFFFFFF, instance["sourceKey"]
        flags = instance["scopeKey"] >> 32
        if flags not in (0, 2):
            raise Unsupported("unrecognized source-unit reference flags")
        if flags == 2:
            if (unit, source) not in self.origins:
                raise Unsupported("missing bind source origin")
            unit, source = self.origins[(unit, source)]
        return unit, source

    def is_interface_port_reference(self, instance):
        unit, source = self.original_source(instance)
        view = self.view(unit)
        kind = view.read(source, "<I")[0] & 255
        if kind == 46:
            source = view.pointer(source + 8)
            kind = view.read(source, "<I")[0] & 255
        return kind == 77

    def source_files(self, unit):
        if unit in self.file_tables:
            return self.file_tables[unit]
        view = self.view(unit)
        root = 24
        if view.read(root, "<I")[0] & 255 not in (31, 32):
            raise Unsupported("unrecognized source-document root")
        primary = view.read(root + 80, "<Q")[0]
        handles = {}
        # Recognize root-owned integer property records on general-object pages.
        # Duplicate, missing, or invalid references fail; arbitrary string search
        # alone must never select an object's source document.
        for page, block in enumerate(view.blocks):
            if block["flags"] != 0:
                continue
            data = block["data"]
            for offset in range(0, len(data) - 47, 8):
                if struct.unpack_from("<Q", data, offset)[0] != 11:
                    continue
                key = (page << 16) | offset
                try:
                    owner = view.pointer(key + 40)
                    if owner != root:
                        continue
                    name = view.string(view.pointer(key + 8))
                except Unsupported:
                    continue
                if not name.startswith("bof") or not name[3:].isdigit():
                    continue
                number = int(name[3:])
                handle = view.read(key + 32, "<Q")[0]
                if number in handles and handles[number] != handle:
                    raise Unsupported(f"conflicting source-file properties in unit {unit} ({self.unit_names.get(unit)}), file {number}: {handles[number]} vs {handle}")
                handles[number] = handle
        handles.setdefault(1, primary)
        result = {}
        for number, handle in handles.items():
            result[number] = self.document_from_handle(unit, handle)
        self.file_tables[unit] = result
        return result

    def document_from_handle(self, unit, handle):
        names = self.long_strings[self.unit_libraries[unit]]
        if handle & 1 or not 1 <= handle // 2 <= len(names):
            raise Unsupported("unrecognized source-document string handle")
        return names[handle // 2 - 1]

    def extended_file_number(self, unit, source):
        if unit not in self.extended_files:
            view, result = self.view(unit), {}
            for page, block in enumerate(view.blocks):
                data = block["data"]
                for offset in range(0, len(data) - 47, 8):
                    if struct.unpack_from("<Q", data, offset)[0] != 11:
                        continue
                    key = (page << 16) | offset
                    try:
                        if view.string(view.pointer(key + 8)) != "bofl":
                            continue
                        owner = view.pointer(key + 40)
                    except Unsupported:
                        continue
                    if view.read(key + 24, "<Q")[0] != 1:
                        raise Unsupported("unrecognized extended source-file property type")
                    number = view.read(key + 32, "<Q")[0]
                    if owner in result and result[owner] != number:
                        raise Unsupported("conflicting extended source-file numbers")
                    result[owner] = number
            self.extended_files[unit] = result
        if source not in self.extended_files[unit]:
            raise Unsupported("missing extended source-file number")
        return self.extended_files[unit][source]

    def instance_position(self, instance, sources):
        unit, source = self.original_source(instance)
        view = self.view(unit)
        header = view.read(source, "<I")[0]
        if header & 255 == 46:
            source = view.pointer(source + 8)
            header = view.read(source, "<I")[0]
        if header & 255 == 81:
            source = view.pointer(source + 72)
            header = view.read(source, "<I")[0]
        kind = header & 255
        if kind in (44, 45, 64, 66, 82):
            file_number, line = (header >> 8) & 127, view.read(source + 24, "<I")[0]
            if file_number == 127:
                file_number = self.extended_file_number(unit, source)
        elif kind in (31, 32):
            file_number, line = 1, view.read(source + 104, "<I")[0]
        else:
            return None
        if not file_number:
            return None
        document = (self.document_from_handle(unit, view.read(source + 80, "<Q")[0])
                    if kind in (31, 32) else self.source_files(unit).get(file_number))
        if document is None:
            raise Unsupported("unresolved local source-file number")
        filename = sources.document(self.unit_libraries[unit], document)
        return {"file": filename, "line": line} if filename and line else None
