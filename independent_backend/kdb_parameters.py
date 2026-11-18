# SPDX-License-Identifier: MPL-2.0
"""Elaborated parameter-set rows for the verified version-one archive."""
import struct
from collections import Counter

from kdb_archive import read_framed
from kdb_records import Unsupported


class ParameterSets:
    def __init__(self, directory):
        self.sets = {}
        self.record_counts = Counter()
        filename = directory / "_paramSetElabDB"
        if not filename.exists():
            return
        frames = read_framed(filename, with_metadata=True)
        for frame, (data, metadata) in enumerate(frames):
            if metadata is None:
                raise Unsupported("not a KDB parameter frame")
            name_count, set_count, first_reserved, second_reserved = metadata
            if (first_reserved or second_reserved or name_count > 1_000_000
                    or not 0 < set_count <= 31 or frame < len(frames) - 1 and set_count != 31):
                raise Unsupported("unverified KDB parameter frame counts")
            names, offset = [None], 0
            for _ in range(name_count):
                end = data.find(b"\0", offset)
                if end < 0 or end - offset > 1048576:
                    raise Unsupported("unterminated KDB parameter string")
                names.append(data[offset:end].decode("utf-8"))
                offset = end + 1
            for slot in range(set_count):
                if len(data) - offset < 16:
                    raise Unsupported("truncated KDB parameter set")
                tag, flags, name_id, count = struct.unpack_from("<4I", data, offset)
                offset += 16
                if tag != 32 or flags or name_id >= len(names) or count > (len(data) - offset) // 64:
                    raise Unsupported("unverified KDB parameter set layout")
                entries = {}
                records = 0
                while offset < len(data):
                    if len(data) - offset < 4:
                        raise Unsupported("truncated KDB parameter record tag")
                    tag = struct.unpack_from("<I", data, offset)[0]
                    if tag == 32:
                        break
                    if tag not in (33, 35) or len(data) - offset < 64:
                        raise Unsupported("unverified KDB parameter record")
                    tag, flags, unit, key, value_kind, literal_id, aux, payload, trailer = struct.unpack_from("<II7Q", data, offset)
                    offset += 64
                    records += 1
                    self.record_counts[tag] += 1
                    if tag == 35 or not unit:
                        continue
                    if (unit, key) in entries:
                        raise Unsupported("unverified KDB parameter entry layout")
                    if ((value_kind & 0xFFFFFF in (4, 5) or value_kind == 0x305)
                            and payload < len(names) and literal_id < len(names)):
                        value = names[payload]
                    else:
                        value = payload
                    entries[unit, key] = (flags, value_kind, value, aux, trailer)
                if records < count:
                    raise Unsupported("KDB parameter set contains too few records")
                # Slot zero is reserved in each 32-slot group. The archive
                # begins at group one, after the reserved initial group.
                self.sets[33 + frame * 32 + slot] = names[name_id], entries
            if offset != len(data):
                raise Unsupported("KDB parameter frame has unparsed bytes")

    def lookup(self, reference, unit, key):
        if not reference:
            return None
        slot = reference >> 1
        if not reference & 1 or slot not in self.sets:
            raise Unsupported("invalid KDB variant parameter-set reference")
        _, entries = self.sets[slot]
        if not any(member_unit == unit for member_unit, _ in entries):
            raise Unsupported("KDB parameter set does not include variant source unit")
        return entries.get((unit, key))
