# SPDX-License-Identifier: MPL-2.0
"""Experimental interface-port bindings from formal and actual source objects.

No inference from SDB instance reuse links. Hierarchical expressions,
interface-port arrays and complex member types still require separate coverage.
"""
from collections import defaultdict
import re
from kdb_records import Unsupported
from kdb_lexical import LexicalScopes


class InterfaceBindings:
    def __init__(self, session):
        self.session = session
        self.formal_cache, self.bound_cache = {}, {}
        self.interface_definitions = defaultdict(set)
        for master in session.masters.values():
            if master["category"] & 65535 == 1:
                self.interface_definitions[master["name"]].add((master["scopeKey"], master["sourceKey"]))
        self.source_instances = defaultdict(list)
        self.source_arrays, self.array_containers, self.formal_arrays = defaultdict(list), {}, {}
        shapes = session.store.array_shapes()
        links = {link["id"]: link for link in session.store.instance_links()}
        array_groups = {}
        for row in session.rows.values():
            if not row["base"]:
                continue
            instance = session.instances_by_id[row["instanceRecord"]]
            self.source_instances[session.objects.original_source(instance)].append(row)
            link = links[row["instanceRecord"]]
            shape = shapes.get((link["masterTag"], link["master"]))
            if row["kind"] == "npiInterface" and shape:
                group = row["parent"], shape["namespace"], shape["id"]
                unit, source = session.objects.original_source(instance)
                view = session.objects.view(unit)
                if view.read(source, "<I")[0] & 255 != 46:
                    raise Unsupported("interface array element source is not an element object")
                index = view.read(source + 4, "<i")[0]
                if row["name"] != shape["name"] + f"[{index}]":
                    raise Unsupported("multi-dimensional or inconsistent interface array element name")
                item = array_groups.setdefault(group, {"shape": shape, "prototype": row, "elements": {}})
                if index in item["elements"]:
                    raise Unsupported("duplicate interface array element index")
                item["elements"][index] = row
        for (parent, _, _), item in array_groups.items():
            shape = item["shape"]
            indices = self.indices(shape)
            if set(indices) != item["elements"].keys():
                raise Unsupported("interface array shape/element coverage mismatch")
            name = parent + "." + shape["name"] if parent else shape["name"]
            if name in self.array_containers:
                raise Unsupported("ambiguous runtime interface array container")
            container = {"fullname": name, "kind": "npiInterfaceArray", "parent": parent, **item}
            self.array_containers[name] = container
            source_key = session.objects.original_source(shape)
            self.source_arrays[source_key].append(container)
        for excluded in session.store.excluded_references:
            link = links[excluded["instanceRecord"]]
            shape = shapes.get((link["masterTag"], link["master"]))
            if not shape:
                continue
            instance = session.instances_by_id[excluded["instanceRecord"]]
            unit, source = session.objects.original_source(instance)
            view = session.objects.view(unit)
            if view.read(source, "<I")[0] & 255 != 46:
                raise Unsupported("formal interface array source is not an element")
            index = view.read(source + 4, "<i")[0]
            tail = "." + shape["name"] + f"[{index}]"
            if not excluded["fullname"].endswith(tail):
                raise Unsupported("formal array element name/source mismatch")
            key = excluded["fullname"][:-len(tail)], shape["name"]
            if key in self.formal_arrays and self.formal_arrays[key] != shape:
                raise Unsupported("inconsistent formal array declaration shape")
            self.formal_arrays[key] = shape

    @staticmethod
    def indices(shape):
        step = 1 if shape["right"] >= shape["left"] else -1
        return list(range(shape["left"], shape["right"] + step, step))

    def formals(self, owner):
        row = self.session.node(owner)
        if row["kind"] not in ("npiModule", "npiInterface", "npiProgram"):
            raise Unsupported("interface formal owner is not an instance")
        key = row["scopeKey"], row["sourceKey"]
        if key not in self.formal_cache:
            view = self.session.objects.view(key[0])
            result = {}
            for port in LexicalScopes.chain(view, view.pointer(key[1] + 56)):
                if view.read(port, "<I")[0] & 255 != 47:
                    raise Unsupported("unrecognized formal port list node")
                decl = view.pointer(port + 24)
                header = view.read(decl, "<I")[0]
                if header & 255 != 77:
                    continue
                name = view.string(view.pointer(decl + 24))
                file_number = header >> 8 & 127
                if file_number == 127:
                    file_number = self.session.objects.extended_file_number(key[0], decl)
                document = self.session.objects.source_files(key[0]).get(file_number)
                filename = self.session.sources.document(self.session.objects.unit_libraries[key[0]], document) if document else None
                line = view.read(decl + 4, "<I")[0]
                if not filename or not line or name in result:
                    raise Unsupported("ambiguous or unlocated interface formal")
                parts = []
                for component in LexicalScopes.chain(view, view.pointer(decl + 32)):
                    if view.read(component, "<I")[0] != 27:
                        raise Unsupported("unrecognized interface type-name component")
                    parts.append(view.string(view.pointer(component + 24)))
                generic = bool(header & 0x80000000)
                target_unit = target_root = target = None
                modport = None
                if generic:
                    if parts:
                        raise Unsupported("generic interface has an unexpected named type")
                else:
                    if len(parts) not in (1, 2):
                        raise Unsupported("qualified interface type shape is not implemented")
                    definitions = self.interface_definitions[parts[0]]
                    if len(definitions) != 1:
                        raise Unsupported("interface type definition is ambiguous or missing")
                    target_unit, target_root = next(iter(definitions))
                    target_view = self.session.objects.view(target_unit)
                    # Relative to the INTERFACE arena, not the consumer arena.
                    target = view.pointer(decl + 48, target_view=target_view)
                    target_kind = target_view.read(target, "<I")[0] & 255
                    if len(parts) == 1:
                        if target_kind != 32 or target != target_root:
                            raise Unsupported("interface type target disagrees with its definition")
                    else:
                        if target_kind != 75 or target_view.pointer(target + 48) != target_root:
                            raise Unsupported("unrecognized modport definition target")
                        modport = target_view.string(target_view.pointer(target + 32))
                        if modport != parts[1]:
                            raise Unsupported("modport definition/name mismatch")
                result[name] = {"name": name, "ordinal": view.read(port + 16, "<I")[0],
                                "scopeKey": key[0], "sourceKey": decl, "file": filename, "line": line,
                                "interfaceUnit": target_unit, "interfaceRoot": target_root,
                                "modport": modport, "typeTarget": target, "generic": generic,
                                "array": bool(header & 0x40000000)}
            self.formal_cache[key] = result
        return self.formal_cache[key]

    def actual(self, owner, name, active=None):
        key = owner, name
        if key in self.bound_cache:
            return self.bound_cache[key]
        active = active or set()
        if key in active or len(active) > 128:
            raise Unsupported("recursive interface port binding")
        formals = self.formals(owner)
        if name not in formals:
            raise Unsupported("interface formal not found")
        formal = formals[name]
        row = self.session.node(owner)
        caller = row["parent"]
        if not caller:
            raise Unsupported("top-level interface formal has no actual caller")
        instance = self.session.instances_by_id[row["instanceRecord"]]
        unit, source = self.session.objects.original_source(instance)
        view = self.session.objects.view(unit)
        kind = view.read(source, "<I")[0] & 255
        if kind == 46:
            source = view.pointer(source + 8)
            kind = view.read(source, "<I")[0] & 255
        if kind not in (44, 45):
            raise Unsupported("unrecognized interface consumer call object")
        targets = []
        for connection in LexicalScopes.chain(view, view.pointer(source + 48)):
            header = view.read(connection, "<I")[0]
            if header & 255 != 49:
                raise Unsupported("unrecognized actual port connection object")
            matched = (view.string(view.pointer(connection + 32)) == name if header & 0x80000000
                       else view.read(connection + 32, "<I")[0] == formal["ordinal"])
            if matched:
                targets.append(view.pointer(connection + 48))
        if len(targets) != 1 or targets[0] is None:
            raise Unsupported("missing or ambiguous actual interface connection")
        target = targets[0]
        target_kind = view.read(target, "<I")[0] & 255
        if target_kind == 77:
            forwarded_name = view.string(view.pointer(target + 24))
            actual = self.actual(caller, forwarded_name, active | {key})
        elif target_kind in (44, 45, 46):
            candidates = [candidate for candidate in self.source_instances[(unit, target)]
                          if candidate["kind"] == "npiInterface" and
                          (caller == candidate["parent"] or caller.startswith(candidate["parent"] + "."))]
            candidates += [candidate for candidate in self.source_arrays[(unit, target)]
                           if caller == candidate["parent"] or caller.startswith(candidate["parent"] + ".")]
            if not candidates:
                raise Unsupported("actual interface declaration is outside caller ancestry")
            nearest = max(len(candidate["parent"]) for candidate in candidates)
            candidates = [candidate for candidate in candidates if len(candidate["parent"]) == nearest]
            if len(candidates) != 1:
                raise Unsupported("actual interface declaration matches several runtime instances")
            actual = dict(candidates[0])
            declared_name = actual["shape"]["name"] if actual["kind"] == "npiInterfaceArray" else actual["name"]
            # NPI can display a direct outer-scope declaration under the caller
            # context (e.g. g[0].bus for an actual tb.bus). Preserve that display
            # identity separately from the verified physical runtime instance.
            actual["_npiFullname"] = caller + "." + declared_name
        elif target_kind == 60:
            actual = self.hierarchical_actual(unit, target, caller)
        else:
            raise Unsupported("actual interface expression kind is not implemented: " + str(target_kind))
        if formal["array"]:
            shape = self.formal_arrays.get(key)
            if not shape or actual["kind"] != "npiInterfaceArray" or len(self.indices(shape)) != len(actual["elements"]):
                raise Unsupported("formal/actual interface array shape mismatch")
        elif actual["kind"] != "npiInterface":
            raise Unsupported("scalar interface formal is bound to an array")
        self.bound_cache[key] = actual
        return actual

    def hierarchical_actual(self, unit, source, caller):
        view, segments, seen = self.session.objects.view(unit), [], set()
        while source is not None:
            if source in seen or len(seen) > 128:
                raise Unsupported("cyclic or excessive hierarchical interface expression")
            seen.add(source)
            if view.read(source, "<I")[0] & 255 != 60:
                raise Unsupported("unrecognized hierarchical reference component")
            name = view.string(view.pointer(source + 24))
            declaration_unit = view.read(source + 20, "<I")[0] >> 16 or unit
            declaration_view = self.session.objects.view(declaration_unit)
            declaration = view.pointer(source + 48, target_view=declaration_view)
            segments.append((name, declaration_unit, declaration))
            source = view.pointer(source + 40)
        path = ".".join(name for name, _, _ in segments)
        ancestor = caller
        while True:
            candidate_name = ancestor + "." + path if ancestor else path
            candidate = self.session.rows.get(candidate_name) or self.array_containers.get(candidate_name)
            if candidate is not None:
                break
            if not ancestor:
                raise Unsupported("hierarchical actual has no matching runtime path")
            ancestor = self.session.node(ancestor)["parent"]
        if candidate["kind"] not in ("npiInterface", "npiInterfaceArray"):
            raise Unsupported("hierarchical actual does not name an interface")
        # Validate the runtime choice against resolved AST declaration identity.
        if candidate["kind"] == "npiInterfaceArray":
            actual_source = self.session.objects.original_source(candidate["shape"])
        else:
            actual_source = self.session.objects.original_source(self.session.instances_by_id[candidate["instanceRecord"]])
        if actual_source != segments[-1][1:]:
            raise Unsupported("hierarchical runtime path disagrees with resolved source identity")
        return candidate

    def describe(self, query):
        owner = query
        while owner and owner not in self.session.rows:
            owner = owner.rpartition(".")[0]
        if not owner:
            raise Unsupported("interface alias has no supported owner")
        tail = query[len(owner) + 1:]
        candidates = [name for name in self.formals(owner) if tail == name or tail.startswith(name + ".") or tail.startswith(name + "[")]
        if len(candidates) != 1:
            raise Unsupported("interface alias formal is ambiguous or absent")
        name = candidates[0]
        formal = self.formals(owner)[name]
        actual = self.actual(owner, name)
        reported_name = actual.get("_npiFullname", actual["fullname"])
        suffix = tail[len(name):]
        if suffix.startswith("["):
            match = re.match(r"\[(-?\d+)\]", suffix)
            if not match or not formal["array"]:
                raise Unsupported("invalid scalar/array interface alias selection")
            indices = self.indices(self.formal_arrays[(owner, name)])
            index = int(match[1])
            if index not in indices:
                raise Unsupported("formal interface array index is out of bounds")
            actual_index = self.indices(actual["shape"])[indices.index(index)]
            actual = actual["elements"][actual_index]
            reported_name += f"[{actual_index}]"
            suffix = suffix[len(match[0]):]
        canonical_name = actual["fullname"]
        if formal["modport"]:
            if suffix:
                if suffix.count(".") != 1:
                    raise Unsupported("nested modport member selection is not implemented")
                target_view = self.session.objects.view(formal["interfaceUnit"])
                members = []
                for member in LexicalScopes.chain(target_view, target_view.pointer(formal["typeTarget"] + 56)):
                    if target_view.read(member, "<I")[0] & 255 != 76:
                        raise Unsupported("unrecognized modport member declaration")
                    if target_view.string(target_view.pointer(member + 24)) == suffix[1:]:
                        members.append(member)
                if len(members) != 1:
                    raise Unsupported("modport member is missing or ambiguous")
                actual = {"fullname": actual["fullname"] + "." + formal["modport"] + suffix, "kind": "npiMpPort"}
                reported_name += "." + formal["modport"] + suffix
                canonical_name = actual["fullname"]
            else:
                # Observed NPI npiActual(modport ref) exposes no fullname. The
                # member reference does carry its actual interface instance path.
                actual = {"fullname": "", "kind": "npiModport"}
                reported_name = ""
                canonical_name += "." + formal["modport"]
        elif suffix:
            actual_name = actual["fullname"] + suffix
            if actual_name in self.session.rows:
                actual = {"fullname": actual_name, "kind": self.session.rows[actual_name]["kind"]}
            else:
                if suffix.count(".") != 1:
                    raise Unsupported("nested interface value member is not implemented")
                scope = actual["prototype"] if actual["kind"] == "npiInterfaceArray" else self.session.node(actual["fullname"])
                view = self.session.objects.view(scope["scopeKey"])
                found = []
                for decl in LexicalScopes.chain(view, view.pointer(scope["sourceKey"] + 64)):
                    if view.string(view.pointer(decl + 32)) == suffix[1:]:
                        found.append(decl)
                if len(found) != 1:
                    raise Unsupported("actual interface value member is missing or ambiguous")
                header = view.read(found[0], "<I")[0]
                kind, dtype = header & 255, header >> 16 & 255
                if kind in (51, 52, 53):
                    actual_kind = "npiNet"
                elif kind in (54, 55) and dtype in (7, 8):
                    actual_kind = "npiReg" if dtype == 7 else "npiBitVar"
                else:
                    raise Unsupported("actual interface member type is not implemented")
                actual = {"fullname": actual_name, "kind": actual_kind}
            reported_name += suffix
            canonical_name = actual_name
        parent = query.rpartition(".")[0] if suffix else owner
        context = self.session.resolve(owner)
        return {"fullname": query, "kind": "npiRefObj", "file": formal["file"], "line": formal["line"],
                "module": context["module"], "definitionFile": context["definitionFile"],
                "definitionLine": context["definitionLine"], "instance": context["instance"],
                "actual": {"fullname": reported_name, "kind": actual["kind"]},
                "canonicalActual": {"fullname": canonical_name, "kind": actual["kind"]},
                "scope": {"fullname": parent, "kind": "npiRefObj" if suffix else self.session.rows[owner]["kind"]}}
