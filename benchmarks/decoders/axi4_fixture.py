"""Generate an AXI4 VCD, a pre-bound project and an independent transaction ledger."""
import argparse
import json
import random
from pathlib import Path


def generate(directory, groups, seed):
    rng = random.Random(seed)
    directory.mkdir(parents=True, exist_ok=True)
    widths = {"aclk": 1, "aresetn": 1}
    channels = ("aw", "w", "b", "ar", "r")
    address = {"id": 4, "addr": 32, "len": 8, "size": 3, "burst": 2}
    payloads = (address, {"data": 64, "strb": 8, "last": 1},
                {"id": 4, "resp": 2}, address,
                {"id": 4, "data": 64, "last": 1, "resp": 2})
    for channel, payload in zip(channels, payloads):
        for field, width in {"valid": 1, "ready": 1, **payload}.items():
            widths[channel + field] = width
    saved = {}
    tick = 0
    with (directory / "axi4.vcd").open("w") as wave, (directory / "expected.jsonl").open("w") as ledger:
        ids = {name: f"s{i}" for i, name in enumerate(widths)}
        wave.write("$timescale 1ns $end\n$scope module tb $end\n")
        for name, width in widths.items():
            wave.write(f"$var wire {width} {ids[name]} {name} $end\n")
        wave.write("$upscope $end\n$enddefinitions $end\n#0\n")

        def drive(name, value):
            if saved.get(name) == value:
                return
            saved[name] = value
            encoded = str(value) if widths[name] == 1 else f"b{value:b} "
            wave.write(f"{encoded}{ids[name]}\n")

        def cycle(transfers, stalled=()):
            nonlocal tick
            wave.write(f"#{tick + 1}\n")
            drive("aclk", 0)
            for ch in channels:
                drive(ch + "valid", int(ch in transfers))
                drive(ch + "ready", int(ch not in stalled))
                for field, value in transfers.get(ch, {}).items():
                    drive(ch + field, value)
            wave.write(f"#{tick + 5}\n")
            drive("aclk", 1)
            tick += 10
            return tick - 5

        for name in widths:
            drive(name, 0)
        cycle({})
        wave.write(f"#{tick}\n")
        drive("aresetn", 1)
        for group in range(groups):
            base = group * 4096
            # Two reads with ID 1 overlap a third with ID 3. Different write
            # IDs permit reversing the order of B responses.
            lengths = (4, 2, 256 if group % 64 == 0 else 8, 2, 4)
            ids_in_group = (1, 1, 3, 5, 6)
            offsets = (24, 128, 1024, 8, 40)
            modes = (2, 0, 1, 1, 2)
            records = [
                dict(group=group, kind="Read" if i < 3 else "Write",
                     id=ident, address=base + offsets[i], beats=lengths[i],
                     burst=modes[i], points=[])
                for i, ident in enumerate(ids_in_group)
            ]

            def address_fields(i):
                r = records[i]
                return dict(id=r["id"], addr=r["address"], len=r["beats"] - 1,
                            size=3, burst=r["burst"])

            def transfer(**pins):
                payload = {ch: fields for ch, (_, fields) in pins.items()}
                # Hold payload and VALID stable until every selected channel
                # is accepted; different phases stall different channel sets.
                for _ in range(rng.randrange(3)):
                    cycle(payload, payload)
                edge = cycle(payload)
                for ch, (i, fields) in pins.items():
                    records[i]["points"].append(dict(channel=ch, tick=edge, **fields))

            for i in range(3):
                pins = {"ar": (i, address_fields(i))}
                if i < 2:
                    pins["w"] = (3, dict(data=rng.getrandbits(64), strb=255, last=i))
                transfer(**pins)
            transfer(aw=(3, address_fields(3)))
            transfer(aw=(4, address_fields(4)))
            for i in range(lengths[4]):
                transfer(w=(4, dict(data=rng.getrandbits(64), strb=0xAB,
                                    last=int(i + 1 == lengths[4]))))
            order = [0, 2] * 4 + [1, 2] * 2 + [2] * (lengths[2] - 6)
            seen = [0, 0, 0]
            for index, i in enumerate(order):
                seen[i] += 1
                pins = {"r": (i, dict(id=ids_in_group[i], data=rng.getrandbits(64),
                                       resp=2 if group % 97 == 0 and index == 3 else 0,
                                       last=int(seen[i] == lengths[i])))}
                if index < 2:
                    j = 4 - index
                    pins["b"] = (j, dict(id=ids_in_group[j],
                                         resp=3 if group % 113 == 0 and j == 4 else 0))
                transfer(**pins)
            for record in records:
                ledger.write(json.dumps(record, separators=(",", ":")) + "\n")
        cycle({})
    visible = "aclk awvalid awready awid awaddr wvalid wready wdata wlast bvalid bready bid bresp arvalid arready arid araddr rvalid rready rid rdata rlast rresp".split()
    chosen = [dict(id=ids[name], scope="tb", name=name, width=widths[name]) for name in visible]
    project = dict(format="wave-workbench-project", version=1, waveform="axi4.vcd",
                   view=dict(chosen=chosen, start=0, end=min(tick - 5, 1200), cursorA=15,
                             decoderInstances=[dict(instanceId="axi", decoderId="amba.axi4",
                                                    engine="builtin", pinnedFields=["id", "address"],
                                                    bindings={k: "tb." + k for k in widths})]))
    (directory / "axi4.waveproj").write_text(json.dumps(project, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--groups", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if not 1 <= args.groups <= 2**20:
        parser.error("groups must be between 1 and 1048576")
    generate(args.output, args.groups, args.seed)
