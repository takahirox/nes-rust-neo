// SPDX-License-Identifier: CC0-1.0
// Deterministic controller replays invented from the game rules, independent of
// emulator output. Each continues through repeated rounds for >5 minutes.
import { writeFile } from 'node:fs/promises';

export const frames = 18_060;
export const warmup = 12;

function schedule() {
  const ranges = [[warmup, warmup, 0x08]];
  let next = warmup + 1;
  return {
    ranges,
    run(length, input = 0) {
      if (length && input && next <= frames) ranges.push([next, Math.min(next + length - 1, frames), input]);
      next += length;
    },
    get next() { return next; },
  };
}

function orbit() {
  const replay = schedule();
  for (let round = 1; replay.next <= frames; round++) {
    const targetY = 92 + (round & 7) * 4;
    replay.run(Math.abs(targetY - 96), targetY < 96 ? 0x10 : 0x20);
    replay.run(90, 0x80);
  }
  return replay.ranges;
}

function breakwater() {
  const replay = schedule();
  let x = 120;
  for (let round = 1; replay.next <= frames; round++) {
    for (let cargo = 0; cargo < 3; cargo++) {
      const target = 120 + ((round - 1) & 3) * 16 + cargo * 8;
      const move = Math.abs(target - x) / 2;
      replay.run(move, target < x ? 0x40 : 0x80);
      replay.run((round === 1 ? 114 : 57) - move);
      x = target;
    }
  }
  return replay.ranges;
}

export const replays = {
  orbit: {
    mapper: 0, ranges: orbit(), checks: [[10, 0x10, 0], [12, 0x10, 1], [32, 0x12, 60], [59, 0x14, 1], [102, 0x11, 2]],
    titleFrame: 10, playFrame: 32, transitionFrame: 102,
  },
  breakwater: {
    mapper: 3, ranges: breakwater(), checks: [[10, 0x10, 0], [12, 0x10, 1], [126, 0x14, 1], [130, 0x12, 128], [354, 0x11, 2]],
    titleFrame: 10, playFrame: 130, transitionFrame: 354,
  },
};

export async function writeReplays(output) {
  for (const [name, { ranges }] of Object.entries(replays)) {
    const content = ranges.map(([first, last, pad]) => `${first} ${last} ${pad.toString(16).padStart(2, '0')}`).join('\n');
    await writeFile(new URL(`./${name}.replay`, output), content + '\n');
  }
}
