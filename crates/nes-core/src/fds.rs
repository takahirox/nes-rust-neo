use std::{ops::Range, sync::Arc};

use crate::{
    Mirroring, SnapshotError,
    fds_audio::FdsAudio,
    media::{DISK_SIGNATURE, FDS_BIOS_BYTES, FDS_SIDE_BYTES, MediaError},
    snapshot::{DISK_MAGIC, DISK_VERSION, Reader, Value, hash, open, seal, state_fields, valid},
};

// A byte cell is eight drive bits. Gaps are rounded to whole byte cells.
const BYTE_CYCLES: u32 = 150;
const SPINUP_CYCLES: u32 = 50_000;
const CHANGE_CYCLES: u32 = 150_000;
const LEAD_GAP: usize = 3537;
const BLOCK_GAP: usize = 121;
const MIN_LEAD_GAP: usize = 26_150usize.div_ceil(8);
const MIN_BLOCK_GAP: usize = 480 / 8;
const BASE_TRACK_BYTES: usize = 98_304;
// Two side headers occupy 58 bytes. Each file pair (including hidden files)
// takes at least 17 bytes even with an empty payload.
const MAX_SIDE_BLOCKS: usize = 2 + 2 * ((FDS_SIDE_BYTES - 58) / 17);
const MAX_TRACK_BYTES: usize =
    FDS_SIDE_BYTES + MIN_LEAD_GAP + (MAX_SIDE_BLOCKS - 1) * MIN_BLOCK_GAP + 3 * MAX_SIDE_BLOCKS;
pub const MAX_DISK_SAVE_BYTES: usize = 255 * MAX_TRACK_BYTES;

fn crc_byte(mut crc: u16, value: u8) -> u16 {
    crc ^= u16::from(value);
    for _ in 0..8 {
        crc = (crc >> 1) ^ if crc & 1 == 0 { 0 } else { 0x8408 };
    }
    crc
}

fn append_block(track: &mut Vec<u8>, block: &[u8], gap: usize) {
    track.resize(track.len() + gap, 0);
    track.push(0x80);
    track.extend_from_slice(block);
    let crc = block.iter().copied().fold(crc_byte(0, 0x80), crc_byte);
    track.extend_from_slice(&crc.to_le_bytes());
}

fn expand_side(track: &mut Vec<u8>, raw: &[u8], side: usize) -> Result<(), MediaError> {
    let start = track.len();
    let malformed = || MediaError::DiskSide(side);
    if !raw.starts_with(DISK_SIGNATURE) || raw[56] != 2 {
        return Err(malformed());
    }
    let mut blocks = vec![&raw[..56], &raw[56..58]];
    let mut rest = &raw[58..];
    let mut files = 0;
    // Hidden files can follow the advertised file count.
    while rest.first() == Some(&3) {
        let file = rest.get(..16).ok_or_else(malformed)?;
        let length = usize::from(u16::from_le_bytes([file[13], file[14]]));
        let data = rest.get(16..17 + length).ok_or_else(malformed)?;
        if data[0] != 4 || file[15] > 2 {
            return Err(malformed());
        }
        blocks.extend([file, data]);
        rest = &rest[17 + length..];
        files += 1;
    }
    if files < usize::from(raw[57]) || rest.iter().any(|&byte| byte != 0) {
        return Err(malformed());
    }

    // Each block needs a sync byte and two CRC bytes in addition to its data.
    let block_bytes = raw.len() - rest.len() + 3 * blocks.len();
    let default_size = block_bytes + LEAD_GAP + (blocks.len() - 1) * BLOCK_GAP;
    // Keep both legacy gap choices and the 96 KiB floor so existing snapshots
    // retain their exact byte layout. Grow denser tracks using minimum gaps.
    let (lead, between) = if default_size <= BASE_TRACK_BYTES {
        (LEAD_GAP, BLOCK_GAP)
    } else {
        (MIN_LEAD_GAP, MIN_BLOCK_GAP)
    };
    for (index, block) in blocks.into_iter().enumerate() {
        append_block(track, block, if index == 0 { lead } else { between });
    }
    track.resize(track.len().max(start + BASE_TRACK_BYTES), 0);
    Ok(())
}

pub struct Disk {
    tracks: Vec<u8>,
    offsets: Arc<[usize]>,
    original: Arc<[u8]>,
    identity: [u8; 32],
}

impl Disk {
    pub(crate) fn from_sides(sides: &[u8]) -> Result<Self, MediaError> {
        let side_count = sides.len() / FDS_SIDE_BYTES;
        let mut tracks = Vec::with_capacity(side_count * BASE_TRACK_BYTES);
        let mut offsets = Vec::with_capacity(side_count + 1);
        offsets.push(0);
        for (index, raw) in sides.as_chunks::<FDS_SIDE_BYTES>().0.iter().enumerate() {
            expand_side(&mut tracks, raw, index)?;
            offsets.push(tracks.len());
        }
        Ok(Self {
            original: Arc::from(tracks.as_slice()),
            identity: hash(sides),
            tracks,
            offsets: Arc::from(offsets),
        })
    }

    pub fn side_count(&self) -> usize {
        self.offsets.len() - 1
    }

    fn track_range(&self, side: usize) -> Range<usize> {
        self.offsets[side]..self.offsets[side + 1]
    }
}

#[derive(Default)]
struct Timer {
    reload: u16,
    remaining: u16,
    control: u8,
    irq: bool,
}

impl Timer {
    fn tick(&mut self) {
        if self.control & 2 != 0 {
            if self.remaining == 0 {
                self.irq = true;
                self.remaining = self.reload;
                if self.control & 1 == 0 {
                    self.control = 0;
                }
            } else {
                self.remaining -= 1;
            }
        }
    }
}

#[derive(Default)]
struct Drive {
    inserted: Option<usize>,
    pending: Option<usize>,
    settle: u32,
    control: u8,
    head: usize,
    delay: u32,
    ready: bool,
    sync: bool,
    crc: u16,
    crc_error: bool,
    check_crc: bool,
    transfer: bool,
    irq: bool,
    input: u8,
    output: u8,
}

impl Drive {
    fn rewind(&mut self) {
        self.head = 0;
        self.delay = SPINUP_CYCLES;
        self.ready = false;
        self.sync = false;
        self.crc = 0;
        self.crc_error = false;
        self.check_crc = false;
        self.transfer = false;
        self.irq = false;
    }

    fn clock(&mut self) -> Option<usize> {
        if self.settle > 0 {
            self.settle -= 1;
            if self.settle == 0 {
                self.inserted = self.pending.take();
            }
        }
        let side = self.inserted?;
        // The drive runs with reset released (bit 0) and motor stop clear (bit 1).
        if self.control & 3 != 1 {
            return None;
        }
        self.delay -= 1;
        if self.delay != 0 {
            return None;
        }
        self.ready = true;
        self.delay = BYTE_CYCLES;
        Some(side)
    }

    fn read_cell(&mut self, value: u8) {
        if self.control & 0x40 == 0 {
            self.sync = false;
            self.crc = 0;
            self.crc_error = false;
            self.check_crc = false;
        } else if !self.sync {
            if value == 0x80 {
                self.sync = true;
                self.crc = crc_byte(0, value);
            }
        } else {
            if self.control & 0x10 == 0 || self.check_crc {
                self.crc = crc_byte(self.crc, value);
                if self.check_crc {
                    self.crc_error = self.crc != 0;
                    self.check_crc = false;
                }
            }
            self.input = value;
            self.complete_transfer();
        }
    }

    fn write_cell(&mut self) -> u8 {
        if self.writing_gap() {
            self.crc = 0;
            0
        } else if self.control & 0x10 != 0 {
            let value = self.crc as u8;
            self.crc >>= 8;
            value
        } else {
            self.complete_transfer();
            self.crc = crc_byte(self.crc, self.output);
            self.output
        }
    }

    fn writing_gap(&self) -> bool {
        self.control & 0x44 == 0
    }

    fn complete_transfer(&mut self) {
        self.transfer = true;
        self.irq |= self.control & 0x80 != 0;
    }

    fn acknowledge_transfer(&mut self) {
        self.transfer = false;
        self.irq = false;
    }
}

pub(crate) struct Fds {
    disk: Disk,
    bios: Arc<[u8; FDS_BIOS_BYTES]>,
    bios_identity: [u8; 32],
    pub prg: Box<[u8]>,
    pub chr: Box<[u8]>,
    drive: Drive,
    timer: Timer,
    io: u8,
    external: u8,
    audio: FdsAudio,
    revision: u32,
}

impl Fds {
    pub fn new(disk: Disk, bios: Option<&[u8]>) -> Result<Self, MediaError> {
        let bios = bios.ok_or(MediaError::MissingBios)?;
        let bios: &[u8; FDS_BIOS_BYTES] = bios.try_into().map_err(|_| MediaError::BiosSize)?;
        let mut board = Self {
            disk,
            bios: Arc::new(*bios),
            bios_identity: hash(bios),
            prg: vec![0; 0x8000].into_boxed_slice(),
            chr: vec![0; 0x2000].into_boxed_slice(),
            drive: Drive {
                inserted: Some(0),
                ..Drive::default()
            },
            timer: Timer::default(),
            io: 0,
            external: 0x80,
            audio: FdsAudio::default(),
            revision: 0,
        };
        board.drive.rewind();
        Ok(board)
    }

    pub fn side_count(&self) -> usize {
        self.disk.side_count()
    }

    pub fn inserted(&self) -> Option<usize> {
        self.drive.inserted
    }

    pub fn requested_side(&self) -> Option<usize> {
        self.drive.pending.or(self.drive.inserted)
    }

    pub fn eject(&mut self) {
        if self.drive.inserted.take().is_some() || self.drive.pending.is_some() {
            self.drive.settle = CHANGE_CYCLES;
        }
        self.drive.pending = None;
        self.drive.rewind();
    }

    pub fn insert(&mut self, side: usize) -> bool {
        if side >= self.side_count() {
            return false;
        }
        if self.drive.inserted == Some(side) || self.drive.pending == Some(side) {
            return true;
        }
        self.eject();
        if self.drive.settle == 0 {
            self.drive.inserted = Some(side);
        } else {
            self.drive.pending = Some(side);
        }
        true
    }

    pub fn reset(&mut self) {
        self.drive.control = 0;
        self.drive.input = 0;
        self.drive.output = 0;
        self.drive.rewind();
        self.timer = Timer::default();
        self.io = 0;
        self.external = 0x80;
        self.audio = FdsAudio::default();
        self.prg.fill(0);
        self.chr.fill(0);
    }

    pub fn save(&self) -> &[u8] {
        &self.disk.tracks
    }

    pub fn restore(&mut self, bytes: &[u8]) -> bool {
        if bytes.len() != self.disk.tracks.len() {
            return false;
        }
        self.disk.tracks.copy_from_slice(bytes);
        true
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    pub fn mirroring(&self) -> Mirroring {
        if self.drive.control & 8 == 0 {
            Mirroring::Vertical
        } else {
            Mirroring::Horizontal
        }
    }

    pub fn irq(&self) -> bool {
        self.timer.irq || self.drive.irq
    }

    pub fn tick(&mut self) -> f32 {
        self.timer.tick();
        if let Some(side) = self.drive.clock() {
            let track = self.disk.track_range(side);
            let index = track.start + self.drive.head;
            if self.drive.control & 4 != 0 {
                self.drive.read_cell(self.disk.tracks[index]);
            } else {
                let data = self.drive.write_cell();
                if self.disk.tracks[index] != data {
                    self.disk.tracks[index] = data;
                    self.revision = self.revision.wrapping_add(1);
                }
            }
            self.drive.head += 1;
            if index + 1 == track.end {
                self.drive.control &= !1;
                self.drive.ready = false;
                self.drive.irq |= !self.drive.writing_gap() && self.drive.control & 0x80 != 0;
            }
        }
        if self.io & 2 != 0 {
            self.audio.tick()
        } else {
            0.0
        }
    }

    pub fn cpu_read(&mut self, addr: u16, open: u8) -> u8 {
        match addr {
            0x6000..=0xdfff => self.prg[usize::from(addr - 0x6000)],
            0xe000..=0xffff => self.bios[usize::from(addr - 0xe000)],
            0x4040..=0x4092 if self.io & 2 != 0 => self.audio.read(addr, open),
            0x4030..=0x4033 => match addr {
                0x4030 => {
                    let end_of_track = self
                        .drive
                        .inserted
                        .is_some_and(|side| self.drive.head == self.disk.track_range(side).len());
                    let status = (open & 0x24)
                        | u8::from(self.timer.irq)
                        | (self.drive.control & 8)
                        | (u8::from(self.drive.crc_error) << 4)
                        | (u8::from(end_of_track) << 6)
                        | (u8::from(self.drive.transfer) << 7);
                    self.timer.irq = false;
                    status
                }
                0x4031 => {
                    self.drive.acknowledge_transfer();
                    self.drive.input
                }
                0x4032 => {
                    (open & 0xf8)
                        | if self.drive.inserted.is_none() {
                            7
                        } else {
                            u8::from(!self.drive.ready) << 1
                        }
                }
                _ => self.external | 0x80,
            },
            _ => open,
        }
    }

    pub fn cpu_write(&mut self, addr: u16, value: u8) {
        match addr {
            0x6000..=0xdfff => self.prg[usize::from(addr - 0x6000)] = value,
            0x4020 => self.timer.reload = (self.timer.reload & 0xff00) | u16::from(value),
            0x4021 => self.timer.reload = (self.timer.reload & 0xff) | (u16::from(value) << 8),
            0x4022 => {
                self.timer.control = if self.io & 1 != 0 { value & 3 } else { 0 };
                if self.timer.control & 2 == 0 {
                    self.timer.irq = false;
                } else {
                    self.timer.remaining = self.timer.reload;
                }
            }
            0x4023 => {
                self.io = value & 3;
                if self.io & 1 == 0 {
                    self.timer.control = 0;
                    self.timer.irq = false;
                    // Reset $4025 to stopped, with read mode selected.
                    self.drive.control = 0x06;
                    self.drive.rewind();
                }
                if self.io & 2 == 0 {
                    self.audio.reset_output();
                }
            }
            0x4024 if self.io & 1 != 0 => {
                self.drive.output = value;
                self.drive.acknowledge_transfer();
            }
            0x4025 if self.io & 1 != 0 => {
                if value & 3 != 1 || self.drive.control & 1 == 0 {
                    self.drive.rewind();
                }
                if value & 0x14 == 0x14 && self.drive.control & 0x10 == 0 {
                    // Firmware can arm the check between the two CRC bytes.
                    self.drive.check_crc = true;
                }
                self.drive.control = value;
                self.drive.irq = false;
                if self.drive.writing_gap() {
                    self.drive.transfer = false;
                }
            }
            0x4026 if self.io & 1 != 0 => self.external = value,
            0x4040..=0x408a if self.io & 2 != 0 => self.audio.write(addr, value),
            _ => {}
        }
    }
}

state_fields!(Timer {
    reload,
    remaining,
    control,
    irq
});
state_fields!(Drive {
    inserted,
    pending,
    settle,
    control,
    head,
    delay,
    ready,
    sync,
    crc,
    crc_error,
    check_crc,
    transfer,
    irq,
    input,
    output
});

const SAVE_PAGE: usize = 256;

impl Disk {
    fn write_delta(&self, tracks: &[u8], out: &mut Vec<u8>) {
        let start = out.len();
        out.resize(start + tracks.len().div_ceil(SAVE_PAGE * 8), 0);
        for (page, (current, original)) in tracks
            .chunks(SAVE_PAGE)
            .zip(self.original.chunks(SAVE_PAGE))
            .enumerate()
        {
            if current != original {
                out[start + page / 8] |= 1 << (page % 8);
                out.extend_from_slice(current);
            }
        }
    }

    fn read_delta(
        original: &[u8],
        tracks: &mut [u8],
        input: &mut Reader<'_>,
    ) -> Result<(), SnapshotError> {
        let pages = original.len().div_ceil(SAVE_PAGE);
        let flags = input.take(pages.div_ceil(8))?;
        if !pages.is_multiple_of(8) {
            valid(flags[flags.len() - 1] >> (pages % 8) == 0)?;
        }
        for (page, (current, base)) in tracks
            .chunks_mut(SAVE_PAGE)
            .zip(original.chunks(SAVE_PAGE))
            .enumerate()
        {
            if flags[page / 8] & (1 << (page % 8)) != 0 {
                input.copy(current)?;
                valid(current != base)?;
            } else {
                current.copy_from_slice(base);
            }
        }
        Ok(())
    }
}

impl Fds {
    pub(crate) fn snapshot_identity(&self) -> (u8, [u8; 32], [u8; 32]) {
        (1, self.disk.identity, self.bios_identity)
    }

    pub(crate) fn snapshot_base(&self) -> Self {
        Self {
            disk: Disk {
                tracks: vec![0; self.disk.original.len()],
                offsets: self.disk.offsets.clone(),
                original: self.disk.original.clone(),
                identity: self.disk.identity,
            },
            bios: self.bios.clone(),
            bios_identity: self.bios_identity,
            prg: vec![0; self.prg.len()].into_boxed_slice(),
            chr: vec![0; self.chr.len()].into_boxed_slice(),
            drive: Drive::default(),
            timer: Timer::default(),
            io: 0,
            external: 0,
            audio: FdsAudio::default(),
            revision: 0,
        }
    }

    pub(crate) fn write_state(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.prg);
        out.extend_from_slice(&self.chr);
        self.drive.encode(out);
        self.timer.encode(out);
        self.io.encode(out);
        self.external.encode(out);
        self.audio.encode(out);
        self.revision.encode(out);
        self.disk.write_delta(&self.disk.tracks, out);
    }

    pub(crate) fn read_state(&mut self, input: &mut Reader<'_>) -> Result<(), SnapshotError> {
        input.copy(&mut self.prg)?;
        input.copy(&mut self.chr)?;
        self.drive = input.value()?;
        self.timer = input.value()?;
        self.io = input.value()?;
        self.external = input.value()?;
        self.audio = input.value()?;
        self.revision = input.value()?;
        let drive = &self.drive;
        valid(
            self.io <= 3
                && self.timer.control <= 3
                && self.audio.valid_state()
                && drive.settle <= CHANGE_CYCLES
                && (1..=SPINUP_CYCLES).contains(&drive.delay)
                && drive.pending.is_none_or(|side| {
                    side < self.side_count() && drive.settle > 0 && drive.inserted.is_none()
                })
                && drive.inserted.map_or(drive.head == 0, |side| {
                    side < self.side_count() && drive.settle == 0 && {
                        let len = self.disk.track_range(side).len();
                        drive.head < len || (drive.head == len && drive.control & 1 == 0)
                    }
                }),
        )?;
        Disk::read_delta(&self.disk.original, &mut self.disk.tracks, input)
    }

    pub(crate) fn export_save(&self, tracks: &[u8]) -> Option<Vec<u8>> {
        (tracks.len() == self.disk.original.len()).then(|| {
            seal(
                DISK_MAGIC,
                DISK_VERSION,
                1,
                &self.disk.identity,
                &[0; 32],
                |out| self.disk.write_delta(tracks, out),
            )
        })
    }

    pub(crate) fn disk_save_limit(&self) -> usize {
        let len = self.disk.original.len();
        len + len.div_ceil(SAVE_PAGE * 8) + 128
    }

    pub(crate) fn decode_save(&self, bytes: &[u8]) -> Result<Vec<u8>, SnapshotError> {
        let mut input = open(
            bytes,
            self.disk_save_limit(),
            DISK_MAGIC,
            DISK_VERSION,
            1,
            &self.disk.identity,
            &[0; 32],
        )?;
        let mut tracks = vec![0; self.disk.original.len()];
        Disk::read_delta(&self.disk.original, &mut tracks, &mut input)?;
        input.finish()?;
        Ok(tracks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Media, Nes, apu::Apu, board::Board, cpu::CpuBus, ppu::Ppu};

    fn side() -> Vec<u8> {
        let mut bytes = vec![0; FDS_SIDE_BYTES];
        bytes[..DISK_SIGNATURE.len()].copy_from_slice(DISK_SIGNATURE);
        bytes[56] = 2;
        bytes
    }

    fn board() -> Fds {
        let bytes = side().repeat(3);
        let mut bios = [0; FDS_BIOS_BYTES];
        bios[0] = 0xea;
        bios[0x1ffd] = 0xe0;
        Fds::new(Disk::from_sides(&bytes).unwrap(), Some(&bios)).unwrap()
    }

    fn clock(board: &mut Fds, cycles: u32) {
        for _ in 0..cycles {
            board.tick();
        }
    }

    #[test]
    fn formats_bios_and_size_validation() {
        let raw = side();
        for count in [1, 2, 3] {
            let header = [b"FDS\x1a".as_slice(), &[count; 1], &[0; 11]].concat();
            let raw = raw.repeat(usize::from(count));
            let image = [header, raw.clone()].concat();
            for bytes in [&raw, &image] {
                let Media::Disk(disk) = Media::parse(bytes).unwrap() else {
                    panic!("expected FDS");
                };
                assert_eq!(disk.side_count(), usize::from(count));
                assert!(matches!(
                    Media::parse(&bytes[..bytes.len() - 1]),
                    Err(MediaError::DiskSize)
                ));
            }
            let mut wrong = image;
            wrong[5] = 1;
            assert!(matches!(Media::parse(&wrong), Err(MediaError::DiskHeader)));
            wrong[5] = 0;
            wrong[4] += 1;
            assert!(matches!(Media::parse(&wrong), Err(MediaError::DiskSize)));
        }
        let mut malformed = raw.clone();
        malformed[57] = 1;
        assert!(matches!(
            Media::parse(&malformed),
            Err(MediaError::DiskSide(0))
        ));
        malformed[58] = 3;
        malformed[71] = 0xff;
        malformed[72] = 0xff;
        assert!(matches!(
            Media::parse(&malformed),
            Err(MediaError::DiskSide(0))
        ));
        let mut qd = raw.clone();
        qd.resize(65536, 0);
        assert!(matches!(Media::parse(&qd), Err(MediaError::DiskSize)));
        assert!(matches!(
            Nes::from_media(Media::parse(&raw).unwrap(), None),
            Err(MediaError::MissingBios)
        ));
        assert!(matches!(
            Nes::from_media(Media::parse(&raw).unwrap(), Some(&[0; 8191])),
            Err(MediaError::BiosSize)
        ));
    }

    #[test]
    fn dense_disk_sides_preserve_every_block_and_crc() {
        for (files, payload, last_payload, track_len) in
            [(150, 419, 461, BASE_TRACK_BYTES), (255, 235, 235, 99_783)]
        {
            let blocks = dense_blocks(files, payload, last_payload);
            let mut raw: Vec<_> = blocks.iter().flatten().copied().collect();
            raw.resize(FDS_SIDE_BYTES, 0);
            let mut image = b"FDS\x1a\x01".to_vec();
            image.resize(16, 0);
            image.extend_from_slice(&raw);
            for bytes in [&raw, &image] {
                let Media::Disk(disk) = Media::parse(bytes).unwrap() else {
                    panic!("expected FDS");
                };
                assert_eq!(disk.side_count(), 1);
                assert_eq!(disk.tracks.len(), track_len);
                let mut track = disk.tracks.as_slice();
                for (index, block) in blocks.iter().enumerate() {
                    let gap = track.iter().position(|&byte| byte != 0).unwrap();
                    assert_eq!(gap, if index == 0 { 3269 } else { 60 });
                    let (cell, rest) = track[gap..].split_at(block.len() + 3);
                    assert_eq!(cell[0], 0x80);
                    assert_eq!(&cell[1..1 + block.len()], block);
                    assert_eq!(cell.iter().copied().fold(0, crc_byte), 0);
                    track = rest;
                }
                assert!(track.iter().all(|&byte| byte == 0));
            }
        }
    }

    fn dense_blocks(files: u8, payload: u16, last_payload: u16) -> Vec<Vec<u8>> {
        let mut blocks = vec![side()[..56].to_vec(), vec![2, files]];
        for file in 0..files {
            let length = if file == files - 1 {
                last_payload
            } else {
                payload
            };
            let mut header = vec![0; 16];
            header[0] = 3;
            header[1] = file;
            header[13..15].copy_from_slice(&length.to_le_bytes());
            let mut data = vec![file; usize::from(length) + 1];
            data[0] = 4;
            blocks.extend([header, data]);
        }
        blocks
    }

    #[test]
    fn mixed_track_lengths_drive_and_restore_at_side_boundaries() {
        let mut raw: Vec<_> = dense_blocks(255, 235, 235).into_iter().flatten().collect();
        raw.resize(FDS_SIDE_BYTES, 0);
        raw.extend(side());
        let bios = [0; FDS_BIOS_BYTES];
        let mut fds = Fds::new(Disk::from_sides(&raw).unwrap(), Some(&bios)).unwrap();
        let boundary = 99_783;
        assert_eq!(fds.side_count(), 2);
        assert_eq!(fds.save().len(), boundary + BASE_TRACK_BYTES);

        fds.cpu_write(0x4023, 1);
        fds.cpu_write(0x4025, 0xe1);
        fds.cpu_write(0x4024, 0x7b);
        fds.drive.head = BASE_TRACK_BYTES - 1;
        clock(&mut fds, SPINUP_CYCLES);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x40, 0);

        fds.drive.head = boundary - 1;
        clock(&mut fds, 2 * BYTE_CYCLES);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x40, 0x40);
        assert_eq!(&fds.save()[boundary - 1..=boundary], &[0x7b, 0]);

        assert!(fds.insert(1));
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x40, 0);
        fds.cpu_write(0x4024, 0x3a);
        fds.cpu_write(0x4025, 0xe1);
        clock(&mut fds, CHANGE_CYCLES + SPINUP_CYCLES - 1);
        assert_eq!(fds.inserted(), Some(1));
        assert_eq!(&fds.save()[boundary - 1..=boundary], &[0x7b, 0x3a]);

        let mut reopened = Fds::new(Disk::from_sides(&raw).unwrap(), Some(&bios)).unwrap();
        assert!(reopened.restore(fds.save()));
        assert_eq!(reopened.save(), fds.save());
    }

    #[test]
    fn generic_cpu_ppu_mappings_and_reset() {
        let mut nes = Nes::from_board(Board::Disk(Box::new(board())));
        assert_eq!(nes.cpu_state().pc, 0xe000);
        assert_eq!(nes.bus.read(0xe000), 0xea);
        nes.bus.write(0xe000, 0);
        nes.step_instruction();
        assert_eq!(nes.cpu_state().pc, 0xe001);
        for (addr, value) in [(0x6000, 7), (0xdfff, 8)] {
            nes.bus.write(addr, value);
            assert_eq!(nes.bus.read(addr), value);
            assert_eq!(nes.peek_ram(addr), Some(value));
        }
        nes.bus.board.chr_write(0x1fff, 0xa5);
        assert_eq!(nes.bus.board.chr_read(0x1fff), 0xa5);
        let mut ppu = Ppu::new();
        let board = &mut nes.bus.board;
        let address = |ppu: &mut Ppu, board: &mut Board, address: u16| {
            for byte in address.to_be_bytes() {
                ppu.cpu_write(board, 6, byte);
            }
        };
        address(&mut ppu, board, 0x2000);
        ppu.cpu_write(board, 7, 0x42);
        address(&mut ppu, board, 0x2800);
        ppu.cpu_read(board, 7);
        assert_eq!(ppu.cpu_read(board, 7), 0x42);
        board.cpu_write(0x4023, 1, 0);
        board.cpu_write(0x4025, 8, 0);
        address(&mut ppu, board, 0x2400);
        ppu.cpu_read(board, 7);
        assert_eq!(ppu.cpu_read(board, 7), 0x42);
        assert_eq!(nes.disk_side(), Some(0));
        assert!(nes.insert_disk(2));
        assert_eq!(nes.disk_side(), None);
        let mut updated = nes.save_bytes().unwrap().to_vec();
        updated[2 * BASE_TRACK_BYTES + 42] = 0x9a;
        assert!(nes.restore_save(&updated));
        assert!(!nes.restore_save(&updated[..200]));
        nes.reset();
        assert_eq!(nes.peek_ram(0xdfff), Some(0));
        assert_eq!(nes.save_bytes().unwrap(), updated);
        for _ in 0..CHANGE_CYCLES {
            nes.bus.board.tick();
        }
        assert_eq!(nes.disk_side(), Some(2));
    }

    #[test]
    fn disk_register_timing_crc_and_ejection() {
        let mut fds = board();
        fds.cpu_write(0x4025, 0xc5);
        assert_eq!(fds.cpu_read(0x4032, 0x58), 0x5a);
        fds.cpu_write(0x4023, 1);
        fds.cpu_write(0x4025, 0xc7);
        clock(&mut fds, SPINUP_CYCLES);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
        fds.cpu_write(0x4025, 0xc5);
        clock(&mut fds, SPINUP_CYCLES - 1);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
        clock(&mut fds, 1);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 0);
        clock(&mut fds, (LEAD_GAP as u32 + 1) * BYTE_CYCLES - 1);
        assert!(!fds.irq());
        clock(&mut fds, 1);
        assert!(fds.irq());
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x82, 0x80);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x82, 0x80);
        assert!(fds.irq());
        assert_eq!(fds.cpu_read(0x4031, 0), 1);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x82, 0);
        assert!(!fds.irq());
        for index in 1..57 {
            clock(&mut fds, BYTE_CYCLES);
            assert_eq!(fds.cpu_read(0x4030, 0), 0x80);
            let value = fds.cpu_read(0x4031, 0);
            if let Some(&expected) = DISK_SIGNATURE.get(index) {
                assert_eq!(value, expected);
            }
        }
        fds.cpu_write(0x4025, 0xd5);
        clock(&mut fds, BYTE_CYCLES);
        assert_eq!(fds.drive.crc, 0);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x10, 0);
        fds.cpu_write(0x4025, 0);
        fds.disk.tracks[LEAD_GAP + 2] ^= 1;
        fds.cpu_write(0x4025, 0x45);
        clock(
            &mut fds,
            SPINUP_CYCLES + (LEAD_GAP as u32 + 57) * BYTE_CYCLES,
        );
        fds.cpu_write(0x4025, 0x55);
        clock(&mut fds, BYTE_CYCLES);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x10, 0x10);
        fds.eject();
        assert!(!fds.irq());
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 7);
        assert!(!fds.insert(3));
        assert!(fds.insert(1));
        clock(&mut fds, CHANGE_CYCLES - 1);
        assert_eq!(fds.inserted(), None);
        clock(&mut fds, 1);
        assert_eq!(fds.inserted(), Some(1));
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
    }

    #[test]
    fn stopping_a_ready_drive_halts_reads_and_writes_until_restart() {
        let mut fds = board();
        let original = fds.save().to_vec();
        let first_block_cycles = (LEAD_GAP as u32 + 1) * BYTE_CYCLES;

        fds.cpu_write(0x4023, 1);
        fds.cpu_write(0x4025, 0xe5);
        clock(&mut fds, SPINUP_CYCLES);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 0);
        fds.cpu_write(0x4025, 0xe7);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
        clock(&mut fds, SPINUP_CYCLES + first_block_cycles);
        assert!(!fds.irq());
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x80, 0);
        assert_eq!(fds.cpu_read(0x4031, 0), 0);

        fds.cpu_write(0x4025, 0xe5);
        clock(&mut fds, SPINUP_CYCLES - 1);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
        clock(&mut fds, 1 + first_block_cycles);
        assert!(fds.irq());
        assert_eq!(fds.cpu_read(0x4031, 0), DISK_SIGNATURE[0]);

        fds.cpu_write(0x4025, 0xe3);
        fds.cpu_write(0x4024, 0xa5);
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
        clock(&mut fds, SPINUP_CYCLES + first_block_cycles);
        assert!(!fds.irq());
        assert_eq!(fds.revision(), 0);
        assert_eq!(fds.save(), original);

        fds.cpu_write(0x4025, 0xe1);
        clock(&mut fds, SPINUP_CYCLES);
        assert!(fds.irq());
        assert_eq!(fds.revision(), 1);
        assert_eq!(fds.save()[0], 0xa5);
    }

    #[test]
    fn drive_status_reports_media_across_disk_io_toggles() {
        let mut fds = board();
        for enable in [1, 0] {
            fds.cpu_write(0x4023, enable);
            assert_eq!(fds.cpu_read(0x4032, 0x58), 0x5a);
        }

        fds.eject();
        assert_eq!(fds.cpu_read(0x4032, 0x58), 0x5f);
        for enable in [1, 0] {
            fds.cpu_write(0x4023, enable);
            assert_eq!(fds.cpu_read(0x4032, 0x58), 0x5f);
        }

        assert!(fds.insert(1));
        clock(&mut fds, CHANGE_CYCLES);
        assert_eq!(fds.cpu_read(0x4032, 0x58), 0x5a);
    }

    #[test]
    fn timer_irq_write_crc_and_all_sides_snapshot() {
        let mut fds = board();
        fds.cpu_write(0x4020, 2);
        fds.cpu_write(0x4022, 3);
        clock(&mut fds, 3);
        assert!(!fds.irq());
        fds.cpu_write(0x4023, 1);
        fds.cpu_write(0x4022, 3);
        clock(&mut fds, 2);
        assert!(!fds.irq());
        clock(&mut fds, 1);
        assert_eq!(fds.cpu_read(0x4030, 0), 1);
        assert!(!fds.irq());
        clock(&mut fds, 3);
        assert!(fds.irq());
        fds.cpu_write(0x4022, 2);
        assert_eq!(fds.cpu_read(0x4030, 0), 1);
        clock(&mut fds, 6);
        assert_eq!(fds.cpu_read(0x4030, 0), 1);
        clock(&mut fds, 6);
        assert!(!fds.irq());
        for side in [0, 2] {
            assert!(fds.insert(side));
            clock(&mut fds, CHANGE_CYCLES);
            fds.cpu_write(0x4024, 0x80);
            fds.cpu_write(0x4025, 0xc1);
            clock(&mut fds, SPINUP_CYCLES);
            assert!(fds.irq());
            assert_eq!(fds.cpu_read(0x4030, 0) & 0x82, 0x80);
            fds.cpu_write(0x4024, 10 + side as u8);
            assert_eq!(fds.cpu_read(0x4030, 0) & 0x82, 0);
            assert!(!fds.irq());
            clock(&mut fds, BYTE_CYCLES);
            fds.cpu_write(0x4025, 0xd1);
            clock(&mut fds, 2 * BYTE_CYCLES);
            let block = &fds.save()[side * BASE_TRACK_BYTES..][..4];
            assert_eq!(block[..2], [0x80, 10 + side as u8]);
            assert_eq!(block.iter().copied().fold(0, crc_byte), 0);
            fds.cpu_write(0x4025, 0);
        }
        let mut restored = board();
        assert_eq!(restored.save()[1], 0);
        assert!(restored.restore(fds.save()));
        assert_eq!(restored.save(), fds.save());
        assert_eq!(restored.save()[BASE_TRACK_BYTES + 1], 0);
    }

    #[test]
    fn writing_gap_does_not_raise_the_byte_transfer_flag_or_irq() {
        let mut fds = board();
        fds.disk.tracks[..3].fill(0xff);
        fds.cpu_write(0x4023, 1);
        fds.cpu_write(0x4024, 0x80);
        fds.cpu_write(0x4025, 0xa1);
        clock(&mut fds, SPINUP_CYCLES + BYTE_CYCLES);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x80, 0);
        assert!(!fds.irq());
        assert_eq!(&fds.save()[..3], &[0, 0, 0xff]);

        fds.cpu_write(0x4025, 0xe1);
        clock(&mut fds, BYTE_CYCLES);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x80, 0x80);
        assert!(fds.irq());
        assert_eq!(fds.save()[2], 0x80);

        fds.cpu_write(0x4025, 0xa1);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0x80, 0);
        assert!(!fds.irq());
        fds.drive.head = BASE_TRACK_BYTES - 1;
        clock(&mut fds, BYTE_CYCLES);
        assert_eq!(fds.cpu_read(0x4030, 0) & 0xc0, 0x40);
        assert!(!fds.irq());
    }

    #[test]
    fn disabling_disk_io_stops_writes_and_disk_irqs() {
        let mut fds = board();
        let original = fds.save().to_vec();
        let transfer_cycles = SPINUP_CYCLES + (LEAD_GAP as u32 + 56) * BYTE_CYCLES;

        fds.cpu_write(0x4023, 1);
        fds.cpu_write(0x4024, 0x5a);
        fds.cpu_write(0x4025, 0xc1);
        fds.cpu_write(0x4023, 0);
        clock(&mut fds, transfer_cycles);
        assert_eq!(fds.revision(), 0, "disk was written with disk I/O disabled");
        assert!(!fds.irq());
        assert_eq!(fds.save(), original);

        // Enabling the registers again still requires an explicit drive start.
        fds.cpu_write(0x4023, 1);
        clock(&mut fds, transfer_cycles);
        assert!(!fds.irq());
        assert_eq!(fds.cpu_read(0x4032, 0) & 7, 2);
        assert_eq!(fds.save(), original);

        fds.cpu_write(0x4024, 0xa5);
        fds.cpu_write(0x4025, 0xc1);
        clock(&mut fds, SPINUP_CYCLES);
        assert!(fds.irq());
        assert_eq!(fds.save()[0], 0xa5);
    }

    #[test]
    fn expansion_audio_mixes_with_apu_on_shared_sample_clock() {
        let mut fds = board();
        fds.cpu_write(0x4023, 2);
        fds.cpu_write(0x4089, 0x80);
        fds.cpu_write(0x4040, 63);
        fds.cpu_write(0x4089, 0);
        fds.cpu_write(0x4080, 0xa0);
        let mut apu = Apu::new();
        apu.write(0x4011, 32, 0);
        for cycle in 1..=38 {
            apu.tick(cycle, fds.tick());
        }
        let tnd = 32.0 / 22638.0;
        let mixed = 0.22 + 159.79 * tnd / (1.0 + 100.0 * tnd);
        let expected = mixed * 0.9883 * 0.9440 * 0.8400;
        assert_eq!(apu.audio().len(), 1);
        assert!((apu.audio()[0] - expected).abs() < 0.000_001);
        fds.cpu_write(0x4023, 0);
        assert_eq!(fds.tick(), 0.0);
    }

    #[test]
    fn audio_reset_clears_gain_and_phase_until_envelope_is_programmed() {
        let mut fds = board();
        fds.cpu_write(0x4023, 3);
        fds.cpu_write(0x4089, 0x80);
        for addr in 0x4040..=0x407f {
            fds.cpu_write(addr, 32);
        }
        fds.cpu_write(0x4040, 63);
        fds.cpu_write(0x4089, 0);
        fds.cpu_write(0x4080, 0xa0);
        fds.cpu_write(0x4080, 0x40);
        fds.cpu_write(0x408a, 1);
        fds.cpu_write(0x4082, 0xff);
        fds.cpu_write(0x4083, 0x0f);
        assert!(fds.tick() > 0.0);
        clock(&mut fds, 16);
        assert_eq!(fds.cpu_read(0x4040, 0), 32);
        assert_eq!(fds.cpu_read(0x4090, 0), 32);

        fds.cpu_write(0x4023, 1);
        assert_eq!(fds.tick(), 0.0);
        clock(&mut fds, 150_000);
        fds.cpu_write(0x4023, 3);
        assert_eq!(fds.cpu_read(0x4090, 0), 0);
        assert_eq!(fds.cpu_read(0x4040, 0), 63);
        for _ in 0..32 {
            assert_eq!(fds.tick(), 0.0);
        }
        assert_eq!(fds.cpu_read(0x4090, 0), 0);

        fds.cpu_write(0x4080, 0xa0);
        assert_eq!(fds.cpu_read(0x4090, 0), 32);
        assert!(fds.tick() > 0.0);
    }
    #[test]
    #[ignore = "requires the test-only FDS fixtures generated by tests/fds/check.mjs"]
    fn source_fixture_snapshot_continuation() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/generated");
        let image = std::fs::read(root.join("fds-relay.fds")).unwrap();
        let headerless = std::fs::read(root.join("fds-relay-raw.fds")).unwrap();
        let bios = std::fs::read(root.join("fds-bios.rom")).unwrap();
        let make = |image: &[u8], bios: &[u8]| {
            Nes::from_media(Media::parse(image).unwrap(), Some(bios)).unwrap()
        };
        let mut live = make(&image, &bios);
        let mut restored = make(&headerless, &bios);
        let mut captured_transfer = false;
        let mut peak = 0.0f32;
        let original = live.save_bytes().unwrap().to_vec();
        assert_eq!(
            restored
                .decode_disk_save(&live.export_disk_save(&original).unwrap())
                .unwrap(),
            original
        );

        // Catch a transfer with asserted IRQ before fixture firmware acknowledges it.
        for _ in 0..500_000 {
            live.step_instruction();
            if matches!(&live.bus.board, Board::Disk(fds) if fds.drive.transfer && fds.drive.irq) {
                restored.restore_snapshot(&live.snapshot()).unwrap();
                for _ in 0..200 {
                    live.step_instruction();
                    restored.step_instruction();
                }
                assert_eq!(restored.snapshot(), live.snapshot());
                captured_transfer = true;
                break;
            }
        }
        assert!(captured_transfer);

        live = make(&image, &bios);
        for frame in 1..=285 {
            match frame {
                105 => live.eject_disk(),
                106 => {
                    assert!(live.insert_disk(1));
                }
                193 => {
                    assert!(live.insert_disk(2));
                }
                _ => {}
            }
            if [1, 27, 59, 99, 105, 106, 107, 141, 191, 193, 228, 284].contains(&frame) {
                restored.restore_snapshot(&live.snapshot()).unwrap();
                assert!(restored.audio().is_empty());
            } else if frame == 108 {
                assert_eq!(restored.requested_disk_side(), Some(1));
                assert_eq!(restored.disk_side(), None);
            }
            let input = match frame {
                30..=53 | 132..=139 | 219..=226 => 0x80,
                55..=56 | 142..=143 | 229..=230 => 1,
                _ => 0,
            };
            for nes in [&mut live, &mut restored] {
                nes.set_controller(0, input);
                assert!(nes.run_frame());
            }
            assert_eq!(restored.cpu_state(), live.cpu_state());
            assert_eq!(restored.peek_ram(0x12), live.peek_ram(0x12));
            assert_eq!(hash(restored.frame()), hash(live.frame()));
            assert_eq!(restored.audio(), live.audio());
            peak = live
                .audio()
                .iter()
                .fold(peak, |peak, sample| peak.max(sample.abs()));
        }
        assert!(peak > 0.04);
        let progress = live.save_bytes().unwrap();
        for (side, expected) in [0x12, 0x23, 0x34].into_iter().enumerate() {
            assert_eq!(progress[side * BASE_TRACK_BYTES + 3560], expected);
        }
        assert_eq!(restored.save_bytes(), Some(progress));
        let delta = live.export_disk_save(progress).unwrap();
        assert_eq!(restored.decode_disk_save(&delta).unwrap(), progress);
        let before = live.snapshot();
        let mut wrong_bios = bios.clone();
        wrong_bios[1] ^= 1;
        let mut wrong = make(&image, &wrong_bios);
        let wrong_before = wrong.snapshot();
        assert_eq!(wrong.restore_snapshot(&before), Err(SnapshotError::Bios));
        assert_eq!(wrong.snapshot(), wrong_before);
        assert_eq!(wrong.decode_disk_save(&delta).unwrap(), progress);
        let mut different = image.clone();
        different[16 + 22] ^= 1;
        let mut different = make(&different, &bios);
        assert_eq!(
            different.restore_snapshot(&before),
            Err(SnapshotError::Media)
        );
        assert_eq!(
            different.decode_disk_save(&delta),
            Err(SnapshotError::Media)
        );
        assert!(live.restore_snapshot(&before[..before.len() - 1]).is_err());
        assert_eq!(live.snapshot(), before);
    }
}
