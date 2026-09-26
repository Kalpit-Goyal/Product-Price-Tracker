import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';

import config from './config.js';
import logger from './util/logger.js';
import { getCatalogDetailed, searchProducts, getProductDetail, warmCatalog, isCatalogWarm } from './services/catalog.js';
import { getBrowserStatus } from './services/browser.js';
import { scrapeAllTrackedProducts } from './services/scraper.js';
import {
  listTrackedProducts,
  upsertTrackedProduct,
  deleteTrackedProduct,
  getHistory,
  getAttempts,
  getLatestPrices,
  getAllAttemptsWithProduct,
  getHealthSnapshot,
  createScrapeRun,
  finishScrapeRun,
  getScrapeRun,
  usingMemoryDb,
} from './util/db.js';

/**
 * The HTTP API.
 *
 * Written as a factory that takes no arguments and returns the app, so tests can
 * import it without starting a listener.
 *
 * Two rules run through every handler here:
 *
 *  1. A handler that cannot do its job says so with the right status code. No route
 *     returns an empty list to mean "something went wrong", because an empty list
 *     and a real empty list are indistinguishable to the caller.
 *  2. Nothing here invents data. If the scraper has never succeeded for a product,
 *     the API says `latestPrice: null`. It does not fall back to the last known
 *     price, and the UI is not allowed to either.
 */

export const app = express();

app.use(express.json({ limit: '64kb' }));

/**
 * WHY permissive CORS here specifically: the frontend is deployed to Vercel and the
 * API to Render, so they are different origins by design. This is a public,
 * read-mostly API and the only mutating route that costs anything (`/api/scrape/run`)
 * is gated by a shared secret rather than by origin. Locking CORS to one origin
 * would mean redeploying the API every time the frontend URL changed.
 */
app.use(cors());
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

/** Wrap an async handler so a rejected promise becomes a 500, not a hung request. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Constant-time-ish comparison so the cron secret is not trivially guessable. */
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------ health

app.get(
  '/api/health',
  wrap(async (req, res) => {
    const snapshot = await getHealthSnapshot().catch((err) => ({ mode: 'unavailable', error: err.message }));
    const browserStatus = getBrowserStatus();
    res.json({
      status: snapshot.mode === 'unavailable' ? 'degraded' : 'ok',
      mode: snapshot.mode,
      store: usingMemoryDb ? 'local-json-file' : 'supabase',
      trackedProducts: snapshot.trackedProducts ?? null,
      attempts: snapshot.attempts ?? null,
      successes: snapshot.successes ?? null,
      lastSuccessAt: snapshot.lastSuccessAt ?? null,
      target: config.scrapeBaseUrl,
      uptimeSeconds: Math.round(process.uptime()),
      // Whether Chromium can actually be launched. This is here because a missing
      // Playwright browser is the single most deceptive failure this service has: the
      // deploy is green, health is 200, every route works, and then every scrape fails
      // with "Executable doesn't exist". Surfacing it on the endpoint that deploy
      // checks and humans poll turns a silent data outage into a visible one.
      // 'unknown' until the startup probe finishes.
      browserAvailable: browserStatus.available,
      browserCheckedAt: browserStatus.checkedAt,
      // The first line of the launch failure, so a red deploy can be diagnosed from
      // this endpoint alone instead of digging through build logs. It distinguishes
      // the two causes that need opposite fixes: "Executable doesn't exist" means the
      // browser was not installed or not persisted (check PLAYWRIGHT_BROWSERS_PATH),
      // while "Host system is missing dependencies" means it installed fine but the
      // base image lacks its shared libraries, and only a Docker image can fix that.
      browserError: browserStatus.error,
      // Tells the dashboard whether it may offer a "run the scraper now" button.
      //
      // In production the answer is always false and cannot be overridden: the cron
      // job is the only thing that should start a scrape, and the only way to prove
      // that is for the endpoint to demand a secret that is never sent to a browser.
      // The flag exists so the UI can explain *why* the button is absent instead of
      // just hiding it — a missing control with no explanation reads as an oversight.
      allowManualRun: config.NODE_ENV !== 'production' && process.env.ALLOW_DEV_TRIGGER === '1',
      nodeEnv: config.NODE_ENV,
      // Lets the dashboard explain a slow first search instead of showing an
      // unexplained spinner: a cold index costs ~60s of live store traffic, a warm
      // one answers in under a millisecond.
      catalogWarm: isCatalogWarm(),
    });

    // WHY THE HEALTH CHECK WARMS THE CATALOG. A cheap uptime probe is also the first
    // request a sleeping host receives, so it is the earliest moment we learn the
    // process was restarted and the in-memory search index is gone. Kicking a
    // background refill here means the index is already rebuilt by the time a real
    // search arrives, instead of the search paying ~76s and being cut off by the
    // proxy. Non-blocking: health must stay fast, so a cold index never delays it.
    warmCatalog({ reason: 'health-probe' });
  })
);

// ------------------------------------------------------------------ search

app.get(
  '/api/products/search',
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      return res.status(400).json({ error: 'bad_request', message: 'q must be at least 2 characters' });
    }

    const catalog = await getCatalogDetailed();
    const { results, coverage, complete } = await searchProducts(q, { limit: 20 });

    res.json({
      query: q,
      catalogSize: catalog.items.length,
      // The store has no search of its own, so this is OUR index over the paginated
      // catalog. Saying so in the payload stops a reader assuming the store ranked
      // these results.
      source: 'local-index-over-/api/v2/listings',
      // If the index is short, results can be incomplete. Reporting that beats
      // returning a confident-looking list that is quietly missing products.
      indexCoverage: coverage === null ? null : Number(coverage.toFixed(3)),
      indexComplete: complete,
      resultCount: results.length,
      results: results.map((p) => ({
        id: p.id,
        name: p.name,
        brand: p.brand ?? null,
        category: p.category ?? null,
        sku: p.sku ?? null,
        sourceUrl: `${config.scrapeBaseUrl}/item/${p.id}`,
      })),
    });
  })
);

// ---------------------------------------------------- tracked products (CRUD)

app.get(
  '/api/products',
  wrap(async (req, res) => {
    const [products, latest] = await Promise.all([listTrackedProducts(), getLatestPrices()]);

    res.json({
      count: products.length,
      products: products.map((p) => {
        const last = latest.get(p.id) ?? null;
        return {
          id: p.id,
          storeProductId: p.storeProductId,
          productName: p.productName,
          brand: p.brand,
          category: p.category,
          sku: p.sku,
          optionAxis: p.optionAxis,
          optionId: p.optionId,
          optionLabel: p.optionLabel,
          sourceUrl: p.sourceUrl,
          active: p.active,
          lastScrapedAt: p.lastScrapedAt,
          // Explicitly null when there has never been a success. The UI must show
          // "never scraped", not the last value it happens to have cached.
          latestPrice: last ? last.price : null,
          latestStock: last ? last.stock : null,
          latestCurrency: last ? last.currency : null,
          latestScrapedAt: last ? last.scrapedAt : null,
        };
      }),
    });
  })
);

// The options a product is sold in.
//
// WHY THIS EXISTS. `POST /api/products` validates a requested option against the
// store, and its 422 response helpfully lists what is available — but making the UI
// submit a guess just to discover the options is a broken flow. Tracking an
// option+price pair is meaningless without knowing which options exist, so the
// picker needs them up front.
//
// It is keyed by *store* product id, not by our tracked id, because at this point
// nothing is tracked yet. The two are easy to confuse, so the param name says which
// one it is.
app.get(
  '/api/products/:storeProductId/options',
  wrap(async (req, res) => {
    const storeProductId = Number(req.params.storeProductId);
    if (!Number.isInteger(storeProductId) || storeProductId <= 0) {
      return res.status(400).json({ error: 'bad_request', message: 'storeProductId must be a positive integer' });
    }

    const detail = await getProductDetail(storeProductId);
    res.json({
      storeProductId,
      name: detail.name,
      brand: detail.brand,
      optionAxis: detail.optionAxis ?? null,
      options: (detail.options ?? []).map((o) => ({ id: o.id, label: o.label })),
    });
  })
);

const TrackBody = z.object({
  storeProductId: z.coerce.number().int().positive(),
  optionId: z.string().min(1).optional(),
  optionLabel: z.string().min(1).optional(),
});

app.post(
  '/api/products',
  wrap(async (req, res) => {
    const parsed = TrackBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'storeProductId must be a positive integer',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const { storeProductId, optionId, optionLabel } = parsed.data;

    // Resolve the product from the store rather than trusting the client for its
    // name/brand: a stale or wrong name in our database is a lie we would then show
    // in the UI forever.
    const detail = await getProductDetail(storeProductId);
    if (!detail) {
      return res.status(404).json({ error: 'not_found', message: `no product ${storeProductId} in the store` });
    }

    const options = detail.options ?? [];
    if (options.length === 0) {
      return res.status(422).json({
        error: 'no_options',
        message: 'this product exposes no options, so it cannot be tracked as an option+price pair',
      });
    }

    let chosen = null;
    let optionSource = 'requested';
    if (optionId) chosen = options.find((o) => o.id === String(optionId)) ?? null;
    else if (optionLabel) {
      chosen = options.find((o) => o.label.toLowerCase() === String(optionLabel).toLowerCase()) ?? null;
    } else {
      // Defaulting is only safe because the *client asked for nothing specific*. If
      // the client names an option that does not exist, that is an error and is
      // refused below — defaulting there is how a product ends up tracked under an
      // option it does not sell. The caller is told which option was chosen and that
      // it was a default, so the UI never has to guess what it just subscribed to.
      chosen = options[0];
      optionSource = 'default';
    }

    if (!chosen) {
      // Refuse rather than defaulting. Defaulting here is how a product ends up
      // tracked under an option it does not sell.
      return res.status(422).json({
        error: 'option_not_found',
        message: `option ${JSON.stringify(optionId ?? optionLabel)} is not offered by this product`,
        available: options.map((o) => ({ id: o.id, label: o.label })),
      });
    }

    const row = await upsertTrackedProduct({
      storeProductId,
      productName: detail.name ?? `product ${storeProductId}`,
      brand: detail.brand ?? null,
      category: detail.category ?? null,
      sku: detail.sku ?? null,
      optionAxis: detail.optionAxis ?? null,
      optionId: chosen.id,
      optionLabel: chosen.label,
      sourceUrl: `${config.scrapeBaseUrl}/item/${storeProductId}`,
    });

    res.status(201).json({ tracked: row, optionSource });
  })
);

app.delete(
  '/api/products/:id',
  wrap(async (req, res) => {
    try {
      await deleteTrackedProduct(String(req.params.id));
      res.json({ deleted: req.params.id });
    } catch (err) {
      if (err.code === 'not_found') {
        return res.status(404).json({ error: 'not_found', message: `no tracked product ${req.params.id}` });
      }
      throw err;
    }
  })
);

app.get(
  '/api/products/:id/history',
  wrap(async (req, res) => {
    const history = await getHistory(String(req.params.id), { limit: 2000 });
    res.json({
      trackedProductId: req.params.id,
      count: history.length,
      // Every point is an independent observation. The store re-rolls its price on
      // each load, so this series is noisy by nature; the API says so rather than
      // pretending it is a stable quantity.
      note: 'each point is one successful observation at the time shown; the store re-rolls price on every page load',
      history,
    });
  })
);

app.get(
  '/api/products/:id/attempts',
  wrap(async (req, res) => {
    const attempts = await getAttempts(String(req.params.id), { limit: 500 });
    res.json({
      trackedProductId: req.params.id,
      count: attempts.length,
      attempts,
    });
  })
);

// ------------------------------------------------------------------ CSV export

app.get(
  '/api/attempts.csv',
  wrap(async (req, res) => {
    const rows = await getAllAttemptsWithProduct({ limit: 50000 });
    const csv = stringify(
      rows,
      {
        header: true,
        columns: [
          'attemptedAt',
          'storeProductId',
          'productName',
          'optionLabel',
          'outcome',
          'price',
          'stock',
        ],
      }
    );

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="scrape-attempts-${stamp}.csv"`);
    res.send(csv);
  })
);

// ------------------------------------------------------------------ scraping

app.post(
  '/api/scrape/run',
  wrap(async (req, res) => {
    // WHY THE DEV-ONLY BYPASS EXISTS. /api/health advertises `allowManualRun`, and the
    // dashboard renders a "run now" button when it is true. That flag was useless: the
    // button sent no secret, so it could only ever have returned 401. The two now
    // agree, and they agree in exactly one direction.
    //
    // The condition is the same expression the health route uses, and it is
    // deliberately impossible to satisfy in production: NODE_ENV is never
    // 'production' there, so the secret is always required and the bypass is dead
    // code. A browser still cannot start a scrape on the deployed API. The bypass
    // exists so that a developer running locally with a seeded store does not have to
    // paste a secret into devtools, not to weaken the deployed endpoint.
    const devTriggerAllowed =
      config.NODE_ENV !== 'production' && process.env.ALLOW_DEV_TRIGGER === '1';

    if (!devTriggerAllowed && !secretMatches(req.get('x-cron-secret'), config.CRON_SECRET)) {
      // 401, not 403: the caller has not proved who they are.
      return res.status(401).json({ error: 'unauthorized', message: 'X-Cron-Secret header required' });
    }

    // A secret-authenticated call is the external scheduler, not a person. The dev-UI
    // path is the only unauthenticated one and it is dead code in production, so every
    // 'cron' run here really did arrive from the scheduler. Labelling it 'cron' rather
    // than the vaguer 'api' is what makes a scheduled cycle verifiable from the database
    // instead of only from the scheduler's own history.
    const trigger = devTriggerAllowed && !req.get('x-cron-secret') ? 'dev-ui' : 'cron';
    const run = await createScrapeRun(trigger);
    logger.info(
      { event: 'run_requested', runId: run.id, viaSecret: Boolean(req.get('x-cron-secret')) },
      'scrape run requested via API'
    );

    // Respond immediately with the run id. A full run drives a real browser and can
    // take minutes; making the cron job wait for it would exceed most HTTP timeouts
    // and the caller would never learn whether it had worked.
    res.status(202).json({ runId: run.id, status: 'accepted' });

    scrapeAllTrackedProducts({ trigger: `${trigger}:${run.id}` })
      .then(async (summary) => {
        await finishScrapeRun(run.id, summary);
        logger.info({ event: 'run_finished_via_api', runId: run.id, ...summary, products: undefined }, 'api-triggered run finished');
      })
      .catch(async (err) => {
        logger.error({ event: 'run_failed_via_api', runId: run.id, err: err.message }, 'api-triggered run threw');
        await finishScrapeRun(run.id, { attempted: 0, succeeded: 0, failed: 1 }).catch(() => {});
      });
  })
);

app.get(
  '/api/scrape/runs/:id',
  wrap(async (req, res) => {
    const run = await getScrapeRun(String(req.params.id));
    if (!run) return res.status(404).json({ error: 'not_found', message: `no run ${req.params.id}` });
    res.json({
      runId: run.id,
      trigger: run.trigger,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      status: run.finished_at ? 'finished' : 'running',
      attempted: run.attempted,
      succeeded: run.succeeded,
      failed: run.failed,
    });
  })
);

// ------------------------------------------------------------------ errors

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `no route for ${req.method} ${req.path}` });
});

// Central error handler. A DB or network failure must not surface as an empty
// success body, so anything thrown ends up as a 500 with a real message.
app.use((err, req, res, _next) => {
  let status = err.status ?? err.statusCode ?? 500;
  let code = err.code ?? 'internal_error';
  let message = err.message ?? 'unexpected error';

  // WHY AN UPSTREAM 429 MUST NOT BECOME A 500. The store rate-limits us, and when it
  // does, retrying already happened further down (see fetchStoreJson). Reporting
  // that as "internal error" tells the caller the server is broken when in fact the
  // request was merely too early, and it invites a pointless retry storm from the
  // frontend. 503 + Retry-After says "the store is busy, come back shortly" — which
  // is both accurate and actionable.
  // WHY DOMAIN ERRORS NEED MAPPING HERE. A route can only return 404 for a missing
  // product if the lookup *returns* null. When the store answers 404 the lookup
  // *throws* instead, so the request fell through to this handler and a genuinely
  // missing product was reported to the user as HTTP 500 — indistinguishable from a
  // broken server. Mapping the known domain codes keeps the status honest.
  if (err.message === 'product_not_found') {
    status = 404;
    code = 'not_found';
    message = 'that product does not exist in the store';
  } else if (err.message === 'invalid_product_id') {
    status = 400;
    code = 'bad_request';
    message = 'product id must be a positive integer';
  } else if (/(?:_http_429|^http_429)$/.test(err.message ?? '')) {
    status = 503;
    code = 'store_rate_limited';
    message = 'the store is rate limiting requests — try again shortly';
  } else if (/(?:_http_5\d\d|^http_5\d\d)$/.test(err.message ?? '')) {
    status = 503;
    code = 'store_unavailable';
    message = 'the store returned a server error — try again shortly';
  }

  if (res.headersSent) return;

  logger.error(
    { event: 'request_failed', url: req.originalUrl, err: message, code, status },
    'request failed'
  );
  res.status(status).json({ error: code, message });
});

export default app;
