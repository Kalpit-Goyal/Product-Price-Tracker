import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryable, isFatal, backoffMs, classifyError } from '../src/services/retry.js';
import { InteractionError } from '../src/services/interaction.js';

test('option mismatch is fatal, option timing problems are retryable', () => {
  // These two are deliberately different codes. The product does not sell the
  // tracked option -> retrying cannot help, and the previous behaviour (assume the
  // page default) is exactly how a wrong price reaches the database.
  assert.equal(isFatal('option_not_found'), true);
  assert.equal(isRetryable('option_not_found'), false);

  // The picker had not rendered yet -> a timing problem, so a retry is reasonable.
  assert.equal(isRetryable('option_picker_absent'), true);
  assert.equal(isFatal('option_picker_absent'), false);
});

test('transient interaction failures are retryable', () => {
  for (const code of [
    'panel_never_settled',
    'panel_not_found',
    'interaction_gate_never_opened',
    'price_not_found',
    'price_unparseable',
    'stock_unparseable',
    'nav_timeout',
    'network_error',
    'http_429',
    'http_5xx',
  ]) {
    assert.equal(isRetryable(code), true, `${code} should be retryable`);
  }
});

test('permanent conditions are fatal', () => {
  for (const code of ['product_not_found', 'auth_failed', 'forbidden_host', 'config_invalid']) {
    assert.equal(isFatal(code), true, `${code} should be fatal`);
    assert.equal(isRetryable(code), false, `${code} must not be retried`);
  }
});

test('an unrecognised code is not silently treated as retryable forever', () => {
  // The default is retryable for network-ish patterns, but a bare unknown string
  // must not be. Otherwise a typo in an error code turns into an infinite retry.
  assert.equal(isRetryable('something_odd'), false);
  assert.equal(isRetryable('net::ERR_CONNECTION_RESET_timeout'), true);
  assert.equal(isRetryable(''), false);
  assert.equal(isRetryable(null), false);
});

test('backoff grows exponentially, is capped, and is jittered', () => {
  const a1 = backoffMs(1, { baseMs: 2000, maxMs: 30000 });
  const a2 = backoffMs(2, { baseMs: 2000, maxMs: 30000 });
  const a5 = backoffMs(5, { baseMs: 2000, maxMs: 30000 });
  const a50 = backoffMs(50, { baseMs: 2000, maxMs: 30000 });

  assert.ok(a1 >= 2000 && a1 < 3000, `attempt 1 out of range: ${a1}`);
  assert.ok(a2 >= 4000 && a2 < 5000, `attempt 2 out of range: ${a2}`);
  assert.ok(a5 <= 31000, `attempt 5 exceeded cap: ${a5}`);
  assert.ok(a50 <= 31000, `cap not enforced: ${a50}`);

  // Jitter must actually vary, or every scraper on the 2-hourly cron retries in
  // lockstep and the store's 429s never stop.
  const samples = new Set(Array.from({ length: 25 }, () => backoffMs(3, { baseMs: 2000, maxMs: 30000 })));
  assert.ok(samples.size > 1, 'backoff returned an identical value every time — no jitter');
});

test('classifyError keeps an explicit code and reads an HTTP status from the message', () => {
  assert.deepEqual(classifyError(new InteractionError('panel_never_settled', 'nope')), {
    code: 'panel_never_settled',
    message: 'nope',
    httpStatus: null,
  });

  const timeout = classifyError(new Error('locator.click: Timeout 8000ms exceeded.'));
  assert.equal(timeout.code, 'nav_timeout');

  const rate = classifyError(new Error('Request failed with status code 429'));
  assert.equal(rate.code, 'http_429');
  assert.equal(rate.httpStatus, 429);

  const server = classifyError(new Error('upstream returned 503'));
  assert.equal(server.code, 'http_5xx');
  assert.equal(server.httpStatus, 503);

  const net = classifyError(new Error('net::ERR_TIMED_OUT'));
  assert.equal(net.code, 'network_error');

  assert.equal(classifyError(null).code, 'unknown');
  assert.equal(classifyError(new Error('totally unexpected')).code, 'unknown');
});

test('a code that is not a safe identifier is not trusted as an error code', () => {
  // The code ends up in a SQL CHECK constraint and a CSV column. An error carrying
  // quotes or spaces must not be able to smuggle its way in.
  const hostile = new Error('boom');
  hostile.code = 'price" ; DROP TABLE scrape_attempts; --';
  const result = classifyError(hostile);
  assert.notEqual(result.code, 'price" ; DROP TABLE scrape_attempts; --');
  assert.equal(result.code, 'unknown');
});
