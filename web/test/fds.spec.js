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
const acceptRemoval = page => button(page.getByRole('dialog', { name: 'Confirm removal' }), 'Remove').click();

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
  expect(await peek(page, 8)).toBe(0x81);
  expect(await peek(page, 0x1f)).toBe(0);
}

function frame(page) {
  return page.locator('canvas').evaluate(canvas => canvas.toDataURL());
}

async function saveState(page) {
  await button(page, 'Save state').click();
  await expect(page.locator('#status')).toHaveText('State saved.');
  await expect(button(page, 'Save state')).toBeEnabled();
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

async function diskStorage(page, key, initial = [0x11, 0x22, 0x33]) {
  const record = await page.evaluate(key => new Promise((resolve, reject) => {
    const open = indexedDB.open('nes-rust-neo/fds', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('data');
      const get = tx.objectStore('data').get(key);
      tx.oncomplete = () => {
        db.close();
        const result = get.result;
        resolve(key === 'bios' || !result ? result && Array.from(result) : {
          version: result.version, bytes: Array.from(result.bytes),
        });
      };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), key);
  if (!record || key === 'bios') return record;
  expect(record.version).toBe(2);
  return diskProgress(record.bytes, initial);
}

function diskProgress(bytes, initial = [0x11, 0x22, 0x33]) {
  const pageSize = 256;
  const pagesPerSide = 98304 / pageSize;
  const pages = pagesPerSide * initial.length;
  const flagsStart = 79;
  let offset = flagsStart + pages / 8;
  const values = initial.slice();
  for (let page = 0; page < pages; page++) {
    if (!(bytes[flagsStart + (page >> 3)] & (1 << (page & 7)))) continue;
    if (page % pagesPerSide === Math.floor(3560 / pageSize)) {
      values[Math.floor(page / pagesPerSide)] = bytes[offset + 3560 % pageSize];
    }
    offset += pageSize;
  }
  expect(offset + 32).toBe(bytes.length);
  return values;
}

async function injectDiskFailures(page) {
  await page.addInitScript(() => {
    for (const method of ['get', 'put', 'delete']) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function (...args) {
        const key = args[method === 'put' ? 1 : 0];
        if (this.name === 'data' && key?.startsWith?.('fds-') && method === 'get' && window.failDisk === 'corrupt') {
          return original.call(this, 'malformed-disk-save');
        }
        if (this.name === 'data' && key?.startsWith?.(window.failDiskPrefix ?? 'fds-') && window.failDisk === method) {
          if (!(window.failDiskAfter > 0)) {
            throw new DOMException('Injected disk storage failure', 'QuotaExceededError');
          }
          window.failDiskAfter--;
          window.diskKeyWrittenBeforeFailure = key;
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
  const assets = ['', 'index.html', 'style.css', 'main.js', 'controls.js', 'storage.js', 'disk-storage.js', 'save-storage.js', 'saves.js',
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
  await expect.poll(async () => diskStorage(page, await saveKey(single), [0x44])).toEqual([0x45]);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x23, 0x34]);
  expect(await readFile(fixture(multi))).toEqual(original);
});

test('reload preserves the newest writes on both sides while an earlier save is pending', async ({ page }) => {
  const id = await saveKey(multi);
  await page.addInitScript(id => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (key === id) {
        this.transaction.addEventListener('complete', event => {
          // Writes commit, but their callbacks stay pending in the old document.
          event.stopImmediatePropagation();
        }, { once: true });
      }
      return request;
    };
  }, id);
  await ready(page);
  await loadFile(page, multi);
  await localBios(page);
  await loaded(page, multi);
  await booted(page);

  await deliver(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);
  await changeSide(page, 2);
  await deliver(page);
  expect(await peek(page, 0x12)).toBe(0x23);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);

  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await remembered(page, multi);
  await loaded(page, multi);
  await booted(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  await changeSide(page, 2);
  expect(await peek(page, 0x12)).toBe(0x23);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x23, 0x33]);
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
  const warning = fullscreen.locator('#fullscreen-save-message');
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

test.describe('short landscape fullscreen save warning', () => {
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });

  test('all touch controls remain usable while a disk write can be retried', async ({ page }, testInfo) => {
    const name = 'FDS Relay (Japan) (English Translation) (Revision 2) (Diagnostic Build).fds';
    const id = await saveKey(multi);
    await injectDiskFailures(page);
    await ready(page);
    await picker(page);
    await chooseFile(page, 'Open local game…', {
      name, mimeType: 'application/octet-stream', buffer: await readFile(fixture(multi)),
    });
    await localBios(page);
    await loaded(page, name);
    await booted(page);
    await button(page, 'Fullscreen').tap();
    const fullscreen = page.locator('#game-presentation:fullscreen');
    await expect(fullscreen).toBeVisible();
    await page.locator('canvas').focus();
    await page.evaluate(() => { window.failDisk = 'put'; });
    await deliver(page);

    const warning = fullscreen.locator('#fullscreen-save-message');
    await expect(warning).toHaveText(`Could not save disk changes for ${name}. Keep this tab open and retry save storage.`);
    const retry = button(fullscreen, 'Retry save storage');
    const pads = fullscreen.locator('[data-pad]');
    await expect(pads).toHaveCount(8);
    await page.screenshot({ path: testInfo.outputPath('fds-short-landscape-fullscreen-save-warning.png') });
    for (const target of [
      ...await pads.all(), button(fullscreen, 'Exit fullscreen'),
      fullscreen.getByLabel('Disk side'), button(fullscreen, 'Eject'), retry,
    ]) {
      await expect(target).toBeInViewport({ ratio: 1 });
      await target.tap({ trial: true });
    }
    await expect(warning).toBeInViewport({ ratio: 1 });
    expect(await warning.evaluate(element => element.scrollHeight)).toBeLessThanOrEqual(
      await warning.evaluate(element => element.clientHeight));
    expect(await diskStorage(page, id)).toBeUndefined();
    await retryDiskWrite(retry);
    await expect(warning).toBeHidden();
    await expect(fullscreen).toBeVisible();
    expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);
  });
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

test('loading a state flushes matching unsaved disk changes before activating it', async ({ page }) => {
  await injectDiskFailures(page);
  const id = await saveKey(multi);
  await ready(page);
  await loadFile(page, multi);
  await localBios(page);
  await booted(page);
  await page.evaluate(() => { window.failDisk = 'put'; });
  await deliver(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  await expect(page.locator('#warnings')).toHaveText(/Could not save disk changes/);
  expect(await diskStorage(page, id)).toBeUndefined();
  await saveState(page);

  await page.evaluate(() => { delete window.failDisk; });
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText('State loaded.');
  await button(page, 'Pause').click();
  await page.reload();
  await remembered(page, multi);
  await booted(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);
});

test('a failed disk profile removal preserves the active machine and can be retried', async ({ page }) => {
  await injectDiskFailures(page);
  const id = await saveKey(multi);
  await ready(page);
  await loadFile(page, multi);
  await localBios(page);
  await booted(page);
  const profiles = page.getByRole('dialog', { name: 'Save data' });
  await page.locator('#save-data').click();
  await button(profiles, 'New save').click();
  await expect(page.locator('#active-save-name')).toHaveText('Save 2');
  const key = await page.evaluate(id => `${id}:${JSON.parse(localStorage.getItem('nes-rust-neo/profiles-v1/' + id)).selected}`, id);
  await changeSide(page, 2);
  await deliver(page);
  await button(page, 'Pause').click();
  await expect.poll(() => diskStorage(page, key)).toEqual([0x11, 0x23, 0x33]);
  const before = await frame(page);

  await page.locator('#save-data').click();
  await page.evaluate(() => { window.failDisk = 'delete'; });
  await button(profiles, 'Remove Save 2').click();
  await acceptRemoval(page);
  await expect(page.locator('#save-data-message')).toHaveText('Injected disk storage failure');
  await button(profiles, 'Close').click();
  await expect(page.locator('#active-save-name')).toHaveText('Save 2');
  await expect(button(page, 'Play')).toBeEnabled();
  await expect(page.getByLabel('Disk side')).toHaveValue('1');
  expect(await frame(page)).toBe(before);
  expect(await peek(page, 0x12)).toBe(0x23);
  expect(await diskStorage(page, key)).toEqual([0x11, 0x23, 0x33]);

  await page.locator('#save-data').click();
  await expect(button(profiles, 'Save 2')).toHaveAttribute('aria-current', 'true');
  await page.evaluate(() => { delete window.failDisk; });
  await button(profiles, 'Remove Save 2').click();
  await acceptRemoval(page);
  await expect(page.locator('#save-data-message')).toHaveText('Removed Save 2.');
  await expect(button(profiles, 'Save 2')).toHaveCount(0);
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');
  expect(await diskStorage(page, key)).toBeUndefined();
});

test('FDS states restore pending sides and isolate, migrate, and recover writable profiles', async ({ page }) => {
  const network = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url())) network.push([request.method(), request.url(), request.postData()]);
  });
  await injectDiskFailures(page);
  const id = await saveKey(multi);
  await ready(page);
  await loadFile(page, multi);
  await localBios(page);
  await booted(page);
  await deliver(page);
  await button(page, 'Pause').click();
  await expect.poll(() => diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);

  // Seed the previous release's whole-track record under its original key.
  await page.evaluate(key => new Promise((resolve, reject) => {
    const core = window.emulator;
    const bytes = new Uint8Array(core.memory.buffer, core.save_ptr(), core.save_len()).slice();
    const open = indexedDB.open('nes-rust-neo/fds', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('data', 'readwrite');
      tx.objectStore('data').put({ version: 1, bytes }, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), id);
  await page.reload();
  await remembered(page, multi);
  await booted(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);

  const statePicker = page.getByRole('dialog', { name: 'Save states' });
  const profilePicker = page.getByRole('dialog', { name: 'Save data' });
  const rows = statePicker.locator('#state-history li');
  const diskBytes = () => page.evaluate(() => {
    const core = window.emulator;
    const tracks = new Uint8Array(core.memory.buffer, core.save_ptr(), core.save_len());
    return [0, 1, 2].map(side => tracks[side * 98304 + 3560]);
  });
  const openStates = () => page.locator('#choose-state').click();
  async function enterFullscreen() {
    await button(page, 'Fullscreen').click();
    await expect(page.locator(':fullscreen #save-state')).toBeVisible();
  }
  async function leaveFullscreen() {
    await button(page, 'Exit fullscreen').click();
    await expect(page.locator(':fullscreen')).toHaveCount(0);
    await expect(button(page, 'Play')).toBeEnabled();
  }
  async function openProfiles(name) {
    await expect(page.locator('#active-save-name')).toHaveText(name);
    await page.locator('#save-data').click();
  }
  async function exportFile(control, extension) {
    const event = page.waitForEvent('download');
    await control.click();
    const download = await event;
    expect(download.suggestedFilename()).toMatch(extension);
    return {
      name: download.suggestedFilename(), mimeType: 'application/octet-stream',
      buffer: await readFile(await download.path()),
    };
  }

  await button(page, 'Pause').click();
  await enterFullscreen();
  const originalFrame = await frame(page);
  await saveState(page);
  await openStates();
  await expect(rows).toHaveCount(1);
  const preview = rows.first().locator('img');
  expect(await preview.evaluate(image => image.decode().then(() => image.naturalWidth))).toBe(256);
  const initialTime = await rows.first().locator('time').getAttribute('datetime');
  await button(statePicker, 'Close').click();
  await saveState(page);
  await openStates();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('time')).not.toHaveAttribute('datetime', initialTime);
  const exportedState = await exportFile(rows.first().getByRole('button', { name: /^Export state/ }), /\.nesstate$/);
  await button(statePicker, 'New state').click();
  await expect(button(page, 'Load state')).toBeDisabled();
  await page.getByLabel('Disk side').selectOption('1');
  await expect(page.locator('#disk-status')).toHaveText('Changing side…');
  await saveState(page);
  await openStates();
  await expect(rows).toHaveCount(2);
  await rows.last().getByRole('button', { name: /^Select state/ }).click();
  await expect(page.locator('#disk-status')).toHaveText('Changing side…');
  await button(page, 'Load state').click();
  await expect(page.locator('#disk-status')).toHaveText('Inserted');
  await expect(page.getByLabel('Disk side')).toHaveValue('0');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await frame(page)).toBe(originalFrame);
  await leaveFullscreen();
  await expect(button(page, 'Load state')).toBeEnabled();

  await button(page, 'Play').click();
  await deliver(page);
  await changeSide(page, 2);
  await button(page, 'Pause').click();
  await expect.poll(() => diskStorage(page, id)).toEqual([0x13, 0x22, 0x33]);
  // Deliver on side two with the UI paused so only the live disk changes.
  await page.evaluate(() => {
    const core = window.emulator;
    const target = core.debug_peek_ram(0x18);
    for (let i = 0; i < 240; i++) {
      const position = core.debug_peek_ram(0x11);
      if (Math.abs(target - position) <= 2) break;
      core.run_frame(position < target ? 0x80 : 0x40, 0);
    }
    const deliveries = core.debug_peek_ram(0x13);
    for (let i = 0; i < 600 && core.debug_peek_ram(0x13) === deliveries; i++) core.run_frame(1, 0);
  });
  expect(await diskBytes()).toEqual([0x13, 0x23, 0x33]);
  const beforeFailedLoad = await frame(page);
  await page.evaluate(id => {
    window.failDisk = 'put';
    window.failDiskPrefix = id + ':';
    window.failDiskAfter = 1;
  }, id);
  await enterFullscreen();
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText(/Could not load the state.*Browser storage is full/);
  expect(await diskBytes()).toEqual([0x13, 0x23, 0x33]);
  expect(await frame(page)).toBe(beforeFailedLoad);
  await expect(page.getByLabel('Disk side')).toHaveValue('1');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await diskStorage(page, id)).toEqual([0x13, 0x22, 0x33]);
  expect(await page.evaluate(id => localStorage.getItem('nes-rust-neo/profiles-v1/' + id), id)).toBeNull();
  const partialRecoveryKey = await page.evaluate(() => window.diskKeyWrittenBeforeFailure);
  expect(partialRecoveryKey).toContain(id + ':');
  expect(await diskStorage(page, partialRecoveryKey)).toBeUndefined();

  await page.evaluate(() => { delete window.failDisk; });
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText(/Previous progress.*recovery profiles/);
  expect(await diskBytes()).toEqual([0x12, 0x22, 0x33]);
  expect(await diskStorage(page, id)).toEqual([0x12, 0x22, 0x33]);
  await openProfiles('Save 1');
  const saveOneFile = await exportFile(button(profilePicker, 'Export current save data'), /\.fds-save$/);
  await button(profilePicker, 'Close').click();
  await openStates();
  await expect(rows).toHaveCount(2);
  await chooseFile(page, 'Import state', exportedState);
  await expect(page.locator('#state-message')).toHaveText(/State imported/);
  await expect(rows).toHaveCount(3);
  await rows.nth(1).getByRole('button', { name: /^Select state/ }).click();
  await button(page, 'Load state').click();
  await expect(page.locator('#disk-status')).toHaveText('Changing side…');
  await expect(page.getByLabel('Disk side')).toHaveValue('1');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await peek(page, 0x10)).toBe(1);

  await openProfiles('Save 1');
  await expect(profilePicker.getByRole('button', { name: /^Recovery ·/ })).toHaveCount(2);
  const lastSaved = profilePicker.getByRole('button', { name: /^Recovery · Last saved progress ·/ });
  const lastSavedName = await lastSaved.textContent();
  await lastSaved.click();
  await expect(profilePicker).toBeHidden();
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await diskBytes()).toEqual([0x13, 0x22, 0x33]);
  await openProfiles(lastSavedName);
  const recover = profilePicker.getByRole('button', { name: /^Recovery · Current progress ·/ });
  const recoveryName = await recover.textContent();
  await recover.click();
  await expect(profilePicker).toBeHidden();
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await diskBytes()).toEqual([0x13, 0x23, 0x33]);
  await leaveFullscreen();
  await button(page, 'Reset').click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await diskBytes()).toEqual([0x13, 0x23, 0x33]);
  await openStates();
  await expect(rows).toHaveCount(0);
  await button(statePicker, 'Close').click();
  await enterFullscreen();
  await openProfiles(recoveryName);
  await button(profilePicker, 'Duplicate current').click();
  await openProfiles('Save 2');
  const diskFile = await exportFile(button(profilePicker, 'Export current save data'), /\.fds-save$/);
  expect(diskProgress(diskFile.buffer)).toEqual([0x13, 0x23, 0x33]);
  await button(profilePicker, 'Close').click();
  await leaveFullscreen();
  await button(page, 'Play').click();
  await booted(page);
  await button(page, 'Pause').click();
  await enterFullscreen();
  await openProfiles('Save 2');
  await chooseFile(page, 'Import save data', saveOneFile);
  await expect(page.locator('#save-data-message')).toHaveText(/Imported as Save 3/);
  await expect(button(profilePicker, 'Save 2')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#active-save-name')).toHaveText('Save 2');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await peek(page, 0x10)).toBe(1);
  expect(await diskBytes()).toEqual([0x13, 0x23, 0x33]);
  await button(profilePicker, 'Save 3').click();
  await expect(profilePicker).toBeHidden();
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await peek(page, 0x10)).toBe(0);
  expect(await diskBytes()).toEqual([0x12, 0x22, 0x33]);
  await openProfiles('Save 3');
  await button(profilePicker, 'New save').click();
  await openProfiles('Save 4');
  expect(await diskBytes()).toEqual([0x11, 0x22, 0x33]);
  await button(profilePicker, 'Remove Save 4').click();
  await acceptRemoval(page);
  await expect(page.locator('#save-data-message')).toHaveText('Removed Save 4.');
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');
  await button(profilePicker, 'Close').click();
  await expect(button(page, 'Load state')).toBeEnabled();
  await leaveFullscreen();
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');

  const games = await picker(page);
  await button(games, 'Remove ' + multi).click();
  await expect(page.locator('#library-status')).toHaveText(/Removed/);
  await page.keyboard.press('Escape');
  await loadFile(page, raw);
  await loaded(page, raw);
  await booted(page);
  expect(await diskBytes()).toEqual([0x12, 0x22, 0x33]);
  await openStates();
  await expect(rows).toHaveCount(3);
  await button(statePicker, 'Close').click();
  await page.reload();
  await remembered(page, raw);
  await booted(page);
  expect(await peek(page, 0x12)).toBe(0x12);
  await openStates();
  await expect(rows).toHaveCount(3);
  await rows.last().getByRole('button', { name: /^Select state/ }).click();
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText('State loaded.');
  await expect(button(page, 'Pause')).toBeEnabled();
  await openStates();
  await rows.first().getByRole('button', { name: /^Remove state/ }).click();
  await acceptRemoval(page);
  await expect(rows).toHaveCount(2);
  await expect(rows.last().locator('[aria-current=true]')).toBeVisible();
  await rows.last().getByRole('button', { name: /^Remove state/ }).click();
  await acceptRemoval(page);
  await expect(rows).toHaveCount(1);
  await expect(button(statePicker, 'New state')).toHaveAttribute('aria-current', 'true');
  expect(network.every(([method, url, body]) => method === 'GET' && body === null &&
    /^\/nes-rust-neo\/(?:[\w-]+\.(?:js|css|wasm))?$/.test(new URL(url).pathname))).toBe(true);
});
