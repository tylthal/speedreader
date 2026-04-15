import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@playwright/test';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.join(repoRoot, '.browser-libs', 'root');

export default defineConfig({
  testDir: './e2e',
  testMatch: 'diagnose-pip-detail.spec.ts',
  timeout: 60000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    launchOptions: {
      env: {
        ...process.env,
        LD_LIBRARY_PATH:
          process.env.LD_LIBRARY_PATH ||
          [
            path.join(browserRoot, 'usr/lib/x86_64-linux-gnu'),
            path.join(browserRoot, 'lib/x86_64-linux-gnu'),
            path.join(browserRoot, 'usr/lib'),
            path.join(browserRoot, 'lib'),
          ].join(':'),
        FONTCONFIG_PATH:
          process.env.FONTCONFIG_PATH || path.join(browserRoot, 'etc/fonts'),
        FONTCONFIG_FILE: process.env.FONTCONFIG_FILE || 'fonts.conf',
        XDG_DATA_DIRS:
          process.env.XDG_DATA_DIRS ||
          [
            path.join(browserRoot, 'usr/share'),
            path.join(browserRoot, 'usr/local/share'),
          ].join(':'),
      },
    },
  },
});
