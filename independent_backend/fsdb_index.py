# SPDX-License-Identifier: MPL-2.0
"""Private bounded signal-to-index address table experiment."""
import struct
from fsdb_container import MAX_BLOCK
from kdb_records import Unsupported


def locations(container, metadata=None):
    start = struct.unpack("<Q", container.read(0x410, 8))[0]
    if not 0x900 <= start <= container.size - 12:
        raise Unsupported("signal index-location pointer is outside file")
    size = struct.unpack("<Q", container.read(start, 8))[0]
    if not 12 <= size <= min(MAX_BLOCK, container.size - start):
        raise Unsupported("signal index-location section bounds/budget")
    position, chunks, decoded = start + 8, [], 0
    while position < start + size:
        if position + 4 > start + size:
            raise Unsupported("truncated index-location compressed length")
        length = struct.unpack("<I", container.read(position, 4))[0]
        position += 4
        if not 0 < length <= start + size - position:
            raise Unsupported("index-location compressed block bounds")
        raw = container.decompress(container.read(position, length), "c")
        if chunks and len(chunks[-1]) != 1048572:
            raise Unsupported("unverified index-location nonfinal block capacity")
        decoded += len(raw)
        if decoded > MAX_BLOCK:
            raise Unsupported("index-location decoded budget exceeded")
        chunks.append(raw)
        position += length
    raw = b"".join(chunks)
    if len(raw) != 9 * (container.header_max_id + 1):
        raise Unsupported("index-location table length disagrees with header ID range")
    result, state_flags = [], []
    for offset in range(0, len(raw), 9):
        address, flags = struct.unpack_from("<QB", raw, offset)
        if flags & ~3:
            raise Unsupported("unverified index-location address flag")
        result.append(address)
        state_flags.append(flags)
    if result[0]:
        raise Unsupported("index-location ID zero must have no record")
    if metadata is not None:
        metadata["stateFlags"] = state_flags
    return result
