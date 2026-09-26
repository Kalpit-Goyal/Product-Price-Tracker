#!/usr/bin/env node
/**
 * CLI scraper — the "observable (headed)" deliverable and the local test harness.
 *
 * Usage:
 *   node scripts/scrape.js                        # headless, all tracked products
 *   node scripts/scrape.js --headed               # visible Chromium (screen recording)
 *   node scripts/scrape.js --headed --slowmo=60   # legible on camera WITHOUT breaking
 *                                                  # the interaction gate (see below)
 *   node scripts/scrape.js --demo-fault=gate       # fail attempt 1 on cue, then recover
 *   node scripts/scrape.js --product=2022 --option=o2 --ad-hoc
 *   node scripts/scrape.js --attempts=3
 *
 * --ad-hoc scrapes a product that is NOT in the database, so the scraper can be
 * proven before Supabase exists or before anything is tracked.
 *
 * --demo-fault=gate|throttle|slow injects one deliberate failure on attempt 1 so the
 * retry logic and the attempt log are visible in a recording. It is a CLI flag
 * rather than an env var on purpose: `cross-env` is not a dependency of this project,
 * and `FOO=bar node x.js` does not work in cmd.exe or PowerShell. A flag is the only
 * form that behaves identically on every platform.
 *
 * SLOW-MO WARNING, MEASURED. The hover gate is timing sensitive: it needs ~14 moves
 * at ~40ms spacing plus a dwell. Measured headed success rate for all three options
 * of one product: slowMo 0 -> 3/3, 60 -> 3/3, 120 -> 3/3, 250 -> 0/3 (every attempt
 * died on `interaction_gate_never_opened`). The knob that makes a run look "nice and
 * slow" for a camera is the same knob that makes the scraper fail. Use 60.
 */
import { chromium } from 'playwright';
import config from '../src/config.js';
import logger from '../src/util/logger.js';
import { getManifest } from '../src/services/manifest.js';
import { newContext, closeBrowser } from '../src/services/browser.js';
import { unlockPrice } from '../src/services/interaction.js';
import { extractOffer } from '../src/services/extract.js';
import { scrapeAllTrackedProducts } from '../src/services/scraper.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};

const headed = flag('headed') === true || config.headless === false;
const slowMoArg = Number(flag('slowmo', 0)) || 0;
const productArg = flag('product', null);
const optionArg = flag('option', null) ?? 'o1';
const attempts = Number(flag('attempts', config.SCRAPE_MAX_ATTEMPTS)) || config.SCRAPE_MAX_ATTEMPTS;
const adHoc = flag('ad-hoc') === true;

// Sets the env var the injector in scraper.js reads. Done here, in JS, because
// `DEMO_FAULT=gate node scripts/scrape.js` silently does nothing on Windows.
const demoFault = flag('demo-fault', null);
if (demoFault && demoFault !== true) {
  process.env.DEMO_FAULT = String(demoFault);
  console.log(
    `\x1b[33m  DEMO_FAULT="${demoFault}" — attempt 1 will fail on purpose so the retry and the attempt log are visible.\x1b[0m`
  );
} else if (demoFault === true) {
  console.error('  --demo-fault needs a value: gate | throttle | slow');
  process.exit(64);
}

if (slowMoArg) config.slowMo = slowMoArg;

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

function banner(text) {
  console.log(`\n${BOLD}${'='.repeat(72)}${RESET}`);
  console.log(`${BOLD}  ${text}${RESET}`);
  console.log(`${BOLD}${'='.repeat(72)}${RESET}`);
}

async function runAdHoc() {
  const storeProductId = Number(productArg);
  if (!Number.isInteger(storeProductId) || storeProductId < 1) {
    console.error('--ad-hoc requires --product=<numeric id>');
    process.exit(2);
  }

  // Resolve the option id -> human label from the store's own API, so ad-hoc runs
  // exercise the real "select an option" path instead of silently using whatever
  // default the page happens to preselect.
  let optionAxis = null;
  let optionLabel = null;
  try {
    const res = await fetch(`${config.apiV2}/items/${storeProductId}`);
    const detail = await res.json();
    optionAxis = detail.optionAxis ?? null;
    optionLabel = detail.options?.find((o) => o.id === String(optionArg))?.label ?? null;
  } catch (err) {
    console.log(`${YELLOW}could not resolve option label (${err.message}); using page default${RESET}`);
  }

  const product = {
    id: `adhoc-${storeProductId}-${optionArg}`,
    storeProductId,
    optionId: String(optionArg),
    optionLabel,
  };

  banner(
    `AD-HOC SCRAPE  product=${storeProductId}  option=${optionArg}` +
      `${optionLabel ? ` ("${optionLabel}")` : ''}  headless=${!headed}`
  );
  console.log(`${DIM}target: ${config.scrapeBaseUrl}/item/${storeProductId}${RESET}`);

  const manifest = await getManifest();
  console.log(
    `${DIM}manifest revision ${manifest.revision}  priceValue=.${manifest.classes.priceValue}  ` +
      `priceTag=${manifest.priceTag}  carrier=${manifest.priceCarrier}${RESET}`
  );

  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const t0 = Date.now();
    process.stdout.write(`${DIM}attempt ${attempt}/${attempts} …${RESET} `);
    let context;
    try {
      context = await newContext();
      const page = await context.newPage();
      const res = await page.goto(`${config.scrapeBaseUrl}/item/${storeProductId}`, {
        waitUntil: 'domcontentloaded',
        timeout: config.SCRAPE_TIMEOUT_MS,
      });

      const interaction = await unlockPrice(
        page,
        { optionAxis, optionLabel },
        `.${manifest.classes.priceWrap}`,
        { slowMo: config.slowMo }
      );
      const offer = await extractOffer(page, manifest);

      console.log(`${GREEN}OK${RESET} in ${Date.now() - t0}ms`);
      console.log(`  status        ${res.status()}`);
      console.log(`  option        ${optionLabel ?? '(page default)'}`);
      console.log(`  interaction   ${interaction.moves} moves, ${interaction.dwellMs}ms dwell, clicked CTA`);
      console.log(`  price  ${BOLD}${offer.price}${RESET}  (rendered ${JSON.stringify(offer.priceText)})`);
      console.log(`  stock  ${BOLD}${offer.stock}${RESET}  (rendered ${JSON.stringify(offer.stockText)})`);
      console.log(`  mrp    ${offer.mrp ?? '-'}`);
      console.log(`  seller ${offer.seller ?? '-'}   delivery ${offer.delivery ?? '-'}`);
      console.log(`  store's own attempt count: ${offer.storeAttemptCount ?? 'n/a'}`);
      console.log(`  hidden nodes sharing the price class (rejected): ${offer.decoyTexts.length} ${JSON.stringify(offer.decoyTexts)}`);
      await closeBrowser();
      return 0;
    } catch (err) {
      lastErr = err;
      console.log(`${YELLOW}FAIL${RESET} ${err.code ?? ''} ${err.message.split('\n')[0].slice(0, 110)}`);
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
    } finally {
      await context?.close().catch(() => {});
    }
  }

  console.error(`\n${RED}gave up after ${attempts} attempts${RESET}`);
  console.error(`last error: ${lastErr?.code ?? ''} ${lastErr?.message}`);
  await closeBrowser();
  return 1;
}

async function main() {
  logger.level = 'warn'; // keep the CLI output readable; full logs via `npm start`

  if (adHoc) return runAdHoc();

  banner(`SCRAPE RUN  headless=${!headed}${config.slowMo ? `  slowMo=${config.slowMo}` : ''}  maxAttempts=${attempts}`);
  const summary = await scrapeAllTrackedProducts();

  banner('SUMMARY');
  console.log(`  attempted  ${summary.attempted}`);
  console.log(`  succeeded  ${GREEN}${summary.succeeded}${RESET}`);
  console.log(`  failed     ${summary.failed ? RED : ''}${summary.failed}${summary.failed ? RESET : ''}`);
  if (summary.skipped) console.log(`  ${YELLOW}skipped: ${summary.reason}${RESET}`);
  for (const p of summary.products ?? []) {
    const colour = p.outcome === 'success' ? GREEN : RED;
    console.log(
      `  ${colour}${p.outcome.padEnd(8)}${RESET} product=${p.storeProductId} option=${p.optionId} ` +
        `${p.price !== null && p.price !== undefined ? `price=${p.price} stock=${p.stock}` : p.errorCode ?? ''}`
    );
  }
  if (summary.error) console.log(`  ${RED}run error: ${summary.error}${RESET}`);
  await closeBrowser();
  return summary.failed > 0 ? 1 : 0;
}

process.exit(await main());
