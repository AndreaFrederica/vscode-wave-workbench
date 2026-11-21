# SHM differential fixtures

Run from the repository root with Xcelium, Spectre, and simvisdbutil on PATH. The generator takes a new output directory and keeps the simulator databases, logs and reference exports there.

```sh
bash test/fixtures/shm/generate.sh /tmp/shm-corpus
python3 test/fixtures/shm/verify.py /tmp/shm-corpus --blosc /path/to/libblosc.so.1
```

Set `SHM_SRR_PYTHON` to the full path to Virtuoso's `cdspython` before generation to also compare the mixed analog traces against SRR. The independent readers run with plain Python, and PSFXL sample decoding uses Blosc 1. With Blosc on the system library path, omit `--blosc`.

Set `SHM_LEGACY_SPECTRE` to the executable for Spectre 18.1 to generate an additional PSFXL 1.1 sample with version metadata records. The Rust regression checks it when present.

| Output | Controlled changes | Reference |
| --- | --- | --- |
| `digital/waves.shm` | Four-state logic, two-state bits, ascending and descending vectors, packed grids, nested structs, signed integers, generated hierarchy, real, string and event | Cadence VCD, SST2 reports, and HDL stimulus for unpacked struct members and strings |
| `digital-shifted/waves.shm` | Same stimulus with blank lines inserted before module definitions, declarations and a generate block | Fixed source-line deltas and the same value checks |
| `digital-10ns/waves.shm` | Same digital stimulus with a 10 ns tick | Cadence VCD and the SST2 time exponent |
| `digital-split/waves.shm` | Same digital stimulus across three numbered transition files | VCD from the single-file run |
| `analog/{standard,float32}` | Same RC transient, with variable and constant traces, written as float64 and float32 | Spectre PSF ASCII with the same stimulus and precision-aware value comparisons |
| `analog/{lz4,raw,legacy,legacy-simulator}` | Native LZ4 blocks, uncompressed column data, and PSFXL 1.1 with and without version metadata records | All five channels compared against the Spectre PSF ASCII samples |
| `mixed/waves.shm` | Verilog-AMS with a digital clock, an analog voltage source, and an RC filter | Cadence VCD for the clock and optional SRR bitwise digests for both analog channels |
| `ordered/waves.shm`, `ordered-split/waves.shm` | Same-tick changes on directly recorded and reconstructed buses | Cadence VCD after initialization and known HDL initial states |
| `objects/waves.shm` | Enum, shortreal, realtime, dynamic array, queue, associative array, and string | Known HDL stimulus |
| `object-variants/waves.shm` | Packed union, class handles and members, nested and fixed arrays, queues of arrays, wildcard and string keys, and element deletion | Cadence VCD and SST2 catalogue with assertions from the HDL stimulus |
| `digital/waves.shm.hierarchy.hdl.json` | Declarations and instantiation positions exported from the simulation snapshot | Known positions in the HDL source |
| `psf-analyses` | AC, DC sweep, operating point, noise, transfer function, pole-zero and S-parameter data | Binary and ASCII Spectre exports, with analytic checks for AC and S-parameters |
| `psf-analyses/nested-*` | AC results for a resistance sweep enclosing a capacitance sweep | Four parameter combinations checked against the RC transfer function |
| `psf-analyses/stability-*` | AC, loop gain, and stability margins with each of four requested Spectre output formats | All numeric samples compared against the PSF ASCII files |

Run the same digital, mixed and analog checks through the built Rust backend. This check also removes Cadence environment variables from the backend process and exercises recovery of complete PSFXL chunks from a truncated copy.

```sh
python3 test/fixtures/shm/verify-rust.py native/target/release/wave-backend /tmp/shm-corpus --extended
```

The mixed database contains both SST2 and PSFXL. Its AMS control file supplies the transient analysis for Xcelium. [Cadence AMS control file example](https://community.cadence.com/cadence_technology_forums/f/mixed-signal-design/25749/inserting-electrical-to-real-connect-modules-automatically/1322602)
