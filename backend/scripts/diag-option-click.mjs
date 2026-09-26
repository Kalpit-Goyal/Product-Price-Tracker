/** Diagnose why the 2nd option click times out on a reused page. */
import config from '../src/config.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';
import { unlockPrice } from '../src/services/interaction.js';

const productId = 2022;
const manifest = await getManifest();
const context = await newContext();
const page = await context.newPage();
await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });

async function chipState(label) {
  const info = await page.evaluate((axis) => {
    const picker = document.querySelector(`.opt-picker[aria-label="${axis}"]`);
    if (!picker) return { picker: false };
    return {
      picker: true,
      chips: [...picker.querySelectorAll('button.opt-chip')].map((b) => {
        const r = b.getBoundingClientRect();
        return {
          text: b.textContent,
          pressed: b.getAttribute('aria-pressed'),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          // what is actually on top at the chip's centre?
          topEl: (() => {
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return hit ? `${hit.tagName}.${hit.className}` : null;
          })(),
        };
      }),
      panelClass: document.querySelector('.offer-panel')?.className,
    };
  }, 'Edition');
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(info, null, 2));
}

await chipState('BEFORE any interaction');
await unlockPrice(page, { optionAxis: 'Edition', optionLabel: 'Standard' }, `.${manifest.classes.priceWrap}`);
await chipState('AFTER loading Standard (panel should be offer-ready)');

console.log('\n--- attempting Special Edition click, full error ---');
try {
  const chip = page
    .locator('.opt-picker[aria-label="Edition"]')
    .locator('button.opt-chip', { hasText: /^\s*Special Edition\s*$/ })
    .first();
  console.log('count =', await chip.count());
  await chip.click({ timeout: 5000 });
  console.log('clicked OK');
} catch (e) {
  console.log('FULL ERROR:\n' + e.message.split('\n').slice(0, 25).join('\n'));
}
await chipState('AFTER attempting Special Edition');

await context.close();
await closeBrowser();
