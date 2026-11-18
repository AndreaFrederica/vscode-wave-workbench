# SPDX-License-Identifier: MPL-2.0
"""Recognize input storage from compiler-recorded port tokens."""
from pathlib import PurePosixPath

from kdb_records import Unsupported
from kdb_tdc import TokenDocuments


class PortTokens:
    def __init__(self, session):
        self.session = session
        self.archives = {}
        self.modules = {}
        self.definitions = {}
        for row in session.rows.values():
            if row["kind"] not in ("npiModule", "npiInterface", "npiProgram"):
                continue
            unit = row["scopeKey"]
            if unit in self.definitions:
                continue
            self.definitions[unit] = session.sources.lookup(row["module"])

    def inputs(self, owner):
        unit = owner["scopeKey"]
        if unit not in self.modules:
            self.read_document(unit)
        return self.modules[unit]

    def read_document(self, unit):
        definition = self.definitions.get(unit)
        self.modules[unit] = {}
        if not definition:
            return
        library = definition["library"]
        if library not in self.archives:
            self.archives[library] = TokenDocuments(self.session.objects.directory / library / "tdc.sdb")
        archive = self.archives[library]
        exact = definition["source"]
        names = (exact, PurePosixPath(exact).name)
        document = next((name for name in names if name in archive.documents), None)
        if document is None:
            return
        tokens = archive.tokens(document)["lines"]
        for source_unit, source in self.definitions.items():
            if source and (source["library"], source["source"]) == (library, exact):
                self.modules[source_unit] = self.read_inputs(source_unit, source, tokens)

    @staticmethod
    def read_inputs(unit, definition, tokens):
        start = definition["line"] - 1
        stop = min(definition["endLine"], start + 1024)
        inputs, nesting = {}, []
        module_seen, direction, explicit = False, None, False
        source_prefix, before_var = [], None
        header_import = False
        scan_name = False
        pairing = {")": "(", "]": "[", "}": "{"}
        for line in tokens[start:stop]:
            for token in line:
                text = token["text"]
                key, token_unit, metadata = token["metadata"]
                category = metadata >> 16 & 255
                if before_var is None:
                    source_prefix.append(" " if category == 1 else text)
                if not module_seen:
                    if category == 2 and text in ("module", "macromodule", "interface", "program"):
                        scan_name = True
                    elif category == 3 and scan_name:
                        module_seen = text == definition["unit"] and key in (0, 24)
                        scan_name = False
                    continue
                if not nesting and category == 2 and text == "import":
                    header_import = True
                if header_import:
                    if category == 11 and text == ";":
                        header_import = False
                    continue
                if category == 11 and text in pairing.values():
                    nesting.append(text)
                elif category == 11 and text in pairing:
                    if not nesting or nesting.pop() != pairing[text]:
                        raise Unsupported("unbalanced KDB port tokens")
                elif category == 11 and text == ";" and not nesting:
                    return inputs
                elif nesting == ["("]:
                    if category == 2 and text in ("input", "output", "inout", "ref"):
                        direction, explicit = text, False
                    elif category == 2 and text == "var":
                        explicit = True
                        if before_var is None:
                            before_var = "".join(source_prefix)
                    elif category == 6 and token_unit in (0, unit) and direction == "input":
                        # NPI treats an earlier occurrence of the name in
                        # the source prefix as an implicit net declaration.
                        storage = "npiReg" if explicit and text not in before_var else "npiNet"
                        inputs[key or text] = (text, storage)
        return {}
