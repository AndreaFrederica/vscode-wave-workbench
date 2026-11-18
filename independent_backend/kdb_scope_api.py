# SPDX-License-Identifier: MPL-2.0
"""Scope API experiment: design, packages and lazy lexical declarations.

Value and direct array-container handles remain
unsupported. This adapter is private until the complete acceptance gate passes.
"""
from collections import defaultdict
from pathlib import Path
from kdb_records import Store, Unsupported
from kdb_objects import ObjectDatabase
from kdb_sources import SourceIndex
from kdb_lexical import LexicalScopes


class ScopeSession:
    def __init__(self, database):
        directory = Path(database)
        if (directory / "kdb.elab++").is_dir():
            directory /= "kdb.elab++"
        self.store = Store(directory / "sdb")
        self.objects, self.sources = ObjectDatabase(directory), SourceIndex(directory)
        self.lexical = LexicalScopes(self.objects, self.sources)
        self.masters = self.store.variant_records()
        self.instances_by_id = {row["id"]: row for row in self.store.instance_names()}
        self.rows, self.child_names, self.definition_names = {}, defaultdict(list), defaultdict(list)
        self.expanded, self.contexts = set(), {}
        self.bindings, self.values = None, None
        for node in self.store.hierarchy(objects=self.objects, include_packages=True, database_order=True):
            master = self.masters[node["masterRecord"]]
            node.update(scopeKey=master["scopeKey"] & 0xFFFFFFFF, sourceKey=master["sourceKey"], base=True)
            self.register(node)
            if node["kind"] in ("npiModule", "npiInterface", "npiProgram"):
                self.definition_names[node["module"]].append(node["fullname"])

    def register(self, row):
        name = row["fullname"]
        if name in self.rows:
            raise Unsupported("duplicate scope API path: " + name)
        self.rows[name] = row
        self.child_names[row["parent"]].append(name)

    def expand(self, name):
        if not name or name in self.expanded:
            return
        row = self.rows[name]
        for child in self.lexical.children(row["scopeKey"], row["sourceKey"]):
            self.register({**child, "fullname": name + "." + child["name"], "parent": name, "base": False})
        self.expanded.add(name)

    def node(self, query):
        if query in self.rows:
            return self.rows[query]
        prefix = query
        while prefix and prefix not in self.rows:
            prefix = prefix.rpartition(".")[0]
        if not prefix:
            raise Unsupported("KDB object not found in supported scope subset: " + query)
        while prefix != query:
            self.expand(prefix)
            candidates = [name for name in self.child_names[prefix]
                          if query == name or query.startswith(name + ".")]
            if not candidates:
                raise Unsupported("value / alias / unknown scope is not implemented: " + query)
            prefix = max(candidates, key=len)
        return self.rows[query]

    @staticmethod
    def summary(row):
        name = row["fullname"]
        return {"fullname": name, "kind": row["kind"], "file": "", "line": 0,
                "module": row["module"] if row["kind"] in ("npiModule", "npiInterface", "npiProgram") else "",
                "definitionFile": "", "definitionLine": 0, "instance": name}

    def context(self, row):
        name = row["fullname"]
        if name not in self.contexts:
            self.contexts[name] = (row if row["kind"] == "npiModule" else
                                   self.context(self.node(row["parent"])) if row["parent"] else None)
        return self.contexts[name]

    def resolve(self, query):
        try:
            row = self.node(query)
        except Unsupported:
            reference = self.resolve_reference(query)
            return {key: reference[key] for key in ("fullname", "kind", "file", "line", "module",
                                                    "definitionFile", "definitionLine", "instance")}
        if row["base"]:
            position = self.objects.instance_position(self.instances_by_id[row["instanceRecord"]], self.sources)
        else:
            position = row
        if position is None:
            raise Unsupported("scope source position is unavailable: " + query)
        context = self.context(row)
        definition = self.sources.lookup(context["module"]) if context else None
        if context and definition is None:
            raise Unsupported("scope module definition is unresolved")
        return {"fullname": query, "kind": row["kind"], "file": position["file"], "line": position["line"],
                "module": context["module"] if context else "",
                "definitionFile": definition["file"] if definition else "",
                "definitionLine": definition["line"] if definition else 0,
                "instance": context["fullname"] if context else ""}

    def parent(self, query):
        try:
            parent = self.node(query)["parent"]
        except Unsupported:
            scope = self.resolve_reference(query)["scope"]
            parent = scope["fullname"] if scope else None
        return [self.resolve(parent)] if parent else []

    def binding_adapter(self):
        if self.bindings is None:
            from kdb_bindings import InterfaceBindings
            self.bindings = InterfaceBindings(self)
        return self.bindings

    def resolve_reference(self, query):
        try:
            return self.binding_adapter().describe(query)
        except Unsupported:
            if self.values is None:
                from kdb_values import ValueObjects
                self.values = ValueObjects(self)
            return self.values.describe(query)

    def scopes(self, query=""):
        if query:
            self.node(query)
            self.expand(query)
        return [self.summary(self.rows[name]) for name in self.child_names[query]]

    def contains_design(self, row, active=None):
        active = active or set()
        name = row["fullname"]
        if name in active or len(active) > 128:
            raise Unsupported("recursive generated design filtering")
        for child_name in self.child_names[name]:
            child = self.rows[child_name]
            if child["kind"] in ("npiModule", "npiProgram"):
                return True
            if child["kind"] == "npiGenScope" and self.contains_design(child, active | {name}):
                return True
        return False

    def children(self, query=""):
        rows = self.scopes(query)
        return [row for row in rows if row["kind"] in ("npiModule", "npiProgram") or
                row["kind"] == "npiGenScope" and self.contains_design(self.rows[row["fullname"]])]

    def instances(self, definition):
        result = []
        for name in self.definition_names[definition]:
            row = self.summary(self.rows[name])
            location = self.sources.lookup(definition)
            if location is None:
                raise Unsupported("own definition location is unresolved")
            row.update(definitionFile=location["file"], definitionLine=location["line"])
            result.append(row)
        return result
