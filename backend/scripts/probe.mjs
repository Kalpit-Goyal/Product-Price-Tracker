/**
 * EXPLORATORY PROBE — not part of the app.
 *
 * Purpose: prove (or disprove) that a headless browser can beat the store's hover
 * gate, and observe the real DOM shape so the extractor is written against
 * observed reality rather than guesses.
 *
 * Usage: node scripts/probe.mjs [productId] [optionId]
 */
import { chromium } from 'playwright';

const BASE = 'https://demo.inelabteamdev.com';
const productId = process.argv[2] ?? '2022';
const optionId = process.argv[3] ?? 'o1';

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') log(`  [console.error] ${m.text().slice(0, 160)}`);
});

try {
  // ---------------------------------------------------------------- manifest
  hr('1. MANIFEST (what selectors are we allowed to use?)');
  // Fetched from NODE, not from page context. See BUILD_LOG "Failure 1":
  // page.evaluate(fetch) on about:blank has origin "null" and the API sends no
  // CORS header, so the browser blocks it. Node's fetch has no origin and is
  // not subject to CORS at all -- which is also why the design says the manifest
  // comes from a lightweight Node fetch rather than the browser.
  const mres = await fetch(`${BASE}/api/v2/ui/manifest`, {
    headers: { accept: 'application/json' },
  });
  log(`manifest status=${mres.status}`);
  const manifest = await mres.json();
  log(JSON.stringify(manifest, null, 2));

  // ---------------------------------------------------------------- navigate
  hr(`2. NAVIGATE to /item/${productId}`);
  const resp = await page.goto(`${BASE}/item/${productId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  log(`status=${resp.status()}`);
  await page.waitForSelector('.offer-panel, .offer-panel.offer-locked', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // ------------------------------------------------- what does the panel look like?
  hr('3. OFFER PANEL — state BEFORE any interaction');
  const panelInfo = await page.evaluate(() => {
    const panel = document.querySelector('.offer-panel');
    if (!panel) return { found: false };
    return {
      found: true,
      className: panel.className,
      text: panel.innerText.trim().slice(0, 400),
      rect: panel.getBoundingClientRect().toJSON(),
      html: panel.outerHTML.slice(0, 1500),
    };
  });
  log(JSON.stringify(panelInfo, null, 2));

  // -------------------------------------------- naive extraction (expected FAIL)
  hr('4. NAIVE extraction with a hardcoded ".price-value" (this is the trap)');
  const naive = await page.evaluate(() => {
    const el = document.querySelector('.price-value');
    return el
      ? { found: true, text: el.textContent, ariaHidden: el.getAttribute('aria-hidden'),
          display: getComputedStyle(el).display }
      : { found: false };
  });
  log(JSON.stringify(naive, null, 2));
  log('>>> NOTE: if found, this is almost certainly a DECOY, not the real price.');

  // -------------------------------------------- THE HOVER GATE
  hr('5. HOVER GATE — 8+ real mouse moves, >=40ms apart, then dwell to 600ms');
  const rect = panelInfo.rect;
  if (!rect || !rect.width) {
    log('!!! panel has no box; cannot perform interaction');
  } else {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;

    const t0 = Date.now();
    // Moves must be DISTINCT and spaced >=40ms (the store records a move only if
    // >=40ms since the last recorded one) and >=8 of them (minMoves: 8).
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      await page.mouse.move(cx + Math.cos(angle) * (rect.width / 3),
                           cy + Math.sin(angle) * (rect.height / 3));
      await page.waitForTimeout(60);
    }
    log(`  dispatched 12 moves in ${Date.now() - t0}ms`);

    // Ensure total dwell from first move >= 600ms
    const elapsed = Date.now() - t0;
    if (elapsed < 700) await page.waitForTimeout(700 - elapsed);
    log(`  dwell total ${Date.now() - t0}ms`);

    // FAILURE 2 taught us this: moves+dwell only UNLOCK the button. The signature
    // includes `clickAt`, so an actual click is required to trigger the fetch.
    const btn = page.locator('button.ctl.ctl-main');
    log(`  button disabled? ${await btn.isDisabled().catch(() => 'n/a')}`);
    await btn.click({ timeout: 10000 });
    log('  clicked the button');

    // Give the page time to run its own signed fetch + decrypt
    await page.waitForTimeout(4000);
  }

  hr('6. OFFER PANEL — state AFTER interaction');
  const after = await page.evaluate(() => {
    const panel = document.querySelector('.offer-panel');
    const out = { className: panel?.className, text: panel?.innerText?.trim().slice(0, 600) };
    // Everything that looks price-ish
    out.priceish = [...document.querySelectorAll('[class]')]
      .filter((e) => /price|amount|offer|stock|avail/i.test(e.className))
      .slice(0, 40)
      .map((e) => ({
        tag: e.tagName,
        cls: e.className,
        text: (e.textContent || '').trim().slice(0, 60),
        ariaHidden: e.getAttribute('aria-hidden'),
        display: getComputedStyle(e).display,
      }));
    return out;
  });
  log(JSON.stringify(after, null, 2));

  hr('7. MANIFEST-DRIVEN extraction (the correct path)');
  const extracted = await page.evaluate((m) => {
    const cls = m.classes;
    const res = {};
    // price
    const priceNodes = [...document.querySelectorAll(`.${cls.priceValue}`)];
    res.allPriceNodes = priceNodes.map((e) => ({
      tag: e.tagName,
      text: e.textContent,
      ariaHidden: e.getAttribute('aria-hidden'),
      display: getComputedStyle(e).display,
      visibility: getComputedStyle(e).visibility,
    }));
    res.visible = priceNodes.filter(
      (e) => e.getAttribute('aria-hidden') !== 'true' && getComputedStyle(e).display !== 'none'
    );
    res.priceText = res.visible[0]?.textContent ?? null;
    // stock
    const stockEl = document.querySelector(`.${cls.stock}`);
    res.stockText = stockEl?.textContent?.trim() ?? null;
    res.mrpText = document.querySelector(`.${cls.mrp}`)?.textContent?.trim() ?? null;
    return res;
  }, manifest);
  log(JSON.stringify(extracted, null, 2));

  hr('8. FULL PAGE TEXT (sanity check)');
  log((await page.evaluate(() => document.body.innerText)).slice(0, 1500));
} catch (err) {
  log('PROBE ERROR:', err.message);
  log(err.stack?.split('\n').slice(0, 6).join('\n'));
} finally {
  await browser.close();
}
