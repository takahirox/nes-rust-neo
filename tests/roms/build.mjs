// SPDX-License-Identifier: CC0-1.0
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReplays } from './replay.mjs';

const source = fileURLToPath(new URL('.', import.meta.url));
const outputUrl = new URL('../generated/', import.meta.url);
const output = fileURLToPath(outputUrl);
await mkdir(output, { recursive: true });

// Original 5×7 glyphs, one hexadecimal row per encoded pixel row.
const font = {
  A: '0E11111F111111', B: '1E11111E11111E', C: '0F10101010100F',
  D: '1E11111111111E', E: '1F10101E10101F', F: '1F10101E101010',
  G: '0F10101711110F', H: '1111111F111111', I: '0E04040404040E',
  J: '0101010111110E', K: '11121418141211', L: '1010101010101F',
  M: '111B1515111111', N: '11191915131311', O: '0E11111111110E',
  P: '1E11111E101010', Q: '0E11111115120D', R: '1E11111E141211',
  S: '0F10100E01011E', T: '1F040404040404', U: '1111111111110E',
  V: '11111111110A04', W: '11111115151B11', X: '11110A040A1111',
  Y: '11110A04040404', Z: '1F01020408101F',
  0: '0E11131519110E', 1: '040C040404040E', 2: '0E11010204081F',
  3: '1E01010601011E', 4: '02060A121F0202', 5: '1F10101E01011E',
  6: '0E10101E11110E', 7: '1F010204080808', 8: '0E11110E11110E',
  9: '0E11110F01010E', '-': '0000001F000000',
};

const sprites = [
  // Ship, beacon, rover, left/right barge, cargo.
  ['...1....', '..121...', '.11211..', '1111111.', '1111111.', '..121...', '.2.2.2..', '........'],
  ['...2....', '..121...', '.11211..', '2222222.', '.11211..', '..121...', '...2....', '........'],
  ['........', '.22222..', '1111111.', '1222221.', '1111111.', '.1.1.1..', '........', '........'],
  ['...22...', '...22...', '...22222', '11111111', '21111111', '.2222222', '..111111', '........'],
  ['........', '...22...', '22222...', '11111111', '11111112', '2222222.', '111111..', '........'],
  ['1111111.', '1222221.', '1211121.', '1212121.', '1211121.', '1222221.', '1111111.', '........'],
];

function patterns() {
  const chr = Buffer.alloc(8192);
  for (const [char, rows] of Object.entries(font)) {
    const address = char.charCodeAt(0) * 16;
    for (let y = 0; y < 7; y++) chr[address + y] = parseInt(rows.slice(y * 2, y * 2 + 2), 16) << 2;
  }
  for (const [index, rows] of sprites.entries()) {
    const address = (index + 1) * 16;
    for (const [y, row] of rows.entries()) {
      for (const [column, pixel] of [...row].entries()) {
        if (pixel === '1') chr[address + y] |= 128 >> column;
        if (pixel === '2') chr[address + y + 8] |= 128 >> column;
      }
    }
  }
  chr[9 * 16 + 2] = 0xff;
  chr[9 * 16 + 3] = 0xaa;
  return chr;
}

for (const name of ['orbit', 'breakwater']) await writeFile(join(output, name + '.chr'), patterns());

const fixtures = [
  ['orbit', 'orbit'],
  ['breakwater', 'breakwater'],
  ['diagnostic', 'diagnostic'],
  ['diagnostic-alternate', 'diagnostic', '-D', 'ALTERNATE=1'],
  ['mmc3-irq', 'mmc3-irq'],
];
const sums = await readFile(join(source, 'sha256.txt'), 'utf8').catch(error => {
  if (error.code === 'ENOENT' && process.argv.includes('--print-hashes')) return '';
  throw error;
});
const hashes = new Map(sums.trim().split('\n').map(line => line.trim().split(/\s+/).reverse()));
for (const [name, assembly, ...definitions] of fixtures) {
  const object = join(output, name + '.o');
  const rom = join(output, name + '.nes');
  execFileSync('ca65', ['--bin-include-dir', output, ...definitions, assembly + '.s', '-o', object], { cwd: source, stdio: 'inherit' });
  const layout = name === 'mmc3-irq' ? 'mmc3.cfg' : 'game.cfg';
  execFileSync('ld65', ['-C', layout, '-o', rom, object], { cwd: source, stdio: 'inherit' });
  const hash = createHash('sha256').update(await readFile(rom)).digest('hex');
  if (process.argv.includes('--print-hashes')) console.log(hash + '  ' + name + '.nes');
  else if (hash !== hashes.get(name + '.nes')) throw new Error('Fixture hash mismatch for ' + name + '.nes');
}

await writeReplays(outputUrl);
