# SPDX-License-Identifier: MPL-2.0
# Experimental source-unit ranges read from user-generated database metadata.
# Does not read RTL source content, vendor code/libraries, or oracle files.
import struct
import re
from pathlib import Path
from kdb_records import Unsupported


class Cursor:
    def __init__(self, data, offset=0):
        self.data, self.offset = data, offset

    def read(self, fmt):
        size = struct.calcsize(fmt)
        if self.offset + size > len(self.data):
            raise Unsupported("truncated source mapping record")
        value = struct.unpack_from(fmt, self.data, self.offset)
        self.offset += size
        return value

    def string(self, complemented=False):
        end = self.data.find(b"\0", self.offset)
        if end < 0 or end - self.offset > 1048576:
            raise Unsupported("invalid source mapping string")
        raw = self.data[self.offset:end]
        self.offset = end + 1
        if complemented:
            raw = bytes(value ^ 255 for value in raw)
        return raw.decode("utf-8")


class SourceIndex:
    def __init__(self, elab_directory):
        self.units = {}
        self.libraries = []
        self.documents = {}
        for filename in sorted(Path(elab_directory).glob("*.lib++/MapTbl")):
            library = filename.parent
            names = Cursor((library / "AbsDocNameTbl").read_bytes())
            revision, endian, flags, count = names.read("<IIII")
            if revision != 0 or endian != 0x01020304 or flags != 4 or count > 100000:
                raise Unsupported("unrecognized absolute-document-name table")
            mapping = {}
            for _ in range(count):
                relative, absolute = names.string(True), names.string(True)
                names.read("<BI")  # Metadata whose semantics are not yet established.
                if relative in mapping and mapping[relative] != absolute:
                    raise Unsupported("ambiguous document mapping")
                mapping[relative] = absolute
            if names.offset != len(names.data):
                raise Unsupported("unparsed absolute-document-name tail")
            basename_mapping = {}
            for key, absolute in mapping.items():
                basename_mapping.setdefault(Path(key).name, set()).add(absolute)
            self.documents[library.name] = (mapping, basename_mapping)

            table = Cursor(filename.read_bytes())
            endian, revision, bucket_count = table.read("<III")
            if endian != 0x01020304 or revision != 117:
                raise Unsupported("unrecognized source-unit mapping format")
            records = []
            if bucket_count > 1024:
                raise Unsupported("unsupported source-unit bucket count")
            collisions = 0
            for _ in range(bucket_count):
                bucket = table.read("<I")[0]
                count, slot = bucket >> 10, bucket & 1023
                if count < 1 or count > 100000 or len(records) + count > 100000:
                    raise Unsupported("source-unit bucket budget exceeded")
                collisions += count - 1
                for _ in range(count):
                    fingerprint = table.read("<I")[0]
                    if fingerprint & 1023 != slot:
                        raise Unsupported("source-unit hash/bucket mismatch")
                    unit, source = table.string(), table.string()
                    if not unit.endswith("&hdl"):
                        raise Unsupported("unsupported source-unit language")
                    first, last, first_column, last_column = table.read("<IIII")
                    if first < 1 or last < first:
                        raise Unsupported("invalid source-unit line range")
                    records.append({"unit": unit[:-4], "source": source,
                                    "line": first, "endLine": last,
                                    "column": first_column, "endColumn": last_column})
            file_count = table.read("<I")[0]
            if file_count > 100000:
                raise Unsupported("source-file record budget exceeded")
            for _ in range(file_count):
                table.string()
                table.read("<I")
            if table.offset != len(table.data):
                raise Unsupported("unparsed source-unit mapping tail")

            for record in records:
                source = record["source"]
                absolute = mapping.get(source)
                if absolute is None and source != "?":
                    candidates = basename_mapping.get(Path(source).name, set())
                    if len(candidates) == 1:
                        absolute = next(iter(candidates))
                    elif len(candidates) > 1:
                        record["unresolvedReason"] = "ambiguous source basename"
                # Preserve the stored virtual include name, while exposing a
                # physical editor path for the observed VCS include suffix.
                physical = re.sub(r"#inc__[^#]+__\d+#$", "", absolute) if absolute else None
                record.update(file=physical, databaseFile=absolute, library=library.name)
                self.units.setdefault(record["unit"], []).append(record)
            self.libraries.append({"library": library.name, "sourceUnits": len(records),
                                   "buckets": bucket_count, "collisions": collisions,
                                   "documents": len(mapping)})

    def lookup(self, unit):
        records = self.units.get(unit, [])
        if len(records) == 1 and records[0]["file"]:
            return records[0]
        return None

    def document(self, library, source):
        mapping, basenames = self.documents.get(library, ({}, {}))
        absolute = mapping.get(source)
        if absolute is None:
            candidates = basenames.get(Path(source).name, set())
            if len(candidates) != 1:
                return None
            absolute = next(iter(candidates))
        return re.sub(r"#inc__[^#]+__\d+#$", "", absolute)


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser()
    parser.add_argument("elab_directory", type=Path)
    args = parser.parse_args()
    index = SourceIndex(args.elab_directory)
    print(json.dumps({"libraries": index.libraries, "units": index.units}, indent=2))
