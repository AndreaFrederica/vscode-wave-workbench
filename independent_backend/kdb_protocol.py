# SPDX-License-Identifier: MPL-2.0
"""Private adapter for the extension's KDB request contract."""
from pathlib import Path

from kdb_records import Unsupported
from kdb_scope_api import ScopeSession


class KdbProtocol:
    SCOPE_LIMIT = 1500

    def __init__(self):
        self.session = None

    def open(self, filename):
        if self.session is not None:
            raise Unsupported("KDB already loaded; attach a fresh backend for another database")
        if not isinstance(filename, str) or not filename or "\0" in filename:
            raise Unsupported("Invalid path")
        path = Path(filename)
        if not path.is_dir():
            raise Unsupported("KDB directory is unavailable")
        self.session = ScopeSession(path)
        return {"attached": True, "backend": "native-independent-kdb"}

    def run(self, method, request):
        if method == "kdbOpen":
            if request.get("path") is None:
                raise Unsupported("Missing KDB directory")
            return self.open(request["path"])
        if method == "kdbResolve" and request.get("query") is None:
            raise Unsupported("Missing hierarchy")
        query = request.get("query") or ""
        if not isinstance(query, str) or "\0" in query:
            raise Unsupported("Invalid hierarchy name")
        session = self.session
        if session is None:
            raise Unsupported("No KDB attached")
        if method == "kdbResolve":
            return [session.resolve(query)]
        if method == "kdbParent":
            return session.parent(query)
        if method == "kdbInstances":
            return session.instances(query)
        if method in ("kdbChildren", "kdbScopes"):
            if query and query not in session.rows:
                try:
                    session.node(query)
                except Unsupported:
                    session.resolve_reference(query)
                    return []
            lookup = session.children if method == "kdbChildren" else session.scopes
            return lookup(query)[:self.SCOPE_LIMIT]
        raise Unsupported("Unknown KDB method")
