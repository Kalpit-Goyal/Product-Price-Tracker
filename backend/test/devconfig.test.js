import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * WHY THIS TEST EXISTS.
 *
 * `frontend/vite.config.js` proxied `/api` to `127.0.0.1:3001` while the backend's
 * default `PORT` is 10000. Nothing warned about it: `npm start` in `backend/` and
 * `npm run dev` in `frontend/` both started cleanly, and every request from the
 * browser failed. A fresh clone could not talk to itself, and the failure looked
 * like a backend problem rather than a config mismatch.
 *
 * This asserts the two numbers agree, in both directions, so a port change on
 * either side fails here instead of in a browser.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const viteConfig = await readFile(new URL('../../frontend/vite.config.js', import.meta.url), 'utf8');

// `PORT: intish(10000)` in backend/src/config.js is the source of truth.
const backendConfig = await readFile(new URL('../../backend/src/config.js', import.meta.url), 'utf8');
const portMatch = backendConfig.match(/PORT:\s*intish\((\d+)\)/);
const backendDefaultPort = portMatch ? Number(portMatch[1]) : null;

test('backend has a parseable default PORT', () => {
  assert.ok(backendDefaultPort, 'could not read the default PORT out of backend/src/config.js');
});

test('vite dev proxy targets the port the backend actually listens on', () => {
  // Match the proxy target only, not the BACKEND_URL fallback comment.
  const target = viteConfig.match(/target:\s*process\.env\.BACKEND_URL\s*\?\?\s*'([^']+)'/);
  assert.ok(target, 'expected the proxy target to read process.env.BACKEND_URL ?? <default>');

  const url = new URL(target[1]);
  const proxyPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  assert.equal(
    proxyPort,
    backendDefaultPort,
    `vite proxies /api to port ${proxyPort} but the backend defaults to ${backendDefaultPort}. ` +
      `Fix one or the other, or set BACKEND_URL when running the frontend.`
  );
});

test('the proxy target is overridable without editing the file', () => {
  // Local development genuinely needs this: a second checkout, or a backend on
  // another port, should not require editing a committed file.
  assert.match(
    viteConfig,
    /process\.env\.BACKEND_URL/,
    'proxy target should honour BACKEND_URL so a dev can point at another backend'
  );
});
