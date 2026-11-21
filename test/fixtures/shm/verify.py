#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

"""Compare generated Cadence fixtures against the independent SHM readers."""

import argparse
import collections
import json
import math
import re
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
MEMBERS = {
    "diff_tb.entries[0].data": [[0, "0xz"], [13, "z01"]],
    "diff_tb.entries[0].packed_member": [[0, "01zx"], [5, "01z1"]],
    "diff_tb.entries[0].ready": [[0, "1"]],
    "diff_tb.entries[0].packed_member.valid": [[0, "x"], [5, "1"]],
    "diff_tb.packet.code": [[0, "000"], [5, "1xz"]],
    "diff_tb.packet.code[4]": [[0, "0"], [5, "x"]],
    "diff_tb.packed_grid[0]": [[0, "000"], [5, "z01"]],
    "diff_tb.message": [[0, "initial"], [13, "updated"]],
}


def read_script(script, *args):
    return json.loads(subprocess.check_output([sys.executable, str(SCRIPTS / script), *map(str, args)]))


def vcd(path):
    scopes = []
    signals = {}
    events = collections.defaultdict(list)
    tick = 0
    for text in path.read_text().splitlines():
        line = text.strip()
        if line.startswith("$scope "):
            scopes.append(line.split()[2])
        elif line.startswith("$upscope "):
            scopes.pop()
        elif line.startswith("$var "):
            _, kind, width, symbol, name, *fields = line.split()
            # Cadence appends the outer packed range to this fixture's VCD name.
            if name == "packed_grid[1:0]":
                name = "packed_grid"
            signals[symbol] = (".".join([*scopes, name]), kind, int(width))
        elif line.startswith("#"):
            tick = int(line[1:])
        elif line and line[0] in "01xzbr":
            if line[0] in "br":
                if len(line.split()) != 2:
                    continue
                value, symbol = line[1:].split()
            else:
                value, symbol = line[0], line[1:]
            if symbol not in signals:
                continue
            name, kind, width = signals[symbol]
            if kind == "real":
                value = repr(float(value))
            else:
                value = value.rjust(width, value[0] if value[0] in "xz" else "0")
            events[name].append([tick, value])
    return dict(events)


def verify_digital(directory, extra=None, exponent=-12):
    expected = vcd(directory / "reference.vcd")
    expected.update(extra or {})
    flags = [item for name in expected for item in ("--signal", name)]
    stem = directory / "waves.shm" / "waves"
    decoded = read_script("read-sst2-structure.py", stem.with_suffix(".dsn"), stem.with_suffix(".trn"), *flags)
    assert decoded["secondsPerTickExponent"] == exponent
    for name, reference in expected.items():
        binding = decoded["requestedSignals"][name]
        if "events" in binding:
            actual = binding["events"]
        else:
            actual = [
                event for chunk in decoded["series"][binding["series"]]["slices"]
                for stream in chunk.get("streams", []) if stream["id"] in binding["ids"]
                for event in stream["events"]
            ]
        assert actual == reference, (name, actual[:5], reference[:5])
    return {scope["path"]: scope for scope in decoded["scopes"]}, sum(map(len, expected.values()))


def analog_reference(path):
    source = path.read_text().split("\nVALUE\n", 1)[1]
    current_time = None
    results = collections.defaultdict(list)
    for name, text in re.findall(r'^"([^"]+)"\s+([^\s]+)$', source, re.M):
        if name == "time":
            current_time = float(text)
        else:
            results[name].append((current_time, float(text)))
    return results


def verify_analog(directory, library):
    name = "tran1.tran.tran"
    expected = analog_reference(directory / "ascii" / name)
    library_flags = ["--blosc", library] if library else []
    flags = [item for signal in expected for item in ("--signal", signal)]
    for variant, relative in (("standard", 1e-13), ("float32", 1e-7)):
        actual = read_script("read-psfxl.py", directory / variant / name, *library_flags, *flags)["samples"]
        for signal, reference in expected.items():
            samples = actual[signal]
            assert len(samples) == len(reference), (variant, signal, len(samples), len(reference))
            for (time, value), (expected_time, expected_value) in zip(samples, reference):
                assert math.isclose(time, expected_time, rel_tol=1e-13)
                assert math.isclose(value, expected_value, rel_tol=relative, abs_tol=1e-18)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--blosc")
    args = parser.parse_args()
    before, before_count = verify_digital(args.directory / "digital", MEMBERS)
    after, after_count = verify_digital(args.directory / "digital-shifted", MEMBERS)
    for scope, field, line_delta in (
        ("diff_tb", "definitionLine", 4),
        ("diff_tb.lane[0].u_leaf", "definitionLine", 2),
        ("diff_tb.lane[1]", "sourceLine", 6),
    ):
        assert after[scope][field] - before[scope][field] == line_delta
    _, coarse_count = verify_digital(args.directory / "digital-10ns", MEMBERS, exponent=-8)
    _, mixed_count = verify_digital(args.directory / "mixed")
    verify_analog(args.directory / "analog", args.blosc)
    mixed = args.directory / "mixed"
    srr_reference = mixed / "analog-reference.jsonl"
    if srr_reference.is_file():
        library_flags = ["--blosc", args.blosc] if args.blosc else []
        actual = read_script(
            "read-psfxl.py", mixed / "waves.shm" / "timeDom.tran.tran", "--digest-all", *library_flags
        )["samples"]
        expected = dict(map(json.loads, srr_reference.read_text().splitlines()))
        assert actual == expected, (actual, expected)
        print(f"Mixed AMS analog samples agree with SRR on {len(actual)} signals")
    print(f"SST2 events agree ({before_count}, {after_count}, {coarse_count}, {mixed_count})")
    print("PSFXL float64 and float32 samples agree with the PSF ASCII reference")


if __name__ == "__main__":
    main()
