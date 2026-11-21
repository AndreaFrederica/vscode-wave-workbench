// SPDX-License-Identifier: MPL-2.0

import type { AssignmentValue } from "./rtl-trace";

export interface TraceOperand {
  width: number;
  signed?: boolean;
  bits?: string;
  range?: readonly [number, number];
  sampledRange?: readonly [number, number];
}

const maxWidth = 4096;

export function normalizeBits(bits: string | undefined, width: number) {
  if (
    !bits ||
    width < 1 ||
    width > maxWidth ||
    bits.length > width ||
    !/^[01xz]+$/i.test(bits)
  )
    return undefined;
  const lower = bits.toLowerCase();
  return lower.padStart(width, /^[xz]/.test(lower) ? lower[0] : "0");
}

export function sliceTraceBits(
  bits: string,
  range: readonly [number, number] | undefined,
  first: number,
  last: number,
) {
  if (!range) return undefined;
  const [left, right] = range;
  if (Math.abs(left - right) + 1 !== bits.length) return undefined;
  const step = left <= right ? 1 : -1;
  const start = (first - left) * step;
  const end = (last - left) * step;
  if (start < 0 || end < start || end >= bits.length) return undefined;
  return bits.slice(start, end + 1);
}

function truth(bits: string) {
  return bits.includes("1") ? "1" : /[xz]/.test(bits) ? "x" : "0";
}

function invert(bit: string) {
  return bit === "0" ? "1" : bit === "1" ? "0" : "x";
}

export function traceInteger(bits: string, signed?: boolean) {
  if (!/^[01]+$/.test(bits) || (bits[0] === "1" && signed === undefined))
    return undefined;
  const magnitude = BigInt("0b" + bits);
  return signed ? BigInt.asIntN(bits.length, magnitude) : magnitude;
}

function bitwise(op: string, left: string, right: string) {
  if (op === "and" && (left === "0" || right === "0")) return "0";
  if (op === "or" && (left === "1" || right === "1")) return "1";
  if (/[xz]/.test(left + right)) return "x";
  if (op === "and") return "1";
  if (op === "or") return "0";
  return left === right ? "0" : "1";
}

type Shape = { width: number; signed?: boolean; fill?: string };
const relationalOperators = new Set([
  "less",
  "lessEqual",
  "greater",
  "greaterEqual",
]);
const shifts = new Set(["shiftLeft", "shiftRight", "arithmeticShiftRight"]);
const arithmetic = {
  add: (left: bigint, right: bigint) => left + right,
  subtract: (left: bigint, right: bigint) => left - right,
  multiply: (left: bigint, right: bigint) => left * right,
  divide: (left: bigint, right: bigint) => left / right,
  modulo: (left: bigint, right: bigint) => left % right,
};

function common(left?: Shape, right?: Shape): Shape | undefined {
  if (!left || !right) return undefined;
  const signed =
    left.signed === false || right.signed === false
      ? false
      : left.signed === true && right.signed === true
        ? true
        : undefined;
  return { width: Math.max(left.width, right.width), signed };
}

function matchMembershipLabel(
  selector: string,
  label: string,
  upper: string | undefined,
  signed: boolean | undefined,
): "0" | "1" | "x" | undefined {
  if (upper !== undefined) {
    if (/[xz]/.test(selector + label + upper)) return "x";
    const value = traceInteger(selector, signed);
    const lowerBound = traceInteger(label, signed);
    const upperBound = traceInteger(upper, signed);
    if (
      value === undefined ||
      lowerBound === undefined ||
      upperBound === undefined
    )
      return undefined;
    return lowerBound <= value && value <= upperBound ? "1" : "0";
  }
  let unknown = false;
  for (let index = 0; index < label.length; index++) {
    const pattern = label[index];
    if (pattern === "x" || pattern === "z") continue;
    const bit = selector[index];
    if (bit === "x" || bit === "z") unknown = true;
    else if (bit !== pattern) return "0";
  }
  return unknown ? "x" : "1";
}

function matchesCase(selector: string, label: string, wildcard?: RegExp) {
  if (!wildcard) return selector === label;
  for (let index = 0; index < selector.length; index++) {
    const left = selector[index];
    const right = label[index];
    if (left !== right && !wildcard.test(left + right)) return false;
  }
  return true;
}

export function traceValueShapes(
  getOperand: (id: number) => TraceOperand | undefined,
) {
  const shapes = new Map<AssignmentValue, Shape | undefined>();

  function shape(node: AssignmentValue): Shape | undefined {
    if (shapes.has(node)) return shapes.get(node);
    const result = infer(node);
    const bounded =
      result &&
      Number.isInteger(result.width) &&
      result.width >= 1 &&
      result.width <= maxWidth
        ? result
        : undefined;
    shapes.set(node, bounded);
    return bounded;
  }

  function infer(node: AssignmentValue): Shape | undefined {
    switch (node.op) {
      case "typeShape":
        return { width: node.args[0], signed: node.args[1] };
      case "generateIndex":
        return undefined;
      case "signal": {
        const value = getOperand(node.args);
        return value && { width: value.width, signed: value.signed };
      }
      case "unsignedBit":
        return { width: 32, signed: true };
      case "fillBit":
        return { width: 1, signed: false, fill: node.args ? "1" : "0" };
      case "fillUnknown":
        return { width: 1, signed: false, fill: node.args };
      case "literal":
        return { width: node.args[0].length, signed: node.args[1] };
      case "select":
        return {
          width: Math.abs(node.args[1] - node.args[2]) + 1,
          signed: false,
        };
      case "slice": {
        const [input, left, right] = node.args;
        const child = shape(input);
        return child && right >= 0 && left >= right && left < child.width
          ? { width: left - right + 1, signed: false }
          : undefined;
      }
      case "bitSelect":
        return { width: 1, signed: false };
      case "indexedPartSelect":
        return { width: node.args[2].width, signed: false };
      case "concat": {
        let width = 0;
        for (const part of node.args) {
          const member = shape(part);
          if (!member || member.fill) return undefined;
          width += member.width;
        }
        return { width, signed: false };
      }
      case "repeat": {
        const [count, part] = node.args;
        const item = shape(part);
        if (!item || item.fill || !Number.isInteger(count) || count < 1)
          return undefined;
        return { width: count * item.width, signed: false };
      }
      case "cast": {
        const [width, signed, , input] = node.args;
        const resolvedWidth = width ?? shape(input)?.width;
        return resolvedWidth && { width: resolvedWidth, signed };
      }
      case "unary": {
        const [op] = node.args;
        if (op !== "bitNot" && op !== "negate")
          return { width: 1, signed: false };
        const input = shape(node.args[1]);
        return (
          input && {
            width: input.width,
            signed: input.signed,
            fill:
              op === "bitNot" && input.fill ? invert(input.fill) : undefined,
          }
        );
      }
      case "binary": {
        const [op, left, right] = node.args;
        if (shifts.has(op)) return shape(left);
        if (
          [
            "and",
            "or",
            "equal",
            "notEqual",
            "caseEqual",
            "caseNotEqual",
            "caseItemEqual",
            "caseItemZ",
            "caseItemX",
          ].includes(op) ||
          relationalOperators.has(op)
        )
          return { width: 1, signed: false };
        return common(shape(left), shape(right));
      }
      case "conditional":
        return common(shape(node.args[1]), shape(node.args[2]));
      case "caseMatch":
      case "membership":
        return { width: 1, signed: false };
    }
  }

  return shape;
}

export function evaluateTraceValue(
  expression: AssignmentValue,
  targetWidth: number | undefined,
  operand: (id: number) => TraceOperand | undefined,
) {
  const operands = new Map<number, TraceOperand | undefined>();
  const inputs = new Set<number>();

  function getOperand(id: number) {
    if (!operands.has(id)) operands.set(id, operand(id));
    return operands.get(id);
  }

  const shape = traceValueShapes(getOperand);

  function read(id: number) {
    inputs.add(id);
    const value = getOperand(id);
    return value && !value.sampledRange
      ? normalizeBits(value.bits, value.width)
      : undefined;
  }

  function readSlice(id: number, first: number, last: number) {
    const value = getOperand(id);
    if (!value?.sampledRange) {
      const bits = read(id);
      return bits && sliceTraceBits(bits, value?.range, first, last);
    }
    inputs.add(id);
    return (
      value.bits && sliceTraceBits(value.bits, value.sampledRange, first, last)
    );
  }

  function fit(
    bits: string | undefined,
    width: number,
    signed: boolean | undefined,
  ) {
    if (bits === undefined || bits.length === width) return bits;
    if (signed === undefined && bits[0] !== "0") return undefined;
    return bits.padStart(width, signed ? bits[0] : "0");
  }

  function evalBits(
    node: AssignmentValue,
    width: number,
    signed: boolean | undefined,
  ): string | undefined {
    const type = shape(node);
    if (!type) return undefined;
    if (type.fill) return type.fill.repeat(width);
    switch (node.op) {
      case "signal":
        return fit(read(node.args), width, signed);
      case "unsignedBit":
        return (node.args ? "1" : "0").padStart(width, "0");
      case "literal":
        return fit(normalizeBits(node.args[0], type.width), width, signed);
      case "select": {
        const [id, first, last] = node.args;
        return fit(readSlice(id, first, last), width, signed);
      }
      case "slice": {
        const [input, left, right] = node.args;
        const bits = natural(input);
        return fit(
          bits && bits.slice(bits.length - 1 - left, bits.length - right),
          width,
          signed,
        );
      }
      case "bitSelect":
      case "indexedPartSelect": {
        const [id, index] = node.args;
        const base = getOperand(id);
        if (
          !base?.range ||
          Math.abs(base.range[0] - base.range[1]) + 1 !== base.width
        )
          return undefined;
        const bits = natural(index);
        if (!bits) return undefined;
        if (/[xz]/.test(bits))
          return fit("x".repeat(type.width), width, signed);
        const slot = traceInteger(bits, shape(index)?.signed);
        if (slot === undefined) return undefined;
        const [left, right] = base.range;
        const ascendingVector = left <= right;
        const ascendingIndices =
          node.op === "bitSelect" || node.args[2].ascendingIndices;
        const first =
          ascendingVector === ascendingIndices
            ? slot
            : slot + BigInt(type.width - 1) * (ascendingIndices ? 1n : -1n);
        const start = (first - BigInt(left)) * (ascendingVector ? 1n : -1n);
        const end = start + BigInt(type.width);
        const vectorWidth = BigInt(base.width);
        if (start >= vectorWidth || end <= 0n)
          return fit("x".repeat(type.width), width, signed);
        const validStart = Number(start < 0n ? 0n : start);
        const validEnd = Number(end > vectorWidth ? vectorWidth : end);
        const stride = ascendingVector ? 1 : -1;
        const selected = readSlice(
          id,
          left + validStart * stride,
          left + (validEnd - 1) * stride,
        );
        if (!selected) return undefined;
        return fit(
          "x".repeat(start < 0n ? Number(-start) : 0) +
            selected +
            "x".repeat(end > vectorWidth ? Number(end - vectorWidth) : 0),
          width,
          signed,
        );
      }
      case "concat": {
        let bits = "";
        for (const part of node.args) {
          const piece = natural(part);
          if (!piece) return undefined;
          bits += piece;
        }
        return fit(bits, width, signed);
      }
      case "repeat": {
        const [count, part] = node.args;
        return fit(natural(part)?.repeat(count), width, signed);
      }
      case "cast": {
        const [castWidth, , twoState, input] = node.args;
        const child = shape(input);
        if (!child) return undefined;
        const size = castWidth ?? child.width;
        if (!Number.isInteger(size) || size < 1 || size > maxWidth)
          return undefined;
        const bits = evalBits(
          input,
          Math.max(size, child.width),
          child.signed,
        )?.slice(-size);
        return fit(
          twoState ? bits?.replace(/[xz]/g, "0") : bits,
          width,
          signed,
        );
      }
      case "unary": {
        const [op, item] = node.args;
        const bits =
          op === "bitNot" || op === "negate"
            ? evalBits(item, width, signed)
            : natural(item);
        if (!bits) return undefined;
        if (op === "bitNot") return Array.from(bits, invert).join("");
        if (op === "negate")
          return /[xz]/.test(bits)
            ? "x".repeat(width)
            : BigInt.asUintN(width, -BigInt("0b" + bits))
                .toString(2)
                .padStart(width, "0");
        if (op === "not") return fit(invert(truth(bits)), width, signed);
        if (op === "reduceOr") return fit(truth(bits), width, signed);
        if (op === "reduceAnd")
          return fit(
            bits.includes("0") ? "0" : /[xz]/.test(bits) ? "x" : "1",
            width,
            signed,
          );
        return fit(
          Array.from(bits).reduce(
            (left, right) => bitwise("xor", left, right),
            "0",
          ),
          width,
          signed,
        );
      }
      case "binary": {
        const [op, lhs, rhs] = node.args;
        if (op === "and" || op === "or") {
          const left = natural(lhs);
          const right = natural(rhs);
          const decisive = op === "and" ? "0" : "1";
          if (
            (left && truth(left) === decisive) ||
            (right && truth(right) === decisive)
          )
            return fit(decisive, width, signed);
          return fit(
            left && right ? bitwise(op, truth(left), truth(right)) : undefined,
            width,
            signed,
          );
        }
        if (shifts.has(op)) {
          const left = evalBits(lhs, width, signed);
          const right = natural(rhs);
          if (!left || !right) return undefined;
          if (/[xz]/.test(right)) return "x".repeat(width);
          const amount = BigInt("0b" + right);
          const offset = amount >= BigInt(width) ? width : Number(amount);
          if (offset === 0) return left;
          if (op === "shiftLeft")
            return left.slice(offset) + "0".repeat(offset);
          if (
            op === "arithmeticShiftRight" &&
            signed === undefined &&
            left[0] !== "0"
          )
            return undefined;
          const fill = op === "arithmeticShiftRight" && signed ? left[0] : "0";
          return fill.repeat(offset) + left.slice(0, width - offset);
        }
        const lhsType = shape(lhs);
        const rhsType = shape(rhs);
        const types = common(lhsType, rhsType);
        if (!types) return undefined;
        const caseItem =
          op === "caseItemEqual" || op === "caseItemZ" || op === "caseItemX";
        const caseComparison =
          op === "caseEqual" || op === "caseNotEqual" || caseItem;
        const relational = relationalOperators.has(op);
        const comparison =
          caseComparison || op === "equal" || op === "notEqual" || relational;
        // Another case item can supply the comparison's width or signedness.
        if (
          caseItem &&
          (lhsType?.fill ||
            rhsType?.fill ||
            lhsType?.width !== rhsType?.width ||
            [lhs, rhs].some(
              (item) =>
                item.op === "binary" ||
                item.op === "unary" ||
                item.op === "conditional",
            ))
        )
          return undefined;
        const operandWidth = comparison ? types.width : width;
        const operandSigned = comparison ? types.signed : signed;
        const left = evalBits(lhs, operandWidth, operandSigned);
        const right = evalBits(rhs, operandWidth, operandSigned);
        if (!left || !right) return undefined;
        if (caseComparison) {
          const wild =
            op === "caseItemZ" ? /z/ : op === "caseItemX" ? /[xz]/ : undefined;
          const matched = matchesCase(left, right, wild);
          return fit(
            matched === (op !== "caseNotEqual") ? "1" : "0",
            width,
            signed,
          );
        }
        if (op === "equal" || op === "notEqual") {
          const difference = Array.from(left).some(
            (bit, i) =>
              /^[01]$/.test(bit) && /^[01]$/.test(right[i]) && bit !== right[i],
          );
          return fit(
            difference
              ? op === "equal"
                ? "0"
                : "1"
              : /[xz]/.test(left + right)
                ? "x"
                : op === "equal"
                  ? "1"
                  : "0",
            width,
            signed,
          );
        }
        if (relational) {
          if (/[xz]/.test(left + right)) return fit("x", width, signed);
          if (operandSigned === undefined && left[0] !== right[0])
            return undefined;
          const integer = (bits: string) => {
            const value = BigInt("0b" + bits);
            return operandSigned ? BigInt.asIntN(operandWidth, value) : value;
          };
          const a = integer(left);
          const b = integer(right);
          const matched =
            op === "less"
              ? a < b
              : op === "lessEqual"
                ? a <= b
                : op === "greater"
                  ? a > b
                  : a >= b;
          return fit(matched ? "1" : "0", width, signed);
        }
        if (Object.hasOwn(arithmetic, op)) {
          if (/[xz]/.test(left + right)) return "x".repeat(width);
          const requiresSign = op === "divide" || op === "modulo";
          const interpretation = requiresSign ? signed : false;
          const lhsValue = traceInteger(left, interpretation);
          const rhsValue = traceInteger(right, interpretation);
          if (requiresSign && rhsValue === 0n) return "x".repeat(width);
          if (lhsValue === undefined || rhsValue === undefined)
            return undefined;
          const value = arithmetic[op as keyof typeof arithmetic](
            lhsValue,
            rhsValue,
          );
          return BigInt.asUintN(width, value).toString(2).padStart(width, "0");
        }
        const operation =
          op === "bitAnd" ? "and" : op === "bitOr" ? "or" : "xor";
        return Array.from(left, (bit, i) =>
          bitwise(operation, bit, right[i]),
        ).join("");
      }
      case "conditional": {
        const [condition, yes, no] = node.args;
        const test = natural(condition);
        if (!test) return undefined;
        const selected = truth(test);
        if (selected !== "x")
          return evalBits(selected === "1" ? yes : no, width, signed);
        const left = evalBits(yes, width, signed);
        const right = evalBits(no, width, signed);
        return left && right
          ? Array.from(left, (bit, i) => (bit === right[i] ? bit : "x")).join(
              "",
            )
          : undefined;
      }
      case "caseMatch":
      case "membership": {
        const [selector, labels, [first, end]] = node.args;
        const kind = node.op === "caseMatch" ? node.args[3] : "inside";
        const wild =
          kind === "wildcardZ"
            ? /z/
            : kind === "wildcardX"
              ? /[xz]/
              : undefined;
        let comparison = shape(selector);
        // All labels determine the comparison type, including later arms.
        for (const label of labels) {
          comparison = common(comparison, shape(label[0]));
          if (label[1]) comparison = common(comparison, shape(label[1]));
        }
        if (!comparison) return undefined;
        const { width: operandWidth, signed: operandSigned } = comparison;
        const left = evalBits(selector, operandWidth, operandSigned);
        if (!left) return undefined;
        let result: "0" | "x" | undefined = "0";
        for (const [firstTerm, lastTerm] of labels.slice(first, end)) {
          const lower = evalBits(firstTerm, operandWidth, operandSigned);
          const upper =
            lastTerm && evalBits(lastTerm, operandWidth, operandSigned);
          if (!lower || (lastTerm && !upper)) {
            result = undefined;
            continue;
          }
          const match =
            kind === "inside"
              ? matchMembershipLabel(left, lower, upper, operandSigned)
              : matchesCase(left, lower, wild)
                ? "1"
                : "0";
          if (match === "1") return fit("1", width, signed);
          if (match === undefined || (match === "x" && result !== undefined))
            result = match;
        }
        return fit(result, width, signed);
      }
    }
  }

  function natural(node: AssignmentValue) {
    const type = shape(node);
    return type && evalBits(node, type.width, type.signed);
  }

  const type = shape(expression);
  if (!type) return undefined;
  targetWidth ??= type.width;
  if (
    !Number.isInteger(targetWidth) ||
    targetWidth < 1 ||
    targetWidth > maxWidth
  )
    return undefined;
  const bits = evalBits(
    expression,
    Math.max(targetWidth, type.width),
    type.signed,
  );
  if (!bits) return undefined;
  return {
    bits: bits.slice(-targetWidth),
    inputs: [...inputs],
    signed: type.signed,
  };
}
