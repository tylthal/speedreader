import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from '@playwright/test';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.join(repoRoot, '.browser-libs', 'root');

export default defineConfig({
  testDir: './e2e',
  testMatch: [/app-smoke\.spec\.ts$/, /bookmark-reader\.spec\.ts$/, /centering-check\.spec\.ts$/, /bookmark-scroll-playback\.spec\.ts$/],
  testIgnore: ['api.spec.ts', 'library.spec.ts', 'reader.spec.ts', 'diagnose-images.spec.ts', 'qa-quick.spec.ts', 'qa-walkthrough.spec.ts'],
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: true,
  },
});
