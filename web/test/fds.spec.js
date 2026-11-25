import { test, expect, devices } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const generated = new URL('../../tests/generated/', import.meta.url);
const fixture = name => fileURLToPath(new URL(name, generated));
const multi = 'fds-relay.fds';
const raw = 'fds-relay-raw.fds';
const single = 'fds-relay-single.fds';
const bios = 'fds-bios.rom';
const nes = 'diagnostic.nes';
const button = (page, name) => page.getByRole('button', { name, exact: true });
const drive = page => page.getByRole('group', { name: 'Disk drive' });

async function ready(page) {
  await page.addInitScript(() => {
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async (...args) => {
      const result = await instantiate(...args);
      if (result.instance?.exports.debug_peek_ram) window.emulator = result.instance.exports;
      return result;
    };
    const copy = AudioBuffer.prototype.copyToChannel;
    AudioBuffer.prototype.copyToChannel = function (samples, ...args) {
      window.outputPeak = samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
      return copy.call(this, samples, ...args);
    };
  });
  await page.goto('./');
  await expect(button(page, 'Open game')).toBeEnabled();
}

async function picker(page) {
  const pane = page.getByRole('dialog', { name: 'Open game' });
  if (!await pane.isVisible()) await page.getByRole('button', { name: /^(Open|Change) game$/ }).click();
  await expect(pane).toBeVisible();
  return pane;
}

async function chooseFile(page, name, source) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name }).click();
  await (await chooser).setFiles(source);
}

async function loadFile(page, name) {
  await picker(page);
  await chooseFile(page, 'Open local game…', fixture(name));
}

async function localBios(page) {
  await expect(page.locator('#bios-required')).toBeVisible();
  await chooseFile(page, 'Choose FDS BIOS…', fixture(bios));
}

async function remembered(page, name) {
  const pane = await picker(page);
  await button(pane, name).click();
}

async function loaded(page, name) {
  await expect(page.locator('#inserted')).toHaveText(name);
  await expect(button(page, 'Pause')).toBeEnabled();
}

function peek(page, address) {
  return page.evaluate(address => window.emulator.debug_peek_ram(address), address);
}

function waitRam(page, address, value) {
  return page.waitForFunction(([address, value]) =>
    window.emulator.debug_peek_ram(address) === value, [address, value]);
}

async function booted(page, side = 1) {
  await waitRam(page, 0x10, side);
  expect(await peek(page, 8)).toBe(3);
  expect(await peek(page, 0x1f)).toBe(0);
}

function frame(page) {
  return page.locator('canvas').evaluate(canvas => canvas.toDataURL());
}

async function deliver(page, initialFrame) {
  const target = await peek(page, 0x18);
  const start = await peek(page, 0x11);
  if (Math.abs(target - start) > 2) {
    const key = target > start ? 'ArrowRight' : 'ArrowLeft';
    await page.keyboard.down(key);
    await page.waitForFunction(([target, right]) => {
      const position = window.emulator.debug_peek_ram(0x11);
      return right ? position >= target - 2 : position <= target + 2;
    }, [target, target > start]);
    await page.keyboard.up(key);
    if (initialFrame) await expect.poll(() => frame(page)).not.toBe(initialFrame);
  }
  const deliveries = await peek(page, 0x13);
  await page.keyboard.down('x');
  await waitRam(page, 0x13, deliveries + 1);
  await page.keyboard.up('x');
}

async function changeSide(page, side) {
  const select = page.getByLabel('Disk side');
  await select.focus();
  await select.selectOption(String(side - 1));
  await expect(page.locator('#disk-status')).toHaveText('Inserted');
  await expect(page.locator('canvas')).toBeFocused();
  await waitRam(page, 0x10, side);
}

async function saveKey(name) {
  const bytes = await readFile(fixture(name));
  return 'fds-' + createHash('sha256').update(bytes[0] === 70 ? bytes.subarray(16) : bytes).digest('hex');
}

function diskStorage(page, key) {
  return page.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open('nes-rust-neo/fds', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('data');
      const get = tx.objectStore('data').get(key);
      tx.oncomplete = () => {
        db.close();
        if (key === 'bios') resolve(get.result && Array.from(get.result));
        else resolve(get.result && Array.from({ length: get.result.bytes.length / 98304 },
          (_, side) => get.result.bytes[side * 98304 + 3560]));
      };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), key);
}

async function injectDiskFailures(page) {
  await page.addInitScript(() => {
    for (const method of ['get', 'put']) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        const key = args[method === 'get' ? 0 : 1];
        if (this.name === 'data' && key?.startsWith?.('fds-') && method === 'get' && window.failDisk === 'corrupt') {
          return original.call(this, 'malformed-disk-save');
        }
        if (this.name === 'data' && key?.startsWith?.('fds-') && window.failDisk === method) {
          throw new DOMException('Injected disk storage failure', 'QuotaExceededError');
        }
        return original.apply(this, args);
      };
    }
  });
}

async function retryDiskWrite(retry) {
  // Keep automatic saves failing until the retry click reaches the button.
  await retry.evaluate(element => {
    element.addEventListener('click', () => { delete window.failDisk; }, { capture: true, once: true });
  });
  await retry.click();
}

test('one picker validates media and manages a local BIOS without disrupting the current game', async ({ page }) => {
  const urls = [];
  page.on('request', request => urls.push([request.method(), request.url(), request.postData()]));
  await ready(page);
  const assets = ['', 'index.html', 'style.css', 'main.js', 'controls.js', 'storage.js', 'disk-storage.js',
    'audio.js', 'wasm.js', 'nes_wasm.wasm'].map(path => new URL(path, page.url()).href);
  await expect(drive(page)).toBeHidden();
  const legacyBytes = await readFile(fixture(nes));
  const legacyId = createHash('sha256').update(legacyBytes).digest('hex');
  const legacySave = Buffer.alloc(8192);
  legacySave[0] = 2;
  await page.evaluate(async ({ bytes, id, save, name }) => {
    localStorage.setItem('nes-rust-neo/battery-v1/' + id, save);
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('nes-rust-neo', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('roms', 'readwrite');
        transaction.objectStore('roms').put({ id, name, bytes: Uint8Array.from(bytes).buffer });
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    });
  }, { bytes: [...legacyBytes], id: legacyId, save: legacySave.toString('base64'), name: nes });
  await page.reload();
  await remembered(page, nes);
  await loaded(page, nes);
  expect(await peek(page, 0x6000)).toBe(2);
  await loadFile(page, nes);
  await loaded(page, nes);
  await button(page, 'Pause').click();
  const before = await frame(page);

  await loadFile(page, multi);
  await expect(page.locator('#bios-required')).toBeVisible();
  await chooseFile(page, 'Choose FDS BIOS…', {
    name: 'wrong.rom', mimeType: 'application/octet-stream', buffer: Buffer.alloc(8191),
  });
  await expect(page.locator('#library-status')).toHaveText(/exactly 8192 bytes/);
  await page.locator('#bios').dispatchEvent('cancel');
  await expect(page.locator('#library-status')).toHaveText('BIOS selection cancelled.');
  await button(page, 'Cancel disk load').click();
  await expect(page.locator('#inserted')).toHaveText(nes);
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await frame(page)).toBe(before);

  await loadFile(page, multi);
  await localBios(page);
  await loaded(page, multi);
  await booted(page);
  await expect.poll(() => page.evaluate(() => window.outputPeak ?? 0)).toBeGreaterThan(.04);
  await expect(page.locator('#disk-side option')).toHaveText(['Disk 1 — A', 'Disk 1 — B', 'Disk 2 — A']);
  await button(page, 'Eject').click();
  await expect(page.locator('#disk-status')).toHaveText('Drive empty');
  await expect(drive(page)).toBeVisible();
  await page.getByLabel('Disk side').selectOption('2');
  await expect(page.locator('#disk-status')).toHaveText('Drive empty');
  await button(page, 'Insert').click();
  await waitRam(page, 0x10, 3);
  await changeSide(page, 2);
  await changeSide(page, 1);

  await remembered(page, nes);
  await loaded(page, nes);
  await expect(drive(page)).toBeHidden();
  await remembered(page, multi);
  await loaded(page, multi);
  await booted(page);
  const pane = await picker(page);
  await expect(pane.getByRole('heading', { name: 'My games' })).toBeVisible();
  await expect(pane.locator('#library li')).toHaveCount(2);
  await expect(pane.getByRole('combobox')).toHaveCount(0);
  const replacement = await readFile(fixture(bios));
  replacement[4096] ^= 1;
  await chooseFile(page, 'Replace FDS BIOS…', {
    name: 'other.rom', mimeType: 'application/octet-stream', buffer: replacement,
  });
  await expect(page.locator('#library-status')).toHaveText('The FDS BIOS was saved locally.');
  expect(await diskStorage(page, 'bios')).toEqual([...replacement]);
  await button(page, 'Forget FDS BIOS').click();
  await expect(page.locator('#library-status')).toHaveText(/removed/);
  expect(await diskStorage(page, 'bios')).toBeUndefined();

  await button(pane, nes).click();
  await loaded(page, nes);
  await remembered(page, multi);
  await expect(page.locator('#bios-required')).toBeVisible();
  await button(page, 'Cancel disk load').click();
  await expect(button(page, 'Pause')).toBeEnabled();
  await expect(page.locator('#inserted')).toHaveText(nes);
  await expect(drive(page)).toBeHidden();

  const bogus = { name: 'not-a-disk.fds', mimeType: 'application/octet-stream', buffer: Buffer.alloc(65500) };
  await page.locator('#rom').setInputFiles(bogus);
  await expect(page.locator('#status')).toHaveText(/Unsupported game format/);
  await expect(page.locator('#inserted')).toHaveText(nes);
  expect(urls.every(([method, url, body]) => method === 'GET' && assets.includes(url) && body === null)).toBe(true);
});

test('guest video, side progression and exact disk writes survive reset, removal, switch and reload', async ({ page }) => {
  const original = await readFile(fixture(multi));
  const id = await saveKey(multi);
  await ready(page);
  await loadFile(page, multi);
  await localBios(page);
  await loaded(page, multi);
  await booted(page);
  const before = await frame(page);

  for (const side of [1, 2, 3]) {
    if (side > 1) await changeSide(page, side);
    await deliver(page, side === 1 ? before : undefined);
    expect(await peek(page, 0x12)).toBe(side * 0x11 + 1);
    const values = [0x11, 0x22, 0x33].map((value, index) => value + (index < side ? 1 : 0));
    await expect.poll(() => diskStorage(page, id)).toEqual(values);
  }
  expect(await peek(page, 0x19)).toBe(2);
  expect(await frame(page)).not.toBe(before);

  await button(page, 'Reset').click();
  await booted(page, 3);
  expect(await peek(page, 0x12)).toBe(0x34);
  await loadFile(page, nes);
  await loaded(page, nes);
  await picker(page);
  await button(page, 'Remove ' + multi).click();
  await expect(page.locator('#library li')).toHaveCount(1);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x23, 0x34]);
  await page.reload();
  await loadFile(page, raw);
  await loaded(page, raw);
  await booted(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  await changeSide(page, 2);
  expect(await peek(page, 0x12)).toBe(0x23);
  await changeSide(page, 3);
  expect(await peek(page, 0x12)).toBe(0x34);
  await loadFile(page, single);
  await loaded(page, single);
  await booted(page, 4);
  await expect(page.locator('#disk-side option')).toHaveText(['Disk 1 — A']);
  expect(await peek(page, 0x12)).toBe(0x44);
  await deliver(page);
  await expect.poll(async () => diskStorage(page, await saveKey(single))).toEqual([0x45]);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x23, 0x34]);
  expect(await readFile(fixture(multi))).toEqual(original);
});

test('disk storage failures and concurrent tabs preserve the active game and allow retry', async ({ page, context }) => {
  await injectDiskFailures(page);
  const id = await saveKey(multi);
  await ready(page);
  await loadFile(page, nes);
  await loaded(page, nes);
  await button(page, 'Pause').click();
  await page.evaluate(() => { window.failDisk = 'get'; });
  await loadFile(page, multi);
  await localBios(page);
  await expect(page.locator('#warnings')).toHaveText(/Could not restore the disk progress/);
  await expect(page.locator('#inserted')).toHaveText(nes);
  await expect(button(page, 'Play')).toBeEnabled();
  await page.evaluate(() => { window.failDisk = 'put'; });
  await button(page, 'Retry save storage').click();
  await loaded(page, multi);
  await booted(page);
  await deliver(page);
  await expect(page.locator('#warnings')).toHaveText(/Could not save disk changes/);
  await loadFile(page, nes);
  await expect(page.locator('#status')).toHaveText(/Save the current disk changes/);
  await expect(page.locator('#inserted')).toHaveText(multi);
  expect(await peek(page, 0x12)).toBe(0x12);

  const other = await context.newPage();
  await ready(other);
  await remembered(other, multi);
  await expect(other.locator('#warnings')).toHaveText(/Close the other tab or open another game there/);
  await expect(other.locator('#inserted')).toHaveText('None');

  await page.bringToFront();
  await retryDiskWrite(button(page, 'Retry save storage'));
  await expect(page.locator('#warnings')).toBeHidden();
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);
  await loadFile(page, nes);
  await loaded(page, nes);
  await page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('nes-rust-neo/fds', 1);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('data', 'readwrite');
      transaction.objectStore('data').put({ version: 1, bytes: new Uint8Array(1) }, 'malformed-disk-save');
      transaction.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await page.evaluate(() => { window.failDisk = 'corrupt'; });
  await remembered(page, multi);
  await expect(page.locator('#warnings')).toHaveText(/stored disk data is invalid/);
  await expect(page.locator('#inserted')).toHaveText(nes);
  await page.evaluate(() => { delete window.failDisk; });
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);
  await other.bringToFront();
  await button(other, 'Retry save storage').click();
  await loaded(other, multi);
  await booted(other);
  expect(await peek(other, 0x12)).toBe(0x12);
});

test('fullscreen disk changes preserve keyboard play and failed saves can be retried in place', async ({ page }) => {
  await injectDiskFailures(page);
  const id = await saveKey(multi);
  await ready(page);
  await loadFile(page, multi);
  await localBios(page);
  await loaded(page, multi);
  await booted(page);
  await button(page, 'Fullscreen').click();
  const fullscreen = page.locator('#game-presentation:fullscreen');
  await expect(fullscreen).toBeVisible();

  await changeSide(page, 2);
  await page.evaluate(() => { window.failDisk = 'put'; });
  await deliver(page);
  expect(await peek(page, 0x12)).toBe(0x23);
  const warning = fullscreen.locator('#fullscreen-disk-warning');
  await expect(warning).toBeInViewport({ ratio: 1 });
  await expect(warning).toHaveText(/Could not save disk changes.*keep this tab open and retry save storage/i);
  expect(await diskStorage(page, id)).toBeUndefined();
  const retry = button(fullscreen, 'Retry save storage');
  await expect(retry).toBeInViewport({ ratio: 1 });
  await retryDiskWrite(retry);
  await expect(warning).toBeHidden();
  await expect(retry).toBeHidden();
  await expect(fullscreen).toBeVisible();
  expect(await diskStorage(page, id)).toEqual([0x11, 0x23, 0x33]);

  await button(page, 'Exit fullscreen').click();
  await expect(fullscreen).toHaveCount(0);
  await page.reload();
  await remembered(page, multi);
  await loaded(page, multi);
  await booted(page);
  await changeSide(page, 2);
  expect(await peek(page, 0x12)).toBe(0x23);
});

for (const layout of [
  { name: 'desktop', options: { viewport: { width: 1280, height: 900 } } },
  { name: 'portrait', options: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  { name: 'landscape', options: { ...devices['iPhone 13 landscape'], viewport: { width: 844, height: 390 } } },
]) {
  test(`disk drive fits ${layout.name} and fullscreen`, async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({ ...layout.options, deviceScaleFactor: 1, baseURL });
    try {
      const page = await context.newPage();
      await ready(page);
      await loadFile(page, multi);
      await localBios(page);
      await loaded(page, multi);
      await booted(page);
      await expect(drive(page)).toBeVisible();
      await expect(button(page, 'Fullscreen')).toBeInViewport({ ratio: 1 });
      await page.waitForFunction(() => {
        const canvas = document.querySelector('canvas');
        return canvas.getContext('2d').getImageData(51, 114, 1, 1).data[0] > 200;
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        layout.options.viewport.width);
      const initialFrame = await frame(page);
      await page.screenshot({ path: testInfo.outputPath(`fds-${layout.name}.png`) });

      await button(page, 'Fullscreen').click();
      await expect(page.locator('#game-presentation:fullscreen')).toBeVisible();
      await expect(drive(page)).toBeInViewport({ ratio: 1 });
      await expect(page.getByLabel('Disk side')).toBeInViewport({ ratio: 1 });
      await changeSide(page, 2);
      await expect.poll(() => frame(page)).not.toBe(initialFrame);
      await page.screenshot({ path: testInfo.outputPath(`fds-${layout.name}-fullscreen.png`) });
      await button(page, 'Exit fullscreen').click();
      await expect(page.locator('#game-presentation:fullscreen')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}
