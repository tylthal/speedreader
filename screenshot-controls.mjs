import { chromium } from 'playwright';

const MOBILE = { width: 390, height: 844 };
const LIB_PATH = [
  '/workspace/.browser-libs/root/usr/lib/x86_64-linux-gnu',
  '/tmp/syslibs/usr/lib/x86_64-linux-gnu',
  '/tmp/syslibs/lib/x86_64-linux-gnu',
  '/tmp/chromium-deps/extracted/usr/lib/x86_64-linux-gnu',
  '/tmp/chromium-deps/extracted/lib/x86_64-linux-gnu',
].join(':');

const browser = await chromium.launch({
  executablePath: '/home/dev/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  env: { ...process.env, LD_LIBRARY_PATH: LIB_PATH },
});

async function screenshotWithTheme(themeName) {
  const ctx = await browser.newContext({
    viewport: MOBILE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: themeName === 'dark' ? 'dark' : 'light',
  });
  const page = await ctx.newPage();

  const filePath = '/workspace/e2e/test-data/sample.txt';

  await page.goto('http://localhost:5176', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Set theme
  await page.evaluate((t) => {
    localStorage.setItem('speedreader-theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, themeName);
  await page.waitForTimeout(300);

  // Upload book
  await page.locator('input[type="file"]').setInputFiles(filePath);

  // Wait for reader
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (/\/read\/\d+/.test(page.url())) break;
    if (await page.locator('.reader-viewport').count()) break;
    if (await page.locator('[role="article"]').count()) {
      await page.locator('[role="article"]').first().click();
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(500);
  }
  await page.waitForURL(/\/read\/\d+/, { timeout: Math.max(5000, deadline - Date.now()) });
  await page.waitForSelector('.reader-viewport', { timeout: 10000 });
  await page.waitForTimeout(1000);

  // Re-ensure theme
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, themeName);
  await page.waitForTimeout(500);

  // Paused state
  await page.screenshot({ path: `screenshot-new-${themeName}-paused.png` });
  console.log(`Saved: screenshot-new-${themeName}-paused.png`);

  // Close-up of controls
  const controls = page.locator('.controls').first();
  if (await controls.count() > 0) {
    await controls.screenshot({ path: `screenshot-new-${themeName}-controls.png` });
    console.log(`Saved: screenshot-new-${themeName}-controls.png`);
  }

  // Playing state
  const playBtn = page.locator('.controls__play-bar').first();
  if (await playBtn.count() > 0) {
    await playBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `screenshot-new-${themeName}-playing.png` });
    console.log(`Saved: screenshot-new-${themeName}-playing.png`);

    // Close-up of strip
    const strip = page.locator('.controls').first();
    if (await strip.count() > 0) {
      await strip.screenshot({ path: `screenshot-new-${themeName}-strip.png` });
      console.log(`Saved: screenshot-new-${themeName}-strip.png`);
    }

    // Pause
    const pauseBtn = page.locator('.controls__strip-pause').first();
    if (await pauseBtn.count() > 0) {
      await pauseBtn.click();
      await page.waitForTimeout(500);
    }
  }

  await ctx.close();
}

await screenshotWithTheme('light');
await screenshotWithTheme('dark');
await browser.close();
console.log('Done!');
