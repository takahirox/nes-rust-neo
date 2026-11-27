# nes-rust-neo

An NTSC NES emulator written from scratch in Rust. The browser app starts empty. Open a local iNES cartridge or Famicom Disk System (FDS) image to play with 256×240 video and audio. The frontend builds to static files for GitHub Pages and can also run on localhost.

## Run locally

Use Rust stable 1.88 or newer with rustfmt and Clippy, Node.js 22 or newer, and npm. Install the target with the same Rust toolchain that runs Cargo. On systems with both a system Rust and rustup, put rustup’s toolchain first on PATH.

```sh
rustup component add rustfmt clippy
rustup target add wasm32-unknown-unknown
npm --prefix web ci
npm --prefix web run build
npm --prefix web run serve
```

Open the URL printed by the server. It serves the build at [http://127.0.0.1:4173/nes-rust-neo/](http://127.0.0.1:4173/nes-rust-neo/) to exercise repository-relative asset paths. The app uses WebAssembly, Web Audio, IndexedDB and Web Crypto. Use localhost or HTTPS for Web Crypto.

## Play

Choose **Open game**, then **Open local game…**, and select a locally obtained `.nes` cartridge or `.fds` disk image. The emulator validates the file contents, selects the hardware, and starts playback. Use **Play** or **Pause** to control execution and **Reset** to restart with saved cartridge RAM or disk changes intact. The initial display is **CRT** at up to **3×** scale, with volume at 100%. **Help** opens the keyboard reference.

| NES control | Keyboard | Standard gamepad |
| --- | --- | --- |
| D-pad | Arrow keys | D-pad or left stick |
| A | X | Right face button |
| B | Z | Lower face button |
| Start | Enter | Start |
| Select | Either Shift | Back / Select |

The on-screen controller supports simultaneous touch buttons and sliding diagonals. It sits beside the video on short landscape screens and stays available in fullscreen on touch devices. Keyboard and touch control player 1. A second standard gamepad controls player 2. Pause, window focus loss and hidden tabs release held input. Hidden tabs suspend emulation and audio. Use a button or key gesture to activate audio if the browser requires it.

Successfully imported games appear together under **My games** in the **Open game** or **Change game** picker. Select any remembered entry to open it. **Remove** forgets the entry and retains its progress. Existing imported cartridges and battery saves use their original storage and SHA-256 keys.

The first disk load asks for a lawfully obtained raw 8 KiB FDS BIOS, often named `disksys.rom`. BIOS validation checks the exact size of 8,192 bytes. The emulator accepts any raw firmware of that size and has no checksum allowlist. The verified firmware is the original diagnostic BIOS described in [FDS verification](docs/fds-verification.md). The picker can replace or forget the locally stored BIOS. Cancelling a game or BIOS selection, or encountering a validation or save-restore error, preserves the current game and its play or pause state.

Disk games start with the first side inserted. Select **Disk side** to change sides in image order, or **Eject** to leave the drive empty. While the drive is empty, select a side and press **Insert**. The game keeps running through the short ejection and insertion delay. The controls are also available in fullscreen. Side timing advances with emulation, so a change requested while paused finishes after resuming.

## Save and resume

The same save controls are available along the bottom of the fullscreen player. The browser or operating system may leave fullscreen when it opens a native file picker.

- Open **Save state ▾** to choose **New state** or a timestamped screenshot. **Save** captures the machine and overwrites the selected entry on subsequent saves. **Load** explicitly restores the target and keeps your Play or Pause setting. The picker also offers **Remove**, **Export** and **Import state**. An import creates a separate entry.
- **Save data** appears beside battery-backed cartridges and FDS games. Select a profile to restart the game with its progress. **New save** starts fresh, **Duplicate current** copies the current progress, and **Import save data** opens the import as a separate profile. **Save 1** adopts the browser’s existing native save. Reset keeps progress in the active profile. Remove a profile’s attached states before removing the profile.
- Loading an older state can roll back the selected profile’s battery save or FDS disk changes. To keep newer progress, use **Duplicate current** or **Export current save data** in **Save data** before loading. After duplicating, reselect the original profile to load its state. If a required storage write fails, keep the current tab open and follow the retry message. Disk changes must be saved before switching games. Existing battery-save recovery controls handle conflicting legacy drafts.
- Removing a game from **My games** retains its profiles and states. Reopening the exact NES ROM or original FDS sides brings them back. Headered and headerless FDS images use the same identity. Only one tab can run a given FDS image at a time. Concurrent editing of the same game in multiple tabs is unsupported.
- Export important progress before clearing site data or changing browsers or origins. Use raw `.srm` with the same NES ROM and `.fds-save` with the same original disk. A `.nesstate` uses the exact ROM or disk image, its original FDS BIOS when applicable, and a compatible emulator build. Browser storage is best-effort and may be cleared, evicted or exhausted.

See the [snapshot format and storage policy](docs/save-states.md) for details. The app requests only its own static assets. Games, names, BIOS and saves stay local. The build contains no game media or BIOS.

## Test

Install [cc65](https://cc65.github.io/) for the test-only cartridge and disk fixtures. On Ubuntu use `sudo apt-get install cc65`. On macOS use `brew install cc65`. The production build needs neither cc65 nor Playwright’s browser runtime.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
node tests/roms/check.mjs
node tests/fds/check.mjs
cargo build --locked -p nes-wasm --target wasm32-unknown-unknown --release
npm --prefix web ci
npm --prefix web run build
npx --prefix web playwright install chromium
npm --prefix web test
node tests/check-static.mjs
git diff --check
```

On headless Linux, install Chromium and its OS dependencies with `npx --prefix web playwright install --with-deps chromium`. Playwright starts its own server at the repository subpath. Close a local server on the same port first, or set `NES_WEB_PORT` for the test command.

Build the ignored test ROMs with `node tests/roms/build.mjs`. Run a local cartridge with the same generic core and inspect CPU, framebuffer and audio evidence.

```sh
cargo run --locked --release -p nes-runner -- tests/generated/orbit.nes \
  --frames 18060 --replay tests/generated/orbit.replay \
  --expect 102:11:02 --video tests/generated/orbit.ppm
```

For an FDS run, pass `--bios FILE` and schedule any eject or insertion with `--disk FRAME:eject` or `--disk FRAME:SIDE`, where sides are one-based. `--disk-save-in FILE` restores a runner snapshot and `--disk-save-out NEW_FILE` writes one. FDS output files use new paths. The runner verifies the snapshot version and original side identity before loading it.

See fixture provenance, replay checkpoints and results in [Cartridge verification](docs/verification.md) and [FDS verification](docs/fds-verification.md).

## Compatibility

The core supports standard NTSC iNES cartridges and Famicom Disk System images. It emulates Ricoh 2A03 CPU instructions, two controllers, OAM DMA, the PPU background and sprite pipelines, and two pulse channels, triangle, noise and DMC. The headless and browser frontends use the same core.

| Mapper | Implemented layout | Evidence |
| --- | --- | --- |
| 0 | NROM with 16/32 KiB PRG and CHR ROM or RAM | Orbit Salvage and hardware diagnostic |
| 1 | MMC1 with up to 256 KiB PRG (512 KiB SUROM with 8 KiB CHR), banking, mirroring and up to 8 KiB PRG RAM | Native bank and write timing tests |
| 2 | UxROM with up to 256 KiB PRG, fixed upper bank and banked lower PRG | Native bank tests |
| 3 | CNROM with up to 32 KiB CHR ROM and discrete bus conflicts | Breakwater and native bank tests |
| 4 | MMC3 with standard PRG/CHR banks, PRG RAM protection and scanline IRQ | Native bank tests and IRQ diagnostic ROM |

An FDS image can have a standard 16-byte `FDS\x1a` header with a side count and zero reserved bytes, or begin with a valid disk-information block. Each side is exactly 65,500 bytes. File blocks and zero padding are validated on every side, including hidden file pairs beyond the advertised count. QD, raw bitstreams, write-protect variants and automatic side swapping are unsupported.

The FDS baseline covers the RAM adapter, disk and timer IRQs, synthesized gaps and CRCs, manual side changes, disk writes and FDS expansion audio. Mandatory testing uses an original BIOS and a playable original disk guest. Nintendo BIOS revisions and commercial disk titles remain unverified. See the [FDS verification and hardware limitations](docs/fds-verification.md). Other MMC1/MMC3 board variants, NES 2.0, PAL/Dendy timing and special controllers are outside the verified baseline.

The verified browser workflows include save states for supported NES cartridges and FDS images, and native save profiles for battery-backed cartridges and writable disks. States require the exact NES ROM or original FDS sides, the exact FDS BIOS used to capture the state when applicable, and a compatible emulator build. See the [snapshot format and compatibility policy](docs/save-states.md).

The PPU approximates OAM evaluation and sprite overflow, register open-bus decay, color emphasis and some mid-scanline interactions. CPU interrupt sampling and DMC/OAM contention cover the tested cases. Sub-cycle races around VBlank, controller read glitches from DMC DMA, analog APU output and unstable unofficial opcodes can differ on hardware. UxROM assumes a bus-conflict-free board. [NESdev hardware reference](https://www.nesdev.org/wiki/Nesdev_Wiki)

## Project layout and deployment

- `crates/nes-core` owns the emulated machine and memory.
- `crates/nes-wasm` exposes transactional game staging, disk operations, saves and bounded frame execution, with buffers for the browser.
- `crates/nes-runner` provides deterministic native replay and diagnostics.
- `web` contains the static frontend, production build and Chromium tests.

The GitHub Actions workflow tests and audits the same `web/dist` directory it uploads to GitHub Pages on pushes to `main`. Configure GitHub Pages to use GitHub Actions for the repository. See the [workflow](.github/workflows/ci-pages.yml) and the [FDS publication checks](docs/fds-verification.md#publication).

The workspace split and browser controls follow the SNES project’s development and UI reference, adapted to NES hardware. [snes-rust README](https://github.com/takahirox/snes-rust/blob/main/README.md) · [snes-rust browser app](https://takahirox.github.io/snes-rust/) · [snes-rust baseline issue](https://github.com/takahirox/snes-rust/issues/3)

## Contributing

- [Development workflow](docs/development-flow.md)
- [Review guidelines](docs/review-guidelines.md)
