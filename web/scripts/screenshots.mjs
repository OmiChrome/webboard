// Captures README screenshots from a running server (default http://localhost:8799).
import { chromium, devices } from '@playwright/test';
const base = process.env.BASE_URL || 'http://localhost:8799';
const out = new URL('../../docs/screenshots/', import.meta.url).pathname;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function shot(ctxOpts, name, steps) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await steps(page);
  await page.screenshot({ path: `${out}${name}.png` });
  await ctx.close();
}

const upload = async (page, id) => {
  await page.getByTestId(`example-${id}`).click();
  await page.getByTestId('upload').click();
  await page.getByTestId('log').getByText('Upload complete').waitFor();
};

for (const scheme of ['light', 'dark']) {
  await shot({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2, colorScheme: scheme }, `desktop-plotter-${scheme}`, async (page) => {
    await upload(page, 'SinePlotter');
    await page.getByRole('tab', { name: 'Plotter' }).click();
    await page.waitForTimeout(2500);
  });
}
await shot({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' }, 'desktop-traffic-output', async (page) => {
  await upload(page, 'TrafficLight');
  await page.waitForTimeout(400);
});
await shot({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2, colorScheme: 'dark' }, 'desktop-monitor', async (page) => {
  await upload(page, 'HelloSerial');
  await page.getByRole('tab', { name: 'Serial Monitor' }).click();
  await page.waitForTimeout(3200);
});
await shot({ ...devices['Pixel 7'], colorScheme: 'dark' }, 'android-knightrider', async (page) => {
  await page.getByRole('button', { name: 'Sketches' }).click();
  await upload(page, 'KnightRider');
  await page.waitForTimeout(300);
});
await shot({ ...devices['Pixel 7'], colorScheme: 'light' }, 'android-drawer', async (page) => {
  await page.getByRole('button', { name: 'Sketches' }).click();
  await page.waitForTimeout(400);
});
await browser.close();
console.log('screenshots in', out);
