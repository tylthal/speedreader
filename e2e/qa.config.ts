import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'qa-walkthrough.spec.ts',
  timeout: 120000,
  use: {
    baseURL: 'http://localhost:5174',
    launchOptions: {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: '/tmp/syslibs/usr/lib/x86_64-linux-gnu:/tmp/syslibs/lib/x86_64-linux-gnu',
      },
    },
  },
  webServer: {
    command: 'npm run dev -- --host 0.0.0.0',
    port: 5174,
    reuseExistingServer: true,
  },
});
