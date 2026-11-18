# SPDX-License-Identifier: MPL-2.0
"""Private waveform operations over the standalone FSDB session."""
from bisect import bisect_right
from collections import OrderedDict, defaultdict
from pathlib import Path
import json

from fsdb_container import Container
from fsdb_session import Session
from kdb_records import Unsupported

MIB = 1024 * 1024


def wave_window(events, start, end, limit):
    """Return the value at the left boundary and transitions through end."""
    prior = bisect_right(events, (start, "\xff")) - 1
    result = [(start, events[prior][1])] if prior >= 0 else []
    for index in range(prior + 1, len(events)):
        instant, value = events[index]
        if instant > end:
            break
        if len(result) == limit:
            return result, True
        result.append((instant, value))
    return result, False


def virtual_value(operation, values, width):
    if operation == "concat":
        return "".join(values)
    padded = [value.rjust(width, "0") for value in values]
    result = []
    for bits in zip(*padded):
        if operation == "not":
            value = {"0": "1", "1": "0"}.get(bits[0], "x")
        elif operation == "and":
            value = "0" if "0" in bits else "1" if all(bit == "1" for bit in bits) else "x"
        elif operation == "or":
            value = "1" if "1" in bits else "0" if all(bit == "0" for bit in bits) else "x"
        else:
            value = "x" if "x" in bits or "z" in bits else str(bits.count("1") % 2)
        result.append(value)
    return "".join(result)


class WaveStore:
    def __init__(self, filename, budget=64 * MIB):
        filename = Path(filename)
        container = Container(filename)
        first_scope = container.block(container.scope_blocks[0], "x")
        self.session = Session(filename, native=first_scope.startswith(b"\xfe\x04"), container=container)
        self.signals = []
        self.ids, self.scopes = defaultdict(list), defaultdict(list)
        for row in self.session.declaration["signals"]:
            native_id = row["nativeId"]
            signal = {"id": str(native_id), "name": row["name"], "scope": row["scope"],
                      "width": row["width"], "supported": native_id not in self.session.unsupported}
            self.signals.append(signal)
            self.ids[signal["id"]].append(signal)
            self.scopes[signal["scope"]].append(signal)
        self.last_search = None
        self.virtuals = {}
        self.cache = OrderedDict()
        self.stats = dict(hits=0, misses=0, containingHits=0, evictions=0, bytes=0, entries=0,
                          budget=budget, reads=0)

    def metadata(self):
        container = self.session.container
        return {"signals": self.signals[:1500], "total": len(self.signals), "start": str(container.start),
                "end": str(container.end), "scale": container.scale, "backend": "native-fsdb"}

    def search(self, query="", offset=0, limit=1500):
        query = query.lower()
        if self.last_search is None or self.last_search[0] != query:
            rows = self.signals if not query else [
                row for row in self.signals if query in (row["scope"] + "." + row["name"]).lower()]
            self.last_search = query, rows
        return self.page(self.last_search[1], offset, limit)

    @staticmethod
    def page(rows, offset, limit):
        limit = min(1500, max(1, limit))
        if offset < 0:
            raise Unsupported("negative waveform page offset")
        return {"signals": rows[offset:offset + limit], "total": len(rows), "offset": offset}

    def scope_signals(self, query="", offset=0, limit=512):
        return {"scope": query, **self.page(self.scopes.get(query, []), offset, limit)}

    @staticmethod
    def matches_descriptor(row, descriptor):
        return all(descriptor.get(field) in (None, row[field]) for field in ("scope", "name"))

    def describe(self, descriptors=None, signals=None, query=None):
        if descriptors is None:
            descriptors = [{"id": signal_id} for signal_id in signals or []]
        if len(descriptors) > 100000:
            raise Unsupported("Too many descriptors (max 100000)")
        found = []
        for descriptor in descriptors:
            virtual = self.virtuals.get(descriptor["id"])
            if virtual is not None:
                if self.matches_descriptor(virtual[0], descriptor):
                    found.append(virtual[0])
                continue
            for row in self.ids.get(descriptor["id"], []):
                if self.matches_descriptor(row, descriptor) and query in (None, row["scope"] + "." + row["name"]):
                    found.append(row)
                    break
        return found

    def match_names(self, names, query=""):
        if len(names) > 20000 or any(len(name.encode("utf-8")) > 4096 for name in names):
            raise Unsupported("Too many RTL identifiers")
        requested = set(names)
        tails = {name.rsplit(".", 1)[-1] for name in requested}
        matches = defaultdict(list)
        count, truncated = 0, False
        prefix = query + "."
        for row in self.signals:
            scope, base = row["scope"], row["name"].lstrip("\\")
            bracket = base.rfind("[") if base.endswith("]") else -1
            if bracket >= 0 and ":" in base[bracket:]:
                base = base[:bracket]
            if base not in tails:
                continue
            keys = []
            if not query or scope == query:
                keys.append(base)
            keys.append(scope + "." + base)
            if query and scope.startswith(prefix):
                keys.append(scope[len(prefix):] + "." + base)
            for key in keys:
                if key not in requested:
                    continue
                rows = matches[key]
                if len(rows) >= 200 or count >= 100000:
                    truncated = True
                else:
                    rows.append(row)
                    count += 1
        return {"matches": dict(matches), "truncated": truncated}

    def define_virtual(self, definition, name=""):
        operation = definition["op"]
        inputs = [{field: item.get(field) for field in ("id", "bitOffset", "scope", "name")}
                  for item in definition["inputs"]]
        if not 1 <= len(inputs) <= 64:
            raise Unsupported("Select 1–64 operands")
        if operation == "not" and len(inputs) != 1:
            raise Unsupported("NOT requires one operand")
        if operation not in {"concat", "and", "or", "xor", "not"}:
            raise Unsupported("Unsupported virtual signal operation")
        widths, projected, depth = [], [], 1
        for item in inputs:
            virtual = self.virtuals.get(item["id"])
            rows = [virtual[0]] if virtual else self.ids.get(item["id"])
            if not rows:
                raise Unsupported("Virtual input not found")
            if not any(self.matches_descriptor(row, item) for row in rows):
                raise Unsupported("Virtual source identity mismatch")
            if not rows[0]["supported"]:
                raise Unsupported("Unsupported virtual operand")
            width, bit = rows[0]["width"], item["bitOffset"]
            if bit is not None and not 0 <= bit < width:
                raise Unsupported("Virtual bit outside source width")
            widths.append(width)
            projected.append(width if bit is None else 1)
            if virtual:
                depth = max(depth, virtual[2] + 1)
        if depth > 16:
            raise Unsupported("Virtual expression nesting limit is 16")
        width = sum(projected) if operation == "concat" else max(projected)
        if not 1 <= width <= 65536:
            raise Unsupported("Virtual signal width must be 1–65536")
        canonical = {"op": operation, "inputs": inputs}
        hash_value = 14695981039346656037
        for byte in json.dumps(canonical, ensure_ascii=False, separators=(",", ":")).encode("utf-8"):
            hash_value = ((hash_value ^ byte) * 1099511628211) & ((1 << 64) - 1)
        signal_id = f"@virtual:{hash_value:016x}"
        if signal_id in self.virtuals:
            signal = self.virtuals[signal_id][0]
            if signal["definition"] != canonical:
                raise Unsupported("Virtual definition hash collision")
        else:
            if len(self.virtuals) >= 4096:
                raise Unsupported("Maximum 4096 virtual definitions per waveform")
            signal = {"id": signal_id, "scope": "$virtual", "name": name or f"{operation}_{hash_value:016x}",
                      "width": width, "supported": True, "definition": canonical}
            self.virtuals[signal_id] = signal, widths, depth
        definitions = [entry[0] for entry in sorted(self.virtuals.values(), key=lambda entry: entry[2])]
        return {"signal": signal, "definitions": definitions}

    def virtual_block(self, virtual, start, end, limit):
        signal, widths, _ = virtual
        definition = signal["definition"]
        input_limit = min(limit, max(1, 16 * MIB // max(1, sum(widths))))
        inputs = {}
        for item in definition["inputs"]:
            signal_id = item["id"]
            if signal_id not in inputs:
                inputs[signal_id] = self.block(signal_id, start, end, input_limit)
        safe_end, truncated = end, False
        for events, clipped in inputs.values():
            if clipped:
                truncated = True
                if not events or events[-1][0] <= start:
                    return [], True
                safe_end = min(safe_end, events[-1][0] - 1)
        blocks = [inputs[item["id"]][0] for item in definition["inputs"]]
        times = sorted({start, *(instant for events in blocks for instant, _ in events if start <= instant <= safe_end)})
        if len(times) * signal["width"] * len(blocks) > 50_000_000:
            raise Unsupported("Virtual computation budget exceeded; zoom in or select fewer operands")
        offsets = [0] * len(blocks)
        current = ["x" * width for width in widths]
        output = []
        for instant in times:
            projected = []
            for index, (events, item) in enumerate(zip(blocks, definition["inputs"])):
                while offsets[index] < len(events) and events[offsets[index]][0] <= instant:
                    current[index] = events[offsets[index]][1]
                    offsets[index] += 1
                bit = item["bitOffset"]
                projected.append(current[index] if bit is None else current[index][-1 - bit])
            value = virtual_value(definition["op"], projected, signal["width"])
            if not output or output[-1][1] != value:
                if len(output) == limit:
                    return output, True
                output.append((instant, value))
        return output, truncated

    def evict(self):
        _, (_, cost) = self.cache.popitem(last=False)
        self.stats["bytes"] -= cost
        self.stats["evictions"] += 1
        self.stats["entries"] = len(self.cache)

    def configure_cache(self, size):
        if size < 0:
            raise Unsupported("negative waveform cache budget")
        self.stats["budget"] = min(size, 512 * MIB)
        while self.cache and self.stats["bytes"] > self.stats["budget"]:
            self.evict()
        return self.stats.copy()

    def block(self, signal_id, start, end, limit):
        virtual = self.virtuals.get(signal_id)
        rows = [virtual[0]] if virtual else self.ids.get(signal_id)
        if not rows:
            raise Unsupported("Unknown signal")
        if not rows[0]["supported"]:
            raise Unsupported("Unsupported signal encoding")
        key = signal_id, start, end, limit
        if key in self.cache:
            self.stats["hits"] += 1
            self.cache.move_to_end(key)
            return self.cache[key][0]
        containing = [cached for cached, (block, _) in self.cache.items()
                      if cached[0] == signal_id and cached[1] <= start and cached[2] >= end and not block[1]]
        if containing:
            best = min(containing, key=lambda cached: cached[2] - cached[1])
            self.cache.move_to_end(best)
            self.stats["hits"] += 1
            self.stats["containingHits"] += 1
            return wave_window(self.cache[best][0][0], start, end, limit)
        self.stats["misses"] += 1
        if virtual:
            result = self.virtual_block(virtual, start, end, limit)
        else:
            events = [(int(instant), value) for instant, value in self.session.range_events(int(signal_id), start, end)]
            result = wave_window(events, start, end, limit)
            self.stats["reads"] += 1
        cost = 232 + len(signal_id) + sum(24 + len(value) for _, value in result[0])
        if cost <= self.stats["budget"]:
            while self.cache and (self.stats["bytes"] + cost > self.stats["budget"] or len(self.cache) >= 4096):
                self.evict()
            self.cache[key] = result, cost
            self.stats["bytes"] += cost
            self.stats["entries"] = len(self.cache)
        return result

    def query(self, signals, start, end, limit=20000):
        start, end = int(start), int(end)
        if len(signals) > 64 or not 0 <= start <= end < 1 << 64 or not 1 <= limit <= 100000:
            raise Unsupported("Invalid query bounds (max 64 signals, 100000 events each)")
        output = {}
        for signal_id in signals:
            events, truncated = self.block(signal_id, start, end, limit)
            output[signal_id] = {"events": [[str(instant), value] for instant, value in events],
                                 "truncated": truncated}
        return output
