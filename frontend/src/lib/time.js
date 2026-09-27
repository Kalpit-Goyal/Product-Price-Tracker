/**
 * Timestamp formatting for the dashboard.
 *
 * WHY THE UI SHOWS IST WHILE STORAGE AND CSV STAY UTC. `scraped_at` and `attempted_at`
 * are stored and exported as ISO 8601 UTC, which is what the CSV contract requires, so
 * the database must not be touched. But every number in the database is a UTC instant
 * that a reader in IST has to convert by hand - a 5h30m offset that is easy to get
 * wrong, and a reader who gets it wrong concludes the scrape times are wrong. So the
 * rendering is IST and the raw UTC is kept reachable in the tooltip and `title`.
 *
 * WHY NOT JUST OFFSET THE STRING. Adding 5:30 to the text would silently produce a
 * plausible-looking wrong answer for any timestamp that is not exactly UTC, and it
 * cannot see a DST rule change. `Intl` with an explicit `timeZone` asks the platform
 * for the real offset for that instant.
 *
 * WHY h23 AND NOT hour12:false. `hour12: false` is allowed to render midnight as hour
 * `24`, which would print `00:00` as `24:00` on a 2-hourly schedule that fires at
 * midnight IST. `hourCycle: 'h23'` pins the 00-23 range.
 */

const IST = 'Asia/Kolkata';

const fullParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const shortParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function readParts(iso, fmt) {
  // `iso == null` rather than `!iso`: the chart passes epoch milliseconds, so a falsy
  // check would treat a legitimate timestamp of 0 as missing.
  if (iso === null || iso === undefined || iso === '') return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
}

const EM_DASH = '—';

/** Compact IST stamp for tables and chart ticks: `27 Sep, 23:30`. */
export function fmtIST(iso) {
  const p = readParts(iso, shortParts);
  if (!p) return EM_DASH;
  return `${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

/** Full IST stamp with the zone named, for detail rows: `2026-09-27 23:30:00 IST`. */
export function fmtISTFull(iso) {
  const p = readParts(iso, fullParts);
  if (!p) return EM_DASH;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} IST`;
}

/**
 * The same instant in UTC, so a reader can line the dashboard up against the CSV
 * export, whose timestamps are ISO 8601 UTC by contract.
 */
export function fmtUTC(iso) {
  if (iso === null || iso === undefined || iso === '') return EM_DASH;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return EM_DASH;
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}
