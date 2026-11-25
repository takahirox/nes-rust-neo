import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { frames, replays } from '../../tests/roms/replay.mjs';

const fixtures = new URL('../../tests/generated/', import.meta.url);
const pickup = name => new URL(name + '.nes', fixtures);

for (const [name, replay] of Object.entries(replays)) {
  test(`${name} runs five minutes through the production Wasm core`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('./');
    await expect(page.getByRole('button', { name: 'Open ROM', exact: true })).toBeEnabled();
    const rom = [...await readFile(pickup(name))];
    const result = await page.evaluate(async ({ rom, replay, frames }) => {
      const { loadCore } = await import(new URL('wasm.js', location.href));
      const core = await loadCore();
      core.prepare(Uint8Array.from(rom));
      core.activate();
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      const image = ctx.createImageData(256, 240);
      const snapshots = [];
      const checks = [];
      const samples = { count: 0, peak: 0 };
      let index = 0;
      for (let frame = 1; frame <= frames; frame++) {
        while (index < replay.ranges.length && replay.ranges[index][1] < frame) index++;
        const range = replay.ranges[index];
        const buttons = range && range[0] <= frame ? range[2] : 0;
        if (!core.runFrame(buttons, 0)) throw new Error(`CPU jam on frame ${frame}`);
        const audio = core.audio();
        samples.count += audio.length;
        for (const value of audio) samples.peak = Math.max(samples.peak, Math.abs(value));
        for (const [at, address] of replay.checks) {
          if (at === frame) checks.push(core.peekRam(address));
        }
        if ([replay.titleFrame, replay.playFrame + 1, replay.transitionFrame + 1, frames].includes(frame)) {
          core.draw(ctx, image);
          const pixels = ctx.getImageData(0, 0, 256, 240).data;
          let hash = 2166136261;
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4) {
            const color = pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2];
            colors.add(color);
            hash = Math.imul(hash ^ color, 16777619);
          }
          snapshots.push({ hash: hash >>> 0, colors: colors.size });
        }
      }
      return { snapshots, checks, samples, mode: core.peekRam(0x10), round: core.peekRam(0x11) };
    }, { rom, replay, frames });
    expect(result.checks).toEqual(replay.checks.map(([, , expected]) => expected));
    expect(result.mode).toBe(1);
    expect(result.round).toBeGreaterThan(20);
    expect(result.snapshots.every(({ colors }) => colors >= 2)).toBe(true);
    expect(new Set(result.snapshots.map(({ hash }) => hash)).size).toBe(4);
    expect(result.samples.count).toBeGreaterThan(48000 * 300);
    expect(result.samples.peak).toBeGreaterThan(.03);
    console.log(`${name} mapper ${replay.mapper}, ${frames} frames, round ${result.round}, sample peak ${result.samples.peak.toFixed(5)}, canvas hashes ${result.snapshots.map(s => s.hash.toString(16)).join(' ')}`);
  });
}

test('Orbit Salvage plays real game-generated audio through the app', async ({ page }) => {
  await page.addInitScript(() => {
    const RealAudioContext = AudioContext;
    window.AudioContext = class extends RealAudioContext {
      createGain() {
        const gain = super.createGain();
        const analyser = this.createAnalyser();
        gain.connect(analyser);
        window.gameAudioPeak = () => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          return samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
        };
        return gain;
      }
    };
  });
  await page.goto('./');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open ROM', exact: true }).click();
  await (await chooser).setFiles(fileURLToPath(pickup('orbit')));
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  // Allow the cartridge to finish its power-on/VBlank initialization.
  await expect.poll(() => page.locator('canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(32, 16, 120, 8).data;
    return new Set(Array.from(pixels.filter((_, index) => index % 4 === 2))).size;
  })).toBeGreaterThan(1);
  await page.keyboard.down('Enter');
  await expect.poll(() => page.evaluate(() => window.gameAudioPeak?.() || 0), {
    intervals: [15, 20, 30],
  }).toBeGreaterThan(.02);
  await page.keyboard.up('Enter');
});
