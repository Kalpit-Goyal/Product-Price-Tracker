# INE Store Price Tracker

Tracks prices for a specific **product + option** pair on a demo storefront whose
prices deliberately change on every page load, and shows the result as a price
history you can actually trust.

The hard part of this assignment is not scraping a price. It is not recording a
price that turns out to be wrong, and not inventing certainty the data does not
support. That is what most of the code here is about.

- **Backend:** Node.js + Express, Playwright Chromium
- **Frontend:** React 18 + Vite
- **Database:** Supabase/Postgres, with a local JSON store for development
- **Deploy:** Render (API) + Vercel (dashboard) + cron-job.org (schedule)
- **Docs:** [`DESIGN_NOTE.md`](DESIGN_NOTE.md) for why it is built this way — the
  trade-offs, and what the first drafts got wrong

---

## Quick start

You need Node 20+ and a Supabase project (or use the local JSON store).

```bash
# 1. Backend
cd backend
npm install
npx playwright install chromium
cp .env.example .env          # then edit it -- see below
npm start                     # listens on :10000

# 2. Frontend, in a second terminal
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

The Vite dev server proxies `/api` to `http://127.0.0.1:10000` so the browser sees
one origin. To point somewhere else, set `BACKEND_URL` rather than editing the file:

```bash
BACKEND_URL=http://127.0.0.1:4000 npm run dev
```

### Running without Supabase

Set these and the whole app runs off a local JSON file, which is enough to
develop and to demo:

```bash
MEMORY_DB=1
MEMORY_DB_FILE=./.data/memory-db.json
```

This is a development aid only: no concurrency control, no real durability. The
logs say so every time it loads.

### Tracking something to look at

```bash
cd backend
npm run seed -- --search="capture card" --limit=3   # find products
npm run seed -- --product=2662                      # track all its options
npm run scrape                                     # scrape them
```

`seed --product=<id>` resolves the product's real options from the store and
tracks each one, because a price is only meaningful for a specific option.

---

## How it works

```
                     ┌──────────────────────────────┐
  cron-job.org ─────▶│  POST /api/scrape/run       │  requires X-Cron-Secret
  (every 2h)         │  (202 Accepted, runs async)  │
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │  Playwright Chromium         │
                     │  1. GET /api/v2/ui/manifest  │  every selector comes from here
                     │  2. hover gate, then CTA     │  trusted input, dwell, moves
                     │  3. read the visible node    │  decoys are rejected
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │  every attempt is written    │
                     │  price/stock NULL on failure │
                     └──────────────┬───────────────┘
                                    ▼
   Vercel dashboard ◀───  Supabase  ◀───  GET /api/...  ◀───  Render API
```

Four decisions carry most of the weight:

**Selectors come only from the live manifest.** `/api/v2/ui/manifest` is refetched
before *every* attempt, so a revision change that rotates the class names is picked
up automatically. Nothing is hardcoded. Caching it for the process lifetime would
mean never noticing a rotation.

**The store is a random sampler, not a listing.** `/listings` returns a different
slice each call and caps at 60 per page. A single sweep of all 16 pages covered only
**611 of 960** products, and search silently omitted products that definitely
existed. Search now sweeps repeatedly until coverage converges (measured **956-958 of
960**) and reports its coverage to the caller instead of implying completeness.

**A failed attempt is a real record.** Failures are stored with `price` and `stock`
as `NULL`, never a guess. `outcome` is `retried` if the run later recovered and
`failed` if it never did, because that distinction is what the CSV export is for.
History contains successful observations only.

**Prices are jittered, so no ordering is claimed.** The store re-rolls a price on
every load. The history chart shows observations and min/max/spread. It never says
"the price dropped", because a single pair of samples cannot establish that.

---

## API

Base URL `http://localhost:10000`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | status, counts, `catalogWarm`, `allowManualRun` |
| `GET` | `/api/products/search?q=` | live search; returns `indexCoverage` and `indexComplete` |
| `GET` | `/api/products` | tracked products with latest price/stock |
| `GET` | `/api/products/:storeProductId/options` | real options read from the store |
| `POST` | `/api/products` | track a product + option; resolves names from the store |
| `DELETE` | `/api/products/:id` | untrack; cascades history and attempts |
| `GET` | `/api/products/:id/history` | successful observations only |
| `GET` | `/api/products/:id/attempts` | every attempt, including failures |
| `GET` | `/api/attempts.csv` | full CSV export |
| `POST` | `/api/scrape/run` | **requires `X-Cron-Secret`**; returns `202` + `runId` |
| `GET` | `/api/scrape/runs/:id` | `{ runId, status, attempted, succeeded, failed }` |

`POST /api/scrape/run` is the only way to start a scrape. In production it always
requires the secret; a secret-less call is permitted only when `NODE_ENV` is not
`production` **and** `ALLOW_DEV_TRIGGER=1`, which is the same condition
`/api/health` advertises as `allowManualRun`. That expression is unsatisfiable in
production, so the bypass is dead code there.

---

## Verifying it

Three gates, in increasing cost. All three are green.

```bash
cd backend
npm test          # 58 unit tests, no network
npm run smoke     # 35 API checks against a live store
npm run verify:ui # 21 checks in real Chromium against a real backend
```

| Gate | Covers | Result |
|---|---|---|
| `npm test` | parsers, retry classification, DB mapping, catalog sampling, dev config | **58/58** |
| `npm run smoke` | every documented route, auth, CSV, error mapping | **35/35** |
| `npm run verify:ui` | rendered DOM, real browser, real store, network log | **21/21** |

`verify:ui` exists because the first two can both be green while the dashboard is
blank. They prove the routes answer; only a browser proves the UI *uses* the
answers. It starts and stops its own servers, so there is nothing to leave running
and no ports to remember.

Other useful scripts:

```bash
npm run verify:options   # read all options for one product against the live store
npm run diag:gate        # diagnose why the hover gate did or did not open
```

---

## Recording the headed run

Deliverable 3 wants a 2-4 minute recording of a headed run including one slow or
failing response, so the retry logic and logging are visible.

```bash
cd backend
npm run seed -- --product=2662          # one product, three options
npm run demo:headed                     # headed, slowmo 60, one deliberate failure
```

**Use `--slowmo=60`, not something larger.** Measured headed results, all three
options of one product:

| `SLOWMO_MS` | Result |
|---|---|
| 0 | 3/3 |
| 60 | 3/3 |
| 120 | 3/3 |
| 250 | **0/3** |

The hover gate needs ~14 moves at ~40ms spacing plus a dwell, and `slowMo` delays
*every* Playwright action. Raising it to make a run look nicer on camera is exactly
what makes the scraper fail. This is Failure 19 in the build log.

Other fault kinds, if you want a different failure on camera:

```bash
npm run demo:throttle      # injects a 429-style throttle instead of a gate failure
node scripts/scrape.js --demo-fault=slow   # injects an 8s stall
```

The fault is thrown *inside* the attempt's `try` block, so it travels the real
`classifyError` → retry → `recordAttempt` path. The recording shows genuine error
handling, not a mock of it. It is refused outright when `NODE_ENV=production`.

### Shot list

1. **Terminal** — `npm run seed -- --product=2662` and `npm run scrape -- --product=2662 --ad-hoc`.
   Show the product being resolved from the store, not typed in by hand.
2. **Headed Chromium** — pointer hovering the price node so the gate visibly opens,
   then the CTA enables and the panel settles. This is the part worth slowing down,
   and the part that breaks if you raise `slowMo` past 120.
3. **The injected failure** — the terminal shows `attempt 1 failed (gate_timeout);
   retrying`, then attempt 2 succeeding. Contrast the two lines.
4. **The dashboard** — refresh and show the attempt log containing the failed
   attempt *with no price*, sitting directly above the success. That adjacency is
   the whole point of the data model.
5. **The honest chart** — point at the min/max/spread line and note that no
   trend arrow is shown, because the store jitters prices on every load.

---

## Known limitations

Stated plainly rather than left to be discovered.

- **No real Supabase project has been run against this.** The migrations, the
  `record_success()` RPC and the RLS policies are verified by review and by
  memory-mode parity tests, not by execution. There are no credentials in this
  environment.
- **The Render free tier will fight the schedule.** It idles after ~15 minutes
  while the cron fires every 2 hours, so a cold service will fail the first request
  that reaches it. The fix is an external 10-minute keep-warm ping, which is what
  the `/api/health` route exists for.
- **Catalog coverage is high, not absolute.** 956-958 of 960 measured. The missing
  few are products the sampler has not drawn. Coverage is reported to the caller
  rather than hidden.
- **A cold search costs ~60-75s** while the index rebuilds. It is warmed at boot,
  on a timer, and on the health probe, so users normally never pay it. On a host
  that just woke, the first search can still.
- **No frontend test framework.** The UI is verified by real-browser assertions in
  `verify:ui` rather than by unit tests, which catches integration and rendering
  faults but not fine-grained component logic.
- **A full-catalog scrape takes hours.** 958 products at a few seconds each is
  1-2 hours with zero failures, realistically longer with throttling. The scraper is
  resumable so a long sweep runs in batches instead of one enormous process.
