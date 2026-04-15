import { expect, test } from '@playwright/test'
import { clearAppState, SAMPLE_TXT_PATH } from './helpers'

test.describe('Playback text centering', () => {
  test('phrase mode text is vertically centered in visible area', async ({ page }) => {
    await clearAppState(page)
    await page.locator('input[type="file"]').setInputFiles(SAMPLE_TXT_PATH)
    await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
    await expect(page.locator('.reader-viewport')).toBeVisible()

    // Only one long-press-wrapper should exist
    await expect(page.locator('.long-press-wrapper')).toHaveCount(1)

    // Start playback (phrase mode is default)
    await page.getByLabel('Play reading').click({ force: true })
    await page.waitForTimeout(500)

    // The overlay and its center element should exist
    const overlay = page.locator('.focus-overlay')
    const center = page.locator('.focus-overlay__center')
    await expect(overlay).toBeVisible()
    await expect(center).toBeVisible()

    // Controls should be visible
    await expect(page.getByLabel('Pause reading')).toBeVisible()

    // Verify center is in the visible area (above controls, below header)
    const overlayBox = await overlay.boundingBox()
    const centerBox = await center.boundingBox()
    const controlsBox = await page.locator('.controls').boundingBox()
    expect(overlayBox).toBeTruthy()
    expect(centerBox).toBeTruthy()
    expect(controlsBox).toBeTruthy()

    // The visible reading area is from overlay top to controls top
    const visibleTop = overlayBox!.y
    const visibleBottom = controlsBox!.y
    const visibleMidY = visibleTop + (visibleBottom - visibleTop) / 2
    const centerMidY = centerBox!.y + centerBox!.height / 2

    // The center element should be within 15% of the visible area's midpoint
    const visibleHeight = visibleBottom - visibleTop
    const tolerance = visibleHeight * 0.15
    expect(Math.abs(centerMidY - visibleMidY)).toBeLessThan(tolerance)

    await page.screenshot({ path: 'test-results/centering-phrase.png' })
  })
})
