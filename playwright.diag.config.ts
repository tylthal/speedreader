import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'diagnose-images.spec.ts',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1024, height: 768 },
  },
  // Vite is already running externally; no webServer block.
});
