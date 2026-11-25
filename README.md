# nes-rust-neo

An NTSC NES emulator written from scratch in Rust. The browser app starts empty. Open a local iNES cartridge to play with 256×240 video and audio. The frontend builds to static files for GitHub Pages and can also run on localhost.

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

Choose **Insert cartridge**, then **Open local ROM…**, and select a legally obtained local `.nes` file. A successful load starts playback. Use **Play** or **Pause** to control execution and **Reset** to restart the current cartridge with its battery RAM intact. The initial display is **CRT** at up to **3×** scale, with volume at 100%. **Help** opens the keyboard reference.

| NES control | Keyboard | Standard gamepad |
| --- | --- | --- |
| D-pad | Arrow keys | D-pad or left stick |
| A | X | Right face button |
| B | Z | Lower face button |
| Start | Enter | Start |
| Select | Either Shift | Back / Select |

The on-screen controller supports simultaneous touch buttons and sliding diagonals. It sits beside the video on short landscape screens and stays available in fullscreen on touch devices. Keyboard and touch control player 1. A second standard gamepad controls player 2. Pause, window focus loss and hidden tabs release held input. Hidden tabs suspend emulation and audio. Use a button or key gesture to activate audio if the browser requires it.

Successfully imported cartridges appear under **My cartridges** in the **Insert cartridge** or **Change cartridge** picker. Select a remembered entry to insert it again. **Remove** forgets the library entry and retains its battery save. The browser keys saves by SHA-256 over the original ROM bytes and uses Web Locks to coordinate writes across tabs. Reopen the cartridge after closing or reloading a tab to recover queued progress. If another tab saved different progress, **Retry save storage** loads the shared save. When browser storage fails, the warning indicates whether progress can survive a reload or is held in memory in the open tab. If a cartridge’s save cannot be read, the current cartridge keeps its play or pause state, and retry completes the insertion once the save is readable.

ROMs, names, saves and preferences are stored in the browser. Clearing site data removes the library, saves and preferences. The app requests only its own static assets. The build contains no cartridges or game downloads.

## Test

Install [cc65](https://cc65.github.io/) for the test-only cartridge sources. On Ubuntu use `sudo apt-get install cc65`. On macOS use `brew install cc65`. The production build needs neither cc65 nor Playwright’s browser runtime.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
node tests/roms/check.mjs
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

See fixture provenance, replay checkpoints, commands and acceptance evidence in [Test fixtures and verification](docs/verification.md).

## Compatibility

The core supports standard NTSC iNES cartridges. It emulates Ricoh 2A03 CPU instructions, two controllers, OAM DMA, the PPU background and sprite pipelines, and two pulse channels, triangle, noise and DMC. The headless and browser frontends use the same core.

| Mapper | Implemented layout | Evidence |
| --- | --- | --- |
| 0 | NROM with 16/32 KiB PRG and CHR ROM or RAM | Orbit Salvage and hardware diagnostic |
| 1 | MMC1 with up to 256 KiB PRG, banking, mirroring and up to 8 KiB PRG RAM | Native bank and write timing tests |
| 2 | UxROM with up to 256 KiB PRG, fixed upper bank and banked lower PRG | Native bank tests |
| 3 | CNROM with up to 32 KiB CHR ROM and discrete bus conflicts | Breakwater and native bank tests |
| 4 | MMC3 with standard PRG/CHR banks, PRG RAM protection and scanline IRQ | Native bank tests and IRQ diagnostic ROM |

This is a playable baseline. The test suite covers the supported layouts above. Other MMC1/MMC3 board variants, NES 2.0, PAL/Dendy timing, disk images, expansion audio, special controllers, save states and commercial-game compatibility are outside the verified baseline.

The PPU approximates OAM evaluation and sprite overflow, register open-bus decay, color emphasis and some mid-scanline interactions. CPU interrupt sampling and DMC/OAM contention cover the tested cases. Sub-cycle races around VBlank, controller read glitches from DMC DMA, analog APU output and unstable unofficial opcodes can differ on hardware. UxROM assumes a bus-conflict-free board. [NESdev hardware reference](https://www.nesdev.org/wiki/Nesdev_Wiki)

## Project layout and deployment

- `crates/nes-core` owns the emulated machine and memory.
- `crates/nes-wasm` exposes cartridge staging and bounded frame execution, with buffers for the browser.
- `crates/nes-runner` provides deterministic native replay and diagnostics.
- `web` contains the static frontend, production build and Chromium tests.

The GitHub Actions workflow tests and audits the same `web/dist` directory it uploads to GitHub Pages on pushes to `main`. Configure GitHub Pages to use GitHub Actions for the repository. See the [workflow](.github/workflows/ci-pages.yml) and the issue’s [publication checks](https://github.com/takahirox/nes-rust-neo/issues/3).

The workspace split and browser controls follow the SNES project’s development and UI reference, adapted to NES hardware. [snes-rust README](https://github.com/takahirox/snes-rust/blob/main/README.md) · [snes-rust browser app](https://takahirox.github.io/snes-rust/) · [snes-rust baseline issue](https://github.com/takahirox/snes-rust/issues/3)

## Contributing

- [Development workflow](docs/development-flow.md)
- [Review guidelines](docs/review-guidelines.md)
