# Famicom Disk System verification

[Issue #7](https://github.com/takahirox/nes-rust-neo/issues/7) adds disk media to the shared NTSC emulator. Chip and image-format references used for the implementation include the hardware notes from NESdev and the Mesen implementation of the 2C33 drive and audio. [FDS register and hardware notes](https://www.nesdev.org/wiki/Family_Computer_Disk_System) · [FDS disk format](https://www.nesdev.org/wiki/FDS_disk_format) · [FDS audio](https://www.nesdev.org/wiki/FDS_audio) · [Mesen FDS implementation](https://github.com/SourMesen/Mesen2/tree/master/Core/NES/Mappers/FDS)

## Fixture provenance

The fixture firmware, game, graphics and replay in [tests/fds](../tests/fds) are original to this repository. Their authors dedicate the fixture sources and generated BIOS, game and disk images to the public domain to the extent allowed by law under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). The build uses cc65 and the sources in this tree. It downloads no media and links no external firmware, game code or artwork. The disk identifier includes the standard FDS format signature.

Run `node tests/fds/build.mjs` to generate binaries and replay files under ignored `tests/generated/`. Generation verifies the full [SHA-256 manifest](../tests/fds/sha256.txt). Use `node tests/fds/build.mjs --print-hashes` to review hashes after an intentional fixture change. All media binaries are test-only. Browser captures show the generated guest running in the production build with media selected from local files.

| Fixture | Purpose |
| --- | --- |
| `fds-bios.rom` | Original 8 KiB test firmware. Its CPU code handles timer and drive IRQs, synchronizes physical blocks, checks CRCs, and loads a file from disk into program RAM. |
| `fds-relay.bin` | **Disk Relay**, the 6502 program stored inside each disk side. Left/Right steer the solid sprite. At the hollow beacon, A delivers and writes the count. Change sides to reach a new beacon. |
| `fds-relay.fds` and `fds-relay-raw.fds` | The same three sides in headered and headerless images. Distinct beacon positions and progress values make side changes visible and test save identity across equivalent formats. |
| `fds-relay-single.fds` | Headerless single side with a separate game identity and a fourth beacon position. |

## Native execution and results

`cargo test --workspace --locked` checks one-, two- and three-side parsing, header count and padding, bad signatures/blocks and truncation, BIOS size and reset-vector mapping, CPU program RAM, CHR RAM, PPU mirroring, timer repeat/one-shot and acknowledgment, byte-cell timing, drive reset/settling/empty status, CRC acceptance and rejection, disk writes across sides, snapshots, waveform RAM, envelope rate, modulation wrap and the combined analog-level approximation at the shared APU sample rate.

The register tests and diagnostic BIOS verify that `$4030` bit 7 stays set across repeated status reads. Servicing `$4031` or `$4024` clears the flag and its disk IRQ. The audio regression checks that an odd-step `$4088` write updates both steps of the same entry and that playback uses the revised modulation. [FDS register hardware tests](https://www.nesdev.org/wiki/User:TakuikaNinja/FDS_Registers) · [Modulation table write behavior](https://www.nesdev.org/wiki/FDS_audio#Mod_table_write_($4088))

`node tests/fds/check.mjs` runs the native gate below with pinned fixtures, 30-second per-run limits and an ignored scratch directory. It checks the full before/after track difference. Only the progress byte and that block’s two CRC bytes may differ on each side. The original disk file remains byte-identical. It then opens the headerless equivalent with the saved tracks, boots the independent single side, and verifies that saves for the wrong original image and attempts to overwrite an existing snapshot are rejected.

To reproduce the three-side replay directly from the root, use a new output filename.

```sh
node tests/fds/build.mjs
cargo run --locked --release -p nes-runner -- tests/generated/fds-relay.fds \
  --bios tests/generated/fds-bios.rom --frames 285 \
  --replay tests/generated/fds-relay.replay --disk 105:eject --disk 106:2 --disk 193:3 \
  --expect 27:08:81 --expect 54:11:46 --expect 100:12:12 --expect 191:12:23 \
  --expect 280:12:34 --expect 280:13:03 --expect 280:19:02 \
  --disk-save-out tests/generated/relay-example.fds-save
```

| Run | Expected and observed checkpoints | Final video FNV-1a | Audio samples, peak and FNV-1a |
| --- | --- | --- | --- |
| Three-side replay, 285 frames | Both IRQs by frame 27. Controller moved the courier to x=70 by frame 54. Wrote and reread `12`, `23`, `34` by frames 100, 191 and 280, with three deliveries and two side handoffs on the same running guest. | `b26e461551898ea9` | 227,564 · 0.05423 · `9beb18f001229527` |
| Headerless reopen, 100 frames | Restored `12`, `23`, `34` by frames 30, 64 and 96. | `034782452e64f015` | 79,807 · 0.05423 · `bf55a37723f9d6b4` |
| Single side, 130 frames | Side marker 4 by frame 29. Delivered and reread `45` by frame 129. | `ccd9a3d977d9b9a5` | 103,768 · 0.05423 · `24fad98d3e98a6d3` |

The runner snapshot begins with `FDS-SAV1` and an eight-byte little-endian FNV-1a fingerprint of the original headerless payload, followed by the mutable tracks in side order. Browser storage uses SHA-256 keys and a separate versioned IndexedDB record. The snapshots preserve all emulated disk writes, including gap and CRC bytes.

## Browser execution and UI

`npm --prefix web test` generates the fixtures, runs Chromium against `web/dist` and uses isolated browser profiles. [FDS browser suite](../web/test/fds.spec.js)

- The single picker loads local NES and FDS media and reopens both from **My games**. Tests cover NES → FDS → NES → FDS, content-based validation, preserved paused/running state, missing/invalid/cancelled BIOS input, BIOS reuse/replacement/forgetting, all three sides, and a one-side image.
- The real Wasm guest produces changing canvas frames from controller input, and the app passes a signal with an absolute peak above 0.04 to Web Audio. The guest observes ejection/reinsertion and keeps RAM across side changes.
- Tests write and read back `12`, `23`, `34` through guest disk registers, assert the exact persisted bytes, reset on side three, switch to NES, remove the library entry, reload, and reimport the headerless form. The single-side game starts at `44` and independently saves `45`. The original local file remains byte-identical.
- With an earlier save completion callback held, reloading after a write on side B restores the exact bytes `12` and `23` on sides A and B. The save handler explicitly starts the IndexedDB commit during navigation, when the browser can suspend request callbacks. [Chrome page lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- Injected disk storage read errors, malformed saves, and write failures preserve the current machine. A failed write prevents switching until it succeeds. Two tabs cannot write the same image concurrently. After the owner commits and switches, the second tab retries and reads the committed value. A seeded version-1 cartridge record and battery save reopen without reimport. The cartridge recovery checks still use the legacy database and key prefixes.
- Network tracing covers local file loading, BIOS registration, replacement and forgetting, disk use and remembered-game switches. Requests are same-origin static GETs with empty bodies. The asset audit verifies the allowlist, Wasm format, production source network calls, and tracked binary exclusions.

The comparison uses the existing NES captures from [Issue #3's reference UI review](verification.md#reference-ui-review) and new Chromium captures from the FDS browser test with the same 3× CRT and volume defaults. The same canvas and touch controls anchor both layouts. The disk row appears within the screen while the drive is in use or empty. The fullscreen screenshots show the second side inserted.

| Viewport | Existing reference | FDS windowed | FDS fullscreen |
| --- | --- | --- | --- |
| Desktop 1280×900 | [Desktop](ui-parity/desktop.png) | [Windowed](ui-parity/fds-desktop.png) | [Fullscreen](ui-parity/fds-desktop-fullscreen.png) |
| Mobile portrait 390×844 | [Portrait](ui-parity/portrait.png) | [Windowed](ui-parity/fds-portrait.png) | [Fullscreen](ui-parity/fds-portrait-fullscreen.png) |
| Mobile landscape 844×390 | [Landscape](ui-parity/landscape.png) | [Windowed](ui-parity/fds-landscape.png) | [Fullscreen](ui-parity/fds-landscape-fullscreen.png) |

## Hardware and firmware scope

The 2C33 model transfers whole byte cells every 150 NTSC CPU cycles after 50,000 cycles of spin-up. An ejection/insertion sequence exposes an empty drive for 150,000 CPU cycles. The emulator synthesizes the lead and inter-block gaps, sync bytes and CRC-16/KERMIT from the original FDS file blocks. Each side uses a 96 KiB track with a zero-filled tail. Images whose synthesized blocks exceed that capacity are rejected. The drive treats inserted images as writable through the local snapshot. Empty drive status reports no media, not ready and not writable. Mechanical tolerances, bit-cell phase, hardware write-protection switches and link-port peripherals are outside the model. An interrupted guest disk write can leave partially written track data, as on a physical drive. A browser storage failure retains the last committed snapshot and keeps newer data in the running tab until it can be committed.

FDS audio models 64-entry wave RAM, gain envelopes, frequency, modulation table traversal and bias, master level and write gating. The mixer uses a fixed digital FDS-to-NES gain and the existing output filters. Analog amplitudes and sub-cycle effects are approximations.

The app maps any local file of exactly 8,192 bytes into the BIOS window and executes its reset vector on the shared CPU. It performs size validation only. The test firmware exposes a small fixture-specific API and validates the emulated hardware path with the source-built guest. The original Nintendo boot menu, services and games remain unverified. QD, nonstandard headers or padding, and raw flux formats are outside this baseline.

## Pre-merge checks

Run the documented [README test commands](../README.md#test) with Chromium installed. The local run used macOS arm64, Rust 1.99.0, Node.js 26.12.1 and Chromium 151.0.7922.34. The same gates are configured in [CI](../.github/workflows/ci-pages.yml).

| Commands | Result |
| --- | --- |
| `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` | Passed. 21 Rust tests. |
| `node tests/roms/check.mjs`, `node tests/fds/check.mjs` | Passed. Pinned fixture hashes, cartridge diagnostics, both 18,060-frame cartridge replays and all disk replays. |
| `cargo build --locked -p nes-wasm --target wasm32-unknown-unknown --release`, `npm --prefix web ci`, `npm --prefix web run build` | Passed. Release Wasm and static app built. |
| `npx --prefix web playwright install chromium`, `npm --prefix web test` | Passed. 29 browser tests, including the FDS flows and the existing device, audio, library and save checks. |
| `node tests/check-static.mjs`, `git diff --check`, `git diff --cached --check` | Passed. Nine production assets and tracked-media exclusions. |

## Publication

After merge to `main`, verify the Pages workflow and record the successful deployment run and actual site URL. The expected [published app](https://takahirox.github.io/nes-rust-neo/) should start empty. With generated local fixtures, verify NES → FDS → NES, the missing-BIOS prompt, reuse, live side changes, FDS video and audio, and disk writes after reload. Inspect the published asset list and request trace. Record the results against Issue #7 and open a linked follow-up if deployment exposes a defect.
