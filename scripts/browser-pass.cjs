const { chromium } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const BASE = process.env.BROWSER_PASS_BASE_URL || 'http://127.0.0.1:4173/'
const BROWSER_LIBS_ROOT = path.join(REPO_ROOT, '.browser-libs', 'root')
const BOOK_DIR = process.env.BROWSER_PASS_BOOK_DIR || path.join(REPO_ROOT, 'testbook')
const BOOK_FILTER = process.env.BROWSER_PASS_FILTER || ''
const BOOK_INDICES = (process.env.BROWSER_PASS_INDICES || '')
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((v) => Number.isFinite(v))
const CHROME = process.env.BROWSER_PASS_CHROME || undefined

function browserRuntimeEnv(rootDir) {
  return {
    LD_LIBRARY_PATH:
      process.env.LD_LIBRARY_PATH ||
      [
        path.join(rootDir, 'usr/lib/x86_64-linux-gnu'),
        path.join(rootDir, 'lib/x86_64-linux-gnu'),
        path.join(rootDir, 'usr/lib'),
        path.join(rootDir, 'lib'),
      ].join(':'),
    FONTCONFIG_PATH: process.env.FONTCONFIG_PATH || path.join(rootDir, 'etc/fonts'),
    FONTCONFIG_FILE: process.env.FONTCONFIG_FILE || 'fonts.conf',
    XDG_DATA_DIRS:
      process.env.XDG_DATA_DIRS ||
      [path.join(rootDir, 'usr/share'), path.join(rootDir, 'usr/local/share')].join(':'),
  }
}

function ensureBrowserRuntime() {
  if (process.platform !== 'linux') {
    return
  }

  if (process.env.LD_LIBRARY_PATH || fs.existsSync(BROWSER_LIBS_ROOT)) {
    return
  }

  const setupScript = path.join(__dirname, 'setup-browser-libs.py')
  const result = spawnSync('python3', [setupScript], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    throw new Error(`browser runtime setup failed with exit code ${result.status ?? 'unknown'}`)
  }
}

function launchEnv() {
  if (process.platform !== 'linux') {
    return process.env
  }

  if (!process.env.LD_LIBRARY_PATH && !fs.existsSync(BROWSER_LIBS_ROOT)) {
    return process.env
  }

  return {
    ...process.env,
    ...browserRuntimeEnv(BROWSER_LIBS_ROOT),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function clearState(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
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
            new Promise((resolve) => {
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
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
}

async function snapshot(page) {
  return page.evaluate(() => {
    const fv = document.querySelector('.formatted-view')
    const ps = window.__positionStore?.snapshot?.() ?? null
    return {
      scrollTop: fv?.scrollTop ?? null,
      chapterIdx: ps?.chapterIdx ?? null,
      absoluteSegmentIndex: ps?.absoluteSegmentIndex ?? null,
      formattedLinkCount: document.querySelectorAll('.formatted-view a').length,
    }
  })
}

async function run() {
  ensureBrowserRuntime()

  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    env: launchEnv(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  const books = fs
    .readdirSync(BOOK_DIR)
    .filter((name) => name.endsWith('.epub'))
    .filter((name) => !BOOK_FILTER || name.includes(BOOK_FILTER))
    .sort()

  const results = []

  for (const bookName of books) {
    console.log(`[browser-pass] start ${bookName}`)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (error) => {
      console.error('[pageerror]', bookName, error.message)
    })

    try {
      await clearState(page)
      console.log(`[browser-pass] upload ${bookName}`)
      await page
        .locator('input[type="file"]')
        .setInputFiles(path.join(BOOK_DIR, bookName))
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        if (/\/read\/\d+/.test(page.url())) break
        if (await page.locator('.reader-viewport').count()) break
        if (await page.locator('[role="article"]').count()) {
          await page.locator('[role="article"]').first().click()
          await sleep(500)
        } else {
          await sleep(500)
        }
      }
      await page.waitForURL(/\/read\/\d+/, { timeout: 30000 })
      await page.waitForSelector('.reader-viewport', { timeout: 30000 })
      await sleep(6000)
      console.log(`[browser-pass] reader-ready ${bookName}`)

      await page.getByLabel('Open table of contents').click()
      await page.waitForSelector('.toc-sidebar', { timeout: 10000 })
      await sleep(500)

      const tocItems = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.toc-sidebar__item'))
          .filter((el) => el.tagName === 'BUTTON')
          .map((el, i) => ({ i, title: (el.textContent || '').trim() })),
      )

      const uniqueIndices =
        BOOK_INDICES.length > 0
          ? [...new Set(BOOK_INDICES)].filter((i) => i >= 0 && i < tocItems.length)
          : [
              ...new Set([
                0,
                1,
                2,
                Math.floor((tocItems.length - 1) / 2),
                tocItems.length - 1,
              ]),
            ].filter((i) => i >= 0 && i < tocItems.length)

      const linkCount = await page.evaluate(
        () => document.querySelectorAll('.formatted-view a').length,
      )

      const clickResults = []
      for (const idx of uniqueIndices) {
        if (!(await page.locator('.toc-sidebar').count())) {
          await page.getByLabel('Open table of contents').click()
          await page.waitForSelector('.toc-sidebar', { timeout: 10000 })
          await sleep(400)
        }

        const before = await snapshot(page)
        const title = tocItems[idx]?.title ?? `#${idx}`
        console.log(`[browser-pass] click ${bookName} :: ${idx} :: ${title}`)
        await page
          .locator('.toc-sidebar__item')
          .filter({ hasText: title })
          .first()
          .click()
        await sleep(2500)
        const after = await snapshot(page)
        const changed =
          after.chapterIdx !== before.chapterIdx ||
          after.absoluteSegmentIndex !== before.absoluteSegmentIndex ||
          (after.scrollTop != null &&
            before.scrollTop != null &&
            Math.abs(after.scrollTop - before.scrollTop) > 40)

        clickResults.push({ idx, title, before, after, changed })
      }

      results.push({
        bookName,
        tocCount: tocItems.length,
        formattedLinkCount: linkCount,
        clicks: clickResults,
      })
      console.log(`[browser-pass] done ${bookName}`)
    } catch (error) {
      console.log(`[browser-pass] fail ${bookName}`)
      results.push({
        bookName,
        error: error?.stack || String(error),
      })
    } finally {
      await page.close()
    }
  }

  await browser.close()
  console.log(JSON.stringify(results, null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
