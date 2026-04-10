import { test, expect } from '@playwright/test'

test.describe('Offline support', () => {
  test('app shell loads and shows library when offline', async ({ page, context }) => {
    // First load while online to populate caches
    await page.goto('/')
    await expect(page.locator('.library-page')).toBeVisible({ timeout: 10000 })

    // Go offline
    await context.setOffline(true)

    // Reload — should work from cache
    await page.reload()
    await expect(page.locator('.library-page')).toBeVisible({ timeout: 10000 })

    // Navigation should work
    await page.click('[data-nav="settings"]')
    await expect(page.locator('.settings-page')).toBeVisible({ timeout: 5000 })
  })

  test('shows offline toast when network drops', async ({ page, context }) => {
    await page.goto('/')
    await expect(page.locator('.library-page')).toBeVisible({ timeout: 10000 })

    // Go offline
    await context.setOffline(true)

    // Should show the offline toast
    await expect(page.locator('.offline-toast')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.offline-toast__message')).toContainText('offline')

    // Come back online
    await context.setOffline(false)

    // Should show "Back online" toast
    await expect(page.locator('.offline-toast--online')).toBeVisible({ timeout: 5000 })
  })
})
