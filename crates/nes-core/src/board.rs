use crate::SnapshotError;
use crate::snapshot::Reader;
use crate::{Cartridge, Mirroring, fds::Fds};

pub(crate) enum Board {
    Cartridge(Box<Cartridge>),
    Disk(Box<Fds>),
}

impl Board {
    pub fn reset(&mut self) {
        match self {
            Self::Cartridge(cart) => cart.reset(),
            Self::Disk(fds) => fds.reset(),
        }
    }

    pub fn tick(&mut self) -> f32 {
        match self {
            Self::Cartridge(_) => 0.0,
            Self::Disk(fds) => fds.tick(),
        }
    }

    pub fn cpu_read(&mut self, addr: u16, open: u8) -> u8 {
        match self {
            Self::Cartridge(cart) => cart.cpu_read(addr, open),
            Self::Disk(fds) => fds.cpu_read(addr, open),
        }
    }

    pub fn cpu_write(&mut self, addr: u16, value: u8, cycle: u64) {
        match self {
            Self::Cartridge(cart) => cart.cpu_write(addr, value, cycle),
            Self::Disk(fds) => fds.cpu_write(addr, value),
        }
    }

    pub fn chr_read(&self, addr: u16) -> u8 {
        match self {
            Self::Cartridge(cart) => cart.chr_read(addr),
            Self::Disk(fds) => fds.chr[usize::from(addr)],
        }
    }

    pub fn chr_write(&mut self, addr: u16, value: u8) {
        match self {
            Self::Cartridge(cart) => cart.chr_write(addr, value),
            Self::Disk(fds) => fds.chr[usize::from(addr)] = value,
        }
    }

    pub fn ppu_address(&mut self, addr: u16, dot: u64) {
        if let Self::Cartridge(cart) = self {
            cart.ppu_address(addr, dot);
        }
    }

    pub fn mirroring(&self) -> Mirroring {
        match self {
            Self::Cartridge(cart) => cart.mirroring(),
            Self::Disk(fds) => fds.mirroring(),
        }
    }

    pub fn irq(&self) -> bool {
        match self {
            Self::Cartridge(cart) => cart.irq(),
            Self::Disk(fds) => fds.irq(),
        }
    }
}

impl Board {
    pub fn snapshot_identity(&self) -> (u8, [u8; 32], [u8; 32]) {
        match self {
            Self::Cartridge(cart) => (0, cart.identity, [0; 32]),
            Self::Disk(fds) => fds.snapshot_identity(),
        }
    }

    pub fn snapshot_base(&self) -> Self {
        match self {
            Self::Cartridge(cart) => Self::Cartridge(cart.clone()),
            Self::Disk(fds) => Self::Disk(Box::new(fds.snapshot_base())),
        }
    }

    pub fn write_state(&self, out: &mut Vec<u8>) {
        match self {
            Self::Cartridge(cart) => cart.write_state(out),
            Self::Disk(fds) => fds.write_state(out),
        }
    }

    pub fn read_state(
        &mut self,
        input: &mut Reader<'_>,
        cycle: u64,
        ppu_clock: u64,
    ) -> Result<(), SnapshotError> {
        match self {
            Self::Cartridge(cart) => cart.read_state(input, cycle, ppu_clock),
            Self::Disk(fds) => fds.read_state(input),
        }
    }
}
