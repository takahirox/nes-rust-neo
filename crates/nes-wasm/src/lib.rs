//! Single-threaded browser ABI. JavaScript copies into the staging buffer,
//! and reads output views before the next mutating call.
use std::cell::RefCell;

use nes_core::Nes;

#[derive(Default)]
struct Emulator {
    live: Option<Nes>,
    candidate: Option<Nes>,
    input: Vec<u8>,
    error: String,
}

thread_local! {
    static EMULATOR: RefCell<Emulator> = RefCell::new(Emulator::default());
}

#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(len: usize) -> *mut u8 {
    EMULATOR.with_borrow_mut(|emu| {
        if len > 8 * 1024 * 1024 {
            return std::ptr::null_mut();
        }
        emu.input.resize(len, 0);
        emu.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare_rom() -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        emu.candidate = None;
        match Nes::from_ines(&emu.input) {
            Ok(nes) => {
                emu.candidate = Some(nes);
                true
            }
            Err(err) => {
                emu.error = err.to_string();
                emu.input = Vec::new();
                false
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    EMULATOR.with_borrow(|emu| emu.error.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> usize {
    EMULATOR.with_borrow(|emu| emu.error.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn battery_len() -> usize {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(|nes| nes.cartridge().battery_ram())
            .map_or(0, <[u8]>::len)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn restore_candidate_battery() -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        emu.candidate
            .as_mut()
            .is_some_and(|nes| nes.restore_battery_ram(&emu.input))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn restore_live_battery() -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        emu.live
            .as_mut()
            .is_some_and(|nes| nes.restore_battery_ram(&emu.input))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn candidate_battery_len() -> usize {
    EMULATOR.with_borrow(|emu| {
        emu.candidate
            .as_ref()
            .and_then(|nes| nes.cartridge().battery_ram())
            .map_or(0, <[u8]>::len)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn activate_rom() {
    EMULATOR.with_borrow_mut(|emu| {
        if let Some(nes) = emu.candidate.take() {
            emu.live = Some(nes);
        }
        emu.input = Vec::new();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    EMULATOR.with_borrow_mut(|emu| {
        if let Some(nes) = &mut emu.live {
            nes.reset();
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn run_frame(pad_one: u8, pad_two: u8) -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        emu.live.as_mut().is_some_and(|nes| {
            nes.set_controller(0, pad_one);
            nes.set_controller(1, pad_two);
            nes.run_frame()
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn frame_ptr() -> *const u8 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .map_or(std::ptr::null(), |nes| nes.frame().as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_ptr() -> *const f32 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .map_or(std::ptr::null(), |nes| nes.audio().as_ptr())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn audio_len() -> usize {
    EMULATOR.with_borrow(|emu| emu.live.as_ref().map_or(0, |nes| nes.audio().len()))
}

#[unsafe(no_mangle)]
pub extern "C" fn battery_ptr() -> *const u8 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(|nes| nes.cartridge().battery_ram())
            .map_or(std::ptr::null(), <[u8]>::as_ptr)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn battery_revision() -> u32 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .map_or(0, |nes| nes.cartridge().save_revision())
    })
}

/// Side-effect-free CPU and cartridge RAM access for host diagnostics.
#[unsafe(no_mangle)]
pub extern "C" fn debug_peek_ram(address: u16) -> i32 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(|nes| nes.peek_ram(address))
            .map_or(-1, i32::from)
    })
}
