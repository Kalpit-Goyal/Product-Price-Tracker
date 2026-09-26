/**
 * Exploratory probe #2 — how do we SELECT a product option?
 *
 * The assignment requires the user to pick "both the product and the option to
 * track", and price is per-option. We need the option control's real DOM.
 */
import { chromium } from 'playwright';

const BASE = 'https://demo.inelabteamdev.com';
const productId = process.argv[2] ?? '2022';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

try {
  await page.goto(`${BASE}/item/${productId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('button.ctl.ctl-main', { timeout: 20000 });
  await page.waitForTimeout(1000);

  console.log('='.repeat(70));
  console.log('OPTION CONTROLS');
  console.log('='.repeat(70));

  const opts = await page.evaluate(() => {
    // Anything that looks like a selectable option chip
    const all = [...document.querySelectorAll('button, [role="radio"], [role="button"], label, li, a')];
    return all
      .map((e) => ({
        tag: e.tagName,
        cls: e.className,
        type: e.getAttribute('type'),
        role: e.getAttribute('role'),
        pressed: e.getAttribute('aria-pressed'),
        checked: e.getAttribute('aria-checked'),
        sel: e.getAttribute('aria-selected'),
        text: (e.textContent || '').trim().slice(0, 40),
        html: e.outerHTML.slice(0, 200),
      }))
      .filter((o) => /edition|standard|special|pro bundle|\bo[123]\b|option|variant|chip|pill/i.test(o.text + ' ' + o.cls));
  });
  console.log(JSON.stringify(opts, null, 2));

  console.log('\n' + '='.repeat(70));
  console.log('AXIS LABEL + surrounding markup');
  console.log('='.repeat(70));
  const axis = await page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /^edition$/i.test((e.textContent || '').trim())
    );
    if (!el) return { found: false };
    return {
      found: true,
      parentHtml: el.parentElement.outerHTML.slice(0, 1200),
      grandParentHtml: el.parentElement.parentElement.outerHTML.slice(0, 1600),
    };
  });
  console.log(JSON.stringify(axis, null, 2));

  console.log('\n' + '='.repeat(70));
  console.log('API: item options (ground truth)');
  console.log('='.repeat(70));
  const r = await fetch(`${BASE}/api/v2/items/${productId}`);
  const j = await r.json();
  console.log('optionAxis:', j.optionAxis);
  console.log('options:', JSON.stringify(j.options));
} catch (e) {
  console.error('ERR', e.message);
} finally {
  await browser.close();
}
