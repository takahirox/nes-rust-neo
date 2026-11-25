// SPDX-License-Identifier: CC0-1.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('./', import.meta.url);
const output = new URL('../generated/', import.meta.url);
await mkdir(output, { recursive: true });

async function assemble(name, suffix) {
  const object = fileURLToPath(new URL('fds-' + name + '.o', output));
  const binary = fileURLToPath(new URL('fds-' + name + suffix, output));
  execFileSync('ca65', [name + '.s', '-o', object], { cwd: source, stdio: 'inherit' });
  execFileSync('ld65', ['-C', name + '.cfg', '-o', binary, object], { cwd: source, stdio: 'inherit' });
  return readFile(binary);
}

const bios = await assemble('bios', '.rom');
const guest = await assemble('relay', '.bin');
assert.equal(bios.length, 8192);
assert(guest.length && guest.length < 60000);

function side(number, progress) {
  const bytes = Buffer.alloc(65500);
  bytes.write('\x01*NINTENDO-HVC*', 0, 'ascii');
  bytes.write('RLY', 16, 'ascii');
  bytes[21] = number;
  bytes[22] = progress;
  bytes[56] = 2;
  bytes[57] = 1;
  bytes[58] = 3;
  bytes.write('RELAY   ', 61, 'ascii');
  bytes.writeUInt16LE(0x6000, 69);
  bytes.writeUInt16LE(guest.length, 71);
  bytes[74] = 4;
  guest.copy(bytes, 75);
  return bytes;
}

const header = Buffer.alloc(16);
header.write('FDS\x1a', 0, 'ascii');
header[4] = 3;
const raw = Buffer.concat([side(1, 0x11), side(2, 0x22), side(3, 0x33)]);
const files = {
  'fds-bios.rom': bios,
  'fds-relay.bin': guest,
  'fds-relay.fds': Buffer.concat([header, raw]),
  'fds-relay-raw.fds': raw,
  'fds-relay-single.fds': side(4, 0x44),
};
const hashes = [];
for (const [name, bytes] of Object.entries(files)) {
  await writeFile(new URL(name, output), bytes);
  hashes.push(createHash('sha256').update(bytes).digest('hex') + '  ' + name);
}

const manifest = hashes.join('\n') + '\n';
if (process.argv.includes('--print-hashes')) process.stdout.write(manifest);
else assert.equal(manifest, await readFile(new URL('sha256.txt', source), 'utf8'));

await writeFile(new URL('fds-relay.replay', output), [
  '30 53 80',
  '55 56 01',
  '132 139 80',
  '142 143 01',
  '219 226 80',
  '229 230 01',
].join('\n') + '\n');

await writeFile(new URL('fds-relay-single.replay', output), '30 77 80\n79 80 01\n');
