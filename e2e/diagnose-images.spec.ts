import { test, expect } from '@playwright/test';
import path from 'path';

test('diagnose: upload testbook EPUB, switch to formatted, capture state', async ({ page }) => {
  // Capture every console message verbatim.
  const logs: string[] = [];
  page.on('console', (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    logs.push(`[pageerror] ${err.message}`);
  });

  // Clear any existing app state.
  await page.goto('/');
  await page.evaluate(async () => {
    try { localStorage.clear(); } catch {}
    try {
      const dbs = await indexedDB.databases?.() ?? [];
      for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
    } catch {}
    try {
      // Best-effort OPFS reset
      const root = await navigator.storage?.getDirectory?.();
      if (root) {
        for await (const [name] of (root as any).entries()) {
          await root.removeEntry(name, { recursive: true }).catch(() => {});
        }
      }
    } catch {}
  });
  await page.reload();
  await page.waitForLoadState('networkidle');

  // Upload the test book.
  const filePath = path.join(__dirname, '..', 'testbook', 'babel-r-f-kuang-2022--annas-archive--zlib-22432456.epub');
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(filePath);

  // Wait for the new card to appear.
  await page.waitForSelector('[role="article"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa-screenshots/diag-01-library.png' });

  // Click into the book.
  await page.locator('[role="article"]').first().click();
  await page.waitForURL(/\/read\/\d+/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'qa-screenshots/diag-02-reader-default.png' });

  // What's the initial display mode? The default is 'formatted' now, so the
  // formatted view should be present from the start.
  const formattedPresent = await page.locator('.formatted-view').count();
  console.log('::diag formatted-view count:', formattedPresent);

  // Look for img elements inside the formatted view.
  const imgInfo = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.formatted-view img'));
    return imgs.slice(0, 20).map((img) => {
      const i = img as HTMLImageElement;
      return {
        src: i.getAttribute('src'),
        currentSrc: i.currentSrc,
        complete: i.complete,
        naturalWidth: i.naturalWidth,
        naturalHeight: i.naturalHeight,
      };
    });
  });
  console.log('::diag img count:', imgInfo.length);
  console.log('::diag img sample:', JSON.stringify(imgInfo.slice(0, 5), null, 2));

  // Inspect the OPFS contents directly.
  const opfsDump = await page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    try {
      const root = await navigator.storage.getDirectory();
      async function walk(dir: any, prefix: string) {
        for await (const [name, entry] of dir.entries()) {
          const path = `${prefix}${name}`;
          if (entry.kind === 'directory') {
            out[path] = [];
            await walk(entry, `${path}/`);
          } else {
            const file = await entry.getFile();
            (out[prefix.replace(/\/$/, '')] ||= []).push(`${name} (${file.size} bytes)`);
          }
        }
      }
      await walk(root, '');
    } catch (e) {
      out['__error__'] = [(e as Error).message];
    }
    return out;
  });
  console.log('::diag opfs:', JSON.stringify(opfsDump, null, 2));

  // Inspect the section html in the DB.
  const dbDump = await page.evaluate(async () => {
    try {
      const Dexie = (await import('dexie')).default;
      const db: any = new Dexie('speedreader');
      db.version(2).stores({
        publications: '++id',
        chapters: '++id, publication_id',
        segments: '++id, chapter_id',
        image_pages: '++id, chapter_id',
        reading_progress: '++id, &publication_id',
      });
      await db.open();
      const pubs = await db.publications.toArray();
      const chapters = await db.chapters.limit(3).toArray();
      // Sample HTML from first chapter
      let firstHtmlSample: string | null = null;
      if (chapters[0]?.html) firstHtmlSample = chapters[0].html.slice(0, 800);
      return {
        pubCount: pubs.length,
        firstPub: pubs[0] && {
          id: pubs[0].id,
          title: pubs[0].title,
          cover_path: pubs[0].cover_path,
          total_segments: pubs[0].total_segments,
        },
        firstChapterTitle: chapters[0]?.title,
        firstChapterHtmlBytes: chapters[0]?.html?.length ?? 0,
        firstHtmlSample,
        chapterCount: await db.chapters.count(),
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  console.log('::diag db:', JSON.stringify(dbDump, null, 2));

  // Save logs.
  console.log('\n=== ALL CONSOLE LOGS ===');
  for (const l of logs) console.log(l);

  // Always pass — we just want the output.
  expect(true).toBe(true);
});
