import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { expect, test, type Page } from '@playwright/test'
import { clearAppState, uploadBookAndWaitForReader } from './helpers'

interface Snapshot {
  chapterIdx: number | null
  absoluteSegmentIndex: number | null
  formattedLinkCount: number
}

interface TocButtonMeta {
  index: number
  key: string
  title: string
  sectionIndex: number
  htmlAnchor: string | null
}

const TESTBOOK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'testbook',
)

const BOOKS = fs
  .readdirSync(TESTBOOK_DIR)
  .filter((fileName) => fileName.endsWith('.epub'))
  .sort()

async function uploadAndOpenBook(page: Page, filePath: string) {
  await uploadBookAndWaitForReader(page, filePath, 180000)
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
    const ps = (window as typeof window & { __positionStore?: { snapshot?: () => unknown } })
      .__positionStore?.snapshot?.() as
      | { chapterIdx?: number | null; absoluteSegmentIndex?: number | null }
      | undefined

    return {
      chapterIdx: ps?.chapterIdx ?? null,
      absoluteSegmentIndex: ps?.absoluteSegmentIndex ?? null,
      formattedLinkCount: document.querySelectorAll('.formatted-view a').length,
    }
  })
}

async function getTocButtons(page: Page): Promise<TocButtonMeta[]> {
  return page.locator('button.toc-sidebar__item').evaluateAll((buttons) =>
    buttons.map((button, index) => {
      const el = button as HTMLButtonElement
      return {
        index,
        key: el.dataset.tocKey ?? '',
        title: el.textContent?.trim() ?? '',
        sectionIndex: Number(el.dataset.sectionIndex ?? '-1'),
        htmlAnchor: el.dataset.htmlAnchor?.trim() || null,
      }
    }),
  )
}

async function expectSingleActiveItem(page: Page) {
  const activeItems = await page.locator('button.toc-sidebar__item').evaluateAll((buttons) =>
    buttons.flatMap((button, index) => {
      const el = button as HTMLButtonElement
      if (!el.classList.contains('toc-sidebar__item--active')) return []
      return [{
        index,
        key: el.dataset.tocKey ?? '',
        title: el.textContent?.trim() ?? '',
        sectionIndex: Number(el.dataset.sectionIndex ?? '-1'),
        htmlAnchor: el.dataset.htmlAnchor?.trim() || null,
      }]
    }),
  )

  expect(activeItems).toHaveLength(1)
}

async function waitForTargetVisible(page: Page, target: TocButtonMeta) {
  await page.waitForFunction(
    ({ htmlAnchor, sectionIndex }) => {
      function resolveVisibleAnchorTarget(
        anchorEl: HTMLElement,
        sectionEl: HTMLElement,
      ): HTMLElement {
        let candidate: HTMLElement | null = anchorEl
        while (candidate) {
          const rect = candidate.getBoundingClientRect()
          if (rect.width > 0 || rect.height > 0) return candidate
          candidate = candidate.nextElementSibling as HTMLElement | null
        }
        return sectionEl
      }

      const container = document.querySelector('.formatted-view') as HTMLElement | null
      const section = document.querySelector(
        `.formatted-view__section[data-section-index="${sectionIndex}"]`,
      ) as HTMLElement | null
      if (!container || !section) return false

      let targetEl: HTMLElement | null = section
      const anchor = (htmlAnchor ?? '').trim().replace(/^#/, '')
      if (anchor) {
        const idMatch = document.getElementById(anchor)
        if (idMatch instanceof HTMLElement && section.contains(idMatch)) {
          targetEl = resolveVisibleAnchorTarget(idMatch, section)
        } else {
          const namedMatch = Array.from(section.querySelectorAll('[name]')).find(
            (node) => (node as HTMLElement).getAttribute('name') === anchor,
          )
          targetEl =
            namedMatch instanceof HTMLElement
              ? resolveVisibleAnchorTarget(namedMatch, section)
              : null
        }
      }
      if (!targetEl) return false

      const containerRect = container.getBoundingClientRect()
      const targetRect = targetEl.getBoundingClientRect()

      return (
        targetRect.bottom > containerRect.top - 24 &&
        targetRect.top < containerRect.bottom - 8
      )
    },
    target,
    { timeout: 15000 },
  )
}

test.describe.configure({ mode: 'serial' })

for (const fileName of BOOKS) {
  test(`${fileName} TOC entries stay singly active and navigate to visible content`, async ({ page }) => {
    test.setTimeout(1200000)

    await clearAppState(page)
    await uploadAndOpenBook(page, path.join(TESTBOOK_DIR, fileName))

    await expect(page.locator('.formatted-view a')).toHaveCount(0)
    await openToc(page)

    const tocButtons = await getTocButtons(page)
    expect(tocButtons.length).toBeGreaterThan(0)

    const initialActiveCount = await page.locator('button.toc-sidebar__item--active').count()
    expect(initialActiveCount).toBeLessThanOrEqual(1)

    for (const button of tocButtons) {
      try {
        await openToc(page)

        await page.locator('button.toc-sidebar__item').nth(button.index).click()

        await waitForTargetVisible(page, button)
        const after = await snapshot(page)

        expect(after.formattedLinkCount).toBe(0)

        await openToc(page)
        await expectSingleActiveItem(page)
      } catch (error) {
        throw new Error(
          [
            `TOC entry failed: index=${button.index}`,
            `title=${JSON.stringify(button.title)}`,
            `sectionIndex=${button.sectionIndex}`,
            `htmlAnchor=${JSON.stringify(button.htmlAnchor)}`,
            `key=${JSON.stringify(button.key)}`,
            error instanceof Error ? error.message : String(error),
          ].join('\n'),
        )
      }
    }
  })
}
