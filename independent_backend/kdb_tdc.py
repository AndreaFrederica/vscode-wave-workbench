# SPDX-License-Identifier: MPL-2.0
"""Experimental embedded token documents in user-generated tdc.sdb.

Only database bytes and system LZO1X are read. Original RTL is not opened.
The container stores named documents as chains of indexed physical blocks.
"""
import struct
from pathlib import Path
from kdb_archive import Lzo
from kdb_sources import Cursor
from kdb_records import Unsupported


class TokenDocuments:
    def __init__(self, filename):
        self.filename = Path(filename)
        size = self.filename.stat().st_size
        if size < 136:
            raise Unsupported("truncated token-document container")
        with self.filename.open("rb") as stream:
            header = stream.read(56)
            stream.seek(size - 80)
            spans = [struct.unpack(">QQ", stream.read(16)) for _ in range(5)]
            version, reserved, logical_size, metadata, free, name_offset, name_bytes, bucket_bytes, entry_bytes, flags = struct.unpack(">IIQQQQIIII", header)
            if version != 0x312C4 or reserved or logical_size != size or free or flags:
                raise Unsupported("unrecognized token-document header")
            if spans[0] != (0, name_offset) or spans[1] != (name_offset, name_bytes):
                raise Unsupported("token-document name span mismatch")
            if spans[2][1] != bucket_bytes or spans[3][1] != entry_bytes or entry_bytes % 48 or spans[4][1] % 16:
                raise Unsupported("unrecognized token-document index sizes")
            for (offset, length), (next_offset, _) in zip(spans, spans[1:]):
                if offset + length != next_offset:
                    raise Unsupported("noncontiguous token-document tables")
            if spans[-1][0] + spans[-1][1] != size - 80:
                raise Unsupported("token-document footer extent mismatch")
            if name_bytes > 16 * 1024 * 1024 or entry_bytes > 100000 * 48 or spans[4][1] > 1000000 * 16:
                raise Unsupported("token-document index exceeds budget")
            stream.seek(name_offset)
            names = stream.read(name_bytes)
            stream.seek(spans[3][0])
            records = stream.read(entry_bytes)
            stream.seek(spans[4][0])
            blocks = stream.read(spans[4][1])
        self.blocks = [struct.unpack_from(">QIi", blocks, i) for i in range(0, len(blocks), 16)]
        for offset, length, next_block in self.blocks:
            if offset < 56 or not length or offset + length > name_offset or not -1 <= next_block < len(self.blocks):
                raise Unsupported("invalid token-document data block")
        self.documents = {}
        for i in range(0, len(records), 48):
            fingerprint, name, collision, attributes, head, length, timestamp, opaque = struct.unpack_from(">IIiIQQQQ", records, i)
            end = names.find(b"\0", name)
            if name >= len(names) or end < 0 or not head < len(self.blocks) or length > 256 * 1024 * 1024:
                raise Unsupported("invalid token-document name/head/length")
            name = names[name:end].decode("utf-8")
            if not name.endswith(".tdc") or name[:-4] in self.documents:
                raise Unsupported("unrecognized or duplicate token document name")
            self.documents[name[:-4]] = {"head": head, "length": length}

    def document(self, name):
        record = self.documents[name]
        block, seen, parts, total = record["head"], set(), [], 0
        with self.filename.open("rb") as stream:
            while block != -1:
                if block in seen:
                    raise Unsupported("cyclic token-document block chain")
                seen.add(block)
                offset, length, block = self.blocks[block]
                total += length
                if total > record["length"]:
                    raise Unsupported("token-document chain exceeds declared length")
                stream.seek(offset)
                data = stream.read(length)
                if len(data) != length:
                    raise Unsupported("truncated token-document data")
                parts.append(data)
        if total != record["length"]:
            raise Unsupported("token-document chain length mismatch")
        return b"".join(parts)

    def first_token_block(self, name):
        document = self.document(name)
        cursor = Cursor(document)
        source_bytes, endian, a, b, language, metadata_size = cursor.read("<6I")
        stored_name = cursor.string()
        if endian != 0x01020304 or language != 117 or metadata_size != 10 or not document_name_matches(name, stored_name):
            raise Unsupported("unrecognized token-document descriptor")
        stored = cursor.read("<I")[0]
        if not stored or cursor.offset + stored > len(document):
            raise Unsupported("truncated embedded token block")
        raw = Lzo().decompress_bounded("x", document[cursor.offset:cursor.offset + stored])
        return {"sourceBytes": source_bytes, "descriptorA": a, "descriptorB": b,
                "remainingBytes": len(document) - cursor.offset - stored,
                "raw": raw}

    def _tokens(self, name):
        document = self.document(name)
        cursor = Cursor(document)
        source_bytes, endian, a, b, language, metadata_size = cursor.read("<6I")
        stored_name = cursor.string()
        if endian != 0x01020304 or language != 117 or metadata_size != 10 or not document_name_matches(name, stored_name):
            raise Unsupported("unrecognized token-document descriptor")
        parts, total = [], 0
        while True:
            # The text block stream is followed by the document's absolute
            # stored path, not by a zero-length compression frame.
            if document[cursor.offset:cursor.offset + 1] == b"/":
                end = document.find(b"\0", cursor.offset)
                if end >= 0:
                    candidate = document[cursor.offset:end].decode("utf-8", errors="replace")
                    if Path(candidate).name == Path(stored_name).name:
                        break
            stored = cursor.read("<I")[0]
            if not stored:
                raise Unsupported("unexpected zero-sized token text block")
            if cursor.offset + stored > len(document):
                raise Unsupported("truncated token text block")
            raw = Lzo().decompress_bounded("x", document[cursor.offset:cursor.offset + stored])
            cursor.offset += stored
            total += len(raw)
            if total > 256 * 1024 * 1024:
                raise Unsupported("token text exceeds decoded budget")
            parts.append(raw)
        lines = token_lines(b"".join(parts))
        return {"sourceBytes": source_bytes, "lines": lines, "storedName": stored_name,
                "decodedBytes": total, "compressedBlocks": len(parts)}

    def tokens(self, name):
        result = self._tokens(name)
        # Macro expansion tokens are embedded alongside the original invocation.
        # Count only original spelling when validating the source byte length.
        text_bytes = len(original_text(result["lines"]).encode("utf-8"))
        # This is a syntax token archive, not a lossless text archive. Paired
        # cases show inserted spaces after synthesis comment keywords, and
        # numeric prefixes moved from macro invocations into expansion tokens.
        # Expose that difference; callers must use expanded tokens for semantics.
        result["spellingBytes"] = text_bytes
        result["sourceByteCountMatches"] = (text_bytes == result["sourceBytes"]
                                            if result["sourceBytes"] != 0xFFFFFFFF else None)
        return result


def token_lines(data):
    cursor, lines = Cursor(data), []
    while cursor.offset < len(data):
        count = cursor.read("<I")[0]
        if count > 1000000 or len(lines) > 1000000:
            raise Unsupported("embedded token count exceeds budget")
        tokens = []
        for _ in range(count):
            text = cursor.string()
            metadata = cursor.read("<III")
            token = {"text": text, "metadata": metadata}
            category = metadata[2] >> 16 & 255
            if category in (18, 82):
                token["includeDocument"] = cursor.string()
            elif category in (19, 83):
                token["stringValue"] = cursor.string()
            elif category in (21, 85):
                token["macroExpansion"] = cursor.string()
            elif category == 111:
                # A null provenance pointer has no additional serialized string.
                # Consuming one would eat the empty spelling of the end marker.
                token["expansionOrigin"] = cursor.string() if metadata[:2] != (0, 0) else None
            tokens.append(token)
        lines.append(tokens)
    return lines


def document_name_matches(index_name, stored_name):
    indexed, stored = Path(index_name).name, Path(stored_name).name
    # Basename collisions have numeric suffixes in the index, while each
    # descriptor retains its original path and basename.
    return bool(stored) and (indexed == stored or
                            indexed.startswith(stored) and indexed[len(stored):].isdigit())


def original_text(lines):
    """Return unexpanded token spelling; not necessarily byte-identical RTL."""
    parts, expansion_depth = [], 0
    for line in lines:
        for token in line:
            category = token["metadata"][2] >> 16 & 255
            if category == 111:
                expansion_depth += 1
            elif category == 112:
                if not expansion_depth:
                    raise Unsupported("unbalanced macro expansion end")
                expansion_depth -= 1
            elif not expansion_depth:
                parts.append(token["text"])
    if expansion_depth:
        raise Unsupported("unterminated macro expansion")
    return "".join(parts)
