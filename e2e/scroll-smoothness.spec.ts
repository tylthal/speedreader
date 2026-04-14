import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { clearAppState, SAMPLE_EPUB_PATH, uploadBookAndWaitForReader } from './helpers'

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Scroll-smoothness measurement test                                 */
/* ------------------------------------------------------------------ */

test.describe('Scroll smoothness during playback', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page)
    await page.goto('/')
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH)
    await ensureFormattedView(page)
    await selectScrollMode(page)
    // Let content settle
    await page.waitForTimeout(1000)
  })

  test('frame timing and scroll position continuity during scroll playback', async ({ page }) => {
    const MEASURE_DURATION_MS = 5000

    // Start playback
    await page.getByLabel('Play reading').click()
    await page.waitForTimeout(500) // let playback ramp up

    // Collect frame timing data and scroll positions via rAF loop
    const data = await page.evaluate((durationMs: number) => {
      return new Promise<{
        frameTimestamps: number[]
        scrollPositions: number[]
      }>((resolve) => {
        const frameTimestamps: number[] = []
        const scrollPositions: number[] = []
        const scrollEl = document.querySelector('.formatted-view') as HTMLElement | null
        const startTime = performance.now()

        function tick(ts: number) {
          frameTimestamps.push(ts)
          scrollPositions.push(scrollEl ? scrollEl.scrollTop : 0)

          if (ts - startTime < durationMs) {
            requestAnimationFrame(tick)
          } else {
            resolve({ frameTimestamps, scrollPositions })
          }
        }

        requestAnimationFrame(tick)
      })
    }, MEASURE_DURATION_MS)

    // Pause playback
    await page.getByLabel('Pause reading').click()

    // --- Analysis ---
    const { frameTimestamps, scrollPositions } = data
    const frameCount = frameTimestamps.length

    // Calculate frame deltas
    const deltas: number[] = []
    for (let i = 1; i < frameTimestamps.length; i++) {
      deltas.push(frameTimestamps[i] - frameTimestamps[i - 1])
    }

    // Sort deltas for percentile calculations
    const sortedDeltas = [...deltas].sort((a, b) => a - b)
    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length
    const maxDelta = sortedDeltas[sortedDeltas.length - 1]
    const p95Index = Math.floor(sortedDeltas.length * 0.95)
    const p95Delta = sortedDeltas[p95Index]
    const p99Index = Math.floor(sortedDeltas.length * 0.99)
    const p99Delta = sortedDeltas[p99Index]

    // Count dropped frames (>20ms between frames, i.e. missed a 16.67ms vsync)
    const droppedFrames = deltas.filter((d) => d > 20).length
    // Severe jank (>50ms, i.e. 3+ missed frames)
    const severeJank = deltas.filter((d) => d > 50).length

    // Scroll position analysis
    let backwardJumps = 0
    let maxBackwardJump = 0
    let totalScrollDistance = 0
    const scrollDeltas: number[] = []
    for (let i = 1; i < scrollPositions.length; i++) {
      const sd = scrollPositions[i] - scrollPositions[i - 1]
      scrollDeltas.push(sd)
      if (sd < -0.5) {
        // backward movement beyond floating-point noise
        backwardJumps++
        maxBackwardJump = Math.max(maxBackwardJump, Math.abs(sd))
      }
      totalScrollDistance += Math.abs(sd)
    }

    // Detect discontinuities: sudden large jumps (>100px in one frame)
    const discontinuities = scrollDeltas.filter((sd) => Math.abs(sd) > 100).length

    // Check that scrolling actually happened
    const scrollRange = scrollPositions[scrollPositions.length - 1] - scrollPositions[0]

    // --- Report ---
    console.log('\n========== SCROLL SMOOTHNESS REPORT ==========')
    console.log(`Measurement duration: ${MEASURE_DURATION_MS}ms`)
    console.log(`Total frames collected: ${frameCount}`)
    console.log(`Frame deltas analyzed: ${deltas.length}`)
    console.log('')
    console.log('--- Frame Timing ---')
    console.log(`  Average frame time: ${avgDelta.toFixed(2)}ms`)
    console.log(`  Max frame time:     ${maxDelta.toFixed(2)}ms`)
    console.log(`  P95 frame time:     ${p95Delta.toFixed(2)}ms`)
    console.log(`  P99 frame time:     ${p99Delta.toFixed(2)}ms`)
    console.log(`  Dropped frames (>20ms): ${droppedFrames} (${((droppedFrames / deltas.length) * 100).toFixed(1)}%)`)
    console.log(`  Severe jank (>50ms):    ${severeJank}`)
    console.log('')
    console.log('--- Scroll Position ---')
    console.log(`  Start scrollTop:   ${scrollPositions[0].toFixed(1)}px`)
    console.log(`  End scrollTop:     ${scrollPositions[scrollPositions.length - 1].toFixed(1)}px`)
    console.log(`  Net scroll:        ${scrollRange.toFixed(1)}px`)
    console.log(`  Total distance:    ${totalScrollDistance.toFixed(1)}px`)
    console.log(`  Backward jumps:    ${backwardJumps}`)
    console.log(`  Max backward jump: ${maxBackwardJump.toFixed(2)}px`)
    console.log(`  Discontinuities (>100px): ${discontinuities}`)
    console.log('================================================\n')

    // Log the worst 10 frame deltas with their indices
    if (droppedFrames > 0) {
      const worstFrames = deltas
        .map((d, i) => ({ delta: d, index: i }))
        .filter((f) => f.delta > 20)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 10)
      console.log('Worst frame deltas:')
      for (const f of worstFrames) {
        console.log(`  Frame ${f.index}: ${f.delta.toFixed(2)}ms (scrollDelta: ${scrollDeltas[f.index]?.toFixed(2)}px)`)
      }
      console.log('')
    }

    // Assertions - these are informational but we set generous thresholds
    expect(frameCount).toBeGreaterThan(100) // should get many frames in 5s
    expect(scrollRange).toBeGreaterThan(0)  // scrolling should have happened

    // Warn-level assertions (generous): max frame time under 200ms
    expect(maxDelta).toBeLessThan(200)
  })
})
