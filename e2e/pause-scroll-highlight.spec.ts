import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  clearAppState,
  SAMPLE_EPUB_PATH,
  uploadBookAndWaitForReader,
} from './helpers';

/**
 * Tests for the pause-scroll-highlight bug: when a user pauses playback and
 * scrolls in formatted view, the highlight (and thus the resume position)
 * should track the viewport center — not drift above the visible area.
 *
 * Root cause under test: the scroll→segment detection uses a proportional
 * estimate (`progress * segments.length`) that assumes equal segment heights.
 * With real content (headings, short paragraphs, images) the mapping is
 * inaccurate and the highlight can land far above the visible text.
 */

async function ensureFormattedView(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label^="Display mode:"]');
  await expect(toggle).toBeVisible();
  const label = await toggle.getAttribute('aria-label');
  if (label && !label.includes('Formatted')) {
    await toggle.click();
  }
  await expect(page.locator('.formatted-view')).toBeVisible();
}

async function selectScrollMode(page: Page): Promise<void> {
  const modeBtn = page.locator('[aria-label^="Reading mode:"]');
  await expect(modeBtn).toBeVisible();
  const label = await modeBtn.getAttribute('aria-label');
  if (label && label.toLowerCase().includes('scroll')) return;
  await modeBtn.click();
  await page
    .locator('[role="listbox"][aria-label="Select reading mode"]')
    .getByRole('option', { name: 'Scroll Continuous' })
    .click();
  await expect(modeBtn).toContainText(/Scroll/);
}

/** Returns the scroll-container metrics and highlight position. */
async function getViewportAndHighlight(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector(
      '.formatted-view',
    ) as HTMLElement | null;
    if (!container)
      return {
        scrollTop: -1,
        viewportTop: 0,
        viewportBottom: 0,
        scrollHeight: 0,
        clientHeight: 0,
        highlightTop: null as number | null,
        highlightBottom: null as number | null,
      };

    const viewportTop = container.scrollTop;
    const viewportBottom = container.scrollTop + container.clientHeight;

    // Find the highlight band(s)
    const highlights = container.querySelectorAll(
      '.formatted-view__highlight',
    );
    let highlightTop: number | null = null;
    let highlightBottom: number | null = null;

    if (highlights.length > 0) {
      // Highlights are absolutely positioned inside the scroll container.
      // Their `top` style is relative to the scroll content, not viewport.
      for (const h of highlights) {
        const el = h as HTMLElement;
        const hTop = parseFloat(el.style.top || '0');
        const hHeight = parseFloat(el.style.height || '0');
        if (highlightTop === null || hTop < highlightTop) highlightTop = hTop;
        if (highlightBottom === null || hTop + hHeight > highlightBottom)
          highlightBottom = hTop + hHeight;
      }
    }

    return {
      scrollTop: container.scrollTop,
      viewportTop,
      viewportBottom,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      highlightTop,
      highlightBottom,
    };
  });
}

test.describe('Pause-scroll highlight tracking', () => {
  test.beforeEach(async ({ page }) => {
    await clearAppState(page);
    await page.goto('/');
    await uploadBookAndWaitForReader(page, SAMPLE_EPUB_PATH);
    await ensureFormattedView(page);
    await selectScrollMode(page);
  });

  test('after pausing and scrolling down, highlight stays within the visible viewport', async ({
    page,
  }) => {
    // 1. Pause immediately (no need to play first — we just need paused state)
    //    The highlight should be visible at the start of the content.
    // Wait for initial programmatic scroll flag to clear (600ms timeout)
    await page.waitForTimeout(1000);

    const initial = await getViewportAndHighlight(page);

    // Need enough content to scroll. Skip if not scrollable.
    if (initial.scrollHeight <= initial.clientHeight + 100) {
      test.skip(true, 'Not enough scrollable content');
    }

    // 2. Scroll down significantly
    const scrollDelta = Math.min(
      initial.clientHeight * 3,
      (initial.scrollHeight - initial.scrollTop) * 0.5,
    );
    await page.evaluate(
      ({ delta }) => {
        const el = document.querySelector('.formatted-view') as HTMLElement;
        el.scrollTop += delta;
      },
      { delta: scrollDelta },
    );

    // Wait for scroll handler rAF to fire and update position + highlight
    await page.waitForTimeout(1000);

    // 3. Verify highlight is within the visible viewport
    const afterScroll = await getViewportAndHighlight(page);

    // The scroll should have actually moved
    expect(afterScroll.scrollTop).toBeGreaterThan(initial.scrollTop + 50);

    // The highlight must exist
    expect(afterScroll.highlightTop).not.toBeNull();
    expect(afterScroll.highlightBottom).not.toBeNull();

    // KEY ASSERTION: highlight should overlap the visible viewport.
    // If the highlight is entirely above the viewport, the bug is present.
    const highlightIsAboveViewport =
      afterScroll.highlightBottom! < afterScroll.viewportTop;
    const highlightIsBelowViewport =
      afterScroll.highlightTop! > afterScroll.viewportBottom;

    expect(
      highlightIsAboveViewport,
      `Highlight (${afterScroll.highlightTop?.toFixed(0)}-${afterScroll.highlightBottom?.toFixed(0)}) ` +
        `is entirely above viewport (${afterScroll.viewportTop.toFixed(0)}-${afterScroll.viewportBottom.toFixed(0)}). ` +
        `The proportional segment detection drifted.`,
    ).toBe(false);

    expect(
      highlightIsBelowViewport,
      `Highlight is entirely below viewport`,
    ).toBe(false);
  });

  test('resume after pause-scroll plays from the visible position, not the old position', async ({
    page,
  }) => {
    // 1. Note starting position, then scroll down while paused
    await page.waitForTimeout(1000);
    const initial = await getViewportAndHighlight(page);

    if (initial.scrollHeight <= initial.clientHeight + 100) {
      test.skip(true, 'Not enough scrollable content');
    }

    // 2. Scroll down significantly
    const scrollDelta = Math.min(
      initial.clientHeight * 3,
      (initial.scrollHeight - initial.scrollTop) * 0.5,
    );
    await page.evaluate(
      ({ delta }) => {
        const el = document.querySelector('.formatted-view') as HTMLElement;
        el.scrollTop += delta;
      },
      { delta: scrollDelta },
    );
    await page.waitForTimeout(1000);

    const beforeResume = await getViewportAndHighlight(page);

    // 3. Start playback (should begin from scrolled-to position)
    await page.locator('[aria-label="Play reading"]').click();
    await page.waitForTimeout(1500);

    // 4. Pause and check position
    await page.locator('[aria-label="Pause reading"]').click();
    await page.waitForTimeout(500);

    const afterResume = await getViewportAndHighlight(page);

    // The scroll position after resume should be near where we scrolled to
    // (or ahead of it since playback advances), NOT jumped back to the start.
    const jumpedBackToStart =
      afterResume.scrollTop < initial.scrollTop + initial.clientHeight * 0.5;

    expect(
      jumpedBackToStart,
      `After resume, scrollTop (${afterResume.scrollTop.toFixed(0)}) jumped back near ` +
        `start (${initial.scrollTop.toFixed(0)}) instead of ` +
        `continuing from scroll position (${beforeResume.scrollTop.toFixed(0)}). ` +
        `The position store was set to wrong segment during scroll.`,
    ).toBe(false);
  });

  test('scrolling up while paused moves highlight to earlier content', async ({
    page,
  }) => {
    // 1. Play to get deeper into content, then pause
    await page.locator('[aria-label="Play reading"]').click();
    await page.waitForTimeout(5000);
    await page.locator('[aria-label="Pause reading"]').click();
    await page.waitForTimeout(500);

    const afterPause = await getViewportAndHighlight(page);

    // 2. Scroll UP
    const scrollDelta = Math.min(
      afterPause.clientHeight * 2,
      afterPause.scrollTop * 0.5,
    );
    if (scrollDelta < 50) {
      test.skip(true, 'Not enough scroll range to test upward scroll');
    }

    await page.evaluate(
      ({ delta }) => {
        const el = document.querySelector('.formatted-view') as HTMLElement;
        el.scrollTop -= delta;
      },
      { delta: scrollDelta },
    );
    await page.waitForTimeout(800);

    const afterScroll = await getViewportAndHighlight(page);

    // Highlight should be visible, not stuck at old position below viewport
    expect(afterScroll.highlightTop).not.toBeNull();

    const highlightIsAboveViewport =
      afterScroll.highlightBottom! < afterScroll.viewportTop;
    const highlightIsBelowViewport =
      afterScroll.highlightTop! > afterScroll.viewportBottom;

    expect(
      highlightIsBelowViewport,
      `After scrolling UP, highlight (${afterScroll.highlightTop?.toFixed(0)}-${afterScroll.highlightBottom?.toFixed(0)}) ` +
        `is below viewport (${afterScroll.viewportTop.toFixed(0)}-${afterScroll.viewportBottom.toFixed(0)})`,
    ).toBe(false);
    expect(highlightIsAboveViewport, 'Highlight above viewport after scroll up').toBe(false);
  });
});
