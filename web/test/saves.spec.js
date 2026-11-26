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

function accept(page, prompt) {
  page.once('dialog', async dialog => {
    expect(dialog.message()).toMatch(prompt);
    await dialog.accept();
  });
}

async function exportFrom(page, control, extension) {
  const event = page.waitForEvent('download');
  await control.click();
  const download = await event;
  expect(download.suggestedFilename().endsWith(extension)).toBe(true);
  const bytes = await readFile(await download.path());
  return { name: download.suggestedFilename(), mimeType: 'application/octet-stream', buffer: bytes };
}

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

  page.once('dialog', dialog => dialog.dismiss());
  await states(page).first().getByRole('button', { name: /^Remove state/ }).click();
  await expect(states(page)).toHaveCount(3);
  accept(page, /Remove the state saved/);
  await states(page).first().getByRole('button', { name: /^Remove state/ }).click();
  await expect(states(page)).toHaveCount(2);
  await expect(states(page).last().locator('[aria-current=true]')).toBeVisible();
  accept(page, /Remove the state saved/);
  await states(page).last().getByRole('button', { name: /^Remove state/ }).click();
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

test('battery profiles adopt Save 1, retain displaced progress and abort failed writes', async ({ page }) => {
  const media = await readFile(diagnostic);
  const id = createHash('sha256').update(media).digest('hex');
  const baseKey = 'nes-rust-neo/battery-v1/' + id;
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, data) {
      if (window.failedRecovery && key.startsWith(window.failedRecovery + ':')) {
        throw new DOMException('Injected recovery write failure', 'QuotaExceededError');
      }
      if (window.failedCatalog && key.startsWith('nes-rust-neo/profiles-v1/')) {
        throw new DOMException('Injected profile catalog failure', 'QuotaExceededError');
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
  await page.evaluate(([key, bytes]) => localStorage.setItem(key, bytes), [baseKey, legacy.toString('base64')]);
  await insert(page, 'battery.nes', media);
  await pause(page);
  expect(await ram(page, 0x6000)).toBe(3);
  await expect(page.locator('#active-save-name')).toHaveText('Save 1');
  await save(page);
  let picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  const originalTime = await states(page).first().locator('time').getAttribute('datetime');
  await button(picker, 'Close').click();

  await button(page, 'Play').click();
  await progress(page, 4);
  await pause(page);
  const newerFrame = await canvasImage(page);
  await page.evaluate(key => { window.failedSnapshot = true; window.failedRecovery = key; }, baseKey);
  await button(page, 'Save state').click();
  await expect(page.locator('#status')).toHaveText(/Could not save the state.*Injected snapshot write failure/);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(1);
  await expect(states(page).first().locator('time')).toHaveAttribute('datetime', originalTime);
  await button(picker, 'Close').click();

  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText(/State load stopped.*Injected recovery write failure/);
  expect(await ram(page, 0x6000)).toBe(4);
  expect(await canvasImage(page)).toBe(newerFrame);
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await page.evaluate(key => atob(localStorage.getItem(key)).charCodeAt(0), baseKey)).toBe(4);

  await page.evaluate(() => {
    delete window.failedRecovery;
    delete window.failedSnapshot;
    window.failedCatalog = true;
  });
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText(/State load stopped.*Injected profile catalog failure/);
  expect(await ram(page, 0x6000)).toBe(4);
  expect(await page.evaluate(key => Object.keys(localStorage).filter(item => item.startsWith(key + ':')), baseKey)).toEqual([]);

  await page.evaluate(() => { delete window.failedCatalog; });
  await button(page, 'Load state').click();
  await expect(page.locator('#status')).toHaveText(/Previous progress.*recovery profile/);
  expect(await ram(page, 0x6000)).toBe(3);
  expect(await page.evaluate(key => atob(localStorage.getItem(key)).charCodeAt(0), baseKey)).toBe(3);

  let profiles = await nativeProfiles(page, 'Save 1');
  await button(profiles, 'Remove Save 1').click();
  await expect(page.locator('#save-data-message')).toHaveText(/Remove the saved states for Save 1/);
  const recovery = await profiles.getByRole('button', { name: /^Recovery ·/ }).textContent();
  await button(profiles, recovery).click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(4);
  await button(page, 'Reset').click();
  await expect(button(page, 'Play')).toBeEnabled();
  expect(await ram(page, 0x6000)).toBe(4);
  picker = await browse(page);
  await expect(states(page)).toHaveCount(0);
  await button(picker, 'Close').click();

  profiles = await nativeProfiles(page, recovery);
  await button(profiles, 'Duplicate current').click();
  profiles = await nativeProfiles(page, 'Save 2');
  const sram = await exportFrom(page, button(profiles, 'Export current save data'), '.srm');
  expect(sram.buffer.length).toBe(8192);
  expect(sram.buffer[0]).toBe(4);
  await page.locator('#save-data-file').setInputFiles({ ...sram, buffer: Buffer.alloc(1) });
  await expect(page.locator('#save-data-message')).toHaveText(/8192-byte SRAM file from this ROM/);
  await page.locator('#save-data-file').setInputFiles(sram);
  profiles = await nativeProfiles(page, 'Save 3');
  expect(await ram(page, 0x6000)).toBe(4);
  await button(profiles, 'New save').click();
  profiles = await nativeProfiles(page, 'Save 4');
  expect(await ram(page, 0x6000)).toBe(0);
  accept(page, /Remove Save 4 and its game save data/);
  await button(profiles, 'Remove Save 4').click();
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
