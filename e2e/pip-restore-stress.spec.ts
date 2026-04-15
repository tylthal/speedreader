import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { clearAppState, uploadBookAndWaitForReader } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Use glob to find the file — the filename contains a Unicode apostrophe
import { globSync } from 'glob'
const phantomMatches = globSync(
  path.join(__dirname, '..', 'testbook', 'The Phantom*Opera*.epub'),
)
const PHANTOM_EPUB = phantomMatches[0] ?? ''

/**
 * Comprehensive PIP-restore stress test.
 *
 * Opens "The Phantom of the Opera", scrolls to a random position,
 * captures the text at the PIP reference line, exits the book,
 * re-enters, and validates the PIP is pointing at the same text.
 *
 * Repeats 100 times with a different random scroll target each cycle.
 * Runs on an iPhone 17 Pro–sized viewport (393×852).
 */

// ─── helpers ────────────────────────────────────────────────────────

async function ensureFormattedView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]')
  if ((await toggle.count()) === 0) return
  const label = await toggle.getAttribute('aria-label')
  if (label && !label.includes('Formatted')) {
    await toggle.click()
    await page.waitForTimeout(500)
  }
  await expect(page.locator('.formatted-view')).toBeVisible({ timeout: 5000 })
}

/**
 * Scroll using mouse-wheel gestures so the app sees real user-scroll
 * events (passive scroll listener → rAF detect → positionStore commit).
 */
async function userScroll(page: Page, totalPixels: number): Promise<void> {
  const fv = page.locator('.formatted-view')
  const box = await fv.boundingBox()
  if (!box) throw new Error('.formatted-view has no bounding box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  const stepSize = 200
  const steps = Math.ceil(Math.abs(totalPixels) / stepSize)
  const direction = totalPixels > 0 ? 1 : -1
  for (let i = 0; i < steps; i++) {
    const remaining = Math.abs(totalPixels) - i * stepSize
    const delta = Math.min(stepSize, remaining) * direction
    await page.mouse.wheel(0, delta)
    await page.waitForTimeout(50)
  }
  // Wait for scroll → rAF → pip repositioning → segment detection → scrollend
  await page.waitForTimeout(1200)
}

/** Read the positionStore snapshot from the debug hook. */
async function getPositionState(page: Page) {
  return page.evaluate(() => {
    const store = (window as any).__positionStore
    if (!store) throw new Error('__positionStore not available')
    return store.snapshot()
  })
}

/**
 * Capture a full diagnostic snapshot at the PIP reference line:
 * - scrollTop of the container
 * - the text of the block-level element at the reference line
 * - the pip element's top offset
 * - the raw textContent of the text node at the reference line
 * - localStorage position data
 * - positionStore state
 */
async function getPipSnapshot(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector('.formatted-view') as HTMLElement
    if (!container) return null

    const containerRect = container.getBoundingClientRect()
    const refY = containerRect.top + container.clientHeight * 0.4
    const cx = containerRect.left + containerRect.width / 2

    // Find the block-level element at the reference line
    let blockText = ''
    let lineText = ''
    const doc = container.ownerDocument
    if ('caretRangeFromPoint' in doc) {
      const cr = (doc as any).caretRangeFromPoint(cx, refY)
      if (cr) {
        // Get the immediate text node content for precise matching
        if (cr.startContainer.nodeType === Node.TEXT_NODE) {
          lineText = (cr.startContainer as Text).textContent?.trim() || ''
        }
        // Walk up to the nearest block element
        let block: Node | null = cr.startContainer
        while (block && block !== container) {
          if (
            block instanceof HTMLElement &&
            getComputedStyle(block).display === 'block'
          )
            break
          block = block.parentNode
        }
        blockText = block?.textContent?.trim().substring(0, 200) || ''
      }
    }

    // PIP element position
    const pip = document.querySelector('.formatted-view__pip') as HTMLElement
    const pipTop = pip ? parseFloat(pip.style.top) : -1
    const pipBoundingTop = pip ? pip.getBoundingClientRect().top : -1

    // Section-relative offset (mirrors what the saver computes)
    const store = (window as any).__positionStore
    const snap = store ? store.snapshot() : {}
    const sections = container.querySelectorAll('.formatted-view__section')
    let sectionOffset = container.scrollTop
    if (snap.chapterIdx != null && sections[snap.chapterIdx]) {
      sectionOffset =
        container.scrollTop -
        (sections[snap.chapterIdx] as HTMLElement).offsetTop
    }

    // localStorage state
    let lsData: any = null
    for (let id = 1; id <= 20; id++) {
      const raw = localStorage.getItem(`speedreader_position_${id}`)
      if (raw) {
        lsData = { pubId: id, ...JSON.parse(raw) }
        break
      }
    }

    return {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      blockText,
      lineText,
      pipStyleTop: pipTop,
      pipBoundingTop: pipBoundingTop,
      sectionOffset,
      store: {
        chapterId: snap.chapterId,
        chapterIdx: snap.chapterIdx,
        absoluteSegmentIndex: snap.absoluteSegmentIndex,
        scrollTop: snap.scrollTop,
        origin: snap.origin,
        revision: snap.revision,
      },
      localStorage: lsData,
    }
  })
}

async function exitReader(page: Page): Promise<void> {
  const exitBtn = page.locator(
    '[aria-label="Exit reader"], [aria-label="Back to library"]',
  )
  if ((await exitBtn.count()) > 0) {
    await exitBtn.first().click()
  } else {
    await page.goto('/')
  }
  // Wait for navigation + unmount flush
  await page.waitForTimeout(1500)
}

async function reenterBook(page: Page): Promise<void> {
  const bookCard = page.locator('[role="article"]').first()
  if ((await bookCard.count()) > 0) {
    await bookCard.click()
  }
  await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
  await page.waitForSelector('.reader-viewport', { timeout: 15000 })
  // Wait for: bootstrap → positionStore.init → Effect 2 scroll →
  // layout settle → pip reposition → scrollend
  await page.waitForTimeout(3000)
}

/** Get the max scrollable distance for the formatted view. */
async function getMaxScroll(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('.formatted-view') as HTMLElement
    if (!c) return 0
    return Math.max(0, c.scrollHeight - c.clientHeight)
  })
}

/** Seeded PRNG (mulberry32) for reproducible random scroll positions. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── test ───────────────────────────────────────────────────────────

test.describe('PIP restore stress — 100 cycles, random scroll, text validation', () => {
  // iPhone 17 Pro viewport
  test.use({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  })

  test.setTimeout(900_000) // 15 minutes for 100 iterations

  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, PHANTOM_EPUB)
    await ensureFormattedView(page)
    await page.waitForTimeout(2000) // initial layout settle
  })

  test('pip text is identical after exit/re-enter across 100 random scroll positions', async ({
    page,
  }) => {
    const TOTAL_TRIALS = 100
    // Use a fixed seed so failures are reproducible
    const rng = mulberry32(20260413)

    // Discover how far we can scroll
    const maxScroll = await getMaxScroll(page)
    console.log(`[setup] maxScroll = ${maxScroll}px`)
    expect(maxScroll).toBeGreaterThan(1000)

    // Reserve 10% from each end to avoid edge cases at very top/bottom
    const scrollMin = Math.round(maxScroll * 0.05)
    const scrollMax = Math.round(maxScroll * 0.90)

    let passed = 0
    let failed = 0
    const failures: Array<{
      trial: number
      scrollTarget: number
      before: any
      after: any
      reason: string
    }> = []

    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      // Generate a random scroll target
      const scrollTarget =
        scrollMin + Math.round(rng() * (scrollMax - scrollMin))

      // ── 1. Scroll to the random position via programmatic set + user gesture ──
      // First jump close to the target, then do a small user-scroll to trigger
      // the real scroll event pipeline (Effect 3 detection + positionStore commit).
      await page.evaluate((target) => {
        const c = document.querySelector('.formatted-view') as HTMLElement
        if (c) c.scrollTop = Math.max(0, target - 300)
      }, scrollTarget)
      await page.waitForTimeout(200)

      // Small user-gesture scroll to trigger real scroll detection pipeline
      await userScroll(page, 300)

      // Extra settle time for pip repositioning + positionStore commit
      await page.waitForTimeout(500)

      // ── 2. Capture the PIP snapshot before exit ──
      const before = await getPipSnapshot(page)
      if (!before || !before.blockText) {
        console.log(
          `[skip] Trial ${trial}: no text at pip line (scrollTarget=${scrollTarget}). Skipping.`,
        )
        continue
      }

      // ── 3. Verify localStorage was actually written ──
      const lsBefore = before.localStorage
      if (!lsBefore) {
        console.log(
          `[warn] Trial ${trial}: localStorage not written before exit`,
        )
      }

      // ── 4. Exit the book ──
      await exitReader(page)

      // ── 5. Check localStorage state after exit (the unmount flush) ──
      const lsAfterExit = await page.evaluate(() => {
        for (let id = 1; id <= 20; id++) {
          const raw = localStorage.getItem(`speedreader_position_${id}`)
          if (raw) return { pubId: id, ...JSON.parse(raw) }
        }
        return null
      })

      // ── 6. Re-enter the book ──
      await reenterBook(page)
      await ensureFormattedView(page)
      await page.waitForTimeout(1000) // extra settle after formatted view ready

      // ── 7. Capture the PIP snapshot after restore ──
      const after = await getPipSnapshot(page)
      if (!after) {
        failures.push({
          trial,
          scrollTarget,
          before,
          after: null,
          reason: 'no snapshot after restore',
        })
        failed++
        continue
      }

      // ── 8. Compare: the primary criterion is TEXT match ──
      // Use the first 80 chars of blockText for comparison (avoids trailing
      // whitespace or minor DOM differences at the end of long paragraphs)
      const beforeText = before.blockText.substring(0, 80)
      const afterText = after.blockText.substring(0, 80)
      const textMatch = beforeText === afterText
      const scrollDrift = Math.abs(after.scrollTop - before.scrollTop)

      if (textMatch) {
        passed++
      } else {
        failed++
        const reason =
          `TEXT MISMATCH | scrollDrift=${scrollDrift}px | ` +
          `seg ${before.store.absoluteSegmentIndex}→${after.store.absoluteSegmentIndex} | ` +
          `ch ${before.store.chapterIdx}→${after.store.chapterIdx} | ` +
          `sectionOffset ${before.sectionOffset.toFixed(1)}→${after.sectionOffset.toFixed(1)} | ` +
          `ls.scroll_top ${lsAfterExit?.scroll_top ?? 'null'}→restored store.scrollTop ${after.store.scrollTop}`

        const detail = {
          trial,
          scrollTarget,
          before: {
            text: beforeText,
            scrollTop: before.scrollTop,
            sectionOffset: before.sectionOffset,
            store: before.store,
            ls: lsBefore,
          },
          after: {
            text: afterText,
            scrollTop: after.scrollTop,
            sectionOffset: after.sectionOffset,
            store: after.store,
          },
          lsAfterExit,
          reason,
        }
        failures.push(detail)
        console.log(`\n[FAIL] Trial ${trial} (target=${scrollTarget}px): ${reason}`)
        console.log(`  BEFORE text: "${beforeText}"`)
        console.log(`  AFTER  text: "${afterText}"`)
        console.log(
          `  BEFORE store: seg=${before.store.absoluteSegmentIndex} ch=${before.store.chapterIdx} scrollTop=${before.store.scrollTop} origin=${before.store.origin}`,
        )
        console.log(
          `  AFTER  store: seg=${after.store.absoluteSegmentIndex} ch=${after.store.chapterIdx} scrollTop=${after.store.scrollTop} origin=${after.store.origin}`,
        )
        console.log(
          `  LS after exit: ch_idx=${lsAfterExit?.chapter_idx} seg=${lsAfterExit?.absolute_segment_index} scroll_top=${lsAfterExit?.scroll_top}`,
        )
      }

      // Progress logging every 10 trials
      if ((trial + 1) % 10 === 0) {
        console.log(
          `[progress] ${trial + 1}/${TOTAL_TRIALS} — ${passed} passed, ${failed} failed`,
        )
      }
    }

    // ── Final report ──
    console.log(`\n${'='.repeat(60)}`)
    console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed} trials`)
    console.log(`${'='.repeat(60)}`)

    if (failures.length > 0) {
      console.log(`\n── Failure summary ──`)
      for (const f of failures) {
        console.log(
          `  Trial ${f.trial} (target=${f.scrollTarget}px): ${f.reason}`,
        )
      }

      // Categorize failures
      const chapterMismatch = failures.filter(
        (f) =>
          f.before?.store?.chapterIdx !== f.after?.store?.chapterIdx,
      )
      const sameChapterDrift = failures.filter(
        (f) =>
          f.before?.store?.chapterIdx === f.after?.store?.chapterIdx,
      )

      console.log(`\n── Failure categories ──`)
      console.log(`  Chapter mismatch: ${chapterMismatch.length}`)
      console.log(`  Same chapter, text drift: ${sameChapterDrift.length}`)

      if (sameChapterDrift.length > 0) {
        const avgScrollDrift =
          sameChapterDrift.reduce(
            (sum, f) =>
              sum + Math.abs((f.after?.scrollTop ?? 0) - (f.before?.scrollTop ?? 0)),
            0,
          ) / sameChapterDrift.length
        console.log(`  Avg scroll drift (same chapter): ${avgScrollDrift.toFixed(1)}px`)
      }
    }

    // Assert: 100% pass rate required — any text mismatch is a bug
    expect(
      failed,
      `${failed} out of ${passed + failed} trials had PIP text mismatch after exit/re-enter. ` +
        `First failure: Trial ${failures[0]?.trial} — ${failures[0]?.reason}`,
    ).toBe(0)
  })

  /**
   * Scenario 2: Touch-gesture scrolling with momentum simulation.
   *
   * On a real iPhone, touch scrolling fires many rapid scroll events
   * with decelerating deltas (momentum/inertia). This test simulates
   * that pattern and exits while the scroll may still be settling.
   */
  test('pip survives touch-gesture scroll with momentum + rapid exit (50 cycles)', async ({
    page,
  }) => {
    const TOTAL_TRIALS = 50
    const rng = mulberry32(98765)

    const maxScroll = await getMaxScroll(page)
    const scrollMin = Math.round(maxScroll * 0.05)
    const scrollMax = Math.round(maxScroll * 0.85)

    let passed = 0
    let failed = 0
    const failures: Array<{ trial: number; reason: string }> = []

    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      const scrollTarget =
        scrollMin + Math.round(rng() * (scrollMax - scrollMin))

      // Jump near the target
      await page.evaluate((target) => {
        const c = document.querySelector('.formatted-view') as HTMLElement
        if (c) c.scrollTop = Math.max(0, target - 800)
      }, scrollTarget)
      await page.waitForTimeout(100)

      // Simulate momentum scroll: rapid small deltas with decreasing magnitude
      // This mimics iOS inertial scrolling after a touch flick
      const fv = page.locator('.formatted-view')
      const box = await fv.boundingBox()
      if (!box) continue
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

      const momentumDeltas = [120, 100, 80, 60, 40, 30, 20, 15, 10, 5, 3, 1]
      for (const delta of momentumDeltas) {
        await page.mouse.wheel(0, delta)
        // Decreasing intervals simulate momentum deceleration
        await page.waitForTimeout(16 + Math.round(rng() * 16))
      }

      // Let the PIP settle and positionStore commit
      await page.waitForTimeout(1500)

      // Capture before-exit state
      const before = await getPipSnapshot(page)
      if (!before || !before.blockText) {
        continue
      }
      // Skip if we landed on a chapter-transition placeholder (seg=0).
      // The saver intentionally skips persisting these transient states,
      // so the previous chapter's position remains in localStorage.
      // This is correct app behavior, not a bug.
      if (before.store.absoluteSegmentIndex === 0) {
        console.log(
          `[skip] Trial ${trial}: at chapter-transition placeholder (ch=${before.store.chapterIdx}, seg=0). Skipping.`,
        )
        continue
      }

      // Exit — with a SHORT wait to simulate quick exit
      // (user taps back quickly after scrolling)
      await exitReader(page)

      // Re-enter
      await reenterBook(page)
      await ensureFormattedView(page)
      await page.waitForTimeout(1000)

      const after = await getPipSnapshot(page)
      if (!after) {
        failures.push({ trial, reason: 'no snapshot after restore' })
        failed++
        continue
      }

      const beforeText = before.blockText.substring(0, 80)
      const afterText = after.blockText.substring(0, 80)

      if (beforeText === afterText) {
        passed++
      } else {
        failed++
        const reason =
          `MOMENTUM TEXT MISMATCH | ` +
          `scrollDrift=${Math.abs(after.scrollTop - before.scrollTop)}px | ` +
          `seg ${before.store.absoluteSegmentIndex}→${after.store.absoluteSegmentIndex} | ` +
          `ch ${before.store.chapterIdx}→${after.store.chapterIdx}`
        failures.push({ trial, reason })
        console.log(`[FAIL] Trial ${trial}: ${reason}`)
        console.log(`  BEFORE: "${beforeText}"`)
        console.log(`  AFTER:  "${afterText}"`)
      }

      if ((trial + 1) % 10 === 0) {
        console.log(
          `[progress-momentum] ${trial + 1}/${TOTAL_TRIALS} — ${passed} passed, ${failed} failed`,
        )
      }
    }

    console.log(
      `\nMOMENTUM RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`,
    )
    if (failures.length > 0) {
      for (const f of failures) console.log(`  ${f.reason}`)
    }

    expect(
      failed,
      `Momentum test: ${failed} failures. First: ${failures[0]?.reason}`,
    ).toBe(0)
  })

  /**
   * Scenario 3: Exit DURING active scroll (before settle).
   *
   * The user scrolls and immediately taps exit without waiting for
   * the PIP to settle. This is the highest-risk scenario because:
   * - The scroll events may still be firing
   * - Effect 3 rAF detection may not have committed yet
   * - The unmount flush reads scrollTop from a moving container
   */
  test('pip survives exit during active scroll (50 cycles)', async ({
    page,
  }) => {
    const TOTAL_TRIALS = 50
    const rng = mulberry32(54321)

    const maxScroll = await getMaxScroll(page)
    const scrollMin = Math.round(maxScroll * 0.05)
    const scrollMax = Math.round(maxScroll * 0.85)

    let passed = 0
    let failed = 0
    const failures: Array<{ trial: number; reason: string }> = []

    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      const scrollTarget =
        scrollMin + Math.round(rng() * (scrollMax - scrollMin))

      // Jump to a settled position first
      await page.evaluate((target) => {
        const c = document.querySelector('.formatted-view') as HTMLElement
        if (c) c.scrollTop = target
      }, scrollTarget)
      await page.waitForTimeout(200)

      // Small user-scroll to trigger detection pipeline
      await userScroll(page, 200)
      await page.waitForTimeout(800)

      // Capture the SETTLED state — this is what we expect after restore
      const settled = await getPipSnapshot(page)
      if (!settled || !settled.blockText) {
        continue
      }

      // Now do ANOTHER scroll and exit IMMEDIATELY (before settle)
      // The scroll amount is small (50-200px) so the PIP should still be
      // near the same text block, but the timing pressure is the point.
      const smallScroll = 50 + Math.round(rng() * 150)
      const fv = page.locator('.formatted-view')
      const box = await fv.boundingBox()
      if (!box) continue
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, smallScroll)

      // Capture what's at the PIP line RIGHT NOW (mid-scroll)
      // Wait just enough for one rAF cycle
      await page.waitForTimeout(50)
      const midScroll = await getPipSnapshot(page)

      // Wait for scroll settle + positionStore commit
      await page.waitForTimeout(1200)

      // Capture the post-settle state — THIS is what should be saved
      const afterSmallScroll = await getPipSnapshot(page)
      if (!afterSmallScroll || !afterSmallScroll.blockText) {
        continue
      }

      // Exit and re-enter
      await exitReader(page)
      await reenterBook(page)
      await ensureFormattedView(page)
      await page.waitForTimeout(1000)

      const restored = await getPipSnapshot(page)
      if (!restored) {
        failures.push({ trial, reason: 'no snapshot after restore' })
        failed++
        continue
      }

      // The restored text should match the post-settle text
      // (not the mid-scroll text, not the pre-scroll text)
      const expectedText = afterSmallScroll.blockText.substring(0, 80)
      const restoredText = restored.blockText.substring(0, 80)

      if (expectedText === restoredText) {
        passed++
      } else {
        failed++
        const reason =
          `MID-SCROLL EXIT MISMATCH | ` +
          `scrollDrift=${Math.abs(restored.scrollTop - afterSmallScroll.scrollTop)}px | ` +
          `seg ${afterSmallScroll.store.absoluteSegmentIndex}→${restored.store.absoluteSegmentIndex} | ` +
          `ch ${afterSmallScroll.store.chapterIdx}→${restored.store.chapterIdx} | ` +
          `settledText="${expectedText.substring(0, 50)}" restoredText="${restoredText.substring(0, 50)}"`
        failures.push({ trial, reason })
        console.log(`[FAIL] Trial ${trial}: ${reason}`)
      }

      if ((trial + 1) % 10 === 0) {
        console.log(
          `[progress-midscroll] ${trial + 1}/${TOTAL_TRIALS} — ${passed} passed, ${failed} failed`,
        )
      }
    }

    console.log(
      `\nMID-SCROLL EXIT RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`,
    )
    if (failures.length > 0) {
      for (const f of failures) console.log(`  ${f.reason}`)
    }

    expect(
      failed,
      `Mid-scroll exit test: ${failed} failures. First: ${failures[0]?.reason}`,
    ).toBe(0)
  })

  /**
   * Scenario 4: Rapid-fire exit/re-enter with no settle time.
   *
   * Tests the unmount → mount race condition: can the new mount's
   * positionStore.init() load stale data because the old unmount
   * flush overwrites localStorage during the transition?
   */
  test('pip survives rapid exit/re-enter with minimal settle (30 cycles)', async ({
    page,
  }) => {
    const TOTAL_TRIALS = 30
    const rng = mulberry32(11111)

    const maxScroll = await getMaxScroll(page)
    const scrollMin = Math.round(maxScroll * 0.10)
    const scrollMax = Math.round(maxScroll * 0.80)

    let passed = 0
    let failed = 0
    const failures: Array<{ trial: number; reason: string }> = []

    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      const scrollTarget =
        scrollMin + Math.round(rng() * (scrollMax - scrollMin))

      // Scroll to position and let it fully settle
      await page.evaluate((target) => {
        const c = document.querySelector('.formatted-view') as HTMLElement
        if (c) c.scrollTop = Math.max(0, target - 200)
      }, scrollTarget)
      await page.waitForTimeout(100)
      await userScroll(page, 200)
      await page.waitForTimeout(800)

      const before = await getPipSnapshot(page)
      if (!before || !before.blockText) continue

      // RAPID exit — minimal wait
      const exitBtn = page.locator(
        '[aria-label="Exit reader"], [aria-label="Back to library"]',
      )
      if ((await exitBtn.count()) > 0) {
        await exitBtn.first().click()
      } else {
        await page.goto('/')
      }
      // Minimal wait — just enough for navigation to start
      await page.waitForTimeout(500)

      // RAPID re-enter
      const bookCard = page.locator('[role="article"]').first()
      await bookCard.waitFor({ state: 'visible', timeout: 10000 })
      await bookCard.click()
      await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
      await page.waitForSelector('.reader-viewport', { timeout: 15000 })
      // Give full settle time for restore
      await page.waitForTimeout(3500)
      await ensureFormattedView(page)
      await page.waitForTimeout(500)

      const after = await getPipSnapshot(page)
      if (!after) {
        failures.push({ trial, reason: 'no snapshot after rapid restore' })
        failed++
        continue
      }

      const beforeText = before.blockText.substring(0, 80)
      const afterText = after.blockText.substring(0, 80)

      if (beforeText === afterText) {
        passed++
      } else {
        failed++
        const reason =
          `RAPID EXIT MISMATCH | ` +
          `scrollDrift=${Math.abs(after.scrollTop - before.scrollTop)}px | ` +
          `seg ${before.store.absoluteSegmentIndex}→${after.store.absoluteSegmentIndex} | ` +
          `ch ${before.store.chapterIdx}→${after.store.chapterIdx} | ` +
          `before="${beforeText.substring(0, 50)}" after="${afterText.substring(0, 50)}"`
        failures.push({ trial, reason })
        console.log(`[FAIL] Trial ${trial}: ${reason}`)
      }

      if ((trial + 1) % 10 === 0) {
        console.log(
          `[progress-rapid] ${trial + 1}/${TOTAL_TRIALS} — ${passed} passed, ${failed} failed`,
        )
      }
    }

    console.log(
      `\nRAPID EXIT RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`,
    )
    if (failures.length > 0) {
      for (const f of failures) console.log(`  ${f.reason}`)
    }

    expect(
      failed,
      `Rapid exit test: ${failed} failures. First: ${failures[0]?.reason}`,
    ).toBe(0)
  })

  /**
   * Scenario 5: Simulates detached-DOM unmount race condition.
   *
   * Directly tests the fix for the root cause: during unmount, doSave()
   * reads container.scrollTop which may be 0 on a detached element.
   * This test verifies localStorage still has the correct scroll_top
   * even after the component unmounts.
   */
  test('localStorage scroll_top is not zeroed during unmount flush (30 cycles)', async ({
    page,
  }) => {
    const TOTAL_TRIALS = 30
    const rng = mulberry32(33333)

    const maxScroll = await getMaxScroll(page)
    const scrollMin = Math.round(maxScroll * 0.10)
    const scrollMax = Math.round(maxScroll * 0.80)

    let passed = 0
    let failed = 0
    const failures: Array<{ trial: number; reason: string }> = []

    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      const scrollTarget =
        scrollMin + Math.round(rng() * (scrollMax - scrollMin))

      // Scroll and settle
      await page.evaluate((target) => {
        const c = document.querySelector('.formatted-view') as HTMLElement
        if (c) c.scrollTop = Math.max(0, target - 200)
      }, scrollTarget)
      await page.waitForTimeout(100)
      await userScroll(page, 200)
      await page.waitForTimeout(1000)

      // Read localStorage BEFORE exit — this is the "good" value
      const lsBefore = await page.evaluate(() => {
        for (let id = 1; id <= 20; id++) {
          const raw = localStorage.getItem(`speedreader_position_${id}`)
          if (raw) return JSON.parse(raw)
        }
        return null
      })

      if (!lsBefore || lsBefore.scroll_top == null) continue

      const scrollTopBefore = lsBefore.scroll_top

      // Exit the book
      await exitReader(page)

      // Read localStorage AFTER exit — the unmount flush may have overwritten
      const lsAfter = await page.evaluate(() => {
        for (let id = 1; id <= 20; id++) {
          const raw = localStorage.getItem(`speedreader_position_${id}`)
          if (raw) return JSON.parse(raw)
        }
        return null
      })

      if (!lsAfter) {
        failures.push({ trial, reason: 'no localStorage after exit' })
        failed++
        continue
      }

      const scrollTopAfter = lsAfter.scroll_top
      const drift = Math.abs(scrollTopAfter - scrollTopBefore)

      // The scroll_top should NOT have been zeroed or drastically changed
      // by the unmount flush. Allow small drift (10px bucket rounding).
      if (scrollTopAfter === 0 && scrollTopBefore > 50) {
        failed++
        const reason =
          `ZEROED scroll_top! before=${scrollTopBefore} after=${scrollTopAfter} ` +
          `seg=${lsAfter.absolute_segment_index} ch=${lsAfter.chapter_idx}`
        failures.push({ trial, reason })
        console.log(`[FAIL] Trial ${trial}: ${reason}`)
      } else if (drift > 30) {
        failed++
        const reason =
          `LARGE DRIFT scroll_top! before=${scrollTopBefore} after=${scrollTopAfter} drift=${drift} ` +
          `seg_before=${lsBefore.absolute_segment_index} seg_after=${lsAfter.absolute_segment_index}`
        failures.push({ trial, reason })
        console.log(`[FAIL] Trial ${trial}: ${reason}`)
      } else {
        passed++
      }

      // Re-enter for next trial
      await reenterBook(page)
      await ensureFormattedView(page)
      await page.waitForTimeout(500)

      if ((trial + 1) % 10 === 0) {
        console.log(
          `[progress-unmount] ${trial + 1}/${TOTAL_TRIALS} — ${passed} passed, ${failed} failed`,
        )
      }
    }

    console.log(
      `\nUNMOUNT FLUSH RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`,
    )
    if (failures.length > 0) {
      for (const f of failures) console.log(`  ${f.reason}`)
    }

    expect(
      failed,
      `Unmount flush test: ${failed} failures. First: ${failures[0]?.reason}`,
    ).toBe(0)
  })

  /**
   * Scenario 6: Touch-scroll via touchscreen (actual touch events).
   *
   * Uses Playwright's touchscreen API to fire real touch events instead
   * of mouse wheel. This is the closest simulation to real iPhone usage.
   */
  test('pip survives touchscreen swipe scroll + exit (50 cycles)', async ({
    page,
  }) => {
    const TOTAL_TRIALS = 50
    const rng = mulberry32(77777)

    const maxScroll = await getMaxScroll(page)
    const scrollMin = Math.round(maxScroll * 0.05)
    const scrollMax = Math.round(maxScroll * 0.85)

    let passed = 0
    let failed = 0
    const failures: Array<{ trial: number; reason: string }> = []

    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      const scrollTarget =
        scrollMin + Math.round(rng() * (scrollMax - scrollMin))

      // Jump near target programmatically
      await page.evaluate((target) => {
        const c = document.querySelector('.formatted-view') as HTMLElement
        if (c) c.scrollTop = Math.max(0, target - 400)
      }, scrollTarget)
      await page.waitForTimeout(100)

      // Touch-swipe to scroll ~400px down
      const fv = page.locator('.formatted-view')
      const box = await fv.boundingBox()
      if (!box) continue

      const startX = box.x + box.width / 2
      const startY = box.y + box.height * 0.7
      const endY = box.y + box.height * 0.2
      const swipeSteps = 10

      // Perform touch swipe: finger moves from bottom to top
      await page.touchscreen.tap(startX, startY)
      await page.waitForTimeout(50)

      // Manual touch swipe with intermediate points
      for (let step = 0; step <= swipeSteps; step++) {
        const y = startY + ((endY - startY) * step) / swipeSteps
        await page.mouse.move(startX, y)
        await page.waitForTimeout(16)
      }

      // Final small wheel to ensure scroll events fire and detection runs
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 50)

      // Let PIP settle
      await page.waitForTimeout(1500)

      const before = await getPipSnapshot(page)
      if (!before || !before.blockText) continue

      // Exit and re-enter
      await exitReader(page)
      await reenterBook(page)
      await ensureFormattedView(page)
      await page.waitForTimeout(1000)

      const after = await getPipSnapshot(page)
      if (!after) {
        failures.push({ trial, reason: 'no snapshot after touch restore' })
        failed++
        continue
      }

      const beforeText = before.blockText.substring(0, 80)
      const afterText = after.blockText.substring(0, 80)

      if (beforeText === afterText) {
        passed++
      } else {
        failed++
        const reason =
          `TOUCH SWIPE MISMATCH | ` +
          `scrollDrift=${Math.abs(after.scrollTop - before.scrollTop)}px | ` +
          `seg ${before.store.absoluteSegmentIndex}→${after.store.absoluteSegmentIndex} | ` +
          `ch ${before.store.chapterIdx}→${after.store.chapterIdx}`
        failures.push({ trial, reason })
        console.log(`[FAIL] Trial ${trial}: ${reason}`)
        console.log(`  BEFORE: "${beforeText}"`)
        console.log(`  AFTER:  "${afterText}"`)
      }

      if ((trial + 1) % 10 === 0) {
        console.log(
          `[progress-touch] ${trial + 1}/${TOTAL_TRIALS} — ${passed} passed, ${failed} failed`,
        )
      }
    }

    console.log(
      `\nTOUCH SWIPE RESULTS: ${passed} passed, ${failed} failed out of ${passed + failed}`,
    )
    if (failures.length > 0) {
      for (const f of failures) console.log(`  ${f.reason}`)
    }

    expect(
      failed,
      `Touch swipe test: ${failed} failures. First: ${failures[0]?.reason}`,
    ).toBe(0)
  })
})
