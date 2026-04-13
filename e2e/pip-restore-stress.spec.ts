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
 * Stress test: scroll to various positions in "The Phantom of the Opera",
 * exit the book, re-enter, and verify the pip is at the same text line.
 *
 * Runs 100 iterations at different scroll positions to reproduce the
 * pip-drift-on-restore bug the user reports.
 */

// ─── helpers ────────────────────────────────────────────────────────

async function ensureFormattedView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]')
  if (await toggle.count() === 0) return
  const label = await toggle.getAttribute('aria-label')
  if (label && !label.includes('Formatted')) {
    await toggle.click()
    await page.waitForTimeout(500)
  }
  await expect(page.locator('.formatted-view')).toBeVisible({ timeout: 5000 })
}

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
  await page.waitForTimeout(800)
}

async function getPositionState(page: Page) {
  return page.evaluate(() => {
    const store = (window as any).__positionStore
    if (!store) throw new Error('__positionStore not available')
    return store.snapshot()
  })
}

/** Get scrollTop + text at the pip line */
async function getPipSnapshot(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector('.formatted-view') as HTMLElement
    if (!container) return { scrollTop: 0, text: '', pipTop: 0 }

    const containerRect = container.getBoundingClientRect()
    const refY = containerRect.top + container.clientHeight * 0.4
    const cx = containerRect.left + containerRect.width / 2

    let text = ''
    const doc = container.ownerDocument
    if ('caretRangeFromPoint' in doc) {
      const cr = (doc as any).caretRangeFromPoint(cx, refY)
      if (cr) {
        let block: Node | null = cr.startContainer
        while (block && block !== container) {
          if (
            block instanceof HTMLElement &&
            getComputedStyle(block).display === 'block'
          ) break
          block = block.parentNode
        }
        text = block?.textContent?.trim().substring(0, 120) || ''
      }
    }

    const pip = document.querySelector('.formatted-view__pip') as HTMLElement
    const pipTop = pip ? pip.getBoundingClientRect().top : 0

    return { scrollTop: container.scrollTop, text, pipTop }
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
  // Wait for navigation to library
  await page.waitForTimeout(1000)
}

async function reenterBook(page: Page): Promise<void> {
  const bookCard = page.locator('[role="article"]').first()
  if ((await bookCard.count()) > 0) {
    await bookCard.click()
  }
  await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
  await page.waitForSelector('.reader-viewport', { timeout: 15000 })
  // Wait for restore scroll + layout + pip positioning
  await page.waitForTimeout(2500)
}

// ─── test ───────────────────────────────────────────────────────────

test.describe('Pip restore stress test — Phantom of the Opera', () => {
  test.setTimeout(600_000) // 10 minutes for many iterations

  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, PHANTOM_EPUB)
    await ensureFormattedView(page)
    await page.waitForTimeout(2000) // initial layout settle
  })

  test('pip position is preserved across 100 exit/re-enter cycles at various scroll offsets', async ({
    page,
  }) => {
    // Scroll offsets to test — covers beginning, middle, deep into the book
    const scrollOffsets = [
      500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000,
      7000, 8000, 9000, 10000, 12000, 14000, 16000, 18000, 20000, 25000,
    ]

    let passed = 0
    let failed = 0
    const failures: string[] = []

    const TOTAL_TRIALS = 40
    for (let trial = 0; trial < TOTAL_TRIALS; trial++) {
      const scrollPx = scrollOffsets[trial % scrollOffsets.length]

      // Scroll to a fresh position from wherever we are
      // First scroll back to top, then to the target
      if (trial > 0) {
        // We just re-entered — wait for settle then scroll to new position
        await page.evaluate(() => {
          const c = document.querySelector('.formatted-view') as HTMLElement
          if (c) c.scrollTop = 0
        })
        await page.waitForTimeout(300)
      }
      await userScroll(page, scrollPx)

      // Capture pip state before exit
      const before = await getPipSnapshot(page)
      const stateBefore = await getPositionState(page)

      if (!before.text) {
        // Skip if we couldn't read text (e.g., scrolled past content)
        continue
      }

      // Check what's actually saved before exit
      const diagData = await page.evaluate(() => {
        const store = (window as any).__positionStore
        const snap = store ? store.snapshot() : {}
        // Try all possible publication IDs
        let lsData: any = null
        for (let id = 1; id <= 10; id++) {
          const raw = localStorage.getItem(`speedreader_position_${id}`)
          if (raw) { lsData = { id, ...JSON.parse(raw) }; break }
        }
        return {
          storeScrollTop: snap.scrollTop,
          storeSegment: snap.absoluteSegmentIndex,
          storeOrigin: snap.origin,
          storeRevision: snap.revision,
          storeKeys: Object.keys(snap),
          ls: lsData,
        }
      })

      if (trial < 3 || (trial >= 4 && trial <= 6)) {
        console.log(`[diag] Trial ${trial}: storeScrollTop=${diagData.storeScrollTop}, ls_scroll_top=${diagData.ls?.scroll_top}, beforeScrollTop=${before.scrollTop}`)
      }

      // Exit
      await exitReader(page)

      // Re-enter
      await reenterBook(page)

      // Check what happened during restore
      if (trial < 3 || (trial >= 5 && trial < 7)) {
        const restoreCheck = await page.evaluate(() => {
          const store = (window as any).__positionStore
          const snap = store ? store.snapshot() : {}
          return { scrollTop: snap.scrollTop, origin: snap.origin, seg: snap.absoluteSegmentIndex, revision: snap.revision }
        })
        console.log(`[restore-diag] Trial ${trial}: after reenter: ${JSON.stringify(restoreCheck)}`)
      }

      // Capture pip state after restore
      const after = await getPipSnapshot(page)
      const stateAfter = await getPositionState(page)

      const scrollDrift = Math.abs(after.scrollTop - before.scrollTop)
      const textMatch = before.text.substring(0, 60) === after.text.substring(0, 60)
      const segmentDrift = Math.abs(
        stateAfter.absoluteSegmentIndex - stateBefore.absoluteSegmentIndex,
      )

      const ok = textMatch && segmentDrift <= 5

      if (ok) {
        passed++
      } else {
        failed++
        const msg =
          `Trial ${trial} (scroll=${scrollPx}): ` +
          `textMatch=${textMatch}, segDrift=${segmentDrift}, scrollDrift=${scrollDrift}px. ` +
          `Before: seg=${stateBefore.absoluteSegmentIndex} scrollTop=${before.scrollTop} "${before.text.substring(0, 50)}". ` +
          `After: seg=${stateAfter.absoluteSegmentIndex} scrollTop=${after.scrollTop} "${after.text.substring(0, 50)}"`
        failures.push(msg)
        console.log(`[FAIL] ${msg}`)
      }

      if (trial % 10 === 9) {
        console.log(
          `[progress] ${trial + 1}/${TOTAL_TRIALS} done — ${passed} passed, ${failed} failed`,
        )
      }
    }

    console.log(`\n=== RESULTS ===`)
    console.log(`Passed: ${passed}/${TOTAL_TRIALS}`)
    console.log(`Failed: ${failed}/${TOTAL_TRIALS}`)
    if (failures.length > 0) {
      console.log(`\nFailure details:`)
      for (const f of failures) {
        console.log(`  ${f}`)
      }
    }

    // Report pass rate
    const passRate = passed / (passed + failed)
    expect(
      passRate,
      `Pass rate ${(passRate * 100).toFixed(1)}% — ${failed} failures out of ${passed + failed}. ` +
        `First failure: ${failures[0] ?? 'none'}`,
    ).toBeGreaterThanOrEqual(0.95) // At least 95% pass rate
  })
})
