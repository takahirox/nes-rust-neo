import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const dist = new URL('web/dist/', root);
const expected = ['audio.js', 'controls.js', 'disk-storage.js', 'index.html', 'main.js', 'nes_wasm.wasm', 'storage.js', 'style.css', 'wasm.js'];
const entries = await readdir(dist, { withFileTypes: true });
assert.deepEqual(entries.map(entry => entry.name).sort(), expected);
assert(entries.every(entry => entry.isFile()));

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
assert(!tracked.some(path => /(?:\.(nes|fds|unf|unif|chr|sav|qd|rom|bios|bin|fds-save)$)|^(tests\/generated|web\/dist)\//i.test(path)));
const wasm = await readFile(new URL('nes_wasm.wasm', dist));
assert(WebAssembly.validate(wasm));
const rustSources = tracked.filter(path => /^crates\/[^/]+\/src\/.*\.rs$/.test(path));
for (const path of rustSources) {
  const source = await readFile(new URL(path, root), 'utf8');
  assert(!/\binclude_bytes!\s*\(/.test(source), `Unexpected embedded binary in ${path}`);
}

const scripts = await Promise.all(expected.filter(name => name.endsWith('.js')).map(async name =>
  [name, await readFile(new URL(name, dist), 'utf8')]));
for (const [name, script] of scripts) {
  const network = script.match(/\bfetch\s*\(|\b(?:XMLHttpRequest|sendBeacon|WebSocket|EventSource|RTCPeerConnection)\b/g) ?? [];
  if (name === 'wasm.js') {
    assert.deepEqual(network, ['fetch(']);
    assert(script.includes("fetch(new URL('./nes_wasm.wasm', import.meta.url))"));
  } else {
    assert.deepEqual(network, []);
  }
}
console.log('Production asset allowlist, Wasm validation, source network calls and tracked media exclusions passed.');
