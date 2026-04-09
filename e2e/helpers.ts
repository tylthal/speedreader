import path from 'path'
import { fileURLToPath } from 'url'
import type { Page } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SAMPLE_TXT_PATH = path.join(__dirname, 'test-data', 'sample.txt')
export const SAMPLE_EPUB_PATH = path.join(__dirname, 'test-data', 'alice-in-wonderland.epub')

export async function clearAppState(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    try {
      localStorage.clear()
      sessionStorage.clear()
    } catch {}

    try {
      const databases = (await indexedDB.databases?.()) ?? []
      await Promise.all(
        databases.map(
          (database) =>
            new Promise<void>((resolve) => {
              if (!database.name) return resolve()
              const request = indexedDB.deleteDatabase(database.name)
              request.onsuccess = () => resolve()
              request.onerror = () => resolve()
              request.onblocked = () => resolve()
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

export async function uploadBookAndWaitForReader(
  page: Page,
  filePath: string,
  timeoutMs = 30000,
): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(filePath)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (/\/read\/\d+/.test(page.url())) break
    if (await page.locator('.reader-viewport').count()) break
    if (await page.locator('[role="article"]').count()) {
      await page.locator('[role="article"]').first().click()
      await page.waitForTimeout(500)
      continue
    }
    await page.waitForTimeout(500)
  }

  await page.waitForURL(/\/read\/\d+/, { timeout: Math.max(5000, deadline - Date.now()) })
  await page.waitForSelector('.reader-viewport', {
    timeout: Math.max(5000, deadline - Date.now()),
  })
}
