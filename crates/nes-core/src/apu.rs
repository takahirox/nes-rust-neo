use crate::{CPU_HZ, SAMPLE_RATE};

const LENGTHS: [u8; 32] = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22,
    192, 24, 72, 26, 16, 28, 32, 30,
];
const DUTY: [u8; 4] = [0b01000000, 0b01100000, 0b01111000, 0b10011111];
const NOISE_PERIOD: [u16; 16] = [
    4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
];
const DMC_PERIOD: [u16; 16] = [
    428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 85, 72, 54,
];

#[derive(Default)]
struct Envelope {
    control: u8,
    start: bool,
    divider: u8,
    decay: u8,
}

impl Envelope {
    fn clock(&mut self) {
        let period = self.control & 15;
        if std::mem::take(&mut self.start) {
            self.decay = 15;
            self.divider = period;
        } else if self.divider == 0 {
            self.divider = period;
            if self.decay != 0 {
                self.decay -= 1;
            } else if self.halt() {
                self.decay = 15;
            }
        } else {
            self.divider -= 1;
        }
    }
    fn halt(&self) -> bool {
        self.control & 0x20 != 0
    }
    fn volume(&self) -> u8 {
        if self.control & 0x10 != 0 {
            self.control & 15
        } else {
            self.decay
        }
    }
}

#[derive(Default)]
struct Pulse {
    envelope: Envelope,
    length: u8,
    period: u16,
    timer: u16,
    phase: u8,
    sweep: u8,
    sweep_divider: u8,
    sweep_reload: bool,
    ones_complement: bool,
}

impl Pulse {
    fn target(&self) -> i32 {
        let period = i32::from(self.period);
        let change = period >> (self.sweep & 7);
        if self.sweep & 8 != 0 {
            period - change - i32::from(self.ones_complement)
        } else {
            period + change
        }
    }
    fn sweep_clock(&mut self) {
        let target = self.target();
        if self.sweep_divider == 0
            && self.sweep & 0x80 != 0
            && self.sweep & 7 != 0
            && self.period >= 8
            && (0..=0x7ff).contains(&target)
        {
            self.period = target as u16;
        }
        if self.sweep_divider == 0 || self.sweep_reload {
            self.sweep_divider = (self.sweep >> 4) & 7;
            self.sweep_reload = false;
        } else {
            self.sweep_divider -= 1;
        }
    }
    fn tick(&mut self) {
        if self.timer == 0 {
            self.timer = self.period;
            self.phase = (self.phase + 1) & 7;
        } else {
            self.timer -= 1;
        }
    }
    fn value(&self) -> u8 {
        let duty = DUTY[usize::from(self.envelope.control >> 6)];
        if self.length == 0
            || self.period < 8
            || self.target() > 0x7ff
            || duty & (0x80 >> self.phase) == 0
        {
            0
        } else {
            self.envelope.volume()
        }
    }
}

#[derive(Default)]
struct Triangle {
    control: u8,
    linear: u8,
    reload: bool,
    length: u8,
    period: u16,
    timer: u16,
    phase: u8,
    output: u8,
}

impl Triangle {
    fn clock_linear(&mut self) {
        if self.reload {
            self.linear = self.control & 0x7f;
        } else {
            self.linear = self.linear.saturating_sub(1);
        }
        self.reload &= self.control & 0x80 != 0;
    }
    fn tick(&mut self) {
        if self.timer == 0 {
            self.timer = self.period;
            if self.length != 0 && self.linear != 0 {
                self.phase = (self.phase + 1) & 31;
                self.output = if self.phase < 16 {
                    15 - self.phase
                } else {
                    self.phase - 16
                };
            }
        } else {
            self.timer -= 1;
        }
    }
}

struct Noise {
    envelope: Envelope,
    length: u8,
    control: u8,
    timer: u16,
    shift: u16,
}

impl Noise {
    fn tick(&mut self) {
        if self.timer == 0 {
            self.timer = NOISE_PERIOD[usize::from(self.control & 15)] - 1;
            let tap = if self.control & 0x80 != 0 { 6 } else { 1 };
            self.shift = (self.shift >> 1) | (((self.shift ^ (self.shift >> tap)) & 1) << 14);
        } else {
            self.timer -= 1;
        }
    }
    fn value(&self) -> u8 {
        if self.length != 0 && self.shift & 1 == 0 {
            self.envelope.volume()
        } else {
            0
        }
    }
}

struct Dmc {
    control: u8,
    base: u16,
    length: u16,
    address: u16,
    remaining: u16,
    timer: u16,
    output: u8,
    sample: Option<u8>,
    shift: u8,
    bits: u8,
    silent: bool,
    irq: bool,
}

impl Dmc {
    fn restart(&mut self) {
        self.address = self.base;
        self.remaining = self.length;
    }
    fn request(&self) -> Option<u16> {
        (self.remaining != 0 && self.sample.is_none()).then_some(self.address)
    }
    fn fill(&mut self, byte: u8) {
        self.sample = Some(byte);
        self.address = if self.address == 0xffff {
            0x8000
        } else {
            self.address + 1
        };
        self.remaining -= 1;
        if self.remaining == 0 {
            if self.control & 0x40 != 0 {
                self.restart();
            } else if self.control & 0x80 != 0 {
                self.irq = true;
            }
        }
    }
    fn tick(&mut self) {
        if self.timer != 0 {
            self.timer -= 1;
            return;
        }
        self.timer = DMC_PERIOD[usize::from(self.control & 15)] - 1;
        if !self.silent {
            if self.shift & 1 != 0 && self.output <= 125 {
                self.output += 2;
            } else if self.shift & 1 == 0 && self.output >= 2 {
                self.output -= 2;
            }
        }
        self.shift >>= 1;
        self.bits -= 1;
        if self.bits == 0 {
            self.bits = 8;
            self.silent = self.sample.is_none();
            self.shift = self.sample.take().unwrap_or(0);
        }
    }
}

pub(crate) struct Apu {
    pulses: [Pulse; 2],
    triangle: Triangle,
    noise: Noise,
    dmc: Dmc,
    enabled: u8,
    five_step: bool,
    inhibit: bool,
    frame_irq: bool,
    frame_cycle: u16,
    reset_at: Option<(u64, bool)>,
    sample_phase: u32,
    last_mix: f32,
    high_90: f32,
    last_90: f32,
    high_440: f32,
    low_14k: f32,
    audio: Vec<f32>,
}

impl Apu {
    pub fn new() -> Self {
        Self {
            pulses: [
                Pulse {
                    ones_complement: true,
                    ..Pulse::default()
                },
                Pulse::default(),
            ],
            triangle: Triangle::default(),
            noise: Noise {
                envelope: Envelope::default(),
                length: 0,
                control: 0,
                timer: 0,
                shift: 1,
            },
            dmc: Dmc {
                control: 0,
                base: 0xc000,
                length: 1,
                address: 0,
                remaining: 0,
                timer: 0,
                output: 0,
                sample: None,
                shift: 0,
                bits: 8,
                silent: true,
                irq: false,
            },
            enabled: 0,
            five_step: false,
            inhibit: false,
            frame_irq: false,
            frame_cycle: 0,
            reset_at: None,
            sample_phase: 0,
            last_mix: 0.0,
            high_90: 0.0,
            last_90: 0.0,
            high_440: 0.0,
            low_14k: 0.0,
            audio: Vec::with_capacity(1024),
        }
    }

    pub fn audio(&self) -> &[f32] {
        &self.audio
    }
    pub fn clear_audio(&mut self) {
        self.audio.clear();
    }
    pub fn clear_audio_if_full(&mut self) {
        if self.audio.len() >= 2048 {
            self.audio.clear();
        }
    }
    pub fn irq(&self) -> bool {
        self.frame_irq || self.dmc.irq
    }
    pub fn dmc_request(&self) -> Option<u16> {
        self.dmc.request()
    }
    pub fn dmc_fill(&mut self, byte: u8) {
        self.dmc.fill(byte);
    }

    pub fn status(&mut self, open: u8) -> u8 {
        let out = u8::from(self.pulses[0].length != 0)
            | (u8::from(self.pulses[1].length != 0) << 1)
            | (u8::from(self.triangle.length != 0) << 2)
            | (u8::from(self.noise.length != 0) << 3)
            | (u8::from(self.dmc.remaining != 0) << 4)
            | (open & 0x20)
            | (u8::from(self.frame_irq) << 6)
            | (u8::from(self.dmc.irq) << 7);
        self.frame_irq = false;
        out
    }

    pub fn write(&mut self, address: u16, byte: u8, cycle: u64) {
        let length = LENGTHS[usize::from(byte >> 3)];
        match address {
            0x4000..=0x4007 => {
                let channel = usize::from((address >> 2) & 1);
                let pulse = &mut self.pulses[channel];
                match address & 3 {
                    0 => pulse.envelope.control = byte,
                    1 => {
                        pulse.sweep = byte;
                        pulse.sweep_reload = true;
                    }
                    2 => pulse.period = (pulse.period & 0x700) | u16::from(byte),
                    _ => {
                        pulse.period = (pulse.period & 0xff) | (u16::from(byte & 7) << 8);
                        if self.enabled & (1 << channel) != 0 {
                            pulse.length = length;
                        }
                        pulse.phase = 0;
                        pulse.envelope.start = true;
                    }
                }
            }
            0x4008 => self.triangle.control = byte,
            0x400a => self.triangle.period = (self.triangle.period & 0x700) | u16::from(byte),
            0x400b => {
                self.triangle.period = (self.triangle.period & 0xff) | (u16::from(byte & 7) << 8);
                if self.enabled & 4 != 0 {
                    self.triangle.length = length;
                }
                self.triangle.reload = true;
            }
            0x400c => self.noise.envelope.control = byte,
            0x400e => self.noise.control = byte,
            0x400f => {
                if self.enabled & 8 != 0 {
                    self.noise.length = length;
                }
                self.noise.envelope.start = true;
            }
            0x4010 => {
                self.dmc.control = byte;
                if byte & 0x80 == 0 {
                    self.dmc.irq = false;
                }
            }
            0x4011 => self.dmc.output = byte & 0x7f,
            0x4012 => self.dmc.base = 0xc000 | (u16::from(byte) << 6),
            0x4013 => self.dmc.length = (u16::from(byte) << 4) | 1,
            0x4015 => {
                self.enabled = byte;
                if byte & 1 == 0 {
                    self.pulses[0].length = 0;
                }
                if byte & 2 == 0 {
                    self.pulses[1].length = 0;
                }
                if byte & 4 == 0 {
                    self.triangle.length = 0;
                }
                if byte & 8 == 0 {
                    self.noise.length = 0;
                }
                if byte & 16 == 0 {
                    self.dmc.remaining = 0;
                } else if self.dmc.remaining == 0 {
                    self.dmc.restart();
                }
                self.dmc.irq = false;
            }
            0x4017 => {
                self.inhibit = byte & 0x40 != 0;
                if self.inhibit {
                    self.frame_irq = false;
                }
                self.reset_at = Some((cycle + 3 + (cycle & 1), byte & 0x80 != 0));
            }
            _ => {}
        }
    }

    fn quarter(&mut self) {
        self.pulses[0].envelope.clock();
        self.pulses[1].envelope.clock();
        self.noise.envelope.clock();
        self.triangle.clock_linear();
    }

    fn half(&mut self) {
        for pulse in &mut self.pulses {
            if !pulse.envelope.halt() {
                pulse.length = pulse.length.saturating_sub(1);
            }
            pulse.sweep_clock();
        }
        if !self.noise.envelope.halt() {
            self.noise.length = self.noise.length.saturating_sub(1);
        }
        if self.triangle.control & 0x80 == 0 {
            self.triangle.length = self.triangle.length.saturating_sub(1);
        }
    }

    pub fn tick(&mut self, cycle: u64) {
        if let Some((when, five)) = self.reset_at
            && cycle == when
        {
            self.reset_at = None;
            self.frame_cycle = 0;
            self.five_step = five;
            if five {
                self.quarter();
                self.half();
            }
        } else {
            self.frame_cycle += 1;
            match (self.five_step, self.frame_cycle) {
                (_, 7457 | 22371) => self.quarter(),
                (_, 14913) | (false, 29829) | (true, 37281) => {
                    self.quarter();
                    self.half();
                }
                _ => {}
            }
            if !self.five_step && (29828..=29830).contains(&self.frame_cycle) && !self.inhibit {
                self.frame_irq = true;
            }
            if self.frame_cycle == if self.five_step { 37282 } else { 29830 } {
                self.frame_cycle = 0;
            }
        }

        if cycle & 1 == 0 {
            for pulse in &mut self.pulses {
                pulse.tick();
            }
        }
        self.triangle.tick();
        self.noise.tick();
        self.dmc.tick();

        self.sample_phase += SAMPLE_RATE;
        if self.sample_phase >= CPU_HZ {
            self.sample_phase -= CPU_HZ;
            self.sample();
        }
    }

    fn sample(&mut self) {
        let pulse = f32::from(self.pulses[0].value() + self.pulses[1].value());
        let tnd = f32::from(self.triangle.output) / 8227.0
            + f32::from(self.noise.value()) / 12241.0
            + f32::from(self.dmc.output) / 22638.0;
        let mix = 95.88 * pulse / (8128.0 + 100.0 * pulse) + 159.79 * tnd / (1.0 + 100.0 * tnd);
        // One-pole NES output filters, at the fixed 48 kHz output rate.
        self.high_90 = 0.9883 * (self.high_90 + mix - self.last_mix);
        self.last_mix = mix;
        self.high_440 = 0.9440 * (self.high_440 + self.high_90 - self.last_90);
        self.last_90 = self.high_90;
        self.low_14k += 0.8400 * (self.high_440 - self.low_14k);
        self.audio.push(self.low_14k);
    }
}
