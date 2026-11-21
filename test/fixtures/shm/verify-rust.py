#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

"""Compare the Rust backend protocol against the generated Cadence fixtures."""

import argparse
import json
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from verify import MEMBERS, analog_reference, vcd


def request(process, method, **args):
    process.stdin.write(json.dumps({"id": 1, "method": method, **args}) + "\n")
    process.stdin.flush()
    response = json.loads(process.stdout.readline())
    assert "result" in response, response
    return response["result"]


def open_wave(process, path):
    meta = request(process, "open", path=str(path))
    assert meta["backend"] == "rust-independent-shm", meta["backend"]
    return meta


def samples(process, signal, meta, limit=1500):
    identifier = signal["id"]
    response = request(
        process, "query", signals=[identifier], start=meta["start"], end=meta["end"], limit=limit
    )[identifier]
    assert not response["truncated"], identifier
    return response["events"]


def verify_digital(process, directory, scale, extra):
    meta = open_wave(process, directory / "waves.shm")
    assert meta["scale"] == scale, meta["scale"]
    expected = vcd(directory / "reference.vcd")
    expected.update(extra)
    signals = {f'{item["scope"]}.{item["name"]}': item for item in meta["signals"]}
    for name, reference in expected.items():
        events = samples(process, signals[name], meta)
        actual = [
            [int(tick), repr(float(value)) if signals[name].get("real") else value]
            for tick, value in events
        ]
        assert actual == reference, (name, actual[:5], reference[:5])
    return {item["fullname"]: item for item in request(process, "hdlLocations")}, meta


def verify_analog(process, directory, extended=False):
    stub = "tran1.tran.tran"
    expected = analog_reference(directory / "ascii" / stub)
    variants = [("standard", ".psfxl", 1e-13), ("float32", ".psfxl", 1e-7)]
    if extended:
        variants.extend([
            ("lz4", ".psfxl", 1e-13), ("raw", ".dat", 1e-13), ("legacy", ".psfxl", 1e-13),
        ])
        if (directory / "legacy-simulator").exists():
            variants.append(("legacy-simulator", ".psfxl", 1e-13))
        lz4 = (directory / "lz4" / (stub + ".psfxl")).read_bytes()
        assert b":11:" in lz4.splitlines()[1], "Spectre selected a different compression format"
        assert open_wave(process, directory / "raw" / stub)["end"] == "20000000"
    for variant, suffix, relative in variants:
        meta = open_wave(process, directory / variant / (stub + suffix))
        assert meta["scale"] == "1fs"
        assert set(expected) == {signal["name"] for signal in meta["signals"]}
        assert not meta.get("warnings"), (variant, meta.get("warnings"))
        for signal in meta["signals"]:
            assert signal["real"]
            actual = samples(process, signal, meta)
            reference = expected[signal["name"]]
            assert len(actual) == len(reference)
            for (tick, value), (time, target) in zip(actual, reference):
                assert abs(int(tick) - time * 1e15) <= 0.50001
                assert math.isclose(float(value), target, rel_tol=relative, abs_tol=1e-18)


def verify_partial(process, mixed):
    with tempfile.TemporaryDirectory(prefix="wave-partial-") as temporary:
        stub = Path(temporary) / "timeDom.tran.tran"
        source = mixed / "waves.shm" / stub.name
        shutil.copyfile(source, stub)
        raw = Path(str(source) + ".psfxl").read_bytes()
        Path(str(stub) + ".psfxl").write_bytes(raw[: len(raw) - 128])
        meta = open_wave(process, Path(str(stub) + ".psfxl"))
        assert any("truncated tail" in notice for notice in meta["warnings"])
        counts = sorted(len(samples(process, signal, meta)) for signal in meta["signals"])
        assert counts == [1, 207], counts


def verify_order(process, directory):
    meta = open_wave(process, directory / "waves.shm")
    expected = vcd(directory / "reference.vcd")
    for signal in meta["signals"]:
        name = f'{signal["scope"]}.{signal["name"]}'
        if name not in expected:
            continue
        reference = [[str(tick), value] for tick, value in expected[name]]
        # VCD dumpvars starts after Xcelium's initialization transitions.
        initial = [["0", "x" * signal["width"]]]
        if directory.name == "ordered-split" and name == "order.bus":
            initial.append(["0", "0x"])
        reference = initial + reference
        parameters = {"signals": [signal["id"]], "start": "0", "end": "10"}
        actual = request(process, "query", **parameters, preserveSameTick=True)[signal["id"]]
        assert actual["events"] == reference, (name, actual, reference)
        collapsed = list(dict(reference).items())
        changes = [
            list(row) for index, row in enumerate(collapsed)
            if index == 0 or row[1] != collapsed[index - 1][1]
        ]
        actual = request(process, "query", **parameters)[signal["id"]]
        assert actual["events"] == changes, (name, actual)
        partial = request(process, "query", **parameters, limit=2, preserveSameTick=True)[signal["id"]]
        assert partial["events"] == reference[:2] and partial["truncated"] == (len(reference) > 2), (name, partial)


def verify_objects(process, directory):
    meta = open_wave(process, directory / "waves.shm")
    by_name = {item["name"]: item for item in meta["signals"]}
    expected = {
        "state": [("0", "100"), ("5", "011")],
        "short_real": [("0", "0.25"), ("5", "-2.25")],
        "rt": [("0", "0.25"), ("5", "2.25")],
        "s": [("0", ""), ("5", "hello")],
        "cells[]": [("0", f"{2:032b}")],
        "cells[$1]": [("0", "011")],
        "cells[$2]": [("0", "zzz"), ("5", "111")],
        "queued[]": [("0", f"{1:032b}"), ("5", f"{2:032b}")],
        "queued[$1]": [("0", f"{9:032b}")],
        "queued[$2]": [("5", f"{8:032b}")],
        "assoc[]": [("0", f"{1:032b}"), ("5", f"{2:032b}")],
        "assoc[$2].key": [("0", f"{7:032b}")],
        "assoc[$2].val": [("0", "1011")],
        "assoc[$3].key": [("5", f"{11:032b}")],
        "assoc[$3].val": [("5", "1010")],
    }
    for name, reference in expected.items():
        actual = samples(process, by_name[name], meta)
        assert actual == [list(row) for row in reference], (name, actual, reference)


def verify_object_variants(process, directory):
    _, meta = verify_digital(process, directory, "1ps", {})
    by_name = {f'{s["scope"]}.{s["name"]}': s for s in meta["signals"]}
    catalogue = (directory / "reference-objects.txt").read_text().splitlines()
    recorded = {line.split()[-1] for line in catalogue if line.startswith("*")}
    assert recorded <= by_name.keys(), recorded - by_name.keys()
    instance = next(name.rsplit(".", 1)[0] for name in recorded if "::Packet@" in name and name.endswith(".n"))
    expected = {
        "order.overlay.word": [("0", "01101001"), ("5", "z11x1001")],
        "order.overlay.parts.hi": [("0", "0110"), ("5", "z11x")],
        "order.overlay.parts.lo": [("0", "1001")],
        "order.assoc[$2].key": [("0", "alpha"), ("5", "")],
        "order.assoc[$2].val": [("0", "1001"), ("5", "xxxx")],
        "order.assoc[$3].key": [("5", "beta")],
        "order.assoc[$3].val": [("5", "0101")],
        "order.wild[$3].key": [("5", f"{8:064b}")],
        "order.wild[$3].val": [("5", "0111")],
        "order.nested[$1][]": [("0", f"{2:032b}")],
        "order.nested[$1][$2]": [("0", f"{23:032b}"), ("5", f"{42:032b}")],
        "order.queue_of_arrays[$1][1]": [("0", f"{42:032b}"), ("5", "x" * 32)],
        "order.queue_of_arrays[$2][1]": [("5", f"{11:032b}")],
        instance + ".n": [("0", f"{10:032b}"), ("5", f"{23:032b}"), ("10", "x" * 32)],
        instance + ".label_text": [("0", "before"), ("5", "after"), ("10", "")],
    }
    for name, reference in expected.items():
        actual = samples(process, by_name[name], meta)
        assert actual == [list(row) for row in reference], (name, actual, reference)
    handle = samples(process, by_name["order.pkt"], meta)
    assert int(handle[0][1], 2) != 0 and handle[1] == ["10", "0" * 32], handle


def verify_psf_stability(process, directory):
    for file, axis, count in (("ac1.ac", "frequency", 8), ("stb1.stb", "frequency", 24),
                              ("stb1.margin.stb", "sweep", 4)):
        reference = {}
        for encoding in ("psfascii", "psfbin", "psfxl", "psfbinf"):
            meta = request(process, "open", path=str(directory / f"stability-{encoding}" / file))
            assert meta["axis"] == axis and meta["backend"] == "rust-psf", meta
            traces = {s["name"]: samples(process, s, meta) for s in meta["signals"]}
            assert len(traces) == count, traces
            if encoding == "psfascii":
                reference = traces
                continue
            assert traces.keys() == reference.keys(), (file, encoding, traces.keys())
            # Spectre stores single-precision sweeps and values in PSFBINF.
            tolerance = 2e-6 if encoding == "psfbinf" else 2e-12
            for name, events in traces.items():
                assert len(events) == len(reference[name]), (file, name)
                for (tick, value), (ref_tick, ref_value) in zip(events, reference[name]):
                    assert math.isclose(int(tick), int(ref_tick), rel_tol=tolerance), (
                        file, encoding, name, tick, ref_tick
                    )
                    v, expected = float(value), float(ref_value)
                    assert (math.isnan(v) and math.isnan(expected)) or math.isclose(
                        v, expected, rel_tol=tolerance, abs_tol=1e-12
                    ), (file, encoding, name, value, ref_value)


def verify_psf(process, directory):
    for filename, axis, count in (
        ("ac1.ac", "frequency", 8), ("noise1.noise", "frequency", 5),
        ("dc1.dc", "sweep", 2), ("op1.dc", "sweep", 2),
        ("xf1.xf", "frequency", 4), ("pz1.pz", "sweep", 7), ("sp1.sp", "frequency", 16),
    ):
        revisions = []
        for encoding in ("binary", "ascii"):
            subdir = f"sp-{encoding}" if filename == "sp1.sp" else encoding
            meta = request(process, "open", path=str(directory / subdir / filename))
            assert meta["backend"] == "rust-psf" and meta["axis"] == axis, meta
            traces = {s["name"]: samples(process, s, meta) for s in meta["signals"]}
            assert len(traces) == count, traces
            revisions.append((meta, traces))
        (meta, binary), (text_meta, ascii_traces) = revisions
        assert meta.get("sweep") == text_meta.get("sweep"), (meta, text_meta)
        assert binary.keys() == ascii_traces.keys(), (binary.keys(), ascii_traces.keys())
        for name, actual in binary.items():
            assert len(actual) == len(ascii_traces[name]), name
            for (tick, value), (text_tick, text_value) in zip(actual, ascii_traces[name]):
                assert tick == text_tick, (name, tick, text_tick)
                assert math.isclose(float(value), float(text_value), rel_tol=2e-12), (name, value, text_value)
        if filename == "ac1.ac":
            entries = next(trace for name, trace in binary.items() if name == "vout.mag")
            for tick, value in entries:
                omega_rc = 2 * math.pi * int(tick) * 1e-12
                assert math.isclose(float(value), 1 / math.hypot(1, omega_rc), rel_tol=1e-8)
        elif filename == "dc1.dc":
            assert meta["sweep"]["unit"] == "V", meta["sweep"]
            assert [float(value) for _, value in binary["vout"]] == [0, .25, .5, .75, 1]
        elif filename == "op1.dc":
            assert binary["vout"] == [["0", "1"]]
        elif filename == "sp1.sp":
            assert all(math.isclose(float(value), 0.5) for _, value in binary["s21.mag"])

    for encoding in ("binary", "ascii"):
        meta = request(
            process, "open", path=str(directory / f"nested-{encoding}" / "nested_ac1.sweep")
        )
        assert meta["axis"] == "frequency" and len(meta["signals"]) == 32, meta
        signals = {s["scope"]: s for s in meta["signals"] if s["name"] == "vout.mag"}
        for resistance in (1000, 2000):
            for capacitance in (1, 2):
                signal = signals[f"ac.R={resistance}, C={capacitance}e-9"]
                for tick, value in samples(process, signal, meta):
                    omega_rc = 2 * math.pi * int(tick) * resistance * capacitance * 1e-15
                    assert math.isclose(float(value), 1 / math.hypot(1, omega_rc), rel_tol=1e-8)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backend", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--extended", action="store_true")
    args = parser.parse_args()
    environment = os.environ.copy()
    for key in ("LD_LIBRARY_PATH", "XCELIUM_HOME", "CDS_INST_DIR", "SPECTRE_HOME"):
        environment.pop(key, None)
    with subprocess.Popen(
        [str(args.backend.resolve()), "--independent"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=environment,
    ) as process:
        before, _ = verify_digital(process, args.directory / "digital", "1ps", MEMBERS)
        shifted, _ = verify_digital(process, args.directory / "digital-shifted", "1ps", MEMBERS)
        verify_digital(process, args.directory / "digital-10ns", "10ns", MEMBERS)
        split = args.directory / "digital-split"
        _, split_meta = verify_digital(process, split, "1ps", MEMBERS)
        assert split_meta["end"] == "156"
        split_part = open_wave(process, split / "waves.shm" / "waves-2.trn")
        assert split_part["start"] == "0" and split_part["end"] == "156"
        for name, field, delta in (
            ("diff_tb", "declaration", 4),
            ("diff_tb.lane[0].u_leaf", "declaration", 2),
            ("diff_tb.lane[1]", "instance", 6),
        ):
            assert shifted[name][field]["line"] - before[name][field]["line"] == delta
        assert before["diff_tb.lane[0].u_leaf"]["module"] == "diff_leaf"
        mixed = args.directory / "mixed"
        _, meta = verify_digital(process, mixed, "1ps", {})
        for signal in filter(lambda signal: signal.get("real"), meta["signals"]):
            assert len(samples(process, signal, meta)) == 207
            overview = request(
                process, "overview", name=signal["id"], start="0", end="20000", bins=10
            )
            assert len(overview) == 10 and any(len(row[4]) > 1 for row in overview)
        verify_analog(process, args.directory / "analog", args.extended)
        verify_partial(process, mixed)
        if args.extended:
            for name, field, line in (
                ("diff_tb.packet", "declaration", 21),
                ("diff_tb.entries[0].data", "declaration", 22),
                ("diff_tb.lane[1].u_leaf", "instance", 32),
            ):
                source = before[name][field]
                assert Path(source["file"]).samefile(args.directory / "digital" / "digital.sv")
                assert source["line"] == line, source
            for dataset in ("ordered", "ordered-split"):
                verify_order(process, args.directory / dataset)
            verify_objects(process, args.directory / "objects")
            verify_object_variants(process, args.directory / "object-variants")
            verify_psf(process, args.directory / "psf-analyses")
            verify_psf_stability(process, args.directory / "psf-analyses")
        process.stdin.close()
        assert process.wait(timeout=10) == 0
    print("SST2, PSFXL, mixed SHM, source locations and truncated PSFXL agree")
    if args.extended:
        print("Ordered transitions, HDL snapshot locations, SV objects and Spectre analysis samples agree")


if __name__ == "__main__":
    main()
