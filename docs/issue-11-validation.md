# Issue #11 validation

The speaker button uses the same inline SVG speaker, sound waves and mute
mark as the SNES player. Chromium checked the 44×44 CSS-pixel target,
accessible name, tooltip and pressed state. The test mutes with Space, unmutes
with touch, sets the slider to zero, reloads, and verifies that unmuting
restores the previous 37% volume. The existing audio test measures the
actual Web Audio signal and gain across mute, unmute and suspension.
[SNES markup](https://github.com/takahirox/snes-rust/blob/main/web/index.html) ·
[SNES styles](https://github.com/takahirox/snes-rust/blob/main/web/style.css) ·
[SNES audio UI](https://github.com/takahirox/snes-rust/blob/main/web/app.js)

## Layout regression

On the base revision at 320×640, a real save of the NES diagnostic cartridge
moved the D-pad from y=568.75 to y=592.25 CSS pixels and Start from y=708.75
to y=732.25. Both returned to their original positions when the notice
expired. The window scroll offset stayed at zero.

[The regression test](../web/test/player-layout.spec.js) runs the production
Wasm with the repository's NES diagnostic cartridge and FDS relay with its
fixture BIOS. It records `getBoundingClientRect()` for the picture, canvas,
D-pad, each direction, A/B, Start/Select and visible controls. In all eight
combinations of media, orientation and presentation, each coordinate and
dimension stayed within 1 CSS pixel of the baseline for that layout. The
test checks these conditions during save feedback, after it expires, after a
load that creates a recovery profile, after a short load notice replaces it,
and after a failed snapshot write. It also checks unchanged scroll offsets,
visible text, center hit-testing and touch release.

## Fullscreen workflows

The [NES save tests](../web/test/saves.spec.js) and [FDS save tests](../web/test/fds.spec.js)
use real restored frames, SRAM and disk bytes. The fullscreen checks include
creating, selecting, overwriting, loading, exporting, importing and removing
states, restoring an inserted or pending FDS side, and keeping manual pause.
They verify that the same controls and state selection return to the normal
layout. The profile checks cover create, duplicate, select, remove,
import/export, recovery access and the guard against removing a profile
with attached states. A non-battery cartridge hides Save data. An injected
FDS write failure exercises the persistent warning and its fullscreen retry
button.

Keyboard checks cover initial dialog focus, Tab order, Escape, safe removal
cancellation and focus return. Chromium intercepts native file selection
for import tests. The cancellation test dispatches the file input's
`cancel` event and separately exercises a browser fullscreen exit with the
dialog still open. OS picker presentation and fullscreen dismissal remain
browser- and platform-dependent.

## Chromium screenshots

Touch screenshots show a loaded game with save feedback visible. The desktop
pair shows the FDS drive before and after a side change, with fullscreen save
controls visible. All captures use the repository's generated fixtures.

| Viewport | Media | Normal | Fullscreen |
| --- | --- | --- | --- |
| Desktop 1280×900 | FDS | [Normal](player-ui/fds-desktop.png) | [Fullscreen](player-ui/fds-desktop-fullscreen.png) |
| Portrait 320×640 | NES | [Normal](player-ui/nes-portrait-normal.png) | [Fullscreen](player-ui/nes-portrait-fullscreen.png) |
| Portrait 320×640 | FDS | [Normal](player-ui/fds-portrait-normal.png) | [Fullscreen](player-ui/fds-portrait-fullscreen.png) |
| Landscape 667×375 | NES | [Normal](player-ui/nes-landscape-normal.png) | [Fullscreen](player-ui/nes-landscape-fullscreen.png) |
| Landscape 667×375 | FDS | [Normal](player-ui/fds-landscape-normal.png) | [Fullscreen](player-ui/fds-landscape-fullscreen.png) |

[Portrait fullscreen state history](player-ui/nes-portrait-fullscreen-history.png)
shows the shared picker with timestamped previews and per-entry actions.

## Local checks

Run on macOS with Rust stable 1.99, Node.js 26 and Playwright 1.62 Chromium.

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | Passed |
| `cargo test --workspace --locked` | 30 passed. The FDS fixture-dependent test runs separately in the FDS gate. |
| `node tests/roms/check.mjs` | Passed diagnostic, mapper IRQ and five-minute cartridge replays. |
| `node tests/fds/check.mjs` | Passed the fixture-dependent snapshot test and disk, video and audio checks. |
| `cargo build --locked -p nes-wasm --target wasm32-unknown-unknown --release` | Passed |
| `npm --prefix web ci` and `npm --prefix web run build` | Passed |
| `npx --prefix web playwright install chromium` | Passed |
| `npm --prefix web test` | 42 Chromium tests passed against the production Wasm. |
| `node tests/check-static.mjs` | Passed the production asset allowlist, Wasm validation, network call audit and tracked media check. |
| `git diff --check` | Passed |

To rerun the focused browser checks after building the app, use

```sh
npm --prefix web test -- --grep 'speaker icon|save feedback|touch fullscreen saves|FDS states restore|fullscreen disk changes|disk drive fits'
```

Hosted GitHub Actions validation awaits the downstream PR. Pages deployment
and the live player smoke test follow merge. Record the Actions run and
published URL with the NES and FDS speaker, save feedback and fullscreen save
workflow results. [Expected Pages URL](https://takahirox.github.io/nes-rust-neo/)
