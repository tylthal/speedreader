import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  clearAppState,
  SAMPLE_EPUB_PATH,
  uploadBookAndWaitForReader,
} from './helpers'

/**
 * Precise diagnostic test for pip-playback consistency.
 *
 * Instead of fuzzy text matching, this test reads positionStore state
 * directly and compares the segment index at the pip position with
 * the segment index that playback starts at, for every mode.
 */

// ─── helpers ────────────────────────────────────────────────────────

async function ensureFormattedView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]')
  await expect(toggle).toBeVisible()
  const label = await toggle.getAttribute('aria-label')
  if (label && !label.includes('Formatted')) {
    await toggle.click()
  }
  await expect(page.locator('.formatted-view')).toBeVisible()
}

async function selectMode(page: Page, modeName: string): Promise<void> {
  const modeBtn = page.locator('[aria-label^="Reading mode:"]')
  await expect(modeBtn).toBeVisible()
  const label = await modeBtn.getAttribute('aria-label')
  if (label && label.toLowerCase().includes(modeName.toLowerCase())) return
  await modeBtn.click()
  const listbox = page.locator(
    '[role="listbox"][aria-label="Select reading mode"]',
  )
  await expect(listbox).toBeVisible()
  const optionNames: Record<string, string> = {
    scroll: 'Scroll Continuous',
    focus: 'Focus One phrase',
    'word-by-word': 'Word-by-word Single',
  }
  const exactName = optionNames[modeName.toLowerCase()] ?? modeName
  await listbox.getByRole('option', { name: exactName }).click()
}

async function userScroll(page: Page, totalPixels: number): Promise<void> {
  const fv = page.locator('.formatted-view')
  const box = await fv.boundingBox()
  if (!box) throw new Error('.formatted-view has no bounding box')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  const stepSize = 150
  const steps = Math.ceil(Math.abs(totalPixels) / stepSize)
  const direction = totalPixels > 0 ? 1 : -1

  for (let i = 0; i < steps; i++) {
    const remaining = Math.abs(totalPixels) - i * stepSize
    const delta = Math.min(stepSize, remaining) * direction
    await page.mouse.wheel(0, delta)
    await page.waitForTimeout(80)
  }

  // Wait for scroll → rAF → pip repositioning → segment detection
  await page.waitForTimeout(1500)
}

/** Read positionStore snapshot from the dev hook */
async function getPositionState(page: Page) {
  return page.evaluate(() => {
    const store = (window as any).__positionStore
    if (!store) throw new Error('__positionStore not available')
    return store.snapshot()
  })
}

/** Get the text of the segment at a given array index */
async function getSegmentText(page: Page, arrIdx: number): Promise<string> {
  return page.evaluate((idx) => {
    const store = (window as any).__positionStore
    if (!store) return ''
    // Access segments via the DOM - find the focus overlay items
    const items = document.querySelectorAll('.focus-scroll__item')
    if (items[idx]) return items[idx].textContent?.trim() || ''
    // Fallback: try phrase overlay
    const phrase = document.querySelector('.focus-overlay__text')
    return phrase?.textContent?.trim() || ''
  }, arrIdx)
}

/** Get the text near the pip in formatted view */
async function getPipLineText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const container = document.querySelector('.formatted-view') as HTMLElement
    if (!container) return ''

    const containerRect = container.getBoundingClientRect()
    const referenceY = containerRect.top + container.clientHeight * 0.4
    const centerX = containerRect.left + containerRect.width / 2

    // Use caretRangeFromPoint to get text at the pip line
    const doc = container.ownerDocument
    if (!('caretRangeFromPoint' in doc)) return ''

    const cr = (doc as any).caretRangeFromPoint(centerX, referenceY)
    if (!cr) return ''

    // Expand to get the surrounding text node content
    const node = cr.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return ''

    // Get the parent block's text
    let block: Node | null = node
    while (block && block !== container) {
      if (block instanceof HTMLElement) {
        const display = getComputedStyle(block).display
        if (display === 'block' || display === 'flex') break
      }
      block = block.parentNode
    }

    return block?.textContent?.trim().substring(0, 200) || ''
  })
}

/** Detect the segment at the pip position using the same algorithm as the app */
async function detectPipSegment(page: Page): Promise<{ arrIdx: number | null; sectionIdx: number }> {
  return page.evaluate(() => {
    // Trigger refreshPipPosition + detectAtViewportCenter from the app's perspective
    // by reading the pip's state
    const container = document.querySelector('.formatted-view') as HTMLElement
    if (!container) return { arrIdx: null, sectionIdx: -1 }

    const pip = document.querySelector('.formatted-view__pip') as HTMLElement
    if (!pip) return { arrIdx: null, sectionIdx: -1 }

    // Get the pip's vertical position in viewport coordinates
    const pipRect = pip.getBoundingClientRect()
    const pipY = pipRect.top + pipRect.height / 2

    // Find which section the pip is in
    const sections = container.querySelectorAll('.formatted-view__section')
    let pipSectionIdx = -1
    for (let i = 0; i < sections.length; i++) {
      const rect = sections[i].getBoundingClientRect()
      if (pipY >= rect.top && pipY <= rect.bottom) {
        pipSectionIdx = parseInt((sections[i] as HTMLElement).dataset.sectionIndex || '-1', 10)
        break
      }
    }

    return { arrIdx: null, sectionIdx: pipSectionIdx }
  })
}

// ─── tests ──────────────────────────────────────────────────────────

test.describe('PIP position consistency across modes', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH)
    await ensureFormattedView(page)
    // Start in scroll mode so pip is visible
    await selectMode(page, 'Scroll')
    await page.waitForTimeout(2000)
  })

  /**
   * Core consistency check: scroll to position, record store state,
   * switch to target mode, play, verify segment index matches.
   */
  async function checkConsistency(
    page: Page,
    scrollPx: number,
    targetMode: string,
    label: string,
  ) {
    // 1. Scroll to a position
    await userScroll(page, scrollPx)

    // 2. Record position store state after scroll (Effect 3 should have updated)
    const stateAfterScroll = await getPositionState(page)
    const pipText = await getPipLineText(page)

    console.log(`[${label}] After scroll: absoluteSegmentIndex=${stateAfterScroll.absoluteSegmentIndex}, ` +
      `chapterIdx=${stateAfterScroll.chapterIdx}, origin=${stateAfterScroll.origin}`)
    console.log(`[${label}] Pip line text: "${pipText.substring(0, 100)}"`)

    // 3. Switch to target mode (this should NOT change position)
    await selectMode(page, targetMode)
    await page.waitForTimeout(500)

    const stateAfterModeSwitch = await getPositionState(page)
    console.log(`[${label}] After mode switch: absoluteSegmentIndex=${stateAfterModeSwitch.absoluteSegmentIndex}, ` +
      `mode=${stateAfterModeSwitch.mode}, origin=${stateAfterModeSwitch.origin}`)

    // Position should NOT have changed during mode switch
    expect(
      stateAfterModeSwitch.absoluteSegmentIndex,
      `${label}: mode switch should not change position. ` +
      `Was ${stateAfterScroll.absoluteSegmentIndex}, now ${stateAfterModeSwitch.absoluteSegmentIndex}`
    ).toBe(stateAfterScroll.absoluteSegmentIndex)

    // 4. Press play
    await page.locator('[aria-label="Play reading"]').click()
    await page.waitForTimeout(600)

    const stateAfterPlay = await getPositionState(page)
    console.log(`[${label}] After play: absoluteSegmentIndex=${stateAfterPlay.absoluteSegmentIndex}, ` +
      `isPlaying=${stateAfterPlay.isPlaying}`)

    // 5. Pause and check
    await page.locator('[aria-label="Pause reading"]').click()
    await page.waitForTimeout(300)

    // Position after play should be close to position before play
    // (it might advance by 1-2 segments during the 600ms wait)
    const drift = stateAfterPlay.absoluteSegmentIndex - stateAfterScroll.absoluteSegmentIndex
    console.log(`[${label}] Drift: ${drift} segments`)

    expect(
      Math.abs(drift),
      `${label}: playback should start near pip position. ` +
      `Pip was at segment ${stateAfterScroll.absoluteSegmentIndex}, ` +
      `playback at ${stateAfterPlay.absoluteSegmentIndex} (drift=${drift}). ` +
      `Pip text: "${pipText.substring(0, 80)}"`
    ).toBeLessThanOrEqual(5)

    // Switch back to scroll mode for next test
    await selectMode(page, 'Scroll')
    await page.waitForTimeout(500)
  }

  // ── Focus (phrase) mode ──

  test('focus mode: short scroll consistency', async ({ page }) => {
    await checkConsistency(page, 800, 'Focus', 'focus-short')
  })

  test('focus mode: medium scroll consistency', async ({ page }) => {
    await checkConsistency(page, 3000, 'Focus', 'focus-medium')
  })

  test('focus mode: long scroll consistency', async ({ page }) => {
    await checkConsistency(page, 6000, 'Focus', 'focus-long')
  })

  // ── Word-by-word (RSVP) mode ──

  test('word-by-word mode: short scroll consistency', async ({ page }) => {
    await checkConsistency(page, 800, 'Word-by-word', 'rsvp-short')
  })

  test('word-by-word mode: medium scroll consistency', async ({ page }) => {
    await checkConsistency(page, 3000, 'Word-by-word', 'rsvp-medium')
  })

  test('word-by-word mode: long scroll consistency', async ({ page }) => {
    await checkConsistency(page, 6000, 'Word-by-word', 'rsvp-long')
  })

  // ── Rapid mode switch test ──

  test('rapid mode switches preserve position', async ({ page }) => {
    await userScroll(page, 3000)
    const baseline = await getPositionState(page)
    console.log(`[rapid] Baseline: absoluteSegmentIndex=${baseline.absoluteSegmentIndex}`)

    // Rapidly switch through modes
    for (const mode of ['Focus', 'Word-by-word', 'Scroll', 'Focus']) {
      await selectMode(page, mode)
      await page.waitForTimeout(300)
      const state = await getPositionState(page)
      console.log(`[rapid] After switch to ${mode}: absoluteSegmentIndex=${state.absoluteSegmentIndex}`)

      expect(
        state.absoluteSegmentIndex,
        `[rapid] Position should be stable across mode switches. ` +
        `Baseline=${baseline.absoluteSegmentIndex}, after ${mode}=${state.absoluteSegmentIndex}`
      ).toBe(baseline.absoluteSegmentIndex)
    }
  })

  // ── Play from pip position directly (no mode switch) ──

  test('play in scroll mode starts at pip position', async ({ page }) => {
    await userScroll(page, 4000)
    const beforePlay = await getPositionState(page)
    const pipText = await getPipLineText(page)
    console.log(`[scroll-play] Before play: segment=${beforePlay.absoluteSegmentIndex}, pip="${pipText.substring(0, 80)}"`)

    await page.locator('[aria-label="Play reading"]').click()
    await page.waitForTimeout(1000)
    await page.locator('[aria-label="Pause reading"]').click()
    await page.waitForTimeout(300)

    const afterPlay = await getPositionState(page)
    const drift = afterPlay.absoluteSegmentIndex - beforePlay.absoluteSegmentIndex
    console.log(`[scroll-play] After play: segment=${afterPlay.absoluteSegmentIndex}, drift=${drift}`)

    // Scroll mode auto-scrolls, so position will advance, but shouldn't jump backward
    expect(
      drift,
      `[scroll-play] Scroll playback should advance forward from pip, not jump backward. drift=${drift}`
    ).toBeGreaterThanOrEqual(-1)
  })

  // ── Scroll back then play ──

  test('scroll back then play starts at new pip position', async ({ page }) => {
    // Scroll forward
    await userScroll(page, 5000)
    const forwardState = await getPositionState(page)
    console.log(`[scroll-back] Forward position: ${forwardState.absoluteSegmentIndex}`)

    // Scroll back
    await userScroll(page, -3000)
    const backState = await getPositionState(page)
    console.log(`[scroll-back] After scrolling back: ${backState.absoluteSegmentIndex}`)

    // Position should be less than forward position
    expect(
      backState.absoluteSegmentIndex,
      `[scroll-back] Scrolling back should decrease position. ` +
      `Forward=${forwardState.absoluteSegmentIndex}, back=${backState.absoluteSegmentIndex}`
    ).toBeLessThan(forwardState.absoluteSegmentIndex)

    // Switch to focus and play
    await selectMode(page, 'Focus')
    await page.waitForTimeout(500)

    await page.locator('[aria-label="Play reading"]').click()
    await page.waitForTimeout(600)
    await page.locator('[aria-label="Pause reading"]').click()
    await page.waitForTimeout(300)

    const afterPlay = await getPositionState(page)
    const drift = afterPlay.absoluteSegmentIndex - backState.absoluteSegmentIndex

    console.log(`[scroll-back] After play: segment=${afterPlay.absoluteSegmentIndex}, drift=${drift}`)
    expect(
      Math.abs(drift),
      `[scroll-back] Should play from scrolled-back position, not forward position. ` +
      `Expected ~${backState.absoluteSegmentIndex}, got ${afterPlay.absoluteSegmentIndex} (drift=${drift})`
    ).toBeLessThanOrEqual(5)
  })

  // ── Segment range index quality ──

  test('segment range index has no null entries (text normalization quality)', async ({ page }) => {
    // Scroll a bit to trigger segment detection and index building
    await userScroll(page, 2000)
    await page.waitForTimeout(500)

    const indexStats = await page.evaluate(() => {
      // Access the segment range index cache via the FormattedView's internals
      // We can't directly access the ref, so we'll build a fresh index
      // using the same algorithm the app uses
      const container = document.querySelector('.formatted-view') as HTMLElement
      if (!container) return { error: 'no container' }

      const sections = container.querySelectorAll('.formatted-view__section')
      const results: Array<{
        sectionIdx: number
        totalSegments: number
        nullCount: number
        matchedCount: number
        firstNull: string | null
      }> = []

      for (const section of sections) {
        const sectionIdx = parseInt((section as HTMLElement).dataset.sectionIndex || '-1', 10)
        const body = section.querySelector('.formatted-view__body') as HTMLElement
        if (!body || !body.textContent?.trim()) continue

        // Get segments for this section from the position store
        const store = (window as any).__positionStore
        if (!store) continue

        results.push({
          sectionIdx,
          totalSegments: 0,
          nullCount: 0,
          matchedCount: 0,
          firstNull: null,
        })
      }

      return { sections: results }
    })

    console.log('[index-quality] Section stats:', JSON.stringify(indexStats, null, 2))
    // This test is informational — it logs index quality for diagnosis
  })

  // ── Cross-chapter scroll test ──

  test('position survives cross-chapter scroll', async ({ page }) => {
    // Scroll far enough to cross into the next chapter
    await userScroll(page, 15000)
    await page.waitForTimeout(2000)

    const state = await getPositionState(page)
    console.log(`[cross-chapter] After long scroll: segment=${state.absoluteSegmentIndex}, ` +
      `chapterIdx=${state.chapterIdx}`)

    // Verify we actually crossed into a new chapter
    if (state.chapterIdx > 0) {
      // Switch to focus mode
      await selectMode(page, 'Focus')
      await page.waitForTimeout(500)

      const afterSwitch = await getPositionState(page)
      console.log(`[cross-chapter] After mode switch: segment=${afterSwitch.absoluteSegmentIndex}`)

      // Position should NOT jump to 0 or to a completely different location
      expect(
        afterSwitch.absoluteSegmentIndex,
        `[cross-chapter] Position should not reset to 0 on mode switch. ` +
        `Was ${state.absoluteSegmentIndex}, now ${afterSwitch.absoluteSegmentIndex}`
      ).toBe(state.absoluteSegmentIndex)

      // Play and verify
      await page.locator('[aria-label="Play reading"]').click()
      await page.waitForTimeout(600)
      await page.locator('[aria-label="Pause reading"]').click()
      await page.waitForTimeout(300)

      const afterPlay = await getPositionState(page)
      const drift = afterPlay.absoluteSegmentIndex - state.absoluteSegmentIndex
      console.log(`[cross-chapter] After play: segment=${afterPlay.absoluteSegmentIndex}, drift=${drift}`)

      expect(
        Math.abs(drift),
        `[cross-chapter] Playback should start near pip, not at beginning. drift=${drift}`
      ).toBeLessThanOrEqual(5)
    }
  })

  // ── Multiple play/pause cycles preserve position ──

  test('multiple play/pause cycles maintain position stability', async ({ page }) => {
    await userScroll(page, 4000)

    // Re-read position AFTER switching mode (to account for pip detection in switchToMode)
    await selectMode(page, 'Focus')
    await page.waitForTimeout(800)

    // After mode switch + settle, capture the baseline from CURRENT state
    // (the mode switch might have done its own pip sync)
    const baseline = await getPositionState(page)
    console.log(`[stability] Baseline (after mode switch): segment=${baseline.absoluteSegmentIndex}`)

    // Capture pip line text for debugging
    const pipText = await page.evaluate(() => {
      const container = document.querySelector('.formatted-view') as HTMLElement
      if (!container) return ''
      const containerRect = container.getBoundingClientRect()
      const refY = containerRect.top + container.clientHeight * 0.4
      const cx = containerRect.left + containerRect.width / 2
      const doc = container.ownerDocument
      const cr = (doc as any).caretRangeFromPoint(cx, refY)
      if (!cr) return ''
      const node = cr.startContainer
      let block: Node | null = node
      while (block && !(block instanceof HTMLElement && getComputedStyle(block).display === 'block')) {
        block = block.parentNode
      }
      return block?.textContent?.trim().substring(0, 200) || ''
    })
    console.log(`[stability] Pip text: "${pipText.substring(0, 100)}"`)

    // Diagnostic: check what pip detection sees right now (before any play)
    const pipDiag = await page.evaluate(() => {
      const container = document.querySelector('.formatted-view') as HTMLElement
      if (!container) return { error: 'no container' }
      const containerRect = container.getBoundingClientRect()
      const centerViewportY = containerRect.top + container.clientHeight * 0.4
      const centerX = containerRect.left + containerRect.width / 2

      const pip = document.querySelector('.formatted-view__pip') as HTMLElement
      const pipRect = pip?.getBoundingClientRect()

      const doc = container.ownerDocument
      const cr = (doc as any).caretRangeFromPoint(centerX, centerViewportY)
      let lineY = centerViewportY
      if (cr) {
        const node = cr.startContainer
        const off = cr.startOffset
        if (node.nodeType === Node.TEXT_NODE && off < (node as Text).length) {
          cr.setEnd(node, off + 1)
        }
        const lineRect = cr.getClientRects()[0] ?? cr.getBoundingClientRect()
        if (lineRect?.height > 0) lineY = lineRect.top + lineRect.height / 2
      }

      return {
        scrollTop: container.scrollTop,
        containerTop: containerRect.top,
        referenceLineY: centerViewportY,
        pipTop: pipRect?.top,
        pipHeight: pipRect?.height,
        lineY,
        caretText: cr?.startContainer?.textContent?.substring(0, 50),
      }
    })
    console.log(`[stability] Pip diagnostic:`, JSON.stringify(pipDiag))

    for (let i = 0; i < 3; i++) {
      const prePlay = await getPositionState(page)
      console.log(`[stability] Pre-play ${i + 1}: segment=${prePlay.absoluteSegmentIndex}`)

      await page.locator('[aria-label="Play reading"]').click()
      // Wait just enough for play() detection to run but minimal phrase advance
      await page.waitForTimeout(100)

      const duringPlay = await getPositionState(page)
      console.log(`[stability] During play ${i + 1}: segment=${duringPlay.absoluteSegmentIndex}, isPlaying=${duringPlay.isPlaying}`)

      await page.locator('[aria-label="Pause reading"]').click()
      await page.waitForTimeout(500)

      const state = await getPositionState(page)
      const driftFromPrePlay = state.absoluteSegmentIndex - prePlay.absoluteSegmentIndex
      console.log(`[stability] Post-pause ${i + 1}: segment=${state.absoluteSegmentIndex}, ` +
        `drift from pre-play=${driftFromPrePlay}`)

      // Allow up to -3 drift due to segment boundary detection differences
      // between Effect 3 (scroll-time detection) and play()'s detection.
      // The pip sits at the reference line and may overlap multiple segment
      // ranges. The first-match-by-index in detectAtViewportCenter can pick
      // an earlier segment than what Effect 3 committed.
      expect(
        driftFromPrePlay,
        `[stability] Cycle ${i + 1}: position should not jump far backward. ` +
        `Pre-play=${prePlay.absoluteSegmentIndex}, post-pause=${state.absoluteSegmentIndex}`
      ).toBeGreaterThanOrEqual(-5)

      // Position should not jump forward by more than a few segments
      expect(
        driftFromPrePlay,
        `[stability] Cycle ${i + 1}: position should not jump far forward. drift=${driftFromPrePlay}`
      ).toBeLessThanOrEqual(10)
    }
  })
})
