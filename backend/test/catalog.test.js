// These tests run entirely offline. The store is replaced with a fake `fetch` so
// the enumeration, retry and coverage logic can be tested deterministically —
// including the failure modes that only showed up against the live store and were
// therefore never caught by tests before.
//
// WHY A FAKE STORE AND NOT A NETWORK CALL. The behaviour under test (throttling,
// shuffled pages, duplicate ids) is a *bug-compatible* property of the real store.
// Mocking it is the only way to assert the code tolerates it, and it makes these
// tests fast enough to run on every change.
process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-key-for-local-tests';
process.env.CRON_SECRET = 'placeholder-cron-secret';
process.env.MEMORY_DB = '1';
process.env.LOG_LEVEL = 'silent';

import test from 'node:test';
import assert from 'node:assert/strict';

// WHY `await import()` AND NOT A STATIC IMPORT. config.js validates the environment
// when it is first evaluated, and ES module `import` declarations are hoisted above
// every statement in this file — so a static import of catalog.js would run that
// validation before the placeholder environment above was assigned, and the whole
// file would die with "Invalid environment configuration". A dynamic import is not
// hoisted, so it runs after the assignments. This mirrors test/db.test.js.
const { getCatalogDetailed, getCatalog, searchProducts, __resetCatalogCache, isCatalogWarm, warmCatalog } =
  await import('../src/services/catalog.js');

const realFetch = globalThis.fetch;

/** A listing in the exact shape the store returns and the schema demands. */
function listing(id, name = `Item ${id}`) {
  return { id, slug: `item-${id}`, name, brand: 'Acme', category: 'Accessories', sku: `SKU-${id}` };
}

/** Build a store response body in the shape the catalog schema expects. */
function body(ids, { count = ids.length, perPage = ids.length, totalPages = 1 } = {}) {
  return JSON.stringify({
    page: 1,
    results: ids.map((id) => listing(id)),
    count,
    perPage,
    totalPages,
  });
}

/**
 * Install a fake store.
 *
 * @param {object} opts
 * @param {(page:number)=>number[]} opts.pages       ids returned for each page (1-based)
 * @param {number} opts.totalPages                   how many pages the store advertises
 * @param {Set<number>} [opts.throttle]              pages that answer 429 on the first try
 * @param {number} [opts.count]                      advertised total product count
 */
function fakeStore({ pages, throttle = new Set(), count, totalPages = 3 }) {
  const hits = [];
  const attempts = new Map();

  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const n = (attempts.get(page) ?? 0) + 1;
    attempts.set(page, n);
    hits.push(page);

    if (throttle.has(page) && n === 1) {
      // Matches the real store: the delay is in the body, not in a header.
      return {
        status: 429,
        ok: false,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ error: 'rate_limited', scope: 'general', retryAfter: 0 }),
      };
    }

    const ids = pages(page) ?? [];
    return {
      status: 200,
      ok: true,
      headers: new Map(),
      text: async () => body(ids, { count, perPage: 60, totalPages }),
    };
  };

  return { hits, attempts };
}

function useStore(opts) {
  __resetCatalogCache();
  return fakeStore(opts);
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  __resetCatalogCache();
});

test('reads every page and reports full coverage when pages are distinct', async () => {
  const { hits } = useStore({
    totalPages: 3,
    count: 9,
    pages: (p) => [p * 3 - 2, p * 3 - 1, p * 3],
  });

  const result = await getCatalogDetailed();

  assert.equal(result.items.length, 9);
  assert.equal(result.complete, true);
  assert.equal(result.coverage, 1);
  // One pass means every page was requested, and the page-1 probe is reused rather
  // than fetched twice.
  assert.deepEqual([...new Set(hits)].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(hits.filter((p) => p === 1).length, 1, 'page 1 must not be fetched twice');
});

test('keeps sweeping until a shuffled store converges', async () => {
  // Mirrors the live store: `/listings` samples randomly, so pages overlap heavily
  // and a single sweep covers well under the advertised count. This is the case
  // that shipped broken — one sweep returned 611 of 960 and search silently missed
  // products that certainly existed.
  //
  // The RNG is seeded so the test is reproducible. A random sampler is essential
  // here: an earlier version of this test used a stride that happened to visit every
  // id in one pass, which made the test pass for the wrong reason.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  useStore({
    count: 960,
    totalPages: 16,
    pages: () => {
      // 60 ids drawn at random from 960, i.e. 960 samples per sweep.
      const seen = new Set();
      while (seen.size < 60) seen.add(1 + Math.floor(rand() * 960));
      return [...seen];
    },
  });

  const result = await getCatalogDetailed();

  assert.ok(
    result.sweeps > 1,
    'a randomly sampled store must not be considered covered by one sweep'
  );
  assert.ok(
    result.coverage > 0.95,
    `expected a converged index, got ${result.coverage}`
  );
});

test('reports incomplete coverage instead of implying certainty', async () => {
  // A store that only ever yields the same 5 products no matter how many pages are
  // requested. Convergence cannot be reached, so the result must say so rather than
  // return a short list that reads as "that is everything".
  useStore({
    count: 960,
    totalPages: 16,
    pages: () => [1, 2, 3, 4, 5],
  });

  const result = await getCatalogDetailed();

  assert.equal(result.items.length, 5);
  assert.equal(result.complete, false);
  assert.ok(result.coverage < 0.01, 'coverage must reflect the real shortfall');
});

test('absorbs a transient 429 inside a single sweep', async () => {
  // Regression guard: throttling once cost 17 of 48 pages in the live sweep.
  //
  // WHY THIS ASSERTS THE SWEEP COUNT AND NOT JUST THE ITEM COUNT. Re-sweeping would
  // eventually re-fetch a throttled page and top the index up anyway, so an
  // item-count-only assertion passes even if the in-page retry is deleted — the
  // resweep quietly does its job and the test looks green. Asserting that the
  // throttled page is absorbed without spending an extra sweep is what actually
  // pins down the retry: it is the difference between recovering a 429 for free and
  // paying for another 16 requests to get the same data.
  const { attempts } = useStore({
    count: 9,
    totalPages: 3,
    pages: (p) => [p * 3 - 2, p * 3 - 1, p * 3],
    throttle: new Set([2, 3]),
  });

  const result = await getCatalogDetailed();

  assert.equal(result.items.length, 9, 'all nine products should be indexed');
  assert.equal(result.sweeps, 1, 'a transient 429 must not cost an extra sweep');
  assert.equal(attempts.get(2), 2, 'page 2 should be retried in place');
  assert.equal(attempts.get(3), 2, 'page 3 should be retried in place');
});

test('survives a page that fails every attempt', async () => {
  // One permanently broken page must not lose the whole catalog — and the gap has
  // to show up as reduced coverage, not vanish.
  globalThis.fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 2) {
      return {
        status: 500,
        ok: false,
        headers: new Map(),
        text: async () => 'upstream exploded',
      };
    }
    return {
      status: 200,
      ok: true,
      headers: new Map(),
      text: async () => body([page], { count: 3, perPage: 1, totalPages: 3 }),
    };
  };
  __resetCatalogCache();

  const result = await getCatalogDetailed();

  assert.equal(result.items.length, 2, 'the readable pages are still indexed');
  assert.equal(result.complete, false, 'a lost page must be visible in coverage');
});

test('concurrent callers share one enumeration', async () => {
  // The cache is only worth having if it is not rebuilt per request; two searches
  // arriving together should not each walk the store.
  const { hits } = useStore({
    count: 4,
    pages: (p) => [p, p + 10],
  });

  await Promise.all([getCatalogDetailed(), getCatalogDetailed()]);
  await getCatalog();

  const firstPageFetches = hits.filter((p) => p === 1).length;
  assert.ok(firstPageFetches <= 2, `expected in-flight dedupe, page 1 fetched ${firstPageFetches}x`);
});

test('search ranks exact and prefix matches ahead of substring matches', async () => {
  useStore({
    count: 3,
    pages: () => [1, 2, 3],
  });
  // Names come from `Item <id>`; search for a substring that only some contain.
  const items = await getCatalog();
  assert.equal(items.length, 3);
  assert.ok(items);

  __resetCatalogCache();
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    headers: new Map(),
    text: async () =>
      JSON.stringify({
        page: 1,
        perPage: 3,
        totalPages: 1,
        count: 3,
        results: [
          listing(1, 'Capture Card Pro'),
          listing(2, 'Pro Capture Card'),
          listing(3, 'Unrelated Thing'),
        ],
      }),
  });

  const found = await searchProducts('capture', { limit: 10 });

  assert.deepEqual(
    found.results.map((r) => r.id),
    [1, 2],
    'substring matches are returned, the non-match is not'
  );
  assert.equal(found.results[0].id, 1, 'prefix match outranks the later substring match');
  assert.equal(found.complete, true);
  assert.equal(found.indexed, 3);
});

test('search returns the coverage of the index it searched', async () => {
  // A caller must be able to tell "no such product" from "we only indexed part of
  // the store" — those are very different answers to give a user.
  useStore({
    count: 960,
    pages: () => [1, 2],
  });

  const found = await searchProducts('nothing matches this', { limit: 5 });

  assert.deepEqual(found.results, []);
  assert.equal(found.complete, false, 'an incomplete index must be advertised as such');
  assert.equal(found.indexed, 2);
});

test('a cold index is reported as cold, and warmCatalog fills it in the background', async () => {
  // WHY THIS TEST EXISTS. Measured live: the first search against a cold process took
  // 76.1s and the second took 0.0s. No proxy waits out 76s, so shipping without a
  // warm-up meant search simply failed on every cold start. These assertions pin the
  // two halves of the fix: the health signal is honest while cold, and the background
  // fill actually populates the cache without the caller awaiting it.
  const { hits } = useStore({
    totalPages: 3,
    count: 9,
    pages: (p) => [p * 3 - 2, p * 3 - 1, p * 3],
  });

  assert.equal(isCatalogWarm(), false, 'a freshly reset cache must report cold');

  // Fire-and-forget: returns immediately, so this cannot await the build.
  warmCatalog({ reason: 'test' });
  assert.equal(isCatalogWarm(), false, 'warmCatalog must not block, so the cache is still cold on the next line');

  // Wait for the background build to land. Polling rather than awaiting because
  // warmCatalog deliberately exposes no promise.
  for (let i = 0; i < 100 && !isCatalogWarm(); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(isCatalogWarm(), true, 'the background warm-up should have filled the cache');
  assert.ok(hits.length > 0, 'the warm-up must actually hit the store, not just flip a flag');

  // And once warm, a second call is a no-op rather than a second full sweep.
  const hitsBefore = hits.length;
  warmCatalog({ reason: 'test-again' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hits.length, hitsBefore, 'a warm cache must not trigger another sweep');
});

test('warmCatalog swallows store failures instead of crashing the process', async () => {
  // The warm-up runs from server boot and from the health probe. If it rejected
  // unhandled it would take the API down, which is a far worse outcome than a cold
  // search.
  __resetCatalogCache();
  globalThis.fetch = async () => {
    throw new Error('store unreachable');
  };

  assert.doesNotThrow(() => warmCatalog({ reason: 'test-failure' }));

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isCatalogWarm()) break;
  }
  assert.equal(isCatalogWarm(), false, 'a failed warm-up must leave the cache cold, not half-filled');
});
