import { defineConfig } from '@playwright/test';

const port = process.env.NES_WEB_PORT || 4173;
const baseURL = `http://127.0.0.1:${port}/nes-rust-neo/`;

export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  use: {
    baseURL, browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run serve',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
