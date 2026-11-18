// SPDX-License-Identifier: MPL-2.0

const x = (n: number) => "x" + n;
const signed = (n: number, width: number) =>
  (n << (32 - width)) >> (32 - width);

export function disassembleRv32(
  word: number,
  zfinx: boolean,
): string | undefined {
  if ((word & 3) !== 3) return compressed(word & 0xffff, zfinx);
  if ((word & 31) === 31) return;
  const opcode = word & 127;
  const rd = (word >>> 7) & 31,
    rs1 = (word >>> 15) & 31,
    rs2 = (word >>> 20) & 31;
  const f3 = (word >>> 12) & 7,
    f7 = word >>> 25;
  const imm = word >> 20;
  const store = signed((f7 << 5) | rd, 12);
  const r = (op: string, ...args: (string | number)[]) =>
    (op && (args.length ? op + " " + args.join(", ") : op)) || undefined;
  const f = (n: number) => (zfinx ? "x" : "f") + n;
  const rm = ["rne", "rtz", "rdn", "rup", "rmm", "", "", "dyn"][f3];
  switch (opcode) {
    case 0x37:
    case 0x17:
      return r(
        opcode === 0x37 ? "lui" : "auipc",
        x(rd),
        "0x" + (word >>> 12).toString(16),
      );
    case 0x6f: {
      const offset =
        ((word >>> 31) << 20) |
        (((word >>> 12) & 255) << 12) |
        (((word >>> 20) & 1) << 11) |
        (((word >>> 21) & 1023) << 1);
      return r("jal", x(rd), signed(offset, 21));
    }
    case 0x67:
      return f3 === 0 ? r("jalr", x(rd), `${imm}(${x(rs1)})`) : undefined;
    case 0x63: {
      const offset =
        ((word >>> 31) << 12) |
        ((rd & 1) << 11) |
        (((word >>> 25) & 63) << 5) |
        (rd & 30);
      return r(
        ["beq", "bne", "", "", "blt", "bge", "bltu", "bgeu"][f3],
        x(rs1),
        x(rs2),
        signed(offset, 13),
      );
    }
    case 0x03:
      return r(
        ["lb", "lh", "lw", "", "lbu", "lhu", "", ""][f3],
        x(rd),
        `${imm}(${x(rs1)})`,
      );
    case 0x23:
      return r(
        ["sb", "sh", "sw", "", "", "", "", ""][f3],
        x(rs2),
        `${store}(${x(rs1)})`,
      );
    case 0x13:
      if (word === 0x13) return "nop";
      if (f3 === 1 || f3 === 5)
        return r(
          f7 === 0
            ? f3 === 1
              ? "slli"
              : "srli"
            : f7 === 32 && f3 === 5
              ? "srai"
              : "",
          x(rd),
          x(rs1),
          rs2,
        );
      return r(
        ["addi", "", "slti", "sltiu", "xori", "", "ori", "andi"][f3],
        x(rd),
        x(rs1),
        imm,
      );
    case 0x33: {
      const name =
        f7 === 0
          ? ["add", "sll", "slt", "sltu", "xor", "srl", "or", "and"][f3]
          : f7 === 1
            ? ["mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu"][
                f3
              ]
            : f7 === 32
              ? ["sub", "", "", "", "", "sra", "", ""][f3]
              : "";
      return r(name, x(rd), x(rs1), x(rs2));
    }
    case 0x0f: {
      if (word === 0x0000100f) return "fence.i";
      if (f3 !== 0 || rd || rs1) return;
      if (word === 0x8330000f) return "fence.tso";
      if (word >>> 28) return;
      const flags = (value: number) =>
        [..."iorw"].filter((_, i) => value & (8 >> i)).join("") || "0";
      return r("fence", flags((word >>> 24) & 15), flags((word >>> 20) & 15));
    }
    case 0x73: {
      if (f3 === 0)
        return (
          {
            0x73: "ecall",
            0x00100073: "ebreak",
            0x30200073: "mret",
            0x10500073: "wfi",
            0x7b200073: "dret",
          } as Record<number, string>
        )[word];
      const csr = ((word >>> 20) & 4095).toString(16);
      return r(
        ["", "csrrw", "csrrs", "csrrc", "", "csrrwi", "csrrsi", "csrrci"][f3],
        x(rd),
        "0x" + csr,
        f3 >= 5 ? rs1 : x(rs1),
      );
    }
    case 0x07:
      return !zfinx && f3 === 2
        ? r("flw", f(rd), `${imm}(${x(rs1)})`)
        : undefined;
    case 0x27:
      return !zfinx && f3 === 2
        ? r("fsw", f(rs2), `${store}(${x(rs1)})`)
        : undefined;
    case 0x43:
    case 0x47:
    case 0x4b:
    case 0x4f:
      return rm && ((word >>> 25) & 3) === 0
        ? r(
            ["fmadd.s", "fmsub.s", "fnmsub.s", "fnmadd.s"][(opcode - 0x43) / 4],
            f(rd),
            f(rs1),
            f(rs2),
            f(word >>> 27),
            rm,
          )
        : undefined;
    case 0x53: {
      const arithmetic = (
        { 0: "fadd.s", 4: "fsub.s", 8: "fmul.s", 12: "fdiv.s" } as Record<
          number,
          string
        >
      )[f7];
      if (arithmetic && rm) return r(arithmetic, f(rd), f(rs1), f(rs2), rm);
      if (f7 === 44 && rs2 === 0 && rm) return r("fsqrt.s", f(rd), f(rs1), rm);
      if (f7 === 16)
        return r(
          ["fsgnj.s", "fsgnjn.s", "fsgnjx.s"][f3],
          f(rd),
          f(rs1),
          f(rs2),
        );
      if (f7 === 20) return r(["fmin.s", "fmax.s"][f3], f(rd), f(rs1), f(rs2));
      if (f7 === 80)
        return r(["fle.s", "flt.s", "feq.s"][f3], x(rd), f(rs1), f(rs2));
      if (f7 === 96 && rs2 < 2 && rm)
        return r("fcvt." + (rs2 ? "wu" : "w") + ".s", x(rd), f(rs1), rm);
      if (f7 === 104 && rs2 < 2 && rm)
        return r("fcvt.s." + (rs2 ? "wu" : "w"), f(rd), x(rs1), rm);
      if (f7 === 112 && rs2 === 0 && f3 === 1)
        return r("fclass.s", x(rd), f(rs1));
      if (!zfinx && f7 === 112 && rs2 === 0 && f3 === 0)
        return r("fmv.x.w", x(rd), f(rs1));
      if (!zfinx && f7 === 120 && rs2 === 0 && f3 === 0)
        return r("fmv.w.x", f(rd), x(rs1));
      return;
    }
  }
}

function compressed(word: number, zfinx: boolean): string | undefined {
  const q = word & 3,
    f3 = word >>> 13;
  const rd = (word >>> 7) & 31,
    rs2 = (word >>> 2) & 31;
  const rp = 8 + (rd & 7),
    sp = 8 + (rs2 & 7);
  const bit12 = (word >>> 12) & 1;
  const imm = signed((bit12 << 5) | rs2, 6);
  if (q === 0) {
    if (f3 === 0) {
      const offset =
        ((word >>> 1) & 0x3c0) |
        ((word >>> 7) & 0x30) |
        ((word >>> 2) & 8) |
        ((word >>> 4) & 4);
      if (offset) return `c.addi4spn ${x(sp)}, ${offset}`;
    }
    const offset =
      ((word >>> 7) & 0x38) | ((word >>> 4) & 4) | ((word << 1) & 0x40);
    if (f3 === 2 || f3 === 6)
      return `c.${f3 === 2 ? "lw" : "sw"} ${x(sp)}, ${offset}(${x(rp)})`;
    if (!zfinx && (f3 === 3 || f3 === 7))
      return `c.${f3 === 3 ? "flw" : "fsw"} f${sp}, ${offset}(${x(rp)})`;
  }
  if (q === 1) {
    if (f3 === 0) return word === 1 ? "c.nop" : `c.addi ${x(rd)}, ${imm}`;
    if (f3 === 2) return `c.li ${x(rd)}, ${imm}`;
    if (f3 === 3 && rd && imm) {
      const offset =
        (bit12 << 9) |
        ((word >>> 2) & 0x10) |
        ((word << 1) & 0x40) |
        ((word << 4) & 0x180) |
        ((word << 3) & 0x20);
      return rd === 2
        ? `c.addi16sp ${signed(offset, 10)}`
        : `c.lui ${x(rd)}, ${imm}`;
    }
    if (f3 === 1 || f3 === 5) {
      const offset =
        (bit12 << 11) |
        ((word >>> 7) & 0x10) |
        ((word >>> 1) & 0x300) |
        ((word << 2) & 0x400) |
        ((word >>> 1) & 0x40) |
        ((word << 1) & 0x80) |
        ((word >>> 2) & 0xe) |
        ((word << 3) & 0x20);
      return `c.${f3 === 1 ? "jal" : "j"} ${signed(offset, 12)}`;
    }
    if (f3 === 4) {
      const op = (word >>> 10) & 3;
      if (op === 2) return `c.andi ${x(rp)}, ${imm}`;
      if (bit12) return;
      if (op < 2) return `c.${op ? "srai" : "srli"} ${x(rp)}, ${rs2}`;
      return `c.${["sub", "xor", "or", "and"][(word >>> 5) & 3]} ${x(rp)}, ${x(sp)}`;
    }
    if (f3 === 6 || f3 === 7) {
      const offset =
        (bit12 << 8) |
        ((word >>> 7) & 0x18) |
        ((word << 1) & 0xc0) |
        ((word >>> 2) & 0x6) |
        ((word << 3) & 0x20);
      return `c.${f3 === 6 ? "beqz" : "bnez"} ${x(rp)}, ${signed(offset, 9)}`;
    }
  }
  if (q === 2) {
    if (f3 === 0 && !bit12) return `c.slli ${x(rd)}, ${rs2}`;
    if ((f3 === 2 && rd) || (f3 === 3 && !zfinx)) {
      const offset =
        (bit12 << 5) | ((word >>> 2) & 0x1c) | ((word << 4) & 0xc0);
      return `c.${f3 === 2 ? "lwsp " + x(rd) : "flwsp f" + rd}, ${offset}(x2)`;
    }
    if (f3 === 4) {
      if (!bit12 && rd && !rs2) return `c.jr ${x(rd)}`;
      if (bit12 && !rd && !rs2) return "c.ebreak";
      if (bit12 && rd && !rs2) return `c.jalr ${x(rd)}`;
      if (rs2) return `c.${bit12 ? "add" : "mv"} ${x(rd)}, ${x(rs2)}`;
    }
    if (f3 === 6 || (f3 === 7 && !zfinx)) {
      const offset = ((word >>> 7) & 0x3c) | ((word >>> 1) & 0xc0);
      return `c.${f3 === 6 ? "swsp " + x(rs2) : "fswsp f" + rs2}, ${offset}(x2)`;
    }
  }
}
