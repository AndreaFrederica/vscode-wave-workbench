#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

if [[ $# -ne 1 ]]; then
    printf 'Usage: %s NEW_OUTPUT_DIRECTORY\n' "$0" >&2
    exit 2
fi
fixture_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
mkdir -- "$1"
cd -- "$1"
output_dir="$PWD"
mkdir digital digital-shifted digital-10ns digital-split analog

# The shifted fixture changes source locations while preserving stimulus.
awk 'NR == 3 || NR == 6 || NR == 17 || NR == 36 { print ""; print "" } { print }' \
    "$fixture_dir/digital.sv" > digital-shifted/digital.sv
cp "$fixture_dir/digital.sv" digital/digital.sv
sed 's|1ps/1ps|10ns/10ns|' "$fixture_dir/digital.sv" > digital-10ns/digital.sv

for dataset in digital digital-shifted digital-10ns; do
    cd "$output_dir/$dataset"
    xrun -64bit -sv -access +rwc -input "$fixture_dir/digital.tcl" \
        -top diff_tb digital.sv > simulation.log 2>&1
    sst2report -dsn -locator waves.shm/waves.trn > reference-dsn.txt
    sst2report -trn -id -locator -trans waves.shm/waves.trn > reference-trn.txt
    simvisdbutil -vcd -nolog -scope diff_tb all -output reference.vcd \
        waves.shm/waves.trn > export.log 2>&1
done

cd "$output_dir/digital-split"
cp "$fixture_dir/digital.sv" digital.sv
sed '/^run$/c\run 10ps\ndatabase -change waves\nrun 15ps\ndatabase -change waves\nrun' \
    "$fixture_dir/digital.tcl" > split.tcl
xrun -64bit -sv -access +rwc -input split.tcl -top diff_tb digital.sv > simulation.log 2>&1
cp "$output_dir/digital/reference.vcd" reference.vcd

cd "$output_dir/analog"
cp "$fixture_dir/analog.scs" analog.scs
spectre analog.scs -format psfxl -raw standard > standard.log 2>&1
CDS_PSFXL_SERVER=1 CDS_PSFXL_FLOATY=1 \
    spectre analog.scs -format psfxl -raw float32 > float32.log 2>&1
spectre analog.scs -format psfascii -raw ascii > ascii.log 2>&1
CDS_PSFXL_COMPRESSOR=lz4 spectre analog.scs -format psfxl -raw lz4 > lz4.log 2>&1
CDS_PSFXL_COMPRESS=0 spectre analog.scs -format psfxl -raw raw > raw.log 2>&1
sed '/^simulator/a psfopts options psfversion="1.1"' analog.scs > legacy.scs
spectre legacy.scs -format psfxl -raw legacy > legacy.log 2>&1
if [[ -n "${SHM_LEGACY_SPECTRE:-}" ]]; then
    "$SHM_LEGACY_SPECTRE" legacy.scs -format psfxl -raw legacy-simulator > legacy-simulator.log 2>&1
fi

mkdir "$output_dir/mixed"
cd "$output_dir/mixed"
ahdl_dir="$(dirname -- "$(command -v xrun)")/../spectre/etc/ahdl"
xrun -64bit -ams -access +rwc -input "$fixture_dir/mixed.tcl" -top mixed_tb \
    -incdir "$ahdl_dir" "$fixture_dir/mixed.vams" "$fixture_dir/mixed.scs" > simulation.log 2>&1
simvisdbutil -vcd -nolog -signal mixed_tb.tick -output reference.vcd \
    waves.shm/waves.trn > export.log 2>&1
if [[ -n "${SHM_SRR_PYTHON:-}" ]]; then
    mkdir analog-reference.shm
    for component in logFile timeDom.tran.tran{,.sig,.psfxl}; do
        ln -s "../waves.shm/$component" "analog-reference.shm/$component"
    done
    "$SHM_SRR_PYTHON" "$fixture_dir/srr-reference.py" \
        analog-reference.shm timeDom-tran mixed_tb.step mixed_tb.filtered > analog-reference.jsonl
fi

for dataset in ordered ordered-split objects object-variants; do
    mkdir "$output_dir/$dataset"
    cd "$output_dir/$dataset"
    input=ordered.tcl
    if [[ $dataset == objects || $dataset == object-variants ]]; then input=objects.tcl; fi
    xrun -64bit -sv -access +rwc -input "$fixture_dir/$input" \
        -top order "$fixture_dir/$dataset.sv" > simulation.log 2>&1
    if [[ $dataset != objects ]]; then
        simvisdbutil -vcd -nolog -scope order all -output reference.vcd \
            waves.shm/waves.trn > export.log 2>&1
    fi
    if [[ $dataset == object-variants ]]; then
        sst2report -trn -locator -id waves.shm/waves.trn > reference-objects.txt
    fi
done

mkdir "$output_dir/psf-analyses"
cd "$output_dir/psf-analyses"
cp "$fixture_dir/psf-analyses.scs" analyses.scs
spectre analyses.scs -format psfbin -raw binary > binary.log 2>&1
spectre analyses.scs -format psfascii -raw ascii > ascii.log 2>&1
spectre "$fixture_dir/psf-sparams.scs" -format psfbin -raw sp-binary > sp-binary.log 2>&1
spectre "$fixture_dir/psf-sparams.scs" -format psfascii -raw sp-ascii > sp-ascii.log 2>&1
spectre "$fixture_dir/psf-nested.scs" -format psfbin -raw nested-binary > nested-binary.log 2>&1
spectre "$fixture_dir/psf-nested.scs" -format psfascii -raw nested-ascii > nested-ascii.log 2>&1
for format in psfbin psfascii psfxl psfbinf; do
    spectre "$fixture_dir/psf-stability.scs" -format "$format" -raw "stability-$format" > "stability-$format.log" 2>&1
done

cd "$output_dir/digital"
include_dir="$(dirname -- "$(command -v xrun)")/../include"
cc -shared -fPIC -I"$include_dir" -o hdl.so "$fixture_dir/../../../native/xcelium_hdl.c"
printf 'exit\n' > export-hdl.tcl
WAVE_WORKBENCH_HDL_OUTPUT="$PWD/locations.jsonl" \
    xrun -64bit -R -loadvpisim "$PWD/hdl.so:wave_workbench_hdl_boot" \
    -input export-hdl.tcl > export-hdl.log 2>&1
python3 - <<'PY'
import json
from pathlib import Path

rows = [json.loads(line) for line in Path("locations.jsonl").read_text().splitlines()]
assert rows, "Empty HDL index from simulator snapshot"
Path("waves.shm.hierarchy.hdl.json").write_text(json.dumps({"version": 1, "locations": rows}))
PY
