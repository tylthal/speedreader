import { expect, test } from '@playwright/test'
import { clearAppState, SAMPLE_EPUB_PATH, uploadBookAndWaitForReader } from './helpers'

interface DiagSnapshot {
  chapterIdx: number
  chapterId: number
  absoluteSegmentIndex: number
  wordIndex: number
  scrollTop: number
  origin: string
  localStorage: string | null
  lastOpenedBookmark: unknown
  farthestReadBookmark: unknown
  containerScrollTop: number | null
}

async function captureState(page: import('@playwright/test').Page): Promise<DiagSnapshot> {
  return await page.evaluate(async () => {
    const store = (window as unknown as { __positionStore?: { snapshot: () => Record<string, unknown> } }).__positionStore
    const snap = (store?.snapshot?.() ?? {}) as Record<string, unknown>
    const pubId = Number((location.pathname.match(/\/read\/(\d+)/) ?? [])[1] ?? 0)
    const ls = localStorage.getItem(`speedreader_position_${pubId}`)

    // Read bookmarks directly from IndexedDB
    const readBookmark = async (type: 'last_opened' | 'farthest_read') => {
      return await new Promise((resolve) => {
        const req = indexedDB.open('speedreader')
        req.onsuccess = () => {
          const db = req.result
          try {
            const tx = db.transaction('bookmarks', 'readonly')
            const idx = tx.objectStore('bookmarks').index('[publication_id+type]')
            const getReq = idx.get([pubId, type])
            getReq.onsuccess = () => resolve(getReq.result ?? null)
            getReq.onerror = () => resolve(null)
          } catch {
            resolve(null)
          }
        }
        req.onerror = () => resolve(null)
      })
    }

    const container = document.querySelector('.formatted-view') as HTMLElement | null

    return {
      chapterIdx: Number(snap.chapterIdx ?? -1),
      chapterId: Number(snap.chapterId ?? -1),
      absoluteSegmentIndex: Number(snap.absoluteSegmentIndex ?? -1),
      wordIndex: Number(snap.wordIndex ?? -1),
      scrollTop: Number(snap.scrollTop ?? -1),
      origin: String(snap.origin ?? ''),
      localStorage: ls,
      lastOpenedBookmark: await readBookmark('last_opened'),
      farthestReadBookmark: await readBookmark('farthest_read'),
      containerScrollTop: container?.scrollTop ?? null,
    }
  })
}

test.describe('Restore position diagnostic', () => {
  test('position after exit/re-entry matches saved position', async ({ page }) => {
    test.setTimeout(180_000)
    await clearAppState(page)

    // Upload the EPUB and wait for the reader view
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH, 40_000)
    await page.waitForTimeout(1500)

    // Make sure we're in formatted view with segments loaded
    const viewport = page.locator('.reader-viewport')
    await expect(viewport).toBeVisible()
    await page.waitForFunction(
      () => {
        const store = (window as unknown as { __positionStore?: { snapshot: () => Record<string, unknown> } }).__positionStore
        const snap = store?.snapshot?.() ?? {}
        return typeof (snap as { chapterIdx?: number }).chapterIdx === 'number'
      },
      { timeout: 10_000 },
    )

    // Scroll the formatted-view container down by a known amount. This mirrors
    // the user's paused-mode scroll path, which is what Effect 3 converts into
    // 'user-scroll' position commits.
    const formattedContainer = page.locator('.formatted-view').first()
    await expect(formattedContainer).toBeVisible()
    const SCROLL_TARGET = 3000
    await formattedContainer.evaluate((el, target) => {
      ;(el as HTMLElement).scrollTo({ top: target as number, behavior: 'auto' })
    }, SCROLL_TARGET)
    // Dispatch a native scrollend so useFormattedViewCursorSync commits with
    // user-scroll origin and the progress saver flushes.
    await page.waitForTimeout(400)
    await formattedContainer.evaluate((el) => {
      const evt = new Event('scrollend')
      el.dispatchEvent(evt)
    })
    await page.waitForTimeout(300)

    // Let the progress saver debounce flush; also nudge with visibility-hidden
    // to trigger the immediate flush path.
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(500)

    const beforeExit = await captureState(page)
    console.log('[DIAG] beforeExit:', JSON.stringify(beforeExit, null, 2))

    // Exit to library
    const exitBtn = page.getByRole('button', { name: /exit/i }).first()
    if (await exitBtn.count()) {
      await exitBtn.click()
    } else {
      // Fallback: navigate directly
      await page.goto('/')
    }
    await page.waitForURL(/\/$|\/library/, { timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(800)

    // Re-enter the book
    const bookCard = page.locator('[role="article"], .book-card').first()
    await bookCard.click()
    await page.waitForURL(/\/read\/\d+/, { timeout: 15_000 })
    await page.waitForSelector('.reader-viewport', { timeout: 10_000 })
    // Give the FormattedView time to mount, render, and run Effect 2 auto-scroll.
    await page.waitForTimeout(3000)

    const afterReentry = await captureState(page)
    console.log('[DIAG] afterReentry:', JSON.stringify(afterReentry, null, 2))

    const mismatch = {
      chapterIdx: beforeExit.chapterIdx !== afterReentry.chapterIdx,
      absoluteSegmentIndex: beforeExit.absoluteSegmentIndex !== afterReentry.absoluteSegmentIndex,
      containerScrollTop: Math.abs((beforeExit.containerScrollTop ?? 0) - (afterReentry.containerScrollTop ?? 0)),
    }
    console.log('[DIAG] mismatch summary:', mismatch)

    // The key assertion: chapter + scrollTop should match (within a
    // small scroll tolerance). absoluteSegmentIndex is NOT asserted
    // equal post-fix: when the restore now correctly lands at the
    // saved scrollTop, Effect 3's paused-mode scroll detector updates
    // the segment index to whichever segment is at the pip reference
    // line — which is usually not the pre-exit segment 0 placeholder
    // (that was never refined because the saved location was a
    // chapter-transition placeholder). What matters is that the
    // visual scroll position matches.
    expect(afterReentry.chapterIdx).toBe(beforeExit.chapterIdx)
    // Post-fix: container scrollTop should also restore within a small
    // tolerance. Pre-fix this drifted ~1500+ px because the restore
    // scroll commits before prior sections have rendered their bodies.
    expect(Math.abs((afterReentry.containerScrollTop ?? 0) - (beforeExit.containerScrollTop ?? 0))).toBeLessThanOrEqual(20)
    // And localStorage scroll_top must never be negative.
    const poisonCheck = afterReentry.localStorage ? JSON.parse(afterReentry.localStorage) : null
    expect(Number(poisonCheck?.scroll_top ?? 0)).toBeGreaterThanOrEqual(0)
  })
})
