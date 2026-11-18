#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Newline-delimited JSON entry point for KDB and FSDB."""
import json
import re
import sys

from fsdb_protocol import MIB, WaveStore
from kdb_protocol import KdbProtocol
from kdb_records import Unsupported


KDB_METHODS = {"kdbOpen", "kdbResolve", "kdbParent", "kdbChildren", "kdbScopes", "kdbInstances"}
WAVE_METHODS = {"query", "describe", "search", "scopeSignals", "matchNames", "defineVirtual",
                "cacheStats", "cacheConfigure"}


def required(request, field):
    value = request.get(field)
    if value is None:
        raise Unsupported("Missing " + field)
    return value


def optional(request, field, default):
    value = request.get(field)
    return default if value is None else value


def timestamp(request, field):
    value = required(request, field)
    if not isinstance(value, str) or not re.fullmatch(r"\+?[0-9]{1,20}", value) or int(value) >= 1 << 64:
        raise Unsupported("Invalid " + field)
    return value


class Backend:
    def __init__(self):
        self.kdb = KdbProtocol()
        self.wave = None

    def run(self, method, request):
        if method in KDB_METHODS:
            return self.kdb.run(method, request)
        if method == "open":
            path = required(request, "path")
            if not isinstance(path, str) or not path or "\0" in path:
                raise Unsupported("Invalid path")
            budget = self.wave.stats["budget"] if self.wave is not None else 64 * MIB
            replacement = WaveStore(path, budget)
            result = replacement.metadata()
            self.wave = replacement
            return result
        if method not in WAVE_METHODS:
            raise Unsupported("Unknown method")
        if self.wave is None:
            raise Unsupported("No open database")
        wave = self.wave
        query = optional(request, "query", "")
        offset = optional(request, "offset", 0)
        if method == "search":
            return wave.search(query, offset, optional(request, "limit", 1500))
        if method == "scopeSignals":
            return wave.scope_signals(query, offset, optional(request, "limit", 512))
        if method == "describe":
            return wave.describe(request.get("descriptors"), request.get("signals"), request.get("query"))
        if method == "matchNames":
            return wave.match_names(required(request, "names"), query)
        if method == "defineVirtual":
            return wave.define_virtual(required(request, "definition"), optional(request, "name", ""))
        if method == "cacheConfigure":
            return wave.configure_cache(optional(request, "bytes", 64 * MIB))
        if method == "cacheStats":
            return wave.stats.copy()
        return wave.query(required(request, "signals"), timestamp(request, "start"),
                          timestamp(request, "end"), optional(request, "limit", 20000))


def respond(backend, line):
    identifier = None
    try:
        data = json.loads(line)
        if not isinstance(data, dict) or not isinstance(data.get("method"), str) or "id" not in data:
            raise Unsupported("Invalid request")
        identifier = data["id"]
        return {"id": identifier, "result": backend.run(data["method"], data)}
    except (Unsupported, OSError) as error:
        return {"id": identifier, "error": str(error)}
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return {"id": identifier, "error": "Invalid request"}


if __name__ == "__main__":
    backend = Backend()
    for line in sys.stdin:
        print(json.dumps(respond(backend, line), ensure_ascii=False, separators=(",", ":")), flush=True)
