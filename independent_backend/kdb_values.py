# SPDX-License-Identifier: MPL-2.0
"""Read source declarations for verified KDB value object kinds."""
import re
from dataclasses import dataclass, field

from kdb_lexical import LexicalScopes
from kdb_parameters import ParameterSets
from kdb_port_tokens import PortTokens
from kdb_records import Unsupported

# Bits 8–14 carry the source document index, including the extended index
# marker 127. Compare layout tags independently of the declaration's file.
TYPE_HEADER_MASK = 0xFFFF80FF
ENUM_TYPE = 0x40000048
STRUCT_TYPE = 0x20000048
UNION_TYPE = 0x30000048
LOGIC_TYPEDEF = 0x50000048
IMPORTED_TYPES = (0x60000048, 0x60200048)
TYPE_PARAMETER_MASK = 0x00FF00FF
TYPE_PARAMETER = 0x00400039


VARIABLE_TYPES = {
    2: ("npiReg", 1),
    3: ("npiIntegerVar", 32),
    5: ("npiRealVar", 64),
    7: ("npiReg", 1),
    8: ("npiBitVar", 1),
    12: ("npiIntVar", 32),
}
INTEGER_OPERATIONS = {
    0x0E0123: "add",
    0x0F0123: "subtract",
    0x100123: "multiply",
    0x110123: "divide",
    0x120123: "modulo",
    0x130123: "equal",
    0x140123: "not equal",
    0x170123: "logical and",
    0x180123: "logical or",
    0x1A0123: "less than",
    0x1C0123: "greater than",
    0x1D0123: "greater or equal",
    0x1E0123: "and",
    0x1F0123: "or",
    0x210123: "left shift",
    0x220123: "right shift",
    0x300123: "power",
    0x350123: "arithmetic right shift",
}
INTEGER_PARAMETER_WIDTHS = {1: 32, 7: 1, 8: 1, 12: 32}


@dataclass
class ConstantFrame:
    view: object
    values: dict
    ranges: dict
    structures: dict
    defined_bits: dict = field(default_factory=dict)
    steps: int = 4096


class ValueObjects:
    def __init__(self, session):
        self.session = session
        self.declarations = {}
        self.paramsets = None
        self.parameter_references = {}
        self.integer_parameters = {}
        self.port_tokens = PortTokens(session)
        self.function_arguments = []
        self.packages = {row["scopeKey"]: row["fullname"] for row in session.rows.values()
                         if row["kind"] == "npiPackage"}

    def parameter_reference(self, owner):
        master = owner.get("masterRecord")
        if master is None:
            return 0
        if master not in self.parameter_references:
            unit, key = self.session.masters[master]["variantSource"]
            reference = 0
            if unit and key:
                view = self.session.objects.view(unit)
                if view.read(key, "<I")[0] & 255 == 81:
                    reference = view.read(key + 56, "<Q")[0]
            self.parameter_references[master] = reference
        return self.parameter_references[master]

    def parameter(self, owner, view, key, header, depth=0):
        tag, dtype = header & 255, header >> 16 & 255
        untyped = self.untyped_parameter_bits(owner, key, header)
        if untyped is not None:
            data, signed = untyped
            return len(data), signed, data
        if (tag == 57 and dtype in INTEGER_PARAMETER_WIDTHS
              or header & 0x1FFFFFFF == 0x010C013A):
            width = INTEGER_PARAMETER_WIDTHS[dtype]
            value, signed = self.integer_parameter(owner, view, key, header, depth)
            return width, signed, f"{value & ((1 << width) - 1):0{width}b}"
        if self.is_enum_parameter(owner, view, key, header):
            value, signed, width = self.enum_parameter(owner, view, key, depth + 1)
            return width, signed, f"{value & ((1 << width) - 1):0{width}b}"
        if header & TYPE_HEADER_MASK == 0x010F003A:
            bits = self.packed_parameter(owner, view, key, depth + 1)
            return len(bits), 0, bits
        entry = self.parameter_entry(owner, key)
        flags, value_kind, payload, aux, trailer = entry or (0, 0, None, 0, 0)
        if entry and (flags != 1 or aux or trailer):
            raise Unsupported("unverified KDB parameter value flags")
        if tag == 58 and dtype == 7 and value_kind == 5 and isinstance(payload, str):
            left, right = self.range_bounds(owner, view, view.pointer(key + 56))
            width = abs(left - right) + 1
            payload = payload.lower()
            if len(payload) != width or any(bit not in "01xz" for bit in payload):
                raise Unsupported("elaborated KDB bit-vector width or encoding mismatch")
            return width, (header >> 28) & 1, payload
        if tag == 57 and dtype == 32 and value_kind == 4 and isinstance(payload, str):
            return 8 * len(payload.encode("utf-8")), 0, payload
        raise Unsupported("unverified KDB parameter width/sign encoding")

    def parameter_entry(self, owner, key):
        if self.paramsets is None:
            self.paramsets = ParameterSets(self.session.objects.directory)
        return self.paramsets.lookup(self.parameter_reference(owner), owner["scopeKey"], key)

    def untyped_parameter_bits(self, owner, key, header):
        if header & TYPE_HEADER_MASK != 0x40010039:
            return None
        entry = self.parameter_entry(owner, key)
        if entry is None:
            return None
        flags, kind, data, aux, trailer = entry
        if kind not in (5, 0x1000005):
            return None
        if (flags != 1 or aux or trailer or not isinstance(data, str)
                or not 0 < len(data) <= 1_048_576 or set(data) - {"0", "1", "x", "z"}):
            raise Unsupported("unverified KDB untyped parameter storage")
        return data, kind >> 24

    @staticmethod
    def integer_32(value, signed):
        return ValueObjects.integer_bits(value, signed, 32)

    @staticmethod
    def integer_bits(value, signed, width):
        value &= (1 << width) - 1
        return value - (1 << width) if signed and value >= 1 << (width - 1) else value

    def integer_parameter(self, owner, view, key, header, depth):
        # Generate blocks have their own elaboration entries. References
        # to declarations in the enclosing module use its variant instead.
        if header & 0x1FFFFFFF == 0x010C013A:
            lexical_owner = view.pointer(key + 56)
            while (owner["kind"] in ("npiGenScope", "npiNamedBegin")
                   and self.source_scope(owner, view) != lexical_owner):
                owner = self.session.node(owner["parent"])
            if owner["kind"] != "npiGenScope":
                raise Unsupported("unverified KDB generated parameter owner")
        elif owner["kind"] == "npiGenScope" and header & 255 == 57:
            context = self.session.context(owner)
            if context and context["scopeKey"] == owner["scopeKey"]:
                _, _, members, _ = self.lookup(context["fullname"] + ".")
                name = view.string(view.pointer(key + 32))
                if members.get(name) == (key, header):
                    owner = context
        environment = (owner["fullname"] if owner["kind"] == "npiGenScope"
                       else self.parameter_reference(owner))
        identity = owner["scopeKey"], key, environment
        if identity in self.integer_parameters:
            return self.integer_parameters[identity]
        if depth > 32:
            raise Unsupported("KDB range expression depth exceeds budget")
        untyped = self.untyped_parameter_bits(owner, key, header)
        if untyped is not None:
            data, signed = untyped
            if len(data) > 32 or set(data) - {"0", "1"}:
                raise Unsupported("unverified KDB untyped integer parameter value")
            result = self.integer_bits(int(data, 2), signed, len(data)), signed
            self.integer_parameters[identity] = result
            return result
        entry = self.parameter_entry(owner, key)
        width = INTEGER_PARAMETER_WIDTHS[header >> 16 & 255]
        signed = int(width == 32 and not header & 0x20000000)
        if entry is None:
            initializer = view.pointer(key + 48)
            if initializer is None:
                raise Unsupported("KDB integer parameter initializer is missing")
            payload, _ = self.integer_expression(owner, view, initializer, depth + 1)
        else:
            flags, kind, payload, aux, trailer = entry
            if kind == 5 and isinstance(payload, str):
                if len(payload) != width or not all(bit in "01" for bit in payload):
                    raise Unsupported("unverified KDB integer bit-string parameter")
                payload = int(payload, 2)
                kind = 1
            if (flags != 1 or kind not in (1, 0x1000001) or aux or trailer
                    or not 0 <= payload < 1 << width):
                raise Unsupported("unverified elaborated KDB integer parameter")
        result = self.integer_32(payload & ((1 << width) - 1), signed), signed
        self.integer_parameters[identity] = result
        return result

    @staticmethod
    def source_scope(owner, view):
        owner_key = owner["sourceKey"]
        owner_kind = view.read(owner_key, "<I")[0] & 255
        if owner_kind == 81:
            owner_key = view.pointer(owner_key + 72)
            owner_kind = view.read(owner_key, "<I")[0] & 255
        if owner_kind == 46:
            owner_key = view.pointer(owner_key + 8)
        return owner_key

    def lookup(self, query):
        owner_name, dot, value_name = query.rpartition(".")
        if not dot:
            raise Unsupported("KDB value requires a scope")
        owner = self.session.node(owner_name)
        unit = owner["scopeKey"]
        view = self.session.objects.view(unit)
        owner_key = self.source_scope(owner, view)
        owner_kind = view.read(owner_key, "<I")[0] & 255
        if owner_kind in (31, 32):
            declaration_slots = (64, 128)
        elif owner_kind == 66 and owner["kind"] == "npiGenScope":
            declaration_slots = (104, 112)
        elif owner_kind == 66 and owner["kind"] == "npiNamedBegin":
            declaration_slots = (104,)
        else:
            raise Unsupported("unverified value scope type")
        cache_key = unit, owner_key
        if cache_key not in self.declarations:
            members = {}
            for offset in declaration_slots:
                for key in LexicalScopes.chain(view, view.pointer(owner_key + offset)):
                    header = view.read(key, "<I")[0]
                    if not 51 <= header & 255 <= 58:
                        raise Unsupported("unverified source value declaration")
                    name = view.string(view.pointer(key + 32))
                    if name in members:
                        raise Unsupported("ambiguous source value declaration")
                    members[name] = key, header
            self.declarations[cache_key] = members
        return owner, view, self.declarations[cache_key], value_name

    @staticmethod
    def immediate_range(view, key):
        if key is None:
            raise Unsupported("KDB value dimension is missing")
        header = view.read(key, "<I")[0]
        if header & TYPE_HEADER_MASK == 0x27:
            return view.read(key + 4, "<HH")
        if header & 0x80FF != 0x26:
            raise Unsupported("unverified KDB value dimension encoding")
        left, right = header >> 16 & 255, header >> 24
        return left, right

    @staticmethod
    def operand_list(view, key, arity, slot=24):
        operands = []
        limit = arity if arity is not None else 65
        for wrapper in LexicalScopes.chain(view, view.pointer(key + slot)):
            if view.read(wrapper, "<I")[0] & 0xFFFFFF != 26 or len(operands) == limit:
                raise Unsupported("unverified KDB expression operand")
            operands.append(view.pointer(wrapper + 16))
        if (arity is not None and len(operands) != arity) or None in operands:
            raise Unsupported("unverified KDB expression arity")
        return operands

    @staticmethod
    def expression_tag(view, key):
        header = view.read(key, "<I")[0]
        return (header & TYPE_HEADER_MASK) | 0x100 if header & 255 == 0x23 else header

    @classmethod
    def operands(cls, view, key):
        right, left = cls.operand_list(view, key, 2)
        return left, right

    def package_symbol(self, view, key, header, member_headers):
        link = view.read(key + 16, "<Q")[0]
        unit = link >> 48
        package = self.packages.get(unit)
        if not package or (link >> 32) & 0xFFFF != 0xFFFF or not link & 0xFFFFFFFF:
            raise Unsupported("unverified KDB package parameter link")
        name = view.string(view.pointer(key + 24))
        if header in (0x2403013C, 0x3403013C):
            member = view.pointer(key + 40)
            if (name != package or member is None
                    or view.read(member, "<I")[0] not in member_headers
                    or view.read(member + 16, "<Q")[0] != link
                    or view.pointer(member + 32) != key):
                raise Unsupported("unverified KDB qualified package parameter")
            name = view.string(view.pointer(member + 24))
        return package, name

    def package_integer(self, view, key, header, depth):
        package, name = self.package_symbol(view, key, header, (0x2011013C, 0x2004013C))
        target, target_view, members, name = self.lookup(package + "." + name)
        if name not in members:
            return self.package_enum(target, target_view, name, depth + 1)
        target_key, target_header = members[name]
        if target_header & TYPE_HEADER_MASK in (0x0107003A, 0x4107003A):
            return self.logic_parameter_integer(target, target_view, target_key, target_header, depth + 1)
        if target_header & 255 != 57 or target_header >> 16 & 255 not in INTEGER_PARAMETER_WIDTHS:
            raise Unsupported("unverified KDB package parameter datatype")
        return self.integer_parameter(target, target_view, target_key, target_header, depth + 1)

    def aggregate_field(self, owner, view, key, header, depth):
        if header in (0x2403013C, 0x3403013C):
            link = view.read(key + 16, "<Q")[0]
            package = self.packages.get(link >> 48)
            if package is None or view.string(view.pointer(key + 24)) != package:
                return None
            term = view.pointer(key + 40)
            if (term is None or view.read(term, "<I")[0] != 0x2011013C
                    or view.pointer(term + 32) != key):
                return None
            key = term
        elif header not in (0x0011013C, 0x1011013C):
            return None
        member = view.pointer(key + 40)
        if member is None or view.read(member, "<I")[0] != 0x2004013C or view.pointer(member + 32) != key:
            return None
        if view.pointer(member + 40) is not None:
            raise Unsupported("unverified nested KDB aggregate field")
        unit = view.read(key + 16, "<Q")[0] >> 48
        aggregate_name = view.string(view.pointer(key + 24))
        if unit:
            package = self.packages.get(unit)
            if not package:
                raise Unsupported("unverified KDB aggregate package link")
            container, source, declarations, _ = self.lookup(package + "." + aggregate_name)
        else:
            container, source, declarations, _ = self.lookup(owner["fullname"] + "." + aggregate_name)
        declaration = view.pointer(key + 48, source)
        reference = declarations.get(aggregate_name)
        if declaration is None or not reference or reference[0] != declaration:
            raise Unsupported("unverified KDB aggregate declaration reference")
        declaration_header = reference[1] & TYPE_HEADER_MASK
        if declaration_header not in (0x010F003A, 0x020F003A, 0x410F003A):
            raise Unsupported("unverified KDB aggregate parameter shape")
        entry = self.parameter_entry(container, declaration)
        initializer = source.pointer(declaration + 48)
        array = declaration_header == 0x020F003A
        if array:
            if entry is not None:
                raise Unsupported("unverified elaborated KDB array of structures")
            reference = view.pointer(key + 56)
            if reference is None:
                raise Unsupported("unverified KDB aggregate index reference")
            ref_header = self.expression_tag(view, reference)
            if ref_header == 0x240123:
                subscript, base = self.operand_list(view, reference, 2)
                if base != key:
                    raise Unsupported("KDB aggregate index base differs")
                index, _ = self.integer_expression(owner, view, subscript, depth + 1)
            elif ref_header & 0xFFFF == 0x124 and view.pointer(reference + 8) == view.pointer(reference + 16) == key:
                index = view.read(reference + 2, "<h")[0]
            else:
                raise Unsupported("unverified KDB aggregate index reference")
            left, right = self.range_bounds(container, source, source.pointer(declaration + 56))
            if not min(left, right) <= index <= max(left, right):
                raise Unsupported("KDB aggregate index outside declaration range")
            values = self.positional_pattern(source, initializer)
            if len(values) != abs(left - right) + 1:
                raise Unsupported("KDB aggregate initializer length differs")
            initializer = values[abs(index - left)]
        elif view.pointer(key + 56) is not None:
            raise Unsupported("unverified KDB aggregate index")
        type_key = source.pointer(declaration + (64 if array else 56))
        type_owner, type_view, type_key = self.type_definition(container, source, type_key)
        if type_view.read(type_key, "<I")[0] & TYPE_HEADER_MASK != STRUCT_TYPE:
            raise Unsupported("KDB aggregate field owner is not a packed structure")
        field_key = view.pointer(member + 48, type_view)
        fields = list(LexicalScopes.chain(type_view, type_view.pointer(type_key + 48)))
        fields = fields[1:] + fields[:1]
        if field_key not in fields or type_view.pointer(field_key + 40) != type_key:
            raise Unsupported("unverified KDB field declaration reference")
        if type_view.string(type_view.pointer(field_key + 32)) != view.string(view.pointer(member + 24)):
            raise Unsupported("KDB aggregate field names differ")
        width, signed = self.integer_field(type_owner, type_view, field_key)
        name = type_view.string(type_view.pointer(field_key + 32))
        if entry is not None:
            flags, storage, bits, auxiliary, trailer = entry
            schema = self.structure_layout(type_owner, type_view, type_key)
            size = sum(length for _, _, length in schema.values())
            if (flags != 1 or storage not in (5, 0x305) or auxiliary or trailer or not isinstance(bits, str)
                    or len(bits) != size or set(bits) - {"x", "z", "0", "1"}):
                raise Unsupported("unverified elaborated KDB aggregate initializer")
            offset, _, _ = schema[field_key]
            digits = bits[size - offset - width:size - offset]
            if set(digits) - {"0", "1"}:
                raise Unsupported("KDB aggregate field has an indeterminate integer value")
            value = int(digits, 2)
        elif initializer is not None and source.read(initializer, "<I")[0] == 0x2B0123:
            packed, _ = self.constant_function(container, source, initializer, depth + 1,
                                               structure=(type_view, type_key))
            schema = self.structure_layout(type_owner, type_view, type_key)
            offset = schema[field_key][0]
            value = packed >> offset
        else:
            values = self.positional_pattern(source, initializer)
            expression = self.pattern_field(source, values, name, fields.index(field_key), len(fields))
            value, _ = self.integer_expression(container, source, expression, depth + 1)
        return self.integer_bits(value, signed, width), signed

    def positional_pattern(self, view, key):
        if key is None or view.read(key, "<I")[0] != 0x9B0123:
            raise Unsupported("unverified KDB assignment pattern")
        nodes = self.operand_list(view, key, None)
        return nodes[1:] + nodes[:1]

    def pattern_field(self, view, values, name, index, count):
        if not values:
            raise Unsupported("KDB packed structure has no initializer entries")
        if view.read(values[0], "<I")[0] != 0x530123:
            if len(values) != count:
                raise Unsupported("KDB packed structure initializer field count differs")
            return values[index]
        found = {}
        for item in values:
            if view.read(item, "<I")[0] != 0x530123:
                raise Unsupported("mixed KDB packed structure initializer entries")
            value, field = self.operand_list(view, item, 2)
            if (view.read(field, "<I")[0] != 0x1004013C
                    or view.pointer(field + 32) != item):
                raise Unsupported("unverified KDB initializer field reference")
            field_name = view.string(view.pointer(field + 24))
            if field_name in found:
                raise Unsupported("duplicate KDB structure initializer field")
            found[field_name] = value
        if name not in found:
            raise Unsupported("KDB packed structure initializer field is missing")
        return found[name]

    def package_enum(self, owner, view, name, depth):
        root = self.source_scope(owner, view)
        matches = []
        for key in LexicalScopes.chain(view, view.pointer(root + 200)):
            if view.read(key, "<I")[0] & TYPE_HEADER_MASK != ENUM_TYPE:
                continue
            for item in LexicalScopes.chain(view, view.pointer(key + 48)):
                if view.string(view.pointer(item + 32)) == name:
                    matches.append(item)
        if len(matches) != 1:
            raise Unsupported("KDB package parameter or enumeration declaration not found")
        return self.enum_item(owner, view, matches[0], depth)

    def enum_item(self, owner, view, key, depth):
        typedef = view.pointer(key + 40)
        if typedef is None or view.read(typedef, "<I")[0] & TYPE_HEADER_MASK != ENUM_TYPE:
            raise Unsupported("unverified KDB enumeration item owner")
        items = list(LexicalScopes.chain(view, view.pointer(typedef + 48)))
        category, width, _ = self.packed_type(owner, view, typedef)
        signed = self.enum_signedness(view.read(typedef + 28, "<I")[0])
        if category != "Enum" or not 0 < width <= 32:
            raise Unsupported("unverified KDB enumeration item width")
        value, negative_cast = -1, False
        for ordinal, item in enumerate(items[1:] + items[:1], 1):
            if view.read(item, "<II") != (0x14A, ordinal) or view.pointer(item + 40) != typedef:
                raise Unsupported("unverified KDB enumeration item layout")
            initializer = view.pointer(item + 48)
            if initializer is None:
                previous = value
                value += 1
                if negative_cast and previous < 0:
                    # NPI continues from the signed cast value and exposes the
                    # result using the previous item's minimum signed width.
                    implicit_width = (~previous).bit_length() + 1
                    if item == key:
                        return self.integer_bits(value, False, implicit_width), 0
            else:
                value, expression_signed = self.integer_expression(owner, view, initializer, depth + 1)
                negative_cast = (not signed and expression_signed and value < 0
                                 and self.expression_tag(view, initializer) == 0xC80123)
                if negative_cast and item == key:
                    return value, 1
            if not negative_cast:
                value &= (1 << width) - 1
            if item == key:
                return self.integer_bits(value, signed, width), signed
        raise Unsupported("KDB enumeration item is outside its type")

    def is_enum_parameter(self, owner, view, key, header):
        layout = header & TYPE_HEADER_MASK
        return (layout == 0x410F003A or
                (layout == 0x020F003A and owner["kind"] == "npiGenScope"
                 and view.read(key + 28, "<I")[0] in (0x3200, 0x3201, 0x3204)))

    def enum_parameter(self, owner, view, key, depth):
        layout = view.read(key, "<I")[0] & TYPE_HEADER_MASK
        if layout == 0x410F003A and owner["kind"] in ("npiGenScope", "npiNamedBegin"):
            name = view.string(view.pointer(key + 32))
            while True:
                scope, source, members, _ = self.lookup(owner["fullname"] + "." + name)
                if source is not view:
                    raise Unsupported("KDB enumeration parameter arena differs from its scope")
                if members.get(name, (None,))[0] == key:
                    owner = scope
                    break
                if owner["kind"] not in ("npiGenScope", "npiNamedBegin"):
                    raise Unsupported("KDB enumeration parameter declaration scope not found")
                owner = self.session.node(owner["parent"])
        slot = 56
        if layout == 0x020F003A:
            lexical_owner = view.pointer(key + 56)
            if self.source_scope(owner, view) != lexical_owner:
                raise Unsupported("unverified KDB generated enumeration owner")
            slot = 64
        typedef = view.pointer(key + slot)
        category, width, dimensions = self.packed_type(owner, view, typedef)
        if not category and dimensions and 0 < width <= 32:
            bits = self.packed_parameter(owner, view, key, depth + 1, typedef=typedef)
            if set(bits) - {"0", "1"}:
                raise Unsupported("KDB packed logic parameter is not an integer")
            return int(bits, 2), 0, width
        if category != "Enum" or not 0 < width <= 32:
            raise Unsupported("unverified KDB enumeration parameter width")
        _, definition_view, definition = self.type_definition(owner, view, typedef)
        base = definition_view.read(definition + 28, "<I")[0]
        signed = self.enum_signedness(base)
        entry = self.parameter_entry(owner, key)
        if entry is None:
            value, _ = self.integer_expression(owner, view, view.pointer(key + 48), depth + 1)
        else:
            flags, kind, value, aux, trailer = entry
            if flags != 1 or aux or trailer:
                raise Unsupported("unverified KDB enumeration parameter metadata")
            if kind & 0xFFFFFF == 5 and isinstance(value, str) and len(value) == width and set(value) <= {"0", "1"}:
                value = int(value, 2)
            elif (kind not in (1, 0x1000001) or not isinstance(value, int)
                  or not 0 <= value < 1 << width):
                raise Unsupported("unverified KDB enumeration parameter storage")
        value &= (1 << width) - 1
        if signed and value >= 1 << (width - 1):
            value -= 1 << width
        return value, signed, width

    def packed_parameter(self, owner, view, key, depth, *, typedef=None):
        if typedef is None:
            typedef = view.pointer(key + 56)
        category, width, dimensions = self.packed_type(owner, view, typedef)
        if category or not dimensions or not 0 < width <= 1_048_576:
            raise Unsupported("unverified KDB packed logic parameter")
        _, target, type_key = self.type_definition(owner, view, typedef)
        if target.read(type_key + 28, "<I")[0] & 0xFFFF0000:
            raise Unsupported("unverified KDB packed logic parameter signedness")
        entry = self.parameter_entry(owner, key)
        if entry is None:
            initializer = view.pointer(key + 48)
            if initializer is not None and view.read(initializer, "<II") == (0xAA0228, 0):
                fill = view.string(view.pointer(initializer + 16)).lower()
                if fill in ("0", "1", "x", "z"):
                    return fill * width
            value, _ = self.integer_expression(owner, view, initializer, depth + 1)
            return f"{value & ((1 << width) - 1):0{width}b}"
        flags, kind, data, auxiliary, extra = entry
        if (flags != 1 or kind != 5 or auxiliary or extra or not isinstance(data, str)
                or len(data) != width or not set(data) <= {"0", "1", "x", "z"}):
            raise Unsupported("unverified KDB packed logic parameter storage")
        return data

    @staticmethod
    def enum_signedness(base):
        base &= 0xFFFF0000
        if base not in (0, 0x70000, 0x80000, 0x1070000, 0xC0000, 0x20C0000):
            raise Unsupported("unverified KDB enumeration parameter signedness")
        return int(base in (0, 0x1070000, 0xC0000))

    def constant_function(self, owner, view, call, depth, *, structure=None):
        operands = self.operand_list(view, call, None)
        if len(operands) < 2:
            raise Unsupported("unverified KDB constant function argument list")
        identifier = operands[1]
        arguments = operands[2:] + operands[:1]
        identifier_header = view.read(identifier, "<I")[0]
        local_call = identifier_header & 255 == 64
        if local_call:
            scope = owner["fullname"]
            name = view.string(view.pointer(identifier + 40))
        elif identifier_header in (0x0013013C, 0x1013013C, 0x2403013C, 0x3403013C):
            scope, name = self.package_symbol(view, identifier, identifier_header, (0x2013013C,))
        else:
            raise Unsupported("unverified KDB constant function link")
        function = self.session.node(scope + "." + name)
        target_view = self.session.objects.view(function["scopeKey"])
        key = function["sourceKey"]
        if local_call and (target_view is not view or key != identifier):
            raise Unsupported("KDB constant function link resolves to a different declaration")
        if identifier_header == 0x1013013C and view.pointer(identifier + 48, target_view) != key:
            raise Unsupported("KDB imported function link resolves to a different declaration")
        header = target_view.read(key, "<I")[0] & TYPE_HEADER_MASK
        allowed = (0x41030040, 0x410C0040, 0x610C0040, 0x410F0040) if structure is None else (0x410F0040,)
        if function["kind"] != "npiFunction" or header not in allowed:
            raise Unsupported("unverified KDB constant function declaration")
        signed = int(not header & 0x20000000)
        declaration_list = list(LexicalScopes.chain(target_view, target_view.pointer(key + 96)))
        declarations = declaration_list[1:] + declaration_list[:1]
        formals = [declaration for declaration in declarations if target_view.read(declaration, "<I")[0] & 255 == 56]
        if len(formals) != len(arguments):
            raise Unsupported("unverified KDB constant function formal count")
        results = [declaration for declaration in declarations
                   if target_view.read(declaration, "<I")[0] & 255 == 55
                   and target_view.string(target_view.pointer(declaration + 32)) == name]
        if len(results) != 1:
            raise Unsupported("unverified KDB constant function result declaration")
        statement = target_view.pointer(key + 112)
        if statement is None:
            raise Unsupported("unverified KDB constant function body")
        bindings = {results[0]: (None, signed)}
        shapes = {}
        type_owner = self.session.node(scope)
        for formal, argument in zip(formals, arguments):
            formal_header = target_view.read(formal, "<I")[0] & TYPE_HEADER_MASK
            formal_flags = target_view.read(formal + 28, "<I")[0]
            port_input = target_view.read(formal + 64, "<I")[0] == 0x820000
            input_formal = formal_flags == 0x8200 or (formal_flags in (0x8300, 0x18300) and port_input)
            enum_formal = formal_header == 0x020F0038 and (
                formal_flags == 0x9200 or (formal_flags == 0x19300
                                          and target_view.read(formal + 64, "<I")[0] == 0x820000))
            scalar_formal = formal_header in (0x01030038, 0x01070038, 0x010C0038, 0x210C0038) and input_formal
            if target_view.pointer(formal + 72) != key or not (scalar_formal or enum_formal):
                raise Unsupported("unverified KDB constant function formal")
            value, _ = self.integer_expression(owner, view, argument, depth + 1)
            if enum_formal:
                type_key = target_view.pointer(formal + 80)
                kind, width, shape = self.packed_type(type_owner, target_view, type_key)
                _, enum_view, enum_key = self.type_definition(type_owner, target_view, type_key)
                if not 0 < width <= 32:
                    raise Unsupported("unverified KDB constant function packed formal width")
                if kind == "Enum":
                    formal_signed = self.enum_signedness(enum_view.read(enum_key + 28, "<I")[0])
                elif not kind:
                    if len(shape) != 1 or enum_view.read(enum_key + 28, "<I")[0] & 0xFFFF0000:
                        raise Unsupported("unverified KDB constant function vector formal")
                    shapes[formal] = shape[0]
                    formal_signed = 0
                else:
                    raise Unsupported("unverified KDB constant function packed formal")
                value &= (1 << width) - 1
                if formal_signed and value >= 1 << (width - 1):
                    value -= 1 << width
                bindings[formal] = value, formal_signed
            elif formal_header == 0x01070038:
                bindings[formal] = value & 1, 0
            else:
                formal_signed = int(not formal_header & 0x20000000)
                bindings[formal] = self.integer_32(value, formal_signed), formal_signed
        frame = ConstantFrame(target_view, bindings, shapes, {})
        vector_result = header == 0x410F0040 and structure is None
        if vector_result:
            self.function_vector(type_owner, target_view, frame, results[0], key)
        if structure is not None:
            decl = target_view.pointer(key + 64)
            if (target_view, decl) != structure:
                raise Unsupported("KDB constant function return type differs")
            frame.structures[results[0]] = self.structure_layout(type_owner, target_view, decl)
        self.function_arguments.append(frame)
        try:
            for node in declarations:
                if node not in bindings and node != results[0]:
                    if (vector_result and target_view.read(node, "<I")[0] & TYPE_HEADER_MASK == 0x020F0037
                            and target_view.pointer(node + 56) == key):
                        self.function_vector(type_owner, target_view, frame, node, key)
                    elif (structure is not None and target_view.read(node, "<I")[0] & TYPE_HEADER_MASK == 0x020F0037
                            and target_view.pointer(node + 56) == key):
                        decl = target_view.pointer(node + 64)
                        frame.structures[node] = self.structure_layout(type_owner, target_view, decl)
                        bindings[node] = None, 0
                    else:
                        self.function_local(type_owner, target_view, node, key, bindings, depth + 1)
            returned = self.function_body(type_owner, target_view, statement, key, depth + 1)
            result, _ = returned if returned is not None else self.function_binding(frame, results[0])
            if result is None:
                raise Unsupported("KDB constant function did not return a value")
        finally:
            self.function_arguments.pop()
        if vector_result:
            left, right = frame.ranges[results[0]]
            return self.integer_bits(result, False, abs(left - right) + 1), 0
        return (result, 0) if structure is not None else (self.integer_32(result, signed), signed)

    def function_vector(self, owner, view, frame, declaration, parent):
        if view.pointer(declaration + 56) != parent:
            raise Unsupported("unverified KDB constant function vector owner")
        typedef = view.pointer(declaration + 64)
        category, width, shape = self.packed_type(owner, view, typedef)
        _, target, type_key = self.type_definition(owner, view, typedef)
        if category or len(shape) != 1 or width > 32 or target.read(type_key + 28, "<I")[0] & 0xFFFF0000:
            raise Unsupported("unverified KDB constant function vector declaration")
        frame.ranges[declaration] = shape[0]
        frame.values[declaration] = 0, 0
        frame.defined_bits[declaration] = 0

    @staticmethod
    def function_binding(frame, declaration):
        value, signed = frame.values[declaration]
        if declaration in frame.defined_bits:
            left, right = frame.ranges[declaration]
            if frame.defined_bits[declaration] != (1 << (abs(left - right) + 1)) - 1:
                raise Unsupported("KDB constant function vector has uninitialized bits")
        if value is None:
            raise Unsupported("uninitialized KDB constant function result")
        return value, signed

    def bit_offset(self, owner, view, subscript, shape, depth):
        index, _ = self.integer_expression(owner, view, subscript, depth + 1)
        left, right = shape
        if not min(left, right) <= index <= max(left, right):
            raise Unsupported("KDB constant bit index outside packed bounds")
        return abs(index - right)

    def integer_field(self, owner, view, field):
        header = view.read(field, "<I")[0]
        dtype = header >> 16 & 255
        if dtype in (3, 12):
            return 32, int(not header & 0x20000000)
        if dtype == 7:
            packed = bool(header & 0x02000000)
            width = self.dimension_width([self.range_bounds(owner, view, view.pointer(field + 48))]) if packed else 1
            if width <= 32:
                return width, int(bool(header & 0x40000000))
        if dtype == 15:
            type_ref = view.pointer(field + 48)
            kind, width, dimensions = self.packed_type(owner, view, type_ref)
            _, target, definition = self.type_definition(owner, view, type_ref)
            base = target.read(definition + 28, "<I")[0]
            if width <= 32:
                if kind == "Enum" and not dimensions:
                    return width, self.enum_signedness(base)
                if not kind and dimensions and not base & 0xFFFF0000:
                    return width, 0
        raise Unsupported("unverified KDB integer field datatype")

    def structure_layout(self, owner, view, key):
        if key is None or view.read(key, "<I")[0] & TYPE_HEADER_MASK != STRUCT_TYPE:
            raise Unsupported("unverified KDB constant function structure")
        fields = list(LexicalScopes.chain(view, view.pointer(key + 48)))
        if not fields or len(fields) > 128:
            raise Unsupported("KDB constant function structure field count exceeds budget")
        layout, offset = {}, 0
        for field in fields[:1] + list(reversed(fields[1:])):
            header = view.read(field, "<I")[0]
            if header & 255 != 73 or view.pointer(field + 40) != key:
                raise Unsupported("unverified KDB constant function structure field")
            width, signed = self.integer_field(owner, view, field)
            layout[field] = offset, signed, width
            offset += width
        return layout

    @staticmethod
    def function_field(frame, view, key):
        if frame.view is not view or view.read(key, "<I")[0] != 0x0031013E:
            return None
        structure = view.pointer(key + 48)
        member = view.pointer(key + 40)
        if (structure not in frame.structures or member is None
                or view.read(member, "<I")[0] != 0x2004013E or view.pointer(member + 32) != key):
            raise Unsupported("unverified KDB local structure field reference")
        field = view.pointer(member + 48)
        element = frame.structures[structure].get(field)
        if element is None or view.string(view.pointer(field + 32)) != view.string(view.pointer(member + 24)):
            raise Unsupported("unverified KDB local structure field")
        return structure, *element

    def function_local(self, owner, view, key, parent, bindings, depth):
        header, flags = view.read(key, "<I")[0] & TYPE_HEADER_MASK, view.read(key + 28, "<I")[0]
        if (header not in (0x010C0037, 0x210C0037, 0x01030037) or view.pointer(key + 56) != parent
                or flags not in (0x8200, 0x8260, 0x18300, 0x18360)):
            raise Unsupported("unverified KDB local constant function variable")
        initial = key + 64
        if view.read(initial, "<Q")[0] == 11:
            if (view.string(view.pointer(initial + 8)) != "regDeclAss"
                    or view.pointer(initial + 40) != key):
                raise Unsupported("unverified KDB local initializer property")
            assignment = view.pointer(initial + 32)
            if (assignment is None or view.read(assignment, "<I")[0] != 0x144
                    or view.pointer(assignment + 8) != key):
                raise Unsupported("unverified KDB declaration assignment")
            initial = view.pointer(assignment + 32)
        if initial is None or self.expression_tag(view, initial) not in (0x10000328, 0x10010328, 0x2B0123):
            raise Unsupported("unverified KDB local variable initializer")
        value, _ = self.integer_expression(owner, view, initial, depth + 1)
        signed = int(not header & 0x20000000)
        bindings[key] = self.integer_32(value, signed), signed

    def function_body(self, owner, view, statement, parent, depth):
        statements = list(LexicalScopes.chain(view, statement))
        for item in statements[1:] + statements[:1]:
            result = self.function_statement(owner, view, item, parent, depth + 1)
            if result is not None:
                return result
        return None

    def function_loop(self, owner, view, key, depth):
        scope = view.pointer(key + 56)
        if scope is None or view.read(scope, "<II") != (0x142, 0xC0000002) or view.pointer(scope + 48) != key:
            raise Unsupported("unverified KDB for-loop scope")
        parts = list(LexicalScopes.chain(view, scope))
        if len(parts) != 3:
            raise Unsupported("unverified KDB for-loop statements")
        initialize, step = parts[1:]
        if view.read(initialize, "<II") != (0x143, 13) or view.read(step, "<II") != (0x143, 0x3A0039):
            raise Unsupported("unverified KDB for-loop initializer or step")
        local = view.pointer(scope + 104)
        update, = self.operand_list(view, step, 1, slot=96)
        if (local is None or view.pointer(local + 8) != local or view.read(update, "<I")[0] != 0x3A0123
                or self.operand_list(view, update, 1) != [local]):
            raise Unsupported("unverified KDB for-loop increment")
        frame = self.function_arguments[-1]
        bindings = frame.values
        local_header = view.read(local, "<I")[0] & TYPE_HEADER_MASK
        if local_header not in (0x010C0037, 0x210C0037) or view.pointer(local + 56) != scope:
            raise Unsupported("unverified KDB for-loop local")
        signed = int(not local_header & 0x20000000)
        bindings[local] = None, signed
        try:
            self.function_statement(owner, view, initialize, key, depth + 1)
            if bindings[local][0] is None:
                raise Unsupported("KDB for-loop initializer did not assign its index")
            condition, = self.operand_list(view, key, 1, slot=96)
            while self.integer_expression(owner, view, condition, depth + 1)[0]:
                frame.steps -= 1
                if frame.steps < 0:
                    raise Unsupported("KDB constant for-loop exceeds iteration budget")
                result = self.function_statement(owner, view, view.pointer(scope + 56), scope, depth + 1)
                if result is not None:
                    return result
                value, signed = bindings[local]
                bindings[local] = self.integer_32(value + 1, signed), signed
        finally:
            bindings.pop(local, None)
        return None

    def function_statement(self, owner, view, key, parent, depth):
        if depth > 32 or key is None or view.pointer(key + 48) != parent:
            raise Unsupported("unverified KDB constant function statement")
        header = view.read(key, "<I")[0]
        subtype = view.read(key + 4, "<I")[0]
        if header == 0x142 and subtype == 3:
            return self.function_body(owner, view, view.pointer(key + 56), key, depth + 1)
        if header != 0x143:
            raise Unsupported("unverified KDB constant function statement")
        if subtype == 55:
            expression, = self.operand_list(view, key, 1, slot=96)
            return self.integer_expression(owner, view, expression, depth + 1)
        if subtype == 13:
            expression, target = self.operand_list(view, key, 2, slot=96)
            frame = self.function_arguments[-1]
            bindings = frame.values
            if self.expression_tag(view, target) == 0x240123:
                subscript, vector = self.operand_list(view, target, 2)
                if vector not in frame.defined_bits:
                    raise Unsupported("unverified KDB constant bit assignment target")
                bit = self.bit_offset(owner, view, subscript, frame.ranges[vector], depth)
                value, _ = self.integer_expression(owner, view, expression, depth + 1)
                mask = 1 << bit
                previous, _ = bindings[vector]
                bindings[vector] = (previous & ~mask) | ((value & 1) << bit), 0
                frame.defined_bits[vector] |= mask
                return None
            field = self.function_field(frame, view, target)
            if field is not None:
                structure, offset, _, width = field
                previous, _ = bindings[structure]
                if previous is None:
                    raise Unsupported("uninitialized KDB constant function structure")
                value, _ = self.integer_expression(owner, view, expression, depth + 1)
                mask = ((1 << width) - 1) << offset
                bindings[structure] = (previous & ~mask) | ((value << offset) & mask), 0
                return None
            if target not in bindings or view.read(target, "<I")[0] & 255 != 55:
                raise Unsupported("unverified KDB constant assignment target")
            value, _ = self.integer_expression(owner, view, expression, depth + 1)
            _, signed = bindings[target]
            if target in frame.defined_bits:
                left, right = frame.ranges[target]
                mask = (1 << (abs(left - right) + 1)) - 1
                bindings[target] = value & mask, 0
                frame.defined_bits[target] = mask
            elif target in frame.structures:
                width = sum(size for _, _, size in frame.structures[target].values())
                bindings[target] = value & ((1 << width) - 1), 0
            else:
                bindings[target] = self.integer_32(value, signed), signed
            return None
        if subtype == 32:
            return self.function_loop(owner, view, key, depth + 1)
        if subtype == 26:
            condition, = self.operand_list(view, key, 1, slot=96)
            branches = list(LexicalScopes.chain(view, view.pointer(key + 56)))
            if len(branches) not in (1, 2):
                raise Unsupported("unverified KDB conditional statement branches")
            if self.integer_expression(owner, view, condition, depth + 1)[0]:
                return self.function_statement(owner, view, branches[-1], key, depth + 1)
            return self.function_statement(owner, view, branches[0], key, depth + 1) if len(branches) == 2 else None
        if subtype not in (27, 283):
            raise Unsupported("unverified KDB constant function body statement kind")
        selector, = self.operand_list(view, key, 1, slot=96)
        selector, _ = self.integer_expression(owner, view, selector, depth + 1)
        fallback = None
        cases = list(LexicalScopes.chain(view, view.pointer(key + 56)))
        if not cases or len(cases) > 1024:
            raise Unsupported("KDB constant case list exceeds budget")
        for case in cases[1:] + cases[:1]:
            if view.read(case, "<I")[0] != 0x143 or view.pointer(case + 48) != key:
                raise Unsupported("unverified KDB constant case item")
            body = view.pointer(case + 56)
            item_kind = view.read(case + 4, "<I")[0]
            if item_kind == 31 and fallback is None:
                fallback = body, case
            elif item_kind == 30:
                labels = self.operand_list(view, case, None, slot=96)
                if not labels:
                    raise Unsupported("KDB constant case item is missing labels")
                if any(self.integer_expression(owner, view, label, depth + 1)[0] == selector for label in labels):
                    return self.function_statement(owner, view, body, case, depth + 1)
            else:
                raise Unsupported("unverified KDB constant case label")
        if fallback:
            return self.function_statement(owner, view, *fallback, depth + 1)
        raise Unsupported("KDB constant function case has no match")

    def integer_builtin(self, owner, view, key, depth):
        argument, identifier = self.operand_list(view, key, 2)
        if view.read(identifier, "<Q")[0] != 27:
            raise Unsupported("unverified KDB integer function identifier")
        name = view.string(view.pointer(identifier + 24))
        if name == "$bits":
            header = self.expression_tag(view, argument)
            untyped = self.untyped_parameter_bits(owner, argument, header)
            if untyped is not None:
                return len(untyped[0]), 1
            if header & 255 == 57 and header >> 16 & 255 in INTEGER_PARAMETER_WIDTHS:
                return INTEGER_PARAMETER_WIDTHS[header >> 16 & 255], 1
            if header == 0x10000328:
                return 32, 1
            if header == 0x550123 and view.read(argument + 8, "<Q")[0] == 0x0F000000:
                type_key, = self.operand_list(view, argument, 1)
                _, width, _ = self.packed_type(owner, view, type_key)
                return width, 1
            if (header == 0x550123 and view.read(argument + 8, "<Q")[0] == 0x07000000
                    and view.pointer(argument + 24) is None):
                return 1, 1
            if header & 0xFFFF00FF == 0x4107003A:
                dimension = view.pointer(argument + 56)
                return self.dimension_width([self.range_bounds(owner, view, dimension)]), 1
            raise Unsupported(f"unverified KDB bits operand {header:#010x}")
        if name not in ("$clog2", "$signed", "$unsigned"):
            raise Unsupported(f"unverified KDB integer function {name}")
        value, _ = self.integer_expression(owner, view, argument, depth + 1)
        if name == "$clog2":
            value &= 0xFFFFFFFF
            return max(0, (value - 1).bit_length()) if value else 0, 1
        header = view.read(argument, "<I")[0]
        if header & 255 == 57 and INTEGER_PARAMETER_WIDTHS.get(header >> 16 & 255) != 32:
            raise Unsupported("unverified KDB integer function operand width")
        signed = int(name == "$signed")
        return self.integer_32(value, signed), signed

    @staticmethod
    def radix_integer(view, key, radix, signed):
        width = view.read(key + 4, "<I")[0]
        digits = view.string(view.pointer(key + 16))
        if not 0 < width <= 32 or not 0 < len(digits) <= 32:
            raise Unsupported("unverified KDB sized integer literal width")
        pattern = {2: r"[01]+", 8: r"[0-7]+", 10: r"[0-9]+", 16: r"[0-9a-fA-F]+"}[radix]
        if not re.fullmatch(pattern, digits):
            raise Unsupported("unverified KDB sized integer literal digits")
        value = int(digits, radix) & ((1 << width) - 1)
        if signed and value >= 1 << (width - 1):
            value -= 1 << width
        return value, signed

    def logic_parameter_integer(self, owner, view, key, header, depth):
        dimension = view.pointer(key + 56)
        width = self.dimension_width([self.range_bounds(owner, view, dimension)])
        if width > 32:
            raise Unsupported("unverified KDB packed logic integer parameter width")
        entry = self.parameter_entry(owner, key)
        if entry is None:
            initializer = view.pointer(key + 48)
            value, _ = self.integer_expression(owner, view, initializer, depth + 1)
        else:
            flags, kind, value, aux, trailer = entry
            if (flags != 1 or kind != 5 or aux or trailer or not isinstance(value, str)
                    or len(value) != width or set(value) - {"0", "1"}):
                raise Unsupported("unverified KDB packed logic integer parameter value")
            value = int(value, 2)
        signed = (header >> 28) & 1
        return self.integer_bits(value, signed, width), signed

    def integer_expression(self, owner, view, key, depth=0):
        if depth > 32:
            raise Unsupported("KDB range expression depth exceeds budget")
        header = self.expression_tag(view, key)
        if header == 0x10000328:
            return view.read(key + 16, "<i")[0], 1
        if header == 0x10010328:
            return view.read(key + 16, "<I")[0], 0
        if header == 0xAA0228 and view.string(view.pointer(key + 16)) == "0":
            return 0, 0
        # The low bit of the radix byte marks a macro-expanded literal.
        radix = {0x020228: 2, 0x040228: 8, 0x060228: 10, 0x080228: 16}.get(header & ~0x10010000)
        if radix:
            return self.radix_integer(view, key, radix, int(bool(header & 0x10000000)))
        if header & 255 == 57 and header >> 16 & 255 in INTEGER_PARAMETER_WIDTHS:
            return self.integer_parameter(owner, view, key, header, depth + 1)
        if header & 0x1FFFFFFF == 0x010C013A:
            return self.integer_parameter(owner, view, key, header, depth + 1)
        if header & TYPE_HEADER_MASK in (0x0107003A, 0x4107003A):
            return self.logic_parameter_integer(owner, view, key, header, depth + 1)
        if self.is_enum_parameter(owner, view, key, header):
            value, signed, _ = self.enum_parameter(owner, view, key, depth + 1)
            return value, signed
        if header & TYPE_HEADER_MASK == 0x010F003A:
            bits = self.packed_parameter(owner, view, key, depth + 1)
            if len(bits) > 32 or set(bits) - {"0", "1"}:
                raise Unsupported("KDB packed logic parameter is not an integer")
            return int(bits, 2), 0
        if header == 0x14A:
            return self.enum_item(owner, view, key, depth + 1)
        if header == 0x0101013A and owner["kind"] == "npiGenScope":
            while owner["kind"] == "npiGenScope":
                entry = self.parameter_entry(owner, key)
                if entry is not None:
                    if entry[0:2] == (1, 0x1000001) and entry[3:] == (0, 0) and 0 <= entry[2] < 1 << 32:
                        return self.integer_32(entry[2], True), 1
                    break
                owner = self.session.node(owner["parent"])
            raise Unsupported("unverified KDB generate index parameter")
        if header in (0x0004013C, 0x0011013C, 0x1011013C, 0x2403013C, 0x3403013C):
            field = self.aggregate_field(owner, view, key, header, depth + 1)
            if field is not None:
                return field
            return self.package_integer(view, key, header, depth + 1)
        if self.function_arguments:
            frame = self.function_arguments[-1]
            if frame.view is view and key in frame.values:
                return self.function_binding(frame, key)
            field = self.function_field(frame, view, key)
            if field is not None:
                structure, offset, signed, width = field
                value, _ = frame.values[structure]
                if value is None:
                    raise Unsupported("uninitialized KDB constant function structure")
                return self.integer_bits(value >> offset, signed, width), signed
            if frame.view is view and header == 0x240123:
                subscript, target = self.operand_list(view, key, 2)
                if target in frame.ranges:
                    bit = self.bit_offset(owner, view, subscript, frame.ranges[target], depth)
                    if target in frame.defined_bits and not frame.defined_bits[target] & (1 << bit):
                        raise Unsupported("KDB constant bit has not been initialized")
                    value, _ = frame.values[target]
                    return (value >> bit) & 1, 0
        if header == 0x240123:
            subscript, target = self.operand_list(view, key, 2)
            target_header = view.read(target, "<I")[0] & TYPE_HEADER_MASK
            if target_header in (0x010F003A, 0x410F003A):
                typedef = view.pointer(target + 56)
                category, _, shape = self.packed_type(owner, view, typedef)
                if not category and len(shape) == 1:
                    bit = self.bit_offset(owner, view, subscript, shape[0], depth)
                    value, _ = self.integer_expression(owner, view, target, depth + 1)
                    return (value >> bit) & 1, 0
        if header == 0x2B0123:
            return self.constant_function(owner, view, key, depth + 1)
        if header == 0x2C0123:
            return self.integer_builtin(owner, view, key, depth + 1)
        if header == 0x4D0123 and view.read(key + 8, "<Q")[0] == 0:
            argument, = self.operand_list(view, key, 1)
            value, _ = self.integer_expression(owner, view, argument, depth + 1)
            return self.integer_32(value, False), 0
        if header == 0x4E0123 and view.read(key + 8, "<Q")[0] == 0x0C000000:
            argument, = self.operand_list(view, key, 1)
            value, _ = self.integer_expression(owner, view, argument, depth + 1)
            return self.integer_32(value, True), 1
        if header == 0x4F0123 and view.read(key + 8, "<Q")[0] == 0:
            argument, type_key = self.operand_list(view, key, 2)
            category, width, _ = self.packed_type(owner, view, type_key)
            if category != "Enum" or not 0 < width <= 32:
                raise Unsupported("unverified KDB enumeration cast type")
            _, definition_view, definition = self.type_definition(owner, view, type_key)
            signed = self.enum_signedness(definition_view.read(definition + 28, "<I")[0])
            value, _ = self.integer_expression(owner, view, argument, depth + 1)
            value &= (1 << width) - 1
            if signed and value >= 1 << (width - 1):
                value -= 1 << width
            return value, signed
        if header == 0xC80123 and view.read(key + 8, "<Q")[0] == 0:
            size, argument = self.operands(view, key)
            width, _ = self.integer_expression(owner, view, size, depth + 1)
            if not 0 < width <= 32:
                raise Unsupported("unverified KDB constant size cast width")
            value, signed = self.integer_expression(owner, view, argument, depth + 1)
            return self.integer_bits(value, signed, width), signed
        if header == 0x030123:
            argument, = self.operand_list(view, key, 1)
            value, signed = self.integer_expression(owner, view, argument, depth + 1)
            return self.integer_32(-value, signed), signed
        if header == 0x270123:
            no, condition, yes = self.operand_list(view, key, 3)
            condition, _ = self.integer_expression(owner, view, condition, depth + 1)
            yes, yes_signed = self.integer_expression(owner, view, yes, depth + 1)
            no, no_signed = self.integer_expression(owner, view, no, depth + 1)
            signed = yes_signed and no_signed
            return self.integer_32(yes if condition else no, signed), signed
        operation = INTEGER_OPERATIONS.get(header)
        if operation:
            left, right = self.operands(view, key)
            left, left_signed = self.integer_expression(owner, view, left, depth + 1)
            right, right_signed = self.integer_expression(owner, view, right, depth + 1)
            signed = left_signed and right_signed
            if operation == "add":
                result = left + right
            elif operation == "subtract":
                result = left - right
            elif operation == "multiply":
                result = left * right
            elif operation == "and":
                result = left & right
            elif operation == "or":
                result = left | right
            elif operation == "logical and":
                return int(bool(left) and bool(right)), 0
            elif operation == "logical or":
                return int(bool(left) or bool(right)), 0
            elif operation in ("equal", "not equal", "less than", "greater than", "greater or equal"):
                left = self.integer_32(left, signed)
                right = self.integer_32(right, signed)
                if operation == "equal":
                    return int(left == right), 0
                if operation == "not equal":
                    return int(left != right), 0
                if operation == "less than":
                    return int(left < right), 0
                return int(left > right if operation == "greater than" else left >= right), 0
            elif operation == "power":
                if right < 0:
                    raise Unsupported("unverified KDB power exponent")
                signed = left_signed
                result = pow(left & 0xFFFFFFFF, right, 1 << 32)
            elif operation == "left shift":
                signed = left_signed
                result = left << right if 0 <= right < 32 else 0
            elif operation in ("right shift", "arithmetic right shift"):
                signed = left_signed
                if operation == "right shift" or not signed:
                    left &= 0xFFFFFFFF
                result = left >> min(right & 0xFFFFFFFF, 32)
            else:
                if not right or left_signed != right_signed and min(left, right) < 0:
                    raise Unsupported("unverified KDB integer division operands")
                result = abs(left) // abs(right)
                if (left < 0) != (right < 0):
                    result = -result
                if operation == "modulo":
                    result = left - result * right
            return self.integer_32(result, signed), signed
        raise Unsupported(f"unverified KDB range expression {header:#010x}")

    def range_bounds(self, owner, view, key):
        if key is None or self.expression_tag(view, key) != 0x250123:
            return self.immediate_range(view, key)
        left, right = self.operands(view, key)
        return self.integer_expression(owner, view, left)[0], self.integer_expression(owner, view, right)[0]

    def dimensions(self, owner, view, key, declaration, declaration_slot):
        if key is None:
            raise Unsupported("KDB packed dimension is missing")
        header = self.expression_tag(view, key)
        if header & 0x80FF == 0x26 or header & TYPE_HEADER_MASK == 0x27:
            return [self.immediate_range(view, key)]
        if header not in (0x250123, 0x360123):
            raise Unsupported("unverified KDB dimension record")
        dimension_owner = view.pointer(key + 16)
        if dimension_owner != declaration:
            if (dimension_owner is None or not 51 <= view.read(dimension_owner, "<I")[0] & 255 <= 56
                    or view.pointer(dimension_owner + declaration_slot) != key):
                raise Unsupported("unverified KDB shared dimension owner")
        if header == 0x250123:
            return [self.range_bounds(owner, view, key)]
        bounds = []
        for wrapper in LexicalScopes.chain(view, view.pointer(key + 24)):
            if view.read(wrapper, "<I")[0] & 0xFFFFFF != 26 or len(bounds) >= 32:
                raise Unsupported("unverified KDB packed dimension wrapper")
            bounds.append(self.range_bounds(owner, view, view.pointer(wrapper + 16)))
        if len(bounds) < 2:
            raise Unsupported("KDB packed dimension group has too few dimensions")
        # The group points at the tail of a circular declaration list.
        return bounds[1:] + bounds[:1]

    @staticmethod
    def dimension_width(bounds):
        width = 1
        for left, right in bounds:
            width *= abs(left - right) + 1
            if width > 1_048_576:
                raise Unsupported("KDB declaration width exceeds budget")
        return width

    def type_path(self, owner, view, key):
        for _ in range(20):
            if key is None:
                break
            yield owner, view, key
            if view.read(key, "<I")[0] & TYPE_HEADER_MASK not in IMPORTED_TYPES:
                return
            unit = view.read(key + 36, "<I")[0]
            flags = view.read(key + 4, "<I")[0]
            if unit == 0 and flags == 0:
                key = view.pointer(key + 48)
                continue
            package = self.packages.get(unit)
            if not package or flags != 0x4000:
                raise Unsupported("unverified imported KDB type source")
            owner = self.session.node(package)
            target_view = self.session.objects.view(unit)
            key, view = view.pointer(key + 48, target_view), target_view
        raise Unsupported("unverified KDB packed aggregate type")

    def type_definition(self, owner, view, key):
        for declaration in self.type_path(owner, view, key):
            pass
        return declaration

    def packed_type(self, owner, view, key, depth=0, *, defaults=False):
        if depth > 20:
            raise Unsupported("unverified KDB packed aggregate type")
        path = list(self.type_path(owner, view, key))
        owner, view, key = path[-1]
        added = []
        for alias_owner, alias_view, alias in path[:-1]:
            if alias_view.read(alias + 4, "<I")[0] == 0 and alias_view.read(alias + 36, "<I")[0] == 0:
                outer = alias_view.pointer(alias + 72)
                if outer is not None:
                    added.extend(self.dimensions(alias_owner, alias_view, outer, alias, 72))
        raw_header = view.read(key, "<I")[0]
        header = raw_header & TYPE_HEADER_MASK
        if raw_header & TYPE_PARAMETER_MASK == TYPE_PARAMETER:
            return self.type_parameter_layout(owner, view, key, depth + 1, defaults=defaults)
        if header == ENUM_TYPE:
            dtype = view.read(key + 28, "<I")[0] >> 16 & 255
            if dtype not in (0, 7, 8, 12):
                raise Unsupported("unverified KDB enumeration base type")
            dimension = view.pointer(key + 72)
            width = self.dimension_width([self.range_bounds(owner, view, dimension)]) if dimension is not None else (1 if dtype in (7, 8) else 32)
            return "Enum", width * self.dimension_width(added), added
        if header == LOGIC_TYPEDEF:
            if view.read(key + 48, "<Q")[0] != 7:
                raise Unsupported("unverified KDB typedef base type")
            dimension = view.pointer(key + 72)
            bounds = added + (self.dimensions(owner, view, dimension, key, 72) if dimension is not None else [])
            return "", self.dimension_width(bounds), bounds
        if header not in (STRUCT_TYPE, UNION_TYPE):
            raise Unsupported(f"unverified KDB packed aggregate type {raw_header:#010x}")
        field_widths = []
        for field in LexicalScopes.chain(view, view.pointer(key + 48)):
            field_header = view.read(field, "<I")[0]
            if field_header & 255 != 73 or view.pointer(field + 40) != key:
                raise Unsupported("unverified KDB packed aggregate field")
            field_type = field_header >> 16 & 255
            if field_type == 15:
                member = view.pointer(field + 48)
                _, width, _ = self.packed_type(owner, view, member, depth + 1)
            elif field_type in (3, 12):
                width = 32
            elif field_type in (7, 8):
                width = 1
                if field_header & 0x02000000:
                    member = view.pointer(field + 48)
                    width = self.dimension_width([self.range_bounds(owner, view, member)])
            else:
                raise Unsupported("unverified KDB packed aggregate field type")
            field_widths.append(width)
        if header == UNION_TYPE and len(set(field_widths)) != 1:
            raise Unsupported("KDB packed union fields have different widths")
        width = sum(field_widths) if header == STRUCT_TYPE else next(iter(field_widths), 0)
        if not 0 < width <= 1_048_576:
            raise Unsupported("KDB packed aggregate width exceeds budget")
        return ("Struct" if header == STRUCT_TYPE else "Union"), width * self.dimension_width(added), added

    def type_parameter_layout(self, owner, view, key, depth, *, defaults=False):
        if depth > 20:
            raise Unsupported("KDB type parameter expansion exceeds depth budget")
        declared_at = owner
        name = view.string(view.pointer(key + 32))
        while True:
            _, _, members, _ = self.lookup(declared_at["fullname"] + "." + name)
            if members.get(name, (None,))[0] == key:
                break
            if not declared_at["parent"]:
                raise Unsupported("KDB type parameter declaration context is missing")
            declared_at = self.session.node(declared_at["parent"])
            if self.session.objects.view(declared_at["scopeKey"]) is not view:
                raise Unsupported("KDB type parameter declaration arena is inconsistent")
        entry = None if defaults else self.parameter_entry(declared_at, key)
        if entry is None:
            expression = view.pointer(key + 48)
        else:
            flags, tag, unit, auxiliary, expression = entry
            if flags != 1 or tag != 11 or auxiliary or not unit or not expression:
                raise Unsupported("unverified KDB type parameter set entry")
            while declared_at["scopeKey"] != unit and declared_at["parent"]:
                declared_at = self.session.node(declared_at["parent"])
            if declared_at["scopeKey"] != unit:
                raise Unsupported("KDB type override has no matching ancestor unit")
            view = self.session.objects.view(unit)
        return self.type_expression_layout(declared_at, view, expression, depth, defaults=defaults)

    def type_expression_layout(self, owner, view, expression, depth, *, defaults=False):
        if expression is None or view.read(expression, "<I")[0] != 0x550123:
            raise Unsupported("unverified KDB type substitution expression")
        base = view.read(expression + 8, "<Q")[0]
        if base == 0x07000000 and view.pointer(expression + 24) is None:
            return "", 1, []
        argument, = self.operand_list(view, expression, 1)
        if base == 0x07000000:
            bounds = [self.range_bounds(owner, view, argument)]
            return "", self.dimension_width(bounds), bounds
        if base == 0x0F000000:
            return self.packed_type(owner, view, argument, depth + 1, defaults=defaults)
        raise Unsupported("unverified KDB type substitution base")

    def projection_layout(self, owner, view, declaration, realized):
        # NPI uses the original type argument for the inner dimension of a
        # selected element. A forwarded parameter retains its default shape
        # here, while the element's value width uses the elaborated type.
        context = self.session.context(owner)
        if not context:
            raise Unsupported("unverified KDB type parameter projection context")
        instance = self.session.instances_by_id[context["instanceRecord"]]
        unit, location = self.session.objects.original_source(instance)
        source = self.session.objects.view(unit)
        instance_tag = source.read(location, "<I")[0] & 255
        if instance_tag == 44:
            return realized
        if instance_tag != 45:
            raise Unsupported("unverified KDB type instance declaration")
        parameter = view.string(view.pointer(declaration + 32))
        override = source.pointer(location + 64)
        if override is None:
            return realized
        for entry in LexicalScopes.chain(source, override):
            tag = source.read(entry, "<I")[0]
            if tag not in (0x2001B, 0x5001B):
                raise Unsupported("unverified instance argument entry")
            if source.string(source.pointer(entry + 24)) != parameter:
                continue
            if tag != 0x5001B:
                raise Unsupported("unverified instance type argument entry")
            parent = self.session.node(context["parent"])
            while parent["scopeKey"] != unit and parent["parent"]:
                parent = self.session.node(parent["parent"])
            if parent["scopeKey"] != unit:
                raise Unsupported("unverified instance type argument arena")
            _, _, dimensions = self.type_expression_layout(parent, source, source.pointer(entry + 16), 0, defaults=True)
            if not dimensions:
                raise Unsupported("unverified instance type argument dimensions")
            return dimensions
        return realized

    def describe(self, query):
        owner, view, members, name = self.lookup(query)
        indices = []
        if name not in members:
            match = re.fullmatch(r"(.*?)((?:\[-?\d+\])+)", name)
            if not match or match[1] not in members:
                raise Unsupported("KDB value declaration not found: " + query)
            name, suffix = match.groups()
            indices = [int(index) for index in re.findall(r"\[(-?\d+)\]", suffix)]
        key, header = members[name]
        tag, dtype = header & 255, header >> 16 & 255
        flags = view.read(key + 28, "<I")[0]
        lexical = bool(flags & 0x8000 and owner["kind"] in ("npiGenScope", "npiNamedBegin"))
        signed = -1
        value = None
        type_dimensions = ()
        declared_type = None
        uses_type_parameter = False
        if header & TYPE_PARAMETER_MASK == TYPE_PARAMETER:
            kind, width = "npiTypeParameter", -1
        elif tag in (57, 58):
            kind = "npiParameter"
            width, signed, value = self.parameter(owner, view, key, header)
        elif (tag in (51, 52, 53) and dtype == 2
              or tag == 53 and dtype == 1 and flags & 0x10):
            kind, width = "npiNet", 1
        elif tag == 56 and dtype == 7 and view.read(key + 64, "<I")[0] == 0x830000:
            kind, width = "npiReg", 1
        elif tag == 56 and dtype == 7 and view.read(key + 64, "<I")[0] == 0x820000:
            tokens = self.port_tokens.inputs(owner)
            port = tokens.get(key) or tokens.get(name)
            if port is None or port[0] != name:
                raise Unsupported("unverified KDB input storage")
            kind, width = port[1], 1
        elif tag == 56 and dtype in (2, 7) and flags == 0x4210:
            direction = view.read(key + 64, "<I")[0] >> 16
            port = view.pointer(key + 56)
            if (direction not in (2, 3) or port is None or view.read(port, "<I")[0] & 255 != 47
                    or view.pointer(port + 24) != key):
                raise Unsupported("unverified KDB indexed port direction")
            kind, width = ("npiNet" if direction == 2 else "npiReg"), 1
        elif (tag == 56 and dtype == 2 and flags == 0x210
              and view.read(key + 64, "<I")[0] >> 16 == 3):
            port = view.pointer(key + 56)
            if port is None or view.read(port, "<I")[0] & 255 != 47 or view.pointer(port + 24) != key:
                raise Unsupported("unverified KDB legacy output port")
            kind, width = "npiReg", 1
        elif tag in (55, 56) and dtype == 15 and flags & 0x1000:
            slot = 72 if tag == 56 else 64 if lexical else 56
            if flags & 0x2000:
                slot += 8
            if flags & 0x4000:
                slot += 8
            declared_type = view.pointer(key + slot)
            uses_type_parameter = (declared_type is not None and
                                   view.read(declared_type, "<I")[0] & TYPE_PARAMETER_MASK == TYPE_PARAMETER)
            category, width, type_dimensions = self.packed_type(owner, view, declared_type)
            if type_dimensions:
                width //= self.dimension_width(type_dimensions)
            port_input = tag == 56 and view.read(key + 64, "<I")[0] == 0x820000
            if category:
                kind = "npi" + category + ("Net" if port_input else "Var")
            else:
                kind = "npiNet" if port_input else "npiReg"
        elif tag in (54, 55) or tag == 56 and dtype == 8:
            if dtype not in VARIABLE_TYPES:
                raise Unsupported("unverified KDB variable datatype")
            kind, width = VARIABLE_TYPES[dtype]
        else:
            raise Unsupported("unverified KDB port storage or declaration kind")
        packed, unpacked = [], []
        packed_slot = 64 if lexical else 56
        if tag in (53, 56):
            port = view.pointer(key + 56)
            if port is not None and view.read(port, "<I")[0] & 255 == 47:
                if view.pointer(port + 24) != key:
                    raise Unsupported("unverified KDB port dimension owner")
                packed_slot = 72
        if tag in (52, 53, 55, 56) and flags & 0x4000:
            if packed_slot == 64:
                lexical_owner = view.pointer(key + 56)
                if lexical_owner is None or view.read(lexical_owner, "<I")[0] & 255 != 66:
                    raise Unsupported("unverified KDB lexical declaration owner")
            dimension = view.pointer(key + packed_slot)
            packed = self.dimensions(owner, view, dimension, key, packed_slot)
        if tag in (51, 52, 53, 54, 55, 56) and flags & 0x2000:
            slot = packed_slot + 8 if flags & 0x4000 else packed_slot
            unpacked = self.dimensions(owner, view, view.pointer(key + slot), key, slot)
        outer_count = len(unpacked) + len(packed)
        is_selected = bool(outer_count and len(indices) >= outer_count)
        element_width = None
        if uses_type_parameter and is_selected and type_dimensions:
            realized_width = self.dimension_width(type_dimensions)
            type_dimensions = self.projection_layout(owner, view, declared_type, type_dimensions)
            if len(indices) == outer_count:
                element_width = realized_width * self.dimension_width(type_dimensions)
        aggregate_element = kind in ("npiEnumVar", "npiStructVar", "npiUnionVar")
        aggregate_boundary = outer_count + len(type_dimensions)
        packed.extend(type_dimensions)
        if aggregate_element and len(indices) > aggregate_boundary:
            packed.append((width - 1, 0))
        elif aggregate_element and packed and not indices and not unpacked:
            kind = "npiPackedArrayVar"
        dimensions = unpacked + packed
        if len(indices) > len(dimensions):
            raise Unsupported("KDB too many indices for value declaration")
        for index, (left, right) in zip(indices, dimensions):
            if not min(left, right) <= index <= max(left, right):
                raise Unsupported("KDB index outside declaration range")
        has_scope = True
        if len(indices) < len(unpacked):
            kind = "npiVarSelect" if indices else "npiArrayVar"
            width = self.dimension_width(unpacked[len(indices):])
            has_scope = not indices
        else:
            if aggregate_element and len(indices) > aggregate_boundary:
                if kind == "npiEnumVar" and uses_type_parameter:
                    kind, width, has_scope = "npiBitSelect", -1, False
                else:
                    kind, width = "npiRegBit", 1
            elif width == 1 and packed and len(indices) == len(dimensions):
                if kind not in ("npiNet", "npiReg"):
                    raise Unsupported("unverified KDB packed bit object type")
                kind += "Bit"
            width = element_width if element_width is not None else width * self.dimension_width(dimensions[len(indices):])
        unit = owner["scopeKey"]
        objects = self.session.objects
        file_number = (header >> 8) & 127
        if file_number == 127:
            file_number = objects.extended_file_number(unit, key)
        document = objects.source_files(unit).get(file_number)
        if document is None:
            raise Unsupported("KDB value has no source document")
        filename = self.session.sources.document(objects.unit_libraries[unit], document)
        line = view.read(key + 24, "<I")[0]
        if not filename or not line:
            raise Unsupported("KDB value has no source position")
        context = self.session.context(owner) if has_scope else None
        definition = self.session.sources.lookup(context["module"]) if context else None
        return {"fullname": query, "kind": kind, "file": filename, "line": line, "width": width, "signed": signed,
                **({"value": value} if value is not None else {}),
                "scope": {"fullname": owner["fullname"], "kind": owner["kind"]} if has_scope else None,
                "module": context["module"] if context else "",
                "definitionFile": definition["file"] if definition else "",
                "definitionLine": definition["line"] if definition else 0,
                "instance": context["fullname"] if context else ""}
