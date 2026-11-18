# SPDX-License-Identifier: MPL-2.0
# Experimental container/record inspection inferred from synthetic user data.
# No vendor headers, code, library calls, or oracle/source-file reads.
import ctypes as c
import ctypes.util
import struct
from pathlib import Path


class Unsupported(ValueError):
    pass


class Buffer:
    def __init__(self, data):
        self.data = data

    def read(self, fmt, pos):
        if pos < 0 or pos + struct.calcsize(fmt) > len(self.data):
            raise Unsupported("record offset outside buffer")
        return struct.unpack_from(fmt, self.data, pos)

    def u32(self, pos):
        return self.read("<I", pos)[0]

    def table(self, pos=None):
        if pos is None:
            if self.data[4:8] != b"0000":
                raise Unsupported("unrecognized table identifier")
            pos = self.u32(0)
        vt = pos - self.read("<i", pos)[0]
        size, object_bytes = self.read("<HH", vt)
        if size < 4 or size % 2 or size > 256 or object_bytes < 4:
            raise Unsupported("invalid vtable size")
        fields = self.read("<" + "H" * ((size - 4) // 2), vt + 4)
        return pos, fields

    def vector(self, slot, stride, pos=None):
        pos, fields = self.table(pos)
        if slot >= len(fields) or not fields[slot]:
            return []
        field = pos + fields[slot]
        target = field + self.u32(field)
        count = self.u32(target)
        if count > 1000000 or target + 4 + stride * count > len(self.data):
            raise Unsupported("vector exceeds buffer or budget")
        return [target + 4 + i * stride for i in range(count)]

    def string(self, pos):
        target = pos + self.u32(pos)
        size = self.u32(target)
        if size > 1048576 or target + 4 + size >= len(self.data):
            raise Unsupported("string exceeds buffer or budget")
        if self.data[target + 4 + size] != 0:
            raise Unsupported("missing string terminator")
        return self.data[target + 4:target + 4 + size].decode("utf-8")


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        index = Buffer((self.directory / "sdb.db").read_bytes())
        files = [index.string(pos) for pos in index.vector(2, 4)]
        if any(Path(name).name != name for name in files):
            raise Unsupported("unsupported file path in container index")
        self.blocks = []
        z = c.CDLL(ctypes.util.find_library("zstd"))
        z.ZSTD_decompress.argtypes = [c.c_void_p, c.c_size_t, c.c_void_p, c.c_size_t]
        z.ZSTD_decompress.restype = c.c_size_t
        z.ZSTD_isError.argtypes, z.ZSTD_isError.restype = [c.c_size_t], c.c_uint
        z.ZSTD_getErrorName.argtypes, z.ZSTD_getErrorName.restype = [c.c_size_t], c.c_char_p
        budget = 0
        for pos in index.vector(4, 24):
            kind, file_id = index.read("<BB", pos)
            if index.data[pos + 2:pos + 8] != bytes(6):
                raise Unsupported("unrecognized chunk-index metadata")
            size, stored, offset = index.read("<IIQ", pos + 8)
            if not 1 <= file_id <= len(files) or size > 64 * 1024 * 1024:
                raise Unsupported("unsupported chunk size/file index")
            budget += size
            if budget > 256 * 1024 * 1024:
                raise Unsupported("inspection exceeds decoded-byte budget")
            with (self.directory / files[file_id - 1]).open("rb") as stream:
                stream.seek(offset)
                data = stream.read(stored)
            if len(data) != stored:
                raise Unsupported("truncated indexed chunk")
            if data.startswith(bytes.fromhex("28b52ffd")):
                source = c.create_string_buffer(data)
                target = c.create_string_buffer(size)
                length = z.ZSTD_decompress(target, size, source, stored)
                if z.ZSTD_isError(length):
                    raise Unsupported(z.ZSTD_getErrorName(length).decode())
                data = target.raw[:length]
            if len(data) != size:
                raise Unsupported("unsupported compression or decoded length")
            self.blocks.append({"kind": kind, "file": files[file_id - 1],
                                "offset": offset, "stored": stored, "data": data})
        strings = [block for block in self.blocks if block["kind"] == 5]
        if len(strings) != 1:
            raise Unsupported("only one string chunk is currently supported")
        self.strings = strings[0]["data"]

    def name(self, tag, reference):
        if tag != 3 or reference < 1 or reference > len(self.strings):
            raise Unsupported("unsupported name reference")
        end = self.strings.find(b"\0", reference - 1)
        if end < 0:
            raise Unsupported("unterminated name")
        return self.strings[reference - 1:end].decode("utf-8")

    def instance_names(self):
        blocks = [block for block in self.blocks if block["kind"] == 3]
        if len(blocks) != 1:
            raise Unsupported("only one instance-name chunk is currently supported")
        b = Buffer(blocks[0]["data"])
        rows = []
        for number, pos in enumerate(b.vector(0, 24), 1):
            tag, reference, object_type, flags = b.read("<IIQQ", pos)
            rows.append({"id": number, "name": self.name(tag, reference),
                         "scopeKey": object_type, "sourceKey": flags})
        return rows

    def instance_links(self):
        self.master_names()
        rows = []
        instance_tag_seen = None
        for chunk, block in enumerate(self.blocks):
            if block["kind"] != 0:
                continue
            b = Buffer(block["data"])
            objects, parents, bindings = b.vector(0, 16), b.vector(2, 8), b.vector(1, 8)
            if len(objects) != len(parents):
                raise Unsupported("instance/parent vector length mismatch")
            # Trailing zero references are omitted. These are object reuse
            # links, not interface port binding targets (swapped-port probes).
            if len(bindings) > len(objects):
                raise Unsupported("instance reuse-reference count exceeds rows")
            for number, (pos, parent) in enumerate(zip(objects, parents)):
                tag, master, instance_tag, instance = b.read("<IIII", pos)
                parent_tag, parent_id = b.read("<II", parent)
                if not tag or not instance_tag or parent_tag not in (0, self.master_tag):
                    raise Unsupported("unrecognized instance reference tags")
                if instance_tag_seen is not None and instance_tag != instance_tag_seen:
                    raise Unsupported("mixed instance reference namespaces")
                instance_tag_seen = instance_tag
                reference = b.read("<II", bindings[number]) if number < len(bindings) else (0, 0)
                rows.append({"id": instance, "master": master, "parent": parent_id,
                             "bindingPresent": reference != (0, 0), "masterTag": tag,
                             "reference": reference, "chunk": chunk, "row": number + 1})
        return rows

    def instance_reference_index(self):
        variants = self.variant_records()
        chunks = {}
        for link in self.instance_links():
            chunks.setdefault(link["chunk"], []).append(link)
        result = {}
        for chunk, links in chunks.items():
            namespaces = set()
            for link in links:
                if link["parent"]:
                    if link["parent"] not in variants:
                        raise Unsupported("missing parent definition variant")
                    tag, first = variants[link["parent"]]["children"]
                    if not tag or not 1 <= first <= len(links):
                        raise Unsupported("invalid variant child-array reference")
                    namespaces.add(tag)
                elif link["masterTag"] == self.master_tag:
                    tag, row = variants[link["master"]]["representative"]
                    if row != link["row"]:
                        raise Unsupported("root representative row mismatch")
                    namespaces.add(tag)
            if len(namespaces) != 1:
                raise Unsupported("ambiguous instance-array namespace")
            namespace = next(iter(namespaces))
            for link in links:
                key = (namespace, link["row"])
                if key in result:
                    raise Unsupported("duplicate instance-array reference")
                result[key] = link
        return result

    def master_names(self):
        blocks = [block for block in self.blocks if block["kind"] == 1]
        if len(blocks) != 1:
            raise Unsupported("only one master-name chunk is currently supported")
        b = Buffer(blocks[0]["data"])
        records, handles = b.vector(0, 40), b.vector(9, 8)
        if len(records) != len(handles):
            raise Unsupported("master/handle vector length mismatch")
        rows = []
        for number, (pos, handle) in enumerate(zip(records, handles), 1):
            ref_tag, object_id = b.read("<II", handle)
            name_tag, name_ref = b.read("<II", pos + 8)
            if not ref_tag:
                raise Unsupported("null master handle namespace")
            if rows and ref_tag != self.master_tag:
                raise Unsupported("mixed master handle namespaces")
            self.master_tag = ref_tag
            rows.append({"id": object_id, "name": self.name(name_tag, name_ref),
                         "canonicalRecord": number,
                         "scopeKey": b.read("<Q", pos + 24)[0],
                         "sourceKey": b.read("<Q", pos + 32)[0],
                         "category": b.read("<I", pos)[0]})
        return rows

    def variant_records(self):
        canonical = self.master_names()
        blocks = [b for b in self.blocks if b["kind"] == 9]
        if len(blocks) != 1:
            raise Unsupported("only one definition-variant chunk is supported")
        b = Buffer(blocks[0]["data"])
        rows, sources = b.vector(0, 24), b.vector(1, 16)
        if len(rows) != len(sources):
            raise Unsupported("definition-variant/source count mismatch")
        result = {}
        for number, (pos, source) in enumerate(zip(rows, sources), 1):
            tag, index, instance_tag, instance, child_tag, child = b.read("<6I", pos)
            if tag != 2 or not 1 <= index <= len(canonical):
                raise Unsupported("unrecognized canonical definition reference")
            result[number] = {**canonical[index - 1], "id": number,
                              "representative": (instance_tag, instance), "children": (child_tag, child),
                              "variantSource": b.read("<QQ", source)}
        for master in canonical:
            if master["id"] not in result or result[master["id"]]["canonicalRecord"] != master["canonicalRecord"]:
                raise Unsupported("canonical definition/variant backlink mismatch")
        return result

    def array_master_references(self):
        aliases = {}
        for block in self.blocks:
            if block["kind"] != 2:
                continue
            b = Buffer(block["data"])
            kinds, references = b.vector(0, 1), b.vector(1, 4)
            if len(kinds) != len(references):
                raise Unsupported("block union tag/reference count mismatch")
            for number, (kind_pos, reference) in enumerate(zip(kinds, references), 1):
                if b.data[kind_pos] != 2:
                    continue
                target = reference + b.u32(reference)
                master_tag, master, shape_tag, shape = b.read("<IIII", target)
                if not master_tag or not master or not shape_tag or not 1 <= shape <= len(kinds):
                    raise Unsupported("invalid array master/shape reference")
                if b.data[kinds[shape - 1]] != 1:
                    raise Unsupported("unrecognized array shape union kind")
                key = (shape_tag, number)
                if key in aliases:
                    raise Unsupported("duplicate array master reference")
                aliases[key] = (master_tag, master)
        return aliases

    def array_shapes(self):
        """One-dimensional declaration bounds and source identity per wrapper."""
        result = {}
        for block in self.blocks:
            if block["kind"] != 2:
                continue
            b = Buffer(block["data"])
            kinds, references = b.vector(0, 1), b.vector(1, 4)
            if len(kinds) != len(references):
                raise Unsupported("array shape union count mismatch")
            for number, (kind, reference) in enumerate(zip(kinds, references), 1):
                if b.data[kind] != 2:
                    continue
                target = reference + b.u32(reference)
                master_tag, master, namespace, shape_id = b.read("<IIII", target)
                if not 1 <= shape_id <= len(kinds) or b.data[kinds[shape_id - 1]] != 1:
                    raise Unsupported("invalid array declaration shape")
                shape = references[shape_id - 1] + b.u32(references[shape_id - 1])
                right, left, name_tag, name_ref, owner_tag, owner, unit, source = b.read("<iiIIIIQQ", shape)
                if not namespace or not owner_tag or not owner or abs(right - left) >= 300000:
                    raise Unsupported("array declaration shape exceeds supported bounds")
                key = namespace, number
                if key in result:
                    raise Unsupported("duplicate array declaration shape")
                result[key] = {"namespace": namespace, "id": number, "right": right, "left": left,
                               "name": self.name(name_tag, name_ref), "owner": (owner_tag, owner),
                               "scopeKey": unit, "sourceKey": source, "master": (master_tag, master)}
        return result

    def hierarchy(self, subtree=None, objects=None, include_packages=False, *, database_order=False):
        self.excluded_references = []
        names = {item["id"]: item for item in self.instance_names()}
        canonical_masters = self.master_names()
        masters = self.variant_records() if objects else {item["id"]: item for item in canonical_masters}
        array_masters = self.array_master_references() if objects else {}
        unit_modules = {}
        for item in masters.values():
            if item["category"] & 0xFFFF in (0, 1, 4):
                if item["scopeKey"] in unit_modules and unit_modules[item["scopeKey"]] != item["name"]:
                    raise Unsupported("ambiguous source-unit/module association")
                unit_modules[item["scopeKey"]] = item["name"]
        adjacency = {}
        for link in self.instance_links():
            if link["id"] not in names:
                raise Unsupported("missing instance-name record")
            adjacency.setdefault(link["parent"], []).append(link)
        nodes, seen = [], set()
        kinds = {0: "npiModule", 1: "npiInterface", 3: "npiPackage", 4: "npiProgram", 7: "npiGenScope", 8: "npiGenScope", 9: "npiGenScope"}

        def visit(owner, parent, context_module, stack):
            if owner in stack or len(stack) > 256:
                raise Unsupported("recursive or excessive-depth hierarchy")
            for link in adjacency.get(owner, []):
                instance = names[link["id"]]
                name = instance["name"]
                full = parent + "." + name if parent else name
                if subtree and not (full == subtree or full.startswith(subtree + ".") or subtree.startswith(full + ".")):
                    continue
                target_tag, target_id = link["masterTag"], link["master"]
                if target_tag != self.master_tag and (target_tag, target_id) in array_masters:
                    target_tag, target_id = array_masters[(target_tag, target_id)]
                known = masters.get(target_id) if target_tag == self.master_tag else None
                if known and (known["category"] & 0xFFFF == 6 or
                              known["category"] & 0xFFFF == 3 and not include_packages):
                    continue  # Packages and primitive gates are not design scopes.
                if known and known["category"] & 0xFFFF == 3 and known["category"] & 0x200000:
                    # The observed implicit built-in package has no source file
                    # and is omitted by NPI's root instance iterator. Preserve
                    # this as a checked format condition, not a name blacklist.
                    if objects is None:
                        raise Unsupported("built-in package classification needs source objects")
                    header = objects.view(known["scopeKey"]).read(known["sourceKey"], "<I")[0]
                    if header & 255 != 31 or header >> 8 & 127:
                        raise Unsupported("unrecognized built-in package source metadata")
                    continue
                may_reference = link["bindingPresent"] or target_tag != self.master_tag or (known and known["category"] & 0xFFFF == 1)
                if objects is not None and may_reference and objects.is_interface_port_reference(instance):
                    self.excluded_references.append({"fullname": full, "instanceRecord": link["id"]})
                    continue
                if target_tag != self.master_tag:
                    raise Unsupported("unrecognized target master reference namespace")
                master = masters.get(target_id)
                if master is None and objects is not None:
                    master = objects.resolve_master(instance, canonical_masters)
                    if master is not None:
                        masters[target_id] = master
                category = master["category"] & 0xFFFF if master else None
                if category == 3 and not include_packages:
                    continue  # Packages are outside this design-tree probe.
                if category == 1 and link["bindingPresent"] and objects is None:
                    raise Unsupported("interface reference/binding semantics are not implemented")
                if master and category not in kinds:
                    raise Unsupported(f"unrecognized design master category {category} at {full}: {master}")
                if full in seen:
                    raise Unsupported("duplicate expanded instance path")
                seen.add(full)
                if len(seen) > 300000:
                    raise Unsupported("expanded hierarchy exceeds node budget")
                definition = master["name"] if master else None
                module = unit_modules.get(master["scopeKey"]) if category in (7, 8, 9) else definition
                kind = kinds.get(category)
                node = {"fullname": full, "parent": parent, "name": name,
                              "module": module, "kind": kind,
                              "definition": definition, "metadataResolved": master is not None and module is not None,
                              "instanceRecord": link["id"], "masterRecord": target_id,
                              "lexicalUnit": (objects.unit_names.get(objects.original_source(instance)[0])
                                              if objects else unit_modules.get(instance["scopeKey"]))}
                if not subtree or full == subtree or full.startswith(subtree + "."):
                    nodes.append(node)
                visit(target_id, full, module or context_module, stack | {owner})
        visit(0, "", None, set())
        if subtree and not any(node["fullname"] == subtree for node in nodes):
            raise Unsupported("requested hierarchy subtree not found")
        return nodes if database_order else sorted(nodes, key=lambda node: node["fullname"])


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="kdb.elab++/sdb")
    args = parser.parse_args()
    store = Store(args.source)
    print(json.dumps({"nodes": store.hierarchy(), "completeMetadata": all(
        node["metadataResolved"] for node in store.hierarchy())}, indent=2))
