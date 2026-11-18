# SPDX-License-Identifier: MPL-2.0
"""Compare the Rust and Python readers on locally supplied FSDB files."""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "independent_backend"))
from fsdb_container import Container
from kdb_records import Unsupported


def block(row):
    return {"offset": row["offset"], "storedBytes": row["storedBytes"], "tableOffset": row["indexOffset"]}


def groups(row, names):
    return {name: [block(record) for record in row[name]] for name in names}


def reference(container):
    return {
        "fileBytes": container.size,
        "start": container.start,
        "end": container.end,
        "timescale": container.scale,
        "headerMaxId": container.header_max_id,
        "graphOffset": container.graph_offset,
        "dictionaryOffset": container.dictionary_data_offset,
        "dictionaryDecodedBytes": container.dictionary_decoded,
        "dictionaryStoredBytes": container.dictionary_stored,
        "dictionaryExtensions": {
            "start": container.graph_offset - len(container.dictionary_extensions),
            "end": container.graph_offset,
        },
        "windowExtensions": {
            "start": container.dictionary_offset - len(container.window_extensions),
            "end": container.dictionary_offset,
        },
        "snapshots": [
            {**groups(row, ("scopes", "variables", "auxiliary")),
             "signalWord": row["signalWord"], "idOffset": row["idOffset"]}
            for row in container.snapshots
        ],
        "windows": [
            {**groups(row, ("values", "indexes")), "anchor": row["timeAnchor"],
             "endLow": row["endLow"], "valuePageBase": row["valuePageBase"]}
            for row in container.windows
        ],
    }


def verify_rejections(binary, filename):
    original = filename.read_bytes()
    layout = Container(filename)
    with TemporaryDirectory(prefix="compare-fsdb-") as directory:
        mutated = Path(directory) / "mutated.fsdb"
        mutations = [
            ("short-header", original[:0x820]),
            ("short-graph", original[:layout.graph_offset + 2]),
        ]
        for name, offset, encoding, value in [
            ("version", 0x28, "<I", 87),
            ("dictionary-offset", 0x478, "<Q", len(original)),
            ("window-count", 0x898, "<I", 0xFFFFFFFF),
            ("start-time", 0x800, "<I", 0xFFFFFFFF),
            ("dictionary-length", layout.dictionary_offset, "<I", 0xFFFFFFFF),
        ]:
            changed = bytearray(original)
            struct.pack_into(encoding, changed, offset, value)
            mutations.append((name, changed))
        for name, data in mutations:
            mutated.write_bytes(data)
            try:
                Container(mutated)
            except Unsupported:
                pass
            else:
                raise AssertionError(("Python accepted a malformed container", name))
            result = subprocess.run([binary, str(mutated)], capture_output=True)
            assert result.returncode != 0 and result.stderr and b"panicked" not in result.stderr, (name, result)
    return len(mutations)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", help="path to the compiled fsdb-inspect executable")
    parser.add_argument("fsdb", nargs="+", type=Path)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    for filename in args.fsdb:
        expected = reference(Container(filename))
        actual = json.loads(subprocess.check_output([binary, str(filename)]))
        assert actual == expected, (filename, [key for key in expected if actual.get(key) != expected[key]])
    rejected = verify_rejections(binary, args.fsdb[0])
    print(f"{len(args.fsdb)} FSDB containers match. Both readers rejected {rejected} malformed inputs.")
