import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  use: {
    baseURL: process.env.MUXPLORER_URL ?? 'http://127.0.0.1:8098',
    viewport: { width: 1512, height: 982 },
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
  workers: 1,
});
