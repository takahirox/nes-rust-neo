# Issue #9 validation

The save-state workflow follows the MIT-licensed `snes-rust` frontend at
`9f48ce38976c520be3df209c97fde82e23692a99`. The reference review covered the
Save and resume instructions, the current toolbar and dialogs, the history
transactions, state preparation and recovery profile handling. The NES
implementation adapts the shared picker and paginated history pattern. Its
versioned, uncompressed payload, FDS delta backups and legacy Save 1 adoption
are described in the [format and storage policy](save-states.md).
[Reference revision](https://github.com/takahirox/snes-rust/tree/9f48ce38976c520be3df209c97fde82e23692a99) · [Save profiles #180](https://github.com/takahirox/snes-rust/issues/180) · [Unified selector #184](https://github.com/takahirox/snes-rust/issues/184)

## Chromium comparison

The captures show each local production Wasm build with one state saved
while paused, followed by opening the state picker. Media were the original
SNES smoke cartridge built by `tools/make-fixture.py`, the NES diagnostic
cartridge built by `tests/roms/build.mjs` and the multi-side FDS relay with its
local fixture BIOS built by `tests/fds/build.mjs`. Portrait and landscape used
Chromium’s iPhone 13 touch emulation at CSS screenshot scale.

| Viewport | SNES reference | NES | FDS |
| --- | --- | --- | --- |
| Desktop, 1280×900 | [SNES](save-ui/desktop-snes.png) | [NES](save-ui/desktop-nes.png) | [FDS](save-ui/desktop-fds.png) |
| Portrait, 390×844 | [SNES](save-ui/portrait-snes.png) | [NES](save-ui/portrait-nes.png) | [FDS](save-ui/portrait-fds.png) |
| Landscape, 844×390 | [SNES](save-ui/landscape-snes.png) | [NES](save-ui/landscape-nes.png) | [FDS](save-ui/landscape-fds.png) |

All three layouts use the same selector, explicit Save and Load buttons,
centered picker and per-entry actions. The picker measured 390 pixels wide on
desktop and landscape and 366 pixels wide in portrait for all three builds.
The NES and FDS portrait toolbar puts settings below playback controls and
uses a compact fullscreen button. The screenshots retain each system’s
native aspect ratio and touch layout. FDS keeps the drive controls below the
video, which adds a row in portrait. The NES app uses a lossless PNG preview
of the 256×240 frame. The SNES preview is a reduced JPEG.

## Checks

The following completed on macOS with the installed Rust stable Wasm target
and Playwright Chromium.

| Command | Observed result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Passed |
| `cargo test --workspace --locked` | 30 tests passed. The fixture-dependent FDS test runs in the next FDS gate |
| `node tests/roms/check.mjs` | Existing diagnostic, mapper IRQ and five-minute NES replay gates passed |
| `node tests/fds/check.mjs` | Source-assembled fixture snapshot test and existing FDS drive, audio, video and write checks passed |
| `cargo build --locked -p nes-wasm --target wasm32-unknown-unknown --release` | Passed |
| `npm --prefix web ci` and `npm --prefix web run build` | Passed |
| `npx --prefix web playwright install chromium` | Passed |
| `NES_WEB_PORT=4192 npm --prefix web test` | 32 Chromium tests passed against the production Wasm |
| `node tests/check-static.mjs` | Static asset allowlist, Wasm validation, network call audit and tracked media exclusion passed |
| `git diff HEAD --check` | Passed |

The Rust tests `snapshot_continuation_for_every_cartridge_mapper` and
`snapshot_rejection_preserves_live_machine` exercise mappers 0, 1, 2, 3 and 4,
including battery and volatile RAM, partial MMC1 writes and CHR RAM and mapper
registers. They compare future CPU, RAM, frame hashes and newly generated PCM.
They also reject bad media, kind, lengths, version, integrity and internal
values without altering the live machine.

The fixture gate assembles the FDS image and BIOS and runs
`cargo test --locked -p nes-core source_fixture_snapshot_continuation -- --ignored`.
The test restores during transfer IRQ, ejection and a pending side change,
compares continuation and verifies writes on all three sides. It also checks
native FDS import and rejects wrong disk, wrong BIOS and truncated files.

The focused Chromium flows can be run from `web` after the build and fixture
generation with `npx playwright test -g 'unified history|battery profiles|FDS states restore'`.
They cover real thumbnails, timestamps, stable overwrite, selection without
loading, explicit paused and playing restores, state import/export and
removal, Save 1 adoption, profile CRUD and independent histories, native
import/export, Reset, library removal/reimport, reload and header identity.
Injected snapshot, recovery or catalog writes verify that the previous state
and live progress remain recoverable. The FDS recovery test checks the displaced and
restored bytes on multiple sides. Existing tests also exercise the FDS
single-writer lock and fullscreen drive controls. Network observations in the
save workflows saw only local static asset HTTP requests.

GitHub Actions and published Pages verification are pending the downstream
PR and merge. The post-merge check should record the Actions run and public
Pages URL, then repeat state create, overwrite, load and reopen with the
source-built NES and FDS media and BIOS, including FDS profile and side
restoration.
