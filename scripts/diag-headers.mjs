// Headless test that uploads the test EPUB and inspects each section's
// header structure to confirm whether our `formatted-view__title` is
// duplicating the body's leading heading.

import puppeteer from 'puppeteer'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const epubPath = resolve(
  __dirname,
  '..',
  'testbook',
  'babel-r-f-kuang-2022--annas-archive--zlib-22432456.epub',
)

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/home/dev/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote', '--font-render-hinting=none'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1024, height: 800 })

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' })
await page.evaluate(async () => {
  try { localStorage.clear() } catch {}
  try {
    const dbs = await indexedDB.databases?.() ?? []
    for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name)
  } catch {}
  try {
    const root = await navigator.storage?.getDirectory?.()
    if (root) for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true }).catch(() => {})
  } catch {}
})
await page.reload({ waitUntil: 'networkidle2' })
await new Promise(r => setTimeout(r, 1500))

const fileInput = await page.$('input[type="file"]')
await fileInput.uploadFile(epubPath)
await page.waitForFunction(() => /\/read\/\d+/.test(location.pathname), { timeout: 30000 })
await new Promise(r => setTimeout(r, 3000))

// For each section, capture: our title text + the first heading in the body.
const sections = await page.evaluate(() => {
  const out = []
  const sects = document.querySelectorAll('.formatted-view__section')
  let i = 0
  for (const s of sects) {
    if (i++ >= 12) break
    const ourTitle = s.querySelector('.formatted-view__title')?.textContent?.trim() ?? null
    const body = s.querySelector('.formatted-view__body')
    const firstHeading = body?.querySelector('h1, h2, h3, h4, h5, h6')
    out.push({
      idx: i - 1,
      ourTitle,
      bodyFirstHeadingTag: firstHeading?.tagName?.toLowerCase() ?? null,
      bodyFirstHeadingText: firstHeading?.textContent?.trim()?.slice(0, 60) ?? null,
      bodyFirstChars: body?.innerHTML?.slice(0, 200) ?? null,
    })
  }
  return out
})

console.log('SECTIONS:')
for (const s of sections) {
  console.log(`\n[${s.idx}] our: "${s.ourTitle}"`)
  console.log(`     body first heading: <${s.bodyFirstHeadingTag}> "${s.bodyFirstHeadingText}"`)
  console.log(`     duplicate? ${
    s.ourTitle && s.bodyFirstHeadingText &&
    s.ourTitle.toLowerCase() === s.bodyFirstHeadingText.toLowerCase()
      ? 'YES'
      : 'no'
  }`)
}

await page.screenshot({ path: '/workspace/qa-screenshots/headers-current.png' })
await browser.close()
