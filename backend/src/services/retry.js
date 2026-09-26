/**
 * Retry policy.
 *
 * WHY jitter is not optional: the 2-hourly cron means many people's scrapers hit
 * this store on the same schedule, and the store rate-limits with 429. A fixed
 * backoff makes every client retry in lockstep and keeps the 429s coming. Jitter
 * de-synchronises them.
 *
 * WHY Retry-After is honoured: the store tells us how long it wants to wait, and
 * ignoring it is both rude and ineffective. It is clamped so a hostile or buggy
 * value cannot make a single attempt hang for hours.
 */

const RETRYABLE_CODES = new Set([
  'hover_timeout',
  'gate_not_open',
  'gate_not_open_click',
  'panel_no_box',
  'panel_never_settled',
  'interaction_gate_never_opened',
  'panel_not_found',
  'panel_no_box',
  'cta_not_found',
  'option_select_failed',
  'option_not_selected',
  'option_picker_absent',  // the picker had not rendered yet — timing, so retry
  'price_not_found',
  'price_ambiguous',
  'price_unparseable',
  'price_implausible',
  'stock_not_found',
  'stock_unparseable',
  'extraction_schema_invalid',
  'nav_error',
  'nav_timeout',
  'http_429',
  'http_5xx',
  'network_error',
  'target_unavailable',
  'browser_crashed',
]);

/** Never retried: retrying cannot help and wastes the run's budget. */
const FATAL_CODES = new Set([
  'product_not_found',   // 404 — the store dropped the product
  'option_not_found',    // the product does not sell the tracked option at all.
                         // Retrying cannot invent it, and the old behaviour here
                         // (assume the default) is how a wrong price gets stored.
  'auth_failed',         // 401/403 on the price request
  'forbidden_host',      // our own guard rail
  'config_invalid',
]);

export function isRetryable(code) {
  if (!code) return false;
  if (FATAL_CODES.has(code)) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  // Default to retryable for network-ish codes we did not enumerate.
  return /timeout|network|http_5|ECONN|ECONNRESET|ETIMEDOUT|socket/i.test(code);
}

export function isFatal(code) {
  return FATAL_CODES.has(code);
}

/**
 * @param {number} attempt 1-based
 * @param {{ baseMs?: number, maxMs?: number }} opts
 */
export function backoffMs(attempt, { baseMs = 2000, maxMs = 30000 } = {}) {
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return Math.round(exponential + Math.random() * 1000);
}

/**
 * Turn a thrown error into a stable, loggable code.
 * Kept in one place so the DB check constraint, the CSV and the UI all agree.
 */
export function classifyError(err) {
  if (!err) return { code: 'unknown', message: 'unknown error', httpStatus: null };
  if (err.code && typeof err.code === 'string' && /^[a-z0-9_]+$/.test(err.code)) {
    return { code: err.code, message: err.message ?? err.code, httpStatus: err.httpStatus ?? null };
  }

  const message = String(err.message ?? err);

  const status = /\b(4\d\d|5\d\d)\b/.exec(message);
  const httpStatus = status ? Number(status[1]) : null;

  let code = 'unknown';
  if (/Timeout .*exceeded|nav_timeout|timeout/i.test(message)) code = 'nav_timeout';
  else if (/net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|network/i.test(message)) code = 'network_error';
  else if (/browser has been closed|Target closed|crash/i.test(message)) code = 'browser_crashed';
  else if (httpStatus === 429) code = 'http_429';
  else if (httpStatus && httpStatus >= 500) code = 'http_5xx';
  else if (httpStatus) code = `http_${httpStatus}`;

  return { code, message: message.slice(0, 500), httpStatus };
}
