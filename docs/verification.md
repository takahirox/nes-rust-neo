# Test fixtures and verification

This accompanies Issue #3. The generated cartridges exercise the regular cartridge, CPU, PPU and APU paths in native Rust and the production WebAssembly build.

## Provenance

The games, diagnostics, play replays, glyphs and sprite designs in [tests/roms](../tests/roms) are original to this repository. Their authors dedicate the fixture sources and generated fixture binaries to the public domain to the extent allowed by law, under the [CC0 1.0 Universal dedication](https://creativecommons.org/publicdomain/zero/1.0/). This grant covers the ROM artwork and executable code. Building uses the cc65 assembler and linker and includes no external libraries, proprietary firmware, game assets or downloaded cartridges. The build reproduces and verifies the exact [SHA-256 manifest](../tests/roms/sha256.txt).

| Fixture | Mapper | Purpose |
| --- | --- | --- |
| `orbit.nes` | 0 | **Orbit Salvage**, a top-down collection game. Press Start, steer with the D-pad, collect three beacons to advance and avoid the rover. |
| `breakwater.nes` | 3 | **Breakwater**, a falling-cargo game. Press Start, move the barge left and right and catch three cargo crates to advance. A missed crate costs a life. |
| `diagnostic.nes` | 0 | CPU binary arithmetic with decimal set, RAM mirroring, $2007 buffering and vertical mirroring, OAM DMA, DMC IRQ, VBlank NMI, pulse output, controller serial I/O and battery saves. |
| `diagnostic-alternate.nes` | 0 | Same diagnostic with different ROM identity, to verify save isolation. |
| `mmc3-irq.nes` | 4 | MMC3 PRG bank selection, nametable mirroring and eight CPU-visible PPU-driven IRQs. |

Run `node tests/roms/build.mjs` from the repository root to generate the ROMs and input replays. The assembler outputs, ROMs, screenshots from the headless runner and WAVs live under ignored `tests/generated/`. Fixture generation and browser tests do not write to `web/dist`. When making a deliberate fixture source change, use `node tests/roms/build.mjs --print-hashes` to review newly generated hashes before updating the manifest.

## Native checks

`cargo test --workspace --locked` checks CPU arithmetic, flags, branches, stack, interrupt priority and latency, bus open state and mirroring, cartridge parsing, CHR RAM, mapper banking and IRQ, PPU buffering, scrolling, pixel priority, sprite-zero hit, odd-frame timing, OAM DMA, controller I/O and all five APU channels.

`node tests/roms/check.mjs` builds each pinned ROM and runs `nes-runner` with a 120-second wall-clock timeout per invocation. The expected completion byte at RAM address `$0000` is `A5` by frame 10 for the battery diagnostic and by frame 6 for the MMC3 diagnostic. The MMC3 diagnostic must record eight IRQs at `$0001`. The battery diagnostic must generate an audio peak above .03. The runner exits nonzero for a CPU jam or mismatched checkpoint.

Both gameplay replays use `--frames 18060 --replay tests/generated/<name>.replay`. Each run lasts just over 300 seconds of NTSC emulated time. It starts at reset, presses Start on frame 12 and sends controller input throughout. Both games must still be in playing mode at frame 18,060, produce over 14,400,000 samples and reach an absolute audio peak above .03.

| Game | Deterministic gameplay checkpoints |
| --- | --- |
| Orbit Salvage | Title at frame 10, playing at 12, player x=60 at 32, one beacon at 59, round two at 102 |
| Breakwater | Title at frame 10, playing at 12, first catch at 126, barge x=128 at 130, round two at 354 |

The scripts print CPU state, total clocks, framebuffer FNV-1a, audio sample count, peak and audio FNV-1a. Inspect `tests/generated/orbit.ppm` and `orbit.wav` for video and audio from the native run. See [the replay source](../tests/roms/replay.mjs) for all expected bytes and replay inputs.

## Chromium checks

Build `web/dist`, install Chromium and run `npm --prefix web test`. Tests use isolated browser contexts and serve the production app at `/nes-rust-neo/`. The gameplay tests feed the same replay ranges and checkpoints to the production Wasm engine in real Chromium. Each test is limited to 180 seconds of wall-clock time. It checks the title, movement and round transition in RAM, four different canvas frames with multiple colors, active gameplay after five emulated minutes, and non-silent APU samples. The live Orbit Salvage test also listens for its Start sound after the app’s Web Audio gain node.

The browser lifecycle tests check empty startup, the local file picker, malformed and unsupported headers, cancellation, switching, pause, restart, keyboard/gamepad/touch input, scaling, Pixel/CRT, fullscreen, mute and volume. They inject gamepad state and a visibility event in Chromium and drive touch via DevTools. Cancellation dispatches the browser’s file input event because the native OS dialog is outside Playwright’s scope. The audio checks use real Web Audio, including the post-gain signal and AudioContext state during suspension and resume.

The persistence tests check reload, cartridge-specific saves, reset, row removal, a read failure with an existing save, and recovery from local database and save write failures. The privacy test starts with an empty profile and records requests through several cartridge imports. The expected trace is eight same-origin GETs for HTML, CSS, five JavaScript modules and Wasm, with empty request bodies and zero requests after the app starts.

## Artifact checks

`node tests/check-static.mjs` verifies the production asset allowlist, validates Wasm, checks production network API calls and inspects `git ls-files` for cartridge binaries or generated outputs. The frontend’s one explicit request loads the relative Wasm asset. The browser test verifies this trace at runtime. The Pages upload depends on the native, browser and artifact gates and is restricted to pushes on `main`. Only the deploy job has Pages write and OIDC permissions. [Pages workflow](../.github/workflows/ci-pages.yml)

## Pre-merge results for Issue #3

The checks below passed from a fresh export of the staged tree on macOS arm64 with Rust 1.99.0, Node.js 26.12.1 and Chromium 151.0.7922.34. The browser check used `NES_WEB_PORT=41938` to serve the app under the repository path on a free port.

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Passed |
| `cargo test --workspace --locked` | 12 tests passed |
| `node tests/roms/check.mjs` | Pinned hashes, both diagnostics and both 18,060-frame gameplay replays passed |
| `cargo build --locked -p nes-wasm --target wasm32-unknown-unknown --release` | Passed |
| `npm --prefix web ci` and `npm --prefix web run build` | Passed |
| `npx --prefix web playwright install chromium` and `npm --prefix web test` | 8 tests passed, including Web Audio, persistence, production-subpath smoke and the request trace |
| `node tests/check-static.mjs` | Passed for the tracked tree and eight production assets |
| `git diff --check` and `git diff --cached --check` | Passed |

| Game | Last round in Chromium | Native final framebuffer FNV-1a | Native audio FNV-1a | Chromium title, play, round-two and final canvas hashes |
| --- | --- | --- | --- | --- |
| Orbit Salvage | 179 | `e0cbc4399c0081ae` | `5aba42948359cd9e` | `fa3bb6a8 c79e2c7b 63eb1c25 fef46eaa` |
| Breakwater | 105 | `68eee8456e35251c` | `2f27e3692ed1ec37` | `eb657615 66a0a75c f320d98e 773f7ba4` |

Both runs produced 14,424,181 native audio samples and a peak of 0.09140 in native Rust and Chromium. The native battery diagnostic produced an audio peak of 0.13676. Its completion byte was `A5` at frame 10. The MMC3 probe reached `A5` and counted eight interrupts by frame 6.

## Publication

After merging to `main` with GitHub Pages configured to use GitHub Actions, verify the Pages run and published URL and repeat the clean-start, local cartridge, audio and no-upload smoke check. The expected path is [https://takahirox.github.io/nes-rust-neo/](https://takahirox.github.io/nes-rust-neo/). Record the run and result against Issue #3.
