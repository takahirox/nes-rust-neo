use crate::apu::Apu;
use crate::board::Board;
use crate::cpu::CpuBus;
use crate::ppu::Ppu;

#[derive(Default)]
pub(crate) struct Pad {
    pub buttons: u8,
    shift: u8,
}

impl Pad {
    fn read(&mut self, strobe: bool) -> u8 {
        if strobe {
            return self.buttons & 1;
        }
        let bit = self.shift & 1;
        self.shift = (self.shift >> 1) | 0x80;
        bit
    }
}

pub(crate) struct Bus {
    pub ram: [u8; 2048],
    pub board: Board,
    pub ppu: Ppu,
    pub apu: Apu,
    pub pads: [Pad; 2],
    pub cycle: u64,
    open: u8,
    strobe: bool,
    dma: Option<u8>,
}

impl Bus {
    pub fn new(board: Board) -> Self {
        Self {
            ram: [0; 2048],
            board,
            ppu: Ppu::new(),
            apu: Apu::new(),
            pads: [Pad::default(), Pad::default()],
            cycle: 0,
            open: 0,
            strobe: false,
            dma: None,
        }
    }

    pub fn reset(&mut self) {
        self.board.reset();
        self.ram.fill(0);
        self.ppu = Ppu::new();
        self.apu = Apu::new();
        self.pads = [Pad::default(), Pad::default()];
        self.cycle = 0;
        self.open = 0;
        self.strobe = false;
        self.dma = None;
    }

    fn tick(&mut self) {
        self.cycle += 1;
        let expansion = self.board.tick();
        self.apu.tick(self.cycle, expansion);
        for _ in 0..3 {
            self.ppu.tick(&mut self.board);
        }
    }

    fn raw_read(&mut self, addr: u16) -> u8 {
        let value = match addr {
            0..=0x1fff => self.ram[usize::from(addr & 0x7ff)],
            0x2000..=0x3fff => self.ppu.cpu_read(&mut self.board, addr & 7),
            0x4015 => self.apu.status(self.open),
            0x4016..=0x4017 => {
                (self.open & 0xe0) | self.pads[usize::from(addr & 1)].read(self.strobe)
            }
            0x4020..=0xffff => self.board.cpu_read(addr, self.open),
            _ => self.open,
        };
        if addr != 0x4015 {
            self.open = value;
        }
        value
    }

    fn dmc_dma(&mut self, during_oam: bool) {
        if let Some(address) = self.apu.dmc_request() {
            // OAM already owns the halt and alignment phases. A DMC read
            // takes its next read slot and delays the OAM transfer by a pair.
            for _ in 0..if during_oam { 1 } else { 2 + (self.cycle & 1) } {
                self.tick();
            }
            let sample = self.raw_read(address);
            self.tick();
            self.apu.dmc_fill(sample);
        }
    }

    pub fn finish_dma(&mut self, pc: u16) {
        if let Some(page) = self.dma.take() {
            self.raw_read(pc);
            self.tick();
            if self.cycle & 1 == 0 {
                self.tick();
            }
            for index in 0..=255 {
                self.dmc_dma(true);
                let byte = self.raw_read((u16::from(page) << 8) | index);
                self.tick();
                self.ppu.dma_write(byte);
                self.open = byte;
                self.tick();
            }
        }
    }
}

impl CpuBus for Bus {
    fn read(&mut self, addr: u16) -> u8 {
        self.dmc_dma(false);
        let byte = self.raw_read(addr);
        self.tick();
        byte
    }

    fn write(&mut self, addr: u16, value: u8) {
        self.open = value;
        match addr {
            0..=0x1fff => self.ram[usize::from(addr & 0x7ff)] = value,
            0x2000..=0x3fff => self.ppu.cpu_write(&mut self.board, addr & 7, value),
            0x4014 => self.dma = Some(value),
            0x4016 => {
                let next = value & 1 != 0;
                if self.strobe && !next {
                    for pad in &mut self.pads {
                        pad.shift = pad.buttons;
                    }
                }
                self.strobe = next;
            }
            0x4000..=0x4013 | 0x4015 | 0x4017 => self.apu.write(addr, value, self.cycle),
            0x4020..=0xffff => self.board.cpu_write(addr, value, self.cycle),
            _ => {}
        }
        self.tick();
    }

    fn take_nmi(&mut self) -> bool {
        self.ppu.take_nmi()
    }
    fn irq(&self) -> bool {
        self.apu.irq() || self.board.irq()
    }
}
