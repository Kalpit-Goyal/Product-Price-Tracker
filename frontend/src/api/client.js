/**
 * The backend API client.
 *
 * WHY THIS IS SO DELIBERATE ABOUT ERRORS. The single most common failure in this
 * project was a request that "worked" but returned something the caller did not
 * expect: a changed return shape, an error reported as a 200, a partial result
 * presented as complete. So every helper here returns parsed JSON plus the raw
 * status, and throws an ApiError that carries the server's own error code and
 * message. Nothing in the UI is allowed to invent a message the server did not
 * send, because the whole point of the dashboard is to be honest about what
 * actually happened.
 */

// Empty in development, where vite.config.js proxies /api to the local backend.
// Absolute in production, where a public Vercel page has no proxy in front of it.
const RAW_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }

  /** True when the store throttled us, so the UI can say "busy, try again". */
  get isRateLimited() {
    return this.code === 'store_rate_limited' || this.status === 429 || this.status === 503;
  }
}

async function request(path, { signal, method = 'GET', body, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // An aborted request is the caller's own doing (a new keystroke superseded the
    // last one), so it must not be reported as a failure to the user.
    if (err.name === 'AbortError') throw err;
    throw new ApiError(`cannot reach the API at ${API_BASE || 'this origin'} — is the backend running?`, {
      code: 'network_error',
    });
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    throw new ApiError(payload?.message ?? `request failed with HTTP ${res.status}`, {
      status: res.status,
      code: payload?.error ?? `http_${res.status}`,
      payload,
    });
  }

  return payload;
}

export const getHealth = (opts) => request('/api/health', opts);

export const searchProducts = (q, opts) =>
  request(`/api/products/search?q=${encodeURIComponent(q)}`, opts);

/** Returns `{ count, products: [...] }`. */
export const getProducts = (opts) => request('/api/products', opts);

export const getOptions = (storeProductId, opts) =>
  request(`/api/products/${encodeURIComponent(storeProductId)}/options`, opts);

export const trackProduct = (payload, opts) =>
  request('/api/products', { ...opts, method: 'POST', body: payload });

export const untrackProduct = (id, opts) =>
  request(`/api/products/${encodeURIComponent(id)}`, { ...opts, method: 'DELETE' });

/** Returns `{ trackedProductId, count, note, history: [...] }`. */
export const getHistory = (id, opts) =>
  request(`/api/products/${encodeURIComponent(id)}/history`, opts);

/** Returns `{ trackedProductId, count, attempts: [...] }`. */
export const getAttempts = (id, opts) =>
  request(`/api/products/${encodeURIComponent(id)}/attempts`, opts);

export const getRun = (runId, opts) =>
  request(`/api/scrape/runs/${encodeURIComponent(runId)}`, opts);

/**
 * POST /api/scrape/run requires the cron secret, which must never reach the
 * browser — anything in this bundle is public. So this exists only to be *not
 * callable* from a deployed frontend; the trigger is exposed solely in local
 * development, where the secret is a placeholder in the developer's own machine.
 * `health.allowManualRun` tells the UI which situation it is in.
 */
export const startRun = (secret, opts) =>
  request('/api/scrape/run', {
    ...opts,
    method: 'POST',
    body: {},
    headers: secret ? { 'x-cron-secret': secret } : {},
  });

/** Absolute URL of the CSV export, for an <a download>. */
export const csvUrl = () => `${API_BASE}/api/attempts.csv`;
