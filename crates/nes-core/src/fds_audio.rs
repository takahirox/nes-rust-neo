#[derive(Default)]
struct Envelope {
    control: u8,
    gain: u8,
    elapsed: u32,
}

impl Envelope {
    fn write(&mut self, value: u8) {
        self.control = value;
        self.elapsed = 0;
        if value & 0x80 != 0 {
            self.gain = value & 63;
        }
    }

    fn tick(&mut self, master: u8) {
        if master == 0 || self.control & 0x80 != 0 {
            return;
        }
        let period = 8 * u32::from(master) * (1 + u32::from(self.control & 63));
        self.elapsed += 1;
        if self.elapsed >= period {
            self.elapsed = 0;
            if self.control & 0x40 != 0 {
                if self.gain < 32 {
                    self.gain += 1;
                }
            } else {
                self.gain = self.gain.saturating_sub(1);
            }
        }
    }
}

pub(crate) struct FdsAudio {
    wave: [u8; 64],
    mod_table: [u8; 64],
    wave_phase: u32,
    mod_phase: u32,
    bias: i32,
    pitch: u16,
    mod_pitch: u16,
    volume: Envelope,
    modulation: Envelope,
    envelope_speed: u8,
    wave_control: u8,
    mod_halted: bool,
    level_control: u8,
    output: f32,
}

impl Default for FdsAudio {
    fn default() -> Self {
        Self {
            wave: [0; 64],
            mod_table: [0; 64],
            wave_phase: 0,
            mod_phase: 0,
            bias: 0,
            pitch: 0,
            mod_pitch: 0,
            volume: Envelope::default(),
            modulation: Envelope::default(),
            envelope_speed: 0xe8,
            wave_control: 0,
            mod_halted: true,
            level_control: 0,
            output: 0.0,
        }
    }
}

impl FdsAudio {
    const PHASE_MASK: u32 = (64 << 16) - 1;

    pub fn reset_output(&mut self) {
        self.volume.write(0x80);
        self.wave_phase = 0;
        self.bias = 0;
        self.output = 0.0;
    }

    fn signed_bias(value: i32) -> i32 {
        (value + 64).rem_euclid(128) - 64
    }

    fn modulation_offset(&self) -> i32 {
        // The 2C33 uses two quantization steps, with asymmetric rounding
        // and wraparound in the intermediate signed product.
        let product = self.bias * i32::from(self.modulation.gain);
        let mut factor = product >> 4;
        if product & 15 != 0 && factor & 128 == 0 {
            factor += if self.bias < 0 { -1 } else { 2 };
        }
        factor = (factor + 64).rem_euclid(256) - 64;
        (i32::from(self.pitch) * factor + 32) >> 6
    }

    pub fn tick(&mut self) -> f32 {
        if self.wave_control & 0xc0 == 0 {
            self.volume.tick(self.envelope_speed);
            self.modulation.tick(self.envelope_speed);
        }
        if !self.mod_halted {
            let step = self.mod_phase + u32::from(self.mod_pitch);
            if step >> 16 != self.mod_phase >> 16 {
                let delta = [0, 1, 2, 4, 0, -4, -2, -1]
                    [self.mod_table[(self.mod_phase >> 16) as usize] as usize];
                self.bias = if self.mod_table[(self.mod_phase >> 16) as usize] == 4 {
                    0
                } else {
                    Self::signed_bias(self.bias + delta)
                };
            }
            self.mod_phase = step & Self::PHASE_MASK;
        }
        if self.level_control & 0x80 == 0 {
            let wave = f32::from(self.wave[(self.wave_phase >> 16) as usize]);
            let gain = f32::from(self.volume.gain.min(32));
            let scale = [1.0, 2.0 / 3.0, 0.5, 0.4][usize::from(self.level_control & 3)];
            self.output = wave * gain * scale * (0.22 / (63.0 * 32.0));
        }
        if self.wave_control & 0x80 == 0 {
            let frequency = (i32::from(self.pitch) + self.modulation_offset()).max(0) as u32;
            self.wave_phase = (self.wave_phase + frequency) & Self::PHASE_MASK;
        }
        self.output
    }

    pub fn read(&self, addr: u16, open: u8) -> u8 {
        let data = match addr {
            0x4040..=0x407f if self.level_control & 0x80 != 0 => self.wave[usize::from(addr & 63)],
            0x4040..=0x407f => self.wave[(self.wave_phase >> 16) as usize],
            0x4090 => self.volume.gain,
            0x4092 => self.modulation.gain,
            _ => return open,
        };
        (open & 0xc0) | data
    }

    pub fn write(&mut self, addr: u16, value: u8) {
        match addr {
            0x4040..=0x407f if self.level_control & 0x80 != 0 => {
                self.wave[usize::from(addr & 63)] = value & 63;
            }
            0x4080 => self.volume.write(value),
            0x4082 => self.pitch = (self.pitch & 0xf00) | u16::from(value),
            0x4083 => {
                self.pitch = (self.pitch & 0xff) | (u16::from(value & 15) << 8);
                self.wave_control = value;
                if value & 0x80 != 0 {
                    self.wave_phase = 0;
                }
                if value & 0x40 != 0 {
                    self.volume.elapsed = 0;
                    self.modulation.elapsed = 0;
                }
            }
            0x4084 => self.modulation.write(value),
            0x4085 => self.bias = Self::signed_bias(i32::from(value & 127)),
            0x4086 => self.mod_pitch = (self.mod_pitch & 0xf00) | u16::from(value),
            0x4087 => {
                self.mod_pitch = (self.mod_pitch & 0xff) | (u16::from(value & 15) << 8);
                self.mod_halted = value & 0x80 != 0;
                if self.mod_halted {
                    self.mod_phase &= !0xffff;
                }
            }
            0x4088 if self.mod_halted => {
                let index = ((self.mod_phase >> 16) as usize) & !1;
                self.mod_table[index..index + 2].fill(value & 7);
                self.mod_phase = (self.mod_phase + (2 << 16)) & Self::PHASE_MASK;
            }
            0x4089 => self.level_control = value,
            0x408a => {
                self.envelope_speed = value;
                self.volume.elapsed = 0;
                self.modulation.elapsed = 0;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wave_write_gate_frequency_level_and_envelope() {
        let mut audio = FdsAudio::default();
        audio.write(0x4040, 63);
        assert_eq!(audio.read(0x4040, 0), 0);
        audio.write(0x4089, 0x80);
        audio.write(0x4040, 63);
        audio.write(0x4041, 32);
        assert_eq!(audio.read(0x4041, 0xc0), 0xe0);
        audio.write(0x4089, 2);
        audio.write(0x4080, 0xbf);
        audio.write(0x4082, 0xff);
        audio.write(0x4083, 0x0f);
        for _ in 0..17 {
            assert!((audio.tick() - 0.11).abs() < 0.000_001);
        }
        assert!((audio.tick() - 0.055_873_014).abs() < 0.000_001);
        audio.write(0x4080, 0x80);
        audio.write(0x4080, 0x40);
        audio.write(0x408a, 1);
        for _ in 0..7 {
            audio.tick();
        }
        assert_eq!(audio.read(0x4090, 0), 0);
        audio.tick();
        assert_eq!(audio.read(0x4090, 0), 1);
    }

    #[test]
    fn modulation_table_counter_wrap_and_pitch() {
        let mut audio = FdsAudio::default();
        audio.write(0x4088, 1);
        audio.write(0x4088, 4);
        assert_eq!(&audio.mod_table[..4], &[1, 1, 4, 4]);
        audio.write(0x4085, 63);
        audio.write(0x4084, 0x90);
        audio.write(0x4083, 4);
        assert_eq!(audio.modulation_offset(), 1008);
        audio.mod_phase = 0;
        audio.write(0x4086, 0xff);
        audio.write(0x4087, 0x0f);
        for _ in 0..17 {
            audio.tick();
        }
        assert_eq!(audio.bias, -64);
        assert_eq!(audio.modulation_offset(), -1024);
        for _ in 17..49 {
            audio.tick();
        }
        assert_eq!(audio.bias, 0);
        assert_eq!(audio.modulation_offset(), 0);
    }

    #[test]
    fn modulation_write_at_odd_step_updates_only_its_entry() {
        let mut audio = FdsAudio::default();
        audio.write(0x4088, 1);
        audio.write(0x4088, 2);
        assert_eq!(&audio.mod_table[..4], &[1, 1, 2, 2]);
        audio.mod_phase = 1 << 16;
        audio.write(0x4088, 3);
        assert_eq!(&audio.mod_table[..4], &[3, 3, 2, 2]);
        assert_eq!(audio.mod_phase, 3 << 16);

        audio.mod_phase = 1 << 16;
        audio.write(0x4084, 0x90);
        audio.write(0x4083, 4);
        audio.write(0x4086, 0xff);
        audio.write(0x4087, 0x0f);
        for _ in 0..16 {
            audio.tick();
        }
        assert_eq!(audio.bias, 0);
        let previous_phase = audio.wave_phase;
        audio.tick();
        assert_eq!(audio.bias, 4);
        assert_eq!(audio.wave_phase - previous_phase, 1088);
        for _ in 0..16 {
            audio.tick();
        }
        assert_eq!(audio.bias, 6);
    }
}
