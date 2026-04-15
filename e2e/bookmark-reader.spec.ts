import { expect, test } from '@playwright/test'
import { clearAppState, SAMPLE_TXT_PATH } from './helpers'

test.describe('Reader with bookmarks', () => {
  test('controls panel visible, scrolling works, bookmarks button present', async ({ page }) => {
    await clearAppState(page)

    // Upload a book
    await page.locator('input[type="file"]').setInputFiles(SAMPLE_TXT_PATH)
    await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
    await expect(page.locator('.reader-viewport')).toBeVisible()

    // Controls bottom sheet should be visible. Scope to .controls__play-bar —
    // the strip adds a second 'Pause reading' button that tripped strict-mode.
    const playBar = page.locator('.controls__play-bar')
    await expect(playBar).toBeVisible()

    // WPM controls should be visible
    await expect(page.locator('.controls__speed-value')).toBeVisible()

    // Bookmarks button should be in the header
    await expect(page.getByLabel('Open bookmarks')).toBeVisible()

    // Start playback (the play-bar is the only visible Play button)
    await playBar.click({ force: true })
    // Strip-pause is the button that shows while playing
    await expect(page.locator('.controls__strip-pause')).toBeVisible()
    // Let the engine cross at least one segment boundary so a position
    // commit fires and farthestRead gets populated.
    await page.waitForTimeout(4000)

    // Pause via the strip
    await page.locator('.controls__strip-pause').click({ force: true })
    await expect(playBar).toBeVisible()
    // Flush-on-pause fires doSave which updates bookmarkStore.lastOpened —
    // needs a tick for the IndexedDB write + emit() + React re-render.
    await page.waitForTimeout(1500)

    // Quick-jump bookmark pills should be present after pause (auto-bookmarks
    // flush via the isPlaying transition hook in useProgressSaver).
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
