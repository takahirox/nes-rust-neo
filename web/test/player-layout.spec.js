import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = name => fileURLToPath(new URL(`../../tests/generated/${name}`, import.meta.url));
const geometries = [
  { name: 'portrait', viewport: { width: 320, height: 640 } },
  { name: 'landscape', viewport: { width: 667, height: 375 } },
  { name: 'short portrait', viewport: { width: 320, height: 568 } },
  { name: 'short landscape', viewport: { width: 568, height: 320 } },
];
const controls = [
  'canvas', '.picture', '#dpad', '#choose-state', '#save-state', '#load-state', '#save-data',
  '#play', '#reset', '#fullscreen', '#exit-fullscreen', '#mute', '#volume', '#scale', '#display',
  '#change-cartridge', '#disk-side', '#disk-toggle',
  ...[1, 2, 4, 8, 16, 32, 64, 128].map(mask => `[data-pad="${mask}"]`),
];

function layout(page) {
  return page.evaluate(selectors => {
    const targets = {};
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element.closest('[inert]')) continue;
      const { x, y, width, height } = element.getBoundingClientRect();
      if (!width || !height) continue;
      const hit = document.elementFromPoint(x + width / 2, y + height / 2);
      targets[selector] = {
        rect: [x, y, width, height],
        receivesTouch: element.contains(hit),
        fits: x >= -1 && y >= -1 && x + width <= innerWidth + 1 && y + height <= innerHeight + 1,
      };
    }
    const status = document.querySelector('#status');
    const text = document.createRange();
    text.selectNodeContents(status);
    const notice = status.textContent ? text.getBoundingClientRect().toJSON() : null;
    return {
      targets, scroll: [scrollX, scrollY], notice,
      statusFits: !notice || (notice.width > 0 && notice.height > 0 && status.scrollHeight <= status.clientHeight &&
        notice.left >= 0 && notice.right <= innerWidth && notice.top >= 0 && notice.bottom <= innerHeight),
    };
  }, controls);
}

function sameLayout(before, during) {
  expect(during.scroll).toEqual(before.scroll);
  expect(during.statusFits, `Notice text bounds: ${JSON.stringify(during.notice)}`).toBe(true);
  expect(Object.keys(during.targets)).toEqual(Object.keys(before.targets));
  for (const [selector, { rect, receivesTouch, fits }] of Object.entries(during.targets)) {
    const delta = rect.map((value, index) => Math.abs(value - before.targets[selector].rect[index]));
    expect(Math.max(...delta), `${selector} x/y/width/height changes: ${delta}`).toBeLessThanOrEqual(1);
    // The center of the D-pad is intentionally blank and is hit by the group itself.
    expect(receivesTouch, selector).toBe(true);
    expect(fits, selector).toBe(true);
  }
}

async function openGame(page, disk) {
  await page.addInitScript(() => {
    const instantiate = WebAssembly.instantiate;
    WebAssembly.instantiate = async (...args) => {
      const result = await instantiate(...args);
      window.machine = result.instance.exports;
      return result;
    };
  });
  await page.goto('./');
  await expect(page.locator('#change-cartridge')).toBeEnabled();
  if (disk) await page.locator('#bios').setInputFiles(fixture('fds-bios.rom'));
  await page.locator('#rom').setInputFiles(fixture(disk ? 'fds-relay.fds' : 'diagnostic.nes'));
  await page.waitForFunction(([address, value]) => window.machine.debug_peek_ram(address) === value,
    disk ? [0x10, 1] : [0, 0xa5]);
}

for (const { name, viewport } of geometries) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });

    for (const media of ['NES', 'FDS']) {
      test(`${media} save feedback keeps the picture and every touch target stationary`, async ({ page, context }, testInfo) => {
        await page.addInitScript(() => {
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (...args) {
            if (window.failSnapshot && this.name === 'snapshots') throw new Error('Injected storage failure.');
            return put.apply(this, args);
          };
        });
        const disk = media === 'FDS';
        await openGame(page, disk);
        const status = page.locator('#status');
        const save = page.locator('#save-state');
        const load = page.locator('#load-state');
        const pad = page.locator(disk ? '[data-pad="2"]' : '[data-pad="1"]');
        const client = await context.newCDPSession(page);

        async function pressAndReleasePad() {
          const { x, y, width, height } = await pad.boundingBox();
          await client.send('Input.dispatchTouchEvent', {
            type: 'touchStart', touchPoints: [{ x: x + width / 2, y: y + height / 2 }],
          });
          await expect(pad).toHaveAttribute('data-active', '');
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await expect(pad).not.toHaveAttribute('data-active', '');
        }

        async function writeDiskProgress() {
          const [position, destination, deliveries] = await page.evaluate(() =>
            [0x11, 0x18, 0x13].map(address => window.machine.debug_peek_ram(address)));
          await page.locator('canvas').focus();
          if (Math.abs(destination - position) > 2) {
            const key = position < destination ? 'ArrowRight' : 'ArrowLeft';
            await page.keyboard.down(key);
            await page.waitForFunction(([destination, movingRight]) => {
              const position = window.machine.debug_peek_ram(0x11);
              return movingRight ? position >= destination - 2 : position <= destination + 2;
            }, [destination, position < destination]);
            await page.keyboard.up(key);
          }
          await page.keyboard.down('x');
          await page.waitForFunction(deliveries => window.machine.debug_peek_ram(0x13) === deliveries + 1, deliveries);
          await page.keyboard.up('x');
        }

        for (const mode of ['normal', 'fullscreen']) {
          if (mode === 'fullscreen') {
            await page.locator('#fullscreen').tap();
            await expect(page.locator(':fullscreen #save-state')).toBeVisible();
          }
          const before = await layout(page);
          expect(before.scroll).toEqual([0, 0]);
          expect(before.targets['[data-pad="16"]']).toBeDefined();
          await save.tap();
          await expect(status).toHaveText('State saved.');
          sameLayout(before, await layout(page));
          await pressAndReleasePad();
          await page.screenshot({ path: testInfo.outputPath(`${media.toLowerCase()}-${name.replaceAll(' ', '-')}-${mode}.png`) });

          if (disk) await writeDiskProgress();
          await expect(status).toBeEmpty();
          sameLayout(before, await layout(page));
          await load.tap();
          await expect(status).toHaveText(/Previous progress.*recovery profile/);
          sameLayout(before, await layout(page));
          await load.tap();
          await expect(status).toHaveText('State loaded.');
          sameLayout(before, await layout(page));

          await page.evaluate(() => { window.failSnapshot = true; });
          await save.tap();
          await expect(status).toHaveText(/Could not save the state.*Injected storage failure/);
          sameLayout(before, await layout(page));
          await page.evaluate(() => { window.failSnapshot = false; });
          await save.tap();
          await expect(status).toHaveText('State saved.');
          await expect(status).toBeEmpty();
          sameLayout(before, await layout(page));
        }
      });
    }
  });
}

test.describe('short landscape drive status', () => {
  test.use({ viewport: { width: 568, height: 320 }, hasTouch: true, isMobile: true });

  test('loading an inserted FDS side keeps fullscreen video and controls stationary', async ({ page }) => {
    await openGame(page, true);
    const play = page.locator('#play');
    const diskStatus = page.locator('#disk-status');
    const side = page.locator('#disk-side');
    const status = page.locator('#status');
    await play.tap();
    await expect(play).toHaveText('Play');
    await page.locator('#fullscreen').tap();
    await expect(diskStatus).toHaveText('Inserted');
    await page.locator(':fullscreen #save-state').tap();
    await expect(status).toHaveText('State saved.');

    await side.selectOption('1');
    await expect(diskStatus).toHaveText('Changing side…');
    const changingSide = await layout(page);
    await page.locator(':fullscreen #load-state').tap();
    await expect(status).toHaveText('State loaded.');
    await expect(diskStatus).toHaveText('Inserted');
    await expect(side).toHaveValue('0');
    await expect(play).toHaveText('Play');
    sameLayout(changingSide, await layout(page));
  });
});

test.describe('short portrait storage quota', () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });

  for (const mode of ['normal', 'fullscreen']) {
    test(`a full browser storage error fits and keeps the current game in ${mode}`, async ({ page }) => {
      await openGame(page, false);
      const play = page.locator('#play');
      const status = page.locator('#status');
      const load = page.locator('#load-state');
      const canvasImage = () => page.locator('canvas').evaluate(canvas => canvas.toDataURL());
      const sram = () => page.evaluate(() => window.machine.debug_peek_ram(0x6000));
      const storedSram = () => page.evaluate(() => {
        const key = Object.keys(localStorage).find(key => key.startsWith('nes-rust-neo/battery-v1/'));
        return key ? atob(localStorage.getItem(key)).charCodeAt(0) : null;
      });
      await expect.poll(sram).toBe(0);
      await page.locator('#save-state').tap();
      await expect(status).toHaveText('State saved.');
      await page.locator('canvas').focus();
      await page.keyboard.down('x');
      await expect.poll(sram).toBe(1);
      await page.keyboard.up('x');
      await play.tap();
      await expect(play).toHaveText('Play');
      await expect.poll(storedSram).toBe(1);
      const currentFrame = await canvasImage();

      await page.evaluate(() => {
        let filler = '';
        for (let size = 1024 * 1024; size >= 1024;) {
          try {
            const next = filler + 'x'.repeat(size);
            localStorage.setItem('quota-test-fill', next);
            filler = next;
          } catch (error) {
            if (error.name !== 'QuotaExceededError') throw error;
            size /= 2;
          }
        }
      });

      if (mode === 'fullscreen') {
        await page.locator('#fullscreen').tap();
        await expect(page.locator(':fullscreen #load-state')).toBeVisible();
      }
      const before = await layout(page);
      expect(before.scroll).toEqual([0, 0]);
      await load.tap();
      await expect(status).toHaveText(/Could not load the state/);
      sameLayout(before, await layout(page));
      await expect(status).toHaveText('Could not load the state. Browser storage is full. Free up space and retry.');
      expect(await sram()).toBe(1);
      expect(await storedSram()).toBe(1);
      expect(await canvasImage()).toBe(currentFrame);
      await expect(play).toHaveText('Play');

      await page.evaluate(() => localStorage.removeItem('quota-test-fill'));
      await load.tap();
      await expect(status).toHaveText(/Previous progress.*recovery profile/);
      expect(await sram()).toBe(0);
      await expect(play).toHaveText('Play');
    });
  }
});
