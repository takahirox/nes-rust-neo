import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frames, replays } from './replay.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cwd = fileURLToPath(new URL('../generated/', import.meta.url));
const timeout = 120_000;
execFileSync(process.execPath, [fileURLToPath(new URL('build.mjs', import.meta.url))], { cwd: root, stdio: 'inherit', timeout });
execFileSync('cargo', ['build', '--locked', '--release', '-p', 'nes-runner'], { cwd: root, stdio: 'inherit', timeout });
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { cwd: root }));
const suffix = process.platform === 'win32' ? '.exe' : '';
const runner = join(metadata.target_directory, 'release', 'nes-runner' + suffix);

function run(name, count, checks, args = []) {
  const expected = checks.flatMap(([frame, address, byte]) =>
    ['--expect', `${frame}:${address.toString(16)}:${byte.toString(16)}`]);
  const output = execFileSync(runner, [name + '.nes', '--frames', String(count), ...expected, ...args], {
    cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log(name + '\n' + output.trimEnd());
  return output;
}

const diagnostic = run('diagnostic', 10, [[10, 0, 0xa5]], ['--video', 'diagnostic.ppm', '--audio', 'diagnostic.wav']);
assert(Number(diagnostic.match(/audio_peak=([0-9.]+)/)[1]) > .03);
run('mmc3-irq', 6, [[6, 0, 0xa5], [6, 1, 8]]);

for (const [name, replay] of Object.entries(replays)) {
  const extra = name === 'orbit' ? ['--audio', 'orbit.wav'] : [];
  const output = run(name, frames, [...replay.checks, [frames, 0x10, 1]], [
    '--replay', name + '.replay', '--video', name + '.ppm', ...extra,
  ]);
  assert(output.includes(`mapper=${replay.mapper} frames=${frames}`));
  assert(Number(output.match(/audio_samples=(\d+)/)[1]) > 48000 * 300);
  assert(Number(output.match(/audio_peak=([0-9.]+)/)[1]) > .03);
}
