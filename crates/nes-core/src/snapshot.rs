//! Fixed-width machine state at a completed instruction (including OAM DMA).
use std::fmt;

use sha2::{Digest, Sha256};

use crate::{MAX_DISK_SAVE_BYTES, Nes, board::Board, bus::Bus, cpu::Cpu};

const STATE_MAGIC: &[u8; 8] = b"NESSTATE";
pub(crate) const DISK_MAGIC: &[u8; 8] = b"FDSDELTA";
const STATE_VERSION: u16 = 1;
pub(crate) const DISK_VERSION: u16 = 1;
const HEADER: usize = 8 + 2 + 1 + 32 + 32 + 4;
const DIGEST: usize = 32;
pub const MAX_DISK_FILE_BYTES: usize =
    MAX_DISK_SAVE_BYTES + MAX_DISK_SAVE_BYTES.div_ceil(2048) + 128;
pub(crate) const MACHINE_LIMIT: usize = 320 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = MAX_DISK_FILE_BYTES + MACHINE_LIMIT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotError {
    Format,
    Version,
    Media,
    Bios,
    Integrity,
    State,
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Format => "The save file is malformed or has an invalid size.",
            Self::Version => "This save file requires a compatible emulator build.",
            Self::Media => "This save file belongs to a different ROM or disk image.",
            Self::Bios => "This state requires the exact FDS BIOS used to save it.",
            Self::Integrity => "The save file failed its integrity check.",
            Self::State => "The save file contains invalid machine data.",
        })
    }
}
impl std::error::Error for SnapshotError {}

pub(crate) fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub(crate) fn seal(
    magic: &[u8; 8],
    version: u16,
    kind: u8,
    media: &[u8; 32],
    bios: &[u8; 32],
    write: impl FnOnce(&mut Vec<u8>),
) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER);
    out.extend_from_slice(magic);
    version.encode(&mut out);
    kind.encode(&mut out);
    out.extend_from_slice(media);
    out.extend_from_slice(bios);
    out.extend_from_slice(&0u32.to_le_bytes());
    write(&mut out);
    let len = (out.len() - HEADER) as u32;
    out[HEADER - 4..HEADER].copy_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&hash(&out));
    out
}

pub(crate) fn open<'a>(
    file: &'a [u8],
    max: usize,
    magic: &[u8; 8],
    version: u16,
    kind: u8,
    media: &[u8; 32],
    bios: &[u8; 32],
) -> Result<Reader<'a>, SnapshotError> {
    if !(HEADER + DIGEST..=max).contains(&file.len()) || !file.starts_with(magic) {
        return Err(SnapshotError::Format);
    }
    let mut header = Reader(&file[8..HEADER]);
    if header.value::<u16>()? != version {
        return Err(SnapshotError::Version);
    }
    if header.value::<u8>()? != kind || header.take(32)? != media {
        return Err(SnapshotError::Media);
    }
    if header.take(32)? != bios {
        return Err(SnapshotError::Bios);
    }
    let end = file.len() - DIGEST;
    if header.value::<usize>()? != end - HEADER {
        return Err(SnapshotError::Format);
    }
    if hash(&file[..end]) != file[end..] {
        return Err(SnapshotError::Integrity);
    }
    Ok(Reader(&file[HEADER..end]))
}

impl Nes {
    /// Maximum snapshot size for the mounted media.
    pub fn snapshot_limit(&self) -> usize {
        MACHINE_LIMIT + self.disk_save_limit()
    }

    /// Maximum native disk-save size for the mounted media.
    pub fn disk_save_limit(&self) -> usize {
        match &self.bus.board {
            Board::Cartridge(_) => 0,
            Board::Disk(fds) => fds.disk_save_limit(),
        }
    }

    /// Capture hardware and framebuffer after reset or a complete CPU instruction.
    /// PCM already delivered to the host is excluded.
    pub fn snapshot(&self) -> Vec<u8> {
        let (kind, media, bios) = self.bus.board.snapshot_identity();
        seal(STATE_MAGIC, STATE_VERSION, kind, &media, &bios, |out| {
            self.cpu.encode(out);
            self.bus.write_state(out);
        })
    }

    /// Decode into an independent machine with the same immutable media.
    /// Hosts can persist displaced native progress before installing the result.
    pub fn prepare_snapshot(&self, file: &[u8]) -> Result<Self, SnapshotError> {
        let (kind, media, bios) = self.bus.board.snapshot_identity();
        let mut input = open(
            file,
            self.snapshot_limit(),
            STATE_MAGIC,
            STATE_VERSION,
            kind,
            &media,
            &bios,
        )?;
        let cpu = input.value::<Cpu>()?;
        valid(cpu.valid_state())?;
        let mut bus = Bus::new(self.bus.board.snapshot_base());
        bus.read_state(&mut input)?;
        input.finish()?;
        Ok(Self { cpu, bus })
    }

    /// Replace the machine only after the complete file has been validated.
    pub fn restore_snapshot(&mut self, file: &[u8]) -> Result<(), SnapshotError> {
        *self = self.prepare_snapshot(file)?;
        Ok(())
    }

    /// Export FDS native progress relative to the original disk.
    pub fn export_disk_save(&self, tracks: &[u8]) -> Option<Vec<u8>> {
        match &self.bus.board {
            Board::Disk(fds) => fds.export_save(tracks),
            Board::Cartridge(_) => None,
        }
    }

    /// Validate an FDS native save against the original disk and expand it.
    pub fn decode_disk_save(&self, file: &[u8]) -> Result<Vec<u8>, SnapshotError> {
        match &self.bus.board {
            Board::Disk(fds) => fds.decode_save(file),
            Board::Cartridge(_) => Err(SnapshotError::Media),
        }
    }
}

pub(crate) fn valid(condition: bool) -> Result<(), SnapshotError> {
    if condition {
        Ok(())
    } else {
        Err(SnapshotError::State)
    }
}

pub(crate) struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    pub(crate) fn take(&mut self, len: usize) -> Result<&'a [u8], SnapshotError> {
        let (head, tail) = self.0.split_at_checked(len).ok_or(SnapshotError::Format)?;
        self.0 = tail;
        Ok(head)
    }

    pub(crate) fn value<T: Value>(&mut self) -> Result<T, SnapshotError> {
        T::read(self)
    }

    pub(crate) fn copy(&mut self, destination: &mut [u8]) -> Result<(), SnapshotError> {
        destination.copy_from_slice(self.take(destination.len())?);
        Ok(())
    }

    pub(crate) fn finish(self) -> Result<(), SnapshotError> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(SnapshotError::Format)
        }
    }
}

pub(crate) trait Value: Sized {
    fn encode(&self, out: &mut Vec<u8>);
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError>;
}

macro_rules! scalar {
    ($($ty:ty),+) => {$(
        impl Value for $ty {
            fn encode(&self, out: &mut Vec<u8>) {
                out.extend_from_slice(&self.to_le_bytes());
            }
            fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
                let mut bytes = [0; size_of::<Self>()];
                input.copy(&mut bytes)?;
                Ok(Self::from_le_bytes(bytes))
            }
        }
    )+};
}

scalar!(u8, u16, u32, u64, i32);

impl Value for f32 {
    fn encode(&self, out: &mut Vec<u8>) {
        self.to_bits().encode(out);
    }
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
        let value = Self::from_bits(input.value()?);
        valid(value.is_finite() && value.abs() <= 8.0)?;
        Ok(value)
    }
}

impl Value for bool {
    fn encode(&self, out: &mut Vec<u8>) {
        u8::from(*self).encode(out);
    }
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
        match input.value::<u8>()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(SnapshotError::State),
        }
    }
}

impl Value for usize {
    fn encode(&self, out: &mut Vec<u8>) {
        (*self as u32).encode(out);
    }
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
        Ok(input.value::<u32>()? as usize)
    }
}

impl<T: Value> Value for Option<T> {
    fn encode(&self, out: &mut Vec<u8>) {
        self.is_some().encode(out);
        if let Some(value) = self {
            value.encode(out);
        }
    }
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
        if input.value()? {
            Ok(Some(input.value()?))
        } else {
            Ok(None)
        }
    }
}

impl<A: Value, B: Value> Value for (A, B) {
    fn encode(&self, out: &mut Vec<u8>) {
        self.0.encode(out);
        self.1.encode(out);
    }
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
        Ok((input.value()?, input.value()?))
    }
}

impl<T: Value, const N: usize> Value for [T; N] {
    fn encode(&self, out: &mut Vec<u8>) {
        for entry in self {
            entry.encode(out);
        }
    }
    fn read(input: &mut Reader<'_>) -> Result<Self, SnapshotError> {
        let mut entries = std::array::from_fn(|_| None);
        for entry in &mut entries {
            *entry = Some(input.value()?);
        }
        Ok(entries.map(Option::unwrap))
    }
}

// Keep the versioned wire order next to the subsystem that owns the fields.
macro_rules! state_fields {
    ($ty:ty { $($field:ident),+ $(,)? }) => {
        impl $crate::snapshot::Value for $ty {
            fn encode(&self, out: &mut Vec<u8>) {
                $(self.$field.encode(out);)+
            }
            fn read(input: &mut $crate::snapshot::Reader<'_>) -> Result<Self, $crate::SnapshotError> {
                Ok(Self { $($field: input.value()?),+ })
            }
        }
    };
}
pub(crate) use state_fields;
