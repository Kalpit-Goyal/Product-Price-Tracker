import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import config from '../config.js';
import logger from './logger.js';

/**
 * Supabase access.
 *
 * WHY the service-role key: Row Level Security stays ON and the anon key is never
 * used, because all reads and writes go through this backend. The key lives only
 * in a server-side env var and is never exposed to the browser.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY READ GOES THROUGH rowToProduct()  (BUILD_LOG Failure 10)
 *
 * Postgres columns are snake_case (`store_product_id`); the rest of this codebase
 * is camelCase (`storeProductId`). That boundary has to be crossed in exactly one
 * place, in both directions, or the two halves disagree.
 *
 * It previously did not, and the disagreement was silent and mode-dependent:
 *   - `upsertTrackedProduct` wrote camelCase keys into the memory store but
 *     snake_case keys into Supabase.
 *   - `findTrackedProduct` searched for `store_product_id` — so against the MEMORY
 *     store, where rows were camelCase, it never matched an existing product and
 *     re-tracking the same product+option silently created duplicates.
 *   - `listTrackedProducts` therefore returned camelCase in one mode and snake_case
 *     in the other, and `scraper.js` read `product.storeProductId`. In memory mode
 *     that was `undefined`, producing a URL like `/item/undefined`.
 *
 * A bug that only appears against real Supabase is the worst kind to have, because
 * the development path is the one that works. Everything crossing the boundary is
 * now converted explicitly by `toRow` / `rowToProduct`, and the memory store holds
 * the same canonical camelCase shape as the Supabase path, so the two modes cannot
 * drift apart again.
 * ---------------------------------------------------------------------------
 */

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * WHY a memory fallback: the scraper must be verifiable before Supabase exists.
 * A hard dependency on an external service would mean "install the app" and
 * "prove the scraper works" are the same step, and if the DB is down you cannot
 * tell a scraper bug from a DB bug. MEMORY_DB=1 isolates the scraper.
 *
 * It refuses to run when NODE_ENV === "production", and it persists to a JSON
 * file rather than living only in RAM, so the seed script, the scraper and the API
 * can each be a separate process (see Failure 12 below). Supabase remains the
 * only store that counts.
 */
export const usingMemoryDb = process.env.MEMORY_DB === '1' && config.NODE_ENV !== 'production';

if (usingMemoryDb) {
  logger.warn(
    { event: 'memory_db' },
    'MEMORY_DB=1 — using a local JSON file instead of Supabase. It is a development aid only: ' +
      'no concurrency control, no real durability. Never run this in production.'
  );
}

/** @type {{ products: Map<string, any>, history: any[], attempts: any[], runs: any[] }} */
const mem = { products: new Map(), history: [], attempts: [], runs: [] };
let seq = 0;
const nextId = () => `mem-${++seq}`;

// WHY the memory store is persisted to disk (BUILD_LOG Failure 12).
// A purely in-memory store lives inside ONE process. That makes "seed the
// products" and "run the scraper" two different processes, each with an empty
// store, so the obvious workflow
//     node scripts/seed.js --product=2022 && node scripts/scrape.js
// silently scraped nothing and reported "no active tracked products". A dev aid
// that cannot carry data between the tools that need it is not a dev aid.
//
// So in non-production the store is written to a JSON file and reloaded on start.
// It stays refused in production, and Supabase remains the only real store.
// Exported so the CLI tools can tell the user which file the dev store lives in,
// instead of describing it in prose that can drift from the code.
export const MEMORY_DB_PATH =
  usingMemoryDb ? (process.env.MEMORY_DB_FILE ?? new URL('../../.data/memory-db.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) : null;

function loadMemoryStore() {
  if (!MEMORY_DB_PATH) return;
  try {
    const raw = readFileSync(MEMORY_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    mem.products = new Map(Object.entries(parsed.products ?? {}));
    mem.history = parsed.history ?? [];
    mem.attempts = parsed.attempts ?? [];
    mem.runs = parsed.runs ?? [];
    seq = Number(parsed.seq ?? mem.products.size);
    logger.info({ event: 'memory_db_loaded', path: MEMORY_DB_PATH, products: mem.products.size }, 'reloaded in-memory store from disk');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn({ event: 'memory_db_load_failed', err: err.message }, 'could not read the memory store file; starting empty');
    }
  }
}

function saveMemoryStore() {
  if (!MEMORY_DB_PATH) return;
  try {
    mkdirSync(dirname(MEMORY_DB_PATH), { recursive: true });
    writeFileSync(
      MEMORY_DB_PATH,
      JSON.stringify(
        { seq, products: Object.fromEntries(mem.products), history: mem.history, attempts: mem.attempts, runs: mem.runs },
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    logger.warn({ event: 'memory_db_save_failed', err: err.message }, 'could not persist the memory store');
  }
}

loadMemoryStore();

function must(result, context) {
  if (result.error) {
    const err = new Error(`${context}: ${result.error.message}`);
    err.code = 'db_error';
    throw err;
  }
  return result.data;
}

// ---------------------------------------------------------------- mapping

/** Canonical (camelCase) product shape used everywhere inside the app. */
export function rowToProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    storeProductId: row.store_product_id,
    productName: row.product_name,
    brand: row.brand ?? null,
    category: row.category ?? null,
    sku: row.sku ?? null,
    optionAxis: row.option_axis ?? null,
    optionId: row.option_id,
    optionLabel: row.option_label,
    sourceUrl: row.source_url,
    active: row.active,
    createdAt: row.created_at ?? null,
    lastScrapedAt: row.last_scraped_at ?? null,
  };
}

/** Canonical product -> Postgres row. */
function toRow(p) {
  return {
    store_product_id: p.storeProductId,
    product_name: p.productName,
    brand: p.brand ?? null,
    category: p.category ?? null,
    sku: p.sku ?? null,
    option_axis: p.optionAxis ?? null,
    option_id: p.optionId,
    option_label: p.optionLabel,
    source_url: p.sourceUrl,
    active: p.active ?? true,
  };
}

/** Canonical (camelCase) history row. */
export function rowToHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    trackedProductId: row.tracked_product_id,
    price: row.price,
    stock: row.stock,
    currency: row.currency,
    scrapedAt: row.scraped_at,
  };
}

/** Canonical (camelCase) attempt row. Price/stock stay null for failures. */
export function rowToAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    trackedProductId: row.tracked_product_id,
    attemptedAt: row.attempted_at,
    outcome: row.outcome,
    attemptNumber: row.attempt_number,
    price: row.price ?? null,
    stock: row.stock ?? null,
    httpStatus: row.http_status ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    durationMs: row.duration_ms ?? null,
    manifestRevision: row.manifest_revision ?? null,
  };
}

function historyToRow(h) {
  return {
    tracked_product_id: h.trackedProductId,
    price: h.price,
    stock: h.stock,
    currency: h.currency ?? 'INR',
    scraped_at: h.scrapedAt,
  };
}

function attemptToRow(a) {
  return {
    tracked_product_id: a.trackedProductId,
    attempted_at: a.attemptedAt,
    outcome: a.outcome,
    attempt_number: a.attemptNumber,
    // A failed attempt has no price. Storing the last good price here would
    // quietly turn a failure into a fake data point.
    price: a.outcome === 'success' ? a.price ?? null : null,
    stock: a.outcome === 'success' ? a.stock ?? null : null,
    http_status: a.httpStatus ?? null,
    error_code: a.errorCode ?? null,
    error_message: a.errorMessage ?? null,
    duration_ms: a.durationMs ?? null,
    manifest_revision: a.manifestRevision ?? null,
  };
}

// ---------------------------------------------------------------- products

export async function listTrackedProducts({ activeOnly = false } = {}) {
  if (usingMemoryDb) {
    return [...mem.products.values()].filter((p) => (activeOnly ? p.active : true));
  }
  let q = supabase.from('tracked_products').select('*').order('created_at', { ascending: false });
  if (activeOnly) q = q.eq('active', true);
  return (must(await q, 'listTrackedProducts') ?? []).map(rowToProduct);
}

export async function getTrackedProduct(id) {
  if (usingMemoryDb) return mem.products.get(id) ?? null;
  return rowToProduct(must(await supabase.from('tracked_products').select('*').eq('id', id).maybeSingle(), 'getTrackedProduct'));
}

export async function findTrackedProduct(storeProductId, optionId) {
  const wanted = Number(storeProductId);
  if (usingMemoryDb) {
    return (
      [...mem.products.values()].find(
        (p) => Number(p.storeProductId) === wanted && p.optionId === optionId
      ) ?? null
    );
  }
  return rowToProduct(
    must(
      await supabase
        .from('tracked_products')
        .select('*')
        .eq('store_product_id', wanted)
        .eq('option_id', optionId)
        .maybeSingle(),
      'findTrackedProduct'
    )
  );
}

/** Idempotent: tracking the same product+option twice updates rather than duplicating. */
export async function upsertTrackedProduct(input) {
  if (usingMemoryDb) {
    const existing = await findTrackedProduct(input.storeProductId, input.optionId);
    if (existing) {
      Object.assign(existing, input, { active: true });
      saveMemoryStore();
      return existing;
    }
    const row = {
      id: nextId(),
      createdAt: new Date().toISOString(),
      lastScrapedAt: null,
      active: true,
      ...input,
    };
    mem.products.set(row.id, row);
    saveMemoryStore();
    return row;
  }

  return rowToProduct(
    must(
      await supabase
        .from('tracked_products')
        .upsert(toRow(input), { onConflict: 'store_product_id,option_id' })
        .select()
        .single(),
      'upsertTrackedProduct'
    )
  );
}

export async function deleteTrackedProduct(id) {
  if (usingMemoryDb) {
    if (!mem.products.delete(id)) {
      const err = new Error(`deleteTrackedProduct: no such product ${id}`);
      err.code = 'not_found';
      throw err;
    }
    // Mirror the schema's ON DELETE CASCADE. The spec calls for stopping a product
    // to remove its history and attempts, and the foreign keys do that in Supabase.
    // Leaving them behind here produced rows that belonged to a product that no
    // longer existed: invisible in the product list, still present in the CSV export
    // and still counted by the health endpoint.
    const key = String(id);
    mem.history = mem.history.filter((h) => String(h.tracked_product_id) !== key);
    mem.attempts = mem.attempts.filter((a) => String(a.tracked_product_id) !== key);
    saveMemoryStore();
    return true;
  }
  must(await supabase.from('tracked_products').delete().eq('id', id), 'deleteTrackedProduct');
  return true;
}

export async function touchProduct(id) {
  if (usingMemoryDb) {
    const p = mem.products.get(id);
    if (p) p.lastScrapedAt = new Date().toISOString();
    saveMemoryStore();
    return;
  }
  await supabase.from('tracked_products').update({ last_scraped_at: new Date().toISOString() }).eq('id', id);
}

// ---------------------------------------------------------------- attempts & history

/**
 * Persist ONE attempt. Called after every attempt, success or failure — this is
 * the function that makes the history honest, so it must never be skipped or
 * batched to the end of a run.
 */
export async function recordAttempt(attempt) {
  const row = attemptToRow(attempt);
  if (usingMemoryDb) {
    const stored = { id: nextId(), ...row };
    mem.attempts.push(stored);
    saveMemoryStore();
    return rowToAttempt(stored);
  }
  return rowToAttempt(
    must(await supabase.from('scrape_attempts').insert(row).select().single(), 'recordAttempt')
  );
}

/**
 * Record a validated success: BOTH the attempt and the history row, together.
 *
 * WHY ONE FUNCTION (BUILD_LOG Failure 11). These were two separate calls. If the
 * attempt insert succeeded and the history insert then failed, the run reported
 * SUCCESS while the price was never stored — the database silently disagreed with
 * the log, which is the exact class of dishonesty this project exists to avoid.
 *
 * Against Supabase the two inserts are made atomic with the `record_success`
 * function in migration 001, so either both rows exist or neither does. If that
 * function is missing, we do NOT silently fall back to two loose inserts: we
 * report persistence failure so the attempt is not counted as a success.
 */
export async function recordSuccess({ trackedProductId, price, stock, scrapedAt, ...rest }) {
  const payload = { trackedProductId, price, stock, scrapedAt, attempt: rest.attempt ?? null };

  if (usingMemoryDb) {
    // Mirror the RPC exactly: a success is BOTH an attempt row and a history row.
    // Writing only the history row here would make the memory mode disagree with
    // Supabase, and the "every attempt is recorded" invariant (and the CSV export)
    // would quietly hold in one mode and not the other.
    // The tracked product id comes from the function's own argument, never from the
    // caller's attempt object. Trusting the caller to repeat it meant an attempt
    // row could be written with no product id, which is then invisible to
    // getAttempts() and to the CSV export — a silently orphaned audit record.
    const attemptPayload = {
      ...(rest.attempt ?? {}),
      trackedProductId,
      outcome: 'success',
      price,
      stock,
    };
    const a = { id: nextId(), ...attemptToRow(attemptPayload) };
    mem.attempts.push(a);
    const h = { id: nextId(), ...historyToRow(payload) };
    mem.history.push(h);

    // Mirror the RPC's `set last_scraped_at = coalesce(p_scraped_at, now())`.
    // Without this the product row kept a null lastScrapedAt forever in memory
    // mode while Supabase moved it forward on every success, so "when did we last
    // check this?" answered differently depending on which store was configured.
    const product = mem.products.get(trackedProductId);
    if (product) product.lastScrapedAt = scrapedAt ?? new Date().toISOString();

    saveMemoryStore();
    return rowToHistory(h);
  }

  const { data, error } = await supabase.rpc('record_success', {
    p_tracked_product_id: trackedProductId,
    p_price: price,
    p_stock: stock,
    p_scraped_at: scrapedAt,
    p_attempt: { ...(rest.attempt ?? {}), trackedProductId, outcome: 'success', price, stock },
  });

  if (error) {
    const err = new Error(`record_success: ${error.message}`);
    err.code = 'db_error';
    // The caller must treat this as a failure. Falling back to a bare history
    // insert here would re-create the split-write inconsistency on failure.
    throw err;
  }
  return rowToHistory(Array.isArray(data) ? data[0] : data);
}

export async function getHistory(trackedProductId, { limit = 500 } = {}) {
  if (usingMemoryDb) {
    return mem.history
      .filter((h) => h.tracked_product_id === trackedProductId)
      .sort((a, b) => new Date(a.scraped_at) - new Date(b.scraped_at))
      .slice(0, limit)
      .map(rowToHistory);
  }
  return (
    must(
      await supabase
        .from('price_history')
        .select('*')
        .eq('tracked_product_id', trackedProductId)
        .order('scraped_at', { ascending: true })
        .limit(limit),
      'getHistory'
    ) ?? []
  ).map(rowToHistory);
}

export async function getAttempts(trackedProductId, { limit = 200 } = {}) {
  if (usingMemoryDb) {
    return mem.attempts
      .filter((a) => a.tracked_product_id === trackedProductId)
      .sort((a, b) => new Date(b.attempted_at) - new Date(a.attempted_at))
      .slice(0, limit)
      .map(rowToAttempt);
  }
  return (
    must(
      await supabase
        .from('scrape_attempts')
        .select('*')
        .eq('tracked_product_id', trackedProductId)
        .order('attempted_at', { ascending: false })
        .limit(limit),
      'getAttempts'
    ) ?? []
  ).map(rowToAttempt);
}

/** Backing data for the full-history CSV export: every attempt, all products. */
export async function getAllAttemptsWithProduct({ limit = 20000 } = {}) {
  if (usingMemoryDb) {
    return mem.attempts
      .slice()
      .sort((a, b) => new Date(a.attempted_at) - new Date(b.attempted_at))
      .slice(0, limit)
      .map((a) => {
        const p = mem.products.get(a.tracked_product_id);
        return {
          attemptedAt: a.attempted_at,
          outcome: a.outcome,
          price: a.price ?? null,
          stock: a.stock ?? null,
          storeProductId: p?.storeProductId ?? null,
          productName: p?.productName ?? null,
          optionLabel: p?.optionLabel ?? null,
        };
      });
  }

  return (
    must(
      await supabase
        .from('scrape_attempts')
        .select(
          'attempted_at,outcome,price,stock,tracked_products!inner(store_product_id,product_name,option_label)'
        )
        .order('attempted_at', { ascending: true })
        .limit(limit),
      'getAllAttemptsWithProduct'
    ) ?? []
  ).map((r) => ({
    attemptedAt: r.attempted_at,
    outcome: r.outcome,
    price: r.price ?? null,
    stock: r.stock ?? null,
    storeProductId: r.tracked_products?.store_product_id ?? null,
    productName: r.tracked_products?.product_name ?? null,
    optionLabel: r.tracked_products?.option_label ?? null,
  }));
}

/** Latest successful price per product, for the dashboard. Keyed by trackedProductId. */
export async function getLatestPrices() {
  if (usingMemoryDb) {
    const out = new Map();
    for (const h of mem.history) {
      const prev = out.get(h.tracked_product_id);
      if (!prev || new Date(h.scraped_at) > new Date(prev.scraped_at)) out.set(h.tracked_product_id, h);
    }
    return new Map([...out].map(([k, v]) => [k, rowToHistory(v)]));
  }

  const { data, error } = await supabase.rpc('latest_prices');
  if (error) {
    // The comment used to promise a per-product fallback and return an empty map
    // instead, so an RPC problem looked exactly like "no prices recorded". Do the
    // real fallback: latest row per product, via a window function.
    logger.warn(
      { event: 'latest_prices_rpc_failed', msg: error.message },
      'latest_prices RPC failed — falling back to a per-product query'
    );
    const fallback = must(
      await supabase
        .from('price_history')
        .select('*'),
      'getLatestPrices.fallback'
    );
    const latest = new Map();
    for (const row of fallback ?? []) {
      const prev = latest.get(row.tracked_product_id);
      if (!prev || new Date(row.scraped_at) > new Date(prev.scraped_at)) {
        latest.set(row.tracked_product_id, row);
      }
    }
    return new Map([...latest].map(([k, v]) => [k, rowToHistory(v)]));
  }
  return new Map((data ?? []).map((r) => [r.tracked_product_id, rowToHistory(r)]));
}

// ---------------------------------------------------------------- run bookkeeping

/**
 * A scrape run is a unit of work, not a product. Recording it separately is what
 * lets `GET /api/scrape/runs/:id` answer "is the cron working?" without inferring
 * it from product rows — a run that scraped nothing still happened, and that is
 * exactly the run an operator most needs to see.
 */
export async function createScrapeRun(trigger) {
  if (usingMemoryDb) {
    const row = {
      id: `run-${++seq}`,
      started_at: new Date().toISOString(),
      finished_at: null,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      trigger: trigger ?? null,
    };
    mem.runs.push(row);
    saveMemoryStore();
    return row;
  }
  return must(
    await supabase.from('scrape_runs').insert({ trigger: trigger ?? null }).select().single(),
    'createScrapeRun'
  );
}

export async function finishScrapeRun(id, counts) {
  const patch = {
    finished_at: new Date().toISOString(),
    attempted: counts.attempted ?? 0,
    succeeded: counts.succeeded ?? 0,
    failed: counts.failed ?? 0,
  };
  if (usingMemoryDb) {
    const row = mem.runs.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    saveMemoryStore();
    return row ?? null;
  }
  return must(await supabase.from('scrape_runs').update(patch).eq('id', id).select().single(), 'finishScrapeRun');
}

export async function getScrapeRun(id) {
  if (usingMemoryDb) return mem.runs.find((r) => r.id === id) ?? null;
  return must(await supabase.from('scrape_runs').select('*').eq('id', id).maybeSingle(), 'getScrapeRun');
}

export async function getHealthSnapshot() {
  if (usingMemoryDb) {
    return {
      mode: 'memory',
      trackedProducts: mem.products.size,
      attempts: mem.attempts.length,
      successes: mem.history.length,
      lastSuccessAt: mem.history.at(-1)?.scraped_at ?? null,
    };
  }
  // Two separate queries on purpose. The obvious single query — select the newest
  // `scraped_at` with limit 1 and read `.count` off it — reports the number of rows
  // that query returned, so the health endpoint advertised at most 1 success no
  // matter how much history existed. Counting needs `head: true` (no rows) and the
  // latest timestamp needs an actual row; one call cannot do both.
  const [products, attempts, successCount, latest] = await Promise.all([
    supabase.from('tracked_products').select('id', { count: 'exact', head: true }),
    supabase.from('scrape_attempts').select('id', { count: 'exact', head: true }),
    supabase.from('price_history').select('id', { count: 'exact', head: true }),
    supabase
      .from('price_history')
      .select('scraped_at')
      .order('scraped_at', { ascending: false })
      .limit(1),
  ]);

  return {
    mode: 'supabase',
    trackedProducts: products.count ?? 0,
    attempts: attempts.count ?? 0,
    successes: successCount.count ?? 0,
    lastSuccessAt: latest.data?.[0]?.scraped_at ?? null,
  };
}

/** Test seam — wipe the in-memory store (and its file, if it has one). */
export function __resetMemoryDb() {
  mem.products.clear();
  mem.history.length = 0;
  mem.attempts.length = 0;
  mem.runs.length = 0;
  seq = 0;
  if (MEMORY_DB_PATH) {
    try {
      writeFileSync(MEMORY_DB_PATH, JSON.stringify({ seq: 0, products: {}, history: [], attempts: [], runs: [] }), 'utf8');
    } catch {
      /* the file is a convenience; failing to clear it must not fail a test */
    }
  }
}

/** Test seam — read the memory store directly. */
export function __memoryStore() {
  return mem;
}
