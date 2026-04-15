import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { clearAppState, SAMPLE_EPUB_PATH, uploadBookAndWaitForReader } from './helpers'

/**
 * Regression test for the "text mode only shows the first segment"
 * bug. Plain/text mode used to render only the current chapter's
 * segments — so opening a book fresh landed on chapter 0 = Cover =
 * 1 segment and the user could not scroll past it. Plain mode now
 * mounts all chapters (like FormattedView does) when paused.
 */

async function switchToPlainView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]')
  await expect(toggle).toBeVisible()
  const label = await toggle.getAttribute('aria-label')
  if (label && label.includes('Formatted')) {
    await toggle.click()
  }
  // Paused plain view mounts .focus-overlay + .focus-scroll
  await expect(page.locator('.focus-scroll')).toBeVisible()
}

test.describe('Plain mode — multi-chapter paused scroll', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH)
    await switchToPlainView(page)
    // Give useAllChapterSegments time to finish fetching every chapter.
    await expect
      .poll(
        async () => await page.locator('.focus-scroll__chapter').count(),
        { timeout: 15000, message: 'waiting for multi-chapter mount' },
      )
      .toBeGreaterThan(1)
  })

  test('renders more than one chapter section when paused', async ({ page }) => {
    const sectionCount = await page.locator('.focus-scroll__chapter').count()
    expect(sectionCount).toBeGreaterThan(1)

    // At least one chapter-title divider (we omit one for the first chapter).
    const titleCount = await page.locator('.focus-scroll__chapter-title').count()
    expect(titleCount).toBeGreaterThanOrEqual(sectionCount - 1)
  })

  test('renders more segments than any single chapter could contain', async ({ page }) => {
    // Sanity: with the old single-chapter bug this would be 1 on chapter 0.
    const itemCount = await page.locator('.focus-scroll .focus-scroll__item').count()
    expect(itemCount).toBeGreaterThan(5)
  })

  test('focus-scroll is vertically scrollable', async ({ page }) => {
    const metrics = await page.evaluate(() => {
      const el = document.querySelector('.focus-scroll') as HTMLElement | null
      if (!el) return null
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    })
    expect(metrics).not.toBeNull()
    expect(metrics!.scrollHeight).toBeGreaterThan(metrics!.clientHeight)
  })

  test('wheel scroll advances past the first item', async ({ page }) => {
    const before = await page.evaluate(
      () => (document.querySelector('.focus-scroll') as HTMLElement).scrollTop,
    )
    // Real wheel events so passive scroll listeners fire like they would
    // for a user.
    const box = await page.locator('.focus-scroll').boundingBox()
    if (!box) throw new Error('no bounding box for .focus-scroll')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 400)
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(500)
    const after = await page.evaluate(
      () => (document.querySelector('.focus-scroll') as HTMLElement).scrollTop,
    )
    expect(after).toBeGreaterThan(before)
  })
})
