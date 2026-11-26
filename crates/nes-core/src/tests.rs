use super::*;
use crate::apu::Apu;
use crate::cpu::CpuBus;
use crate::ppu::Ppu;

fn rom(mapper: u8, prg: u8, chr: u8, flags: u8) -> Vec<u8> {
    let trainer = if flags & 4 == 0 { 0 } else { 512 };
    let mut bytes = vec![0xff; 16 + trainer + usize::from(prg) * 16384 + usize::from(chr) * 8192];
    bytes[..16].fill(0);
    bytes[..4].copy_from_slice(b"NES\x1a");
    bytes[4] = prg;
    bytes[5] = chr;
    bytes[6] = (mapper << 4) | flags;
    bytes[7] = mapper & 0xf0;
    bytes
}

fn program(code: &[u8]) -> Nes {
    let mut bytes = rom(0, 1, 0, 0);
    bytes[16..16 + code.len()].copy_from_slice(code);
    bytes[16 + 0x3ffa..].copy_from_slice(&[0, 0x80, 0, 0x80, 0, 0x80]);
    Nes::from_ines(&bytes).unwrap()
}

#[test]
fn ines_formats_trainer_and_battery() {
    assert!(matches!(
        Cartridge::from_ines(b"NES\x1a"),
        Err(RomError::Header)
    ));
    assert!(matches!(
        Cartridge::from_ines(&rom(99, 1, 0, 0)),
        Err(RomError::Mapper(99))
    ));
    assert!(matches!(
        Cartridge::from_ines(&rom(0, 0, 0, 0)),
        Err(RomError::Layout(0))
    ));
    let mut bytes = rom(0, 1, 0, 7);
    bytes[16] = 42;
    bytes[16 + 512] = 24;
    assert!(matches!(
        Cartridge::from_ines(&bytes[..bytes.len() - 1]),
        Err(RomError::Truncated { .. })
    ));
    let mut cart = Cartridge::from_ines(&bytes).unwrap();
    assert_eq!(cart.mirroring(), Mirroring::Vertical);
    assert_eq!(cart.cpu_read(0x7000, 0), 42);
    assert_eq!(cart.cpu_read(0x8000, 0), 24);
    assert_eq!(cart.cpu_read(0xc000, 0), 24);
    assert_eq!(cart.cpu_read(0x5000, 55), 55);
    assert_eq!(cart.chr_read(0x123), 0);
    cart.chr_write(0x123, 33);
    assert_eq!(cart.chr_read(0x123), 33);
    assert!(!cart.restore_battery_ram(&[0]));
    assert!(cart.restore_battery_ram(&[9; 8192]));
    cart.cpu_write(0x6000, 73, 0);
    cart.reset();
    assert_eq!(cart.battery_ram().unwrap()[0], 73);
    assert_eq!(cart.save_revision(), 1);
    bytes[7] = 8;
    assert!(matches!(
        Cartridge::from_ines(&bytes),
        Err(RomError::Format("NES 2.0"))
    ));
    bytes[7] = 0;
    bytes[9] = 1;
    assert!(matches!(
        Cartridge::from_ines(&bytes),
        Err(RomError::Format("PAL"))
    ));
}

#[test]
fn discrete_mapper_banks() {
    let mut bytes = rom(2, 4, 0, 0);
    for bank in 0..4 {
        bytes[16 + bank * 16384] = bank as u8;
    }
    let mut cart = Cartridge::from_ines(&bytes).unwrap();
    assert_eq!(cart.cpu_read(0x8000, 0), 0);
    cart.cpu_write(0x9234, 2, 0);
    assert_eq!(cart.cpu_read(0x8000, 0), 2);
    assert_eq!(cart.cpu_read(0xc000, 0), 3);
    let mut bytes = rom(3, 1, 4, 0);
    for bank in 0..4 {
        bytes[16 + 16384 + bank * 8192] = (10 + bank) as u8;
    }
    bytes[16] = 1; // D1 tied low by the ROM during this write.
    let mut cart = Cartridge::from_ines(&bytes).unwrap();
    cart.cpu_write(0x8000, 3, 0);
    assert_eq!(cart.chr_read(0), 11);
    cart.cpu_write(0x8001, 3, 1);
    cart.chr_write(0, 50);
    assert_eq!(cart.chr_read(0), 13);
}

#[test]
fn mmc1_serial_and_ram_protection() {
    let mut bytes = rom(1, 4, 2, 0);
    for bank in 0..4 {
        bytes[16 + bank * 16384] = bank as u8;
        bytes[16 + 4 * 16384 + bank * 4096] = (bank + 8) as u8;
    }
    let mut cart = Cartridge::from_ines(&bytes).unwrap();
    let mut cycle = 0;
    let mut serial = |cart: &mut Cartridge, addr: u16, data: u8| {
        for shift in 0..5 {
            cycle += 2;
            cart.cpu_write(addr, (data >> shift) & 1, cycle);
            cart.cpu_write(addr, 0x80, cycle + 1); // Ignored consecutive RMW write.
        }
    };
    assert_eq!(cart.mirroring(), Mirroring::SingleLower);
    assert_eq!(cart.cpu_read(0xc000, 0), 3);
    serial(&mut cart, 0x8000, 0x1b);
    assert_eq!(cart.mirroring(), Mirroring::Horizontal);
    serial(&mut cart, 0xa000, 3);
    serial(&mut cart, 0xc000, 1);
    assert_eq!((cart.chr_read(0), cart.chr_read(0x1000)), (11, 9));
    serial(&mut cart, 0xe000, 2);
    assert_eq!((cart.cpu_read(0x8000, 0), cart.cpu_read(0xc000, 0)), (0, 2));
    cart.cpu_write(0x6000, 5, 0);
    serial(&mut cart, 0xe000, 0x10);
    cart.cpu_write(0x6000, 7, 0);
    assert_eq!(cart.cpu_read(0x6000, 99), 99);
    assert_eq!(cart.ram_at(0x6000), 5);
}

#[test]
fn mmc1_surom_selects_512k_prg_half_with_chr_bit() {
    assert!(matches!(
        Cartridge::from_ines(&rom(1, 32, 2, 0)),
        Err(RomError::Layout(1))
    ));
    let mut bytes = rom(1, 32, 0, 2);
    for bank in 0..32 {
        bytes[16 + bank * 16384] = bank as u8;
    }
    let mut cart = Cartridge::from_ines(&bytes).unwrap();
    let mut cycle = 0;
    let mut serial = |cart: &mut Cartridge, addr: u16, data: u8| {
        for shift in 0..5 {
            cycle += 2;
            cart.cpu_write(addr, (data >> shift) & 1, cycle);
        }
    };
    assert_eq!(
        (cart.cpu_read(0x8000, 0), cart.cpu_read(0xc000, 0)),
        (0, 15)
    );
    serial(&mut cart, 0xe000, 3);
    serial(&mut cart, 0xa000, 0x10);
    assert_eq!(
        (cart.cpu_read(0x8000, 0), cart.cpu_read(0xc000, 0)),
        (19, 31)
    );
    serial(&mut cart, 0x8000, 0x08);
    assert_eq!(
        (cart.cpu_read(0x8000, 0), cart.cpu_read(0xc000, 0)),
        (16, 19)
    );
    serial(&mut cart, 0x8000, 0x00);
    serial(&mut cart, 0xe000, 4);
    assert_eq!(
        (cart.cpu_read(0x8000, 0), cart.cpu_read(0xc000, 0)),
        (20, 21)
    );
    serial(&mut cart, 0xa000, 0);
    assert_eq!(cart.cpu_read(0x8000, 0), 4);
    cart.chr_write(0x1234, 6);
    assert_eq!(cart.chr_read(0x1234), 6);
}

#[test]
fn mmc3_banking_mirroring_and_scanline_irq() {
    let mut bytes = rom(4, 4, 2, 0);
    for bank in 0..8 {
        bytes[16 + bank * 8192] = bank as u8;
    }
    for bank in 0..16 {
        bytes[16 + 4 * 16384 + bank * 1024] = (bank + 16) as u8;
    }
    let mut cart = Cartridge::from_ines(&bytes).unwrap();
    cart.cpu_write(0x8000, 6, 0);
    cart.cpu_write(0x8001, 5, 0);
    assert_eq!(
        (
            cart.cpu_read(0x8000, 0),
            cart.cpu_read(0xc000, 0),
            cart.cpu_read(0xe000, 0)
        ),
        (5, 6, 7)
    );
    cart.cpu_write(0x8000, 0xc0, 0);
    cart.cpu_write(0x8001, 9, 0);
    assert_eq!((cart.cpu_read(0x8000, 0), cart.cpu_read(0xc000, 0)), (6, 5));
    assert_eq!((cart.chr_read(0x1000), cart.chr_read(0x1400)), (24, 25));
    cart.cpu_write(0xa000, 0, 0);
    assert_eq!(cart.mirroring(), Mirroring::Vertical);
    cart.cpu_write(0xa001, 0xc0, 0);
    cart.cpu_write(0x6000, 9, 0);
    assert_eq!(cart.cpu_read(0x6000, 0xff), 0);
    cart.cpu_write(0xc000, 2, 0);
    cart.cpu_write(0xc001, 0, 0);
    cart.cpu_write(0xe001, 0, 0);
    let mut cart = crate::Board::Cartridge(Box::new(cart));
    let mut ppu = Ppu::new();
    ppu.cpu_write(&mut cart, 0, 8); // Sprite patterns $1000, background $0000.
    ppu.cpu_write(&mut cart, 1, 0x18);
    for _ in 0..(341 * 2 + 261) {
        ppu.tick(&mut cart);
    }
    assert!(!cart.irq());
    ppu.tick(&mut cart);
    assert!(cart.irq());
    cart.cpu_write(0xe000, 0, 0);
    assert!(!cart.irq());
}

#[test]
fn cpu_binary_arithmetic_branch_cycles_and_indirect_wrap() {
    let mut nes = program(&[
        0xf8, // SED
        0x18, // CLC
        0xa9, 0x49, // LDA #$49
        0x69, 0x51, // ADC #$51
        0x85, 0x20, // STA $20
        0x10, 0x01, // BPL (not taken)
        0x50, 0x01, // BVC (not taken)
        0x70, 0x01, // BVS (taken)
        0x02, // JAM (skipped)
        0x6c, 0xff, 0x02, // JMP ($02ff)
    ]);
    nes.bus.ram[0x2ff] = 0x10;
    nes.bus.ram[0x200] = 0x81;
    nes.bus.ram[0x300] = 0x82;
    assert_eq!(nes.cpu_cycles(), 7);
    assert_eq!(nes.cpu_state().sp, 0xfd);
    for cycles in [2, 2, 2, 2, 3, 2, 2, 3, 5] {
        let before = nes.cpu_cycles();
        nes.step_instruction();
        assert_eq!(nes.cpu_cycles() - before, cycles);
    }
    assert_eq!(nes.peek_ram(0x0820), Some(0x9a));
    assert_eq!(nes.cpu_state().status, 0xec);
    assert_eq!(nes.cpu_state().pc, 0x8110);
}

#[test]
fn cpu_stack_page_cross_and_jam() {
    let mut nes = program(&[0xa2, 1, 0xbd, 0xff, 0x01, 0x48, 0xa9, 0, 0x68, 0x02]);
    nes.bus.ram[0x200] = 0x87;
    nes.step_instruction();
    let cycles = nes.cpu_cycles();
    nes.step_instruction();
    assert_eq!(nes.cpu_cycles() - cycles, 5);
    for _ in 0..3 {
        nes.step_instruction();
    }
    assert_eq!(nes.cpu_state().a, 0x87);
    assert_eq!(nes.cpu_state().sp, 0xfd);
    assert!(nes.cpu_state().status & 0x80 != 0);
    assert!(!nes.run_frame());
    nes.reset();
    assert!(!nes.cpu_state().halted);
}

#[test]
fn cpu_irq_cli_latency_brk_and_nmi_priority() {
    struct Pins {
        ram: Box<[u8]>,
        nmi: bool,
        irq: bool,
    }
    impl CpuBus for Pins {
        fn read(&mut self, a: u16) -> u8 {
            self.ram[usize::from(a)]
        }
        fn write(&mut self, a: u16, value: u8) {
            self.ram[usize::from(a)] = value;
        }
        fn take_nmi(&mut self) -> bool {
            std::mem::take(&mut self.nmi)
        }
        fn irq(&self) -> bool {
            self.irq
        }
    }
    let mut pins = Pins {
        ram: vec![0; 65536].into_boxed_slice(),
        irq: false,
        nmi: false,
    };
    pins.ram[0xfffa..].copy_from_slice(&[0, 0xa0, 0, 0x80, 0, 0x90]);
    pins.ram[0x8000..0x8004].copy_from_slice(&[0x58, 0xea, 0, 0xea]);
    pins.ram[0x9000] = 0x40;
    pins.ram[0xa000] = 0x40;
    let mut cpu = Cpu::new();
    cpu.reset(&mut pins);
    pins.irq = true;
    cpu.step(&mut pins); // CLI
    cpu.step(&mut pins); // NOP completes before IRQ
    assert_eq!(cpu.state().pc, 0x8002);
    cpu.step(&mut pins);
    assert_eq!(cpu.state().pc, 0x9000);
    assert_eq!(&pins.ram[0x1fb..=0x1fd], &[0x20, 2, 0x80]);
    pins.irq = false;
    cpu.step(&mut pins); // RTI
    cpu.step(&mut pins); // BRK
    assert_eq!(&pins.ram[0x1fb..=0x1fd], &[0x30, 4, 0x80]);
    cpu.step(&mut pins);
    pins.irq = true;
    pins.nmi = true;
    cpu.step(&mut pins);
    assert_eq!(cpu.state().pc, 0xa000);
}

#[test]
fn controller_latch_open_bus_and_oam_dma() {
    let mut nes = program(&[0xa9, 2, 0x8d, 0x14, 0x40, 0xea, 0x4c, 5, 0x80]);
    nes.set_controller(0, 0x95);
    nes.set_controller(1, 0x6a);
    nes.bus.write(0x4016, 1);
    assert_eq!(nes.bus.read(0x4016) & 1, 1);
    assert_eq!(nes.bus.read(0x4016) & 1, 1);
    nes.bus.write(0x4016, 0);
    nes.set_controller(0, 0);
    for i in 0..10 {
        nes.bus.write(0x4018, 0xe0);
        let zero = nes.bus.read(0x4016);
        let one = nes.bus.read(0x4017);
        assert_eq!(zero, 0xe0 | if i < 8 { (0x95 >> i) & 1 } else { 1 });
        assert_eq!(one, 0xe0 | if i < 8 { (0x6a >> i) & 1 } else { 1 });
    }
    nes.bus.ram[0x200] = 0x77;
    nes.bus.ram[0x202] = 0xff;
    nes.bus.ram[0x2ff] = 0x88;
    nes.step_instruction();
    let start = nes.cpu_cycles();
    nes.step_instruction();
    assert_eq!(nes.cpu_cycles() - start, 4 + 513 + (start & 1));
    for (address, expected) in [(0, 0x77), (2, 0xe3), (255, 0x88)] {
        nes.bus.write(0x2003, address);
        assert_eq!(nes.bus.read(0x2004), expected);
    }
}

fn ppaddr(ppu: &mut Ppu, cart: &mut crate::Board, address: u16) {
    let [hi, lo] = address.to_be_bytes();
    ppu.cpu_write(cart, 6, hi);
    ppu.cpu_write(cart, 6, lo);
}

fn ppwrite(ppu: &mut Ppu, cart: &mut crate::Board, address: u16, value: u8) {
    ppaddr(ppu, cart, address);
    ppu.cpu_write(cart, 7, value);
}

#[test]
fn ppu_register_buffer_mirroring_and_nmi_edge() {
    let cart = Cartridge::from_ines(&rom(0, 1, 0, 1)).unwrap();
    let mut cart = crate::Board::Cartridge(Box::new(cart));
    let mut ppu = Ppu::new();
    ppwrite(&mut ppu, &mut cart, 0x2000, 55);
    ppwrite(&mut ppu, &mut cart, 0x2400, 66);
    ppaddr(&mut ppu, &mut cart, 0x2800);
    assert_eq!(ppu.cpu_read(&mut cart, 7), 0);
    assert_eq!(ppu.cpu_read(&mut cart, 7), 55);
    ppaddr(&mut ppu, &mut cart, 0x2c00);
    ppu.cpu_read(&mut cart, 7);
    assert_eq!(ppu.cpu_read(&mut cart, 7), 66);
    ppwrite(&mut ppu, &mut cart, 0x3f10, 0xff);
    ppaddr(&mut ppu, &mut cart, 0x3f00);
    assert_eq!(ppu.cpu_read(&mut cart, 7), 0x3f);
    ppu.cpu_write(&mut cart, 0, 0x80);
    for _ in 0..82_524 {
        ppu.tick(&mut cart);
    }
    assert_eq!(ppu.frames(), 1);
    assert!(ppu.take_nmi());
    ppu.cpu_write(&mut cart, 0, 0);
    ppu.cpu_write(&mut cart, 0, 0x80);
    assert!(ppu.take_nmi());
    assert_eq!(ppu.cpu_read(&mut cart, 2) & 0x80, 0x80);
    assert_eq!(ppu.cpu_read(&mut cart, 2) & 0x80, 0);
}

#[test]
fn ppu_scroll_pixel_priority_sprite_hit_and_odd_frame() {
    let cart = Cartridge::from_ines(&rom(0, 1, 0, 1)).unwrap();
    let mut cart = crate::Board::Cartridge(Box::new(cart));
    let mut ppu = Ppu::new();
    for (address, value) in [
        (0x3f00, 0x0f),
        (0x3f01, 0x30),
        (0x3f11, 0x21),
        (0x2001, 1),
        (0x2021, 1),
        (0x2400, 1),
        (0x2420, 1),
    ] {
        ppwrite(&mut ppu, &mut cart, address, value);
    }
    for line in 0..8 {
        cart.chr_write(0x10 + line, 0xff);
        cart.chr_write(0x20 + line, 0xff);
    }
    ppu.cpu_write(&mut cart, 3, 0);
    for byte in [7, 2, 0, 2] {
        ppu.cpu_write(&mut cart, 4, byte);
    }
    ppu.cpu_write(&mut cart, 0, 0);
    ppu.cpu_write(&mut cart, 5, 8);
    ppu.cpu_write(&mut cart, 5, 0);
    ppu.cpu_write(&mut cart, 1, 0x1e);
    let mut end = Vec::new();
    for dot in 1..=270_000 {
        let frame = ppu.frames();
        ppu.tick(&mut cart);
        if ppu.frames() != frame {
            end.push(dot);
            if end.len() == 1 {
                let rgb = |x, y| &ppu.frame()[(y * WIDTH + x) * 4..][..3];
                assert_eq!(rgb(0, 0), &[255, 254, 255]);
                assert_eq!(rgb(8, 0), &[0, 0, 0]);
                assert_eq!(rgb(248, 0), &[255, 254, 255]);
                assert_eq!(rgb(2, 8), &[100, 176, 255]);
                assert_eq!(ppu.cpu_read(&mut cart, 2) & 0x40, 0x40);
            }
        }
    }
    assert_eq!(end.len(), 3);
    assert_eq!(end[1] - end[0], 89_341);
    assert_eq!(end[2] - end[1], 89_342);
}

#[test]
fn apu_channels_frame_irq_and_dmc_dma() {
    for (enable, registers) in [
        (1, &[(0x4000, 0xbf), (0x4002, 0x90), (0x4003, 8)][..]),
        (2, &[(0x4004, 0x9f), (0x4006, 0xd0), (0x4007, 8)][..]),
        (4, &[(0x4008, 0xff), (0x400a, 0x3e), (0x400b, 8)][..]),
        (8, &[(0x400c, 0x3f), (0x400e, 9), (0x400f, 8)][..]),
    ] {
        let mut apu = Apu::new();
        apu.write(0x4015, enable, 0);
        for &(address, value) in registers {
            apu.write(address, value, 0);
        }
        assert_eq!(apu.status(0) & 15, enable);
        for cycle in 1..=30_000 {
            apu.tick(cycle, 0.0);
        }
        assert_eq!(apu.audio().len(), 804);
        assert!(apu.audio().iter().any(|sample| sample.abs() > 0.01));
        assert!(apu.irq());
        assert_eq!(apu.status(0x20) & 0x60, 0x60);
        assert!(!apu.irq());
        apu.write(0x4015, 0, 30_000);
        assert_eq!(apu.status(0) & 15, 0);
    }
    let mut nes = program(&[0xea, 0x4c, 0, 0x80]); // DMC byte at $c000 is $ea.
    for (addr, val) in [
        (0x4010, 0x8f),
        (0x4011, 64),
        (0x4012, 0),
        (0x4013, 0),
        (0x4015, 16),
    ] {
        nes.bus.write(addr, val);
    }
    let before = nes.cpu_cycles();
    nes.step_instruction();
    assert_eq!(nes.cpu_cycles() - before, 5 + (before & 1));
    assert_eq!(nes.bus.read(0x4015) & 0x90, 0x80);
    assert_eq!(nes.bus.read(0x4015) & 0x80, 0x80);
    nes.bus.write(0x4015, 0);
    assert_eq!(nes.bus.read(0x4015) & 0x80, 0);
    assert!(nes.run_frame());
    assert!(nes.audio().iter().any(|sample| sample.abs() > 0.01));
}

#[test]
fn dmc_fetch_extends_oam_dma_without_losing_bytes() {
    let mut nes = program(&[0x80]);
    for (index, byte) in nes.bus.ram[0x300..0x400].iter_mut().enumerate() {
        *byte = index as u8;
    }
    for (addr, val) in [
        (0x4010, 0x8f),
        (0x4012, 0),
        (0x4013, 0),
        (0x4015, 16),
        (0x4014, 3),
    ] {
        nes.bus.write(addr, val);
    }
    let before = nes.cpu_cycles();
    nes.bus.finish_dma(0x8000);
    assert_eq!(nes.cpu_cycles() - before, 515 + (before & 1));
    assert_eq!(nes.bus.read(0x4015) & 0x80, 0x80);
    for i in 0..=255 {
        nes.bus.write(0x2003, i);
        assert_eq!(nes.bus.read(0x2004), if i & 3 == 2 { i & 0xe3 } else { i });
    }
}

fn snapshot_cart(mapper: u8, banks: u8, battery: bool) -> Vec<u8> {
    let chr = if mapper == 3 { 4 } else { 0 };
    let mut image = rom(mapper, banks, chr, u8::from(battery) * 2);
    // Sample controller shift register, change palette and RAM, and loop.
    let code = [
        0xa9, 1, 0x8d, 0x16, 0x40, 0x4a, 0x8d, 0x16, 0x40, 0xad, 0x16, 0x40, 0x29, 1, 0x85, 1,
        0x8d, 1, 0x60, 0xa9, 0x3f, 0x8d, 6, 0x20, 0xa9, 0, 0x8d, 6, 0x20, 0xa5, 1, 0x69, 0x15,
        0x8d, 7, 0x20, 0x4c, 0, 0xe1,
    ];
    let prg_end = 16 + usize::from(banks) * 16384;
    for bank in 0..usize::from(banks) {
        image[16 + bank * 16384] = 0x90 + bank as u8;
    }
    image[prg_end - 0x1f00..][..code.len()].copy_from_slice(&code);
    image[prg_end - 6..prg_end].copy_from_slice(&[0, 0xe1, 0, 0xe1, 0, 0xe1]);
    if banks == 32 {
        // Reset reads the vector in the lower half before the test switches banks.
        let lower_end = 16 + 16 * 16384;
        image[lower_end - 4..lower_end - 2].copy_from_slice(&[0, 0xe1]);
    }
    if mapper == 3 {
        image[16] = 0xff;
        for bank in 0..4 {
            image[prg_end + bank * 8192] = 0xb0 | bank as u8;
        }
    }
    image
}

#[test]
fn snapshot_continuation_for_every_cartridge_mapper() {
    use crate::snapshot::hash;

    for (mapper, banks, battery) in [
        (0, 1, false),
        (0, 1, true),
        (1, 4, true),
        (1, 32, true),
        (2, 4, false),
        (3, 1, false),
        (4, 4, true),
    ] {
        let image = snapshot_cart(mapper, banks, battery);
        let mut nes = Nes::from_ines(&image).unwrap();
        nes.bus.write(0x6000, 0x81);
        nes.bus.board.chr_write(0, 0xa5);
        match mapper {
            1 => {
                if banks == 32 {
                    // SUROM uses CHR bank 0 bit 4 to select the upper PRG half.
                    for (addr, value) in [(0xa000, 0x10), (0xe000, 3)] {
                        for shift in 0..5 {
                            nes.bus.write(addr, (value >> shift) & 1);
                            nes.bus.read(0);
                        }
                    }
                }
                for _ in 0..4 {
                    nes.bus.write(0x8000, 1);
                    nes.bus.read(0);
                }
            }
            2 => nes.bus.write(0x8000, 1),
            3 => nes.bus.write(0x8000, 2),
            4 => {
                for (addr, value) in [
                    (0x8000, 0xc6),
                    (0x8001, 2),
                    (0xa000, 0),
                    (0xc000, 1),
                    (0xc001, 1),
                    (0xe001, 0),
                ] {
                    nes.bus.write(addr, value);
                }
                let clock = nes.cpu_cycles() * 3;
                nes.bus.board.ppu_address(0, clock - 9);
                nes.bus.board.ppu_address(0x1000, clock);
                nes.bus.board.ppu_address(0, clock);
            }
            _ => {}
        }
        for (addr, value) in [
            (0x4015, 0xff),
            (0x4000, 0xbf),
            (0x4002, 0x99),
            (0x4003, 0xff),
            (0x4008, 0x92),
            (0x400a, 0x31),
            (0x400b, 0x7f),
            (0x400c, 0x1b),
            (0x400e, 0x84),
            (0x400f, 0xff),
            (0x4010, 0x4f),
            (0x4011, 0x21),
            (0x4012, 0x20),
            (0x4013, 2),
            (0x4015, 0xff),
            (0x2001, 0x18),
            (0x4014, 0),
        ] {
            nes.bus.write(addr, value);
        }
        nes.step_instruction(); // Completes OAM DMA before the capture.
        assert!(nes.run_frame());
        if mapper == 1 {
            nes.bus.write(0x8000, 1); // Publish the serial control register.
            nes.bus.read(0);
            for _ in 0..4 {
                nes.bus.write(0xe000, 0);
                nes.bus.read(0);
            }
        }
        nes.set_controller(0, 0xd1);
        nes.bus.write(0x4016, 1);
        nes.bus.write(0x4016, 0);
        assert_eq!(nes.bus.read(0x4016) & 1, 1);
        nes.bus.write(0x4017, 0x80); // Pending APU frame-counter reset.
        let capture = nes.snapshot();
        assert!(capture.len() < 300 * 1024);
        let mut restored = Nes::from_ines(&image).unwrap();
        restored.restore_snapshot(&capture).unwrap();
        assert!(restored.audio().is_empty());
        assert_eq!(restored.snapshot(), capture);
        assert_eq!(nes.bus.read(0x4016), restored.bus.read(0x4016));
        if mapper == 3 {
            assert_eq!(restored.bus.board.chr_read(0), 0xb2);
        } else {
            assert_eq!(restored.bus.board.chr_read(0), 0xa5);
        }
        match mapper {
            1 => {
                assert_eq!(restored.bus.board.mirroring(), Mirroring::Horizontal);
                if banks == 32 {
                    assert_eq!(restored.bus.board.cpu_read(0x8000, 0), 0xa3);
                    assert_eq!(restored.bus.board.cpu_read(0xc000, 0), 0xaf);
                }
                for machine in [&mut nes, &mut restored] {
                    machine.bus.write(0xe000, 1);
                    assert_eq!(machine.bus.board.cpu_read(0x6000, 0x55), 0x55);
                }
            }
            2 => assert_eq!(restored.bus.board.cpu_read(0x8000, 0), 0x91),
            4 => {
                assert_eq!(restored.bus.board.mirroring(), Mirroring::Vertical);
                assert_eq!(restored.bus.board.cpu_read(0x8000, 0), 0x93);
                assert_eq!(restored.bus.board.cpu_read(0xc000, 0), 0x91);
            }
            _ => {}
        }
        let mut frame_hashes = Vec::new();
        for input in [button::A, 0, button::A] {
            for machine in [&mut nes, &mut restored] {
                machine.set_controller(0, input);
                assert!(machine.run_frame(), "mapper {mapper}");
            }
            let frame_hash = hash(nes.frame());
            frame_hashes.push(frame_hash);
            assert_eq!(hash(restored.frame()), frame_hash, "mapper {mapper}");
            assert_eq!(nes.cpu_state(), restored.cpu_state());
            assert_eq!(nes.peek_ram(0x6001), restored.peek_ram(0x6001));
            assert_eq!(nes.peek_ram(1), restored.peek_ram(1));
            assert!(!nes.audio().is_empty());
            assert!(nes.audio().iter().any(|sample| sample.abs() > 0.001));
            assert_eq!(nes.audio(), restored.audio());
            assert_eq!(nes.snapshot(), restored.snapshot());
        }
        assert_ne!(frame_hashes[1], frame_hashes[2]);
    }
}

#[test]
fn snapshot_rejection_preserves_live_machine() {
    use crate::snapshot::hash;
    let image = snapshot_cart(0, 1, true);
    let mut other_image = image.clone();
    other_image[16] ^= 1;
    let other = Nes::from_ines(&other_image).unwrap();
    let mut nes = Nes::from_ines(&image).unwrap();
    assert!(nes.run_frame());
    let before = nes.snapshot();

    assert_eq!(
        nes.restore_snapshot(&other.snapshot()),
        Err(SnapshotError::Media)
    );
    for (offset, expected) in [
        (0, SnapshotError::Format),
        (8, SnapshotError::Version),
        (10, SnapshotError::Media),
        (75, SnapshotError::Format),
        (200, SnapshotError::Integrity),
    ] {
        let mut changed = before.clone();
        changed[offset] ^= 0x80;
        assert_eq!(nes.restore_snapshot(&changed), Err(expected));
    }
    for length in [0, 79, 120, before.len() - 1] {
        assert_eq!(
            nes.restore_snapshot(&before[..length]),
            Err(SnapshotError::Format)
        );
    }
    // A matching checksum still cannot admit an impossible CPU or PPU state.
    let end = before.len() - 32;
    for (offset, value) in [(85, 0), (86, 2), (6544, 0xff)] {
        let mut changed = before.clone();
        changed[offset] = value;
        let digest = hash(&changed[..end]);
        changed[end..].copy_from_slice(&digest);
        assert_eq!(
            nes.restore_snapshot(&changed),
            Err(SnapshotError::State),
            "offset {offset}"
        );
    }
    assert_eq!(nes.snapshot(), before);
}
