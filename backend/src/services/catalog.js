import { z } from 'zod';
import config from '../config.js';
import logger from '../util/logger.js';

/**
 * Catalog enumeration + search.
 *
 * WHY native fetch and not a browser: /api/v2/listings is plain JSON with no DOM
 * and no interaction gate. Driving Chromium to read it would be pure waste and
 * would make bulk enumeration ~50x slower.
 *
 * WHY we build search ourselves: the store has no search UI, and its API silently
 * IGNORES ?q= / ?search= / ?name= — results come back in random order with count
 * unchanged. A naive implementation would appear to work while returning garbage.
 * The assignment requires search by partial or full product name, so we enumerate
 * the catalog once and filter locally.
 */

const ListingSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  brand: z.string(),
  category: z.string(),
  sku: z.string(),
});

const ListResponseSchema = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  totalPages: z.number().int(),
  count: z.number().int(),
  results: z.array(ListingSchema),
});

// WHY 60, NOT 20. Measured live: the store silently caps page size at 60 per page
// (requesting `limit=120` returns `perPage: 60, totalPages: 16, results: 60`).
// Asking for 20 therefore tripled the request count for the same 960 slots — 48
// requests instead of 16 — and every extra request is a chance to be throttled.
// Fewer, larger pages is the cheaper way to sample the catalog.
const PAGE_SIZE = 60;
const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_ATTEMPTS = 5;        // per page, for throttled responses
const PAGE_BACKOFF_MS = 700;    // doubles per attempt, plus jitter
const SWEEP_GAP_MS = 150;       // polite pause between page requests
const MAX_SWEEPS = 6;           // sampling passes; stops early once coverage converges
// Must stay below CACHE_TTL_MS so the cache is always refilled in the background
// before it can go stale, rather than expiring under the next user request.
const WARM_INTERVAL_MS = 8 * 60 * 1000;

/** @type {{ at: number, items: Array<z.infer<typeof ListingSchema>>, coverage: number|null } | null} */
let cache = null;
let inFlight = null;

const THROTTLED = new Set([429, 500, 502, 503, 504]);

async function fetchPage(pageNumber) {
  const url = `${config.apiV2}/listings?page=${pageNumber}&limit=${PAGE_SIZE}`;

  // WHY THE RETRY LOOP IS HERE. The store throttles bulk enumeration, and it does
  // so two different ways. Measured live:
  //   - a 48-page sweep came back with 17 pages answering HTTP 503, so a naive
  //     sweep indexed only 457 of 960 products (47.6% coverage) with no error; and
  //   - burst enumeration is refused with HTTP 429 and a JSON body
  //     {"error":"rate_limited","scope":"general","retryAfter":1}.
  //
  // Retrying immediately just earns another refusal, so this backs off
  // exponentially with jitter. Jitter matters for the same reason it matters in the
  // scraper's retry policy: every client on the same 2-hourly schedule would
  // otherwise retry in lockstep and keep the throttling alive.
  let lastErr = null;
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': config.SCRAPE_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });

      // Read as text first: the throttling hint lives in the JSON body, not in a
      // header. `res.json()` on a 429 would be fine, but the success path needs the
      // text too, and reading once keeps the two paths from disagreeing.
      const body = await res.text();

      if (THROTTLED.has(res.status)) {
        lastErr = new Error(`catalog_http_${res.status}`);
        if (attempt >= PAGE_ATTEMPTS) throw lastErr;

        const waitMs = retryAfterMs(res, body, attempt);
        logger.debug(
          { event: 'catalog_throttled', page: pageNumber, status: res.status, attempt, waitMs },
          'store throttled a catalog page — backing off'
        );
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        // A 4xx that is not 429 will not improve by trying again.
        throw new Error(`catalog_http_${res.status}`);
      }

      return ListResponseSchema.parse(JSON.parse(body));
    } catch (err) {
      lastErr = err;
      // A parse failure or a non-throttled HTTP error is not going to fix itself
      // quickly either, but one more try costs little and pages do recover.
      if (attempt >= PAGE_ATTEMPTS) throw err;
      await sleep(Math.min(PAGE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 400, 15000));
    }
  }
  throw lastErr ?? new Error('catalog_page_failed');
}

/**
 * How long to wait before retrying a throttled request.
 *
 * WHY BOTH HEADER AND BODY. This store sends the delay as `retryAfter` in the JSON
 * body and leaves `retry-after` unset, so a header-only reader falls back to blind
 * exponential backoff and ignores what the server actually asked for. The header is
 * still preferred when present, since that is the standard form and other
 * intermediaries may set it.
 */
function retryAfterMs(res, body, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30000);

  try {
    const parsed = JSON.parse(body);
    const seconds = Number(parsed?.retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30000);
  } catch {
    // A throttled response with an unparseable body just means no server hint.
  }

  return Math.min(PAGE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 400, 15000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * WHY THE PAGE ARGUMENT IS EXPLICIT.
 *
 * `page is not defined` — the bug this prevents.
 *
 * The original loop body read `page.results` while the loop variable was `p`, so
 * every page after the first threw a ReferenceError, was caught by the per-page
 * handler, logged as "retrying", then threw again and was logged as "given up".
 * All 47 remaining pages were silently dropped and getCatalog() returned an index
 * of exactly 20 products while reporting success.
 *
 * It is worth recording why this was so quiet:
 *   - the catch block turned a coding error into a data-quality problem,
 *   - "given up" after one retry sounds like a network issue, and
 *   - the shortfall was only ever logged, never reported to the caller.
 *
 * A catch block that handles network failure will also swallow a ReferenceError.
 * Anything that broad needs its own accounting, which is why getCatalog() now
 * reports coverage instead of just returning a list.
 */
async function fetchPageInto(byId, pageNumber) {
  const page = await fetchPage(pageNumber);
  for (const item of page.results) byId.set(item.id, item);
  return page;
}

/**
 * Enumerate the whole catalog.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SATURATION LOOP AND NOT "48 PAGED REQUESTS"  (BUILD_LOG Failure 13)
 *
 * The obvious implementation — walk pages 1..totalPages and merge — is wrong, and
 * it is wrong in a way that produces a perfectly plausible result.
 *
 * MEASURED: with every one of the 48 pages read successfully and no throttling at
 * all, merging them yielded only **611 of the advertised 960** products (63.6%
 * coverage). Repeated ids appeared across pages. So `/listings?page=N` is not a
 * stable slice of the catalog: the store samples randomly and the pages overlap.
 * The API's own `count` says 960, so paging until the last page looks complete
 * while in fact re-reading the same ~600 products over and over.
 *
 * The consequence is the worst kind for a search index: a gap is invisible. The
 * product simply never appears in results, and nothing errors. A user searching for
 * a real product is told it does not exist.
 *
 * So enumeration is a SATURATION problem, not a pagination problem:
 *   - keep sweeping and merging, deduplicating by id,
 *   - stop when the union stops growing (the sampler has converged) or when the
 *     advertised count is reached,
 *   - report the coverage actually achieved, always, so the caller can tell a
 *     complete index from a partial one.
 *
 * Retries for throttling (see fetchPage) remain necessary but are a separate
 * concern: an early build dropped 17 of 48 pages to 503s and never noticed.
 * ---------------------------------------------------------------------------
 */
export async function getCatalogDetailed({ force = false } = {}) {
  if (cache && !force && Date.now() - cache.at < CACHE_TTL_MS) {
    return {
      items: cache.items,
      coverage: cache.coverage,
      complete: cache.coverage >= 0.999,
      sweeps: cache.sweeps,
    };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const started = Date.now();

    // A first request is needed to learn how many pages there are and how many
    // products the store claims. Its results are kept, so it counts as the opening
    // of sweep 1 rather than being a wasted call.
    const probe = await fetchPage(1);
    const total = probe.totalPages;
    const expected = probe.count;

    const byId = new Map(probe.results.map((r) => [r.id, r]));
    let sweeps = 0;
    let previousSize = byId.size;
    let stagnantSweeps = 0;

    // WHY THE LOOP BOTTOM IS `sweeps < MAX_SWEEPS` AND NOT `<=`. `sweeps` counts
    // *completed* passes, starting at 0, so MAX_SWEEPS is literally the number of
    // full passes over the catalog and MAX_SWEEPS = 1 still reads every page. An
    // earlier version seeded `sweeps = 1` before the loop, which quietly made
    // MAX_SWEEPS = 1 mean "fetch only page 1" — the sort of off-by-one that lets a
    // partial index look complete.
    while (sweeps < MAX_SWEEPS) {
      // Page 1 of the first sweep was already read as the probe above.
      const from = sweeps === 0 ? 2 : 1;

      for (let p = from; p <= total; p++) {
        try {
          await fetchPageInto(byId, p);
        } catch (err) {
          // Individual pages still fail when the store throttles. Record and carry
          // on; the next sweep will try them again.
          logger.debug(
            { event: 'catalog_page_failed', page: p, sweep: sweeps + 1, err: err.message },
            'catalog page unreadable this sweep'
          );
        }
        await sleep(SWEEP_GAP_MS);
      }
      sweeps++;

      const growth = byId.size - previousSize;
      previousSize = byId.size;

      // Converged: a whole sweep turned up almost nothing new. Another sweep would
      // re-read the same ids, so stop and report honestly rather than pretending.
      if (growth <= Math.max(2, byId.size * 0.005)) {
        stagnantSweeps++;
        if (stagnantSweeps >= 2) break;
      } else {
        stagnantSweeps = 0;
      }

      if (byId.size >= expected) break;

      logger.info(
        {
          event: 'catalog_resweep',
          sweep: sweeps,
          indexed: byId.size,
          expected,
          coverage: Number((byId.size / expected).toFixed(3)),
          growth,
        },
        'catalog still short of the advertised count — sampling again'
      );
    }

    const items = [...byId.values()];
    const coverage = expected > 0 ? items.length / expected : 1;
    const complete = coverage >= 0.999;
    cache = { at: Date.now(), items, coverage, sweeps };

    if (!complete) {
      // Reported, not swallowed. A short index means search can miss real products.
      logger.warn(
        {
          event: 'catalog_incomplete',
          indexed: items.length,
          expected,
          coverage: Number(coverage.toFixed(3)),
          sweeps,
        },
        'catalog index converged below the advertised count — search may miss products'
      );
    }

    logger.info(
      { event: 'catalog_loaded', count: items.length, expected, sweeps, ms: Date.now() - started },
      'catalog indexed'
    );
    return { items, coverage, complete, sweeps };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Backwards-compatible list-only accessor. */
export async function getCatalog(opts = {}) {
  return (await getCatalogDetailed(opts)).items;
}

/** True when the cache can answer a search without touching the store. */
export function isCatalogWarm() {
  return Boolean(cache) && Date.now() - cache.at < CACHE_TTL_MS;
}

/**
 * Fill the catalog cache in the background. Returns immediately.
 *
 * WHY THIS EXISTS. Measured live: a cold `GET /api/products/search` took 76.1s to
 * build the index; the second identical search took 0.0s. That is not a slow feature,
 * it is an outage with a spinner — Vercel and Render both terminate a proxied request
 * long before 76s, so in production the first search of every cold start would simply
 * fail. Warming on boot, on a timer, and on wake-up moves that cost off the request
 * path entirely.
 *
 * Safe to call redundantly: `inFlight` already collapses concurrent builds into one.
 */
export function warmCatalog({ reason = 'scheduled' } = {}) {
  if (isCatalogWarm()) return;
  if (inFlight) return;

  logger.info({ event: 'catalog_warm_start', reason }, 'warming catalog cache in background');
  const startedAt = Date.now();

  // Deliberately not awaited, and deliberately never throws: a failed warm-up must
  // not take the process down, and the next tick will try again.
  getCatalogDetailed()
    .then((r) => {
      logger.info(
        {
          event: 'catalog_warm_done',
          reason,
          items: r.items.length,
          coverage: r.coverage,
          complete: r.complete,
          sweeps: r.sweeps,
          durationMs: Date.now() - startedAt,
        },
        'catalog cache warm'
      );
    })
    .catch((err) => {
      logger.warn({ event: 'catalog_warm_failed', reason, err: String(err?.message ?? err) },
        'catalog warm-up failed; searches will rebuild on demand');
    });
}

/**
 * Keep the cache warm for the process lifetime.
 *
 * The interval is unref'd so a pending warm-up can never hold a process open — that
 * would hang test and script exits.
 */
export function startCatalogWarmer() {
  warmCatalog({ reason: 'boot' });
  const timer = setInterval(() => warmCatalog({ reason: 'interval' }), WARM_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Search by partial or full product name.
 *
 * Ranked: exact match, then prefix, then substring.
 *
 * WHY ONLY THE NAME. The assignment asks for search by product name. An earlier
 * version also matched brand and category, which quietly answered a different
 * question: searching "gaming" returned every product in the Gaming category
 * rather than products *named* "gaming". That is not what a name search means, and
 * it makes results look wrong in a way that is hard to diagnose.
 *
 * @returns {Promise<{ results: any[], indexed: number, coverage: number|null, complete: boolean }>}
 */
export async function searchProducts(query, { limit = 20 } = {}) {
  const q = String(query ?? '').trim();
  if (q.length < 1) return { results: [], indexed: 0, coverage: null, complete: false };
  if (q.length > 120) throw new Error('query_too_long');

  const needle = q.toLowerCase();
  const { items, coverage, complete } = await getCatalogDetailed();

  const scored = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    let score = -1;
    if (name === needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (name.includes(needle)) score = 2;
    if (score >= 0) scored.push({ ...item, _score: score });
  }

  scored.sort((a, b) => a._score - b._score || a.name.localeCompare(b.name));
  return {
    results: scored.slice(0, Math.min(limit, 50)).map(({ _score, ...rest }) => rest),
    indexed: items.length,
    coverage,
    complete,
  };
}

/**
 * A GET against the store that tolerates throttling.
 *
 * WHY THIS IS SHARED BY BOTH ENDPOINTS. The store rate-limits `/items/{id}` with the
 * same `{"error":"rate_limited","retryAfter":N}` body it uses for `/listings`, and it
 * does so readily. Without a retry here, `POST /api/products` — the "track this
 * product" button, i.e. a core user action — returned HTTP 500 the moment the store
 * pushed back. Having fixed this once for the catalog and then hit it again on the
 * detail route, the retry now lives in one place.
 *
 * @param {string} url
 * @param {string} label  used in log fields and error codes, e.g. 'product'
 * @returns {Promise<Response>} a response that is safe to read
 */
async function fetchStoreJson(url, label) {
  let lastErr = null;

  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': config.SCRAPE_USER_AGENT },
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.text();

      if (res.status === 404) throw new Error('product_not_found');

      if (THROTTLED.has(res.status)) {
        lastErr = new Error(`${label}_http_${res.status}`);
        if (attempt >= PAGE_ATTEMPTS) throw lastErr;

        const waitMs = retryAfterMs(res, body, attempt);
        logger.debug(
          { event: 'store_throttled', label, status: res.status, attempt, waitMs },
          'store throttled a request — backing off'
        );
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new Error(`${label}_http_${res.status}`);
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      if (attempt >= PAGE_ATTEMPTS) throw err;
      await sleep(Math.min(PAGE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 400, 15000));
    }
  }
  throw lastErr ?? new Error(`${label}_request_failed`);
}

/** Fetch one product's full detail (options, specs, reviews) for the tracking form. */
export async function getProductDetail(storeProductId) {
  const id = Number(storeProductId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_product_id');

  const { body } = await fetchStoreJson(`${config.apiV2}/items/${id}`, 'product');

  return z
    .object({
      id: z.number().int(),
      slug: z.string(),
      name: z.string(),
      brand: z.string(),
      category: z.string(),
      sku: z.string(),
      description: z.string().optional(),
      optionAxis: z.string().optional(),
      options: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
    })
    .passthrough()
    .parse(JSON.parse(body));
}

/** Test seam. */
export function __resetCatalogCache() {
  cache = null;
}
