import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const output = new URL('../generated/', import.meta.url);
const timeout = 30_000;
execFileSync(process.execPath, [fileURLToPath(new URL('build.mjs', import.meta.url))], { cwd: root, stdio: 'inherit', timeout });
execFileSync('cargo', ['test', '--locked', '-p', 'nes-core', 'source_fixture_snapshot_continuation', '--', '--ignored'],
  { cwd: root, stdio: 'inherit', timeout });
execFileSync('cargo', ['build', '--locked', '--release', '-p', 'nes-runner'], { cwd: root, stdio: 'inherit', timeout });
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { cwd: root }));
const runner = join(metadata.target_directory, 'release', process.platform === 'win32' ? 'nes-runner.exe' : 'nes-runner');
const scratch = await mkdtemp(fileURLToPath(new URL('fds-run-', output)));

function run(name, count, checks, extra = []) {
  const args = ['--bios', 'fds-bios.rom', '--frames', String(count)];
  for (const [frame, address, value] of checks) {
    args.push('--expect', [frame, address.toString(16), value.toString(16)].join(':'));
  }
  const result = execFileSync(runner, [name, ...args, ...extra], {
    cwd: output, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log(name + '\n' + result.trimEnd());
  return result;
}

try {
  const saved = join(scratch, 'relay.fds-save');
  const original = join(scratch, 'base.fds-save');
  const image = 'fds-relay.fds';
  const initialFile = await readFile(new URL(image, output));
  run(image, 1, [], ['--disk-save-out', original]);
  const replay = run(image, 285, [
    [27, 0x1f, 0], [27, 8, 0x81], [29, 0x10, 1], [54, 0x11, 0x46],
    [100, 0x12, 0x12], [135, 0x10, 2], [191, 0x12, 0x23], [225, 0x10, 3],
    [280, 0x12, 0x34], [280, 0x13, 3], [280, 0x19, 2],
  ], ['--replay', 'fds-relay.replay', '--disk', '105:eject', '--disk', '106:2',
    '--disk', '193:3', '--disk-save-out', saved]);
  assert(replay.includes('fds sides=3 frames=285'));
  assert(Number(replay.match(/audio_peak=([0-9.]+)/)[1]) > .04);
  assert(replay.includes('framebuffer_fnv64=b26e461551898ea9'));

  const [baseFile, saveFile] = await Promise.all([readFile(original), readFile(saved)]);
  assert.equal(saveFile.subarray(0, 8).toString(), 'FDS-SAV1');
  assert.deepEqual(saveFile.subarray(0, 16), baseFile.subarray(0, 16));
  const before = baseFile.subarray(16);
  const after = saveFile.subarray(16);
  assert.equal(after.length, 3 * 98304);
  for (let side = 0; side < 3; side++) {
    const start = side * 98304;
    const differences = [];
    for (let index = 0; index < 98304; index++) {
      if (before[start + index] !== after[start + index]) differences.push(index);
    }
    assert.deepEqual(differences, [3560, 3594, 3595]);
    assert.equal(after[start + 3560], [0x12, 0x23, 0x34][side]);
  }
  assert.deepEqual(await readFile(new URL(image, output)), initialFile);
  run('fds-relay-raw.fds', 100, [[30, 0x12, 0x12], [64, 0x12, 0x23], [96, 0x12, 0x34]], [
    '--disk-save-in', saved, '--disk', '35:2', '--disk', '67:3',
  ]);
  const single = run('fds-relay-single.fds', 130, [[29, 0x10, 4], [129, 0x12, 0x45], [129, 0x13, 1]], [
    '--replay', 'fds-relay-single.replay',
  ]);
  assert(single.includes('fds sides=1 frames=130'));

  const different = Buffer.from(initialFile);
  different[16 + 22] ^= 1;
  const otherGame = join(scratch, 'other.fds');
  await writeFile(otherGame, different);
  const opts = { cwd: output, timeout, encoding: 'utf8' };
  const rejectSave = spawnSync(runner, [otherGame, '--bios', 'fds-bios.rom', '--frames', '1',
    '--disk-save-in', saved], opts);
  assert.equal(rejectSave.status, 1);
  assert.match(rejectSave.stderr, /original image identity does not match/);
  const rejectOverwrite = spawnSync(runner, [image, '--bios', 'fds-bios.rom', '--frames', '1',
    '--disk-save-out', saved], opts);
  assert.equal(rejectOverwrite.status, 1);
  assert.deepEqual(await readFile(saved), saveFile);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
