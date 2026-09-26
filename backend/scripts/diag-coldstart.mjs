/** Watch the offer panel state over time during a COLD first interaction. */
import config from '../src/config.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';

const productId = Number(process.argv[2] ?? 2022);
const optionLabel = process.argv[3] ?? null;
const manifest = await getManifest();
const panelSel = `.${manifest.classes.priceWrap}`;

const context = await newContext();
const page = await context.newPage();

// Log every request/response the page makes, so we can see the price fetch itself.
page.on('request', (r) => {
  if (r.url().includes('/api/')) console.log(`   REQ  ${r.method()} ${r.url().replace(config.scrapeBaseUrl, '')}`);
});
page.on('response', async (r) => {
  if (r.url().includes('/api/')) console.log(`   RES  ${r.status()} ${r.url().replace(config.scrapeBaseUrl, '')}`);
});
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/')) console.log(`   FAIL ${r.failure()?.errorText} ${r.url().replace(config.scrapeBaseUrl, '')}`);
});

console.log('navigating…');
await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });

const state = () =>
  page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return { cls: 'ABSENT' };
    const btn = document.querySelector('button.ctl.ctl-main');
    return {
      cls: p.className,
      btn: btn ? { text: btn.textContent.trim(), disabled: btn.disabled } : null,
      text: (p.innerText || '').replace(/\n+/g, ' | ').slice(0, 160),
    };
  }, panelSel);

for (let i = 0; i < 6; i++) {
  console.log(`t=${i}s`, JSON.stringify(await state()));
  await page.waitForTimeout(1000);
}

// --- do the interaction by hand, logging as we go
const box = await page.locator(panelSel).boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
console.log(`\ninteraction: 10 moves around (${Math.round(cx)},${Math.round(cy)}) panel ${Math.round(box.width)}x${Math.round(box.height)}`);

if (optionLabel) {
  const chip = page.locator(`.opt-picker button.opt-chip`, { hasText: new RegExp(`^\\s*${optionLabel}\\s*$`) }).first();
  await chip.waitFor({ state: 'visible', timeout: 8000 }).catch(() => console.log('  chip wait failed'));
  await chip.click({ timeout: 5000, force: true }).catch((e) => console.log('  chip click failed: ' + e.message.split('\n')[0]));
  console.log('  option clicked, aria-pressed =', await chip.getAttribute('aria-pressed'));
}

for (let i = 0; i < 10; i++) {
  const a = (i / 10) * Math.PI * 2;
  await page.mouse.move(cx + Math.cos(a) * (box.width / 3), cy + Math.sin(a) * (box.height / 3));
  await page.waitForTimeout(70);
}
await page.waitForTimeout(400);
console.log('after moves :', JSON.stringify(await state()));

const btn = page.locator('button.ctl.ctl-main').first();
console.log('btn disabled =', await btn.isDisabled());
await btn.click({ timeout: 5000, force: true }).catch((e) => console.log('CTA click failed: ' + e.message.split('\n')[0]));
console.log('CTA clicked');

for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(1000);
  const s = await state();
  if (i % 3 === 0 || /ready|failed/.test(s.cls)) console.log(`  t+${i + 1}s`, JSON.stringify(s));
  if (/ready|failed/.test(s.cls)) { console.log('\n>>> SETTLED as', s.cls); break; }
}

await context.close();
await closeBrowser();
