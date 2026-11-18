# SPDX-License-Identifier: MPL-2.0
"""Read four-state events from the FSDB index and bounded page caches."""
from bisect import bisect_right
from collections import OrderedDict, Counter
from fsdb_container import Container, MAX_BLOCK
from fsdb_index import locations
from fsdb_connections import Connections
from fsdb_native_declarations import native_declarations
from fsdb_declarations import declarations
from read_fsdb_scalar import PacketTruncated, dictionary_vector, scalar_packet, vector_packet
from kdb_records import Unsupported


class PageCache:
    def __init__(self, budget=16 * 1024 * 1024):
        self.budget, self.used = budget, 0
        self.pages, self.stats = OrderedDict(), Counter()

    def get(self, key, loader):
        if key in self.pages:
            self.stats["hits"] += 1
            self.pages.move_to_end(key)
            return self.pages[key]
        self.stats["misses"] += 1
        result = loader()
        if len(result) > self.budget:
            return result
        while self.used + len(result) > self.budget:
            _, removed = self.pages.popitem(last=False)
            self.used -= len(removed)
            self.stats["evictions"] += 1
        self.pages[key] = result
        self.used += len(result)
        return result


class ValuePages:
    """Read a single continued packet from indexed 64 KiB value pages."""
    PAGE_SIZE = 65536

    def __init__(self, count, load):
        self.length = min(count * self.PAGE_SIZE, MAX_BLOCK)
        self.load = load
        self.current_page = None
        self.current_data = b""

    def __len__(self):
        return self.length

    def part(self, offset, length):
        page, within = divmod(offset, self.PAGE_SIZE)
        if page != self.current_page:
            self.current_data = self.load(page)
            self.current_page = page
        data = self.current_data
        if len(data) > self.PAGE_SIZE or within + length > len(data):
            raise PacketTruncated("external value packet exceeds its page bounds")
        return data, within

    def __getitem__(self, index):
        if isinstance(index, int):
            data, within = self.part(index, 1)
            return data[within]
        start, stop = index.start, index.stop
        parts = []
        while start < stop:
            size = min(stop - start, self.PAGE_SIZE - start % self.PAGE_SIZE)
            data, within = self.part(start, size)
            parts.append(data[within:within + size])
            start += size
        return b"".join(parts)


class IndexPages:
    """Byte view of a record starting on an index page of variable size."""

    def __init__(self, first, remaining, load):
        self.data = first
        self.remaining = remaining
        self.load = load
        self.next = 1

    def __len__(self):
        # Before touching the following pages only an upper bound is known.
        return min(MAX_BLOCK, len(self.data) + (self.remaining - self.next + 1) * 65536)

    def __getitem__(self, index):
        stop = index + 1 if isinstance(index, int) else index.stop
        if stop > MAX_BLOCK:
            raise PacketTruncated("event index record exceeds byte budget")
        while len(self.data) < stop and self.next <= self.remaining:
            self.data += self.load(self.next)
            self.next += 1
        if stop > len(self.data):
            raise PacketTruncated("truncated event index record")
        return self.data[index]


class Session:
    def __init__(self, filename, native=True, container=None):
        self.container = container if container is not None else Container(filename)
        self.declaration = native_declarations(filename) if native else declarations(filename)
        self.widths, self.unsupported = {}, set()
        for row in self.declaration["signals"]:
            key, width = row["nativeId"], row["width"]
            if key in self.widths and self.widths[key] != width:
                raise Unsupported("one native ID has inconsistent declaration widths")
            self.widths[key] = width
            if not row.get("supported", True) or not 0 < width <= 65536:
                self.unsupported.add(key)
        self.public_ids = set(self.widths)
        for row in self.declaration.get("hiddenSignals", []):
            key, width = row["nativeId"], row["width"]
            if key in self.widths and self.widths[key] != width:
                raise Unsupported("internal declaration width conflicts with visible signal")
            self.widths[key] = width
            if not row.get("supported", True) or not 0 < width <= 65536:
                self.unsupported.add(key)
        self.location_metadata = {}
        self.locations = locations(self.container, self.location_metadata)
        dictionary_raw, offset, self.dictionaries, self.dictionary_modes = self.container.dictionary(), 0, [], []
        while offset < len(dictionary_raw):
            vector, offset = dictionary_vector(dictionary_raw, offset)
            self.dictionaries.append(vector["values"])
            self.dictionary_modes.append(vector["mode"])
        if len(self.dictionaries) != len(self.container.windows):
            raise Unsupported("time dictionary/window correspondence is unverified")
        self.index_base, total = [], 0
        for window in self.container.windows:
            self.index_base.append(total)
            total += len(window["indexes"])
        self.index_count = total
        self.index_cache, self.cache = PageCache(budget=8 * 1024 * 1024), PageCache()
        self.native, self.connections = native, None
        self.active_queries = set()

    def index_window(self, page):
        if page >= self.index_count:
            raise Unsupported("event index reference exceeds global index page table")
        return bisect_right(self.index_base, page) - 1

    def index_page(self, ordinal, index):
        row = self.container.windows[ordinal]["indexes"][index]

        def load():
            data = self.container.block(row, "x")
            if not 0 < len(data) <= 65536:
                raise Unsupported("event index page exceeds bounds")
            if ordinal == index == 0 and data[0] != 0x11:
                raise Unsupported("initial event index header mismatch")
            return data

        return self.index_cache.get((ordinal, index), load)

    def index_location(self, address):
        page, within = address >> 16, address & 0xFFFF
        ordinal = self.index_window(page)
        local = page - self.index_base[ordinal]
        first = self.index_page(ordinal, local)
        if within >= len(first):
            raise Unsupported("event index reference enters unmapped page tail")
        remaining = len(self.container.windows[ordinal]["indexes"]) - local - 1
        raw = IndexPages(first, remaining, lambda offset: self.index_page(ordinal, local + offset)) if remaining else first
        return ordinal, raw, within

    def record(self, address, width, latest=None):
        ordinal, raw, offset = self.index_location(address)
        deltas = self.dictionaries[ordinal]

        def integer(size, timestamp=False):
            nonlocal offset
            if offset + size > len(raw):
                raise Unsupported("truncated event record metadata")
            value = int.from_bytes(raw[offset:offset + size], "little")
            offset += size
            if size == 8 and timestamp:
                value = (value & 0xFFFFFFFF) << 32 | value >> 32
            return value

        def packet(data, position, count, states):
            if count * width > MAX_BLOCK:
                raise Unsupported("decoded event bit count exceeds lab budget")
            if width == 1:
                if position >= len(data):
                    raise PacketTruncated("truncated scalar value prefix")
                if data[position:position + 1] != b"\0":
                    raise Unsupported("unverified scalar value prefix")
                return scalar_packet(data, position + 1, deltas, count, states)
            return vector_packet(data, position, deltas, count, states, width)

        flags = integer(2)
        previous_delta = integer(1 << (flags & 3))
        if previous_delta > address:
            raise Unsupported("event backward link exceeds current index address")
        previous = address - previous_delta if previous_delta else 0
        if previous and self.index_window(previous >> 16) >= ordinal:
            raise Unsupported("event backward link does not reference an earlier window")
        if flags & 0xC0 == 0xC0:
            count = flags >> 8
            if not 0 < count <= 8:
                raise Unsupported("unverified inline event flags/count")
            states = flags & 0x18
            if flags & 4:
                if self.dictionary_modes[ordinal] != 8 or not previous or width != 1 or flags & 255 & ~0xDF:
                    raise Unsupported("unverified wide-time inline event record")
                if integer(1) != 0:
                    raise Unsupported("wide-time inline event prefix is unverified")
                events, _, end = scalar_packet(raw, offset, deltas, count, states)
            else:
                if self.dictionary_modes[ordinal] != 4 or flags & 255 & ~0xDB:
                    raise Unsupported("unverified inline event flags/dictionary mode")
                events, _, end = packet(raw, offset, count, states)
        else:
            if self.dictionary_modes[ordinal] not in (4, 8):
                raise Unsupported("unverified external event dictionary mode")
            if flags & ~0x3FFF:
                raise Unsupported("unverified external event flags")
            value_address = integer(1 << (flags >> 2 & 3))
            max_delta = integer(1 << (flags >> 4 & 3), timestamp=True)
            count = integer(1 << (flags >> 6 & 3))
            first_time = integer(1 << (flags >> 8 & 3), timestamp=True)
            last_time = integer(1 << (flags >> 10 & 3), timestamp=True)
            if not 0 < count <= 1000000 or first_time > last_time:
                raise Unsupported("invalid external event count or time bounds")
            window = self.container.windows[ordinal]
            page, position = value_address >> 16, value_address & 0xFFFF
            page -= window["valuePageBase"]
            if not 0 <= page < len(window["values"]):
                raise Unsupported("value reference is outside owning window page table")
            states = (8 if flags & 0x1000 else 0) | (16 if flags & 0x2000 else 0)
            if latest is not None and first_time > latest:
                return [], previous, states
            pages = window["values"]

            def value_page(index):
                return self.cache.get((ordinal, index), lambda: self.container.block(pages[index], "zlib"))

            def external_packet():
                data = value_page(page)
                if position >= len(data):
                    raise Unsupported("value reference enters unmapped page tail")
                try:
                    return packet(data, position, count, states)
                except PacketTruncated:
                    if len(data) != ValuePages.PAGE_SIZE or page + 1 == len(pages):
                        raise
                    # Subsequent bytes are fetched only when decoding reaches
                    # their page. Do not copy or decode the packet per page.
                    continued = ValuePages(len(pages) - page, lambda i: value_page(page + i))
                    return packet(continued, position, count, states)

            events, actual_delta, end = external_packet()
            if (actual_delta, int(events[0][0]), int(events[-1][0])) != (max_delta, first_time, last_time):
                raise Unsupported("event times/maximum delta disagree with record metadata")
        return events, previous, states

    def events(self, signal_id):
        if signal_id not in self.public_ids:
            raise Unsupported("unknown or unsupported signal ID")
        return self._events(signal_id)

    def range_events(self, signal_id, start, end):
        if signal_id not in self.public_ids or signal_id in self.unsupported:
            raise Unsupported("unknown or unsupported signal ID")
        if self.native and not self.locations[signal_id]:
            return self.events(signal_id)
        address = self.locations[signal_id]
        seen, segments = set(), []
        while address:
            if address in seen or len(seen) >= len(self.container.windows):
                raise Unsupported("event record chain cycle or excess windows")
            seen.add(address)
            segment, address, _ = self.record(address, self.widths[signal_id], latest=end)
            if not segment:
                continue
            segments.append(segment)
            if int(segment[0][0]) <= start:
                break
        events = [event for segment in reversed(segments) for event in segment]
        if any(int(a[0]) >= int(b[0]) for a, b in zip(events, events[1:])):
            raise Unsupported("event chain has non-increasing timestamps")
        return events

    def _events(self, signal_id):
        if signal_id in self.active_queries or len(self.active_queries) >= 256:
            raise Unsupported("cyclic or excessive signal query dependencies")
        self.active_queries.add(signal_id)
        try:
            return self._events_unchecked(signal_id)
        finally:
            self.active_queries.remove(signal_id)

    def _events_unchecked(self, signal_id):
        if signal_id not in self.widths or signal_id in self.unsupported:
            raise Unsupported("unknown or unsupported signal ID")
        target = signal_id
        if not self.locations[target] and self.native:
            if self.connections is None:
                self.connections = Connections(self.container)
            return self.connections.events(target, self._events)
        address, seen, segments, states = self.locations[target], set(), [], 0
        while address:
            if address in seen or len(seen) >= len(self.container.windows):
                raise Unsupported("event record chain cycle or excess windows")
            seen.add(address)
            events, address, flags = self.record(address, self.widths[signal_id])
            states |= flags
            segments.append(events)
        events = [event for segment in reversed(segments) for event in segment]
        if states != self.location_metadata["stateFlags"][target] << 3:
            raise Unsupported("event chain states disagree with index-location flags")
        if any(int(a[0]) >= int(b[0]) for a, b in zip(events, events[1:])):
            raise Unsupported("event chain has non-increasing timestamps")
        return events
