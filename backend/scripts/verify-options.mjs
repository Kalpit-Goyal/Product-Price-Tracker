/**
 * Rigorous option -> price verification, plus a stock-format sweep.
 *
 * WHY: prices change on every page load, so comparing option prices ACROSS runs
 * proves nothing. The only valid test is within a SINGLE page load — select each
 * option in turn on the same loaded page and read the price each time. If the
 * option genuinely affects price, the tiers must be ordered.
 */
import { chromium } from 'playwright';
import config from '../src/config.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';
import { unlockPrice } from '../src/services/interaction.js';
import { extractOffer } from '../src/services/extract.js';

const productId = Number(process.argv[2] ?? 2022);

const manifest = await getManifest();
console.log(`manifest rev ${manifest.revision}  priceValue=.${manifest.classes.priceValue}\n`);

const res = await fetch(`${config.apiV2}/items/${productId}`);
const detail = await res.json();
console.log(`${detail.name}  axis="${detail.optionAxis}"  options=${JSON.stringify(detail.options)}\n`);

const context = await newContext();
const page = await context.newPage();
await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });

const results = [];
const attemptsPerOption = config.SCRAPE_MAX_ATTEMPTS;

for (const opt of detail.options) {
  const t0 = Date.now();

  // Mirror the production retry policy. The store's quote endpoint stalls
  // intermittently (observed live: two consecutive options in one run never
  // settled, then the very next run was clean), and a single attempt is not how
  // the scraper actually runs. Measuring the harness without retries would
  // overstate the failure rate and understate the system.
  let lastErr = null;
  for (let attempt = 1; attempt <= attemptsPerOption; attempt++) {
    try {
      await unlockPrice(
        page,
        { optionAxis: detail.optionAxis, optionLabel: opt.label },
        `.${manifest.classes.priceWrap}`,
        { productUrl: `${config.scrapeBaseUrl}/item/${productId}` }
      );
      const offer = await extractOffer(page, manifest);
      const pressed = await page
        .locator(`.opt-picker button.opt-chip`, { hasText: new RegExp(`^\\s*${opt.label}\\s*$`) })
        .first()
        .getAttribute('aria-pressed');

      // The option genuinely selected must be the one we asked for. A price read
      // under the wrong option is a wrong answer, not a partial one.
      if (pressed !== 'true') {
        throw new Error(`option chip "${opt.label}" is not aria-pressed after selection`);
      }

      results.push({
        opt: opt.label,
        price: offer.price,
        stock: offer.stock,
        raw: offer.priceText,
        pressed,
        attempts: attempt
      });
      console.log(`  ${opt.label.padEnd(18)} price=${String(offer.price).padStart(8)}  stock=${String(offer.stock).padStart(4)}  aria-pressed=${pressed}  raw=${JSON.stringify(offer.priceText)}  (${Date.now() - t0}ms, attempt ${attempt})`);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.log(`  ${opt.label.padEnd(18)} attempt ${attempt}/${attemptsPerOption} FAILED ${err.code ?? ''} ${err.message.split('\n')[0].slice(0, 80)}`);
      // Fresh page per attempt so the next attempt starts from a locked panel.
      await page.goto(`${config.scrapeBaseUrl}/item/${productId}`, { waitUntil: 'domcontentloaded' });
    }
  }
  if (lastErr) console.log(`  ${opt.label.padEnd(18)} GAVE UP after ${attemptsPerOption} attempts`);
}

console.log(`\nprices: ${results.map((r) => `${r.opt}=${r.price}`).join('  <  ')}`);

// ---------------------------------------------------------------------------
// WHAT CAN AND CANNOT BE CONCLUDED FROM ONE RUN
//
// The store re-rolls its price on every page load. Observed live: the SAME option
// (Standard) returned 7701, 8625, 8682, 9746 and 10988 on different runs, and the
// same run produced Special Edition 8625 < Standard 8682. So a single run can
// support neither "tiers are ordered" nor "tiers are arbitrary" — both are claims
// about jitter, not about option pricing.
//
// I originally printed a confident verdict from one run, and when a run came back
// non-monotonic it confidently printed the opposite verdict. That is the same class
// of bug as the empty-array false positive: a strong claim from insufficient
// evidence. The only things one run CAN establish are checked below; tier
// ordering needs `runs` samples and is reported as a frequency, not a verdict.
// ---------------------------------------------------------------------------

const enough = results.length >= 2;
const allPressed = enough && results.every((r) => r.pressed === 'true');
const distinctPrices = new Set(results.map((r) => r.price)).size;

if (!enough) {
  console.log('verdict: INCONCLUSIVE — fewer than two options were read; no claim can be made');
} else {
  console.log(`all options selectable and confirmed via aria-pressed: ${allPressed ? 'YES' : 'NO'}`);
  console.log(`distinct prices across ${results.length} options: ${distinctPrices}/${results.length}`);
  if (distinctPrices === results.length) {
    console.log('  -> each option produced its own price, so the option genuinely selects a price');
  } else {
    console.log('  -> options collided; either the chips are not taking effect or this run is');
    console.log('     dominated by the store’s per-load jitter. Re-run before concluding.');
  }
}
const retried = results.filter((r) => r.attempts > 1).length;
console.log(`options needing a retry: ${retried}/${results.length}`);

await context.close();
await closeBrowser();
