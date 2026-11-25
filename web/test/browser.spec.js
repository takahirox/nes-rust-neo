import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixtures = new URL('../../tests/generated/', import.meta.url);
const fixture = (name = 'diagnostic') => fileURLToPath(new URL(name + '.nes', fixtures));
const originalColor = [173, 173, 173];
const pressColor = [21, 95, 217];
const secondPressColor = [66, 64, 255];

async function coreReady(page) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open ROM', exact: true })).toBeEnabled();
}

async function choose(page, name) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open local ROM' }).click();
  await (await chooser).setFiles(fixture(name));
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
}

function color(page) {
  return page.locator('canvas').evaluate(canvas =>
    [...canvas.getContext('2d').getImageData(75, 100, 1, 1).data].slice(0, 3));
}

async function seeColor(page, rgb) {
  await expect.poll(() => color(page)).toEqual(rgb);
}

async function key(page, code, rgb) {
  await page.keyboard.down(code);
  await seeColor(page, rgb);
  await page.keyboard.up(code);
}

async function instrumentDevices(page) {
  await page.addInitScript(() => {
    let simulatedHidden = false;
    Object.defineProperty(document, 'hidden', { get: () => simulatedHidden });
    window.changeVisibility = hidden => {
      simulatedHidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const buttons = Array.from({ length: 16 }, () => ({ pressed: false }));
    window.gamepadButtons = buttons;
    Object.defineProperty(navigator, 'getGamepads', {
      value: () => [{ index: 0, mapping: 'standard', axes: [0, 0], buttons }],
    });

    // Keep the real Web Audio graph. Tap the signal after the app's gain node.
    const ActualContext = AudioContext;
    window.AudioContext = class extends ActualContext {
      constructor(options) {
        super(options);
        window.audioProbe = { context: this, starts: 0, stops: 0 };
      }
      createGain() {
        const gain = super.createGain();
        const analyser = this.createAnalyser();
        gain.connect(analyser);
        Object.assign(window.audioProbe, { gain, analyser });
        return gain;
      }
      createBufferSource() {
        const source = super.createBufferSource();
        const start = source.start.bind(source);
        const stop = source.stop.bind(source);
        source.start = (...args) => { window.audioProbe.starts++; return start(...args); };
        source.stop = (...args) => { window.audioProbe.stops++; return stop(...args); };
        return source;
      }
    };
    window.audioPeak = () => {
      const analyser = window.audioProbe?.analyser;
      if (!analyser) return 0;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
    };
  });
}

test('production subpath, empty startup, picker, rejection, cancellation and switching', async ({ page }) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push({
    url: request.url(), method: request.method(), body: request.postData(),
  }));
  await coreReady(page);
  const appUrl = page.url();
  const assets = ['', 'style.css', 'main.js', 'controls.js', 'storage.js', 'audio.js', 'wasm.js', 'nes_wasm.wasm']
    .map(name => new URL(name, appUrl).href).sort();
  expect(requests.map(request => request.url).sort()).toEqual(assets);
  await expect(page.getByText('None inserted')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.locator('canvas')).toHaveJSProperty('width', 256);
  await expect(page.locator('canvas')).toHaveJSProperty('height', 240);
  await expect(page.locator('#library li')).toHaveCount(0);

  await choose(page);
  await seeColor(page, originalColor);
  await key(page, 'x', pressColor);
  const picker = page.locator('#rom');
  const invalid = { name: 'broken.nes', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2]) };
  await picker.setInputFiles(invalid);
  await expect(page.locator('#status')).toHaveText(/iNES header/);
  await expect(page.locator('#inserted')).toHaveText('diagnostic.nes');
  await seeColor(page, pressColor);

  const unsupported = Buffer.from(await readFile(fixture()));
  unsupported[6] = 0xf0;
  unsupported[7] = 0xf0;
  await picker.setInputFiles({ ...invalid, name: 'unsupported.nes', buffer: unsupported });
  await expect(page.locator('#status')).toHaveText('Unsupported mapper 255');
  await expect(page.locator('#inserted')).toHaveText('diagnostic.nes');
  await expect(page.locator('#library li')).toHaveCount(1);

  await picker.dispatchEvent('cancel'); // Browser automation cannot dismiss the OS picker.
  await expect(page.locator('#status')).toHaveText(/cancelled/);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await seeColor(page, pressColor);
  await choose(page, 'diagnostic-alternate');
  await expect(page.locator('#inserted')).toHaveText('diagnostic-alternate.nes');
  await seeColor(page, originalColor);
  expect(errors).toEqual([]);
  expect(requests.map(request => request.url).sort()).toEqual(assets);
  expect(requests.every(request => request.method === 'GET' && request.body === null)).toBe(true);
});

test('playback, controls, display, real audio and hidden-tab suspension', async ({ page, context }) => {
  await instrumentDevices(page);
  await coreReady(page);
  await choose(page);
  await seeColor(page, originalColor);
  await expect.poll(() => page.evaluate(() => window.audioProbe.context.state)).toBe('running');
  await expect.poll(() => page.evaluate(() => window.audioPeak())).toBeGreaterThan(.02);

  await key(page, 'ArrowRight', [100, 176, 255]);
  await seeColor(page, originalColor);
  await page.evaluate(() => { window.gamepadButtons[14].pressed = true; });
  await seeColor(page, [146, 144, 255]);
  await page.evaluate(() => { window.gamepadButtons[14].pressed = false; });
  await seeColor(page, originalColor);

  const client = await context.newCDPSession(page);
  await page.locator('#dpad').scrollIntoViewIfNeeded();
  const box = await page.locator('#dpad').boundingBox();
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: box.x + box.width * .85, y: box.y + box.height * .15 }],
  });
  await seeColor(page, [136, 216, 0]);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await seeColor(page, originalColor);

  await page.locator('#scale').selectOption('1');
  await expect(page.locator('canvas')).toHaveCSS('width', '256px');
  await page.locator('#scale').selectOption('2');
  await expect(page.locator('canvas')).toHaveCSS('width', '512px');
  await page.locator('#display').selectOption('crt');
  await expect(page.locator('#screen')).toHaveAttribute('data-display', 'crt');
  await expect(page.locator('canvas')).toHaveCSS('image-rendering', 'auto');
  await page.locator('#display').selectOption('pixel');
  await expect(page.locator('canvas')).toHaveCSS('image-rendering', 'pixelated');

  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('screen');
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);

  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.audioPeak())).toBeLessThan(.001);
  await page.getByRole('slider', { name: 'Volume' }).fill('23');
  await page.getByRole('button', { name: 'Unmute' }).click();
  await expect.poll(() => page.evaluate(() => window.audioProbe.gain.gain.value)).toBeCloseTo(.23);
  await expect.poll(() => page.evaluate(() => window.audioPeak())).toBeGreaterThan(.01);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const count = await page.evaluate(() => window.audioProbe.starts);
  await expect.poll(() => page.evaluate(() => window.audioPeak())).toBeLessThan(.001);
  expect(await page.evaluate(() => window.audioProbe.starts)).toBe(count);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.keyboard.down('ArrowRight');
  await seeColor(page, [100, 176, 255]);
  await page.evaluate(() => window.changeVisibility(true));
  await expect.poll(() => page.evaluate(() => window.audioProbe.context.state)).toBe('suspended');
  const hidden = await page.evaluate(() => ({ starts: window.audioProbe.starts, stops: window.audioProbe.stops }));
  expect(hidden.stops).toBeGreaterThan(0);
  await seeColor(page, [100, 176, 255]);
  expect(await page.evaluate(() => window.audioProbe.starts)).toBe(hidden.starts);
  await page.evaluate(() => window.changeVisibility(false));
  await seeColor(page, originalColor);
  await page.keyboard.up('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.audioProbe.context.state)).toBe('running');

  await key(page, 'x', pressColor);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await seeColor(page, pressColor);
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('remembered ROMs, saves per identity, reset, removal and preferences', async ({ page }) => {
  await coreReady(page);
  await choose(page);
  await seeColor(page, originalColor);
  await key(page, 'x', pressColor);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await seeColor(page, pressColor);

  await choose(page, 'diagnostic-alternate');
  await seeColor(page, originalColor);
  await key(page, 'x', pressColor);
  // Give the cartridge a frame with the button released before the next rising edge.
  await key(page, 'ArrowRight', [100, 176, 255]);
  await key(page, 'x', secondPressColor);
  await page.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
  await seeColor(page, pressColor);
  await page.locator('#scale').selectOption('3');
  await page.locator('#display').selectOption('crt');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();

  await page.reload();
  await expect(page.getByText('None inserted')).toBeVisible();
  await expect(page.locator('#scale')).toHaveValue('3');
  await expect(page.locator('#display')).toHaveValue('crt');
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await page.getByRole('button', { name: 'diagnostic-alternate.nes', exact: true }).click();
  await seeColor(page, secondPressColor);
  await page.getByRole('button', { name: 'Remove diagnostic.nes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'diagnostic.nes', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#library li')).toHaveCount(1);
  await choose(page);
  await seeColor(page, pressColor);
});

test('failed restore protects an existing save and retry recovers it', async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (window.failRestore && name.includes('/battery-v1/')) throw new DOMException('Test read failure', 'SecurityError');
      return getItem.call(this, name);
    };
  });
  await coreReady(page);
  const hash = createHash('sha256').update(await readFile(fixture())).digest('hex');
  const storageKey = 'nes-rust-neo/battery-v1/' + hash;
  const bytes = Buffer.alloc(8192);
  bytes[0] = 2;
  const encoded = bytes.toString('base64');
  await page.evaluate(({ storageKey, encoded }) => {
    localStorage.setItem(storageKey, encoded);
    window.failRestore = true;
  }, { storageKey, encoded });
  await choose(page);
  await expect(page.locator('#warnings')).toHaveText(/Existing data is protected/);
  await seeColor(page, originalColor);
  await key(page, 'x', pressColor);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await seeColor(page, pressColor);
  await page.evaluate(() => { window.failRestore = false; });
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(encoded);
  await page.getByRole('button', { name: 'Retry save storage' }).click();
  await seeColor(page, secondPressColor);
  await expect(page.locator('#status')).toHaveText('Battery save restored. Cartridge restarted.');
  await expect(page.locator('#warnings')).toBeHidden();
});

test('unavailable cartridge storage and failed writes can recover after switching', async ({ page }) => {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      if (window.failLibrary) throw new DOMException('Test database failure', 'SecurityError');
      return open(...args);
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (window.failWrite && name.includes('/battery-v1/')) throw new DOMException('Test quota failure', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  });
  await coreReady(page);
  await page.evaluate(() => { window.failLibrary = window.failWrite = true; });
  await choose(page);
  await seeColor(page, originalColor);
  await expect(page.locator('#warnings')).toHaveText(/could not be remembered/);
  await key(page, 'x', pressColor);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#warnings')).toHaveText(/Progress is held in this tab/);

  await page.evaluate(() => { window.failLibrary = false; });
  await choose(page, 'diagnostic-alternate');
  await seeColor(page, originalColor);
  await page.evaluate(() => { window.failWrite = false; });
  await page.getByRole('button', { name: 'Retry save storage' }).click();
  await expect(page.locator('#warnings')).toBeHidden();
  await choose(page);
  await seeColor(page, pressColor);
});
