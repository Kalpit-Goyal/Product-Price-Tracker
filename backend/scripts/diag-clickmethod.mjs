/**
 * A/B test: which click method actually lands on the CTA?
 *
 * The panel can sit `offer-locked` with an ENABLED button indefinitely, which
 * means React's onClick never ran. Candidate causes: `force: true` bypassing
 * something the app depends on, the pointer being moved away before the click,
 * or needing a real hover-then-press sequence on the button itself.
 */
import config from '../src/config.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';

const productId = 2022;
const manifest = await getManifest();
const panelSel = `.${manifest.classes.priceWrap}`;

const METHODS = ['plain', 'force', 'hover-then-click', 'mouse-down-up', 'dispatch-mouse'];

async function settle(page, ms = 15000) {
  try {
    await page.waitForFunction(
      (sel) => /offer-ready|offer-failed/.test(document.querySelector(sel)?.className ?? ''),
      panelSel,
      { timeout: ms }
    );
    return 'settled';
  } catch {
    return 'NOT-settled';
  }
}

for (const method of METHODS) {
  const context = await newContext();
  const page = await context.newPage();
  let verdict = 'error';
  try {
    await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(panelSel, { state: 'visible', timeout: 20000 });
    await page.waitForTimeout(900);

    const box = await page.locator(panelSel).boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const rx = Math.min(box.width / 3, box.width / 2 - 4);
    const ry = Math.min(box.height / 3, box.height / 2 - 4);

    // open the gate
    const button = page.locator('button.ctl.ctl-main').first();
    let open = false;
    for (let b = 0; b < 3 && !open; b++) {
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        await page.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
        await page.waitForTimeout(70);
      }
      const dl = Date.now() + 3000;
      while (Date.now() < dl) {
        if (!(await button.isDisabled().catch(() => true))) { open = true; break; }
        await page.waitForTimeout(150);
      }
    }
    if (!open) { console.log(`${method.padEnd(16)} GATE NEVER OPENED`); await context.close(); continue; }

    const bb = await button.boundingBox();
    const bx = bb.x + bb.width / 2;
    const by = bb.y + bb.height / 2;

    switch (method) {
      case 'plain':
        await button.click({ timeout: 8000 });
        break;
      case 'force':
        await button.click({ timeout: 8000, force: true });
        break;
      case 'hover-then-click': {
        // Move ONTO the button first (a real hover), then press.
        await page.mouse.move(bx, by, { steps: 6 });
        await page.waitForTimeout(250);
        await page.mouse.down();
        await page.waitForTimeout(60);
        await page.mouse.up();
        break;
      }
      case 'mouse-down-up':
        await page.mouse.move(bx, by, { steps: 8 });
        await page.waitForTimeout(120);
        await page.mouse.down();
        await page.waitForTimeout(80);
        await page.mouse.up();
        break;
      case 'dispatch-mouse': {
        // Raw CDP input at the button's coordinates.
        const client = await page.context().newCDPSession(page);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bx, y: by, button: 'none' });
        await page.waitForTimeout(100);
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 });
        await page.waitForTimeout(60);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 });
        break;
      }
    }

    verdict = await settle(page);
    const txt = await page.evaluate((s) => (document.querySelector(s)?.innerText || '').replace(/\n+/g, ' | ').slice(0, 90), panelSel);
    console.log(`${method.padEnd(16)} ${verdict.padEnd(12)} ${JSON.stringify(txt)}`);
  } catch (e) {
    console.log(`${method.padEnd(16)} ERROR ${e.message.split('\n')[0].slice(0, 80)}`);
  }
  await context.close();
}

await closeBrowser();
