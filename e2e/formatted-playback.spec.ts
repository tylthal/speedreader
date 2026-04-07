import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Smoke tests for the formatted-view auto-scroll feature (scroll/track
 * playback while in formatted display mode).
 *
 * These tests assume at least one publication is already in the library
 * — they skip otherwise. They also assume the publication has at least
 * one chapter with body HTML (i.e. an EPUB or text book, not a CBZ).
 *
 * Run with: npm run test:e2e -- formatted-playback.spec.ts
 */

async function gotoFirstBook(page: Page): Promise<boolean> {
  const response = await page.request.get('/api/v1/publications/');
  const pubs = await response.json();
  const text = pubs.find((p: any) => p.content_type !== 'image');
  if (!text) {
    test.skip();
    return false;
  }
  await page.goto(`/read/${text.id}`);
  await page.waitForSelector('.reader-viewport', { state: 'visible' });
  return true;
}

async function ensureFormattedView(page: Page): Promise<void> {
  // The display-mode toggle's aria-label includes the *current* mode, so
  // we click it only if we're not already in formatted view.
  const toggle = page.locator('[aria-label^="Display mode:"]');
  await expect(toggle).toBeVisible();
  const label = await toggle.getAttribute('aria-label');
  if (label && !label.includes('Formatted')) {
    await toggle.click();
  }
  await expect(page.locator('.formatted-view')).toBeVisible();
}

async function selectScrollMode(page: Page): Promise<void> {
  const modeBtn = page.locator('[aria-label^="Reading mode:"]');
  await expect(modeBtn).toBeVisible();
  const label = await modeBtn.getAttribute('aria-label');
  if (label && label.toLowerCase().includes('scroll')) return;
  await modeBtn.click();
  // Pick the Scroll option from the listbox
  await page.locator('[role="listbox"][aria-label="Select reading mode"] >> text=Scroll').click();
  // Wait for the dropdown to dismiss
  await expect(modeBtn).toContainText(/Scroll/);
}

test.describe('Formatted-view auto-scroll', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await gotoFirstBook(page);
    if (!ok) return;
    await ensureFormattedView(page);
    await selectScrollMode(page);
  });

  test('scroll mode auto-scrolls the formatted view container', async ({ page }) => {
    const initialScrollTop = await page.evaluate(() => {
      const el = document.querySelector('.formatted-view') as HTMLElement | null;
      return el?.scrollTop ?? -1;
    });
    expect(initialScrollTop).toBeGreaterThanOrEqual(0);

    await page.locator('[aria-label="Play reading"]').click();
    // Engine takes a beat to settle (decode-settle + first rAF). Allow a
    // generous window for the scroll to begin.
    await page.waitForTimeout(2000);

    const playingScrollTop = await page.evaluate(() => {
      const el = document.querySelector('.formatted-view') as HTMLElement | null;
      return el?.scrollTop ?? -1;
    });

    // Should have advanced — we don't assert a specific delta because
    // velocity depends on profile + wpm + content, but ANY forward
    // motion proves the engine wired up correctly.
    expect(playingScrollTop).toBeGreaterThan(initialScrollTop);
  });

  test('pause stops the scroll within ~200ms', async ({ page }) => {
    await page.locator('[aria-label="Play reading"]').click();
    await page.waitForTimeout(1500);
    await page.locator('[aria-label="Pause reading"]').click();

    const t1 = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    );
    await page.waitForTimeout(250);
    const t2 = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    );

    // Allow a tiny tail (sub-pixel anti-aliasing, browser scroll snap, etc.)
    expect(Math.abs(t2 - t1)).toBeLessThan(2);
  });

  test('tapping the formatted view pauses playback', async ({ page }) => {
    await page.locator('[aria-label="Play reading"]').click();
    await page.waitForTimeout(1000);

    // Tap (not drag) inside the formatted view. useContentTap should fire
    // and call togglePlayPause.
    const view = page.locator('.formatted-view');
    const box = await view.boundingBox();
    if (!box) throw new Error('formatted-view has no bounding box');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

    // Pause button should now show
    await expect(page.locator('[aria-label="Play reading"]')).toBeVisible({ timeout: 1500 });
  });
});

test.describe('Velocity profile debug overlay', () => {
  test('overlay activates with ?debugProfile=1', async ({ page }) => {
    const response = await page.request.get('/api/v1/publications/');
    const pubs = await response.json();
    const text = pubs.find((p: any) => p.content_type !== 'image');
    if (!text) {
      test.skip();
      return;
    }
    await page.goto(`/read/${text.id}?debugProfile=1`);
    await page.waitForSelector('.reader-viewport', { state: 'visible' });
    await ensureFormattedView(page);
    // The stats panel is rendered into the body and is always present
    // when the flag is set.
    await expect(page.locator('text=velocity profile (debug)')).toBeVisible();
  });
});
