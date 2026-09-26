import config from '../config.js';
import logger from '../util/logger.js';
import { getManifest } from './manifest.js';
import { newContext, closeBrowser } from './browser.js';
import { unlockPrice, InteractionError } from './interaction.js';
import { extractOffer, ExtractionError } from './extract.js';
import { backoffMs, classifyError, isFatal } from './retry.js';
import { recordAttempt, recordSuccess, listTrackedProducts } from '../util/db.js';

/**
 * The scraper orchestrator.
 *
 * Design rules this file exists to enforce, in priority order:
 *
 *  1. NEVER store an unverified value. A price that failed validation produces a
 *     logged attempt with NULL price/stock and no `price_history` row. No
 *     carry-forward of the previous price, no zero, no guess.
 *  2. NEVER stop silently. Every attempt is persisted as it completes, not
 *     buffered to the end of the run.
 *  3. NEVER report a success that was not stored. If the database write fails, the
 *     run says so. A log claiming success while the price is missing is worse than
 *     a failure, because it cannot be noticed.
 *  4. ONE product's failure must not affect the others. Errors are contained per
 *     product, per attempt.
 *  5. ALWAYS release resources. try/finally around the browser context and the
 *     run lock, so a thrown error cannot leak a Chromium process or wedge the
 *     next cron run.
 */

/** A promise-based mutex so the cron and a manual run cannot scrape at once. */
let activeRun = null;

export async function scrapeAllTrackedProducts({ trigger = 'manual' } = {}) {
  if (activeRun) {
    logger.warn({ event: 'run_rejected', reason: 'already_running' }, 'a scrape run is already in progress');
    return { skipped: true, reason: 'already_running' };
  }
  activeRun = (async () => {
    const started = Date.now();
    const summary = { attempted: 0, succeeded: 0, failed: 0, products: [] };

    let products = [];
    try {
      products = await listTrackedProducts({ activeOnly: true });
    } catch (err) {
      logger.error({ event: 'run_aborted', err: err.message }, 'could not load tracked products');
      summary.error = 'db_unavailable';
      return summary;
    }

    if (products.length === 0) {
      logger.warn({ event: 'run_no_products' }, 'no active tracked products');
      return summary;
    }

    logger.info(
      { event: 'run_start', trigger, count: products.length, maxAttempts: config.SCRAPE_MAX_ATTEMPTS },
      `scraping ${products.length} tracked product(s)`
    );

    // Sequential on purpose: polite to the store, and it makes the log readable.
    // SCRAPE_CONCURRENCY exists so this can be raised deliberately, not by accident.
    const queue = [...products];
    const lanes = Math.max(1, Math.min(config.SCRAPE_CONCURRENCY, 4));
    await Promise.all(
      Array.from({ length: lanes }, () =>
        (async () => {
          while (queue.length) {
            const product = queue.shift();
            const result = await scrapeOne(product).catch((err) => {
              // Last-resort containment: scrapeOne handles its own errors, so
              // reaching here means a bug in our own code. Log it, do not crash.
              logger.error(
                { event: 'product_crashed', storeProductId: product.storeProductId, err: err.message },
                'unhandled error'
              );
              return { outcome: 'failed', errorCode: 'internal_error' };
            });
            summary.attempted++;
            if (result.outcome === 'success') summary.succeeded++;
            else summary.failed++;
            summary.products.push({
              storeProductId: product.storeProductId,
              optionId: product.optionId,
              outcome: result.outcome,
              price: result.price ?? null,
              stock: result.stock ?? null,
              errorCode: result.errorCode ?? null,
            });
          }
        })()
      )
    );

    logger.info(
      { event: 'run_complete', trigger, ...summary, products: undefined, ms: Date.now() - started },
      `run finished: ${summary.succeeded} ok, ${summary.failed} failed in ${Date.now() - started}ms`
    );
    return summary;
  })();

  try {
    return await activeRun;
  } finally {
    activeRun = null;
    // Rule 5: the browser is always closed, even if the run threw.
    await closeBrowser().catch(() => {});
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    // Clamped: a hostile or buggy value must not stall a run for hours.
    return Math.min(seconds * 1000, 120000);
  }
  const when = Date.parse(value);
  if (Number.isFinite(when)) {
    return Math.min(Math.max(when - Date.now(), 0), 120000);
  }
  return null;
}

/**
 * Deliberate failure injection, for demos and the screen recording only.
 *
 * WHY THIS EXISTS. Deliverable 3 asks for a recording that shows a slow or failing
 * response so the retry logic and attempt logging are visible. Waiting for the store
 * to fail on cue is not a plan. The fault is thrown *inside* the attempt's try block
 * on purpose: it then travels the real `catch` -> `classifyError` -> retry ->
 * `recordAttempt` path, so the recording shows genuine error handling rather than a
 * mock of it. Nothing downstream knows this happened.
 *
 * Guard rails, because "a demo switch that can corrupt production data" is worse than
 * no switch at all:
 *   - refused outright when NODE_ENV=production;
 *   - fires on the FIRST attempt only, so the run recovers and the recovery is
 *     visible in the same recording;
 *   - fires once per process, not once per product, so a multi-product run does not
 *     look like the store is broken.
 */
const DEMO_FAULTS = {
  // The store throttling us: the most common real failure, and the one that
  // exercises the Retry-After handling.
  throttle: { code: 'http_429', httpStatus: 429, message: 'DEMO: store throttled the price request (injected)' },
  // The panel never opening: exercises the interaction gate failing.
  gate: { code: 'gate_timeout', httpStatus: null, message: 'DEMO: interaction gate never opened (injected)' },
  // A slow upstream: shows the duration column being genuinely large.
  slow: { code: 'slow_response', httpStatus: null, message: 'DEMO: upstream response too slow (injected)' },
};

let demoFaultSpent = false;

function maybeInjectDemoFault({ attempt, storeProductId, optionId }) {
  const requested = process.env.DEMO_FAULT;
  if (!requested || attempt !== 1 || demoFaultSpent) return;

  const fault = DEMO_FAULTS[requested];
  if (!fault) {
    throw Object.assign(
      new Error(`DEMO_FAULT="${requested}" is not one of: ${Object.keys(DEMO_FAULTS).join(', ')}`),
      { code: 'config_invalid' }
    );
  }
  if (config.NODE_ENV === 'production') {
    // Not a warning: a production process must refuse to fake a store failure.
    throw Object.assign(new Error('DEMO_FAULT is a development-only affordance and is refused in production'), {
      code: 'config_invalid',
    });
  }

  demoFaultSpent = true;
  const extraDelayMs = requested === 'slow' ? 8000 : 0;
  logger.warn(
    { event: 'demo_fault_injected', fault: requested, storeProductId, optionId, extraDelayMs },
    `injecting a deliberate "${requested}" failure on attempt 1 (DEMO_FAULT is set)`
  );

  return (async () => {
    if (extraDelayMs) await new Promise((r) => setTimeout(r, extraDelayMs));
    throw Object.assign(new Error(fault.message), { code: fault.code, httpStatus: fault.httpStatus, demo: true });
  })();
}

/**
 * Scrape one (product, option) pair, retrying, persisting every attempt.
 *
 * @param {object} product canonical product row (camelCase) from listTrackedProducts
 * @param {{ maxAttempts?: number }} opts
 */
export async function scrapeOne(product, { maxAttempts = config.SCRAPE_MAX_ATTEMPTS } = {}) {
  const storeProductId = Number(product.storeProductId);
  if (!Number.isInteger(storeProductId) || storeProductId < 1) {
    // Refuse rather than build "/item/undefined" and scrape something else.
    const err = new Error(`tracked product ${product.id} has an invalid storeProductId`);
    err.code = 'config_invalid';
    throw err;
  }

  const productUrl = `${config.scrapeBaseUrl}/item/${storeProductId}`;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();
    const attemptStartedAt = new Date().toISOString();
    let manifest = null;
    let outcome = 'failed';
    let payload = { price: null, stock: null };
    let failure = { code: 'unknown', message: '', httpStatus: null };
    let retryAfterMs = null;

    try {
      // Awaited on purpose: the injector throws asynchronously so it can add a delay
      // first, and this await is what routes that throw into the real catch below.
      await maybeInjectDemoFault({ attempt, storeProductId, optionId: product.optionId });

      // WHY force: the manifest is the source of truth for every selector, and a
      // revision change rotates all of them at once. Caching it for the life of the
      // process means a revision change is never noticed, which is exactly the
      // "selectors are randomized" obstacle the assignment calls out. One small
      // JSON request per attempt is a negligible price for never using a stale class.
      manifest = await getManifest({ force: true });

      const context = await newContext();
      try {
        const page = await context.newPage();

        // Watch the page's own price request. Without this we cannot tell the
        // difference between "the interaction failed" and "the store rate-limited
        // us", and we would retry a 429 blindly instead of waiting as asked.
        const quoteCalls = [];
        page.on('response', (res) => {
          if (/\/api\/v2\/quotes/.test(res.url())) {
            quoteCalls.push({
              status: res.status(),
              retryAfter: res.headers()['retry-after'] ?? null,
            });
          }
        });

        let response;
        try {
          response = await page.goto(productUrl, {
            waitUntil: 'domcontentloaded',
            timeout: config.SCRAPE_TIMEOUT_MS,
          });
        } catch (err) {
          const err2 = new Error(`nav failed: ${err.message}`);
          err2.code = /Timeout/i.test(err.message) ? 'nav_timeout' : 'nav_error';
          throw err2;
        }

        if (response?.status() === 404) {
          const err = new Error('store returned 404 for this product id');
          err.code = 'product_not_found';
          throw err;
        }

        // ---- the two mandatory interaction steps
        await unlockPrice(
          page,
          { optionAxis: product.optionAxis, optionLabel: product.optionLabel },
          `.${manifest.classes.priceWrap}`,
          { slowMo: config.slowMo, productUrl }
        );

        // If the store rate-limited the price request, that is the real story —
        // report it as such instead of letting it look like a parsing failure.
        const lastQuote = quoteCalls.at(-1);
        if (lastQuote && (lastQuote.status === 429 || lastQuote.status >= 500)) {
          retryAfterMs = parseRetryAfter(lastQuote.retryAfter);
          const err = new Error(`price request returned HTTP ${lastQuote.status}`);
          err.code = lastQuote.status === 429 ? 'http_429' : 'http_5xx';
          err.httpStatus = lastQuote.status;
          throw err;
        }

        // ---- manifest-driven, decoy-safe extraction
        const offer = await extractOffer(page, manifest);

        payload = { price: offer.price, stock: offer.stock };
        outcome = 'success';

        logger.info(
          {
            event: 'scrape_success',
            storeProductId,
            optionId: product.optionId,
            price: offer.price,
            stock: offer.stock,
            attempt,
            manifestRevision: manifest.revision,
            decoysSeen: offer.decoyTexts.length,
          },
          `price=${offer.price} stock=${offer.stock} (attempt ${attempt})`
        );
      } finally {
        // Rule 5: never leak a context, even on throw.
        await context.close().catch(() => {});
      }
    } catch (err) {
      failure = classifyError(err);
      const willRetry = !isFatal(failure.code) && attempt < maxAttempts;
      // The distinction the CSV depends on: if we recover later, the earlier
      // failures are "retried"; if we never recover, the last one is "failed".
      outcome = willRetry ? 'retried' : 'failed';

      logger[willRetry ? 'warn' : 'error'](
        {
          event: 'scrape_attempt_failed',
          storeProductId,
          optionId: product.optionId,
          attempt,
          maxAttempts,
          code: failure.code,
          message: failure.message,
          retryAfterMs,
          willRetry,
        },
        willRetry
          ? `attempt ${attempt} failed (${failure.code}); retrying`
          : `attempt ${attempt} failed (${failure.code}); giving up`
      );
    }

    const attemptRow = {
      trackedProductId: product.id,
      attemptedAt: attemptStartedAt,
      outcome,
      attemptNumber: attempt,
      price: outcome === 'success' ? payload.price : null,
      stock: outcome === 'success' ? payload.stock : null,
      httpStatus: failure.httpStatus ?? null,
      errorCode: outcome === 'success' ? null : failure.code,
      errorMessage: outcome === 'success' ? null : String(failure.message ?? '').slice(0, 500),
      durationMs: Date.now() - attemptStart,
      manifestRevision: manifest?.revision ?? null,
    };

    if (outcome === 'success') {
      // Rule 3 + the atomicity fix: ONE call writes the attempt row AND the
      // history row. Two separate inserts could leave a logged success with no
      // stored price, and a double write would log every success twice.
      try {
        await recordSuccess({
          trackedProductId: product.id,
          price: payload.price,
          stock: payload.stock,
          scrapedAt: attemptStartedAt,
          attempt: attemptRow,
        });
      } catch (err) {
        // The price was observed but not stored. Reporting success here would be a
        // lie the database could contradict, so the run records the truth.
        logger.error(
          { event: 'history_write_failed', storeProductId, err: err.message },
          'price was validated but could not be stored — reporting failure'
        );
        return { outcome: 'failed', errorCode: 'db_write_failed', price: null, stock: null };
      }
      return { outcome: 'success', price: payload.price, stock: payload.stock };
    }

    // Rule 2: persist the failed attempt immediately, whatever happened.
    try {
      await recordAttempt(attemptRow);
    } catch (err) {
      // A DB write failure is serious but must not be swallowed silently.
      logger.error({ event: 'attempt_log_failed', err: err.message }, 'could not persist scrape attempt');
    }

    if (isFatal(failure.code)) {
      return { outcome: 'failed', errorCode: failure.code };
    }

    if (attempt < maxAttempts) {
      // Honour Retry-After when the store sent one, otherwise exponential jitter.
      const wait = retryAfterMs ?? backoffMs(attempt);
      logger.debug({ event: 'backoff', waitMs: wait, attempt, fromRetryAfter: retryAfterMs !== null }, 'waiting before retry');
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return { outcome: 'failed', errorCode: 'exhausted_attempts' };
}

export { InteractionError, ExtractionError };
