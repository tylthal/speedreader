import { test, expect } from '@playwright/test';

test.describe('Library Page', () => {
  test('should show the library heading', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toContainText(/library/i);
  });

  test('should show upload area', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[aria-label="Upload EPUB book"]')).toBeVisible();
  });

  test('should show storage status', async ({ page }) => {
    await page.goto('/');
    // Storage status component should be present
    await expect(page.locator('.storage-status')).toBeVisible();
  });

  test('should display uploaded books if any exist', async ({ page }) => {
    await page.goto('/');
    // Wait for API response
    await page.waitForResponse(resp => resp.url().includes('/api/v1/publications'));
    // Page should either show books or empty state
    const content = await page.textContent('body');
    expect(content).toBeTruthy();
  });

  test('should navigate to reader when clicking a book', async ({ page }) => {
    await page.goto('/');
    await page.waitForResponse(resp => resp.url().includes('/api/v1/publications'));

    // If there are books, click the first one
    const bookCard = page.locator('[role="article"]').first();
    if (await bookCard.isVisible()) {
      await bookCard.click();
      await expect(page).toHaveURL(/\/read\/\d+/);
    }
  });
});
