// The DB module validates its environment at import time, so the placeholders must
// be set before it is loaded. MEMORY_DB=1 selects the in-memory store, which is
// the whole point: these tests exercise the mapping and idempotency logic with no
// network and no Supabase project.
process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-key-for-local-tests';
process.env.CRON_SECRET = 'placeholder-cron-secret';
process.env.MEMORY_DB = '1';
process.env.LOG_LEVEL = 'silent';
// The memory store persists to disk so the seed/scrape/API tools can share it.
// Tests must NOT use the real dev file, or running the suite would wipe whatever
// you had seeded.
process.env.MEMORY_DB_FILE = join(tmpdir(), `ine-test-db-${process.pid}.json`);

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const {
  upsertTrackedProduct,
  findTrackedProduct,
  listTrackedProducts,
  recordAttempt,
  recordSuccess,
  getHistory,
  getAttempts,
  deleteTrackedProduct,
  getHealthSnapshot,
  rowToProduct,
  __resetMemoryDb,
  __memoryStore,
  usingMemoryDb,
} = await import('../src/util/db.js');

const sample = {
  storeProductId: 2022,
  productName: 'Junova Capture Card One',
  brand: 'Junova',
  category: 'Accessories',
  sku: 'JCO-1',
  optionAxis: 'Edition',
  optionId: 'o2',
  optionLabel: 'Special Edition',
  sourceUrl: 'https://demo.inelabteamdev.com/item/2022',
};

test.beforeEach(() => __resetMemoryDb());

test.after(() => {
  try {
    rmSync(process.env.MEMORY_DB_FILE, { force: true });
  } catch {
    /* best effort */
  }
});

test('the memory store is what the tests think it is', () => {
  assert.equal(usingMemoryDb, true, 'MEMORY_DB=1 should select the memory store');
});

test('seeded products survive into another process', async () => {
  // The whole reason the memory store is persisted (Failure 12): seeding and
  // scraping are separate processes, so a purely in-memory store made the
  // seed -> scrape workflow silently do nothing.
  await upsertTrackedProduct(sample);
  const reloaded = await import(`../src/util/db.js?fresh=${Date.now()}`);
  const products = await reloaded.listTrackedProducts();
  assert.equal(products.length, 1, 'a freshly loaded module must see the seeded product');
  assert.equal(products[0].storeProductId, 2022);
  assert.equal(products[0].optionLabel, 'Special Edition');
});

test('tracking the same product+option twice updates instead of duplicating', async () => {
  // REGRESSION (BUILD_LOG Failure 10). findTrackedProduct() used to search for
  // `store_product_id` while upsertTrackedProduct() wrote camelCase keys into the
  // memory store, so it never matched and every re-track created a duplicate.
  // Against real Supabase the same call would have worked, so the bug would only
  // ever have appeared in the mode used for local testing.
  const first = await upsertTrackedProduct(sample);
  const second = await upsertTrackedProduct({ ...sample, optionLabel: 'Special Edition (renamed)' });

  assert.equal(first.id, second.id, 're-tracking must reuse the same row');
  const all = await listTrackedProducts();
  assert.equal(all.length, 1);
  assert.equal(all[0].optionLabel, 'Special Edition (renamed)');
});

test('products come back in the canonical camelCase shape', async () => {
  await upsertTrackedProduct(sample);
  const [product] = await listTrackedProducts();

  // These are the exact fields the scraper reads. If a mapping is missing, the URL
  // becomes "/item/undefined" and the scrape fails for a reason that looks like a
  // store problem.
  assert.equal(product.storeProductId, 2022);
  assert.equal(product.optionAxis, 'Edition');
  assert.equal(product.optionLabel, 'Special Edition');
  assert.equal(product.optionId, 'o2');
  assert.equal(product.active, true);
  assert.equal(typeof product.id, 'string');
});

test('findTrackedProduct matches on number and string ids alike', async () => {
  await upsertTrackedProduct(sample);
  assert.ok(await findTrackedProduct(2022, 'o2'));
  assert.ok(await findTrackedProduct('2022', 'o2'), 'a string id from a query param must still match');
  assert.equal(await findTrackedProduct(2022, 'o9'), null, 'a different option is a different product');
  assert.equal(await findTrackedProduct(9999, 'o2'), null);
});

test('rowToProduct maps a Postgres row and tolerates null', () => {
  const mapped = rowToProduct({
    id: 'abc',
    store_product_id: 42,
    product_name: 'Thing',
    brand: null,
    category: null,
    sku: null,
    option_axis: 'Size',
    option_id: 'o1',
    option_label: 'Small',
    source_url: 'https://example.test/item/42',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    last_scraped_at: null,
  });

  assert.equal(mapped.storeProductId, 42);
  assert.equal(mapped.optionLabel, 'Small');
  assert.equal(mapped.brand, null);
  assert.equal(mapped.lastScrapedAt, null);
  assert.equal(rowToProduct(null), null);
});

test('a failed attempt is stored with NULL price and stock', async () => {
  // The single most important invariant in the project: a failure must never carry
  // a value, or the history silently fills with invented data points.
  await upsertTrackedProduct(sample);
  const [product] = await listTrackedProducts();

  await recordAttempt({
    trackedProductId: product.id,
    attemptedAt: new Date().toISOString(),
    outcome: 'retried',
    attemptNumber: 1,
    price: 12345,        // deliberately supplied and must be ignored
    stock: 7,            // likewise
    errorCode: 'panel_never_settled',
    errorMessage: 'never settled',
    durationMs: 12000,
  });

  const [attempt] = await getAttempts(product.id);
  assert.equal(attempt.outcome, 'retried');
  assert.equal(attempt.price, null, 'a non-success attempt must not store a price');
  assert.equal(attempt.stock, null, 'a non-success attempt must not store stock');
  assert.equal(attempt.errorCode, 'panel_never_settled');

  assert.equal((await getHistory(product.id)).length, 0, 'a failure must not create history');
});

test('a validated success writes exactly one history row AND one attempt row', async () => {
  await upsertTrackedProduct(sample);
  const [product] = await listTrackedProducts();

  await recordSuccess({
    trackedProductId: product.id,
    price: 14668,
    stock: 12,
    scrapedAt: new Date().toISOString(),
    attempt: { attemptNumber: 2, durationMs: 4300, manifestRevision: 633001 },
  });

  const history = await getHistory(product.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].price, 14668);
  assert.equal(history[0].stock, 12);
  assert.equal(history[0].currency, 'INR');
  assert.equal(history[0].trackedProductId, product.id);

  // A success is also an attempt. The memory store once wrote only the history row,
  // so "every attempt is recorded" held against Supabase (the RPC does both) and
  // not in memory mode — the same class of mode-dependent bug as Failure 10.
  const attempts = await getAttempts(product.id);
  assert.equal(attempts.length, 1, 'a success must also appear in the attempt log');
  assert.equal(attempts[0].outcome, 'success');
  assert.equal(attempts[0].price, 14668);
  assert.equal(attempts[0].attemptNumber, 2);
  assert.equal(attempts[0].durationMs, 4300);
  assert.equal(attempts[0].manifestRevision, 633001);
});

test('a failed attempt is never accompanied by a history row', async () => {
  await upsertTrackedProduct(sample);
  const [product] = await listTrackedProducts();

  await recordAttempt({
    trackedProductId: product.id,
    attemptedAt: new Date().toISOString(),
    outcome: 'failed',
    attemptNumber: 6,
    errorCode: 'exhausted_attempts',
  });

  assert.equal((await getAttempts(product.id)).length, 1);
  assert.equal((await getHistory(product.id)).length, 0, 'failures must never create history');
});

test('a success moves the product last_scraped_at forward', async () => {
  // The RPC does `set last_scraped_at = coalesce(p_scraped_at, now())`. Memory mode
  // did not, so "when did we last check this?" answered differently depending on
  // which store was configured — and the dashboard shows exactly that field.
  await upsertTrackedProduct(sample);
  const [before] = await listTrackedProducts();
  assert.equal(before.lastScrapedAt, null, 'precondition: never scraped');

  const scrapedAt = '2026-02-03T04:05:06.000Z';
  await recordSuccess({
    trackedProductId: before.id,
    price: 14668,
    stock: 12,
    scrapedAt,
    attempt: { attemptNumber: 1 },
  });

  const [after] = await listTrackedProducts();
  assert.equal(after.lastScrapedAt, scrapedAt);
});

test('deleting a product cascades to its history and attempts', async () => {
  // The schema uses ON DELETE CASCADE and the spec calls for it. Memory mode used to
  // drop only the product row, leaving orphan history and attempt rows behind:
  // invisible in the product list, still exported to CSV and still counted by the
  // health endpoint.
  await upsertTrackedProduct(sample);
  const [product] = await listTrackedProducts();

  await recordSuccess({
    trackedProductId: product.id,
    price: 14668,
    stock: 12,
    scrapedAt: new Date().toISOString(),
    attempt: { attemptNumber: 1 },
  });
  await recordAttempt({
    trackedProductId: product.id,
    attemptedAt: new Date().toISOString(),
    outcome: 'failed',
    attemptNumber: 2,
    errorCode: 'exhausted_attempts',
  });

  assert.equal((await getHistory(product.id)).length, 1);
  assert.equal((await getAttempts(product.id)).length, 2);

  await deleteTrackedProduct(product.id);

  assert.equal((await listTrackedProducts()).length, 0, 'the product is gone');
  assert.equal((await getHistory(product.id)).length, 0, 'history must cascade');
  assert.equal((await getAttempts(product.id)).length, 0, 'attempts must cascade');

  // And nothing may be left behind for the CSV export to pick up.
  const leftovers = [...__memoryStore().history, ...__memoryStore().attempts].filter(
    (r) => String(r.tracked_product_id ?? r.trackedProductId) === String(product.id)
  );
  assert.equal(leftovers.length, 0, 'no orphan rows may survive the delete');
});

test('the health snapshot counts every success, not just the newest', async () => {
  // The Supabase implementation once read `.count` off a `limit: 1` query, so it
  // reported at most 1 success no matter how much history existed. Memory mode is
  // exercised here as the reference for what the count is supposed to mean.
  await upsertTrackedProduct(sample);
  const [product] = await listTrackedProducts();

  for (let i = 0; i < 3; i++) {
    await recordSuccess({
      trackedProductId: product.id,
      price: 1000 + i,
      stock: 5,
      scrapedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      attempt: { attemptNumber: i + 1 },
    });
  }

  const snapshot = await getHealthSnapshot();
  assert.equal(snapshot.successes, 3, 'all three successes must be counted');
  assert.equal(snapshot.trackedProducts, 1);
  assert.equal(snapshot.attempts, 3, 'each success is also an attempt');
  assert.ok(snapshot.lastSuccessAt, 'lastSuccessAt must be populated');
});

test('deleting a product refuses to pretend it succeeded', async () => {
  await assert.rejects(
    () => import('../src/util/db.js').then((m) => m.deleteTrackedProduct('nope')),
    /no such product/
  );
});

test('the memory store keeps canonical keys, not Postgres keys', async () => {
  // Guards the original defect directly: if anything writes snake_case into the
  // memory store again, the two modes will drift and the bug returns.
  await upsertTrackedProduct(sample);
  const raw = [...__memoryStore().products.values()][0];
  assert.ok('storeProductId' in raw, 'memory rows must use storeProductId');
  assert.ok(!('store_product_id' in raw), 'memory rows must not use store_product_id');
});
