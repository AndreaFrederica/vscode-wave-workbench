# SPDX-License-Identifier: MPL-2.0

import json
import sys

import numpy as np
from cdspythonsrr.core.pysrr import srrDataBase


def read_samples(dataset, name, destination, ticks_per_second):
    wave = dataset.evalSignal(name).getValue()
    times = np.asarray(wave["x"]).reshape(-1)
    values = np.asarray(wave["y"]).reshape(-1)
    if (
        times.size != values.size
        or not times.size
        or times.size > 768 * 1024 * 1024 // 16
        or not np.isrealobj(times)
        or not np.isrealobj(values)
    ):
        raise ValueError("unsupported PSFXL transient signal")
    with open(destination, "xb") as output:
        previous = 0
        for start in range(0, times.size, 65536):
            index = slice(start, start + 65536)
            scaled = times[index] * ticks_per_second
            if not np.all(np.isfinite(scaled) & (scaled >= 0) & (scaled < 2**64)):
                raise ValueError("PSFXL time exceeds the supported range")
            ticks = np.floor(scaled)
            ticks += scaled - ticks >= 0.5
            if ticks[0] < previous or np.any(ticks[1:] < ticks[:-1]):
                raise ValueError("PSFXL time is out of order")
            previous = ticks[-1]
            records = np.empty(ticks.size, dtype=[("tick", "<u8"), ("value", "<f8")])
            records["tick"] = ticks
            records["value"] = values[index]
            records.tofile(output)


def main():
    database = srrDataBase("analog.shm")
    dataset = database.getDataSet(sys.argv[1])
    factor = float(sys.argv[2])
    for line in sys.stdin:
        try:
            signal, destination = json.loads(line)
            read_samples(dataset, signal, destination, factor)
            result = {"ok": True}
        except (RuntimeError, ValueError, TypeError, KeyError, OSError, AttributeError) as error:
            result = {"error": str(error)}
        print("WW-SRR " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
