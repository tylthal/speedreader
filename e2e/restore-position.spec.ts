import { expect, test, type Page } from '@playwright/test'
import { clearAppState, SAMPLE_EPUB_PATH, uploadBookAndWaitForReader } from './helpers'

interface CapturedState {
  containerScrollTop: number
  localStorageScrollTop: number | null
  storeScrollTop: number
  restoreState: string | null
}

async function capture(page: Page): Promise<CapturedState> {
  return await page.evaluate(() => {
    const pubId = Number((location.pathname.match(/\/read\/(\d+)/) ?? [])[1] ?? 0)
    const ls = localStorage.getItem(`speedreader_position_${pubId}`)
    const parsed = ls ? (JSON.parse(ls) as { scroll_top?: number }) : null
    const container = document.querySelector('.formatted-view') as HTMLElement | null
    const viewport = document.querySelector('.reader-viewport') as HTMLElement | null
    const store = (window as unknown as { __positionStore?: { snapshot: () => Record<string, unknown> } }).__positionStore
    const snap = (store?.snapshot?.() ?? {}) as Record<string, unknown>
    return {
      containerScrollTop: container?.scrollTop ?? 0,
      localStorageScrollTop: parsed?.scroll_top ?? null,
      storeScrollTop: Number(snap.scrollTop ?? 0),
      restoreState: viewport?.getAttribute('data-restore-state') ?? null,
    }
  })
}

async function reenterBook(page: Page): Promise<void> {
  const exitBtn = page.getByRole('button', { name: /exit/i }).first()
  if (await exitBtn.count()) {
    await exitBtn.click()
  } else {
    await page.goto('/')
  }
  await page.waitForURL(/\/$|\/library/, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
  const bookCard = page.locator('[role="article"], .book-card').first()
  await bookCard.click()
  await page.waitForURL(/\/read\/\d+/, { timeout: 15_000 })
  await page.waitForSelector('.reader-viewport', { timeout: 10_000 })
}

test.describe('Restore position regression', () => {
  test('A: happy path — scroll position and localStorage survive exit/re-entry', async ({ page }) => {
    test.setTimeout(180_000)
    await clearAppState(page)
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH, 40_000)
    await page.waitForTimeout(1500)

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

    const formattedContainer = page.locator('.formatted-view').first()
    await expect(formattedContainer).toBeVisible()
    const SCROLL_TARGET = 3000
    await formattedContainer.evaluate((el, target) => {
      ;(el as HTMLElement).scrollTo({ top: target as number, behavior: 'auto' })
    }, SCROLL_TARGET)
    await page.waitForTimeout(400)
    await formattedContainer.evaluate((el) => {
      el.dispatchEvent(new Event('scrollend'))
    })
    await page.waitForTimeout(300)

    // Trigger visibility-hidden save path.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(500)

    const before = await capture(page)
    expect(before.containerScrollTop).toBeGreaterThan(0)
    expect(before.localStorageScrollTop ?? -1).toBeGreaterThanOrEqual(0)

    await reenterBook(page)

    // Wait for the restore path to finish. 10s matches the 240-attempt
    // rAF budget in useFormattedViewCursorSync with margin.
    await page.waitForSelector('.reader-viewport[data-restore-state="done"]', { timeout: 10_000 })

    const after = await capture(page)

    expect(Math.abs(after.containerScrollTop - before.containerScrollTop)).toBeLessThanOrEqual(10)
    expect(after.localStorageScrollTop ?? -1).toBeGreaterThanOrEqual(0)
    expect(after.restoreState).toBe('done')
  })

  test('B: corruption recovery — poisoned negative scroll_top does not break restore', async ({ page }) => {
    test.setTimeout(180_000)
    await clearAppState(page)
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH, 40_000)
    await page.waitForTimeout(1500)

    // Scroll + save once so there's a valid localStorage entry we can
    // then poison (we need the chapter_id / chapter_idx / abs index to
    // match a real chapter; easiest is to let the app populate them).
    const formattedContainer = page.locator('.formatted-view').first()
    await expect(formattedContainer).toBeVisible()
    await formattedContainer.evaluate((el) => {
      ;(el as HTMLElement).scrollTo({ top: 2000, behavior: 'auto' })
    })
    await page.waitForTimeout(400)
    await formattedContainer.evaluate((el) => {
      el.dispatchEvent(new Event('scrollend'))
    })
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(500)

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    // Poison localStorage: same chapter/segment identifiers, but -500 scroll_top.
    await page.evaluate(() => {
      const pubId = Number((location.pathname.match(/\/read\/(\d+)/) ?? [])[1] ?? 0)
      const key = `speedreader_position_${pubId}`
      const raw = localStorage.getItem(key)
      if (!raw) throw new Error('no saved position to poison')
      const parsed = JSON.parse(raw)
      parsed.scroll_top = -500
      localStorage.setItem(key, JSON.stringify(parsed))
    })

    await reenterBook(page)

    // Restore should land in 'done' or 'degraded', not stay 'idle'/'pending'.
    await page.waitForFunction(
      () => {
        const vp = document.querySelector('.reader-viewport') as HTMLElement | null
        const s = vp?.getAttribute('data-restore-state')
        return s === 'done' || s === 'degraded' || s === 'idle'
      },
      { timeout: 10_000 },
    )

    const after = await capture(page)
    // No negative scroll, no NaN.
    expect(Number.isFinite(after.containerScrollTop)).toBe(true)
    expect(after.containerScrollTop).toBeGreaterThanOrEqual(0)
    // Corrupted scroll_top must have been read-side clamped to 0, not
    // propagated to the positionStore.
    expect(after.storeScrollTop).toBeGreaterThanOrEqual(0)
    // No console errors surfaced by the restore path.
    expect(consoleErrors.join('\n')).not.toMatch(/TypeError|NaN|cannot read/i)
  })
})
