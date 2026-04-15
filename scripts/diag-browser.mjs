// Headless-Chrome diagnostic: open the app, upload the test EPUB, navigate
// to the reader, switch to formatted view, scroll, and capture every console
// message + screenshots.

import puppeteer from 'puppeteer'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const epubPath = resolve(__dirname, '..', 'testbook', 'babel-r-f-kuang-2022--annas-archive--zlib-22432456.epub')

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/home/dev/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
    '--no-zygote',
    '--font-render-hinting=none',
    '--disable-font-subpixel-positioning',
  ],
  env: {
    ...process.env,
    FONTCONFIG_PATH: '/tmp/fc-fonts/fonts',
    FONTCONFIG_FILE: '/tmp/fc-fonts/fonts/fonts.conf',
  },
  dumpio: false,
})

browser.on('disconnected', () => console.log('!!! browser disconnected'))
process.on('uncaughtException', (e) => { console.log('uncaught:', e); })
const page = await browser.newPage()
await page.setViewport({ width: 1024, height: 800 })

const logs = []
page.on('console', (msg) => {
  logs.push(`[${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('requestfailed', (req) => {
  logs.push(`[req-failed] ${req.url()} :: ${req.failure()?.errorText}`)
})

console.log('Opening app...')
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 30000 })

console.log('Wiping any existing state...')
await page.evaluate(async () => {
  try { localStorage.clear() } catch {}
  try {
    const dbs = await indexedDB.databases?.() ?? []
    for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name)
  } catch {}
  try {
    const root = await navigator.storage?.getDirectory?.()
    if (root) {
      for await (const [name] of (root).entries()) {
        await root.removeEntry(name, { recursive: true }).catch(() => {})
      }
    }
  } catch {}
})
await page.reload({ waitUntil: 'networkidle2' })
await new Promise(r => setTimeout(r, 1500))

console.log('Uploading EPUB...')
const fileInput = await page.$('input[type="file"]')
await fileInput.uploadFile(epubPath)

// Library navigates directly to /read/{id} after a successful upload.
console.log('Waiting for reader URL...')
await page.waitForFunction(() => /\/read\/\d+/.test(location.pathname), { timeout: 60000 })
console.log('At reader. Waiting for first paint...')
await new Promise(r => setTimeout(r, 3000))
await page.screenshot({ path: '/workspace/qa-screenshots/diag-02-reader-initial.png' })

const initialImgState = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('.formatted-view img'))
  return {
    formattedViewCount: document.querySelectorAll('.formatted-view').length,
    bodyCount: document.querySelectorAll('.formatted-view__body').length,
    imgCount: imgs.length,
    samples: imgs.slice(0, 5).map((i) => ({
      src: i.getAttribute('src'),
      complete: i.complete,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
    })),
  }
})
console.log('INITIAL:', JSON.stringify(initialImgState, null, 2))

console.log('Scrolling x4...')
for (const y of [200, 600, 1200, 2400]) {
  await page.evaluate((sy) => {
    const c = document.querySelector('.formatted-view')
    if (c) c.scrollTop = sy
  }, y)
  await new Promise(r => setTimeout(r, 400))
}
await page.screenshot({ path: '/workspace/qa-screenshots/diag-03-after-scroll.png' })

const afterScrollImgState = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('.formatted-view img'))
  return {
    imgCount: imgs.length,
    samples: imgs.map((i) => ({
      src: i.getAttribute('src')?.slice(0, 60),
      complete: i.complete,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
    })),
  }
})
console.log('AFTER SCROLL:', JSON.stringify(afterScrollImgState, null, 2))

// Now exit and re-enter the book.
console.log('Exiting to library...')
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2' })
await page.waitForSelector('[role="article"]', { timeout: 10000 })
await new Promise(r => setTimeout(r, 800))

console.log('Re-entering book...')
await page.click('[role="article"]')
await page.waitForFunction(() => /\/read\/\d+/.test(location.pathname), { timeout: 10000 })
await new Promise(r => setTimeout(r, 2500))
await page.screenshot({ path: '/workspace/qa-screenshots/diag-04-reentered.png' })

const reenteredImgState = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('.formatted-view img'))
  return {
    imgCount: imgs.length,
    samples: imgs.map((i) => ({
      src: i.getAttribute('src')?.slice(0, 60),
      complete: i.complete,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
    })),
  }
})
console.log('REENTERED:', JSON.stringify(reenteredImgState, null, 2))

console.log('Scrolling after re-entry...')
for (const y of [200, 600, 1200, 2400]) {
  await page.evaluate((sy) => {
    const c = document.querySelector('.formatted-view')
    if (c) c.scrollTop = sy
  }, y)
  await new Promise(r => setTimeout(r, 400))
}
await page.screenshot({ path: '/workspace/qa-screenshots/diag-05-reentered-scrolled.png' })

const reenteredScrolledState = await page.evaluate(() => {
  const imgs = Array.from(document.querySelectorAll('.formatted-view img'))
  return {
    imgCount: imgs.length,
    samples: imgs.map((i) => ({
      src: i.getAttribute('src')?.slice(0, 60),
      complete: i.complete,
      naturalWidth: i.naturalWidth,
      naturalHeight: i.naturalHeight,
    })),
  }
})
console.log('REENTERED + SCROLLED:', JSON.stringify(reenteredScrolledState, null, 2))

console.log('\n=== CONSOLE LOGS ===')
for (const l of logs) console.log(l)

await browser.close()
