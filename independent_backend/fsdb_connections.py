# SPDX-License-Identifier: MPL-2.0
"""Read FSDB connection archives and calculate values for derived signals."""
import struct
import zlib
import heapq
from collections import OrderedDict
from fsdb_container import MAX_BLOCK
from kdb_records import Unsupported


def inflate(data):
    decoder = zlib.decompressobj()
    result = decoder.decompress(data, MAX_BLOCK + 1)
    if len(result) > MAX_BLOCK or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise Unsupported("connection archive zlib bounds/trailer mismatch")
    return result


def archive(container):
    start = struct.unpack("<Q", container.read(0x538, 8))[0]
    if not start:
        return {}
    end = struct.unpack("<Q", container.read(0x410, 8))[0]
    if not 0x900 <= start < end <= container.size or end - start > MAX_BLOCK:
        raise Unsupported("connection archive file bounds exceed budget")
    raw = container.read(start, end - start)
    if raw[:4] != b"\x21\x43\x65\x87":
        raise Unsupported("connection archive signature mismatch")
    version_length = struct.unpack_from("<I", raw, 4)[0]
    offset = 8 + version_length
    if not 0 < version_length <= 1024 or offset + 16 > len(raw) or raw[offset - 1]:
        raise Unsupported("connection archive version/header bounds")
    if struct.unpack_from("<II", raw, offset) != (0x300, offset):
        raise Unsupported("connection archive initial framing mismatch")
    offset += 8
    results = {}
    while offset + 8 <= len(raw):
        size = struct.unpack_from("<Q", raw, offset)[0]
        offset += 8
        if size == 0:
            if offset != len(raw):
                raise Unsupported("connection archive unparsed end bytes")
            return results
        if not 6 <= size <= min(MAX_BLOCK, len(raw) - offset):
            raise Unsupported("connection section bounds mismatch")
        section = raw[offset:offset + size]
        count = struct.unpack_from("<I", section, size - 4)[0]
        if not 0 < count <= 100000 or 24 * count + 6 > size - 4:
            raise Unsupported("connection section directory budget")
        directory_start = size - 4 - 24 * count
        if section[:2] != b"\xe3\x00":
            raise Unsupported("connection section compression flags are unverified")
        cursor, chunks, anchors, decoded_size = 2, [], {}, 0
        while cursor < directory_start:
            if directory_start - cursor < 4:
                raise Unsupported("truncated connection compressed length")
            length = struct.unpack_from("<I", section, cursor)[0]
            anchor = cursor
            cursor += 4
            if not 0 < length <= directory_start - cursor:
                raise Unsupported("connection compressed frame exceeds section")
            block = inflate(section[cursor:cursor + length])
            if chunks and len(chunks[-1]) != 262144:
                raise Unsupported("unverified connection archive nonfinal chunk capacity")
            anchors[anchor] = decoded_size
            decoded_size += len(block)
            if decoded_size > MAX_BLOCK:
                raise Unsupported("connection decoded section exceeds budget")
            chunks.append(block)
            cursor += length
        decoded = b"".join(chunks)
        intervals = []
        for ordinal in range(count):
            anchor, within, length, key = struct.unpack_from("<QIIQ", section, directory_start + ordinal * 24)
            if anchor not in anchors:
                raise Unsupported("connection directory points outside frame headers")
            begin = anchors[anchor] + within
            finish = begin + length
            if not length or within >= len(chunks[list(anchors).index(anchor)]) or finish > len(decoded) or key in results:
                raise Unsupported("connection logical record bounds/key mismatch")
            intervals.append((begin, finish))
            results[key] = decoded[begin:finish]
        intervals.sort()
        if intervals[0][0] or intervals[-1][1] != len(decoded) or any(a[1] != b[0] for a, b in zip(intervals, intervals[1:])):
            raise Unsupported("connection directory does not cover decoded section exactly")
        offset += size
    raise Unsupported("connection archive terminator missing")


def maps(container):
    position = struct.unpack("<Q", container.read(0x4F0, 8))[0]
    sizes = struct.unpack("<II", container.read(0x4F8, 8))
    if not position and sizes == (0, 0):
        return [{}, {}]
    if not 0x900 <= position < container.size or sum(sizes) > MAX_BLOCK:
        raise Unsupported("connection map section bounds/budget")
    results = []
    for size in sizes:
        end, raw = position + size, bytearray()
        while position + 4 <= end:
            length = struct.unpack("<I", container.read(position, 4))[0]
            position += 4
            if not length:
                break
            if length > end - position:
                raise Unsupported("connection map compressed block exceeds section")
            raw.extend(container.decompress(container.read(position, length), "c"))
            if len(raw) > MAX_BLOCK:
                raise Unsupported("connection map decoded budget")
            position += length
        if position != end:
            raise Unsupported("connection map end mismatch")
        cursor, result = 0, {}
        while cursor < len(raw):
            descriptor = raw[cursor]
            cursor += 1
            if descriptor & 0xC0 != 0xC0 or any(descriptor >> shift & 3 == 3 for shift in (0, 2, 4)):
                raise Unsupported("unverified connection map integer encoding")
            fields = []
            for shift in (0, 2, 4):
                width = 1 << (descriptor >> shift & 3)
                if cursor + width > len(raw):
                    raise Unsupported("truncated connection map integers")
                fields.append(int.from_bytes(raw[cursor:cursor + width], "little"))
                cursor += width
            signal_id, context, node = fields
            if not 0 < signal_id <= container.header_max_id or signal_id in result:
                raise Unsupported("connection map signal key exceeds header/duplicates")
            result[signal_id] = (context, node)
        results.append(result)
    return results


def programs(raw):
    if len(raw) < 8:
        raise Unsupported("connection program header truncated")
    tagged_count, text_count = struct.unpack_from("<II", raw)
    count = tagged_count & 0x7FFFFFFF
    if not tagged_count & 0x80000000 or not 0 < count + text_count <= 100000:
        raise Unsupported("unverified connection program count/base")
    offset, result = 8, {}
    for ordinal in range(count + text_count):
        if offset >= len(raw) or raw[offset] not in (0, 0xC0):
            raise Unsupported("unverified connection program field descriptor")
        descriptor = raw[offset]
        offset += 1
        size = 4 if descriptor else 2
        if offset + 2 * size > len(raw):
            raise Unsupported("truncated connection program header")
        arguments = int.from_bytes(raw[offset:offset + size], "little")
        length = int.from_bytes(raw[offset + size:offset + 2 * size], "little")
        offset += 2 * size
        if arguments > 65536 or not 0 < length <= len(raw) - offset:
            raise Unsupported("connection program arguments/bytes exceed bounds")
        key = ordinal if ordinal < count else 0x10000000 + ordinal - count
        result[key] = {"arguments": arguments, "code": raw[offset:offset + length], "descriptor": descriptor,
                       "format": "binary" if ordinal < count else "text"}
        offset += length
    # Retain the observed common built-in footer as an explicit format check;
    # its operations are not silently treated as user programs.
    footer = bytes.fromhex("0100000100c0000100020095c0000100020081c0000100020082c0000100020094c0")
    if raw[offset:] != footer:
        raise Unsupported("unverified connection program footer")
    # The common footer supplies five callable built-ins. Its first record
    # has descriptor 01 and one implicit value argument (encoded count zero).
    builtins = [(b"\xc0", 1), (b"\x95\xc0", 0), (b"\x81\xc0", 0), (b"\x82\xc0", 0), (b"\x94\xc0", 0)]
    for ordinal, (code, descriptor) in enumerate(builtins):
        result[0x20000000 + ordinal] = {"arguments": 1, "code": code, "descriptor": descriptor, "format": "binary", "builtin": True}
    return result


def graph(raw, operations):
    from fsdb_expression import TEXT_HEADER
    if len(raw) < 12:
        raise Unsupported("connection graph header truncated")
    count, opaque = struct.unpack_from("<II", raw)
    if not 0 < count <= 1000000 or opaque > 1000000:
        raise Unsupported("connection graph count/secondary budget")
    offset, widths = 8, []
    while len(widths) < count:
        if offset + 4 > len(raw):
            raise Unsupported("truncated graph width descriptor")
        word = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        width, flags = word & 0x3FFFFFFF, word >> 30
        if not width or flags not in (0, 2, 3):
            raise Unsupported("unverified graph width/flags")
        if flags == 3:
            if width > count - len(widths):
                raise Unsupported("scalar graph run exceeds vertex count")
            widths.extend([1] * width)
        else:
            widths.append(width)
    if count + offset + 4 > len(raw):
        raise Unsupported("truncated graph attributes/edge count")
    attributes = raw[offset:offset + count]
    offset += count
    edges = struct.unpack_from("<I", raw, offset)[0]
    offset += 4
    if edges > count:
        raise Unsupported("graph edge count exceeds vertex count")
    connections = {}
    for _ in range(edges):
        if offset + 8 > len(raw):
            raise Unsupported("truncated connection graph edge header")
        destination, operation = struct.unpack_from("<II", raw, offset)
        offset += 8
        program = operation & 0x3FFFFFFF
        if operation >> 30 == 2:
            # Kind 2 selects the common scalar built-in namespace, independent
            # of this file's user expression table and its constant pool.
            if program > 4:
                raise Unsupported("unverified scalar connection built-in index")
            program |= 0x20000000
        if program not in operations:
            raise Unsupported("connection graph references an unknown program")
        text_metadata = None
        if operations[program]["format"] == "text":
            if offset + 4 > len(raw):
                raise Unsupported("truncated textual connection edge metadata")
            text_metadata = struct.unpack_from("<I", raw, offset)[0]
            offset += 4
            header = TEXT_HEADER.match(operations[program]["code"])
            if header is None or int(header[3]) != text_metadata:
                raise Unsupported("textual connection edge and expression identifiers differ")
        argument_count = operations[program]["arguments"]
        if argument_count * 4 > len(raw) - offset:
            raise Unsupported("truncated connection graph arguments")
        arguments = struct.unpack_from("<" + "I" * argument_count, raw, offset)
        offset += argument_count * 4
        if destination >= count or any(source >= count + opaque for source in arguments):
            raise Unsupported("connection graph vertex bounds")
        # Several assignments may write different portions of one vertex.
        # Preserve all of them; choosing the last would lose real drivers.
        connections.setdefault(destination, []).append({"program": program, "arguments": arguments, "operation": operation,
                                                       "textMetadata": text_metadata})
    if offset != len(raw):
        raise Unsupported("unparsed connection graph bytes")
    return {"widths": widths, "attributes": attributes, "connections": connections, "secondaryCount": opaque}


def composites(raw, current):
    offset, result = 0, {}
    def integer():
        nonlocal offset
        if offset + 4 > len(raw):
            raise Unsupported("truncated composite connection integer")
        value = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        return value
    while offset < len(raw):
        destination, count = integer(), integer()
        if destination >= len(current["widths"]) or destination in result or count > 1000000:
            raise Unsupported("composite connection destination/count bounds")
        refs, total = [], 0
        for _ in range(count):
            tagged = integer()
            source = tagged & 0x7FFFFFFF
            if source >= len(current["widths"]):
                raise Unsupported("composite connection source exceeds graph")
            selection, length = None, current["widths"][source]
            if tagged >> 31:
                start = integer()
                length = integer() if start >> 31 else 1
                start &= 0x7FFFFFFF
                if not length or start + length > current["widths"][source]:
                    raise Unsupported("composite connection slice exceeds source")
                selection = start, length
            total += length
            refs.append((source, selection))
        if total != current["widths"][destination]:
            raise Unsupported("composite connection widths disagree with destination")
        result[destination] = refs
    return result


def models(raw):
    if len(raw) < 4 or struct.unpack_from("<I", raw)[0] != 1:
        raise Unsupported("unverified connection source metadata version/count")
    offset = 4
    # Source provenance strings are retained in the original archive only;
    # their files are never opened or used to calculate a value.
    for _ in range(2):
        if offset + 4 > len(raw):
            raise Unsupported("truncated connection source provenance")
        length = struct.unpack_from("<I", raw, offset)[0]
        offset += 4
        if length > min(1048576, len(raw) - offset):
            raise Unsupported("connection provenance string exceeds bounds")
        offset += length
    if offset + 20 > len(raw):
        raise Unsupported("truncated connection model directory header")
    flag1, flag2, model_counter, instance_counter, groups = struct.unpack_from("<5I", raw, offset)
    offset += 20
    if flag1 or flag2 or groups > 100000 or instance_counter > 1000000:
        raise Unsupported("connection model directory flags/budget")
    result = {}
    for _ in range(groups):
        if offset + 16 > len(raw):
            raise Unsupported("truncated connection model group")
        prototype, source, master, count = struct.unpack_from("<4I", raw, offset)
        offset += 16
        if count > 1000000 or count * 4 > len(raw) - offset:
            raise Unsupported("connection model instance list exceeds bounds")
        for instance in struct.unpack_from("<" + "I" * count, raw, offset):
            # Map records reserve context zero for the global graph; scoped
            # contexts use the recorded instance ordinal plus one.
            context = instance + 1
            if instance >= instance_counter or context in result:
                raise Unsupported("connection instance ordinal exceeds header/duplicates")
            result[context] = {"prototype": prototype, "source": source, "master": master}
        offset += count * 4
    if offset != len(raw):
        raise Unsupported("unparsed connection source model bytes")
    return result


def bindings(raw):
    if len(raw) % 16:
        raise Unsupported("connection binding tuple length mismatch")
    result = {}
    for destination, node, source, source_node in struct.iter_unpack("<4I", raw):
        if (destination, node) in result:
            raise Unsupported("duplicate connection binding destination")
        result[destination, node] = source, source_node
    return result


class Connections:
    def __init__(self, container):
        self.inputs, self.outputs = maps(container)
        self.records = archive(container) if self.inputs or self.outputs else {}
        self.operations = programs(self.records[2]) if self.records else {}
        self.graphs, self.graph_errors, self.drivers, self.results = {}, {}, {}, {}
        self.prototype_graphs, self.model_map, self.graph_keys = {}, None, {0: 0xFFFFFFFF00000001}
        self.bindings = bindings(self.records.get(6, b""))
        self.composite_graphs = {}
        self.pool = None
        self.expressions, self.expression_errors = {}, {}
        self.event_cache, self.event_bytes, self.event_budget = OrderedDict(), 0, 32 * 1024 * 1024
        self.initial_time = container.windows[0]["timeAnchor"]
        for signal_id, vertex in self.outputs.items():
            if vertex in self.drivers:
                raise Unsupported("connection driver vertex has multiple physical signal IDs")
            self.drivers[vertex] = signal_id

    def get_graph(self, context):
        if context in self.graph_errors:
            raise Unsupported(self.graph_errors[context])
        if context not in self.graphs:
            if context not in self.graph_keys:
                if self.model_map is None:
                    self.model_map = models(self.records[0])
                if context not in self.model_map or self.model_map[context]["source"]:
                    raise Unsupported("unrecognized connection instance/source context")
                self.graph_keys[context] = (self.model_map[context]["prototype"] << 32) | 1
            key = self.graph_keys[context]
            if key not in self.records:
                raise Unsupported("connection instance graph record missing")
            try:
                if key not in self.prototype_graphs:
                    self.prototype_graphs[key] = graph(self.records[key], self.operations)
                self.graphs[context] = self.prototype_graphs[key]
            except Unsupported as error:
                self.graph_errors[context] = str(error)
                raise
        return self.graphs[context]

    def resolve_identity(self, signal_id):
        if signal_id in self.results:
            return self.results[signal_id]
        if signal_id not in self.inputs:
            return signal_id
        context, node = self.inputs[signal_id]
        current = self.get_graph(context)
        if node >= len(current["widths"]):
            raise Unsupported("connection input vertex exceeds graph")
        visited = set()
        while (context, node) not in self.drivers:
            if node in visited or node not in current["connections"]:
                raise Unsupported("unresolved/cyclic connection alias or constant")
            visited.add(node)
            assignments = current["connections"][node]
            if len(assignments) != 1:
                raise Unsupported("multiple connection assignments are not implemented")
            edge = assignments[0]
            operation = self.operations[edge["program"]]
            if operation["code"] not in (b"\xc0", b"\x95\xc0") or len(edge["arguments"]) != 1:
                raise Unsupported("non-identity connection program is not implemented: " + operation["code"].hex())
            source = edge["arguments"][0]
            if source >= len(current["widths"]) or current["widths"][node] != current["widths"][source]:
                raise Unsupported("connection identity has a constant or changes width")
            node = source
        result = self.drivers[context, node]
        self.results[signal_id] = result
        return result

    def events(self, signal_id, physical_events):
        if signal_id not in self.inputs:
            return []
        context, node = self.inputs[signal_id]
        return self.node_events(context, node, physical_events, set())

    def expression(self, operation):
        from fsdb_expression import constants, Expression, TextExpression
        if operation in self.expression_errors:
            raise Unsupported(self.expression_errors[operation])
        if operation not in self.expressions:
            if self.pool is None:
                self.pool = constants(self.records[4])
            program = self.operations[operation]
            try:
                decoder = Expression if program["format"] == "binary" else TextExpression
                self.expressions[operation] = decoder(program["code"], program["arguments"], self.pool)
            except Unsupported as error:
                self.expression_errors[operation] = str(error)
                raise
        return self.expressions[operation]

    def cache_events(self, key, events):
        cost = sum(len(time) + len(value) + 128 for time, value in events)
        if cost <= self.event_budget:
            while self.event_bytes + cost > self.event_budget:
                _, (_, removed) = self.event_cache.popitem(last=False)
                self.event_bytes -= removed
            self.event_cache[key] = events, cost
            self.event_bytes += cost
        return events

    def assignment_events(self, context, node, current, assignments, physical_events, active):
        width = current["widths"][node]
        definitions = [(edge, self.expression(edge["program"])) for edge in assignments]
        source_ids = list(dict.fromkeys(source for edge in assignments for source in edge["arguments"]))
        sources = {source: self.node_events(context, source, physical_events, active) for source in source_ids}
        if any(not events for events in sources.values()):
            raise Unsupported("partial connection source has no recorded events")
        values = {source: "x" * current["widths"][source] for source in source_ids}
        is_net = bool(current["attributes"][node] & 1)

        def render():
            result, written = ["z" if is_net else "x"] * width, set()
            for edge, expression in definitions:
                arguments = [values[source] for source in edge["arguments"]]
                edits = expression.assignment(arguments, width, scalar=edge["operation"] >> 30 == 0)
                if not is_net and written.intersection(edits):
                    raise Unsupported("overlapping variable connection assignments are not implemented")
                written.update(edits)
                for position, value in edits.items():
                    before = result[-1 - position]
                    if is_net:
                        value = value if before == "z" else before if value == "z" or before == value else "x"
                    result[-1 - position] = value
            value = "".join(result)
            if current["attributes"][node] & 2 == 0 and any(edge["operation"] >> 30 == 1 for edge in assignments):
                value = value.replace("x", "0").replace("z", "0")
            return value

        heap = [(int(events[0][0]), source, 0) for source, events in sources.items()]
        heapq.heapify(heap)
        events = []
        if not heap:
            return [[str(self.initial_time), render()]]
        while heap:
            instant = heap[0][0]
            while heap and heap[0][0] == instant:
                _, source, offset = heapq.heappop(heap)
                values[source] = sources[source][offset][1]
                offset += 1
                if offset < len(sources[source]):
                    heapq.heappush(heap, (int(sources[source][offset][0]), source, offset))
            value = render()
            if not events or events[-1][1] != value:
                events.append([str(instant), value])
                if len(events) > 1000000 or width * len(events) > MAX_BLOCK:
                    raise Unsupported("partial connection event budget exceeded")
        return events

    def composite_events(self, context, node, current, refs, physical_events, active):
        sources = {source: self.node_events(context, source, physical_events, active) for source, _ in refs}
        if not sources or any(not events for events in sources.values()):
            raise Unsupported("composite connection source has no recorded events")
        values = {source: "x" * current["widths"][source] for source in sources}
        heap = [(int(events[0][0]), source, 0) for source, events in sources.items()]
        heapq.heapify(heap)
        events = []
        while heap:
            instant = heap[0][0]
            while heap and heap[0][0] == instant:
                _, source, offset = heapq.heappop(heap)
                values[source] = sources[source][offset][1]
                offset += 1
                if offset < len(sources[source]):
                    heapq.heappush(heap, (int(sources[source][offset][0]), source, offset))
            fragments = []
            # The reference list is in ascending destination bit order.
            # Values returned by the waveform API start at the highest bit.
            for source, selection in reversed(refs):
                value = values[source]
                if selection is not None:
                    start, length = selection
                    value = "".join(value[-1 - i] for i in reversed(range(start, start + length)))
                fragments.append(value)
            value = "".join(fragments)
            if len(value) != current["widths"][node]:
                raise Unsupported("composite runtime width disagrees with graph")
            if not events or events[-1][1] != value:
                events.append([str(instant), value])
                if len(events) > 1000000 or len(value) * len(events) > MAX_BLOCK:
                    raise Unsupported("composite event budget exceeded")
        return events

    def node_events(self, context, node, physical_events, active):
        from fsdb_expression import constants, Expression, TextExpression
        key = context, node
        if key in self.event_cache:
            self.event_cache.move_to_end(key)
            return self.event_cache[key][0]
        if key in active or len(active) >= 256:
            raise Unsupported("connection value cycle or excess dependency depth")
        active.add(key)
        try:
            current = self.get_graph(context)
            if key in self.bindings and key not in self.drivers:
                if node >= len(current["widths"]) + current["secondaryCount"]:
                    raise Unsupported("bound connection vertex exceeds graph")
                source_context, source_node = self.bindings[key]
                events = self.node_events(source_context, source_node, physical_events, active)
                return self.cache_events(key, events)
            if node >= len(current["widths"]):
                raise Unsupported("connection secondary constant nodes are not implemented")
            width = current["widths"][node]
            if width > 65536:
                raise Unsupported("connection intermediate width exceeds session budget")
            if key in self.drivers:
                events = physical_events(self.drivers[key])
            else:
                assignments = current["connections"].get(node, [])
                if not assignments:
                    if context not in self.composite_graphs:
                        composite_key = self.graph_keys[context] & ~0xFFFFFFFF | 3
                        self.composite_graphs[context] = composites(self.records.get(composite_key, b""), current)
                    if node in self.composite_graphs[context]:
                        events = self.composite_events(context, node, current, self.composite_graphs[context][node], physical_events, active)
                        return self.cache_events(key, events)
                    raise Unsupported("connection vertex has no recorded source or assignment")
                if len(assignments) != 1:
                    events = self.assignment_events(context, node, current, assignments, physical_events, active)
                    return self.cache_events(key, events)
                edge = assignments[0]
                operation = edge["program"]
                expression = self.expression(operation)
                if (isinstance(expression, Expression) and expression.assignment_tree() is not None
                        or getattr(expression, "destination", None) is not None):
                    events = self.assignment_events(context, node, current, assignments, physical_events, active)
                    return self.cache_events(key, events)
                sources = [self.node_events(context, source, physical_events, active) for source in edge["arguments"]]
                if any(not source for source in sources):
                    raise Unsupported("derived source has no recorded events")
                if edge["operation"] >> 30 == 2 and (width != 1 or len(edge["arguments"]) != 1 or current["widths"][edge["arguments"][0]] != 1):
                    raise Unsupported("unverified scalar connection built-in widths")
                if expression.tree[0] == "argument" and len(sources[expression.argument_map[expression.tree[1]]][0][1]) == width:
                    events = sources[expression.argument_map[expression.tree[1]]]
                else:
                    heap = [(int(source[0][0]), i, 0) for i, source in enumerate(sources)]
                    heapq.heapify(heap)
                    values = ["x" * len(events[0][1]) for events in sources]
                    events = []
                    if not sources:
                        events.append([str(self.initial_time), expression.evaluate([], width, scalar=edge["operation"] >> 30 == 0)])
                    while heap:
                        instant = heap[0][0]
                        while heap and heap[0][0] == instant:
                            _, i, offset = heapq.heappop(heap)
                            values[i] = sources[i][offset][1]
                            offset += 1
                            if offset < len(sources[i]):
                                heapq.heappush(heap, (int(sources[i][offset][0]), i, offset))
                        value = expression.evaluate(values, width, scalar=edge["operation"] >> 30 == 0)
                        if not events or events[-1][1] != value:
                            events.append([str(instant), value])
                            if len(events) > 1000000 or width * len(events) > MAX_BLOCK:
                                raise Unsupported("derived connection events exceed session budget")
            convert_two_state = (key not in self.drivers and
                                 (edge["operation"] >> 30 == 1 and current["attributes"][node] & 2 == 0 or
                                  edge["operation"] >> 30 == 2 and edge["operation"] & 0x3FFFFFFF == 4))
            if convert_two_state:
                # Two-state graph storage determines X/Z conversion. The
                # program's type annotation alone does not change the value.
                converted = []
                for instant, value in events:
                    value = value.replace("x", "0").replace("z", "0")
                    if not converted or converted[-1][1] != value:
                        converted.append([instant, value])
                events = converted
        finally:
            active.remove(key)
        return self.cache_events(key, events)


def identity_aliases(container):
    session = Connections(container)
    return {signal_id: session.resolve_identity(signal_id) for signal_id in session.inputs}
