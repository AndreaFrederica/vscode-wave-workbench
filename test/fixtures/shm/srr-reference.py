#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0

"""Export SRR binary sample digests for differential verification."""

import hashlib
import json
import sys

import numpy as np
from cdspythonsrr.core.pysrr import srrDataBase


def main():
    database = srrDataBase(sys.argv[1])
    dataset = database.getDataSet(sys.argv[2])
    for name in sys.argv[3:]:
        values = dataset.evalSignal(name).getValue()
        time, voltage = (np.asarray(values[key], dtype="<f8").reshape(-1) for key in ("x", "y"))
        digests = [hashlib.sha256(column).hexdigest() for column in (time, voltage)]
        print(json.dumps([name, [len(time), *digests]]))


if __name__ == "__main__":
    main()
