// Playwright QA script for FormattedView position behaviors.
// Run from /workspace.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const SCREEN_DIR = '/tmp/qa-screenshots';
const EPUB_PATH = '/workspace/testbook/babel-r-f-kuang-2022--annas-archive--zlib-22432456.epub';
const BASE_URL = 'http://localhost:5173/';

fs.mkdirSync(SCREEN_DIR, { recursive: true });

const captures = [];
function log(...args) { console.log('[qa]', ...args); }
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function snapshot(page, step, name) {
  const file = path.join(SCREEN_DIR, `${step}-${name}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); }
  catch (e) { log('screenshot failed', step, e.message); }

  const state = await page.evaluate(() => {
    const focusOv = document.querySelector('.focus-overlay');
    const focusInfo = focusOv ? {
      cls: focusOv.className,
      text: (focusOv.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      rect: (() => {
        const r = focusOv.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    } : null;
    const gestureLayer = document.querySelector('.gesture-layer');
    const gestureInfo = gestureLayer ? {
      rect: (() => {
        const r = gestureLayer.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    } : null;
    const hasFormattedView = !!document.querySelector('.formatted-view');
    const fv = document.querySelector('.formatted-view');
    const rects = Array.from(document.querySelectorAll('.formatted-view__highlight')).map(
      (el) => {
        const s = el.style;
        const br = el.getBoundingClientRect();
        return {
          top: s.top, left: s.left, width: s.width, height: s.height,
          domRect: { top: br.top, left: br.left, width: br.width, height: br.height },
        };
      }
    );
    let centerText = null;
    if (fv && rects.length) {
      const first = rects[0].domRect;
      const cx = first.left + first.width / 2;
      const cy = first.top + first.height / 2;
      const el = document.elementFromPoint(cx, cy);
      if (el) centerText = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 200);
    }
    const modeBtn = document.querySelector('[aria-label^="Reading mode:"]');
    const playBtn = document.querySelector('[aria-label="Play reading"], [aria-label="Pause reading"]');
    const dispBtn = document.querySelector('[aria-label^="Display mode:"]');
    let firstVisibleText = null;
    let firstHeading = null;
    if (fv) {
      const box = fv.getBoundingClientRect();
      const el = document.elementFromPoint(box.left + box.width / 2, box.top + 30);
      firstVisibleText = el ? (el.textContent || '').replace(/\s+/g, ' ').slice(0, 200) : null;
      const hs = Array.from(fv.querySelectorAll('h1,h2,h3'));
      for (const h of hs) {
        const r = h.getBoundingClientRect();
        if (r.top >= box.top - 10) {
          firstHeading = (h.textContent || '').replace(/\s+/g, ' ').slice(0, 160);
          break;
        }
      }
    }
    const fvChildCount = fv ? fv.childElementCount : null;
    const fvTextLen = fv ? (fv.textContent || '').length : null;
    // Diagnostic: read positionStore directly so we can verify what
    // the cursor THINKS it's at, independent of what scrollTop or
    // firstHeading suggest.
    let cursor = null;
    try {
      const ps = window.__positionStore;
      if (ps) {
        const s = ps.snapshot();
        cursor = {
          chapterIdx: s.chapterIdx,
          chapterId: s.chapterId,
          abs: s.absoluteSegmentIndex,
          word: s.wordIndex,
          mode: s.mode,
          displayMode: s.displayMode,
          isPlaying: s.isPlaying,
          origin: s.origin,
          revision: s.revision,
        };
      }
    } catch {
      cursor = null;
    }
    // Also check FormattedView visibility
    const fvHidden = fv ? fv.classList.contains('formatted-view--hidden') : null;
    // Diagnostic: capture the position of each rendered article so we
    // can verify whether they actually contain content (h>0) and where
    // they are in the scroll coordinate space.
    const articles = fv
      ? Array.from(fv.querySelectorAll('article.formatted-view__section')).map((el, i) => {
          const r = el.getBoundingClientRect();
          const fvR = fv.getBoundingClientRect();
          const bodyEl = el.querySelector('.formatted-view__body');
          return {
            idx: i,
            sectionIdx: el.getAttribute('data-section-index'),
            top: r.top - fvR.top + fv.scrollTop,
            h: r.height,
            bodyText: bodyEl ? (bodyEl.textContent || '').length : 0,
          };
        })
      : [];
    return {
      fvChildCount,
      fvTextLen,
      fvHidden,
      hasFormattedView,
      scrollTop: fv ? fv.scrollTop : null,
      scrollHeight: fv ? fv.scrollHeight : null,
      clientHeight: fv ? fv.clientHeight : null,
      highlightCount: rects.length,
      highlights: rects,
      highlightCenterText: centerText,
      mode: modeBtn ? modeBtn.getAttribute('aria-label') : null,
      display: dispBtn ? dispBtn.getAttribute('aria-label') : null,
      playState: playBtn ? playBtn.getAttribute('aria-label') : null,
      firstVisibleText, firstHeading,
      focusInfo,
      gestureInfo,
      cursor,
      articles,
    };
  });
  const cap = { step, name, file, ...state };
  captures.push(cap);
  log(`${step} ${name}:`, JSON.stringify({
    hasFV: state.hasFormattedView,
    fvHidden: state.fvHidden,
    scrollTop: state.scrollTop,
    scrollH: state.scrollHeight,
    hlCount: state.highlightCount,
    hl0: state.highlights[0]
      ? { top: state.highlights[0].top, height: state.highlights[0].height }
      : null,
    play: state.playState,
    firstHeading: state.firstHeading,
    focusRect: state.focusInfo?.rect ?? null,
    gestureRect: state.gestureInfo?.rect ?? null,
    cursor: state.cursor,
  }));
  return cap;
}

async function setMode(page, targetMode) {
  const curLabel = await page.getAttribute('[aria-label^="Reading mode:"]', 'aria-label');
  if (curLabel && curLabel.toLowerCase().includes(targetMode.toLowerCase())) return;
  // Click mode button via JS to bypass pointer-events:none on the controls
  // bar (which fades out during playback).
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label^="Reading mode:"]');
    if (btn) btn.click();
  });
  await sleep(300);
  const picked = await page.evaluate((target) => {
    const list = document.querySelector('[role="listbox"][aria-label="Select reading mode"]');
    if (!list) return false;
    const items = Array.from(list.querySelectorAll('[role="option"]'));
    const match = items.find((i) => (i.textContent || '').trim().toLowerCase() === target.toLowerCase());
    if (match) { match.click(); return true; }
    return false;
  }, targetMode);
  if (!picked) throw new Error(`mode option not found: ${targetMode}`);
  await sleep(800);
}

async function ensureFormatted(page) {
  await page.waitForSelector('[aria-label^="Display mode:"]', { state: 'visible' });
  const label = await page.getAttribute('[aria-label^="Display mode:"]', 'aria-label');
  if (label && !label.includes('Formatted')) {
    await page.evaluate(() => {
      const btn = document.querySelector('[aria-label^="Display mode:"]');
      if (btn) btn.click();
    });
    await sleep(500);
  }
  // Wait for formatted-view to be present (don't require visible because
  // phrase/RSVP playing modes unmount it).
  await page.waitForSelector('.formatted-view', { timeout: 15000 }).catch(() => {});
}

async function diagKeyHandler(page, tag) {
  const info = await page.evaluate(() => {
    // Inject a listener we can verify fires
    if (!window.__qaKeyCount) {
      window.__qaKeyCount = 0;
      window.addEventListener('keydown', () => { window.__qaKeyCount++; }, true);
    }
    const countBefore = window.__qaKeyCount;
    const ev = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return { countBefore, countAfter: window.__qaKeyCount };
  });
  log(`diagKey[${tag}]`, info);
}

async function togglePlay(page) {
  const before = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Play reading"], [aria-label="Pause reading"]');
    return btn ? btn.getAttribute('aria-label') : 'no-btn';
  });
  const want = before === 'Pause reading' ? 'Play reading' : 'Pause reading';
  const deadline = Date.now() + 15000;
  let attempts = 0;
  let last = before;
  while (Date.now() < deadline) {
    if (attempts === 0 || (attempts < 5 && (Date.now() - deadline + 15000) > attempts * 2000)) {
      await page.evaluate(() => {
        const btn = document.querySelector('[aria-label="Play reading"], [aria-label="Pause reading"]');
        if (btn) btn.click();
      });
      attempts++;
    }
    await sleep(300);
    const cur = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="Play reading"], [aria-label="Pause reading"]');
      return btn ? btn.getAttribute('aria-label') : null;
    });
    last = cur;
    if (cur === want) {
      log('togglePlay', before, '->', cur, `(${attempts} click(s))`);
      await sleep(2000);
      return;
    }
  }
  log('togglePlay TIMEOUT before=', before, 'last=', last, 'attempts=', attempts);
  await sleep(1500);
}

async function clickPlay(page) { await togglePlay(page); }

async function _unused_pausePlayback(page) {
  // When playing, the controls bar has pointer-events:none.
  // In phrase/RSVP mode the formatted view is unmounted and a focus
  // overlay + GestureLayer receives taps. In scroll mode formatted view
  // is mounted and handles the tap itself. Target whichever exists.
  const box = await page.evaluate(() => {
    const el =
      document.querySelector('.gesture-layer') ||
      document.querySelector('.focus-overlay') ||
      document.querySelector('.formatted-view');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.className };
  });
  if (!box) throw new Error('no tap target for pause');
  // Simulate a tap — the app's useContentTap fires on pointerdown+pointerup
  // without any scroll/drag in between.
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
  await sleep(700);
  // Re-verify: play button should say "Play reading" if paused
  const label = await page.getAttribute('[aria-label="Play reading"], [aria-label="Pause reading"]', 'aria-label').catch(() => null);
  log('after tap-pause target=', box.tag, 'play state=', label);
  // If still playing, retry by clicking the controls toolbar directly
  // (the fade transition is fast; by now controls should have re-faded-in)
  if (label === 'Pause reading') {
    try {
      await page.click('[aria-label="Pause reading"]', { force: true, timeout: 3000 });
      await sleep(500);
    } catch {}
  }
}

async function openToc(page) {
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Open table of contents"]');
    if (btn) btn.click();
  });
  await page.waitForSelector('.toc-sidebar', { state: 'visible' });
  await sleep(300);
}

async function clickTocIndex(page, idx) {
  const info = await page.evaluate((i) => {
    const leafs = Array.from(document.querySelectorAll('.toc-sidebar__item'))
      .filter((e) => e.tagName === 'BUTTON');
    if (i >= leafs.length) return { ok: false, count: leafs.length };
    const el = leafs[i];
    const txt = (el.textContent || '').trim().slice(0, 80);
    el.click();
    return { ok: true, title: txt, count: leafs.length };
  }, idx);
  await sleep(1400);
  return info;
}

(async () => {
  log('launching chromium...');
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/home/dev/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') {
      log('page', t, m.text().slice(0, 300));
    }
  });
  page.on('pageerror', (e) => log('pageerror', e.message));

  try {
    log('goto', BASE_URL);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    await snapshot(page, '00', 'library-loaded');

    let card = await page.$('[role="article"]');
    let alreadyInReader = false;
    if (!card) {
      log('uploading epub');
      const input = await page.$('input[type="file"]');
      if (!input) throw new Error('file input not found');
      await input.setInputFiles(EPUB_PATH);
      log('waiting for book processing or auto-open...');
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const rv = await page.$('.reader-viewport');
        if (rv) { alreadyInReader = true; break; }
        card = await page.$('[role="article"]');
        if (card) break;
        await sleep(500);
      }
      if (!card && !alreadyInReader) throw new Error('book never appeared or opened within 180s');
    } else {
      log('found existing book, reusing');
    }
    await snapshot(page, '01', 'library-with-book');

    if (!alreadyInReader) {
      log('opening book');
      await card.click();
      await page.waitForSelector('.reader-viewport', { state: 'visible', timeout: 30000 });
    } else {
      log('already in reader (auto-opened after upload)');
    }
    await sleep(8000);

    // Focus the document body so space key is captured
    await page.evaluate(() => {
      const rv = document.querySelector('.reader-viewport');
      if (rv && rv instanceof HTMLElement) rv.tabIndex = -1;
      if (rv instanceof HTMLElement) rv.focus();
      document.body.focus?.();
    });

    await ensureFormatted(page);
    await sleep(1500);
    await snapshot(page, 'A', 'cold-open-formatted');
    await snapshot(page, 'B', 'formatted-visible');

    await setMode(page, 'phrase');
    await sleep(800);
    await snapshot(page, 'C0', 'phrase-before-play');
    await togglePlay(page); // start play
    log('phrase playing 2s');
    await sleep(2000);
    // MID-PLAY snapshot — verifies the focus overlay is visible and
    // tappable while playing (the always-mount + display:none fix).
    await snapshot(page, 'C_mid', 'phrase-playing-mid');
    // Tap-to-pause via the gesture layer center (the user's actual
    // path: tap the focus overlay area to pause). This verifies the
    // tappable area survived the always-mount fix.
    const tapped = await page.evaluate(() => {
      const gl = document.querySelector('.gesture-layer');
      if (!gl) return { ok: false, reason: 'no gesture layer' };
      const r = gl.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) return { ok: false, reason: 'gesture layer too small', w: r.width, h: r.height };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const el = document.elementFromPoint(cx, cy);
      // Synthesize a pointerdown+pointerup for the tap.
      const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerType: 'touch' };
      el?.dispatchEvent(new PointerEvent('pointerdown', opts));
      el?.dispatchEvent(new PointerEvent('pointerup', opts));
      return { ok: true, w: Math.round(r.width), h: Math.round(r.height), targetTag: el?.tagName ?? null };
    });
    log('tap-to-pause:', JSON.stringify(tapped));
    await sleep(1000);
    await snapshot(page, 'C_tapped', 'phrase-after-tap-pause');
    await sleep(4000);
    await snapshot(page, 'C', 'phrase-paused-1');

    await togglePlay(page); // play again
    log('phrase playing 5s more');
    await sleep(5000);
    await togglePlay(page); // pause
    await sleep(5000);
    await snapshot(page, 'D', 'phrase-paused-2');

    await setMode(page, 'rsvp');
    await sleep(800);
    await snapshot(page, 'E0', 'rsvp-before-play');
    await togglePlay(page); // play
    log('rsvp playing 5s');
    await sleep(5000);
    await togglePlay(page); // pause
    await sleep(5000);
    await snapshot(page, 'E', 'rsvp-paused');

    // For TOC tests we need a stable formatted view. Switch back to scroll
    // mode (which mounts formatted view even when not playing).
    await setMode(page, 'scroll');
    await sleep(1500);
    await ensureFormatted(page);

    await openToc(page);
    const f1 = await clickTocIndex(page, 3);
    log('TOC F', f1);
    await sleep(1500);
    await snapshot(page, 'F', 'toc-jump-3');

    await openToc(page);
    const g1 = await clickTocIndex(page, 6);
    log('TOC G', g1);
    await sleep(1500);
    await snapshot(page, 'G', 'toc-jump-6');

    await page.evaluate(() => {
      const el = document.querySelector('.formatted-view');
      if (el) el.scrollBy({ top: 500, behavior: 'auto' });
    });
    await sleep(900);
    await snapshot(page, 'H', 'manual-scroll-500');

    await setMode(page, 'scroll');
    await sleep(800);
    await snapshot(page, 'I0', 'scroll-before-play');
    await togglePlay(page); // play
    log('scroll playing 5s');
    await sleep(5000);
    await togglePlay(page); // pause
    await sleep(2000);
    await snapshot(page, 'I', 'scroll-paused');

    log('done');
  } catch (err) {
    log('FATAL', err && err.stack ? err.stack : err);
    try { await snapshot(page, 'ERR', 'error-state'); } catch {}
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(
      path.join(SCREEN_DIR, 'captures.json'),
      JSON.stringify(captures, null, 2),
    );
    await browser.close();
  }
})();
