import { test, expect } from '@playwright/test';

test.describe('Reader', () => {
  test.beforeEach(async ({ page }) => {
    // Check if any publications exist via API
    const response = await page.request.get('/api/v1/publications/');
    const pubs = await response.json();

    if (pubs.length === 0) {
      test.skip();
      return;
    }

    // Navigate to first book
    await page.goto(`/read/${pubs[0].id}`);
  });

  test('should load the reader viewport', async ({ page }) => {
    await expect(page.locator('.reader-viewport')).toBeVisible();
  });

  test('should display reading controls', async ({ page }) => {
    await expect(page.locator('[role="toolbar"]')).toBeVisible();
    await expect(page.locator('[aria-label="Play reading"], [aria-label="Pause reading"]')).toBeVisible();
  });

  test('should show WPM controls', async ({ page }) => {
    // WPM display should be visible
    await expect(page.locator('[aria-label="Decrease reading speed"]')).toBeVisible();
    await expect(page.locator('[aria-label="Increase reading speed"]')).toBeVisible();
  });

  test('should toggle play/pause', async ({ page }) => {
    const playBtn = page.locator('[aria-label="Play reading"]');
    await expect(playBtn).toBeVisible();
    await playBtn.click();

    // Should now show pause
    await expect(page.locator('[aria-label="Pause reading"]')).toBeVisible();

    // Click again to pause
    await page.locator('[aria-label="Pause reading"]').click();
    await expect(page.locator('[aria-label="Play reading"]')).toBeVisible();
  });

  test('should adjust WPM', async ({ page }) => {
    const increaseBtn = page.locator('[aria-label="Increase reading speed"]');

    // Get initial WPM text
    const wpmBefore = await page.locator('[aria-live="polite"]').textContent();

    await increaseBtn.click();

    // WPM should have changed
    const wpmAfter = await page.locator('[aria-live="polite"]').textContent();
    expect(wpmAfter).not.toBe(wpmBefore);
  });

  test('should show focus chunk overlay', async ({ page }) => {
    await expect(page.locator('.focus-overlay')).toBeVisible();
  });

  test('should show transcript pane', async ({ page }) => {
    await expect(page.locator('[role="list"][aria-label="Reading transcript"]')).toBeVisible();
  });
});
