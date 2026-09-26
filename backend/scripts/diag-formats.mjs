/**
 * Ground-truth collector.
 *
 * (a) Waits for the store to serve a `split` price carrier, then dumps the EXACT
 *     characters of the price node. Console output cannot be trusted for this:
 *     the split carrier interleaves invisible filler characters, and what I
 *     thought was "₹ 1 4 , 6 6 8" may have been something else entirely.
 * (b) Logs the panel's class + text every second for 60s after a click, so a
 *     long "unsettled" window can be attributed to a real cause instead of a guess.
 */
import config from '../src/config.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';
import { parsePrice } from '../src/util/parse.js';

const productId = Number(process.argv[2] ?? 2022);
const wantCarrier = process.argv[3] ?? 'split';
const watchSeconds = Number(process.argv[4] ?? 0);

function codepoints(s) {
  return [...s]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp < 32) return `<U+${cp.toString(16).padStart(4, '0')}>`;
      if (cp > 126) return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
      return ch;
    })
    .join('');
}

const context = await newContext();
const page = await context.newPage();

for (let attempt = 1; attempt <= 25; attempt++) {
  const manifest = await getManifest({ force: true });
  const panelSel = `.${manifest.classes.priceWrap}`;

  await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(panelSel, { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(900);

  const box = await page.locator(panelSel).boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = Math.min(box.width / 3, box.width / 2 - 4);
  const ry = Math.min(box.height / 3, box.height / 2 - 4);

  const button = page.locator('button.ctl.ctl-main').first();
  let open = false;
  for (let burst = 0; burst < 3 && !open; burst++) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      await page.waitForTimeout(70);
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!(await button.isDisabled().catch(() => true))) { open = true; break; }
      await page.waitForTimeout(150);
    }
  }
  if (!open) { console.log(`attempt ${attempt}: gate never opened`); continue; }

  await button.click({ timeout: 5000, force: true });

  if (watchSeconds > 0) {
    console.log(`\n=== watching panel for ${watchSeconds}s after click ===`);
    for (let s = 0; s < watchSeconds; s++) {
      const st = await page.evaluate((sel) => {
        const p = document.querySelector(sel);
        const b = document.querySelector('button.ctl.ctl-main');
        return { cls: p?.className, btn: b ? { t: b.textContent.trim().slice(0, 20), d: b.disabled } : null,
                 text: (p?.innerText || '').replace(/\n+/g, ' | ').slice(0, 120) };
      }, panelSel);
      console.log(`  t+${s}s ${JSON.stringify(st)}`);
      if (/offer-ready|offer-failed/.test(st.cls ?? '')) { console.log('  >>> settled'); break; }
      await page.waitForTimeout(1000);
    }
  } else {
    try {
      await page.waitForFunction((sel) => /offer-ready|offer-failed/.test(document.querySelector(sel)?.className ?? ''),
        panelSel, { timeout: 15000 });
    } catch { console.log(`attempt ${attempt}: never settled`); continue; }

    const got = await page.evaluate((cls) => {
      const el = document.querySelector(`.${CSS.escape(cls)}`);
      const stock = document.querySelector('[class*="avail"], .avail-pill');
      return {
        carrier: null,
        priceText: el?.textContent ?? null,
        priceChildSpans: el ? el.children.length : 0,
        priceTag: el?.tagName ?? null,
        stockText: stock?.textContent?.trim() ?? null,
      };
    }, manifest.classes.priceValue);

    console.log(`\nmanifest carrier=${manifest.priceCarrier} priceTag=${manifest.priceTag}`);
    console.log(`  price EXACT  : ${codepoints(got.priceText)}`);
    console.log(`  as JSON      : ${JSON.stringify(got.priceText)}`);
    console.log(`  length       : ${got.priceText?.length}   child spans: ${got.priceChildSpans}   tag: ${got.priceTag}`);
    console.log(`  stock EXACT  : ${codepoints(got.stockText)}  -> ${JSON.stringify(got.stockText)}`);
    console.log(`  parsePrice() : ${parsePrice(got.priceText)}`);

    if (manifest.priceCarrier === wantCarrier) {
      console.log(`\n>>> captured the "${wantCarrier}" carrier`);
      break;
    }
    console.log(`  (wanted ${wantCarrier}, got ${manifest.priceCarrier} — retrying)`);
  }
}

await context.close();
await closeBrowser();
