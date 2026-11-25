import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixtures = new URL('../../tests/generated/', import.meta.url);
const fixture = (name = 'diagnostic') => fileURLToPath(new URL(name + '.nes', fixtures));
const originalColor = [173, 173, 173];
const pressColor = [21, 95, 217];
const secondPressColor = [66, 64, 255];
const thirdPressColor = [117, 39, 254];

async function coreReady(page) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Insert cartridge', exact: true })).toBeEnabled();
}

async function openCartridges(page) {
  await page.getByRole('button', { name: /^(Insert|Change) cartridge$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Cartridges' })).toBeVisible();
}

async function choose(page, name) {
  await openCartridges(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open local ROM' }).click();
  await (await chooser).setFiles(fixture(name));
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog', { name: 'Cartridges' })).toBeHidden();
}

function color(page) {
  return page.locator('canvas').evaluate(canvas =>
    [...canvas.getContext('2d').getImageData(75, 100, 1, 1).data].slice(0, 3));
}

async function batteryKey(name) {
  const hash = createHash('sha256').update(await readFile(fixture(name))).digest('hex');
  return 'nes-rust-neo/battery-v1/' + hash;
}

function savedValue(page, key) {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : atob(raw).charCodeAt(0);
  }, key);
}

async function holdSaveLock(page, key) {
  await page.evaluate(key => new Promise(resolve => {
    void navigator.locks.request(key, () => new Promise(release => {
      window.releaseSaveLock = release;
      resolve();
    }));
  }), key);
}

function queuedSaveWrites(page, key) {
  return page.evaluate(async key => {
    const { pending } = await navigator.locks.query();
    return pending.filter(lock => lock.name === key).length;
  }, key);
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
  await expect(page.locator('#inserted')).toHaveText('None');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.locator('#display')).toHaveValue('crt');
  await expect(page.locator('#scale')).toHaveValue('3');
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('100');
  await expect(page.locator('canvas')).toHaveJSProperty('width', 256);
  await expect(page.locator('canvas')).toHaveJSProperty('height', 240);
  await openCartridges(page);
  await expect(page.locator('#library li')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Cartridges' })).toBeHidden();

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

test('playback, controls, display, real audio and hidden-tab suspension', async ({ page }) => {
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
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('game-presentation');
  await expect(page.getByRole('group', { name: 'On-screen NES controller' })).toBeHidden();
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(page.locator('canvas')).toBeFocused();

  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('0');
  await expect.poll(() => page.evaluate(() => window.audioPeak())).toBeLessThan(.001);
  await page.getByRole('slider', { name: 'Volume' }).fill('23');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await page.getByRole('button', { name: 'Unmute' }).click();
  await expect(page.getByRole('slider', { name: 'Volume' })).toHaveValue('23');
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
  await page.locator('#help summary').click();
  await expect(page.getByRole('group', { name: 'Controls reference' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Controls reference' })).toBeHidden();
});

test('CRT scanlines fade at mobile size and return at desktop size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await coreReady(page);
  await choose(page);
  await seeColor(page, originalColor);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  async function redLevels() {
    const screenshot = await page.locator('.picture').screenshot();
    return page.evaluate(async png => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = new OffscreenCanvas(1, 48);
      const context = canvas.getContext('2d');
      context.drawImage(image, -Math.floor(image.width / 2), -Math.floor(image.height / 2));
      const { data } = context.getImageData(0, 0, 1, canvas.height);
      const reds = data.filter((_, index) => index % 4 === 0);
      return { darkest: Math.min(...reds), brightest: Math.max(...reds) };
    }, screenshot.toString('base64'));
  }

  const mobile = await redLevels();
  expect(mobile.darkest).toBeGreaterThanOrEqual(172);
  expect(mobile.brightest).toBeLessThanOrEqual(176);
  expect(mobile.brightest - mobile.darkest).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  const desktop = await redLevels();
  expect(desktop.brightest - desktop.darkest).toBeGreaterThan(2);
  expect(desktop.brightest - desktop.darkest).toBeLessThanOrEqual(13);
});

test.describe('coarse-pointer player', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

  test('landscape D-pad fits beside the video and touch works in both fullscreen orientations', async ({ page, context }) => {
    await coreReady(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await choose(page);
    await seeColor(page, originalColor);
    const dpad = page.locator('#dpad');
    const canvas = page.locator('canvas');
    const client = await context.newCDPSession(page);

    async function touchDiagonal() {
      const box = await dpad.boundingBox();
      const { width, height } = page.viewportSize();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: box.x + box.width * .85, y: box.y + box.height * .15 }],
      });
      await seeColor(page, [136, 216, 0]);
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await seeColor(page, originalColor);
    }

    expect(await page.evaluate(() => scrollY)).toBe(0);
    const landscapePad = await dpad.boundingBox();
    const landscapeVideo = await canvas.boundingBox();
    expect(landscapePad.x + landscapePad.width).toBeLessThan(landscapeVideo.x);
    expect(landscapePad.y).toBeLessThan(landscapeVideo.y + landscapeVideo.height);
    await touchDiagonal();

    const enter = page.getByRole('button', { name: 'Fullscreen', exact: true });
    const exit = page.getByRole('button', { name: 'Exit fullscreen', exact: true });
    await enter.tap();
    await expect(page.locator(':fullscreen #dpad')).toBeVisible();
    await touchDiagonal();
    await exit.tap();
    await expect(page.locator(':fullscreen')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await enter.tap();
    await expect(page.locator(':fullscreen #dpad')).toBeVisible();
    const portraitPad = await dpad.boundingBox();
    const portraitVideo = await canvas.boundingBox();
    expect(portraitPad.y).toBeGreaterThanOrEqual(portraitVideo.y + portraitVideo.height - 1);
    await touchDiagonal();
    await exit.tap();
    await expect(page.locator(':fullscreen')).toHaveCount(0);
  });
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
  await openCartridges(page);
  await page.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
  await seeColor(page, pressColor);
  await page.locator('#scale').selectOption('3');
  await page.locator('#display').selectOption('crt');
  await page.getByRole('button', { name: 'Mute', exact: true }).click();

  await page.reload();
  await expect(page.locator('#inserted')).toHaveText('None');
  await expect(page.locator('#scale')).toHaveValue('3');
  await expect(page.locator('#display')).toHaveValue('crt');
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();
  await openCartridges(page);
  await page.getByRole('button', { name: 'diagnostic-alternate.nes', exact: true }).click();
  await seeColor(page, secondPressColor);
  await openCartridges(page);
  await page.getByRole('button', { name: 'Remove diagnostic.nes', exact: true }).click();
  await expect(page.locator('#library li')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#library li')).toHaveCount(1);
  await choose(page);
  await seeColor(page, pressColor);
});

test('same-named cartridges have visible and accessible identifiers for opening and removal', async ({ page }) => {
  await coreReady(page);
  const variants = ['diagnostic', 'diagnostic-alternate'];
  const hashes = [];
  for (const [index, name] of variants.entries()) {
    const buffer = await readFile(fixture(name));
    const hash = createHash('sha256').update(buffer).digest('hex');
    hashes.push(hash.slice(0, 12));
    const save = Buffer.alloc(8192);
    save[0] = index + 1;
    await page.evaluate(({ hash, raw }) => localStorage.setItem('nes-rust-neo/battery-v1/' + hash, raw),
      { hash, raw: save.toString('base64') });
    await page.locator('#rom').setInputFiles({ name: 'same.nes', mimeType: 'application/octet-stream', buffer });
    await expect(page.locator('#library li')).toHaveCount(index + 1);
  }

  await page.reload();
  const rowFor = hash => page.locator('#library li').filter({ hasText: hash });
  for (const [index, hash] of hashes.entries()) {
    await openCartridges(page);
    const row = rowFor(hash);
    await expect(row.getByText(hash, { exact: true })).toBeVisible();
    const open = row.getByRole('button', { name: 'same.nes', exact: true });
    await expect(open).toHaveAccessibleDescription(hash);
    await expect(row.getByRole('button', { name: 'Remove same.nes', exact: true })).toHaveAccessibleDescription(hash);
    await open.click();
    await seeColor(page, [pressColor, secondPressColor][index]);
  }
  await openCartridges(page);
  await rowFor(hashes[0]).getByRole('button', { name: 'Remove same.nes', exact: true }).click();
  await expect(page.locator('#library li')).toHaveCount(1);
  await page.reload();
  await openCartridges(page);
  await page.getByRole('button', { name: 'same.nes', exact: true }).click();
  await seeColor(page, secondPressColor);
});

test('failed save restore preserves the paused cartridge and retry inserts the candidate', async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name === window.failRestoreKey) throw new DOMException('Test read failure', 'SecurityError');
      return getItem.call(this, name);
    };
  });
  await coreReady(page);
  await choose(page);
  await seeColor(page, originalColor);
  await key(page, 'x', pressColor);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  const storageKey = await batteryKey('diagnostic-alternate');
  const bytes = Buffer.alloc(8192);
  bytes[0] = 2;
  const encoded = bytes.toString('base64');
  await page.evaluate(({ storageKey, encoded }) => {
    localStorage.setItem(storageKey, encoded);
    window.failRestoreKey = storageKey;
  }, { storageKey, encoded });
  await page.locator('#rom').setInputFiles(fixture('diagnostic-alternate'));
  await expect(page.locator('#warnings')).toHaveText(/Existing data is protected/);
  await expect(page.locator('#inserted')).toHaveText('diagnostic.nes');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await expect(page.locator('#library li')).toHaveCount(1);
  await seeColor(page, pressColor);
  await page.evaluate(() => { delete window.failRestoreKey; });
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(encoded);
  await page.getByRole('button', { name: 'Retry save storage' }).click();
  await expect(page.locator('#inserted')).toHaveText('diagnostic-alternate.nes');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await seeColor(page, secondPressColor);
  await expect(page.locator('#warnings')).toBeHidden();
  await expect(page.locator('#library li')).toHaveCount(2);
});

test('the first battery change survives an immediate reload', async ({ page }) => {
  await coreReady(page);
  await choose(page);
  await seeColor(page, originalColor);
  const storageKey = await batteryKey();
  expect(await savedValue(page, storageKey)).toBeNull();
  // Reload as soon as the diagnostic renders its first changed save value.
  await page.evaluate(rgb => {
    const draw = CanvasRenderingContext2D.prototype.putImageData;
    CanvasRenderingContext2D.prototype.putImageData = function (image, ...args) {
      draw.call(this, image, ...args);
      const pixel = (100 * image.width + 75) * 4;
      if (rgb.every((channel, index) => image.data[pixel + index] === channel)) location.reload();
    };
  }, pressColor);
  const reloaded = page.waitForEvent('load');
  await page.keyboard.down('x');
  await reloaded;
  await page.keyboard.up('x');
  await openCartridges(page);
  await page.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
  await seeColor(page, pressColor);
  await expect.poll(() => savedValue(page, storageKey)).toBe(1);
  await expect(page.locator('#warnings')).toBeHidden();
});

for (const [departure, competingSave] of [
  ['reload', false], ['reload', true], ['tab close', false], ['tab close', true],
]) {
  const outcome = competingSave ? 'keeps the competing save protected' : 'commits the recovered progress';
  test(`${departure} with a queued battery write ${outcome}`, async ({ page, context }) => {
    await coreReady(page);
    await choose(page);
    await seeColor(page, originalColor);
    const storageKey = await batteryKey();
    await key(page, 'x', pressColor);
    await expect.poll(() => savedValue(page, storageKey)).toBe(1);

    const other = await context.newPage();
    await coreReady(other);
    await holdSaveLock(other, storageKey);
    try {
      await page.bringToFront();
      await page.locator('canvas').focus();
      await key(page, 'ArrowRight', [100, 176, 255]);
      await key(page, 'x', secondPressColor);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect.poll(() => queuedSaveWrites(other, storageKey)).toBe(1);
      expect(await savedValue(other, storageKey)).toBe(1);

      if (departure === 'tab close') {
        // A live tab's queued progress belongs to that tab until it closes.
        await other.bringToFront();
        await openCartridges(other);
        await other.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
        await seeColor(other, pressColor);
        await page.close();
      } else {
        await page.reload();
      }
      await expect.poll(() => queuedSaveWrites(other, storageKey)).toBe(0);
      if (competingSave) {
        // Simulate a write by the other tab while it owns the save lock.
        await other.evaluate(key => localStorage.setItem(key, btoa('\0'.repeat(8192))), storageKey);
      }
    } finally {
      await other.evaluate(() => window.releaseSaveLock());
    }

    const reopened = departure === 'tab close' ? await context.newPage() : page;
    if (reopened !== page) await coreReady(reopened);
    await openCartridges(reopened);
    await reopened.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
    await seeColor(reopened, secondPressColor);
    if (competingSave) {
      await expect(reopened.locator('#warnings')).toHaveText(/changed in another tab/);
      expect(await savedValue(other, storageKey)).toBe(0);
      await reopened.getByRole('button', { name: 'Retry save storage' }).click();
      await seeColor(reopened, originalColor);
      await reopened.reload();
      await openCartridges(reopened);
      await reopened.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
      await seeColor(reopened, originalColor);
    } else {
      await expect.poll(() => savedValue(other, storageKey)).toBe(2);
    }
    await expect(reopened.locator('#warnings')).toBeHidden();
  });
}

for (const competingSave of [false, true]) {
  const outcome = competingSave ? 'protects the shared save' : 'commits the newest draft';
  test(`reload with an older session backup ${outcome}`, async ({ page, context }) => {
    await page.addInitScript(() => {
      const { setItem, removeItem } = Storage.prototype;
      Storage.prototype.setItem = function (name, value) {
        if (window.failDraftWrite && this === localStorage && name.includes('/battery-draft-v1/')) {
          throw new DOMException('Test quota failure', 'QuotaExceededError');
        }
        return setItem.call(this, name, value);
      };
      Storage.prototype.removeItem = function (name) {
        if (window.failBackupCleanup && this === sessionStorage && name.includes('/battery-draft-v1/')) {
          throw new DOMException('Test cleanup failure', 'SecurityError');
        }
        return removeItem.call(this, name);
      };
    });

    await coreReady(page);
    await choose(page);
    await seeColor(page, originalColor);
    const storageKey = await batteryKey();
    const backupKey = storageKey.replace('/battery-v1/', '/battery-draft-v1/');
    const drafts = () => page.evaluate(key => {
      const backup = JSON.parse(sessionStorage.getItem(key));
      const draftKey = Object.keys(localStorage).find(name => name.startsWith(key + '/'));
      const draft = draftKey ? JSON.parse(localStorage.getItem(draftKey)) : null;
      return [backup, draft].map(copy => copy ? atob(copy.raw).charCodeAt(0) : null);
    }, backupKey);
    await key(page, 'x', pressColor);
    await expect.poll(() => savedValue(page, storageKey)).toBe(1);

    const other = await context.newPage();
    await coreReady(other);
    await holdSaveLock(other, storageKey);
    try {
      await page.bringToFront();
      await page.locator('canvas').focus();
      await page.evaluate(() => { window.failDraftWrite = true; });
      await key(page, 'ArrowRight', [100, 176, 255]);
      await key(page, 'x', secondPressColor);
      await expect.poll(drafts).toEqual([2, null]);
      await expect.poll(() => queuedSaveWrites(other, storageKey)).toBe(1);

      await page.evaluate(() => {
        window.failDraftWrite = false;
        window.failBackupCleanup = true;
      });
      await key(page, 'ArrowRight', [100, 176, 255]);
      await key(page, 'x', thirdPressColor);
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect.poll(drafts).toEqual([2, 3]);
      expect(await savedValue(other, storageKey)).toBe(1);

      await page.reload();
      await expect.poll(() => queuedSaveWrites(other, storageKey)).toBe(0);
      if (competingSave) {
        await other.evaluate(key => localStorage.setItem(key, btoa('\0'.repeat(8192))), storageKey);
      }
    } finally {
      await other.evaluate(() => window.releaseSaveLock());
    }

    await openCartridges(page);
    await page.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
    await seeColor(page, thirdPressColor);
    if (competingSave) {
      await expect(page.locator('#warnings')).toHaveText(/changed in another tab/);
      expect(await savedValue(other, storageKey)).toBe(0);
      expect(await drafts()).toEqual([2, 3]);
      await page.getByRole('button', { name: 'Retry save storage' }).click();
      await seeColor(page, originalColor);
    } else {
      await expect.poll(() => savedValue(other, storageKey)).toBe(3);
    }
    await expect.poll(drafts).toEqual([null, null]);
    await expect(page.locator('#warnings')).toBeHidden();
  });
}

async function abandonQueuedSaves(page, context, { distinct }) {
  const lockTab = await context.newPage();
  const second = await context.newPage();
  await coreReady(lockTab);
  await coreReady(page);
  await choose(page);
  await seeColor(page, originalColor);
  const storageKey = await batteryKey();
  await key(page, 'x', pressColor);
  await expect.poll(() => savedValue(lockTab, storageKey)).toBe(1);

  await coreReady(second);
  await choose(second);
  await seeColor(second, pressColor);
  const drafts = () => lockTab.evaluate(key => {
    const prefix = key.replace('/battery-v1/', '/battery-draft-v1/') + '/';
    return Object.keys(localStorage).filter(name => name.startsWith(prefix))
      .map(name => atob(JSON.parse(localStorage.getItem(name)).raw).charCodeAt(0)).sort();
  }, storageKey);
  await holdSaveLock(lockTab, storageKey);
  try {
    for (const writer of [page, second]) {
      await writer.bringToFront();
      await writer.locator('canvas').focus();
      await key(writer, 'ArrowRight', [100, 176, 255]);
      await key(writer, 'x', secondPressColor);
      if (distinct && writer === second) {
        await key(writer, 'ArrowRight', [100, 176, 255]);
        await key(writer, 'x', thirdPressColor);
      }
      await writer.getByRole('button', { name: 'Pause', exact: true }).click();
    }
    await expect.poll(() => queuedSaveWrites(lockTab, storageKey)).toBe(2);
    await expect.poll(drafts).toEqual(distinct ? [2, 3] : [2, 2]);
    await page.close();
    await second.close();
    await expect.poll(() => queuedSaveWrites(lockTab, storageKey)).toBe(0);
  } finally {
    await lockTab.evaluate(() => window.releaseSaveLock());
  }
  return { lockTab, storageKey, drafts };
}

test('identical abandoned battery drafts do not override later progress', async ({ page, context }) => {
  const { lockTab, storageKey, drafts } = await abandonQueuedSaves(page, context, { distinct: false });
  const recovered = await context.newPage();
  await coreReady(recovered);
  await openCartridges(recovered);
  await recovered.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
  await seeColor(recovered, secondPressColor);
  await expect.poll(() => savedValue(lockTab, storageKey)).toBe(2);
  await expect(recovered.locator('#warnings')).toBeHidden();

  await key(recovered, 'ArrowRight', [100, 176, 255]);
  await key(recovered, 'x', thirdPressColor);
  await expect.poll(() => savedValue(lockTab, storageKey)).toBe(3);
  await recovered.close();

  const reopened = await context.newPage();
  await coreReady(reopened);
  await openCartridges(reopened);
  await reopened.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
  await seeColor(reopened, thirdPressColor);
  await expect(reopened.locator('#warnings')).toBeHidden();
  expect(await savedValue(lockTab, storageKey)).toBe(3);
  expect(await drafts()).toEqual([]);
});

test('closing two queued writers keeps both recovery copies until a version is chosen', async ({ page, context }) => {
  const { lockTab, storageKey, drafts } = await abandonQueuedSaves(page, context, { distinct: true });
  const reopened = await context.newPage();
  await coreReady(lockTab);
  await coreReady(reopened);
  for (const reader of [lockTab, reopened]) {
    await openCartridges(reader);
    await reader.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
    await expect(reader.getByRole('group', { name: 'Battery save recovery' })).toBeVisible();
    await expect(reader.getByRole('button', { name: /^Use recovery copy / })).toHaveCount(2);
    await expect(reader.getByRole('button', { name: 'Retry save storage' })).toBeHidden();
    await expect(reader.locator('#inserted')).toHaveText('None');
    expect(await savedValue(lockTab, storageKey)).toBe(1);
    expect(await drafts()).toEqual([2, 3]);
  }
  await reopened.getByRole('button', { name: /^Use recovery copy 2/ }).click();
  await seeColor(reopened, thirdPressColor);
  await expect.poll(() => savedValue(lockTab, storageKey)).toBe(3);
  await expect.poll(drafts).toEqual([]);
  // A choice from the other tab's old view cannot undo the resolution.
  await lockTab.getByRole('button', { name: /^Use recovery copy 1/ }).click();
  await expect(lockTab.getByRole('button', { name: /^Use recovery copy / })).toHaveCount(0);
  expect(await savedValue(lockTab, storageKey)).toBe(3);
  await lockTab.getByRole('button', { name: 'Use the stored save' }).click();
  await seeColor(lockTab, thirdPressColor);
});

test('two tabs serialize save writes and a stale tab preserves the winning save', async ({ page: winner, context }) => {
  const stale = await context.newPage();
  for (const page of [winner, stale]) {
    await coreReady(page);
    await choose(page);
    await seeColor(page, originalColor);
  }

  const storageKey = await batteryKey();
  // Hold the real origin-wide lock until both application writes are waiting.
  await holdSaveLock(winner, storageKey);
  const queued = () => queuedSaveWrites(winner, storageKey);
  try {
    await winner.bringToFront();
    await winner.locator('canvas').focus();
    await key(winner, 'x', pressColor);
    await winner.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(queued).toBe(1);

    await stale.bringToFront();
    await stale.locator('canvas').focus();
    await key(stale, 'x', pressColor);
    await key(stale, 'ArrowRight', [100, 176, 255]);
    await key(stale, 'x', secondPressColor);
    await stale.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(queued).toBe(2);
    expect(await winner.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  } finally {
    await winner.evaluate(() => window.releaseSaveLock());
  }

  await expect(stale.locator('#warnings')).toHaveText(/changed in another tab/);
  expect(await winner.evaluate(key => atob(localStorage.getItem(key)).charCodeAt(0), storageKey)).toBe(1);
  await stale.getByRole('button', { name: 'Retry save storage' }).click();
  await expect(stale.locator('#warnings')).toBeHidden();
  await stale.getByRole('button', { name: 'Play', exact: true }).click();
  await seeColor(stale, pressColor);
  await stale.reload();
  await openCartridges(stale);
  await stale.getByRole('button', { name: 'diagnostic.nes', exact: true }).click();
  await seeColor(stale, pressColor);
  await expect(stale.locator('#warnings')).toBeHidden();
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
      if (window.failDraft && name.includes('/battery-draft-v1/')) throw new DOMException('Test quota failure', 'QuotaExceededError');
      return setItem.call(this, name, value);
    };
  });
  await coreReady(page);
  await page.evaluate(() => { window.failLibrary = window.failWrite = window.failDraft = true; });
  await choose(page);
  await seeColor(page, originalColor);
  await expect(page.locator('#warnings')).toHaveText(/could not be remembered/);
  await key(page, 'x', pressColor);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#warnings')).toHaveText(/Progress is held in this tab/);

  await page.evaluate(() => { window.failLibrary = window.failDraft = false; });
  await choose(page, 'diagnostic-alternate');
  await seeColor(page, originalColor);
  await expect(page.locator('#warnings')).toHaveText(/recover progress after reload/);
  await page.evaluate(() => { window.failWrite = false; });
  await page.getByRole('button', { name: 'Retry save storage' }).click();
  await expect(page.locator('#warnings')).toBeHidden();
  await choose(page);
  await seeColor(page, pressColor);
});
