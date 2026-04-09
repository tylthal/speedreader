import { expect, test } from '@playwright/test';
import { clearAppState, SAMPLE_TXT_PATH } from './helpers';

test.describe('App smoke', () => {
  test('uploads a book and keeps primary navigation working', async ({ page }) => {
    await clearAppState(page);

    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
    await expect(page.getByText('Your library is empty')).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(SAMPLE_TXT_PATH);

    await page.waitForURL(/\/read\/\d+/, { timeout: 20000 });
    await expect(page.locator('.reader-viewport')).toBeVisible();
    await expect(
      page.getByLabel('Play reading').or(page.getByLabel('Pause reading')),
    ).toBeVisible();

    await page.getByLabel('Play reading').click({ force: true });
    await expect(page.getByLabel('Pause reading')).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
    await expect(page.locator('.book-card')).toHaveCount(1);

    await page.getByLabel('Archive').click();
    await expect(page.getByRole('heading', { name: 'Archive', exact: true })).toBeVisible();

    await page.getByLabel('Settings').click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    await page.locator('[aria-label^="Light theme:"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });
});
