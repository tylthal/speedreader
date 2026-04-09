import path from 'path'
import { fileURLToPath } from 'url'
import { expect, test, type Page } from '@playwright/test'

interface Snapshot {
  scrollTop: number | null
  chapterIdx: number | null
  absoluteSegmentIndex: number | null
  formattedLinkCount: number
}

interface TocCase {
  name: string
  fileName: string
  indices: number[]
  expectSameChapter?: number
}

const TESTBOOK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'testbook',
)

const CASES: TocCase[] = [
  {
    name: 'Cryptonomicon',
    fileName:
      'Cryptonomicon -- Stephenson, Neal -- 2000 -- HarperCollins -- fcd07785165915a9b9b2fe192d084027 -- Anna’s Archive.epub',
    indices: [1, 2, 63, 126],
  },
  {
    name: 'The Power of Now',
    fileName:
      'The Power of Now_ A Guide to Spiritual Enlightenment -- Tolle, Eckhart -- 2010 -- New World Library -- 05b2704b38b579637304141d8f16bfc4 -- Anna’s Archive.epub',
    indices: [10, 20, 30, 40],
    expectSameChapter: 0,
  },
  {
    name: 'Babel',
    fileName: 'babel-r-f-kuang-2022--annas-archive--zlib-22432456.epub',
    indices: [1, 2, 26, 52],
  },
]

async function clearReaderState(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {}

    try {
      const dbs = (await indexedDB.databases?.()) ?? []
      await Promise.all(
        dbs.map(
          (db) =>
            new Promise<void>((resolve) => {
              if (!db.name) return resolve()
              const req = indexedDB.deleteDatabase(db.name)
              req.onsuccess = () => resolve()
              req.onerror = () => resolve()
              req.onblocked = () => resolve()
            }),
        ),
      )
    } catch {}

    try {
      const root = await navigator.storage?.getDirectory?.()
      if (root) {
        for await (const [name] of root.entries()) {
          await root.removeEntry(name, { recursive: true }).catch(() => {})
        }
      }
    } catch {}
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
}

async function uploadAndOpenBook(
  page: Page,
  filePath: string,
) {
  await page.locator('input[type="file"]').setInputFiles(filePath)

  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    if (/\/read\/\d+/.test(page.url())) break
    if (await page.locator('.reader-viewport').count()) break
    if (await page.locator('[role="article"]').count()) {
      await page.locator('[role="article"]').first().click()
      await page.waitForTimeout(500)
    } else {
      await page.waitForTimeout(500)
    }
  }

  await page.waitForURL(/\/read\/\d+/, { timeout: 30000 })
  await page.waitForSelector('.reader-viewport', { timeout: 30000 })
  await page.waitForTimeout(6000)
}

async function openToc(page: Page) {
  if (!(await page.locator('.toc-sidebar').count())) {
    await page.getByLabel('Open table of contents').click()
    await page.waitForSelector('.toc-sidebar', { timeout: 10000 })
    await page.waitForTimeout(400)
  }
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const fv = document.querySelector('.formatted-view')
    const ps = (window as typeof window & { __positionStore?: { snapshot?: () => unknown } })
      .__positionStore?.snapshot?.() as
      | { chapterIdx?: number | null; absoluteSegmentIndex?: number | null }
      | undefined
    return {
      scrollTop: (fv as HTMLElement | null)?.scrollTop ?? null,
      chapterIdx: ps?.chapterIdx ?? null,
      absoluteSegmentIndex: ps?.absoluteSegmentIndex ?? null,
      formattedLinkCount: document.querySelectorAll('.formatted-view a').length,
    }
  })
}

function changed(before: Snapshot, after: Snapshot): boolean {
  return (
    after.chapterIdx !== before.chapterIdx ||
    after.absoluteSegmentIndex !== before.absoluteSegmentIndex ||
    (after.scrollTop != null &&
      before.scrollTop != null &&
      Math.abs(after.scrollTop - before.scrollTop) > 40)
  )
}

test.describe.configure({ mode: 'serial' })

for (const book of CASES) {
  test(`${book.name} TOC navigation stays functional`, async ({ page }) => {
    await clearReaderState(page)
    await uploadAndOpenBook(page, path.join(TESTBOOK_DIR, book.fileName))

    await expect(page.locator('.formatted-view a')).toHaveCount(0)
    await openToc(page)

    const tocItems = page.locator('button.toc-sidebar__item')
    expect(await tocItems.count()).toBeGreaterThan(book.indices[book.indices.length - 1] ?? 0)

    for (const idx of book.indices) {
      await openToc(page)
      const before = await snapshot(page)
      await tocItems.nth(idx).click()
      await page.waitForTimeout(2500)
      const after = await snapshot(page)

      expect(after.formattedLinkCount).toBe(0)
      expect(changed(before, after)).toBeTruthy()

      if (book.expectSameChapter != null) {
        expect(after.chapterIdx).toBe(book.expectSameChapter)
        expect(after.absoluteSegmentIndex ?? -1).toBeGreaterThan(before.absoluteSegmentIndex ?? -1)
      }
    }
  })
}
