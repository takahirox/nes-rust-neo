//! Validated, filename-independent game media.
use std::fmt;

use crate::{Cartridge, fds::Disk};

pub const FDS_SIDE_BYTES: usize = 65_500;
pub const FDS_BIOS_BYTES: usize = 8_192;
pub(crate) const DISK_SIGNATURE: &[u8] = b"\x01*NINTENDO-HVC*";

#[derive(Debug)]
pub enum MediaError {
    Cartridge(crate::RomError),
    DiskHeader,
    DiskSize,
    DiskSide(usize),
    DiskCapacity(usize),
    MissingBios,
    BiosSize,
    Unsupported,
}

impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cartridge(err) => err.fmt(f),
            Self::DiskHeader => write!(f, "Invalid FDS header (side count or reserved bytes)."),
            Self::DiskSize => write!(f, "FDS image size does not match its 65,500-byte sides."),
            Self::DiskSide(side) => write!(f, "Malformed FDS blocks on side {}.", side + 1),
            Self::DiskCapacity(side) => write!(
                f,
                "FDS side {} exceeds the emulated track capacity.",
                side + 1
            ),
            Self::MissingBios => write!(f, "An 8 KiB FDS BIOS is required for this disk image."),
            Self::BiosSize => write!(f, "The FDS BIOS must be exactly 8192 bytes (8 KiB)."),
            Self::Unsupported => write!(
                f,
                "Unsupported game format. Open an iNES cartridge or a standard FDS disk image."
            ),
        }
    }
}

impl std::error::Error for MediaError {}

pub enum Media {
    Cartridge(Box<Cartridge>),
    Disk(Disk),
}

impl Media {
    pub fn parse(bytes: &[u8]) -> Result<Self, MediaError> {
        if bytes.starts_with(b"NES\x1a") {
            return Cartridge::from_ines(bytes)
                .map(Box::new)
                .map(Self::Cartridge)
                .map_err(MediaError::Cartridge);
        }
        let (sides, count) = if bytes.starts_with(b"FDS\x1a") {
            let header = bytes.get(..16).ok_or(MediaError::DiskHeader)?;
            if header[4] == 0 || header[5..].iter().any(|&byte| byte != 0) {
                return Err(MediaError::DiskHeader);
            }
            (&bytes[16..], usize::from(header[4]))
        } else if bytes.starts_with(DISK_SIGNATURE) {
            (bytes, bytes.len() / FDS_SIDE_BYTES)
        } else {
            return Err(MediaError::Unsupported);
        };
        if !(1..=255).contains(&count) || sides.len() != count * FDS_SIDE_BYTES {
            return Err(MediaError::DiskSize);
        }
        Disk::from_sides(sides).map(Self::Disk)
    }
}
