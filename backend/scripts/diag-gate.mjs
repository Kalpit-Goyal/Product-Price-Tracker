/**
 * Move-by-move gate probe.
 *
 * The panel's sub-message exposes the gate's internal state:
 *   "Hover over the price area to load the current price."  -> fewer than 8 moves
 *   "Hold on - checking availability..."                     -> 8+ moves, dwell < 600ms
 *   (button enabled)                                         -> gate open
 * So we can watch the gate fill up instead of guessing.
 */
import config from '../src/config.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';

const productId = Number(process.argv[2] ?? 2022);
const manifest = await getManifest();
const panelSel = `.${manifest.classes.priceWrap}`;

const context = await newContext();
const page = await context.newPage();
await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector(panelSel, { state: 'visible', timeout: 20000 });
await page.waitForTimeout(1200);

const gate = () =>
  page.evaluate((sel) => {
    const p = document.querySelector(sel);
    const btn = document.querySelector('button.ctl.ctl-main');
    return {
      sub: p?.querySelector('.offer-submsg')?.textContent?.slice(0, 60) ?? null,
      disabled: btn ? btn.disabled : null,
    };
  }, panelSel);

const box = await page.locator(panelSel).boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
console.log(`panel box: x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`);
console.log(`viewport: ${JSON.stringify(page.viewportSize())}`);
console.log(`scrollY: ${await page.evaluate(() => window.scrollY)}\n`);
console.log('before:', JSON.stringify(await gate()));

const radiusMode = process.argv[3] ?? 'circle';
const poll = process.argv[4] !== 'nopoll';
console.log(`\nmode=${radiusMode} poll=${poll}`);

const t0 = Date.now();
if (!poll) {
  // Fire the whole burst with no evaluate() calls in between, then observe.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * (box.width / 3), cy + Math.sin(a) * (box.height / 3));
    await page.waitForTimeout(70);
  }
  for (let k = 0; k < 8; k++) {
    await page.waitForTimeout(250);
    const g = await gate();
    console.log(`  t+${Date.now() - t0}ms disabled=${g.disabled} sub=${JSON.stringify(g.sub)}`);
    if (g.disabled === false) { console.log('  >>> GATE OPEN'); break; }
  }
} else {
  for (let i = 0; i < 14; i++) {
    let x;
    let y;
    if (radiusMode === 'circle') {
      const a = (i / 14) * Math.PI * 2;
      x = cx + Math.cos(a) * (box.width / 3);
      y = cy + Math.sin(a) * (box.height / 3);
    } else if (radiusMode === 'small') {
      // Tight jitter around the centre: many small, definitely-distinct moves.
      x = cx + (i % 5) * 2 - 4;
      y = cy + Math.floor(i / 5) * 2 - 2;
    } else {
      // straight sweep left->right->left
      x = box.x + 20 + ((i * 37) % Math.max(1, box.width - 40));
      y = cy;
    }
    await page.mouse.move(x, y);
    await page.waitForTimeout(75);
    const g = await gate();
    console.log(
      `  move ${String(i + 1).padStart(2)} @(${Math.round(x)},${Math.round(y)}) t+${String(Date.now() - t0).padStart(4)}ms  ` +
        `disabled=${g.disabled}  sub=${JSON.stringify(g.sub)}`
    );
    if (g.disabled === false) { console.log('  >>> GATE OPEN'); break; }
  }
}

await context.close();
await closeBrowser();
