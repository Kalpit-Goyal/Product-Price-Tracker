/**
 * Loads the DEPLOYED dashboard in a real browser and checks it is genuinely wired to
 * the deployed API.
 *
 * WHY THIS EXISTS AS A SEPARATE GATE. The failure that motivated it does not announce
 * itself: a missing build-time env var compiles perfectly, the build exits 0, the
 * deployment goes green, and the resulting page is dead. VITE_API_BASE_URL absent from
 * the bundle means API_BASE is '' and the dashboard silently fetches /api/... against
 * its own origin, where nothing is listening. Every other check passed while that was
 * true, because a broken bundle is still a valid bundle.
 *
 * So this asserts on rendered content and observed network traffic, never on build
 * success. It is also the only check that can see a misconfigured CORS allowlist, since
 * that failure is browser-enforced and leaves the server looking perfectly healthy.
 *
 * NOTE ON ENCODING. This file is deliberately ASCII-only. The rupee sign is written as
 * a \u escape rather than a literal: round-tripping the file through a shell that does
 * not read UTF-8 double-encodes non-ASCII characters silently, which corrupted this
 * exact regex once already and produced a check that passed for the wrong reason.
 *
 * Usage: node scripts/verify-deployed.mjs [url]
 * Exits non-zero on any problem, so it works as a gate.
 */
import { chromium } from 'playwright';

const RUPEE = '\u20B9';
const TARGET = process.argv[2] || 'https://frontend-mauve-three-58.vercel.app';
const EXPECTED_API_HOST = 'ine-price-tracker-api-jmf0.onrender.com';
const EXPECTED_ROWS = 11;

const problems = [];
const log = (pass, label, extra = '') =>
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${extra ? ` ${extra}` : ''}`);
const fail = (why) => problems.push(why);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const consoleErrors = [];
const badResponses = [];
const apiCalls = [];

page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('request', (r) => r.url().includes('/api/') && apiCalls.push(r.url()));
page.on('requestfailed', (r) => {
  if (!r.url().includes('favicon')) badResponses.push(`failed: ${r.url()} (${r.failure()?.errorText})`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) badResponses.push(`${r.status()} ${r.url()}`);
});

console.log(`=== loading ${TARGET} ===`);
await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 90_000 });
console.log(`  title: ${await page.title()}`);

console.log('\n=== API traffic ===');
const paths = [...new Set(apiCalls.map((u) => new URL(u).pathname))];
paths.forEach((p) => console.log(`  ${p}`));

const madeCalls = paths.length > 0;
log(madeCalls, 'the page called the API at all');
if (!madeCalls) fail('no /api/ requests - the bundle has no API base URL');

const rightHost = apiCalls.some((u) => u.includes(EXPECTED_API_HOST));
log(rightHost, `requests went to ${EXPECTED_API_HOST}`);
if (!rightHost) fail('the page is not talking to the expected API host');

console.log('\n=== rendered content ===');
const body = await page.innerText('body');
const hasText = body.trim().length > 200;
log(hasText, 'real text rendered, not a blank shell');
if (!hasText) fail('the page rendered almost no text');

// Count rows via whichever selector this build uses, rather than assuming one.
let rows = 0;
for (const sel of ['table tbody tr', '[role="row"]', '.product-card', 'article', 'li']) {
  const n = await page.locator(sel).count();
  if (n >= EXPECTED_ROWS) {
    rows = n;
    break;
  }
}
if (rows === 0) rows = await page.locator('table tbody tr, [role="row"], .product-card, article').count();
log(rows >= EXPECTED_ROWS, `all ${EXPECTED_ROWS} tracked products rendered`, `(found ${rows})`);
if (rows < EXPECTED_ROWS) fail(`only ${rows} product rows rendered`);

// A rendered price is the strongest evidence the whole chain works: static bundle ->
// CORS-allowed cross-origin fetch -> API -> database -> formatting.
const prices = body.match(new RegExp(`${RUPEE}\\s?[\\d,]+`, 'g')) || [];
log(prices.length > 0, 'prices rendered from the live database', `(${prices.length} amounts, e.g. ${prices.slice(0, 3).join(' ')})`);
if (prices.length === 0) fail('no prices rendered - the database read did not make it to the page');

console.log('\n=== network and console ===');
log(consoleErrors.length === 0, `console errors (${consoleErrors.length})`);
consoleErrors.slice(0, 4).forEach((e) => console.log(`      ${e.slice(0, 160)}`));
if (consoleErrors.length) fail(`${consoleErrors.length} console error(s)`);

log(badResponses.length === 0, `failed / 4xx-5xx requests (${badResponses.length})`);
badResponses.slice(0, 6).forEach((e) => console.log(`      ${e.slice(0, 160)}`));
if (badResponses.length) fail(`${badResponses.length} bad HTTP response(s)`);

await page.screenshot({ path: 'ui-shots/deployed-dashboard.png', fullPage: true });
console.log('\n  screenshot -> backend/ui-shots/deployed-dashboard.png');

await browser.close();

if (problems.length) {
  console.log(`\n=== DEPLOYED DASHBOARD FAILED: ${problems.join('; ')} ===`);
  process.exit(1);
}
console.log('\n=== DEPLOYED DASHBOARD OK ===');
