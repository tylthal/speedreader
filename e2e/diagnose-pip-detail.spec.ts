import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

test('diagnose pip position tracking', async ({ page }) => {
  await page.goto('http://localhost:5173/')
  await page.waitForTimeout(2000)

  // Upload Phantom of the Opera epub
  const importBtn = page.getByText('Import', { exact: false })
  const fileInput = page.locator('input[type="file"]')

  // The import button triggers a hidden file input
  const files = fs.readdirSync(path.resolve('testbook'))
  const phantom = files.find((f: string) => f.includes('Phantom'))
  if (!phantom) { console.log('NO PHANTOM FILE'); return }
  const epubPath = path.resolve('testbook', phantom)

  // Set file on the hidden input — auto-navigates to reader
  await fileInput.setInputFiles(epubPath)
  await page.waitForURL(/\/read\/\d+/, { timeout: 20000 })
  await expect(page.locator('.reader-viewport')).toBeVisible()
  await page.waitForTimeout(3000) // Wait for content to render

  // Check if we're in formatted view
  const formattedView = page.locator('.formatted-view')
  const fvVisible = await formattedView.isVisible().catch(() => false)
  console.log('Formatted view visible:', fvVisible)

  if (!fvVisible) {
    console.log('Could not reach reader - checking current state')
    const state = await page.evaluate(() => ({
      url: window.location.href,
      text: document.body.innerText.slice(0, 300),
    }))
    console.log('CURRENT STATE:', JSON.stringify(state, null, 2))
    return
  }

  // === CHECK SEGMENT INDEX COVERAGE ===
  const coverage = await page.evaluate(() => {
    const container = document.querySelector('.formatted-view') as HTMLElement
    if (!container) return { error: 'no container' }

    // Find the section body
    const sections = container.querySelectorAll('.formatted-view__section')
    const bodies = container.querySelectorAll('.formatted-view__body')

    const sectionInfo = Array.from(sections).map((s, i) => {
      const body = s.querySelector('.formatted-view__body') as HTMLElement
      const titleEl = s.querySelector('.formatted-view__title')
      return {
        index: i,
        title: titleEl?.textContent?.slice(0, 40) || '(no title)',
        hasBody: !!body,
        bodyChildCount: body?.children.length || 0,
        bodyTextLength: body?.textContent?.length || 0,
      }
    })

    // Count total block elements across all sections
    let totalBlocks = 0
    bodies.forEach(b => { totalBlocks += b.children.length })

    return {
      sectionCount: sections.length,
      sectionInfo: sectionInfo.slice(0, 5), // first 5 sections
      totalBlocks,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    }
  })
  console.log('\n=== SECTION COVERAGE ===')
  console.log(JSON.stringify(coverage, null, 2))

  // === SCROLL AND TRACK PIP ===
  for (let scrollTarget = 0; scrollTarget <= 3000; scrollTarget += 500) {
    await page.evaluate((target) => {
      const container = document.querySelector('.formatted-view') as HTMLElement
      if (container) container.scrollTop = target
    }, scrollTarget)
    await page.waitForTimeout(400)

    const data = await page.evaluate(() => {
      const container = document.querySelector('.formatted-view') as HTMLElement
      const pip = document.querySelector('.formatted-view__pip') as HTMLElement
      if (!container) return { error: 'no container' }
      
      const scrollTop = container.scrollTop
      const clientHeight = container.clientHeight
      const viewportCenter = scrollTop + clientHeight / 2
      const pipTop = pip ? parseFloat(pip.style.top) : null
      const pipVisible = pip ? (pip.offsetParent !== null) : false
      
      return {
        scrollTop: Math.round(scrollTop),
        clientHeight: Math.round(clientHeight),
        viewportCenter: Math.round(viewportCenter),
        pipTop: pipTop !== null ? Math.round(pipTop) : null,
        pipInViewport: pipTop !== null ? (pipTop >= scrollTop && pipTop <= scrollTop + clientHeight) : false,
        pipOffsetFromCenter: pipTop !== null ? Math.round(pipTop - viewportCenter) : null,
        pipVisible,
        scrollHeight: container.scrollHeight,
      }
    })
    console.log(`scroll=${scrollTarget}:`, JSON.stringify(data))
  }
})
