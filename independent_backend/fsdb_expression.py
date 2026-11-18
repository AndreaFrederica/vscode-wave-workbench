# SPDX-License-Identifier: MPL-2.0
"""Original, limited expression decoder for controlled FSDB connection data.

These are generated design expressions, not vendor executable instructions.
Only operations verified with original RTL controls are interpreted.
"""
import re
import struct
from kdb_records import Unsupported


def constants(raw):
    if len(raw) < 8:
        raise Unsupported("connection constant pool header truncated")
    count = struct.unpack_from("<I", raw)[0]
    if count > 1000000 or 8 + 12 * count > len(raw):
        raise Unsupported("connection constant count exceeds bounds")
    vectors = struct.unpack_from("<" + "I" * count, raw, 4)
    scalars = struct.unpack_from("<" + "I" * count, raw, 4 + count * 4)
    length = struct.unpack_from("<I", raw, 4 + count * 8)[0]
    start = 8 + count * 8
    if start + length + count * 4 != len(raw):
        raise Unsupported("connection constant pool payload/width bounds")
    payload = raw[start:start + length]
    widths = struct.unpack_from("<" + "I" * count, raw, start + length)
    result, intervals = [], []
    for vector, scalar, width in zip(vectors, scalars, widths):
        if not 0 < width <= 1048576 or (vector == 0xFFFFFFFF) == (scalar == 0xFFFFFFFF):
            raise Unsupported("unverified connection constant storage descriptor")
        if vector != 0xFFFFFFFF:
            size = 8 * ((width + 31) // 32)
            if vector > len(payload) - size:
                raise Unsupported("connection constant vector exceeds payload")
            mask = value = 0
            for i in range((width + 31) // 32):
                m, v = struct.unpack_from("<II", payload, vector + i * 8)
                mask |= m << (i * 32)
                value |= v << (i * 32)
            bits = "".join(("x" if value >> i & 1 else "z") if mask >> i & 1 else
                           ("1" if value >> i & 1 else "0") for i in reversed(range(width)))
            intervals.append((vector, vector + size))
        else:
            if width != 1 or scalar > len(payload) - 4 or payload[scalar] > 3:
                raise Unsupported("connection scalar constant bounds/value")
            bits = "01xz"[payload[scalar]]
            intervals.append((scalar, scalar + 4))
        result.append(bits)
    intervals.sort()
    if intervals and (intervals[0][0] or intervals[-1][1] != len(payload) or any(a[1] != b[0] for a, b in zip(intervals, intervals[1:]))):
        raise Unsupported("connection constants do not cover payload exactly")
    return result


class Expression:
    def __init__(self, code, argument_count, pool):
        self.code, self.argument_count, self.pool = code, argument_count, pool
        self.offset, self.nodes = 0, 0
        self.tree = self.parse(0)
        if self.offset != len(code):
            raise Unsupported("unparsed connection expression bytes")
        tokens = set()
        def collect(node, lvalue=False):
            kind = node[0]
            if kind == "argument":
                if not lvalue:
                    tokens.add(node[1])
            elif kind == "concat":
                for child in node[2]:
                    collect(child, lvalue)
            elif kind == "extended":
                operation, children = node[1:]
                if operation == 0x9B:
                    collect(children[0], True)
                    collect(children[1])
                else:
                    collect(children[0], lvalue)
                    for child in children[1:]:
                        collect(child)
            elif isinstance(kind, int):
                for child in node[1:]:
                    collect(child, lvalue if kind in (0x94, 0x95) else False)
        collect(self.tree)
        if all(token < argument_count for token in tokens):
            self.argument_map = {token: token for token in tokens}
        elif len(tokens) == argument_count:
            # Constant operands can leave gaps in the original argument slot
            # numbers; graph edges contain only the dynamic argument values.
            self.argument_map = {token: index for index, token in enumerate(sorted(tokens))}
        else:
            raise Unsupported("connection expression argument slots disagree with graph arity")

    def aligned_integer(self):
        end = (self.offset + 3) & ~3
        if end + 4 > len(self.code) or any(self.code[self.offset:end]):
            raise Unsupported("connection expression aligned integer bounds/padding")
        self.offset = end + 4
        return struct.unpack_from("<I", self.code, end)[0]

    def parse(self, depth):
        self.nodes += 1
        if depth > 256 or self.nodes > 100000 or self.offset >= len(self.code):
            raise Unsupported("connection expression depth/count/truncation")
        opcode = self.code[self.offset]
        self.offset += 1
        if opcode >= 0xC0:
            argument = opcode - 0xC0
            if opcode >= 0xE0:
                if self.offset >= len(self.code) or not 0x81 <= self.code[self.offset] <= 0xFF:
                    raise Unsupported("invalid extended connection argument")
                argument += (self.code[self.offset] - 0x81) * 32
                self.offset += 1
            return ("argument", argument)
        if opcode <= 3:
            return ("literal", "01xz"[opcode])
        if opcode == 0xB2:
            index = self.aligned_integer()
            if index >= len(self.pool):
                raise Unsupported("connection expression constant index exceeds pool")
            return ("literal", self.pool[index])
        if opcode in (0x81, 0x82, 0x94, 0x95, 0xB9):
            return (opcode, self.parse(depth + 1))
        if opcode in (0x83, 0x84, 0x85, 0x86, 0x8A, 0x9B, 0x9C):
            return (opcode, self.parse(depth + 1), self.parse(depth + 1))
        if opcode == 0x93:
            return (opcode, self.parse(depth + 1), self.parse(depth + 1), self.parse(depth + 1))
        if opcode == 0xBF:
            if self.offset >= len(self.code):
                raise Unsupported("connection extended expression opcode truncated")
            kind = self.code[self.offset]
            self.offset += 1
            if kind == 0x82:
                repeat = self.aligned_integer()
                count = self.aligned_integer()
                if not 0 < repeat <= 65536 or not 0 < count <= 65536:
                    raise Unsupported("connection concatenation count exceeds budget")
                return ("concat", repeat, tuple(self.parse(depth + 1) for _ in range(count)))
            if kind in (0x85, 0x86, 0x9B):
                count = 3 if kind == 0x86 else 2
                return ("extended", kind, tuple(self.parse(depth + 1) for _ in range(count)))
            raise Unsupported("unimplemented extended connection opcode: " + hex(kind))
        raise Unsupported("unimplemented connection expression opcode: " + hex(opcode))

    @staticmethod
    def integer(bits):
        if any(bit not in "01" for bit in bits):
            return None
        value = int(bits, 2)
        return value - (1 << len(bits)) if len(bits) == 32 and bits[0] == "1" else value

    def evaluate(self, arguments, width, tree=None, raw=False, scalar=False):
        def visit(node):
            kind = node[0]
            if kind == "argument":
                return arguments[self.argument_map[node[1]]]
            if kind == "literal":
                return node[1]
            if kind == "concat":
                value = "".join(visit(child) for child in node[2])
                if len(value) * node[1] > 1048576:
                    raise Unsupported("connection concatenation bit count exceeds budget")
                return value * node[1]
            if kind == "extended":
                operation, children = node[1:]
                if operation == 0x9B:
                    raise Unsupported("connection partial assignment evaluation is not implemented")
                source, index = visit(children[0]), self.integer(visit(children[1]))
                if operation == 0x85:
                    return "x" if index is None or not 0 <= index < len(source) else source[-1 - index]
                delta = self.integer(visit(children[2]))
                if index is None or delta is None:
                    return "x" * width
                if abs(delta) >= 65536:
                    raise Unsupported("connection part select width exceeds budget")
                step = -1 if delta < 0 else 1
                return "".join(source[-1 - bit] if 0 <= bit < len(source) else "x" for bit in range(index, index + delta + step, step))
            first = visit(node[1])
            if kind in (0x94, 0x95):
                return first
            if kind == 0x82:
                return "".join({"0": "1", "1": "0", "x": "x", "z": "x"}[bit] for bit in first)
            if kind == 0x81:
                return first.replace("z", "x")
            if kind == 0xB9:
                return "x" if any(bit in first for bit in "xz") else str(first.count("1") & 1)
            if kind == 0x93:
                if not scalar:
                    return first
                positive, negative = visit(node[2]), visit(node[3])
                size = max(len(positive), len(negative), width)
                positive, negative = positive.rjust(size, "0"), negative.rjust(size, "0")
                if "1" in first:
                    return positive
                if not any(bit in first for bit in "xz"):
                    return negative
                return "".join(a if a == b else "x" for a, b in zip(positive, negative))
            second = visit(node[2])
            if kind == 0x8A:
                if not scalar:
                    return first
                def truth(bits):
                    return "1" if "1" in bits else "x" if any(bit in bits for bit in "xz") else "0"
                a, b = truth(first), truth(second)
                return "x" if "x" in (a, b) else "1" if a == b else "0"
            length = max(len(first), len(second))
            first, second = first.rjust(length, "0"), second.rjust(length, "0")
            if kind in (0x9B, 0x9C):
                if any(bit in first + second for bit in "xz"):
                    return "x" * length
                value = int(first, 2) + int(second, 2) if kind == 0x9B else int(first, 2) - int(second, 2)
                return format(value & ((1 << length) - 1), f"0{length}b")
            result = []
            for a, b in zip(first, second):
                if kind == 0x83:
                    result.append("0" if "0" in (a, b) else "1" if a == b == "1" else "x")
                elif kind == 0x84:
                    result.append("1" if "1" in (a, b) else "0" if a == b == "0" else "x")
                elif kind == 0x85:
                    result.append("x" if a in "xz" or b in "xz" else "1" if a != b else "0")
                elif kind == 0x86 and scalar:
                    result.append("x" if a in "xz" or b in "xz" else "1" if a == b else "0")
                else:
                    raise Unsupported("unimplemented connection expression evaluation")
            return "".join(result)
        value = visit(self.tree if tree is None else tree)
        return value if raw else value.rjust(width, "0")[-width:]

    def assignment_tree(self):
        tree = self.tree
        while tree[0] in (0x94, 0x95):
            tree = tree[1]
        return tree if tree[0:2] == ("extended", 0x9B) else None

    def assignment(self, arguments, width, scalar=False):
        tree = self.assignment_tree()
        if tree is None:
            return dict(zip(reversed(range(width)), self.evaluate(arguments, width, scalar=scalar)))

        def integer(node):
            return self.integer(self.evaluate(arguments, 32, tree=node, raw=True))

        def positions(node):
            if node == ("argument", 0):
                return list(reversed(range(width)))
            if node[0] == "concat":
                return [index for child in node[2] for index in positions(child)] * node[1]
            if node[0] == "extended" and node[1] in (0x85, 0x86):
                children = node[2]
                base, start = positions(children[0]), integer(children[1])
                if start is None:
                    raise Unsupported("unknown partial connection assignment index")
                if node[1] == 0x85:
                    indexes = [start]
                else:
                    delta = integer(children[2])
                    if delta is None or abs(delta) >= 65536:
                        raise Unsupported("partial connection assignment range exceeds budget")
                    step = -1 if delta < 0 else 1
                    indexes = range(start, start + delta + step, step)
                if any(not 0 <= index < len(base) for index in indexes):
                    raise Unsupported("partial connection assignment is outside destination")
                return [base[-1 - index] for index in indexes]
            raise Unsupported("unimplemented partial connection assignment target")

        indexes = positions(tree[2][0])
        if not indexes or len(set(indexes)) != len(indexes):
            raise Unsupported("partial connection assignment has duplicate/empty destinations")
        value = self.evaluate(arguments, len(indexes), tree=tree[2][1], scalar=scalar)
        return dict(zip(indexes, value))


TEXT_HEADER = re.compile(rb"(?:Out\[(\d+)(?::\+(-?\d+))?\] = )?bcid (\d+) (\d+)\s+")


class TextExpression:
    """Limited stack expression records emitted for original RTL controls."""
    def __init__(self, code, argument_count, pool):
        header = TEXT_HEADER.match(code)
        if header is None:
            raise Unsupported("unverified textual connection expression header")
        first, delta, _, _ = header.groups()
        self.destination = (int(first), int(delta or 0)) if first else None
        try:
            tokens = code[header.end():].decode("ascii").split()
        except UnicodeError as error:
            raise Unsupported("connection textual expression is not ASCII") from error
        self.argument_count, self.instructions = argument_count, []
        allowed = {"WIDTH", "CALL_ARG_VAL", "OPT_CONST", "CONST", "M_EQU", "M_NEQU", "EQU",
                   "M_LT", "M_GT", "M_LE", "M_GE", "SM_GT", "SHIFT_L", "SHIFT_R", "SASHIFT_R",
                   "ADD", "SUBTRACT", "SMULTIPLY", "SLICE", "MITECONDNOINSTR", "RET", "AND",
                   "OR", "XOR", "XNOR", "NOT", "XOR_REDUCE", "PAD", "CONCATENATE", "MULTI_CONCATENATE"}
        for token in tokens:
            fields = token.split(",")
            if fields[0] not in allowed:
                raise Unsupported("unimplemented textual connection instruction: " + fields[0])
            try:
                values = tuple(int(value) for value in fields[1:])
            except ValueError as error:
                raise Unsupported("unverified textual connection instruction argument") from error
            self.instructions.append((fields[0], values))
        if len(self.instructions) > 100000 or not self.instructions or self.instructions[-1] != ("RET", ()):
            raise Unsupported("textual connection instruction count/return mismatch")
        self.tree = ("text",)

    def assignment(self, arguments, width, scalar=False):
        if self.destination is None:
            positions = range(width - 1, -1, -1)
        else:
            first, delta = self.destination
            last = first + delta
            if not 0 <= first < width or not 0 <= last < width:
                raise Unsupported("textual connection assignment outside destination bounds")
            step = -1 if delta < 0 else 1
            positions = range(first, last + step, step)
        return dict(zip(positions, self.evaluate(arguments, len(positions), scalar=scalar)))

    @staticmethod
    def signed(bits):
        value = int(bits, 2)
        return value - (1 << len(bits)) if bits.startswith("1") else value

    @staticmethod
    def literal(values, width):
        if len(values) < 2 or values[1] or len(values) != values[0] + 2 or values[0] % 2:
            raise Unsupported("unverified textual vector constant fields")
        mask = value = 0
        for mask_word, value_word in zip(values[2::2], values[3::2]):
            if any(not -(1 << 31) <= word < 1 << 32 for word in (mask_word, value_word)):
                raise Unsupported("textual vector constant word exceeds budget")
            mask = (mask << 32) | (mask_word & 0xFFFFFFFF)
            value = (value << 32) | (value_word & 0xFFFFFFFF)
        return "".join("01zx"[((mask >> bit) & 1) * 2 + ((value >> bit) & 1)] for bit in reversed(range(width)))

    @staticmethod
    def bitwise(operation, left, right):
        if operation == "AND":
            return "".join("0" if "0" in (a, b) else "1" if a == b == "1" else "x" for a, b in zip(left, right))
        if operation == "OR":
            return "".join("1" if "1" in (a, b) else "0" if a == b == "0" else "x" for a, b in zip(left, right))
        return "".join("x" if a not in "01" or b not in "01" else
                       str(int((a != b) == (operation == "XOR"))) for a, b in zip(left, right))

    def evaluate(self, arguments, width, scalar=False):
        stack, current_width = [], None
        for instruction, values in self.instructions:
            if instruction == "WIDTH":
                if len(values) != 1 or not 0 < values[0] <= 65536:
                    raise Unsupported("textual connection width exceeds budget")
                current_width = values[0]
                continue
            if current_width is None:
                raise Unsupported("textual connection operation has no width")
            if instruction == "CALL_ARG_VAL":
                if len(values) != 2 or values[1] or not 2 <= values[0] < self.argument_count + 2:
                    raise Unsupported("textual connection argument index/flags")
                stack.append(arguments[values[0] - 2].rjust(current_width, "0")[-current_width:])
            elif instruction == "OPT_CONST":
                if len(values) != 1:
                    raise Unsupported("textual connection constant arguments")
                stack.append(format(values[0] & ((1 << current_width) - 1), f"0{current_width}b"))
            elif instruction == "CONST":
                stack.append(self.literal(values, current_width))
            elif instruction in ("PAD", "NOT", "XOR_REDUCE"):
                if values or not stack:
                    raise Unsupported("textual unary operation stack/arguments")
                value = stack.pop()
                if instruction == "PAD":
                    value = value.rjust(current_width, "0")[-current_width:]
                elif instruction == "NOT":
                    value = value.rjust(current_width, "0")[-current_width:].translate(str.maketrans("01xz", "10xx"))
                else:
                    value = "x" if any(bit in value for bit in "xz") else str(value.count("1") & 1)
                stack.append(value)
            elif instruction in ("AND", "OR", "XOR", "XNOR"):
                if values or len(stack) < 2:
                    raise Unsupported("textual bitwise operation stack/arguments")
                right, left = stack.pop(), stack.pop()
                stack.append(self.bitwise(instruction, left.rjust(current_width, "0")[-current_width:],
                                          right.rjust(current_width, "0")[-current_width:]))
            elif instruction in ("CONCATENATE", "MULTI_CONCATENATE"):
                if len(values) != (1 if instruction == "CONCATENATE" else 2):
                    raise Unsupported("textual concatenation arguments")
                count, repeat = values[0], values[1] if len(values) > 1 else 1
                if not 0 < count <= len(stack) or not 0 < repeat <= 65536:
                    raise Unsupported("textual concatenation stack or repetition count")
                bits = "".join(stack[-count:])
                if len(bits) * repeat > 65536:
                    raise Unsupported("textual concatenation bit count exceeds budget")
                del stack[-count:]
                stack.append(bits * repeat)
            elif instruction in ("M_EQU", "M_NEQU", "EQU", "M_LT", "M_GT", "M_LE", "M_GE", "SM_GT"):
                if values or len(stack) < 2:
                    raise Unsupported("textual equality stack/arguments")
                right, left = stack.pop(), stack.pop()
                size = max(len(left), len(right))
                left, right = (left.rjust(size, left[0]), right.rjust(size, right[0])) if instruction == "SM_GT" else (left.rjust(size, "0"), right.rjust(size, "0"))
                unknown = any(bit in left + right for bit in "xz")
                if instruction == "EQU":
                    value = "1" if left == right else "0"
                elif instruction in ("M_LT", "M_GT", "M_LE", "M_GE", "SM_GT"):
                    if unknown:
                        value = "x"
                    else:
                        a, b = (self.signed(left), self.signed(right)) if instruction == "SM_GT" else (int(left, 2), int(right, 2))
                        value = str(int({"M_LT": a < b, "M_GT": a > b, "M_LE": a <= b,
                                         "M_GE": a >= b, "SM_GT": a > b}[instruction]))
                else:
                    mismatch = any(a in "01" and b in "01" and a != b for a, b in zip(left, right))
                    value = "0" if mismatch else "x" if unknown else "1"
                    if instruction == "M_NEQU" and value != "x":
                        value = "1" if value == "0" else "0"
                stack.append(value)
            elif instruction in ("SHIFT_L", "SHIFT_R", "SASHIFT_R", "ADD", "SUBTRACT", "SMULTIPLY"):
                if values or len(stack) < 2:
                    raise Unsupported("textual arithmetic stack/arguments")
                right, left = stack.pop(), stack.pop()
                if instruction in ("SHIFT_L", "SHIFT_R", "SASHIFT_R"):
                    amount = None if any(bit in right for bit in "xz") else int(right, 2)
                    fill = left[0] if instruction == "SASHIFT_R" else "0"
                    source = left.rjust(current_width, fill)[-current_width:]
                    if amount is None:
                        value = "x" * current_width
                    elif amount >= current_width:
                        value = fill * current_width
                    elif instruction == "SHIFT_L":
                        value = (source + "0" * amount)[-current_width:]
                    else:
                        value = fill * amount + source[:current_width - amount]
                elif any(bit in left + right for bit in "xz"):
                    value = "x" * current_width
                else:
                    if instruction == "SMULTIPLY":
                        number = self.signed(left) * self.signed(right)
                    else:
                        number = int(left, 2) + int(right, 2) if instruction == "ADD" else int(left, 2) - int(right, 2)
                    value = format(number & ((1 << current_width) - 1), f"0{current_width}b")
                stack.append(value)
            elif instruction == "SLICE":
                if values != (1,) or len(stack) < 2:
                    raise Unsupported("textual slice dimensions/stack")
                bits, source = stack.pop(), stack.pop()
                index = Expression.integer(bits)
                stack.append("x" * current_width if index is None else
                             "".join(source[-1 - i] if 0 <= i < len(source) else "x" for i in reversed(range(index, index + current_width))))
            elif instruction == "MITECONDNOINSTR":
                if values != (4,) or len(stack) < 3:
                    raise Unsupported("textual conditional mode/stack")
                negative, positive, condition = stack.pop(), stack.pop(), stack.pop()
                if "1" in condition:
                    result = positive
                elif not any(bit in condition for bit in "xz"):
                    result = negative
                else:
                    positive, negative = positive.rjust(current_width, "0"), negative.rjust(current_width, "0")
                    result = "".join(a if a == b else "x" for a, b in zip(positive, negative))
                stack.append(result[-current_width:].rjust(current_width, "0"))
            elif instruction == "RET":
                if values or len(stack) != 1:
                    raise Unsupported("textual connection return stack mismatch")
                return stack[0].rjust(width, "0")[-width:]
            if len(stack) > 65536:
                raise Unsupported("textual connection stack exceeds budget")
        raise Unsupported("textual connection return missing")
