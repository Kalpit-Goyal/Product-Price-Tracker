#!/usr/bin/env node
/**
 * Self-contained end-to-end check that the dashboard renders live backend data.
 *
 * WHY THIS IS A SEPARATE TOOL FROM smoke.mjs. The API smoke test proves the routes
 * answer. It cannot prove the React app *uses* those answers: a wrong field name, a
 * shape the chart cannot plot, or a crash inside a component all produce a perfectly
 * healthy API and a blank page. Every real frontend bug found while building this was
 * exactly that -- `latestPrice` guessed as `lastPrice`, and a `history` array assumed
 * where the API returns `{ count, history }`. Only a browser catches those.
 *
 * WHY IT OWNS ITS OWN SERVERS. An earlier version assumed servers were already
 * running and was pointed at them by hand. It failed for a whole session against a
 * healthy server, because `vite preview` binds `localhost` -> `::1` (IPv6 only) while
 * the probe hardcoded `127.0.0.1` (IPv4). A probe that only prints on success makes
 * that indistinguishable from a hang. So: no hand-managed servers, no PowerShell
 * process juggling, both address families probed, and every phase announces itself.
 *
 * Usage:  node scripts/verify-ui.mjs
 * Output: human-readable check list, plus ui-shots/dashboard.png
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { rmSync, mkdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const FRONTEND = join(PROJECT, 'frontend');
const DIST = join(FRONTEND, 'dist');
const SHOT_DIR = join(PROJECT, 'ui-shots');

const API_PORT = 3411;
const UI_PORT = 3412;
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;
const DB_FILE = join(tmpdir(), `verify-ui-${process.pid}.json`);

const started = Date.now();
const log = (msg) => console.log(`[${String((Date.now() - started) / 1000).padStart(6)}s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Environment. Assigned (not ||=) so the temp database and the
 * placeholder Supabase values always win -- a leftover MEMORY_DB_FILE
 * in the caller's shell must never be the file this test writes to.
 * ------------------------------------------------------------------ */
Object.assign(process.env, {
  SUPABASE_URL: 'https://placeholder.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'placeholder-key-local-verification-only',
  CRON_SECRET: 'placeholder-cron-secret',
  MEMORY_DB: '1',
  MEMORY_DB_FILE: DB_FILE,
  LOG_LEVEL: 'silent',
  HEADLESS: '1',
  PORT: String(API_PORT),
  ALLOW_DEV_TRIGGER: '1',
});

/* ------------------------------------------------------------------ *
 * Tiny static server for dist/. Avoids `vite preview` entirely: it is a
 * separate process whose output has to be scraped for a ready line, and
 * its default host binding is what caused the original false failure.
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serveStatic(root) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const send = (code, body, type) => res.writeHead(code, { 'content-type': type }).end(body);
      try {
        const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let file = join(root, normalize(path).replace(/^([/\\])+/, ''));
        if (!file.startsWith(root)) return send(403, 'forbidden', 'text/plain');
        try {
          if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
          return send(200, await readFile(file), MIME[extname(file)] ?? 'application/octet-stream');
        } catch {
          // SPA fallback: unknown paths are client routes, not missing files.
          return send(200, await readFile(join(root, 'index.html')), MIME['.html']);
        }
      } catch (err) {
        // Logged, not swallowed: a static server that returns an opaque 500 is the
        // same class of silent failure this script exists to eliminate.
        console.error(`  static server error for ${req.url}: ${err.stack ?? err}`);
        send(500, String(err), 'text/plain');
      }
    });
    server.on('error', reject);
    server.listen(UI_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** Poll until an HTTP endpoint answers. Tries both loopback families and reports why it gave up. */
async function waitForHttp(url, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    for (const host of ['127.0.0.1', '[::1]']) {
      const candidate = url.replace('127.0.0.1', host);
      try {
        const res = await fetch(candidate, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          log(`${label} ready on ${host} (HTTP ${res.status})`);
          return candidate;
        }
        seen.add(`${host} -> HTTP ${res.status}`);
      } catch (err) {
        seen.add(`${host} -> ${err.cause?.code ?? err.name}`);
      }
    }
    await sleep(250);
  }
  throw new Error(`${label} not ready after ${timeoutMs}ms. Last seen: ${[...seen].join('; ')}`);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: process.platform === 'win32' && cmd.endsWith('.cmd') });
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out}`))));
  });
}

/* ------------------------------------------------------------------ *
 * Seed a realistic dataset into the temp store: three products, an
 * irregular 6-point history each (the store re-rolls price per load),
 * and honest failures so the attempt log is not uniformly green.
 * ------------------------------------------------------------------ */
async function seed() {
  const db = await import('../src/util/db.js');
  const now = Date.now();
  const items = [
    { id: 2022, name: 'Junova Capture Card One', brand: 'Junova', sku: 'SK-2022-JU', opt: 'o2', label: 'Special Edition', base: 14668 },
    { id: 2662, name: 'Brightwell Capture Card Duo', brand: 'Brightwell', sku: 'SK-2662-BR', opt: 'o1', label: 'Standard', base: 9724 },
    { id: 2822, name: 'Redwick Capture Card Zen', brand: 'Redwick', sku: 'SK-2822-RE', opt: 'o3', label: 'Pro Bundle', base: 21450 },
  ];
  for (const it of items) {
    const p = await db.upsertTrackedProduct({
      storeProductId: it.id, productName: it.name, brand: it.brand, category: 'Gaming',
      sku: it.sku, optionAxis: 'Edition', optionId: it.opt, optionLabel: it.label,
      sourceUrl: `https://demo.inelabteamdev.com/item/${it.id}`,
    });
    for (let i = 6; i >= 1; i--) {
      await db.recordSuccess({
        trackedProductId: p.id,
        price: it.base + ((i * 137) % 400) - 200,
        stock: (i % 4) + 2,
        scrapedAt: new Date(now - i * 2 * 3600_000).toISOString(),
        attempt: { attemptNumber: 1, durationMs: 3800 + i * 40, manifestRevision: 633001, httpStatus: 200 },
      });
    }
    await db.recordAttempt({
      trackedProductId: p.id, attemptedAt: new Date(now - 3 * 3600_000).toISOString(),
      outcome: 'failed', attemptNumber: 2, errorCode: 'panel_never_settled',
      errorMessage: 'interaction gate never opened', durationMs: 15200,
    });
    await db.recordAttempt({
      trackedProductId: p.id, attemptedAt: new Date(now - 5 * 3600_000).toISOString(),
      outcome: 'retried', attemptNumber: 1, errorCode: 'http_503',
      errorMessage: 'upstream 503', durationMs: 2100,
    });
  }
  const health = await db.getHealthSnapshot();
  log(`seeded ${items.length} products / ${health.successes} successes / ${health.attempts} attempts into ${DB_FILE}`);
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */
const failures = [];
const notes = [];
function check(name, ok, detail = '') {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function assertDashboard(page) {
  // ---- shell ---------------------------------------------------------------
  check('page title is set', (await page.title()).includes('INE'), await page.title());
  check('header renders', (await page.locator('h1').first().innerText()).includes('INE Store Price Tracker'));

  // ---- health strip --------------------------------------------------------
  // A healthy API plus a blank dashboard looks identical to a working app, so the
  // counts are asserted: if these never render, the app is not using the response.
  await page.waitForSelector('.status-strip b', { timeout: 20000 });
  const strip = (await page.locator('.status-strip').innerText()).replace(/\n/g, ' ');
  check('health strip shows a status', /status\s*\S+/i.test(strip), strip);
  check('health strip shows a tracked count', /tracked\s*\d+/i.test(strip), strip);

  // ---- tracked list --------------------------------------------------------
  const rows = page.locator('.tracked-item');
  const count = await rows.count();
  check('tracked products are listed', count > 0, `${count} listed`);
  if (count > 0) {
    const first = (await rows.first().innerText()).replace(/\n/g, ' | ');
    // Guards the field-name bug: a row showing the wrong attribute renders `undefined`.
    check('a row shows a price or an explicit em-dash, never "undefined"', /₹|—/.test(first) && !/undefined/.test(first), first);
    check('a row shows the tracked option', first.split('|').length >= 3, first);
  }

  // ---- detail pane ---------------------------------------------------------
  await page.locator('.tracked-item').first().click();
  await page.waitForSelector('.kv', { timeout: 20000 });
  const kv = await page.locator('.kv').innerText();
  check('detail pane shows the tracked option', /Option tracked/i.test(kv));
  check('detail pane shows successful reads', /Successful reads/i.test(kv));
  check('detail pane has no "undefined" leakage', !/undefined/.test(await page.locator('.detail, .panel').first().innerText()));

  // ---- chart ---------------------------------------------------------------
  // Either plotted points or the explicit empty state. A blank panel -- what a shape
  // mismatch in the history payload produces -- is the failure being guarded.
  const dots = await page.locator('svg circle').count();
  const empty = await page.locator('.empty').count();
  check('history renders points or an explicit empty state', dots > 0 || empty > 0, `points=${dots} empty=${empty}`);
  if (dots > 0) {
    const box = await page.locator('svg').first().boundingBox();
    check('chart has real dimensions', box.width > 200 && box.height > 100, `${Math.round(box.width)}x${Math.round(box.height)}`);
    const legend = await page.locator('.chart-legend').innerText();
    check('chart states how many observations it plotted', /observation/i.test(legend), legend.replace(/\n/g, ' | '));
    notes.push(`${dots} chart points plotted`);
  }

  // ---- tables --------------------------------------------------------------
  const headers = (await page.locator('th').allInnerTexts()).join(' | ');
  check('observations table has price and stock columns', /price/i.test(headers) && /stock/i.test(headers), headers);
  check('scrape log has an outcome column', /outcome/i.test(headers), headers);
  const logRows = await page.locator('tbody tr').count();
  check('scrape log rendered rows', logRows > 0, `${logRows} rows`);

  // ---- search against the live store --------------------------------------
  await page.fill('input[type="search"]', 'capture card');
  await page.waitForSelector('.result', { timeout: 45000 });
  const results = await page.locator('.result').count();
  check('search returns live results', results > 0, `${results} results`);
  notes.push(`live search "capture card" -> ${results} results`);

  // Honest coverage reporting: a short index must be disclosed, not hidden.
  const warns = await page.locator('.notice.warn').count();
  notes.push(`coverage notices shown: ${warns}`);
  if (warns === 0) notes.push('NOTE: no coverage notice -- if the index is incomplete this is a disclosure bug');

  // ---- option picker -------------------------------------------------------
  await page.locator('.result button', { hasText: 'Track' }).first().click();
  await page.waitForSelector('select[aria-label="Option"]', { timeout: 45000 });
  const optionCount = await page.locator('select[aria-label="Option"] option').count();
  check('option picker lists the product\'s real options', optionCount > 0, `${optionCount} options`);

  await page.screenshot({ path: join(SHOT_DIR, 'dashboard.png'), fullPage: true });
  notes.push(`screenshot: ${join(SHOT_DIR, 'dashboard.png')}`);
}

/* ------------------------------------------------------------------ */
let api = null;
let staticServer = null;
let browser = null;
const children = [];

try {
  log('seeding temp database');
  await seed();

  log('building frontend against ' + API);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await run(npm, ['run', 'build'], { cwd: FRONTEND, env: { ...process.env, VITE_API_BASE_URL: API } });
  log('frontend built');

  log('starting backend on ' + API_PORT);
  const backend = spawn(process.execPath, ['src/server.js'], {
    cwd: BACKEND,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(backend);
  backend.stderr.on('data', (d) => process.env.LOG_LEVEL !== 'silent' && process.stderr.write(d));
  await waitForHttp(`${API}/api/health`, 'backend', 45000);

  log(`serving dist on ${UI}`);
  staticServer = await serveStatic(DIST);
  await waitForHttp(UI, 'static server', 15000);

  log('launching chromium');
  // The first search against a cold index costs ~60s of live store traffic by design
  // (it is a real saturation sweep, not a stub). Waiting for the warm-up here keeps
  // this test deterministic instead of racing it -- and the fact that it has to wait
  // is exactly why the dashboard has to say so to a human.
  log('waiting for the catalog index to warm (this is the real cold-start cost)');
  const warmStart = Date.now();
  for (;;) {
    const h = await (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
    if (h.catalogWarm) {
      log(`catalog warm after ${((Date.now() - warmStart) / 1000).toFixed(1)}s; searches will now be instant`);
      break;
    }
    if (Date.now() - warmStart > 180000) {
      check('catalog index warmed within 180s', false, 'still cold');
      break;
    }
    await sleep(2000);
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

  // Browser-level defects are invisible to DOM assertions when a request 404s into
  // a silently-empty list, so the network and console logs are asserted too.
  const consoleErrors = [];
  const badResponses = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('response', (r) => r.status() >= 400 && badResponses.push(`${r.status()} ${r.url()}`));
  page.on('requestfailed', (r) => badResponses.push(`FAILED ${r.method()} ${r.url()}`));

  await page.goto(UI, { waitUntil: 'networkidle', timeout: 45000 });
  await assertDashboard(page);

  const unexpected = badResponses.filter((r) => !/favicon/i.test(r));
  check('no failed or 4xx/5xx requests during the run', unexpected.length === 0, unexpected.slice(0, 3).join(' | ') || 'clean');
  const realErrors = consoleErrors.filter((e) => !/favicon|DevTools|Download the React/i.test(e));
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | ') || 'clean');
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.error(`\nFAIL threw -- ${err.message}\n`);
} finally {
  // Teardown must be unconditional: an orphaned backend holding a port is exactly
  // what made the previous attempt unrunnable on a retry.
  if (browser) await browser.close().catch(() => {});
  if (staticServer) await new Promise((r) => staticServer.close(r));
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  await sleep(300);
  rmSync(DB_FILE, { force: true });
  log('teardown complete (backend, static server, temp db)');
}

mkdirSync(SHOT_DIR, { recursive: true });
for (const n of notes) console.log(`  note: ${n}`);
console.log(failures.length === 0 ? '\nALL UI CHECKS PASSED' : `\n${failures.length} UI CHECK(S) FAILED: ${failures.join('; ')}`);
process.exit(failures.length === 0 ? 0 : 1);
