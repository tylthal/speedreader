import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 390, height: 844 }, // iPhone 14 size
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  webServer: [
    {
      command: 'uvicorn backend.main:app --host 0.0.0.0 --port 3000',
      port: 3000,
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev -- --host 0.0.0.0',
      port: 5173,
      reuseExistingServer: true,
    },
  ],
});
