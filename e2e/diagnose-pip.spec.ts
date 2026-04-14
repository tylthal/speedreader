import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { clearAppState, uploadBookAndWaitForReader } from './helpers'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Find the Phantom epub dynamically to avoid Unicode filename issues
import fs from 'fs'
const testbookDir = path.join(__dirname, '..', 'testbook')
const phantomFile = fs.readdirSync(testbookDir).find((f) => f.includes('Phantom'))
if (!phantomFile) throw new Error('Phantom of the Opera epub not found in testbook/')
const PHANTOM_EPUB = path.join(testbookDir, phantomFile)

/**
 * Diagnostic test: captures pip position vs scroll position after each
 * incremental scroll step while paused in formatted/scroll mode.
 */

async function ensureFormattedView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]')
  await expect(toggle).toBeVisible()
  const label = await toggle.getAttribute('aria-label')
  if (label && !label.includes('Formatted')) {
    await toggle.click()
  }
  await expect(page.locator('.formatted-view')).toBeVisible()
}

async function selectScrollMode(page: Page): Promise<void> {
  const scrollSegment = page.locator('.controls__segment[aria-label*="Scroll"]')
  await expect(scrollSegment).toBeVisible()
  const isActive = await scrollSegment.getAttribute('aria-checked')
  if (isActive === 'true') return
  await scrollSegment.click()
  await expect(scrollSegment).toHaveAttribute('aria-checked', 'true')
}

test('diagnose pip position during paused scroll', async ({ page }) => {
  // Clear state and upload Phantom of the Opera
  await clearAppState(page)
  await page.goto('/')
  await uploadBookAndWaitForReader(page, PHANTOM_EPUB)

  // Wait for reader to load
  await page.waitForURL(/\/read\/\d+/, { timeout: 30000 })
  await page.waitForSelector('.reader-viewport', { timeout: 15000 })

  // Ensure formatted view + scroll mode
  await ensureFormattedView(page)
  await selectScrollMode(page)

  // Make sure we're paused
  await page.waitForTimeout(1000)
  const playBtn = page.getByLabel('Play reading')
  if (!(await playBtn.isVisible().catch(() => false))) {
    // We might be playing; pause first
    await page.getByLabel('Pause reading').click()
    await page.waitForTimeout(500)
  }

  // Wait for formatted view content to render
  await page.waitForTimeout(2000)

  // Collect initial state
  const results: Array<{
    step: number
    scrollTop: number
    clientHeight: number
    scrollHeight: number
    pipTop: number | null
    pipInViewport: boolean | null
    pipOffsetFromViewCenter: number | null
  }> = []

  // Helper to capture state
  const captureState = async (step: number) => {
    const data = await page.evaluate(() => {
      const container = document.querySelector('.formatted-view') as HTMLElement | null
      const pip = document.querySelector('.formatted-view__pip') as HTMLElement | null

      if (!container) return null

      const scrollTop = container.scrollTop
      const clientHeight = container.clientHeight
      const scrollHeight = container.scrollHeight
      const pipTopStr = pip?.style.top
      const pipTop = pipTopStr ? parseFloat(pipTopStr) : null

      let pipInViewport: boolean | null = null
      let pipOffsetFromViewCenter: number | null = null
      if (pipTop !== null) {
        pipInViewport = pipTop >= scrollTop && pipTop <= scrollTop + clientHeight
        pipOffsetFromViewCenter = pipTop - (scrollTop + clientHeight / 2)
      }

      return { scrollTop, clientHeight, scrollHeight, pipTop, pipInViewport, pipOffsetFromViewCenter }
    })

    if (data) {
      results.push({ step, ...data })
    }
  }

  // Capture initial state
  await captureState(0)

  // Perform 5 scroll steps of 300px each
  for (let i = 1; i <= 5; i++) {
    await page.evaluate(() => {
      const el = document.querySelector('.formatted-view') as HTMLElement
      if (el) el.scrollTop += 300
    })
    // Wait for any pip repositioning logic
    await page.waitForTimeout(500)
    await captureState(i)
  }

  // Also capture a 6th step after a longer wait to see if delayed repositioning happens
  await page.waitForTimeout(1500)
  await captureState(6)

  // Print the diagnostic data
  console.log('\n====== PIP POSITION DIAGNOSTIC ======')
  console.log(`Total scrollHeight: ${results[0]?.scrollHeight ?? 'N/A'}`)
  console.log(`clientHeight: ${results[0]?.clientHeight ?? 'N/A'}`)
  console.log('')
  console.log(
    'Step | scrollTop | pipTop     | pipInView | pipOffsetFromCenter',
  )
  console.log(
    '-----|-----------|------------|-----------|--------------------',
  )
  for (const r of results) {
    const pipTopStr = r.pipTop !== null ? r.pipTop.toFixed(1) : 'null'
    const inView = r.pipInViewport !== null ? (r.pipInViewport ? 'YES' : 'NO') : 'N/A'
    const offset =
      r.pipOffsetFromViewCenter !== null ? r.pipOffsetFromViewCenter.toFixed(1) : 'N/A'
    console.log(
      `  ${r.step}  | ${String(r.scrollTop.toFixed(0)).padStart(9)} | ${pipTopStr.padStart(10)} | ${inView.padStart(9)} | ${offset.toString().padStart(10)}`,
    )
  }
  console.log('')

  // Check if pip ever goes OUT of viewport (the reported bug)
  const outOfViewSteps = results.filter((r) => r.pipInViewport === false)
  if (outOfViewSteps.length > 0) {
    console.log(`BUG DETECTED: pip went out of viewport at steps: ${outOfViewSteps.map((r) => r.step).join(', ')}`)
  } else if (results.some((r) => r.pipTop === null)) {
    console.log('NOTE: pip element not found at some steps (may not be rendered when paused)')
  } else {
    console.log('pip stayed within viewport at all captured steps')
  }

  // Check if pip position changes at all during scroll
  const pipPositions = results.filter((r) => r.pipTop !== null).map((r) => r.pipTop!)
  const uniquePipPositions = [...new Set(pipPositions.map((p) => Math.round(p)))]
  console.log(`Unique pip positions (rounded): [${uniquePipPositions.join(', ')}]`)
  console.log(`scrollTop values: [${results.map((r) => Math.round(r.scrollTop)).join(', ')}]`)

  // Check for the specific bug: pip stays at old position while scroll moves
  if (pipPositions.length >= 2) {
    const pipMoved = Math.abs(pipPositions[pipPositions.length - 1] - pipPositions[0]) > 10
    const scrollMoved =
      Math.abs(results[results.length - 1].scrollTop - results[0].scrollTop) > 100
    if (scrollMoved && !pipMoved) {
      console.log('BUG CONFIRMED: scroll moved significantly but pip stayed in roughly same position')
    } else if (scrollMoved && pipMoved) {
      console.log('pip moved along with scroll — checking if it tracked correctly...')
      // Check if pip tracking was smooth or had jumps
      for (let i = 1; i < results.length; i++) {
        if (results[i].pipTop !== null && results[i - 1].pipTop !== null) {
          const pipDelta = results[i].pipTop! - results[i - 1].pipTop!
          const scrollDelta = results[i].scrollTop - results[i - 1].scrollTop
          if (Math.abs(scrollDelta) > 0) {
            console.log(
              `  Step ${results[i - 1].step}->${results[i].step}: scrollDelta=${scrollDelta.toFixed(0)}, pipDelta=${pipDelta.toFixed(0)}`,
            )
          }
        }
      }
    }
  }

  console.log('====== END DIAGNOSTIC ======\n')
})
