/**
 * Keeps a sleeping host awake while a scrape is in progress.
 *
 * WHY THIS EXISTS. Render idles a free web service after ~15 minutes without inbound
 * traffic. A scrape of the tracked set takes minutes -- the first full deployed run took
 * 11m40s -- and produces NO inbound traffic while it works, so the margin against that
 * limit is uncomfortably thin. The heartbeat calls our own /api/health while we work.
 * That endpoint is already suited to it: it is fast and never blocks on the search index.
 *
 * WORTH BEING HONEST ABOUT WHAT THIS DID AND DID NOT FIX. This module was written after
 * the first deployed run came back 0/11, on the theory that the host had been reaped
 * mid-run. That diagnosis was WRONG. The run completed normally and every attempt failed
 * for an unrelated reason: the Playwright browser binary was never installed, because
 * `buildCommand: npm ci` installs the playwright package but not Chromium. The fix was
 * in render.yaml. The uptime reset that looked like a crash was just the service having
 * idled before the run woke it.
 *
 * The heartbeat is kept because the underlying risk is real and independent -- 11m40s is
 * only ~3 minutes inside a 15-minute window -- not because it fixed anything yet. The
 * honest status is "cheap insurance, not yet proven necessary". If two-hourly cron runs
 * reliably complete with it disabled, it should be deleted rather than kept as folklore.
 *
 * WHY THIS IS NOT A SCHEDULER. It never starts a scrape. It only pings while one is
 * already running, and it is started and stopped by the run itself. The assignment
 * forbids an in-process interval because an in-process timer that *schedules scrapes*
 * would be invisible to, and unaccountable to, the operator -- you could not tell from
 * outside whether the job was cloud-hosted or merely hoping. Nothing here decides when
 * to scrape; only the external cron does that. This is a liveness heartbeat, in the same
 * family as Render's own keep-alive.
 *
 * WHY IT IS OFF BY DEFAULT. Locally this would be pure overhead, and in the smoke tests
 * it would make an ephemeral port talk to itself. It only makes sense where the host
 * actually reaps idle processes, so it is opt-in.
 */
import config from '../config.js';
import logger from '../util/logger.js';

/**
 * Render idles at ~15 minutes. Pinging far inside that leaves room for one slow
 * response, and a 60s cadence costs 60 trivial requests per hour -- a rounding error
 * against the free tier's 750 instance-hours.
 */
const DEFAULT_INTERVAL_MS = 60_000;

/** Generous ceiling on one request. If a ping hangs, do not queue more behind it. */
const PING_TIMEOUT_MS = 10_000;

let timer = null;
let beats = 0;
let inFlight = false;

/**
 * Where to send the beat.
 *
 * NOTE THE ENV KEY IS read verbatim, not in camelCase. config.js spreads the parsed
 * schema, so the key is `KEEP_ALIVE_URL`. An earlier version of this file read
 * `config.keepAliveUrl`, which is always undefined -- the override was silently ignored
 * and every beat went to loopback, where it succeeded or failed without ever being
 * visible to the host. A heartbeat that quietly degrades to a no-op is worse than none,
 * because it looks like the problem is handled.
 *
 * The loopback fallback is only a last resort. Render decides a free instance is idle
 * from traffic it sees arriving, and a request the service makes to itself does not
 * count, so KEEP_ALIVE_URL must be set to the public URL in any deployed environment.
 */
function keepAliveBaseUrl() {
  return config.KEEP_ALIVE_URL ?? `http://127.0.0.1:${config.PORT}`;
}

/**
 * One beat. Errors are swallowed deliberately.
 *
 * A heartbeat that throws is worse than no heartbeat: it would turn a liveness aid into
 * a new failure mode. If the instance is genuinely gone, the process is not running to
 * report it, and the run will be recovered by the next cron cycle either way.
 */
async function beat() {
  if (inFlight) return;
  inFlight = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(`${keepAliveBaseUrl()}/api/health`, { signal: controller.signal });
      beats += 1;
      if (!res.ok) {
        logger.warn({ event: 'keepalive_ping_failed', status: res.status }, 'keep-alive ping was not 2xx');
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.warn({ event: 'keepalive_ping_error', err: err.message }, 'keep-alive ping failed');
  } finally {
    inFlight = false;
  }
}

/**
 * Call `fn` while holding the instance awake.
 *
 * Beats immediately rather than after the first interval, because a run that has only
 * just started is exactly the case that gets reaped: the previous idle period may
 * already have been close to the limit.
 */
export async function withKeepAlive(fn) {
  if (!config.KEEP_ALIVE_DURING_RUNS) {
    return fn();
  }

  const interval = config.KEEP_ALIVE_INTERVAL_MS || DEFAULT_INTERVAL_MS;
  logger.info({ event: 'keepalive_start', intervalMs: interval }, 'holding the instance awake for the duration of the run');

  // Deliberately unref'd: a pending heartbeat must never be the reason the process
  // refuses to exit on SIGTERM. See server.js, which force-exits after 10s anyway.
  timer = setInterval(beat, interval);
  if (typeof timer.unref === 'function') timer.unref();
  beat();

  try {
    return await fn();
  } finally {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    logger.info({ event: 'keepalive_stop', beats }, 'keep-alive stopped');
    beats = 0;
  }
}

/** Exposed for tests: is a heartbeat currently scheduled? */
export function isKeepAliveRunning() {
  return timer !== null;
}
