# SPDX-License-Identifier: MPL-2.0
"""Experimental function/task and procedural block scope declarations."""
from kdb_records import Unsupported


class LexicalScopes:
    def __init__(self, objects, sources):
        self.objects, self.sources, self.cache = objects, sources, {}

    @staticmethod
    def chain(view, head):
        seen, node = set(), head
        while node is not None:
            if node in seen:
                if node != head:
                    raise Unsupported("non-root cycle in lexical scope list")
                return
            if len(seen) > 100000:
                raise Unsupported("lexical scope list exceeds budget")
            seen.add(node)
            yield node
            node = view.pointer(node + 8)

    def subroutines(self, view, head):
        """Normalize extern prototypes (65) to definitions (64), once each."""
        definitions = {}
        for child in self.chain(view, head):
            kind = view.read(child, "<I")[0] & 255
            if kind == 65:
                definition = view.pointer(child + 88)
                if definition is None:
                    continue  # Declaration without a body is not an internal scope.
                if (view.read(definition, "<I")[0] & 255 != 64 or
                        view.string(view.pointer(child + 40)) != view.string(view.pointer(definition + 40)) or
                        view.pointer(child + 56) != view.pointer(definition + 56)):
                    raise Unsupported("extern subroutine prototype/definition mismatch")
                definitions[definition] = None
            elif kind == 64:
                definitions[child] = None
            else:
                raise Unsupported("unrecognized subroutine declaration list kind: " + str(kind))
        return list(definitions)

    def children(self, unit, source):
        unit &= 0xFFFFFFFF
        view = self.objects.view(unit)
        if view.read(source, "<I")[0] & 255 == 81:
            source = view.pointer(source + 72)
        key = unit, source
        if key in self.cache:
            return self.cache[key]
        kind = view.read(source, "<I")[0] & 255
        children, class_head = [], None
        if kind in (31, 32):
            children.extend(self.subroutines(view, view.pointer(source + 168)))
            wrappers = view.pointer(source + 176)
            class_head = view.pointer(source + 272)
        elif kind == 64:
            wrappers = view.pointer(source + 80)
        elif kind == 66:
            children.extend(self.subroutines(view, view.pointer(source + 136)))
            wrappers = view.pointer(source + 88)
            class_head = view.pointer(source + 144)
        elif kind == 82:
            children.extend(self.subroutines(view, view.pointer(source + 56)))
            class_head = view.pointer(source + 112)
            wrappers = None
        else:
            raise Unsupported("unrecognized lexical scope owner type: " + str(kind))
        for wrapper in self.chain(view, wrappers):
            if view.read(wrapper, "<I")[0] & 255 != 26:
                raise Unsupported("unrecognized lexical child wrapper")
            children.append(view.pointer(wrapper + 16))
        for child in self.chain(view, class_head):
            if view.read(child, "<I")[0] & 255 != 82:
                raise Unsupported("unrecognized class declaration list")
            children.append(child)
        result = []
        for child in children:
            child_kind = view.read(child, "<I")[0] & 255
            if child_kind == 64:
                name = view.string(view.pointer(child + 40))
                flags = view.read(child + 32, "<I")[0]
                # In the full-chip comparison all four declarations with this
                # bit are absent both from npiInternalScope iteration and from
                # npi_handle_by_name. Do not expose their descendants either.
                # The semantic name of the bit is not established yet.
                if flags & 0x800:
                    continue
                tag = flags & 0x300
                if tag not in (0x100, 0x200):
                    raise Unsupported("unrecognized subroutine task/function flags")
                api_kind = "npiTask" if tag == 0x100 else "npiFunction"
                owner = view.pointer(child + 56)
            elif child_kind == 66:
                name = view.string(view.pointer(child + 32))
                flags = view.read(child + 4, "<I")[0]
                statement = view.pointer(child + 48)
                foreach = (bool(flags & 0x40000000) and statement is not None and
                           view.read(statement, "<I")[0] & 255 == 67 and
                           view.read(statement + 4, "<I")[0] & 255 == 66)
                if foreach:
                    api_kind = "npiForeachStmt"
                elif flags & 0x80000000:
                    api_kind = "npiFor"
                elif flags & 16:
                    api_kind = "npiFork" if flags & 0x40000000 else "npiNamedFork"
                else:
                    api_kind = "npiBegin" if flags & 0x40000000 else "npiNamedBegin"
                owner = view.pointer(child + 80)
            elif child_kind == 82:
                name = view.string(view.pointer(child + 32))
                api_kind = "npiClassDefn"
                owner = view.pointer(child + 104)
            else:
                raise Unsupported("unrecognized lexical child kind: " + str(child_kind))
            if owner != source:
                raise Unsupported("lexical child owner mismatch")
            position = self.objects.instance_position({"scopeKey": unit, "sourceKey": child}, self.sources)
            if position is None:
                raise Unsupported("unresolved lexical source position")
            result.append({"name": name, "kind": api_kind, "sourceKey": child, "scopeKey": unit,
                           "file": position["file"], "line": position["line"]})
        result.sort(key=lambda item: (item["line"], item["sourceKey"]))
        self.cache[key] = result
        return result

    def tree(self, unit, source, prefix):
        rows, active = [], set()

        def visit(unit, source, prefix):
            key = unit, source
            if key in active or len(active) > 128 or len(rows) > 100000:
                raise Unsupported("recursive or excessive lexical scope tree")
            active.add(key)
            for child in self.children(unit, source):
                name = prefix + "." + child["name"] if prefix else child["name"]
                rows.append({"fullname": name, "parent": prefix, **child})
                visit(child["scopeKey"], child["sourceKey"], name)
            active.remove(key)
        visit(unit, source, prefix)
        return rows
