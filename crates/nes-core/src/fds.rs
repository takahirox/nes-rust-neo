use crate::{
    Mirroring,
    fds_audio::FdsAudio,
    media::{DISK_SIGNATURE, FDS_BIOS_BYTES, FDS_SIDE_BYTES, MediaError},
};

// A byte cell is eight drive bits. Gaps are rounded to whole byte cells.
const BYTE_CYCLES: u32 = 150;
const SPINUP_CYCLES: u32 = 50_000;
const CHANGE_CYCLES: u32 = 150_000;
const LEAD_GAP: usize = 3537;
const BLOCK_GAP: usize = 121;
const TRACK_BYTES: usize = 98_304;
pub const MAX_DISK_SAVE_BYTES: usize = 255 * TRACK_BYTES;

fn crc_byte(mut crc: u16, value: u8) -> u16 {
    crc ^= u16::from(value);
    for _ in 0..8 {
        crc = (crc >> 1) ^ if crc & 1 == 0 { 0 } else { 0x8408 };
    }
    crc
}

fn append_block(
    track: &mut Vec<u8>,
    block: &[u8],
    gap: usize,
    side: usize,
) -> Result<(), MediaError> {
    if track.len() + gap + block.len() + 3 > TRACK_BYTES {
        return Err(MediaError::DiskCapacity(side));
    }
    track.resize(track.len() + gap, 0);
    track.push(0x80);
    track.extend_from_slice(block);
    let crc = block.iter().copied().fold(crc_byte(0, 0x80), crc_byte);
    track.extend_from_slice(&crc.to_le_bytes());
    Ok(())
}

fn expand_side(track: &mut Vec<u8>, raw: &[u8], side: usize) -> Result<(), MediaError> {
    let malformed = || MediaError::DiskSide(side);
    if !raw.starts_with(DISK_SIGNATURE) || raw[56] != 2 {
        return Err(malformed());
    }
    append_block(track, &raw[..56], LEAD_GAP, side)?;
    append_block(track, &raw[56..58], BLOCK_GAP, side)?;
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
        append_block(track, file, BLOCK_GAP, side)?;
        append_block(track, data, BLOCK_GAP, side)?;
        rest = &rest[17 + length..];
        files += 1;
    }
    if files < usize::from(raw[57]) || rest.iter().any(|&byte| byte != 0) {
        return Err(malformed());
    }
    track.resize(TRACK_BYTES, 0);
    Ok(())
}

pub struct Disk {
    tracks: Vec<u8>,
}

impl Disk {
    pub(crate) fn from_sides(sides: &[u8]) -> Result<Self, MediaError> {
        let mut tracks = Vec::with_capacity(sides.len() / FDS_SIDE_BYTES * TRACK_BYTES);
        let mut track = Vec::with_capacity(TRACK_BYTES);
        for (index, raw) in sides.as_chunks::<FDS_SIDE_BYTES>().0.iter().enumerate() {
            track.clear();
            expand_side(&mut track, raw, index)?;
            tracks.extend_from_slice(&track);
        }
        Ok(Self { tracks })
    }

    pub fn side_count(&self) -> usize {
        self.tracks.len() / TRACK_BYTES
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
        Some(side * TRACK_BYTES + self.head)
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
        if self.control & 0x40 == 0 {
            self.crc = 0;
            if self.control & 0x10 == 0 {
                self.complete_transfer();
            }
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
    bios: Box<[u8; FDS_BIOS_BYTES]>,
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
            bios: Box::new(*bios),
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
        if let Some(index) = self.drive.clock() {
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
            if self.drive.head == TRACK_BYTES {
                self.drive.control &= !1;
                self.drive.ready = false;
                self.drive.irq |= self.drive.control & 0x80 != 0;
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
                    let status = (open & 0x24)
                        | u8::from(self.timer.irq)
                        | (self.drive.control & 8)
                        | (u8::from(self.drive.crc_error) << 4)
                        | (u8::from(self.drive.head == TRACK_BYTES) << 6)
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
            }
            0x4026 if self.io & 1 != 0 => self.external = value,
            0x4040..=0x408a if self.io & 2 != 0 => self.audio.write(addr, value),
            _ => {}
        }
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
        updated[2 * TRACK_BYTES + 42] = 0x9a;
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
            let block = &fds.save()[side * TRACK_BYTES..][..4];
            assert_eq!(block[..2], [0x80, 10 + side as u8]);
            assert_eq!(block.iter().copied().fold(0, crc_byte), 0);
            fds.cpu_write(0x4025, 0);
        }
        let mut restored = board();
        assert_eq!(restored.save()[1], 0);
        assert!(restored.restore(fds.save()));
        assert_eq!(restored.save(), fds.save());
        assert_eq!(restored.save()[TRACK_BYTES + 1], 0);
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
}
