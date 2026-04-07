import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:5174';
const SHOTS = path.join(__dirname, '..', 'qa-screenshots');

test.describe('QA Walkthrough - Full App (Mobile)', () => {
  test.setTimeout(180_000);

  test('complete app walkthrough', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    // Capture console errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    const nav = (label: string) => page.locator(`button[aria-label="${label}"]`);
    const shot = (name: string) => page.screenshot({ path: path.join(SHOTS, `qa-${name}.png`) });

    // ─── 1. LIBRARY (EMPTY STATE) ───
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800);
    await shot('01-library-empty');

    // ─── 2. SETTINGS PAGE ───
    await nav('Settings').click();
    await page.waitForTimeout(500);
    await shot('02-settings');

    // ─── 3. THEME CYCLING ───
    for (const theme of ['Light', 'Dark', 'Evening', 'Bedtime', 'Forest', 'Ocean']) {
      const btn = page.locator('button').filter({ hasText: new RegExp(`^${theme}$`, 'i') }).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(400);
        await shot(`03-theme-${theme.toLowerCase()}`);
      }
    }

    // Set light theme for visibility
    const lightBtn = page.locator('button').filter({ hasText: /^Light$/i }).first();
    if (await lightBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await lightBtn.click();
      await page.waitForTimeout(300);
    }

    // ─── 4. ARCHIVE PAGE (EMPTY) ───
    await nav('Archive').click();
    await page.waitForTimeout(500);
    await shot('04-archive-empty');

    // ─── 5. UPLOAD TXT FILE ───
    await nav('Library').click();
    await page.waitForTimeout(500);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(path.join(__dirname, 'test-data', 'sample.txt'));

    // Wait for reader to load
    await page.waitForURL('**/read/**', { timeout: 15000 });
    await page.waitForTimeout(2000);
    await shot('05-reader-txt-paused');

    // ─── 6. READER CONTROLS ───
    // Controls are visible when paused
    await shot('06-reader-controls');

    // Play
    const playBar = page.locator('.controls__play-bar').first();
    if (await playBar.isVisible({ timeout: 2000 }).catch(() => false)) {
      await playBar.click();
      await page.waitForTimeout(2000);
      await shot('07-reader-playing');

      // Pause (tap center)
      await page.mouse.click(195, 400);
      await page.waitForTimeout(500);
      await shot('08-reader-paused');
    }

    // ─── 7. MODE SELECTOR ───
    const modeBtn = page.locator('.controls__mode-btn, button[aria-label*="mode" i]').first();
    if (await modeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await modeBtn.click();
      await page.waitForTimeout(500);
      await shot('09-mode-dropdown');
    } else {
      // Try finding mode button by text
      for (const modeName of ['Phrase', 'RSVP', 'Scroll']) {
        const btn = page.locator(`.controls__main-row button:has-text("${modeName}")`).first();
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(500);
          await shot('09-mode-dropdown');
          break;
        }
      }
    }

    // Switch to RSVP if available
    const rsvpItem = page.locator('.controls__mode-list-item:has-text("RSVP")').first();
    if (await rsvpItem.isVisible({ timeout: 1000 }).catch(() => false)) {
      await rsvpItem.click();
      await page.waitForTimeout(500);
      await shot('10-mode-rsvp');

      // Play RSVP
      if (await playBar.isVisible({ timeout: 1000 }).catch(() => false)) {
        await playBar.click();
        await page.waitForTimeout(2000);
        await shot('10b-rsvp-playing');
        await page.mouse.click(195, 400);
        await page.waitForTimeout(500);
      }
    }

    // Switch to Scroll mode
    // Need to reopen mode list
    const modeBtn2 = page.locator('button[aria-label*="Reading mode"]').first();
    if (await modeBtn2.isVisible({ timeout: 1000 }).catch(() => false)) {
      await modeBtn2.click();
      await page.waitForTimeout(500);
      const scrollItem = page.locator('.controls__mode-list-item:has-text("Scroll")').first();
      if (await scrollItem.isVisible({ timeout: 1000 }).catch(() => false)) {
        await scrollItem.click();
        await page.waitForTimeout(500);
        await shot('11-mode-scroll');

        if (await playBar.isVisible({ timeout: 1000 }).catch(() => false)) {
          await playBar.click();
          await page.waitForTimeout(2000);
          await shot('11b-scroll-playing');
          await page.mouse.click(195, 400);
          await page.waitForTimeout(500);
        }
      }
    }

    // ─── 8. BACK TO LIBRARY ───
    await page.goto(BASE);
    await page.waitForTimeout(1000);
    await shot('12-library-with-book');

    // ─── 9. UPLOAD EPUB ───
    const fileInput2 = page.locator('input[type="file"]');
    await fileInput2.setInputFiles(path.join(__dirname, 'test-data', 'alice-in-wonderland.epub'));
    await page.waitForTimeout(1000);
    await shot('13-epub-processing');

    // Wait for reader with generous timeout (EPUB parsing may be slow)
    try {
      await page.waitForURL('**/read/**', { timeout: 45000 });
      await page.waitForTimeout(2000);
      await shot('14-epub-reader');

      // Play EPUB
      if (await playBar.isVisible({ timeout: 2000 }).catch(() => false)) {
        await playBar.click();
        await page.waitForTimeout(3000);
        await shot('15-epub-playing');
        await page.mouse.click(195, 400);
        await page.waitForTimeout(500);
      }
    } catch {
      await shot('14-epub-error-or-timeout');
      console.log('EPUB parsing timed out. Console errors:', errors);
    }

    // ─── 10. FINAL LIBRARY STATE ───
    await page.goto(BASE);
    await page.waitForTimeout(1000);
    await shot('16-library-final');

    // ─── 11. LONG PRESS CONTEXT MENU ───
    const card = page.locator('.book-card').first();
    if (await card.isVisible({ timeout: 3000 }).catch(() => false)) {
      const box = await card.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(800);
        await page.mouse.up();
        await page.waitForTimeout(600);
        await shot('17-context-menu');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    // Log any console errors
    if (errors.length) {
      console.log('Console errors encountered:', errors.slice(0, 10));
    }

    await context.close();
  });
});
