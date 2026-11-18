# SPDX-License-Identifier: MPL-2.0
"""Read scope and signal declarations from template-based FSDB snapshots."""
from fsdb_container import Container
from fsdb_templates import Cursor, template_bytes, parse_templates, atom_variables
from kdb_records import Unsupported


def native_scopes(raw, templates, *, virtual_base=0, previous_footer=None, metadata=None):
    cursor = Cursor(raw)
    cursor.require(0xFE)
    cursor.require(4)
    if previous_footer is not None:
        descriptor = cursor.integer()
        if descriptor > 3 or cursor.integer(1 << descriptor) != previous_footer:
            raise Unsupported("native scope snapshot predecessor mismatch")
    rows, stack = [], []
    while cursor.offset < len(raw):
        start, code = cursor.offset, cursor.integer()
        if code in (0, 0x80, 0xFA, 0xFB):
            if code == 0x80:
                cursor.require(0)
            key = None
            if code in (0, 0x80):
                name, definition, scope_kind = cursor.string(), cursor.string(), cursor.integer()
            else:
                name = cursor.string() if code == 0xFA else None
                descriptor = cursor.integer()
                if descriptor not in (0, 0x10) or code == 0xFA and descriptor:
                    raise Unsupported("unverified native scope key/child index encoding")
                key = cursor.integer(2)
                if key not in templates or templates[key]["kind"] != "scope":
                    raise Unsupported("native scope references a non-scope/unknown template")
                if code == 0xFB:
                    child_index = cursor.integer(1 << (descriptor >> 4 & 3))
                    if not stack or stack[-1]["template"] is None:
                        raise Unsupported("indexed native child has no parent template")
                    children = templates[stack[-1]["template"]]["children"]
                    if child_index >= len(children):
                        raise Unsupported("native child name index exceeds template")
                    name = children[child_index]
                definition, scope_kind = templates[key]["definition"], templates[key]["scopeKind"]
            flags = cursor.integer()
            if flags not in (0, 1, 4, 5, 0xC, 0xD, 0x11, 0x15, 0x1D, 0x40, 0x41, 0x4C, 0x4D):
                raise Unsupported("unimplemented native scope flags: " + hex(flags))
            variables = cursor.integer(4) if flags & 1 else None
            marker = None
            marker_payload = None
            if flags & 4 and not flags & 8:
                marker = cursor.integer()
                if marker <= 3:
                    marker_payload = cursor.integer(1 << marker)
                elif not 0x40 <= marker <= 0x7F:
                    raise Unsupported("unrecognized scope metadata scalar encoding: " + hex(marker))
                # Opaque metadata scalar; the existing bridge exposes scope
                # names/parents, not this field's semantic value.
            parent = stack[-1]["fullname"] if stack else ""
            row = {"name": name, "fullname": parent + "." + name if parent else name,
                   "parent": parent, "definition": definition, "scopeKind": scope_kind,
                   "template": key, "variableOffset": variables, "flags": flags,
                   "marker": marker, "markerPayload": marker_payload}
            rows.append(row)
            stack.append(row)
            if len(stack) > 256 or len(rows) > 1000000:
                raise Unsupported("native scope tree exceeds budget")
        elif code == 0xFD:
            if not stack:
                raise Unsupported("native scope stack underflow")
            flags = cursor.integer()
            if flags == 4:
                descriptor = cursor.integer()
                if descriptor not in (0x40, 0x41, 0x42, 0x50, 0x51, 0x52, 0x55, 0x56, 0x5E):
                    raise Unsupported("unrecognized native scope close attributes: " + hex(descriptor))
                # Retain uninterpreted close metadata; names/variables do not
                # depend on its semantic interpretation in the control cases.
                value = cursor.integer(1 << (descriptor & 3))
                stack[-1]["closeAttribute"] = {"descriptor": descriptor, "value": value}
            elif flags:
                raise Unsupported("unrecognized native close flags")
            stack.pop()
        elif code == 0xFF and not stack:
            descriptor = cursor.integer(2)
            if descriptor not in (0, 4, 8, 0xA):
                raise Unsupported("native scope footer outside proven integer widths: " + hex(descriptor))
            # The aligned virtual base omits its always-zero low byte.
            base = cursor.integer((1 << (descriptor & 3)) - 1) << 8
            footer_position = cursor.integer(1 << (descriptor >> 2 & 3))
            # Preserve the footer's interior pointer. Small controls place it
            # four bytes before FF, but full-chip snapshots also use a nearby
            # interior position; its precise metadata role is not exposed by
            # the bridge. Check the mapped range instead of guessing equality.
            if (base != virtual_base or not virtual_base <= footer_position < virtual_base + start or
                    cursor.offset != len(raw)):
                raise Unsupported(f"native scope footer mismatch: base={base}/{virtual_base}, end={footer_position}/{virtual_base + start - 4}, offset={cursor.offset}/{len(raw)}")
            if metadata is not None:
                metadata.update(footerAddress=virtual_base + start, virtualBase=virtual_base)
            return rows
        else:
            context = [{key: row[key] for key in ("fullname", "template", "flags", "variableOffset")} for row in rows[-2:]]
            raise Unsupported(f"unrecognized native scope opcode {hex(code)} at {start}; context={context}")
    raise Unsupported("native scope tree terminator missing")


def scope_snapshots(container, templates):
    results, previous_footer, ordinal = [], None, 0
    for snapshot in container.snapshots:
        if len(snapshot["scopes"]) != 1:
            raise Unsupported("multi-page native scope snapshots are not implemented")
        raw = container.block(snapshot["scopes"][0], "x")
        state = {}
        rows = native_scopes(raw, templates, virtual_base=ordinal << 20,
                             previous_footer=previous_footer, metadata=state)
        previous_footer = state["footerAddress"]
        results.append(rows)
        ordinal += 1
    return results


def native_declarations(filename):
    from fsdb_variables import variable_groups
    container = Container(filename)
    templates = parse_templates(template_bytes(container))
    scopes = [row for snapshot in scope_snapshots(container, templates) for row in snapshot]
    groups = variable_groups(container)
    signals, hidden_signals, referenced, atoms_cache = [], [], set(), {}
    for scope in scopes:
        start = scope["variableOffset"]
        if start is None:
            continue
        if start not in groups:
            raise Unsupported("native scope variable pointer is not a decoded list start: " + str(start))
        referenced.add(start)
        key = scope["template"]
        if key is not None and key not in atoms_cache:
            atoms_cache[key] = atom_variables(templates, key)
        variables = atoms_cache[key] if key is not None else []
        for record in groups[start]:
            if record["kind"] == "literal":
                if record["placeholder"]:
                    hidden_signals.append({**record, "scope": scope["fullname"]})
                    continue  # Generated non-VAR placeholder, not a name filter.
                variable = record
            else:
                ordinal = record["variableIndex"]
                if ordinal >= len(variables):
                    raise Unsupported("native variable records exceed template slots in " + scope["fullname"])
                variable = variables[ordinal]
            signals.append({**variable, "nativeId": record["nativeId"], "scope": scope["fullname"],
                            "fullname": scope["fullname"] + "." + variable["name"]})
    if groups.keys() - referenced:
        raise Unsupported("unreferenced native variable lists remain: " + str(len(groups.keys() - referenced)))
    return {"signals": signals, "hiddenSignals": hidden_signals, "scopes": scopes, "templates": templates,
            "scope": "native snapshot declarations, optional parameter suffixes; opaque scope metadata retained"}
