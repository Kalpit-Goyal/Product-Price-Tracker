#!/usr/bin/env node
/**
 * Seed tracked products.
 *
 * Usage:
 *   node scripts/seed.js --product=2022                 # all options of one product
 *   node scripts/seed.js --product=2022 --option=o2     # one specific option
 *   node scripts/seed.js --product=2022 --option=Special\ Edition   # by label
 *   node scripts/seed.js --search="capture card" --limit=3
 *   node scripts/seed.js --list-products
 *   node scripts/seed.js --remove=<tracked id>
 *
 * WHY a seed script and not a hand-written SQL insert: the product id in our
 * database is the store's id from /item/{id}, and the option id/label pair has to
 * come from the store's own API. Typing those by hand is how you end up tracking
 * a product that does not exist, or an option the product does not sell — and
 * with the current strict option handling that now fails loudly at scrape time
 * instead of silently recording the wrong price.
 */
import config from '../src/config.js';
import logger from '../src/util/logger.js';
import { getCatalog, searchProducts, getProductDetail } from '../src/services/catalog.js';
import {
  upsertTrackedProduct,
  listTrackedProducts,
  deleteTrackedProduct,
  usingMemoryDb,
  MEMORY_DB_PATH,
} from '../src/util/db.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};

const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

function out(...args) {
  console.log(...args);
}

/** Track one (product, option) pair, validating the option really exists. */
async function track(storeProductId, option) {
  const detail = await getProductDetail(storeProductId);
  if (!detail) {
    out(`  ${DIM}skipped ${storeProductId}: no such product in the store${RESET}`);
    return null;
  }

  const sourceUrl = `${config.scrapeBaseUrl}/item/${storeProductId}`;

  const row = await upsertTrackedProduct({
    storeProductId,
    productName: detail.name ?? `product ${storeProductId}`,
    brand: detail.brand ?? null,
    category: detail.category ?? null,
    sku: detail.sku ?? null,
    optionAxis: detail.optionAxis ?? null,
    optionId: option.id,
    optionLabel: option.label,
    sourceUrl,
  });

  out(
    `  ${GREEN}tracked${RESET} ${String(storeProductId).padEnd(6)} ${(detail.name ?? '').slice(0, 34).padEnd(36)} ` +
      `option ${option.id} "${option.label}"`
  );
  return row;
}

async function listProducts() {
  const products = await listTrackedProducts();
  if (products.length === 0) {
    out(`  ${DIM}nothing tracked yet${RESET}`);
    return;
  }
  out(`  ${BOLD}${products.length} tracked product(s)${RESET}`);
  for (const p of products) {
    out(
      `  ${String(p.storeProductId).padEnd(7)} ${(p.productName ?? '').slice(0, 32).padEnd(34)} ` +
        `${p.optionId.padEnd(5)} ${(p.optionLabel ?? '').padEnd(18)} ` +
        `last scraped: ${p.lastScrapedAt ?? 'never'}`
    );
  }
}

async function main() {
  logger.level = process.env.LOG_LEVEL ?? 'warn';
  if (usingMemoryDb) {
    // The message used to say the data "will be lost when this process exits", which
    // stopped being true once the memory store was persisted to disk (Failure 12).
    // A warning that contradicts the actual behaviour is worse than no warning: it
    // teaches the reader to distrust every message this script prints. It now
    // describes both the real limitation and the real escape hatch.
    out(
      `${BOLD}MEMORY_DB=1${RESET} — using the local JSON store, not Supabase.\n` +
        `Data persists to ${MEMORY_DB_PATH ?? 'a file in backend/.data/'} so the scraper and API\n` +
        `can read it, but there is no concurrency control or real durability. Delete the file\n` +
        `to reset. Use Supabase for anything you want to keep.\n`
    );
  }

  if (flag('list-products') === true) {
    return listProducts();
  }

  const removeId = flag('remove');
  if (removeId) {
    await deleteTrackedProduct(String(removeId));
    out(`  ${GREEN}removed${RESET} ${removeId}`);
    return;
  }

  // ---- search mode: find products, then track the top hits
  const query = flag('search');
  if (query) {
    const limit = Number(flag('limit', 3)) || 3;
    out(`${BOLD}searching for "${query}"${RESET}`);
    const { results: hits, coverage, complete } = await searchProducts(String(query), { limit });
    if (!complete) {
      out(
        `  ${YELLOW}note: the catalog index is only ${(coverage * 100).toFixed(1)}% complete, ` +
          `so some products will be missing from these results${RESET}`
      );
    }
    if (hits.length === 0) {
      out(`  ${DIM}no matches${RESET}`);
      return;
    }
    for (const hit of hits) {
      const detail = await getProductDetail(hit.id);
      const options = detail?.options ?? [];
      if (options.length === 0) {
        out(`  ${DIM}skipped ${hit.id}: no options exposed${RESET}`);
        continue;
      }
      await track(hit.id, options[0]);
    }
    return;
  }

  // ---- explicit product mode
  const productArg = flag('product');
  if (productArg === undefined) {
    out(`Usage:
  node scripts/seed.js --product=<id> [--option=<optionId|label>]
  node scripts/seed.js --search="<name>" [--limit=3]
  node scripts/seed.js --list-products
  node scripts/seed.js --remove=<tracked id>

Catalog: ${(await getCatalog()).length} products available.`);
    return;
  }

  const storeProductId = Number(productArg);
  if (!Number.isInteger(storeProductId) || storeProductId < 1) {
    out(`--product must be a positive integer, got ${JSON.stringify(productArg)}`);
    process.exitCode = 2;
    return;
  }

  const detail = await getProductDetail(storeProductId);
  if (!detail) {
    out(`no product ${storeProductId} in the store`);
    process.exitCode = 1;
    return;
  }

  out(`${BOLD}${detail.name}${RESET}  ${DIM}axis="${detail.optionAxis ?? '-'}"${RESET}`);
  const options = detail.options ?? [];
  if (options.length === 0) {
    out(`  ${DIM}this product exposes no options; tracking it as-is is not supported${RESET}`);
    return;
  }

  const wanted = flag('option');
  let chosen = options;
  if (wanted) {
    const match = options.find(
      (o) => o.id === String(wanted) || o.label.toLowerCase() === String(wanted).toLowerCase()
    );
    if (!match) {
      // Fail loudly rather than tracking something the store does not sell.
      out(
        `  option ${JSON.stringify(wanted)} not found. Available: ` +
          options.map((o) => `${o.id}="${o.label}"`).join(', ')
      );
      process.exitCode = 1;
      return;
    }
    chosen = [match];
  }

  for (const option of chosen) {
    await track(storeProductId, option);
  }
}

await main();
