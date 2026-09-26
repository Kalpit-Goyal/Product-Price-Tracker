import app from './app.js';
import config from './config.js';
import logger from './util/logger.js';
import { usingMemoryDb } from './util/db.js';
import { startCatalogWarmer } from './services/catalog.js';
import { verifyBrowserAvailable } from './services/browser.js';

/**
 * The HTTP entry point.
 *
 * Kept separate from app.js so the app can be imported by tests without binding a
 * port. Nothing else belongs in this file.
 */
const server = app.listen(config.PORT, () => {
  logger.info(
    {
      event: 'server_listening',
      port: config.PORT,
      env: config.NODE_ENV,
      store: usingMemoryDb ? 'local-json-file' : 'supabase',
      target: config.scrapeBaseUrl,
    },
    `INE price tracker API listening on :${config.PORT}`
  );

  // Start filling the search index immediately, off the request path. A cold search
  // costs ~76s of live store traffic, which no proxy will wait out, so the index has
  // to already be there by the time anyone asks for it.
  startCatalogWarmer();

  // Fail loudly here rather than silently on the first cron. Not awaited: the listener
  // is already accepting requests and the read-only API works fine without a browser,
  // so there is no reason to make startup wait on it.
  verifyBrowserAvailable();
});

/**
 * WHY graceful shutdown: Render sends SIGTERM before restarting or deploying. On
 * SIGTERM a scrape run may be mid-flight with a live Chromium. Exiting immediately
 * would abandon a half-written attempt; draining first means the run either
 * finishes or is cleanly interrupted with an honest record.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown_signal', signal }, 'shutting down');
    server.close(() => {
      logger.info({ event: 'shutdown_complete' }, 'http server closed');
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => {
      logger.warn({ event: 'shutdown_forced' }, 'forcing exit after shutdown timeout');
      process.exit(1);
    }, 10000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  // Log and keep serving: one bad promise must not take the API down.
  logger.error({ event: 'unhandled_rejection', reason: String(reason) }, 'unhandled promise rejection');
});
