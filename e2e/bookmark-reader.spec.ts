import { expect, test } from '@playwright/test'
import { clearAppState, SAMPLE_TXT_PATH } from './helpers'

test.describe('Reader with bookmarks', () => {
  test('controls panel visible, scrolling works, bookmarks button present', async ({ page }) => {
    await clearAppState(page)

    // Upload a book
    await page.locator('input[type="file"]').setInputFiles(SAMPLE_TXT_PATH)
    await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
    await expect(page.locator('.reader-viewport')).toBeVisible()

    // Controls bottom sheet should be visible
    const playBtn = page.getByLabel('Play reading').or(page.getByLabel('Pause reading'))
    await expect(playBtn).toBeVisible()

    // WPM controls should be visible
    await expect(page.locator('.controls__speed-value')).toBeVisible()

    // Bookmarks button should be in the header
    await expect(page.getByLabel('Open bookmarks')).toBeVisible()

    // Start playback
    await page.getByLabel('Play reading').click({ force: true })
    await expect(page.getByLabel('Pause reading')).toBeVisible()

    // Pause
    await page.getByLabel('Pause reading').click({ force: true })
    await expect(page.getByLabel('Play reading')).toBeVisible()

    // Quick-jump bookmark pills should be present
    await expect(page.locator('.controls__progress-marker').first()).toBeVisible()

    // Open bookmarks panel
    await page.getByLabel('Open bookmarks').click()
    await expect(page.locator('.bookmarks-panel--open')).toBeVisible()
    await expect(page.locator('.bookmarks-panel__title')).toHaveText('Bookmarks')

    // Auto bookmarks section visible
    await expect(page.locator('.bookmarks-panel__auto-section')).toBeVisible()

    // Empty state for user bookmarks
    await expect(page.locator('.bookmarks-panel__empty')).toBeVisible()

    // Close bookmarks panel
    await page.getByLabel('Close bookmarks').click()
  })
})
