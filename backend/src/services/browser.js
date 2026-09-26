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
