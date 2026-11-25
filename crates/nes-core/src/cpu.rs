const CARRY: u8 = 1;
const ZERO: u8 = 2;
const INTERRUPT: u8 = 4;
const DECIMAL: u8 = 8;
const BREAK: u8 = 16;
const UNUSED: u8 = 32;
const OVERFLOW: u8 = 64;
const NEGATIVE: u8 = 128;

pub(crate) trait CpuBus {
    fn read(&mut self, addr: u16) -> u8;
    fn write(&mut self, addr: u16, value: u8);
    fn take_nmi(&mut self) -> bool;
    fn irq(&self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuState {
    pub pc: u16,
    pub a: u8,
    pub x: u8,
    pub y: u8,
    pub sp: u8,
    pub status: u8,
    pub halted: bool,
}

pub(crate) struct Cpu {
    state: CpuState,
    irq_masked: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Implied,
    Accumulator,
    Immediate,
    Zero,
    ZeroX,
    ZeroY,
    Absolute,
    AbsoluteX,
    AbsoluteY,
    Indirect,
    IndirectX,
    IndirectY,
    Relative,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Read,
    Write,
    Modify,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Adc,
    Ahx,
    Alr,
    Anc,
    And,
    Arr,
    Asl,
    Axs,
    Bcc,
    Bcs,
    Beq,
    Bit,
    Bmi,
    Bne,
    Bpl,
    Brk,
    Bvc,
    Bvs,
    Clc,
    Cld,
    Cli,
    Clv,
    Cmp,
    Cpx,
    Cpy,
    Dcp,
    Dec,
    Dex,
    Dey,
    Eor,
    Inc,
    Inx,
    Iny,
    Isc,
    Jmp,
    Jsr,
    Ky,
    Las,
    Lax,
    Lda,
    Ldx,
    Ldy,
    Lsr,
    Nop,
    Ora,
    Pha,
    Php,
    Pla,
    Plp,
    Rla,
    Rol,
    Ror,
    Rra,
    Rti,
    Rts,
    Sax,
    Sbc,
    Sec,
    Sed,
    Sei,
    Shx,
    Shy,
    Slo,
    Sre,
    Sta,
    Stx,
    Sty,
    Tas,
    Tax,
    Tay,
    Tsx,
    Txa,
    Txs,
    Tya,
    Xaa,
}

use Op::*;

#[rustfmt::skip]
const OPCODES: [(Op, Mode); 256] = {
    use Mode::{Implied as I, Accumulator as A, Immediate as M, Zero as Z, ZeroX as U, ZeroY as V, Absolute as D, AbsoluteX as C, AbsoluteY as B, Indirect as J, IndirectX as X, IndirectY as Y, Relative as R};
    [
        // 00–0F
        (Brk, I), (Ora, X), (Ky, I), (Slo, X), (Nop, Z), (Ora, Z), (Asl, Z), (Slo, Z),
        (Php, I), (Ora, M), (Asl, A), (Anc, M), (Nop, D), (Ora, D), (Asl, D), (Slo, D),
        // 10–1F
        (Bpl, R), (Ora, Y), (Ky, I), (Slo, Y), (Nop, U), (Ora, U), (Asl, U), (Slo, U),
        (Clc, I), (Ora, B), (Nop, I), (Slo, B), (Nop, C), (Ora, C), (Asl, C), (Slo, C),
        // 20–2F
        (Jsr, D), (And, X), (Ky, I), (Rla, X), (Bit, Z), (And, Z), (Rol, Z), (Rla, Z),
        (Plp, I), (And, M), (Rol, A), (Anc, M), (Bit, D), (And, D), (Rol, D), (Rla, D),
        // 30–3F
        (Bmi, R), (And, Y), (Ky, I), (Rla, Y), (Nop, U), (And, U), (Rol, U), (Rla, U),
        (Sec, I), (And, B), (Nop, I), (Rla, B), (Nop, C), (And, C), (Rol, C), (Rla, C),
        // 40–4F
        (Rti, I), (Eor, X), (Ky, I), (Sre, X), (Nop, Z), (Eor, Z), (Lsr, Z), (Sre, Z),
        (Pha, I), (Eor, M), (Lsr, A), (Alr, M), (Jmp, D), (Eor, D), (Lsr, D), (Sre, D),
        // 50–5F
        (Bvc, R), (Eor, Y), (Ky, I), (Sre, Y), (Nop, U), (Eor, U), (Lsr, U), (Sre, U),
        (Cli, I), (Eor, B), (Nop, I), (Sre, B), (Nop, C), (Eor, C), (Lsr, C), (Sre, C),
        // 60–6F
        (Rts, I), (Adc, X), (Ky, I), (Rra, X), (Nop, Z), (Adc, Z), (Ror, Z), (Rra, Z),
        (Pla, I), (Adc, M), (Ror, A), (Arr, M), (Jmp, J), (Adc, D), (Ror, D), (Rra, D),
        // 70–7F
        (Bvs, R), (Adc, Y), (Ky, I), (Rra, Y), (Nop, U), (Adc, U), (Ror, U), (Rra, U),
        (Sei, I), (Adc, B), (Nop, I), (Rra, B), (Nop, C), (Adc, C), (Ror, C), (Rra, C),
        // 80–8F
        (Nop, M), (Sta, X), (Nop, M), (Sax, X), (Sty, Z), (Sta, Z), (Stx, Z), (Sax, Z),
        (Dey, I), (Nop, M), (Txa, I), (Xaa, M), (Sty, D), (Sta, D), (Stx, D), (Sax, D),
        // 90–9F
        (Bcc, R), (Sta, Y), (Ky, I), (Ahx, Y), (Sty, U), (Sta, U), (Stx, V), (Sax, V),
        (Tya, I), (Sta, B), (Txs, I), (Tas, B), (Shy, C), (Sta, C), (Shx, B), (Ahx, B),
        // A0–AF
        (Ldy, M), (Lda, X), (Ldx, M), (Lax, X), (Ldy, Z), (Lda, Z), (Ldx, Z), (Lax, Z),
        (Tay, I), (Lda, M), (Tax, I), (Lax, M), (Ldy, D), (Lda, D), (Ldx, D), (Lax, D),
        // B0–BF
        (Bcs, R), (Lda, Y), (Ky, I), (Lax, Y), (Ldy, U), (Lda, U), (Ldx, V), (Lax, V),
        (Clv, I), (Lda, B), (Tsx, I), (Las, B), (Ldy, C), (Lda, C), (Ldx, B), (Lax, B),
        // C0–CF
        (Cpy, M), (Cmp, X), (Nop, M), (Dcp, X), (Cpy, Z), (Cmp, Z), (Dec, Z), (Dcp, Z),
        (Iny, I), (Cmp, M), (Dex, I), (Axs, M), (Cpy, D), (Cmp, D), (Dec, D), (Dcp, D),
        // D0–DF
        (Bne, R), (Cmp, Y), (Ky, I), (Dcp, Y), (Nop, U), (Cmp, U), (Dec, U), (Dcp, U),
        (Cld, I), (Cmp, B), (Nop, I), (Dcp, B), (Nop, C), (Cmp, C), (Dec, C), (Dcp, C),
        // E0–EF
        (Cpx, M), (Sbc, X), (Nop, M), (Isc, X), (Cpx, Z), (Sbc, Z), (Inc, Z), (Isc, Z),
        (Inx, I), (Sbc, M), (Nop, I), (Sbc, M), (Cpx, D), (Sbc, D), (Inc, D), (Isc, D),
        // F0–FF
        (Beq, R), (Sbc, Y), (Ky, I), (Isc, Y), (Nop, U), (Sbc, U), (Inc, U), (Isc, U),
        (Sed, I), (Sbc, B), (Nop, I), (Isc, B), (Nop, C), (Sbc, C), (Inc, C), (Isc, C),
    ]
};

impl Cpu {
    pub fn new() -> Self {
        Self {
            state: CpuState {
                pc: 0,
                a: 0,
                x: 0,
                y: 0,
                sp: 0,
                status: INTERRUPT | UNUSED,
                halted: false,
            },
            irq_masked: true,
        }
    }

    pub fn state(&self) -> CpuState {
        self.state
    }

    pub fn reset(&mut self, bus: &mut impl CpuBus) {
        self.state.halted = false;
        bus.read(self.state.pc);
        bus.read(self.state.pc);
        for _ in 0..3 {
            bus.read(0x100 | u16::from(self.state.sp));
            self.state.sp = self.state.sp.wrapping_sub(1);
        }
        self.set(INTERRUPT, true);
        self.irq_masked = true;
        self.state.pc = Self::vector(bus, 0xfffc);
    }

    fn vector(bus: &mut impl CpuBus, address: u16) -> u16 {
        u16::from_le_bytes([bus.read(address), bus.read(address + 1)])
    }

    fn fetch(&mut self, bus: &mut impl CpuBus) -> u8 {
        let byte = bus.read(self.state.pc);
        self.state.pc = self.state.pc.wrapping_add(1);
        byte
    }

    fn word(&mut self, bus: &mut impl CpuBus) -> u16 {
        u16::from_le_bytes([self.fetch(bus), self.fetch(bus)])
    }

    fn dummy(&self, bus: &mut impl CpuBus) {
        bus.read(self.state.pc);
    }

    fn push(&mut self, bus: &mut impl CpuBus, value: u8) {
        bus.write(0x100 | u16::from(self.state.sp), value);
        self.state.sp = self.state.sp.wrapping_sub(1);
    }

    fn stack_dummy(&self, bus: &mut impl CpuBus) {
        bus.read(0x100 | u16::from(self.state.sp));
    }

    fn pull(&mut self, bus: &mut impl CpuBus) -> u8 {
        self.state.sp = self.state.sp.wrapping_add(1);
        bus.read(0x100 | u16::from(self.state.sp))
    }

    fn flag(&self, bit: u8) -> bool {
        self.state.status & bit != 0
    }

    fn set(&mut self, bit: u8, set: bool) {
        if set {
            self.state.status |= bit;
        } else {
            self.state.status &= !bit;
        }
    }

    fn nz(&mut self, val: u8) {
        self.set(ZERO, val == 0);
        self.set(NEGATIVE, val & 0x80 != 0);
    }

    fn adc(&mut self, val: u8) {
        let old = self.state.a;
        let sum = u16::from(old) + u16::from(val) + u16::from(self.flag(CARRY));
        let out = sum as u8;
        self.set(CARRY, sum > 255);
        self.set(OVERFLOW, (old ^ out) & (val ^ out) & 0x80 != 0);
        self.state.a = out;
        self.nz(out);
    }

    fn compare(&mut self, reg: u8, val: u8) {
        self.set(CARRY, reg >= val);
        self.nz(reg.wrapping_sub(val));
    }

    fn interrupt(&mut self, bus: &mut impl CpuBus, nmi: bool, software: bool) {
        if software {
            self.fetch(bus);
        } else {
            self.dummy(bus);
            self.dummy(bus);
        }
        let [lo, hi] = self.state.pc.to_le_bytes();
        self.push(bus, hi);
        self.push(bus, lo);
        self.push(bus, self.state.status | if software { BREAK } else { 0 });
        self.set(INTERRUPT, true);
        let address = if nmi || bus.take_nmi() {
            0xfffa
        } else {
            0xfffe
        };
        self.state.pc = Self::vector(bus, address);
        self.irq_masked = true;
    }

    fn branch(&mut self, bus: &mut impl CpuBus, take: bool) {
        let displacement = self.fetch(bus) as i8;
        if take {
            let old = self.state.pc;
            let next = old.wrapping_add_signed(i16::from(displacement));
            bus.read(old);
            if old & 0xff00 != next & 0xff00 {
                bus.read((old & 0xff00) | (next & 0xff));
            }
            self.state.pc = next;
        }
    }

    fn address(&mut self, bus: &mut impl CpuBus, mode: Mode, access: Access) -> (u16, u16) {
        let (base, increment) = match mode {
            Mode::Immediate => {
                let addr = self.state.pc;
                self.state.pc = addr.wrapping_add(1);
                return (addr, addr);
            }
            Mode::Zero => (u16::from(self.fetch(bus)), 0),
            Mode::ZeroX | Mode::ZeroY => {
                let zero = self.fetch(bus);
                bus.read(u16::from(zero));
                let index = if mode == Mode::ZeroX {
                    self.state.x
                } else {
                    self.state.y
                };
                (u16::from(zero.wrapping_add(index)), 0)
            }
            Mode::Absolute | Mode::AbsoluteX | Mode::AbsoluteY => {
                let base = self.word(bus);
                let index = match mode {
                    Mode::AbsoluteX => self.state.x,
                    Mode::AbsoluteY => self.state.y,
                    _ => 0,
                };
                (base, index)
            }
            Mode::IndirectX | Mode::IndirectY => {
                let mut zero = self.fetch(bus);
                if mode == Mode::IndirectX {
                    bus.read(u16::from(zero));
                    zero = zero.wrapping_add(self.state.x);
                }
                let base = u16::from_le_bytes([
                    bus.read(u16::from(zero)),
                    bus.read(u16::from(zero.wrapping_add(1))),
                ]);
                (
                    base,
                    if mode == Mode::IndirectY {
                        self.state.y
                    } else {
                        0
                    },
                )
            }
            _ => unreachable!(),
        };
        let address = base.wrapping_add(u16::from(increment));
        let dummy = (base & 0xff00) | (address & 0xff);
        if matches!(mode, Mode::AbsoluteX | Mode::AbsoluteY | Mode::IndirectY)
            && (access != Access::Read || address != dummy)
        {
            bus.read(dummy);
        }
        (address, base)
    }

    pub fn step(&mut self, bus: &mut impl CpuBus) {
        if self.state.halted {
            self.dummy(bus);
            return;
        }
        let nmi = bus.take_nmi();
        if nmi || (!self.irq_masked && bus.irq()) {
            self.interrupt(bus, nmi, false);
            return;
        }
        let old_i = self.flag(INTERRUPT);
        let (op, mode) = OPCODES[usize::from(self.fetch(bus))];
        match op {
            Brk => self.interrupt(bus, false, true),
            Jmp => {
                let addr = self.word(bus);
                self.state.pc = if mode == Mode::Indirect {
                    let next = (addr & 0xff00) | (addr.wrapping_add(1) & 0xff);
                    u16::from_le_bytes([bus.read(addr), bus.read(next)])
                } else {
                    addr
                };
            }
            Jsr => {
                let low = self.fetch(bus);
                self.stack_dummy(bus);
                let [ret_lo, ret_hi] = self.state.pc.to_le_bytes();
                self.push(bus, ret_hi);
                self.push(bus, ret_lo);
                self.state.pc = u16::from_le_bytes([low, self.fetch(bus)]);
            }
            Rts | Rti => {
                self.dummy(bus);
                self.stack_dummy(bus);
                if op == Rti {
                    self.state.status = (self.pull(bus) | UNUSED) & !BREAK;
                }
                self.state.pc = u16::from_le_bytes([self.pull(bus), self.pull(bus)]);
                if op == Rts {
                    self.dummy(bus);
                    self.state.pc = self.state.pc.wrapping_add(1);
                }
            }
            Bpl | Bmi | Bvc | Bvs | Bcc | Bcs | Bne | Beq => {
                let condition = match op {
                    Bpl => !self.flag(NEGATIVE),
                    Bmi => self.flag(NEGATIVE),
                    Bvc => !self.flag(OVERFLOW),
                    Bvs => self.flag(OVERFLOW),
                    Bcc => !self.flag(CARRY),
                    Bcs => self.flag(CARRY),
                    Bne => !self.flag(ZERO),
                    Beq => self.flag(ZERO),
                    _ => unreachable!(),
                };
                self.branch(bus, condition);
            }
            _ if mode == Mode::Implied => self.implied(bus, op),
            _ if mode == Mode::Accumulator => {
                self.dummy(bus);
                self.state.a = self.modify(op, self.state.a);
            }
            Sta | Stx | Sty | Sax | Ahx | Shx | Shy | Tas => {
                let (mut addr, base) = self.address(bus, mode, Access::Write);
                let high = ((base >> 8) as u8).wrapping_add(1);
                let value = match op {
                    Sta => self.state.a,
                    Stx => self.state.x,
                    Sty => self.state.y,
                    Sax => self.state.a & self.state.x,
                    Ahx => self.state.a & self.state.x & high,
                    Shx => self.state.x & high,
                    Shy => self.state.y & high,
                    Tas => {
                        self.state.sp = self.state.a & self.state.x;
                        self.state.sp & high
                    }
                    _ => unreachable!(),
                };
                if matches!(op, Ahx | Shx | Shy | Tas) && addr & 0xff00 != base & 0xff00 {
                    addr = (u16::from(value) << 8) | (addr & 0xff);
                }
                bus.write(addr, value);
            }
            Asl | Lsr | Rol | Ror | Inc | Dec | Slo | Sre | Rla | Rra | Dcp | Isc => {
                let (addr, _) = self.address(bus, mode, Access::Modify);
                let old = bus.read(addr);
                bus.write(addr, old);
                let new = self.modify(op, old);
                bus.write(addr, new);
            }
            _ => {
                let (addr, _) = self.address(bus, mode, Access::Read);
                self.operand(op, bus.read(addr));
            }
        }
        self.irq_masked = if matches!(op, Cli | Sei | Plp) {
            old_i
        } else {
            self.flag(INTERRUPT)
        };
    }

    fn implied(&mut self, bus: &mut impl CpuBus, op: Op) {
        self.dummy(bus);
        let nz = match op {
            Ky => {
                self.state.halted = true;
                return;
            }
            Nop => return,
            Clc | Sec => {
                self.set(CARRY, op == Sec);
                return;
            }
            Cli | Sei => {
                self.set(INTERRUPT, op == Sei);
                return;
            }
            Cld | Sed => {
                self.set(DECIMAL, op == Sed);
                return;
            }
            Clv => {
                self.set(OVERFLOW, false);
                return;
            }
            Pha => {
                self.push(bus, self.state.a);
                return;
            }
            Php => {
                self.push(bus, self.state.status | BREAK);
                return;
            }
            Pla | Plp => {
                self.stack_dummy(bus);
                let byte = self.pull(bus);
                if op == Plp {
                    self.state.status = (byte | UNUSED) & !BREAK;
                    return;
                }
                self.state.a = byte;
                byte
            }
            Txs => {
                self.state.sp = self.state.x;
                return;
            }
            Tsx => {
                self.state.x = self.state.sp;
                self.state.x
            }
            Tax => {
                self.state.x = self.state.a;
                self.state.x
            }
            Tay => {
                self.state.y = self.state.a;
                self.state.y
            }
            Txa => {
                self.state.a = self.state.x;
                self.state.a
            }
            Tya => {
                self.state.a = self.state.y;
                self.state.a
            }
            Inx => {
                self.state.x = self.state.x.wrapping_add(1);
                self.state.x
            }
            Dex => {
                self.state.x = self.state.x.wrapping_sub(1);
                self.state.x
            }
            Iny => {
                self.state.y = self.state.y.wrapping_add(1);
                self.state.y
            }
            Dey => {
                self.state.y = self.state.y.wrapping_sub(1);
                self.state.y
            }
            _ => unreachable!(),
        };
        self.nz(nz);
    }

    fn modify(&mut self, op: Op, val: u8) -> u8 {
        let carry = u8::from(self.flag(CARRY));
        let out = match op {
            Asl | Slo | Rol | Rla => {
                self.set(CARRY, val & 0x80 != 0);
                (val << 1) | if matches!(op, Rol | Rla) { carry } else { 0 }
            }
            Lsr | Sre | Ror | Rra => {
                self.set(CARRY, val & 1 != 0);
                (val >> 1)
                    | if matches!(op, Ror | Rra) {
                        carry << 7
                    } else {
                        0
                    }
            }
            Inc | Isc => val.wrapping_add(1),
            Dec | Dcp => val.wrapping_sub(1),
            _ => unreachable!(),
        };
        match op {
            Slo => self.operand(Ora, out),
            Sre => self.operand(Eor, out),
            Rla => self.operand(And, out),
            Rra => self.adc(out),
            Isc => self.adc(!out),
            Dcp => self.compare(self.state.a, out),
            _ => self.nz(out),
        }
        out
    }

    fn operand(&mut self, op: Op, value: u8) {
        let out = match op {
            Nop => return,
            Adc | Sbc => {
                self.adc(if op == Adc { value } else { !value });
                return;
            }
            Cmp | Cpx | Cpy => {
                let reg = match op {
                    Cpx => self.state.x,
                    Cpy => self.state.y,
                    _ => self.state.a,
                };
                self.compare(reg, value);
                return;
            }
            Bit => {
                self.set(ZERO, self.state.a & value == 0);
                self.set(NEGATIVE, value & NEGATIVE != 0);
                self.set(OVERFLOW, value & OVERFLOW != 0);
                return;
            }
            Lda => {
                self.state.a = value;
                value
            }
            Ldx => {
                self.state.x = value;
                value
            }
            Ldy => {
                self.state.y = value;
                value
            }
            Lax => {
                self.state.a = value;
                self.state.x = value;
                value
            }
            Las => {
                let out = self.state.sp & value;
                self.state.a = out;
                self.state.x = out;
                self.state.sp = out;
                out
            }
            And | Anc | Alr | Arr | Ora | Eor | Xaa => {
                let result = self.state.a & value;
                self.state.a = match op {
                    Anc => {
                        self.set(CARRY, result & 0x80 != 0);
                        result
                    }
                    Alr => {
                        self.set(CARRY, result & 1 != 0);
                        result >> 1
                    }
                    Arr => {
                        let rotated = (result >> 1) | (u8::from(self.flag(CARRY)) << 7);
                        self.set(CARRY, rotated & 0x40 != 0);
                        self.set(OVERFLOW, (rotated ^ (rotated << 1)) & 0x40 != 0);
                        rotated
                    }
                    Ora => self.state.a | value,
                    Eor => self.state.a ^ value,
                    Xaa => self.state.x & value,
                    _ => result,
                };
                self.state.a
            }
            Axs => {
                let both = self.state.a & self.state.x;
                self.set(CARRY, both >= value);
                self.state.x = both.wrapping_sub(value);
                self.state.x
            }
            _ => unreachable!(),
        };
        self.nz(out);
    }
}
