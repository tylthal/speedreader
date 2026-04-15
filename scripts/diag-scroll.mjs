// Headless test that uploads the test EPUB, opens the reader, and performs
// a long continuous scroll while recording scroll positions every frame.
// Verifies that the scroll position is monotonic (no jumps backwards from
// the programmatic scroll-into-view feedback loop).

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
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
    '--no-zygote',
    '--font-render-hinting=none',
  ],
})
const page = await browser.newPage()
await page.setViewport({ width: 1024, height: 800 })

const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

console.log('Opening app + wiping state...')
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 30000 })
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

console.log('Uploading EPUB...')
const fileInput = await page.$('input[type="file"]')
await fileInput.uploadFile(epubPath)
await page.waitForFunction(() => /\/read\/\d+/.test(location.pathname), { timeout: 30000 })
await new Promise(r => setTimeout(r, 3000))
await page.screenshot({ path: '/workspace/qa-screenshots/scroll-01-initial.png' })

// Continuous scroll: increment scrollTop in small steps and record every
// few frames. Then check whether scrollTop ever moved backwards (jumped).
console.log('Starting smooth scroll test...')
const scrollSamples = await page.evaluate(async () => {
  const c = document.querySelector('.formatted-view')
  if (!c) return { error: 'no formatted-view' }
  const samples = []
  // Record before any scrolling
  samples.push({ at: 0, scrollTop: c.scrollTop, intent: c.scrollTop })

  // Use wheel events to simulate the user's actual scroll input.
  const totalSteps = 60
  const stepDelta = 60
  let intent = 0
  for (let i = 1; i <= totalSteps; i++) {
    intent += stepDelta
    c.scrollTop = intent
    // Wait one rAF
    await new Promise(r => requestAnimationFrame(r))
    samples.push({ at: i, scrollTop: c.scrollTop, intent })
  }
  return { samples, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight }
})

console.log('SAMPLES:')
console.log(JSON.stringify(scrollSamples, null, 2))

if (scrollSamples.samples) {
  let jumps = 0
  let maxBackJump = 0
  let prevTop = -1
  for (const s of scrollSamples.samples) {
    if (s.scrollTop < prevTop) {
      jumps++
      const back = prevTop - s.scrollTop
      if (back > maxBackJump) maxBackJump = back
      console.log(`!! BACKWARD JUMP at step ${s.at}: was ${prevTop}, now ${s.scrollTop} (back ${back}px), intent ${s.intent}`)
    }
    if (s.scrollTop !== s.intent) {
      console.log(`?? INTENT MISMATCH at step ${s.at}: intent ${s.intent}, actual ${s.scrollTop}, diff ${s.intent - s.scrollTop}`)
    }
    prevTop = s.scrollTop
  }
  console.log(`Backward jumps: ${jumps}, max back: ${maxBackJump}px`)
}

await page.screenshot({ path: '/workspace/qa-screenshots/scroll-02-after.png' })

console.log('\n=== CONSOLE LOGS (filtered) ===')
for (const l of logs) {
  if (l.includes('[fmt]') || l.includes('upload') || l.includes('Progress')) {
    console.log(l)
  }
}

await browser.close()
