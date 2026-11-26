# Save states and native save data

A state can be captured after reset or at the end of an instruction, after any
OAM DMA issued by that instruction has completed. The browser captures between
calls to the core, normally just after the instruction that reached VBlank.
The captured framebuffer supplies the preview in the picker and the image shown
immediately after loading. The state includes the CPU, bus and controller
latches, PPU timing and framebuffer, APU sample timing and filters, DMA, and
mapper registers and writable memory. FDS states also preserve the adapter
RAM, writable tracks, drive and disk-change timing, IRQs and expansion audio.
Previously generated samples, Web Audio queues, pressed host keys and wall-clock
pacing are excluded. Emulated controller latches and shift registers remain
intact.

## Version 1

The browser uses `.nesstate` for both NES and FDS. Multi-byte values use
little-endian byte order. The same envelope is used for native FDS backups.

| Offset | Bytes | Field |
| --- | ---: | --- |
| 0 | 8 | ASCII `NESSTATE` or `FDSDELTA` |
| 8 | 2 | Format version, currently 1 |
| 10 | 1 | Media kind, 0 for cartridge and 1 for FDS |
| 11 | 32 | SHA-256 of the exact iNES file or the original FDS side bytes in image order |
| 43 | 32 | SHA-256 of the exact 8 KiB BIOS for FDS states. All zeroes for cartridges and native disk backups |
| 75 | 4 | Payload length |
| 79 | variable | Payload |
| End of payload | 32 | SHA-256 of the 79-byte header and payload |

The subsystem codecs in the core define the state field order. Data uses
fixed-width values, fixed-size buffers and tagged optional fields. The snapshot
contains the writable memories and no immutable ROM or BIOS image. The payload
is uncompressed. For FDS the disk portion is a page bitmap followed by literal
changed pages. The core expands the original sides to tracks, divides their
concatenation into 256-byte pages and uses one bit per page from least to most
significant. Set bits specify pages in track order. The last page can be short.
A browser `.fds-save` contains only this disk delta inside the envelope.
A native `.srm` is the raw 8,192 bytes of battery-backed PRG RAM. It carries
no embedded identity, so use a raw SRAM import only with the ROM that made it.

The decoder validates the envelope, exact media and BIOS identities, checksum,
sizes and machine invariants before preparing a replacement. Cartridge states
are limited to 327,680 bytes. With FDS, the limits are derived from the track
lengths of the mounted image. The absolute limits are 141,290,379 bytes for a
disk backup and 141,618,059 bytes for a machine state, including envelope and
bitmap. The largest decoded disk is bounded by the existing 255-side limit and
the track layout for supported FDS blocks. The decoder takes page counts and
memory lengths from the mounted media, with no file-provided allocation sizes.

Use the exact media and a compatible build. Headered and headerless copies of
the same FDS sides are interchangeable. A state recorded with a different BIOS
requires that exact BIOS even when using the same disk. Future builds can bump
the format version when the wire representation or emulation semantics change.
SNES and other emulators’ state files and the native runner’s existing
`FDS-SAV1` diagnostic files are separate formats. Export native progress for
a backup independent of emulator snapshot compatibility.

## Browser persistence

Each game stores its profile list and last active profile in origin-local
storage. **Save 1** uses the existing native save key. On first open with a
legacy FDS record, the browser converts the stored whole tracks to a delta
after validating their length against the original disk. A failed conversion
retains the old record for retry. Remembered media and the BIOS use their
existing storage. Read-only or non-battery cartridges have a single state
history and no Save data selector.

IndexedDB stores previews and timestamps separately from the snapshot bytes.
An overwrite uses the same entry ID and commits both parts in one transaction.
History reads are paged. State export can be imported into another profile
with the same media and BIOS. The selected target is remembered per game and
profile while the page stays open.

Before loading a state, the browser compares its native data with the live
progress and the last persisted save. It stores each distinct version that
differs from the state in a named **Recovery** profile before writing the
restored native data. Only then does it install the validated machine. If a
required write fails, the running machine stays available and the user can
retry. Select a **Recovery** profile to restart with that version of progress.
Deleting a game from the library retains its profiles and states. Profile
removal requires removing any attached states first.

Use a single tab for a game and its profiles. FDS takes a single-writer lock
for the whole disk, regardless of which profile is selected. Concurrent edits
of the same game are unsupported. Browser storage is local to the origin and
browser profile and offers best-effort durability. Quota failures, eviction or
closing the browser abruptly can lose unsaved progress. Save and export backups
before browser or storage changes.

See the [Issue #9 validation record](issue-9-validation.md) for the reference
revision, browser screenshots and test results.
