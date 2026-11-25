use crate::{HEIGHT, WIDTH};
use crate::{Mirroring, board::Board};

#[rustfmt::skip]
const COLORS: [u32; 64] = [
    0x666666, 0x002a88, 0x1412a7, 0x3b00a4, 0x5c007e, 0x6e0040, 0x6c0600, 0x561d00,
    0x333500, 0x0b4800, 0x005200, 0x004f08, 0x00404d, 0x000000, 0x000000, 0x000000,
    0xadadad, 0x155fd9, 0x4240ff, 0x7527fe, 0xa01acc, 0xb71e7b, 0xb53120, 0x994e00,
    0x6b6d00, 0x388700, 0x0c9300, 0x008f32, 0x007c8d, 0x000000, 0x000000, 0x000000,
    0xfffeff, 0x64b0ff, 0x9290ff, 0xc676ff, 0xf36aff, 0xfe6ecc, 0xfe8170, 0xea9e22,
    0xbcbe00, 0x88d800, 0x5ce430, 0x45e082, 0x48cdde, 0x4f4f4f, 0x000000, 0x000000,
    0xfffeff, 0xc0dfff, 0xd3d2ff, 0xe8c8ff, 0xfbc2ff, 0xfec4ea, 0xfeccc5, 0xf7d8a5,
    0xe4e594, 0xcfef96, 0xbdf4ab, 0xb3f3cc, 0xb5ebf2, 0xb8b8b8, 0x000000, 0x000000,
];

#[derive(Clone, Copy, Default)]
struct Sprite {
    x: u8,
    attr: u8,
    index: u8,
    address: u16,
    lo: u8,
    hi: u8,
}

pub(crate) struct Ppu {
    vram: Box<[u8; 4096]>,
    palette: [u8; 32],
    oam: [u8; 256],
    oam_address: u8,
    ctrl: u8,
    mask: u8,
    status: u8,
    latch: u8,
    buffer: u8,
    v: u16,
    t: u16,
    fine_x: u8,
    second_write: bool,
    scanline: u16,
    dot: u16,
    clock: u64,
    odd: bool,
    frames: u64,
    nmi_line: bool,
    nmi_pending: bool,
    suppress_vblank: bool,
    tile: u8,
    attribute: u8,
    pattern_lo: u8,
    pattern_hi: u8,
    bg: [u16; 4],
    sprites: [Sprite; 8],
    next_sprites: [Sprite; 8],
    sprite_count: usize,
    next_count: usize,
    frame: Vec<u8>,
}

impl Ppu {
    pub fn new() -> Self {
        Self {
            vram: Box::new([0; 4096]),
            palette: [0; 32],
            oam: [0xff; 256],
            oam_address: 0,
            ctrl: 0,
            mask: 0,
            status: 0,
            latch: 0,
            buffer: 0,
            v: 0,
            t: 0,
            fine_x: 0,
            second_write: false,
            scanline: 261,
            dot: 0,
            clock: 0,
            odd: false,
            frames: 0,
            nmi_line: false,
            nmi_pending: false,
            suppress_vblank: false,
            tile: 0,
            attribute: 0,
            pattern_lo: 0,
            pattern_hi: 0,
            bg: [0; 4],
            sprites: [Sprite::default(); 8],
            next_sprites: [Sprite::default(); 8],
            sprite_count: 0,
            next_count: 0,
            frame: vec![0; WIDTH * HEIGHT * 4],
        }
    }

    pub fn frame(&self) -> &[u8] {
        &self.frame
    }
    pub fn frames(&self) -> u64 {
        self.frames
    }
    pub fn position(&self) -> (u16, u16) {
        (self.scanline, self.dot)
    }
    pub fn take_nmi(&mut self) -> bool {
        std::mem::take(&mut self.nmi_pending)
    }

    fn update_nmi(&mut self) {
        let level = self.ctrl & self.status & 0x80 != 0;
        self.nmi_pending |= level && !self.nmi_line;
        self.nmi_line = level;
    }

    fn rendering(&self) -> bool {
        self.mask & 0x18 != 0
    }
    fn render_line(&self) -> bool {
        self.scanline < 240 || self.scanline == 261
    }

    fn nametable(address: u16, mirroring: Mirroring) -> usize {
        let index = usize::from((address - 0x2000) & 0xfff);
        match mirroring {
            Mirroring::Horizontal => ((index & 0x800) >> 1) | (index & 0x3ff),
            Mirroring::Vertical => index & 0x7ff,
            Mirroring::SingleLower => index & 0x3ff,
            Mirroring::SingleUpper => (index & 0x3ff) | 0x400,
            Mirroring::FourScreen => index,
        }
    }

    fn palette_address(address: u16) -> usize {
        let index = usize::from(address & 31);
        if index & 0x13 == 0x10 {
            index - 16
        } else {
            index
        }
    }

    fn read(&self, board: &mut Board, address: u16) -> u8 {
        let address = address & 0x3fff;
        board.ppu_address(address, self.clock);
        match address {
            0..=0x1fff => board.chr_read(address),
            0x2000..=0x3eff => self.vram[Self::nametable(address, board.mirroring())],
            _ => self.palette[Self::palette_address(address)],
        }
    }

    fn write(&mut self, board: &mut Board, address: u16, value: u8) {
        let address = address & 0x3fff;
        board.ppu_address(address, self.clock);
        match address {
            0..=0x1fff => board.chr_write(address, value),
            0x2000..=0x3eff => self.vram[Self::nametable(address, board.mirroring())] = value,
            _ => self.palette[Self::palette_address(address)] = value & 0x3f,
        }
    }

    fn increment_x(&mut self) {
        if self.v & 31 == 31 {
            self.v = (self.v & !31) ^ 0x400;
        } else {
            self.v += 1;
        }
    }

    fn increment_y(&mut self) {
        if self.v & 0x7000 != 0x7000 {
            self.v += 0x1000;
            return;
        }
        self.v &= !0x7000;
        let coarse_y = (self.v >> 5) & 31;
        let next = match coarse_y {
            29 => {
                self.v ^= 0x800;
                0
            }
            31 => 0,
            _ => coarse_y + 1,
        };
        self.v = (self.v & !0x3e0) | (next << 5);
    }

    fn increment_data(&mut self, board: &mut Board) {
        if self.rendering() && self.render_line() {
            self.increment_x();
            self.increment_y();
        } else {
            self.v = self.v.wrapping_add(if self.ctrl & 4 != 0 { 32 } else { 1 }) & 0x7fff;
            board.ppu_address(self.v & 0x3fff, self.clock);
        }
    }

    pub fn cpu_read(&mut self, board: &mut Board, reg: u16) -> u8 {
        self.latch = match reg {
            2 => {
                if self.scanline == 241 && self.dot <= 1 {
                    self.suppress_vblank = true;
                }
                let out = (self.status & 0xe0) | (self.latch & 31);
                self.status &= !0x80;
                self.second_write = false;
                self.update_nmi();
                out
            }
            4 => self.oam[usize::from(self.oam_address)],
            7 => {
                let address = self.v & 0x3fff;
                let old = self.buffer;
                let out = if address >= 0x3f00 {
                    self.buffer = self.read(board, address - 0x1000);
                    let color = self.palette[Self::palette_address(address)];
                    (color & if self.mask & 1 == 0 { 0x3f } else { 0x30 }) | (self.latch & 0xc0)
                } else {
                    self.buffer = self.read(board, address);
                    old
                };
                self.increment_data(board);
                out
            }
            _ => self.latch,
        };
        self.latch
    }

    pub fn cpu_write(&mut self, board: &mut Board, reg: u16, value: u8) {
        self.latch = value;
        match reg {
            0 => {
                self.ctrl = value;
                self.t = (self.t & !0xc00) | (u16::from(value & 3) << 10);
                self.update_nmi();
            }
            1 => self.mask = value,
            3 => self.oam_address = value,
            4 => {
                if self.rendering() && self.render_line() {
                    self.oam_address = self.oam_address.wrapping_add(4);
                } else {
                    self.dma_write(value);
                }
            }
            5 => {
                if self.second_write {
                    self.t = (self.t & !0x73e0)
                        | (u16::from(value & 7) << 12)
                        | (u16::from(value & 0xf8) << 2);
                } else {
                    self.t = (self.t & !31) | u16::from(value >> 3);
                    self.fine_x = value & 7;
                }
                self.second_write = !self.second_write;
            }
            6 => {
                if self.second_write {
                    self.t = (self.t & 0x7f00) | u16::from(value);
                    self.v = self.t;
                    if !self.rendering() || !self.render_line() {
                        board.ppu_address(self.v & 0x3fff, self.clock);
                    }
                } else {
                    self.t = (self.t & 0xff) | (u16::from(value & 0x3f) << 8);
                }
                self.second_write = !self.second_write;
            }
            7 => {
                self.write(board, self.v, value);
                self.increment_data(board);
            }
            _ => {}
        }
    }

    pub fn dma_write(&mut self, value: u8) {
        let masked = if self.oam_address & 3 == 2 {
            value & 0xe3
        } else {
            value
        };
        self.oam[usize::from(self.oam_address)] = masked;
        self.oam_address = self.oam_address.wrapping_add(1);
    }

    fn background_fetch(&mut self, board: &mut Board) {
        let pattern_address =
            (u16::from(self.ctrl & 0x10) << 8) | (u16::from(self.tile) << 4) | (self.v >> 12);
        match self.dot & 7 {
            1 => {
                self.load_background();
                self.tile = self.read(board, 0x2000 | (self.v & 0xfff));
            }
            3 => {
                let addr = 0x23c0 | (self.v & 0xc00) | ((self.v >> 4) & 0x38) | ((self.v >> 2) & 7);
                let quadrant = ((self.v >> 4) & 4) | (self.v & 2);
                self.attribute = (self.read(board, addr) >> quadrant) & 3;
            }
            5 => self.pattern_lo = self.read(board, pattern_address),
            7 => self.pattern_hi = self.read(board, pattern_address + 8),
            0 => self.increment_x(),
            _ => {}
        }
    }

    fn load_background(&mut self) {
        let [lo, hi, a0, a1] = &mut self.bg;
        *lo = (*lo & 0xff00) | u16::from(self.pattern_lo);
        *hi = (*hi & 0xff00) | u16::from(self.pattern_hi);
        *a0 = (*a0 & 0xff00) | if self.attribute & 1 != 0 { 255 } else { 0 };
        *a1 = (*a1 & 0xff00) | if self.attribute & 2 != 0 { 255 } else { 0 };
    }

    fn select_sprites(&mut self) {
        self.next_count = 0;
        let tall = self.ctrl & 0x20 != 0;
        let height = if tall { 16 } else { 8 };
        let table = u16::from(self.ctrl & 8) << 9;
        let empty_address = if tall { 0x1ff0 } else { table | 0xff0 };
        self.next_sprites.fill(Sprite {
            address: empty_address,
            ..Sprite::default()
        });
        let target = if self.scanline == 261 {
            0
        } else {
            self.scanline + 1
        };
        for (index, &[y, tile, attr, x]) in self.oam.as_chunks::<4>().0.iter().enumerate() {
            let Some(mut row) = target.checked_sub(u16::from(y) + 1) else {
                continue;
            };
            if row >= height {
                continue;
            }
            if self.next_count == 8 {
                self.status |= 0x20;
                break;
            }
            if attr & 0x80 != 0 {
                row = height - 1 - row;
            }
            let address = if tall {
                (u16::from(tile & 1) << 12)
                    | (u16::from(tile & 0xfe) << 4)
                    | ((row & 8) << 1)
                    | (row & 7)
            } else {
                table | (u16::from(tile) << 4) | row
            };
            self.next_sprites[self.next_count] = Sprite {
                x,
                attr,
                index: index as u8,
                address,
                lo: 0,
                hi: 0,
            };
            self.next_count += 1;
        }
    }

    fn sprite_fetch(&mut self, board: &mut Board) {
        self.oam_address = 0;
        let offset = usize::from(self.dot - 257);
        let slot = offset / 8;
        let address = self.next_sprites[slot].address;
        match offset % 8 {
            0 | 2 => {
                self.read(board, 0x2000 | (self.v & 0xfff));
            }
            4 => self.next_sprites[slot].lo = self.read(board, address),
            6 => self.next_sprites[slot].hi = self.read(board, address + 8),
            _ => {}
        }
    }

    fn sprite_pixel(&self, x: u8) -> Option<(Sprite, u8)> {
        for &sprite in &self.sprites[..self.sprite_count] {
            let Some(column) = x.checked_sub(sprite.x) else {
                continue;
            };
            if column >= 8 {
                continue;
            }
            let shift = if sprite.attr & 0x40 == 0 {
                7 - column
            } else {
                column
            };
            let color = ((sprite.lo >> shift) & 1) | (((sprite.hi >> shift) & 1) << 1);
            if color != 0 {
                return Some((sprite, color));
            }
        }
        None
    }

    fn pixel(&mut self) {
        let x = (self.dot - 1) as u8;
        let background = if self.mask & 8 != 0 && (x >= 8 || self.mask & 2 != 0) {
            let bit = 15 - self.fine_x;
            self.bg
                .iter()
                .enumerate()
                .fold(0, |out, (i, &bits)| out | (((bits >> bit) & 1) as u8) << i)
        } else {
            0
        };
        let opaque = background & 3 != 0;
        let mut index = if opaque { background } else { 0 };
        if self.mask & 0x10 != 0
            && (x >= 8 || self.mask & 4 != 0)
            && let Some((sprite, color)) = self.sprite_pixel(x)
        {
            if opaque && sprite.index == 0 && x != 255 {
                self.status |= 0x40;
            }
            if !opaque || sprite.attr & 0x20 == 0 {
                index = 16 | ((sprite.attr & 3) << 2) | color;
            }
        }
        if !self.rendering() && self.v & 0x3f00 == 0x3f00 {
            index = Self::palette_address(self.v) as u8;
        }
        let color = self.palette[usize::from(index)] & if self.mask & 1 != 0 { 0x30 } else { 0x3f };
        let [_, mut r, mut g, mut b] = COLORS[usize::from(color)].to_be_bytes();
        let emphasis = self.mask >> 5;
        let attenuate = |value| (u16::from(value) * 3 / 4) as u8;
        if emphasis & 6 != 0 {
            r = attenuate(r);
        }
        if emphasis & 5 != 0 {
            g = attenuate(g);
        }
        if emphasis & 3 != 0 {
            b = attenuate(b);
        }
        let offset = (usize::from(self.scanline) * WIDTH + usize::from(x)) * 4;
        self.frame[offset..offset + 4].copy_from_slice(&[r, g, b, 255]);
    }

    pub fn tick(&mut self, board: &mut Board) {
        if self.scanline == 241 && self.dot == 1 {
            if !self.suppress_vblank {
                self.status |= 0x80;
            }
            self.suppress_vblank = false;
            self.update_nmi();
            self.frames += 1;
        } else if self.scanline == 261 && self.dot == 1 {
            self.status &= !0xe0;
            self.update_nmi();
        }

        if self.rendering() && self.render_line() {
            if (2..=257).contains(&self.dot) || (322..=337).contains(&self.dot) {
                for bits in &mut self.bg {
                    *bits <<= 1;
                }
            }
            if (1..=256).contains(&self.dot) || (321..=336).contains(&self.dot) {
                self.background_fetch(board);
            }
            match self.dot {
                256 => self.increment_y(),
                257 => {
                    self.load_background();
                    self.v = (self.v & !0x41f) | (self.t & 0x41f);
                    self.select_sprites();
                }
                337 => {
                    self.load_background();
                    self.read(board, 0x2000 | (self.v & 0xfff));
                }
                339 => {
                    self.read(board, 0x2000 | (self.v & 0xfff));
                }
                _ => {}
            }
            if (257..=320).contains(&self.dot) {
                self.sprite_fetch(board);
            }
            if self.scanline == 261 && (280..=304).contains(&self.dot) {
                self.v = (self.v & !0x7be0) | (self.t & 0x7be0);
            }
        }
        if self.scanline < 240 && (1..=256).contains(&self.dot) {
            self.pixel();
        }

        self.clock += 1;
        let skip = self.rendering() && self.odd && self.scanline == 261 && self.dot == 339;
        if self.dot == 340 || skip {
            self.dot = 0;
            if self.scanline == 261 {
                self.scanline = 0;
                self.odd = !self.odd;
            } else {
                self.scanline += 1;
            }
            self.sprites = self.next_sprites;
            self.sprite_count = self.next_count;
        } else {
            self.dot += 1;
        }
    }
}
