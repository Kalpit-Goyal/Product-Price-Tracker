import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

/**
 * Tests for the run-scoped keep-alive heartbeat.
 *
 * The failure this guards against is not hypothetical and not subtle: the first
 * deployed run was killed partway through by a host-side restart, leaving a
 * `scrape_runs` row stuck at `running` with `attempted: 0`. A regression here would
 * present as "the cron just silently stopped working", which is the worst possible
 * failure mode for the deliverable.
 *
 * WHY EACH CASE RUNS IN A CHILD PROCESS. config.js is a snapshot -- it reads
 * process.env once at import time and freezes it -- and keepalive.js pulls it in with a
 * STATIC import. ESM caches a module by its resolved URL, so the first keepalive.js
 * import in a process pins config.js for good. Cache-busting the entry module does not
 * help, because its `../config.js` import still resolves to the same canonical URL:
 *
 *   env=0, import keepalive  ->  config.js frozen at false forever
 *   env=1, import keepalive  ->  fresh module, still sees the frozen false
 *
 * The first version of this file did exactly that and its "enabled" cases silently
 * exercised the disabled path. Re-importing cannot fix it, so each case gets a clean
 * process, which is also the only way to genuinely test the unref'd-timer behaviour.
 * Worth remembering: a failing test is not always telling you about the code you
 * think it is testing.
 *
 * Hit counting stays in the parent: the parent owns the HTTP server and counts
 * requests, the child just drives withKeepAlive and reports what it observed.
 */

const MODULE_URL = new URL('../src/util/keepalive.js', import.meta.url).href;
const UNREACHABLE = 'http://127.0.0.1:1'; // reserved port, nothing listens
const MARKER = '__KA__';

// Driven inside the child. Deliberately not a bare `await import` of a relative path:
// it is handed the module as a file URL because the child's cwd is not guaranteed.
const CHILD = `
const mod = await import(process.env.KA_MODULE);
const { withKeepAlive, isKeepAliveRunning } = mod;
const out = { during: null, running: null, threw: null, result: 'body never called' };
try {
  out.result = await withKeepAlive(async () => {
    out.during = isKeepAliveRunning();
    if (process.env.KA_HOLD_MS) await new Promise((r) => setTimeout(r, Number(process.env.KA_HOLD_MS)));
    if (process.env.KA_THROW) throw new Error('scraper blew up');
    return 'body ran';
  });
} catch (e) {
  out.threw = e.message;
}
out.running = isKeepAliveRunning();
console.log('${MARKER}' + JSON.stringify(out));
`;

/** Runs one scenario in a fresh process and returns what the child observed. */
function runInChild(env, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { PATH: process.env.PATH, KA_MODULE: MODULE_URL, ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child hung for ${extra.KA_TIMEOUT_MS ?? 15000}ms -- the interval is not unref'd`));
    }, extra.KA_TIMEOUT_MS ?? 15000);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith(MARKER));
      if (!line) return reject(new Error(`no result from child (exit ${code}):\n${stderr || stdout}`));
      resolve(JSON.parse(line.slice(MARKER.length)));
    });
  });
}

describe('keep-alive heartbeat', () => {
  let server;
  let port;
  let hits;

  before(async () => {
    hits = 0;
    server = http.createServer((req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test('is a no-op when disabled, and calls the body exactly once', async () => {
    const before = hits;
    const out = await runInChild({
      KEEP_ALIVE_DURING_RUNS: '0',
      KEEP_ALIVE_INTERVAL_MS: '20',
      KEEP_ALIVE_URL: `http://127.0.0.1:${port}`,
      KA_HOLD_MS: '120',
    });

    assert.equal(out.result, 'body ran', 'the run must still happen when disabled');
    assert.equal(out.threw, null);
    assert.equal(out.during, false, 'no timer should be scheduled when disabled');
    assert.equal(out.running, false);
    assert.equal(hits, before, 'must not ping at all when disabled, even over 120ms at 20ms');
  });

  test('pings immediately on entry, before the first interval elapses', async () => {
    const before = hits;
    const out = await runInChild({
      KEEP_ALIVE_DURING_RUNS: '1',
      KEEP_ALIVE_INTERVAL_MS: '60000', // long enough that only the opening beat can fire
      KEEP_ALIVE_URL: `http://127.0.0.1:${port}`,
    });

    assert.equal(out.result, 'body ran');
    assert.equal(out.during, true, 'heartbeat should be scheduled while the run is in flight');
    // The opening beat is fired before the body runs, so a scrape that starts just
    // before the idle window closes still registers as traffic first.
    assert.equal(hits - before, 1, 'exactly one beat, and it happened before the body ran');
    assert.equal(out.running, false, 'timer must be cleared on the way out');
  });

  test('keeps beating on an interval for the whole run', async () => {
    const before = hits;
    const out = await runInChild({
      KEEP_ALIVE_DURING_RUNS: '1',
      KEEP_ALIVE_INTERVAL_MS: '25',
      KEEP_ALIVE_URL: `http://127.0.0.1:${port}`,
      KA_HOLD_MS: '250',
    });

    assert.equal(out.during, true);
    // ~250ms at 25ms, plus the opening beat. Assert a floor rather than an exact count:
    // this is a liveness aid and must never become the reason a run is brittle.
    assert.ok(hits - before >= 4, `expected repeated beats, saw ${hits - before}`);
    assert.equal(out.running, false);
  });

  test('stops the heartbeat when the run throws', async () => {
    const before = hits;
    const out = await runInChild({
      KEEP_ALIVE_DURING_RUNS: '1',
      KEEP_ALIVE_INTERVAL_MS: '25',
      KEEP_ALIVE_URL: `http://127.0.0.1:${port}`,
      KA_HOLD_MS: '120',
      KA_THROW: '1',
    });

    assert.equal(out.threw, 'scraper blew up', 'the original error must propagate unchanged');
    assert.equal(out.running, false, 'a failed run must not leave a timer running');
    assert.equal(hits - before >= 1, true, 'it should have been beating before it failed');
  });

  test('an unreachable keep-alive URL does not fail the run', async () => {
    const out = await runInChild({
      KEEP_ALIVE_DURING_RUNS: '1',
      KEEP_ALIVE_INTERVAL_MS: '25',
      KEEP_ALIVE_URL: UNREACHABLE,
      KA_HOLD_MS: '120',
    });

    // The heartbeat is a liveness aid. Turning it into a new failure mode -- where a
    // self-request that cannot be routed kills a scrape that would otherwise have
    // succeeded -- is strictly worse than having no heartbeat at all.
    assert.equal(out.threw, null, 'a dead keep-alive URL must not break the scrape');
    assert.equal(out.result, 'body ran');
    assert.equal(out.during, true);
    assert.equal(out.running, false);
  });

  test('does not hold the event loop open after the run', async () => {
    // A ref'd interval would keep the process alive for the full 30s, blowing past
    // Render's 10s SIGTERM grace window and abandoning the run half-written. The child
    // is killed at 15s and the test fails, so a regression here cannot hang the suite.
    const out = await runInChild(
      {
        KEEP_ALIVE_DURING_RUNS: '1',
        KEEP_ALIVE_INTERVAL_MS: '30000',
        KEEP_ALIVE_URL: `http://127.0.0.1:${port}`,
      },
      { KA_TIMEOUT_MS: 15000 }
    );

    assert.equal(out.result, 'body ran');
    assert.equal(out.running, false);
  });
});
