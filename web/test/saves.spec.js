import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const diagnostic = new URL('../../tests/generated/diagnostic.nes', import.meta.url);
const button = (parent, name) => parent.getByRole('button', { name, exact: true });
const statePicker = page => page.getByRole('dialog', { name: 'Save states' });
const profilePicker = page => page.getByRole('dialog', { name: 'Save data' });
const states = page => statePicker(page).locator('#state-history li');
const target = page => page.locator('#state-target');
const ram = (page, address) => page.evaluate(addr => window.machine.debug_peek_ram(addr), address);
const canvasImage = page => page.locator('canvas').evaluate(canvas => canvas.toDataURL());

async function ready(page) {
  await page.addInitScript(() => {
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async (...args) => {
      const { instance } = await instantiate(...args);
      window.machine = instance.exports;
      window.frames = 0;
      return { instance: { exports: { ...machine, run_frame(...input) {
        window.frames++;
        return machine.run_frame(...input);
      } } } };
    };
  });
  await page.goto('./');
  await expect(button(page, 'Open game')).toBeEnabled();
}

async function insert(page, name, buffer) {
  await page.locator('#rom').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.locator('#inserted')).toHaveText(name);
  await expect.poll(() => ram(page, 0)).toBe(0xa5);
}

async function pause(page) {
  await button(page, 'Pause').click();
  await expect(button(page, 'Play')).toBeEnabled();
}

async function progress(page, count) {
  await page.locator('canvas').focus();
  await page.keyboard.down('x');
  await expect.poll(() => ram(page, 0x6000)).toBe(count);
  await page.keyboard.up('x');
  // Let the diagnostic apply the palette for the released button.
  const before = await page.evaluate(() => window.frames);
  await expect.poll(() => page.evaluate(() => window.frames)).toBeGreaterThan(before + 2);
}

async function save(page) {
  await button(page, 'Save state').click();
  await expect(page.locator('#status')).toHaveText('State saved.');
  await expect(button(page, 'Save state')).toBeEnabled();
}

async function browse(page) {
  await page.locator('#choose-state').click();
  await expect(statePicker(page)).toBeVisible();
  return statePicker(page);
}

async function nativeProfiles(page, name) {
  await expect(page.locator('#active-save-name')).toHaveText(name);
  await page.locator('#save-data').click();
  await expect(profilePicker(page)).toBeVisible();
  return profilePicker(page);
}

async function acceptRemoval(page, prompt) {
  const confirmation = page.getByRole('dialog', { name: 'Confirm removal' });
  await expect(confirmation).toHaveAccessibleDescription(prompt);
  await button(confirmation, 'Remove').click();
}

async function exportFrom(page, control, extension) {
  const event = page.waitForEvent('download');
  await control.click();
  const download = await event;
  expect(download.suggestedFilename().endsWith(extension)).toBe(true);
  const bytes = await readFile(await download.path());
  return { name: download.suggestedFilename(), mimeType: 'application/octet-stream', buffer: bytes };
}

async function openWithUnsavedSram(page) {
  const media = await readFile(diagnostic);
  const key = 'nes-rust-neo/battery-v1/' + createHash('sha256').update(media).digest('hex');
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [key, Buffer.alloc(8192).toString('base64')]);
  await insert(page, 'battery.nes', media);
  await pause(page);
  // Advance the real core with A held while the UI's frame loop and autosave are paused.
  await page.evaluate(() => {
    window.machine.run_frame(1, 0);
    window.machine.run_frame(1, 0);
  });
  expect(await ram(page, 0x6000)).toBe(1);
  expect(await page.evaluate(key => atob(localStorage.getItem(key)).charCodeAt(0), key)).toBe(0);
}

async function reopenBattery(page) {
  await page.reload();
  await button(page, 'Open game').click();
  await button(page, 'battery.nes').click();
  await expect(button(page, 'Pause')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(1);
}

test('loading a state with matching live SRAM persists it without creating a profile', async ({ page }) => {
  await ready(page);
  await openWithUnsavedSram(page);
  await save(page);
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText('State loaded.');
  await expect(button(page, 'Play')).toBeEnabled();
  await reopenBattery(page);
  await pause(page);
  const profiles = await nativeProfiles(page, 'Save 1');
  await expect(profiles.locator('#save-profiles li')).toHaveCount(1);
  await expect(button(profiles, 'Save 1')).toHaveAttribute('aria-current', 'true');
});

test('reloading while an IndexedDB state write is queued preserves SRAM', async ({ page }) => {
  await ready(page);
  await openWithUnsavedSram(page);
  const picker = await browse(page);
  await expect(picker.getByRole('button', { name: 'New state' })).toBeEnabled();
  await button(picker, 'Close').click();
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('nes-rust-neo/states', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const store = db.transaction('snapshots', 'readwrite').objectStore('snapshots');
    // Keep the first transaction open so the state save waits until navigation.
    const hold = () => { store.get('hold').onsuccess = hold; };
    hold();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === 'snapshots') window.snapshotWrite = request;
      return request;
    };
  });
  await button(page, 'Save state').click();
  await expect.poll(() => page.evaluate(() => window.snapshotWrite?.readyState)).toBe('pending');
  await expect(button(page, 'Save state')).toBeDisabled();
  await reopenBattery(page);
});

test('unified history saves, overwrites, validates imports and explicitly loads real NES frames', async ({ page }) => {
  const requests = [];
  const errors = [];
  page.on('request', request => {
    if (/^https?:/.test(request.url())) requests.push({ url: request.url(), method: request.method(), body: request.postData() });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const media = await readFile(diagnostic);
  media[6] &= ~2;
  await ready(page);
  await expect(page.locator('#state-controls')).toBeHidden();
  await insert(page, 'volatile.nes', media);
  await expect(page.locator('#save-data')).toBeHidden();
  await button(page, 'Fullscreen').click();
  await expect(page.locator(':fullscreen #save-state')).toBeVisible();
  await expect(page.locator(':fullscreen #save-data')).toBeHidden();
  await button(page, 'Exit fullscreen').click();

  let picker = await browse(page);
  const frameAtOpen = await page.evaluate(() => window.frames);
  await expect.poll(() => page.evaluate(() => window.frames)).toBeGreaterThan(frameAtOpen);
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(button(page, 'Load state')).toBeDisabled();

  await pause(page);
  await save(page);
  const firstFrame = await canvasImage(page);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  const firstRow = states(page).first();
  const firstTime = await firstRow.locator('time').getAttribute('datetime');
  expect(Date.parse(firstTime)).toBeGreaterThan(0);
  await expect(firstRow.locator('[aria-current=true]')).toBeVisible();
  const preview = await firstRow.locator('img').evaluate(async img => {
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL();
  });
  expect(preview).toBe(firstFrame);
  await button(picker, 'Close').click();
  await button(page, 'Play').click();
  await progress(page, 1);
  await pause(page);
  await save(page);
  const overwrittenFrame = await canvasImage(page);
  expect(overwrittenFrame).not.toBe(firstFrame);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  await expect(firstRow.locator('time')).not.toHaveAttribute('datetime', firstTime);
  const exported = await exportFrom(page, firstRow.getByRole('button', { name: /^Export state/ }), '.nesstate');
  await button(picker, 'New state').click();
  await expect(button(page, 'Load state')).toBeDisabled();

  await button(page, 'Play').click();
  await progress(page, 2);
  await pause(page);
  await save(page);
  const secondFrame = await canvasImage(page);
  const paused = await page.evaluate(() => window.frames);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(2);
  await states(page).last().getByRole('button', { name: /^Select state/ }).click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await page.evaluate(() => window.frames)).toBe(paused);
  expect(await canvasImage(page)).toBe(secondFrame);
  expect(await ram(page, 0x6000)).toBe(2);
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText('State loaded.');
  expect(await ram(page, 0x6000)).toBe(1);
  expect(await canvasImage(page)).toBe(overwrittenFrame);
  await expect(button(page, 'Play')).toBeEnabled();

  picker = await browse(page);
  await page.locator('#state-file').dispatchEvent('cancel');
  await expect(states(page)).toHaveCount(2);
  const bad = Buffer.from(exported.buffer);
  bad[100] ^= 1;
  await page.locator('#state-file').setInputFiles({ ...exported, buffer: bad });
  await expect(page.locator('#state-message')).toHaveText(/integrity check/);
  await expect(states(page)).toHaveCount(2);
  await page.locator('#state-file').setInputFiles(exported);
  await expect(page.locator('#state-message')).toHaveText(/State imported/);
  await expect(states(page)).toHaveCount(3);
  await expect(states(page).last().locator('[aria-current=true]')).toBeVisible();
  expect(await canvasImage(page)).toBe(overwrittenFrame);

  await states(page).first().getByRole('button', { name: /^Remove state/ }).click();
  await button(page.getByRole('dialog', { name: 'Confirm removal' }), 'Cancel').click();
  await expect(states(page)).toHaveCount(3);
  await states(page).first().getByRole('button', { name: /^Remove state/ }).click();
  await acceptRemoval(page, /Remove the state saved/);
  await expect(states(page)).toHaveCount(2);
  await expect(states(page).last().locator('[aria-current=true]')).toBeVisible();
  await states(page).last().getByRole('button', { name: /^Remove state/ }).click();
  await acceptRemoval(page, /Remove the state saved/);
  await expect(states(page)).toHaveCount(1);
  await expect(button(picker, 'New state')).toHaveAttribute('aria-current', 'true');
  await button(picker, 'Close').click();
  await expect(target(page)).toHaveText('New state');

  await page.reload();
  await expect(button(page, 'Open game')).toBeEnabled();
  await button(page, 'Open game').click();
  await button(page, 'volatile.nes').click();
  await expect(page.locator('#inserted')).toHaveText('volatile.nes');
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  await states(page).first().getByRole('button', { name: /^Select state/ }).click();
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText('State loaded.');
  const afterLoad = await page.evaluate(() => window.frames);
  await expect.poll(() => page.evaluate(() => window.frames)).toBeGreaterThan(afterLoad);
  await expect(button(page, 'Pause')).toBeEnabled();

  await button(page, 'Change game').click();
  await button(page, 'Remove volatile.nes').click();
  await expect(page.locator('#library-status')).toHaveText(/Removed/);
  await page.keyboard.press('Escape');
  await insert(page, 'same-media.nes', media);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  expect(requests.every(({ url, method, body }) => method === 'GET' && body === null &&
    /^\/nes-rust-neo\/(?:[\w-]+\.(?:js|css|wasm))?$/.test(new URL(url).pathname))).toBe(true);
  expect(errors).toEqual([]);
});

test('battery states roll back Save 1 in place, preserve existing profiles and abort failed writes', async ({ page }) => {
  const media = await readFile(diagnostic);
  const id = createHash('sha256').update(media).digest('hex');
  const baseKey = 'nes-rust-neo/battery-v1/' + id;
  const catalogKey = 'nes-rust-neo/profiles-v1/' + id;
  const recovery = { id: '4bc1876e-3426-4a9f-935d-c3bcf574a221', name: 'Recovery · Current progress · 1/1/2026' };
  const catalog = {
    selected: 'save-1', next: 2, profiles: [{ id: 'save-1', name: 'Save 1' }, recovery],
  };
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, data) {
      if (key === window.failedSramKey) {
        throw new DOMException('Injected SRAM write failure', 'QuotaExceededError');
      }
      return write.call(this, key, data);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (window.failedSnapshot && this.name === 'snapshots') {
        throw new DOMException('Injected snapshot write failure', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  await ready(page);
  const legacy = Buffer.alloc(8192);
  legacy[0] = 3;
  const recovered = Buffer.from(legacy);
  recovered[0] = 5;
  await page.evaluate(entries => {
    for (const [key, value] of entries) localStorage.setItem(key, value);
  }, [
    [baseKey, legacy.toString('base64')],
    [baseKey + ':' + recovery.id, recovered.toString('base64')],
    [catalogKey, JSON.stringify(catalog)],
  ]);
  await insert(page, 'battery.nes', media);
  await pause(page);
  let profiles = await nativeProfiles(page, 'Save 1');
  await button(profiles, recovery.name).click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(5);
  await save(page);
  profiles = await nativeProfiles(page, recovery.name);
  await button(profiles, 'Save 1').click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(3);
  await button(page, 'Play').click();
  await expect.poll(() => ram(page, 0)).toBe(0xa5);
  await pause(page);
  const originalFrame = await canvasImage(page);
  await save(page);
  let picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  const originalTime = await states(page).first().locator('time').getAttribute('datetime');
  await button(picker, 'Close').click();

  await button(page, 'Play').click();
  await progress(page, 4);
  await pause(page);
  const storedByte = () => page.evaluate(key => atob(localStorage.getItem(key)).charCodeAt(0), baseKey);
  await expect.poll(storedByte).toBe(4);
  // Advance the live SRAM without running the browser's autosave loop.
  await page.evaluate(() => {
    window.machine.run_frame(1, 0);
    window.machine.run_frame(1, 0);
  });
  expect(await ram(page, 0x6000)).toBe(5);
  const newerFrame = await canvasImage(page);
  expect(newerFrame).not.toBe(originalFrame);
  await page.evaluate(key => {
    window.failedSnapshot = true;
    window.failedSramKey = key;
  }, baseKey);
  await button(page, 'Save state').click();
  await expect(page.locator('#status')).toHaveText(/Could not save the state.*Injected snapshot write failure/);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  await expect(states(page).first().locator('time')).toHaveAttribute('datetime', originalTime);
  await button(picker, 'Close').click();

  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText(/Could not load the state.*Browser storage is full/);
  expect(await ram(page, 0x6000)).toBe(5);
  expect(await canvasImage(page)).toBe(newerFrame);
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await storedByte()).toBe(4);
  await page.evaluate(() => {
    delete window.failedSramKey;
    delete window.failedSnapshot;
  });
  for (const repeat of [false, true]) {
    if (repeat) {
      await button(page, 'Play').click();
      await progress(page, 4);
      await pause(page);
      await expect.poll(storedByte).toBe(4);
    }
    await button(page, 'Load state').click();
    await expect(page.locator('#status')).toHaveText('State loaded.');
    await expect(button(page, 'Play')).toBeEnabled();
    await expect(page.locator('#active-save-name')).toHaveText('Save 1');
    expect(await ram(page, 0x6000)).toBe(3);
    expect(await storedByte()).toBe(3);
    expect(await canvasImage(page)).toBe(originalFrame);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), catalogKey)).toEqual(catalog);
  }

  profiles = await nativeProfiles(page, 'Save 1');
  await expect(profiles.locator('#save-profiles li')).toHaveCount(2);
  await expect(button(profiles, 'Save 1')).toHaveAttribute('aria-current', 'true');
  await button(profiles, 'Remove Save 1').click();
  await expect(page.locator('#save-data-message')).toHaveText(/Remove the saved states for Save 1/);
  await button(profiles, recovery.name).click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(5);
  await button(page, 'Reset').click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(5);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  await states(page).first().getByRole('button', { name: /^Select state/ }).click();
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText('State loaded.');
  expect(await ram(page, 0x6000)).toBe(5);
  picker = await browse(page);
  await states(page).first().getByRole('button', { name: /^Remove state/ }).click();
  await acceptRemoval(page, /Remove the state saved/);
  await expect(states(page)).toHaveCount(0);
  await button(picker, 'Close').click();

  profiles = await nativeProfiles(page, recovery.name);
  await button(profiles, 'Duplicate current').click();
  profiles = await nativeProfiles(page, 'Save 2');
  await button(profiles, 'Remove ' + recovery.name).click();
  await acceptRemoval(page, /Remove Recovery/);
  await expect(button(profiles, recovery.name)).toHaveCount(0);
  const sram = await exportFrom(page, button(profiles, 'Export current save data'), '.srm');
  expect(sram.buffer.length).toBe(8192);
  expect(sram.buffer[0]).toBe(5);
  await page.evaluate(() => {
    const core = window.machine;
    for (let i = 0; i < 60 && core.debug_peek_ram(0) !== 0xa5; i++) core.run_frame(0, 0);
  });
  expect(await ram(page, 0)).toBe(0xa5);
  await page.locator('#save-data-file').setInputFiles({ ...sram, buffer: Buffer.alloc(1) });
  await expect(page.locator('#save-data-message')).toHaveText(/8192-byte SRAM file from this ROM/);
  sram.buffer[0] = 7;
  await page.locator('#save-data-file').setInputFiles(sram);
  await expect(page.locator('#save-data-message')).toHaveText(/Imported as Save 3/);
  await expect(button(profiles, 'Save 2')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#active-save-name')).toHaveText('Save 2');
  await expect(page.locator('#play')).toHaveText('Play');
  expect(await ram(page, 0)).toBe(0xa5);
  expect(await ram(page, 0x6000)).toBe(5);
  await button(profiles, 'Save 3').click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0)).toBe(0);
  expect(await ram(page, 0x6000)).toBe(7);
  profiles = await nativeProfiles(page, 'Save 3');
  await button(profiles, 'New save').click();
  profiles = await nativeProfiles(page, 'Save 4');
  expect(await ram(page, 0x6000)).toBe(0);
  await button(profiles, 'Remove Save 4').click();
  await acceptRemoval(page, /Remove Save 4 and its game save data/);
  await expect(page.locator('#save-data-message')).toHaveText('Removed Save 4.');
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');
  await button(profiles, 'Close').click();
  await expect(button(page, 'Load state')).toBeEnabled();
  await page.reload();
  await expect(button(page, 'Open game')).toBeEnabled();
  await button(page, 'Open game').click();
  await button(page, 'battery.nes').click();
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');
  expect(await ram(page, 0x6000)).toBe(3);
});

test.describe('touch fullscreen saves', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 640 } });

  test('shared NES history, profile management and focus survive fullscreen and picker dismissal', async ({ page }, testInfo) => {
    await ready(page);
    await insert(page, 'battery.nes', await readFile(diagnostic));
    const choose = page.locator('#choose-state');
    const openProfiles = page.locator('#save-data');
    const fullscreen = page.locator('#game-presentation:fullscreen');
    const status = page.locator('#status');
    await save(page);
    await progress(page, 1);
    await pause(page);
    const frameAtPause = await page.evaluate(() => window.frames);
    await page.evaluate(() => {
      window.normalChooser = document.querySelector('#choose-state');
      window.normalProfiles = document.querySelector('#save-data');
    });
    await button(page, 'Fullscreen').press('Enter');
    await expect(fullscreen.locator('#choose-state')).toBeVisible();
    expect(await choose.evaluate(node => node === window.normalChooser)).toBe(true);
    expect(await openProfiles.evaluate(node => node === window.normalProfiles)).toBe(true);
    await expect(button(page, 'Load state')).toBeEnabled();
    await save(page); // Overwrite the selected state with SRAM at 1.
    const overwritten = await canvasImage(page);

    await choose.press('Enter');
    const picker = statePicker(page);
    const newState = button(picker, 'New state');
    await expect(newState).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(button(picker, 'Close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(choose).toBeFocused();
    await expect(fullscreen).toBeVisible();

    await browse(page);
    await expect(states(page)).toHaveCount(1);
    await newState.tap();
    await expect(choose).toBeFocused();
    await expect(button(page, 'Load state')).toBeDisabled();
    await page.evaluate(() => {
      window.machine.run_frame(1, 0);
      window.machine.run_frame(1, 0);
    });
    expect(await ram(page, 0x6000)).toBe(2);
    await save(page);

    await browse(page);
    await expect(states(page)).toHaveCount(2);
    const importedState = await exportFrom(page, states(page).first().getByRole('button', { name: /^Export state/ }), '.nesstate');
    const importState = button(picker, 'Import state');
    let file = page.waitForEvent('filechooser');
    await importState.tap();
    await file;
    // Intercepted OS picker does not have a dismiss command in Chromium automation.
    await page.locator('#state-file').dispatchEvent('cancel');
    await expect(importState).toBeFocused();
    await expect(states(page)).toHaveCount(2);
    await expect(fullscreen).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('nes-portrait-fullscreen-history.png') });
    file = page.waitForEvent('filechooser');
    await importState.tap();
    await (await file).setFiles(importedState);
    await expect(page.locator('#state-message')).toHaveText(/State imported/);
    await expect(importState).toBeFocused();
    await expect(states(page)).toHaveCount(3);

    const remove = states(page).first().getByRole('button', { name: /^Remove state/ });
    await remove.tap();
    const confirmation = page.getByRole('dialog', { name: 'Confirm removal' });
    await expect(button(confirmation, 'Cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(remove).toBeFocused();
    await expect(states(page)).toHaveCount(3);
    await remove.tap();
    await acceptRemoval(page, /Remove the state saved/);
    await expect(states(page)).toHaveCount(2);
    await states(page).last().getByRole('button', { name: /^Select state/ }).tap();
    await expect(choose).toBeFocused();
    await button(page, 'Load state').tap();
    await expect(status).toHaveText('State loaded.');
    expect(await ram(page, 0x6000)).toBe(1);
    expect(await canvasImage(page)).toBe(overwritten);
    const selectedState = await target(page).getAttribute('title');

    let profiles = await nativeProfiles(page, 'Save 1');
    await expect(button(profiles, 'Close')).toBeFocused();
    await button(profiles, 'Remove Save 1').tap();
    await expect(page.locator('#save-data-message')).toHaveText(/Remove the saved states/);
    await button(profiles, 'Duplicate current').tap();
    await expect(openProfiles).toBeFocused();
    profiles = await nativeProfiles(page, 'Save 2');
    const native = await exportFrom(page, button(profiles, 'Export current save data'), '.srm');
    expect(native.buffer[0]).toBe(1);
    await button(profiles, 'New save').tap();
    profiles = await nativeProfiles(page, 'Save 3');
    expect(await ram(page, 0x6000)).toBe(0);
    file = page.waitForEvent('filechooser');
    await button(profiles, 'Import save data').tap();
    await (await file).setFiles(native);
    await expect(page.locator('#save-data-message')).toHaveText(/Imported as Save 4/);
    await button(profiles, 'Remove Save 3').tap();
    await acceptRemoval(page, /Remove Save 3 and its game save data/);
    await expect(page.locator('#save-data-message')).toHaveText('Removed Save 3.');
    await button(profiles, 'Save 1').tap();
    await expect(openProfiles).toBeFocused();
    await expect(target(page)).toHaveAttribute('title', selectedState);
    await expect(fullscreen).toBeVisible();

    await browse(page);
    await expect(newState).toBeFocused();
    // Model fullscreen dismissal by the browser while a modal is open.
    await page.evaluate(() => document.exitFullscreen());
    await expect(fullscreen).toHaveCount(0);
    await expect(newState).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(choose).toBeFocused();
    await expect(target(page)).toHaveAttribute('title', selectedState);
    await expect(page.locator('#active-save-name')).toHaveText('Save 1');
    await expect(button(page, 'Play')).toBeEnabled();
    expect(await page.evaluate(() => window.frames)).toBe(frameAtPause);
  });
});
