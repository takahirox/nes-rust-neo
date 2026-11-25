//! Platform-independent NTSC NES. A frame returns RGBA pixels and 48 kHz mono audio.
mod apu;
mod bus;
mod cartridge;
mod cpu;
mod ppu;

pub use cartridge::{Cartridge, Mirroring, RomError};
pub use cpu::CpuState;

use bus::Bus;
use cpu::Cpu;

pub const WIDTH: usize = 256;
pub const HEIGHT: usize = 240;
pub const CPU_HZ: u32 = 1_789_773;
pub const SAMPLE_RATE: u32 = 48_000;

pub mod button {
    pub const A: u8 = 1;
    pub const B: u8 = 2;
    pub const SELECT: u8 = 4;
    pub const START: u8 = 8;
    pub const UP: u8 = 16;
    pub const DOWN: u8 = 32;
    pub const LEFT: u8 = 64;
    pub const RIGHT: u8 = 128;
}

pub struct Nes {
    cpu: Cpu,
    bus: Bus,
}

impl Nes {
    pub fn from_ines(bytes: &[u8]) -> Result<Self, RomError> {
        let mut nes = Self {
            cpu: Cpu::new(),
            bus: Bus::new(Cartridge::from_ines(bytes)?),
        };
        nes.cpu.reset(&mut nes.bus);
        Ok(nes)
    }

    /// Restart from power-on timing while keeping cartridge RAM, including battery saves.
    pub fn reset(&mut self) {
        self.bus.reset();
        self.cpu = Cpu::new();
        self.cpu.reset(&mut self.bus);
    }

    /// Run to the next VBlank, or return false when the CPU executes a jam opcode.
    pub fn run_frame(&mut self) -> bool {
        let frame = self.frame_number();
        self.bus.apu.clear_audio();
        while self.frame_number() == frame {
            self.step_instruction();
            if self.cpu.state().halted {
                return false;
            }
        }
        true
    }

    pub fn step_instruction(&mut self) {
        self.bus.apu.clear_audio_if_full();
        self.cpu.step(&mut self.bus);
        self.bus.finish_dma(self.cpu.state().pc);
    }

    pub fn set_controller(&mut self, port: usize, buttons: u8) {
        if let Some(pad) = self.bus.pads.get_mut(port) {
            pad.buttons = buttons;
        }
    }

    pub fn frame(&self) -> &[u8] {
        self.bus.ppu.frame()
    }
    pub fn audio(&self) -> &[f32] {
        self.bus.apu.audio()
    }
    pub fn frame_number(&self) -> u64 {
        self.bus.ppu.frames()
    }
    pub fn cpu_state(&self) -> CpuState {
        self.cpu.state()
    }
    pub fn cpu_cycles(&self) -> u64 {
        self.bus.cycle
    }
    pub fn ppu_position(&self) -> (u16, u16) {
        self.bus.ppu.position()
    }
    pub fn cartridge(&self) -> &Cartridge {
        &self.bus.cart
    }
    pub fn restore_battery_ram(&mut self, bytes: &[u8]) -> bool {
        self.bus.cart.restore_battery_ram(bytes)
    }

    /// Debug RAM peek with no register reads, clocks, or side effects.
    pub fn peek_ram(&self, address: u16) -> Option<u8> {
        match address {
            0..=0x1fff => Some(self.bus.ram[usize::from(address & 0x7ff)]),
            0x6000..=0x7fff => Some(self.bus.cart.ram_at(address)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests;
