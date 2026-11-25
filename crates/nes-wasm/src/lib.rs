//! Single-threaded browser ABI. JavaScript copies into the staging buffer,
//! and reads output views before the next mutating call.
use std::cell::RefCell;

use nes_core::{MAX_DISK_SAVE_BYTES, Media, Nes};

#[derive(Default)]
struct Emulator {
    live: Option<Nes>,
    candidate: Option<Nes>,
    media: Option<Media>,
    input: Vec<u8>,
    error: String,
}

thread_local! {
    static EMULATOR: RefCell<Emulator> = RefCell::new(Emulator::default());
}

#[unsafe(no_mangle)]
pub extern "C" fn input_buffer(len: usize) -> *mut u8 {
    EMULATOR.with_borrow_mut(|emu| {
        if len > MAX_DISK_SAVE_BYTES {
            return std::ptr::null_mut();
        }
        emu.input.resize(len, 0);
        emu.input.as_mut_ptr()
    })
}

/// Return 0 on validation failure, 1 for a cartridge, or side count + 1 for a disk.
#[unsafe(no_mangle)]
pub extern "C" fn stage_media() -> usize {
    EMULATOR.with_borrow_mut(|emu| {
        emu.candidate = None;
        emu.media = None;
        let bytes = std::mem::take(&mut emu.input);
        match Media::parse(&bytes) {
            Ok(media) => {
                let kind = match &media {
                    Media::Cartridge(_) => 1,
                    Media::Disk(disk) => disk.side_count() + 1,
                };
                emu.media = Some(media);
                kind
            }
            Err(err) => {
                emu.error = err.to_string();
                0
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare_machine() -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        let Some(media) = emu.media.take() else {
            return false;
        };
        let bios = std::mem::take(&mut emu.input);
        match Nes::from_media(media, (!bios.is_empty()).then_some(bios.as_slice())) {
            Ok(nes) => {
                emu.candidate = Some(nes);
                true
            }
            Err(err) => {
                emu.error = err.to_string();
                false
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn discard_candidate() {
    EMULATOR.with_borrow_mut(|emu| {
        emu.candidate = None;
        emu.media = None;
        emu.input = Vec::new();
    });
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
pub extern "C" fn save_len() -> usize {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(Nes::save_bytes)
            .map_or(0, <[u8]>::len)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn restore_candidate_save() -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        let input = std::mem::take(&mut emu.input);
        emu.candidate
            .as_mut()
            .is_some_and(|nes| nes.restore_save(&input))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn restore_live_save() -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        let input = std::mem::take(&mut emu.input);
        emu.live
            .as_mut()
            .is_some_and(|nes| nes.restore_save(&input))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn candidate_save_len() -> usize {
    EMULATOR.with_borrow(|emu| {
        emu.candidate
            .as_ref()
            .and_then(Nes::save_bytes)
            .map_or(0, <[u8]>::len)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn activate_machine() {
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
pub extern "C" fn save_ptr() -> *const u8 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(Nes::save_bytes)
            .map_or(std::ptr::null(), <[u8]>::as_ptr)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn save_revision() -> u32 {
    EMULATOR.with_borrow(|emu| emu.live.as_ref().map_or(0, Nes::save_revision))
}

/// Side-effect-free CPU and program RAM access for host diagnostics.
#[unsafe(no_mangle)]
pub extern "C" fn debug_peek_ram(address: u16) -> i32 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(|nes| nes.peek_ram(address))
            .map_or(-1, i32::from)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn disk_side() -> i32 {
    EMULATOR.with_borrow(|emu| {
        emu.live
            .as_ref()
            .and_then(Nes::disk_side)
            .map_or(-1, |side| side as i32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn select_disk(side: i32) -> bool {
    EMULATOR.with_borrow_mut(|emu| {
        emu.live.as_mut().is_some_and(|nes| {
            if side == -1 && nes.disk_side_count() > 0 {
                nes.eject_disk();
                true
            } else {
                usize::try_from(side).is_ok_and(|side| nes.insert_disk(side))
            }
        })
    })
}
