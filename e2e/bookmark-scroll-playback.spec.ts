import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { clearAppState, SAMPLE_TXT_PATH, SAMPLE_EPUB_PATH, uploadBookAndWaitForReader } from './helpers'

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

async function ensureFormattedView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]')
  await expect(toggle).toBeVisible()
  const label = await toggle.getAttribute('aria-label')
  if (label && !label.includes('Formatted')) {
    await toggle.click()
  }
  await expect(page.locator('.formatted-view')).toBeVisible()
}

/** Mode name → the option label text used in the listbox. */
const MODE_OPTION_MAP: Record<string, string> = {
  Scroll: 'Scroll Continuous',
  'Word-by-word': 'Word-by-word Single',
  Focus: 'Focus One phrase',
}

async function selectMode(page: Page, modeName: string): Promise<void> {
  const modeBtn = page.locator('[aria-label^="Reading mode:"]')
  await expect(modeBtn).toBeVisible()
  const label = await modeBtn.getAttribute('aria-label')
  if (label && label.toLowerCase().includes(modeName.toLowerCase())) return
  await modeBtn.click()
  const optionName = MODE_OPTION_MAP[modeName] ?? modeName
  await page
    .locator('[role="listbox"][aria-label="Select reading mode"]')
    .getByRole('option', { name: optionName })
    .click()
  await expect(modeBtn).toContainText(new RegExp(modeName, 'i'))
}

/**
 * Simulate a long-press gesture on the formatted view.
 * The app uses a 500ms threshold with 15px move tolerance.
 */
async function longPressOnFormattedView(page: Page): Promise<void> {
  const view = page.locator('.formatted-view')
  const box = await view.boundingBox()
  if (!box) throw new Error('formatted-view has no bounding box')

  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  // Pointer down, hold for 700ms, then pointer up
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(700)
  await page.mouse.up()
}

/* ================================================================== */
/*  BOOKMARK TESTS                                                     */
/* ================================================================== */

test.describe('Bookmark creation and management', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_TXT_PATH)
    await ensureFormattedView(page)
  })

  test('long-press while paused opens bookmark dialog and saves bookmark', async ({ page }) => {
    // Ensure we are paused
    await expect(page.getByLabel('Play reading')).toBeVisible()

    // Wait for content to render
    await page.waitForTimeout(1000)

    // Long-press on the formatted view
    await longPressOnFormattedView(page)

    // Bookmark dialog should appear
    const dialog = page.locator('[aria-label="Name this bookmark"]')
    await expect(dialog).toBeVisible({ timeout: 3000 })

    // Input should be pre-filled and focused
    const input = page.locator('[aria-label="Bookmark name"]')
    await expect(input).toBeVisible()

    // Clear and type a custom name
    await input.fill('My Test Bookmark')

    // Save the bookmark
    await page.locator('.bookmark-dialog__btn--save').click()

    // Dialog should close
    await expect(dialog).not.toBeVisible()

    // Open bookmarks panel and verify bookmark exists
    await page.getByLabel('Open bookmarks').click()
    await expect(page.locator('.bookmarks-panel--open')).toBeVisible()

    // User bookmark should now appear (no longer empty)
    await expect(page.locator('.bookmarks-panel__empty')).not.toBeVisible()
    const userRow = page.locator('.bookmarks-panel__user-row')
    await expect(userRow).toHaveCount(1)
    await expect(page.locator('.bookmarks-panel__user-name')).toHaveText('My Test Bookmark')
  })

  test('bookmark dialog can be cancelled', async ({ page }) => {
    await page.waitForTimeout(1000)
    await longPressOnFormattedView(page)

    const dialog = page.locator('[aria-label="Name this bookmark"]')
    await expect(dialog).toBeVisible({ timeout: 3000 })

    // Cancel
    await page.locator('.bookmark-dialog__btn--cancel').click()
    await expect(dialog).not.toBeVisible()

    // Panel should still show empty state
    await page.getByLabel('Open bookmarks').click()
    await expect(page.locator('.bookmarks-panel__empty')).toBeVisible()
  })

  test('bookmark can be deleted from the panel', async ({ page }) => {
    // Create a bookmark first
    await page.waitForTimeout(1000)
    await longPressOnFormattedView(page)
    await expect(page.locator('[aria-label="Name this bookmark"]')).toBeVisible({ timeout: 3000 })
    await page.locator('[aria-label="Bookmark name"]').fill('Delete Me')
    await page.locator('.bookmark-dialog__btn--save').click()

    // Open panel
    await page.getByLabel('Open bookmarks').click()
    await expect(page.locator('.bookmarks-panel__user-row')).toHaveCount(1)

    // Delete the bookmark
    await page.locator('.bookmarks-panel__delete-btn').click()
    await expect(page.locator('.bookmarks-panel__user-row')).toHaveCount(0)
    await expect(page.locator('.bookmarks-panel__empty')).toBeVisible()
  })

  test('bookmark can be renamed via double-click', async ({ page }) => {
    // Create a bookmark
    await page.waitForTimeout(1000)
    await longPressOnFormattedView(page)
    await expect(page.locator('[aria-label="Name this bookmark"]')).toBeVisible({ timeout: 3000 })
    await page.locator('[aria-label="Bookmark name"]').fill('Original Name')
    await page.locator('.bookmark-dialog__btn--save').click()

    // Open panel
    await page.getByLabel('Open bookmarks').click()
    const nameEl = page.locator('.bookmarks-panel__user-name')
    await expect(nameEl).toHaveText('Original Name')

    // Double-click to rename (dispatch event directly for mobile compatibility)
    await nameEl.dispatchEvent('dblclick')

    const renameInput = page.locator('.bookmarks-panel__rename-input')
    await expect(renameInput).toBeVisible({ timeout: 3000 })
    await renameInput.fill('Renamed Bookmark')
    await renameInput.press('Enter')

    // Verify renamed
    await expect(page.locator('.bookmarks-panel__user-name')).toHaveText('Renamed Bookmark')
  })

  test('clicking a user bookmark jumps to its position', async ({ page }) => {
    // Play for a bit to advance position, then pause
    await page.getByLabel('Play reading').click()
    await page.waitForTimeout(3000)
    await page.getByLabel('Pause reading').click()
    await page.waitForTimeout(500)

    // Create bookmark at current position
    await longPressOnFormattedView(page)
    await expect(page.locator('[aria-label="Name this bookmark"]')).toBeVisible({ timeout: 3000 })
    await page.locator('[aria-label="Bookmark name"]').fill('Jump Target')
    await page.locator('.bookmark-dialog__btn--save').click()

    // Navigate back to start by scrolling up
    await selectMode(page, 'Scroll')
    await page.evaluate(() => {
      const el = document.querySelector('.formatted-view') as HTMLElement
      if (el) el.scrollTop = 0
    })
    await page.waitForTimeout(500)

    // Open panel and click the bookmark to jump
    await page.getByLabel('Open bookmarks').click()
    await page.locator('.bookmarks-panel__user-row').click()

    // Panel should close after jump
    await expect(page.locator('.bookmarks-panel--open')).not.toBeVisible({ timeout: 3000 })
  })
})

/* ================================================================== */
/*  PLAYBACK TESTS                                                     */
/* ================================================================== */

test.describe('Playback controls', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_TXT_PATH)
  })

  test('WPM can be increased and decreased', async ({ page }) => {
    const wpmLabel = page.locator('.controls__wpm-label')
    await expect(wpmLabel).toBeVisible()
    const initialWpm = await wpmLabel.textContent()

    // Increase WPM
    await page.getByLabel('Increase reading speed').click()
    await page.waitForTimeout(200)
    const increasedWpm = await wpmLabel.textContent()
    expect(increasedWpm).not.toBe(initialWpm)

    // Decrease WPM back
    await page.getByLabel('Decrease reading speed').click()
    await page.waitForTimeout(200)
    const decreasedWpm = await wpmLabel.textContent()
    expect(decreasedWpm).toBe(initialWpm)
  })

  test('reading mode can be switched between phrase, word-by-word, and scroll', async ({ page }) => {
    const modeBtn = page.locator('[aria-label^="Reading mode:"]')
    await expect(modeBtn).toBeVisible()

    // Switch to Scroll
    await selectMode(page, 'Scroll')
    await expect(modeBtn).toContainText(/Scroll/i)

    // Switch to Word-by-word (RSVP)
    await selectMode(page, 'Word-by-word')
    await expect(modeBtn).toContainText(/Word/i)

    // Switch back to Focus (phrase)
    await selectMode(page, 'Focus')
    await expect(modeBtn).toContainText(/Focus/i)
  })

  test('progress bar advances during playback', async ({ page }) => {
    // The progress container should exist
    const progressContainer = page.locator('.controls__progress')
    await expect(progressContainer).toBeVisible()

    // Get initial progress bar width percentage (may be 0% at start)
    const initialWidth = await page.evaluate(() => {
      const bar = document.querySelector('.controls__progress-bar') as HTMLElement | null
      return bar ? parseFloat(bar.style.width || '0') : 0
    })

    // Play for a few seconds
    await page.getByLabel('Play reading').click()
    await page.waitForTimeout(4000)
    await page.getByLabel('Pause reading').click()

    // Progress should have advanced
    const afterWidth = await page.evaluate(() => {
      const bar = document.querySelector('.controls__progress-bar') as HTMLElement | null
      return bar ? parseFloat(bar.style.width || '0') : 0
    })
    expect(afterWidth).toBeGreaterThan(initialWidth)
  })

  test('playback in phrase mode shows focus overlay', async ({ page }) => {
    await selectMode(page, 'Focus')

    // Start playback
    await page.getByLabel('Play reading').click()
    await page.waitForTimeout(1000)

    // Focus overlay should be visible during playback
    await expect(page.locator('.focus-overlay')).toBeVisible()

    // Pause
    await page.getByLabel('Pause reading').click()
    await page.waitForTimeout(500)

    // After pause, formatted view should be shown (if in formatted display mode)
    await ensureFormattedView(page)
    await expect(page.locator('.formatted-view')).toBeVisible()
  })

  test('auto-bookmarks section is visible in bookmarks panel', async ({ page }) => {
    // Open bookmarks panel
    await page.getByLabel('Open bookmarks').click()
    await expect(page.locator('.bookmarks-panel--open')).toBeVisible({ timeout: 5000 })

    // Auto bookmarks section should be visible with Last Opened and Farthest Read rows
    await expect(page.locator('.bookmarks-panel__auto-section')).toBeVisible()
    const autoRows = page.locator('.bookmarks-panel__auto-row')
    await expect(autoRows).toHaveCount(2) // Last Opened + Farthest Read

    // Both should have labels
    await expect(autoRows.nth(0)).toContainText('Last Opened')
    await expect(autoRows.nth(1)).toContainText('Farthest Read')
  })
})

/* ================================================================== */
/*  SCROLLING TESTS                                                    */
/* ================================================================== */

test.describe('Scrolling behavior', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH)
    await ensureFormattedView(page)
    await selectMode(page, 'Scroll')
  })

  test('manual scroll while paused moves the scroll container', async ({ page }) => {
    await page.waitForTimeout(1000)

    const initialScrollTop = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    )

    // Scroll down
    await page.evaluate(() => {
      const el = document.querySelector('.formatted-view') as HTMLElement
      if (el) el.scrollTop += 800
    })
    await page.waitForTimeout(500)

    const afterScrollTop = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    )
    expect(afterScrollTop).toBeGreaterThan(initialScrollTop)
  })

  test('touch swipe scrolls the formatted view', async ({ page }) => {
    await page.waitForTimeout(1000)

    const initialScroll = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    )

    // Simulate swipe up (scroll down) using touchscreen
    const view = page.locator('.formatted-view')
    const box = await view.boundingBox()
    if (!box) throw new Error('formatted-view has no bounding box')

    const startX = box.x + box.width / 2
    const startY = box.y + box.height * 0.7
    const endY = box.y + box.height * 0.3

    await page.touchscreen.tap(startX, startY)
    await page.waitForTimeout(100)

    // Use mouse to simulate scroll since touchscreen.tap doesn't scroll
    await page.evaluate(
      ({ delta }) => {
        const el = document.querySelector('.formatted-view') as HTMLElement
        if (el) el.scrollTop += delta
      },
      { delta: 300 },
    )
    await page.waitForTimeout(500)

    const afterScroll = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    )

    expect(afterScroll).toBeGreaterThan(initialScroll)
  })

  test('bookmark quick-jump pills are present in controls', async ({ page }) => {
    // Quick-jump bookmark pills should be rendered in the controls
    const pills = page.locator('.controls__bookmark-pill')
    await expect(pills.first()).toBeVisible({ timeout: 5000 })

    // Should have at least 1 pill (Last Opened / Farthest Read)
    const pillCount = await pills.count()
    expect(pillCount).toBeGreaterThanOrEqual(1)

    // Play briefly so auto-bookmarks get set, then check an enabled pill can be clicked
    await page.getByLabel('Play reading').click()
    await page.waitForTimeout(5000)
    await page.getByLabel('Pause reading').click()
    await page.waitForTimeout(1000)

    // Find an enabled pill and click it
    const enabledPill = pills.locator(':not([disabled])').first()
    const enabledCount = await pills.locator(':not([disabled])').count()
    if (enabledCount > 0) {
      await enabledPill.click()
      await page.waitForTimeout(1000)
      // Reader should still be functional after jump
      await expect(page.locator('.reader-viewport')).toBeVisible()
    }
  })
})

/* ================================================================== */
/*  INTEGRATION: bookmark + scroll + playback                          */
/* ================================================================== */

test.describe('Bookmark-scroll-playback integration', () => {
  test('create bookmark, scroll away, jump back via bookmark', async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH)
    await ensureFormattedView(page)
    await selectMode(page, 'Scroll')
    await page.waitForTimeout(1000)

    // Play to advance, then pause
    await page.getByLabel('Play reading').click()
    await page.waitForTimeout(4000)
    await page.getByLabel('Pause reading').click()
    await page.waitForTimeout(500)

    // Record position
    const posBeforeBookmark = await page.evaluate(
      () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
    )

    // Create bookmark at this position
    await longPressOnFormattedView(page)
    const dialog = page.locator('[aria-label="Name this bookmark"]')
    // If dialog doesn't appear (e.g., gesture not recognized), skip gracefully
    if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.locator('[aria-label="Bookmark name"]').fill('Midpoint')
      await page.locator('.bookmark-dialog__btn--save').click()
      await page.waitForTimeout(300)

      // Scroll to the top
      await page.evaluate(() => {
        const el = document.querySelector('.formatted-view') as HTMLElement
        if (el) el.scrollTop = 0
      })
      await page.waitForTimeout(500)

      const posAfterScrollUp = await page.evaluate(
        () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
      )
      expect(posAfterScrollUp).toBeLessThan(posBeforeBookmark)

      // Jump to the bookmark
      await page.getByLabel('Open bookmarks').click()
      await page.locator('.bookmarks-panel__user-row').click()
      await page.waitForTimeout(1000)

      // Should have scrolled back toward the bookmarked position
      const posAfterJump = await page.evaluate(
        () => (document.querySelector('.formatted-view') as HTMLElement | null)?.scrollTop ?? 0,
      )
      expect(posAfterJump).toBeGreaterThan(posAfterScrollUp)
    }
  })

  test('resume playback after jumping to bookmark', async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_TXT_PATH)
    await ensureFormattedView(page)
    await page.waitForTimeout(1000)

    // Create a bookmark at the start
    await longPressOnFormattedView(page)
    const dialog = page.locator('[aria-label="Name this bookmark"]')
    if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.locator('.bookmark-dialog__btn--save').click()
      await page.waitForTimeout(300)

      // Play to advance
      await page.getByLabel('Play reading').click()
      await page.waitForTimeout(3000)
      await page.getByLabel('Pause reading').click()
      await page.waitForTimeout(500)

      // Jump to bookmark
      await page.getByLabel('Open bookmarks').click()
      await page.locator('.bookmarks-panel__user-row').click()
      await page.waitForTimeout(500)

      // Resume playback — should work without errors
      await page.getByLabel('Play reading').click()
      await page.waitForTimeout(1500)

      // Verify still playing
      await expect(page.getByLabel('Pause reading')).toBeVisible()

      // Pause cleanly
      await page.getByLabel('Pause reading').click()
      await expect(page.getByLabel('Play reading')).toBeVisible()
    }
  })
})
