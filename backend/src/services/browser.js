import { chromium } from 'playwright';
import config from '../config.js';
import logger from '../util/logger.js';

/**
 * Browser lifecycle.
 *
 * WHY one shared browser per run rather than one per product: launching Chromium
 * costs ~1s and ~150MB. With a 2-hourly cadence and a bounded product count, one
 * launch per run is the difference between a scrape that comfortably fits inside
 * a Render request window and one that does not.
 *
 * WHY a fresh context per attempt: it drops cookies, storage and any partially
 * loaded page state, so a retry never inherits the wreckage of the attempt before
 * it. Verified to be the difference between recovering and wedging.
 */

let browser = null;
let launching = null;

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (launching) return launching;

  launching = (async () => {
    logger.info(
      { event: 'browser_launch', headless: config.headless, slowMo: config.slowMo },
      config.headless ? 'launching headless chromium' : 'launching HEADED chromium (observable mode)'
    );

    const instance = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMo,
      args: [
        '--disable-dev-shm-usage',   // Render containers have a small /dev/shm
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    instance.on('disconnected', () => {
      logger.warn({ event: 'browser_disconnected' }, 'browser disconnected');
      browser = null;
    });

    browser = instance;
    return instance;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/** Fresh, isolated context with hard timeouts so a hung page cannot wedge a run. */
export async function newContext() {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: config.SCRAPE_USER_AGENT,
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    // Deliberately NOT blocking images/fonts: the store's panel is the only thing
    // we read, but blocking aggressively changed layout timing during testing and
    // made the interaction gate less reliable. Measure before optimising.
  });

  context.setDefaultTimeout(config.SCRAPE_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(config.SCRAPE_TIMEOUT_MS);
  return context;
}

export async function closeBrowser() {
  if (browser?.isConnected()) {
    await browser.close().catch(() => {});
    logger.debug({ event: 'browser_closed' }, 'browser closed');
  }
  browser = null;
}

/**
 * Proves a browser can actually be launched, without scraping anything.
 *
 * WHY THIS EXISTS. A missing Playwright browser is invisible until the first real
 * scrape. The service boots, /api/health returns 200, every route answers, the deploy
 * looks completely green -- and then all 11 products fail with "Executable doesn't
 * exist". That is precisely how the first deployed run failed, and it cost a full
 * deploy cycle to diagnose from the database after the fact.
 *
 * Checking at startup inverts that: the failure is reported on the deploy that caused
 * it, in the log next to the build, instead of surfacing hours later as an empty price
 * history. It launches and immediately closes a browser, costing ~1s and no scraping.
 */
export async function verifyBrowserAvailable() {
  try {
    const probe = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await probe.close();
    logger.info({ event: 'browser_verified' }, 'playwright browser launches successfully');
    return true;
  } catch (err) {
    // Deliberately does NOT exit the process. The API is still useful without a browser
    // -- history, search and CSV all work off the database -- so a hard exit would turn
    // a degraded deployment into an unreachable one. This is loud in the log instead.
    logger.error(
      { event: 'browser_unavailable', err: err.message },
      'CANNOT LAUNCH A BROWSER. Scraping will fail on every product. If this says ' +
        '"Executable doesn\'t exist", the build did not run ' +
        '"npx playwright install chromium". If it says the host is missing system ' +
        'libraries, the native runtime cannot supply them and a Playwright Docker ' +
        'base image is required.'
    );
    return false;
  }
}
