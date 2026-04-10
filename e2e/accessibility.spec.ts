import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test.describe('Accessibility', () => {
  test('library page has no critical a11y violations', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.library-page')).toBeVisible({ timeout: 10000 })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast']) // Theme-dependent; test manually
      .analyze()

    const critical = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )

    if (critical.length > 0) {
      const summary = critical
        .map((v) => `${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} instances)`)
        .join('\n')
      expect(critical, `A11y violations:\n${summary}`).toHaveLength(0)
    }
  })

  test('settings page has no critical a11y violations', async ({ page }) => {
    await page.goto('/settings')
    await expect(page.locator('.settings-page')).toBeVisible({ timeout: 10000 })

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .disableRules(['color-contrast'])
      .analyze()

    const critical = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )

    if (critical.length > 0) {
      const summary = critical
        .map((v) => `${v.impact}: ${v.id} — ${v.description} (${v.nodes.length} instances)`)
        .join('\n')
      expect(critical, `A11y violations:\n${summary}`).toHaveLength(0)
    }
  })
})
