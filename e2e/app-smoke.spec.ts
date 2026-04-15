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
    // While paused, only `.controls__play-bar` is shown (aria-label="Play
    // reading"). While playing, the bar is CSS-hidden and `.controls__strip-
    // pause` takes over. Scope assertions to each element explicitly — a
    // bare getByLabel('Pause reading') matches both and fails strict-mode.
    const playBar = page.locator('.controls__play-bar');
    await expect(playBar).toBeVisible();
    await playBar.click({ force: true });
    await expect(page.locator('.controls__strip-pause')).toBeVisible();

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
