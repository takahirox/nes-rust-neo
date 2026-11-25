import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(web, '..');
const args = ['--locked', '-p', 'nes-wasm', '--target', 'wasm32-unknown-unknown'];
execFileSync('cargo', ['build', ...args, '--release'], { cwd: root, stdio: 'inherit' });
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { cwd: root }));
const dist = resolve(web, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist);
for (const name of ['index.html', 'style.css', 'main.js', 'audio.js', 'controls.js', 'storage.js', 'wasm.js']) {
  await copyFile(resolve(web, 'src', name), resolve(dist, name));
}
await copyFile(resolve(metadata.target_directory, 'wasm32-unknown-unknown/release/nes_wasm.wasm'), resolve(dist, 'nes_wasm.wasm'));
const manifest = await readdir(dist);
console.log(manifest.join('\n'));
