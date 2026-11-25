use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RomError {
    Header,
    Truncated { expected: usize, actual: usize },
    Format(&'static str),
    Mapper(u8),
    Layout(u8),
}

impl fmt::Display for RomError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Header => write!(f, "Expected a 16-byte iNES header"),
            Self::Truncated { expected, actual } => {
                write!(
                    f,
                    "Truncated ROM (expected {expected} bytes, found {actual})"
                )
            }
            Self::Format(reason) => write!(f, "Unsupported cartridge format: {reason}"),
            Self::Mapper(mapper) => write!(f, "Unsupported mapper {mapper}"),
            Self::Layout(mapper) => write!(f, "Unsupported ROM layout for mapper {mapper}"),
        }
    }
}
impl std::error::Error for RomError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mirroring {
    Horizontal,
    Vertical,
    SingleLower,
    SingleUpper,
    FourScreen,
}

#[derive(Default)]
struct Mmc3 {
    select: u8,
    banks: [u8; 8],
    ram: u8,
    latch: u8,
    counter: u8,
    reload: bool,
    enabled: bool,
    irq: bool,
    a12: bool,
    low_since: u64,
}

enum Mapper {
    Nrom,
    Mmc1 {
        shift: u8,
        control: u8,
        chr: [u8; 2],
        prg: u8,
        last_write: Option<u64>,
    },
    Uxrom(u8),
    Cnrom(u8),
    Mmc3(Mmc3),
}

pub struct Cartridge {
    mapper: Mapper,
    mapper_number: u8,
    prg: Vec<u8>,
    chr: Vec<u8>,
    chr_ram: bool,
    ram: Box<[u8; 8192]>,
    mirroring: Mirroring,
    initial_mirroring: Mirroring,
    battery: bool,
    save_revision: u32,
}

impl Cartridge {
    pub fn from_ines(rom: &[u8]) -> Result<Self, RomError> {
        if rom.len() < 16 || &rom[..4] != b"NES\x1a" {
            return Err(RomError::Header);
        }
        let flags = rom[6];
        let format = rom[7];
        if format & 0x0c == 8 {
            return Err(RomError::Format("NES 2.0"));
        }
        if format & 0x0c != 0 {
            return Err(RomError::Format("archaic iNES header"));
        }
        if format & 3 != 0 {
            return Err(RomError::Format("VS System or PlayChoice"));
        }
        if rom[9] & 1 != 0 || rom[10] & 3 == 2 {
            return Err(RomError::Format("PAL"));
        }
        let number = (flags >> 4) | (format & 0xf0);
        let (prg, chr) = (usize::from(rom[4]), usize::from(rom[5]));
        let valid = match number {
            0 => (1..=2).contains(&prg) && chr <= 1,
            1 => (1..=16).contains(&prg) && chr <= 16,
            2 => (2..=16).contains(&prg) && chr <= 1,
            3 => (1..=2).contains(&prg) && (1..=4).contains(&chr),
            4 => (2..=32).contains(&prg) && chr <= 32,
            _ => return Err(RomError::Mapper(number)),
        };
        if !valid || rom[8] > 1 {
            return Err(RomError::Layout(number));
        }
        let trainer = if flags & 4 != 0 { 512 } else { 0 };
        let prg_start = 16 + trainer;
        let chr_start = prg_start + prg * 16384;
        let end = chr_start + chr * 8192;
        if rom.len() < end {
            return Err(RomError::Truncated {
                expected: end,
                actual: rom.len(),
            });
        }
        let mut ram = Box::new([0; 8192]);
        if trainer != 0 {
            ram[0x1000..0x1200].copy_from_slice(&rom[16..prg_start]);
        }
        let mirroring = if flags & 8 != 0 {
            Mirroring::FourScreen
        } else if flags & 1 != 0 {
            Mirroring::Vertical
        } else {
            Mirroring::Horizontal
        };
        Ok(Self {
            mapper: Self::initial_mapper(number),
            mapper_number: number,
            prg: rom[prg_start..chr_start].to_vec(),
            chr: if chr == 0 {
                vec![0; 8192]
            } else {
                rom[chr_start..end].to_vec()
            },
            chr_ram: chr == 0,
            ram,
            mirroring,
            initial_mirroring: mirroring,
            battery: flags & 2 != 0,
            save_revision: 0,
        })
    }

    fn initial_mapper(number: u8) -> Mapper {
        match number {
            0 => Mapper::Nrom,
            1 => Mapper::Mmc1 {
                shift: 0x10,
                control: 0x0c,
                chr: [0; 2],
                prg: 0,
                last_write: None,
            },
            2 => Mapper::Uxrom(0),
            3 => Mapper::Cnrom(0),
            4 => Mapper::Mmc3(Mmc3 {
                ram: 0x80,
                ..Mmc3::default()
            }),
            _ => unreachable!(),
        }
    }

    pub(crate) fn reset(&mut self) {
        self.mapper = Self::initial_mapper(self.mapper_number);
        self.mirroring = self.initial_mirroring;
    }

    pub fn mapper_number(&self) -> u8 {
        self.mapper_number
    }

    pub fn mirroring(&self) -> Mirroring {
        if self.mirroring == Mirroring::FourScreen {
            return self.mirroring;
        }
        match self.mapper {
            Mapper::Mmc1 { control, .. } => match control & 3 {
                0 => Mirroring::SingleLower,
                1 => Mirroring::SingleUpper,
                2 => Mirroring::Vertical,
                _ => Mirroring::Horizontal,
            },
            _ => self.mirroring,
        }
    }

    pub fn battery_ram(&self) -> Option<&[u8]> {
        self.battery.then_some(self.ram.as_slice())
    }

    pub fn restore_battery_ram(&mut self, bytes: &[u8]) -> bool {
        if !self.battery || bytes.len() != self.ram.len() {
            return false;
        }
        self.ram.copy_from_slice(bytes);
        true
    }

    pub fn save_revision(&self) -> u32 {
        self.save_revision
    }

    pub(crate) fn ram_at(&self, address: u16) -> u8 {
        self.ram[usize::from(address & 0x1fff)]
    }

    pub(crate) fn cpu_read(&self, address: u16, open: u8) -> u8 {
        if address < 0x6000 {
            return open;
        }
        if address < 0x8000 {
            return match self.mapper {
                Mapper::Mmc1 { prg, .. } if prg & 0x10 != 0 => open,
                Mapper::Mmc3(ref m) if m.ram & 0x80 == 0 => open,
                _ => self.ram_at(address),
            };
        }
        let offset = usize::from(address - 0x8000);
        let banks = self.prg.len() / 16384;
        let upper = address >= 0xc000;
        let index = match self.mapper {
            Mapper::Nrom | Mapper::Cnrom(_) => offset,
            Mapper::Uxrom(bank) => {
                (if upper { banks - 1 } else { usize::from(bank) }) * 16384 + (offset & 0x3fff)
            }
            Mapper::Mmc1 { prg, control, .. } => {
                let bank = usize::from(prg & 15);
                let bank = match (control >> 2) & 3 {
                    0 | 1 => (bank & !1) + usize::from(upper),
                    2 => {
                        if upper {
                            bank
                        } else {
                            0
                        }
                    }
                    _ => {
                        if upper {
                            banks - 1
                        } else {
                            bank
                        }
                    }
                };
                bank * 16384 + (offset & 0x3fff)
            }
            Mapper::Mmc3(ref m) => {
                let last = self.prg.len() / 8192 - 1;
                let variable = usize::from(m.banks[6] & 0x3f);
                let first = if m.select & 0x40 == 0 {
                    variable
                } else {
                    last - 1
                };
                let third = if m.select & 0x40 == 0 {
                    last - 1
                } else {
                    variable
                };
                [first, usize::from(m.banks[7] & 0x3f), third, last][offset / 8192] * 8192
                    + (offset & 0x1fff)
            }
        };
        self.prg[index % self.prg.len()]
    }

    pub(crate) fn cpu_write(&mut self, address: u16, value: u8, cycle: u64) {
        if address < 0x6000 {
            return;
        }
        if address < 0x8000 {
            match self.mapper {
                Mapper::Mmc1 { prg, .. } if prg & 0x10 != 0 => return,
                Mapper::Mmc3(ref m) if m.ram & 0xc0 != 0x80 => return,
                _ => {}
            }
            let slot = &mut self.ram[usize::from(address & 0x1fff)];
            if *slot != value {
                *slot = value;
                self.save_revision = self.save_revision.wrapping_add(1);
            }
            return;
        }
        let value = if matches!(self.mapper, Mapper::Cnrom(_)) {
            value & self.cpu_read(address, 0xff)
        } else {
            value
        };
        match &mut self.mapper {
            Mapper::Nrom => {}
            Mapper::Uxrom(bank) => *bank = value & 15,
            Mapper::Cnrom(bank) => *bank = value & 3,
            Mapper::Mmc1 {
                shift,
                control,
                chr,
                prg,
                last_write,
            } => {
                if last_write.is_some_and(|last| cycle == last + 1) {
                    return;
                }
                *last_write = Some(cycle);
                if value & 0x80 != 0 {
                    *shift = 0x10;
                    *control |= 0x0c;
                    return;
                }
                let full = *shift & 1 != 0;
                *shift = (*shift >> 1) | ((value & 1) << 4);
                if full {
                    match (address >> 13) & 3 {
                        0 => *control = *shift,
                        1 => chr[0] = *shift,
                        2 => chr[1] = *shift,
                        _ => *prg = *shift,
                    }
                    *shift = 0x10;
                }
            }
            Mapper::Mmc3(m) => match address & 0xe001 {
                0x8000 => m.select = value,
                0x8001 => m.banks[usize::from(m.select & 7)] = value,
                0xa000 if self.mirroring != Mirroring::FourScreen => {
                    self.mirroring = if value & 1 == 0 {
                        Mirroring::Vertical
                    } else {
                        Mirroring::Horizontal
                    };
                }
                0xa001 => m.ram = value,
                0xc000 => m.latch = value,
                0xc001 => m.reload = true,
                0xe000 => {
                    m.enabled = false;
                    m.irq = false;
                }
                0xe001 => m.enabled = true,
                _ => {}
            },
        }
    }

    fn chr_index(&self, address: u16) -> usize {
        let offset = usize::from(address);
        let index = match self.mapper {
            Mapper::Cnrom(bank) => usize::from(bank) * 8192 + offset,
            Mapper::Mmc1 { chr, control, .. } => {
                if control & 0x10 == 0 {
                    usize::from(chr[0] & !1) * 4096 + offset
                } else {
                    usize::from(chr[offset / 4096]) * 4096 + (offset & 0xfff)
                }
            }
            Mapper::Mmc3(ref m) => {
                let [a, b, c, d, e, f, ..] = m.banks;
                let banks = [a & !1, a | 1, b & !1, b | 1, c, d, e, f];
                let slot = (offset / 1024) ^ usize::from((m.select >> 5) & 4);
                usize::from(banks[slot]) * 1024 + (offset & 0x3ff)
            }
            _ => offset,
        };
        index % self.chr.len()
    }

    pub(crate) fn chr_read(&self, address: u16) -> u8 {
        self.chr[self.chr_index(address)]
    }

    pub(crate) fn chr_write(&mut self, address: u16, value: u8) {
        if self.chr_ram {
            let index = self.chr_index(address);
            self.chr[index] = value;
        }
    }

    pub(crate) fn ppu_address(&mut self, address: u16, dot: u64) {
        if let Mapper::Mmc3(m) = &mut self.mapper {
            let high = address & 0x1000 != 0;
            if !high && m.a12 {
                m.low_since = dot;
            }
            if high && !m.a12 && dot - m.low_since >= 8 {
                if m.counter == 0 || m.reload {
                    m.counter = m.latch;
                    m.reload = false;
                } else {
                    m.counter -= 1;
                }
                if m.counter == 0 && m.enabled {
                    m.irq = true;
                }
            }
            m.a12 = high;
        }
    }

    pub(crate) fn irq(&self) -> bool {
        matches!(self.mapper, Mapper::Mmc3(ref m) if m.irq)
    }
}
