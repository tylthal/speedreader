import { test } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:5174';
const SHOTS = path.join(__dirname, '..', 'qa-screenshots');

test('quick controls check', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  // Upload and go to reader
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path.join(__dirname, 'test-data', 'sample.txt'));
  await page.waitForURL('**/read/**', { timeout: 15000 });
  await page.waitForTimeout(2000);

  // Screenshot controls (paused state)
  await page.screenshot({ path: path.join(SHOTS, 'qq-01-controls-paused.png') });

  // Check the computed styles of controls
  const controlsStyle = await page.evaluate(() => {
    const controls = document.querySelector('.controls');
    if (!controls) return 'No .controls found';
    const cs = getComputedStyle(controls);
    return {
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      cssVarControlsBg: getComputedStyle(document.documentElement).getPropertyValue('--controls-bg'),
      cssVarBgSurface: getComputedStyle(document.documentElement).getPropertyValue('--bg-surface'),
      cssVarText: getComputedStyle(document.documentElement).getPropertyValue('--text'),
      cssVarOverlayBg: getComputedStyle(document.documentElement).getPropertyValue('--overlay-bg'),
      theme: document.documentElement.getAttribute('data-theme'),
    };
  });
  console.log('Controls computed styles:', JSON.stringify(controlsStyle, null, 2));

  // Open mode dropdown
  const modeBtn = page.locator('button[aria-label*="Reading mode"]').first();
  if (await modeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await modeBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'qq-02-mode-dropdown.png') });

    // Check mode list item styles
    const itemStyles = await page.evaluate(() => {
      const items = document.querySelectorAll('.controls__mode-list-item');
      return Array.from(items).map(item => {
        const cs = getComputedStyle(item);
        return {
          text: item.textContent,
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          fontSize: cs.fontSize,
          display: cs.display,
          visibility: cs.visibility,
          opacity: cs.opacity,
        };
      });
    });
    console.log('Mode list items:', JSON.stringify(itemStyles, null, 2));
  }

  await context.close();
});
