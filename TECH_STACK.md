# TECH STACK — INE Store Price Tracker

Companion to [`REQUIREMENTS.md`](./REQUIREMENTS.md).
**Plain JavaScript throughout — no TypeScript.**

**Target site:** https://demo.inelabteamdev.com/
**Hard deadline:** Sunday, **27 September 2026, 11:59 PM IST**

---

## 1. At a glance

| Layer | Choice | Hosting | Why |
|---|---|---|---|
| Frontend | **React 18 + Vite** (JSX) | **Vercel** | Required by assignment (React *or* Vue). Vite builds in seconds, which matters against a 1-day deadline |
| Charts | **Recharts** | — | React-native, no canvas config |
| Backend | **Node 20 + Express** (ESM, no build step) | **Render** (Web Service) | Required by assignment (Node *or* Django). One language across the whole stack |
| Scraping | **Playwright (Chromium)** for price/stock; **native `fetch`** for catalog + manifest | — | The only way to satisfy the hover/signature gate (see §5) |
| Database | **Supabase (PostgreSQL)** | Supabase | Required. Free tier, gives us `pg` semantics + SQL migrations |
| Scheduling | **cron-job.org** → `POST /api/scrape/run` | cron-job.org | Required. Render free tier sleeps, so no in-process loop |
| CSV | **csv-stringify** | — | Correct RFC 4180 quoting/escaping for free |
| Validation | **Zod** | — | Runtime validation of untrusted scraped data — more important than types here |
| Logging | **pino** | — | JSON logs, cheap, Render-friendly |

### 1.1 Why no TypeScript (and what replaces it)

Deliberate choice, not an oversight. The two things TS would have given us compile-time safety on
are handled a different way:

| Without TS | Replacement |
|---|---|
| Compile-time type errors | **Zod** schemas at every boundary (API bodies, DB rows, scraped payloads). Scraper output is *untrusted runtime data*, so runtime validation is the check that actually matters |
| Types on shared shapes | **JSDoc `@typedef`** for the manifest, the price/stock extraction result, and the CSV row — editors still autocomplete and `checkJs` can be enabled later without a migration |
| Catching selector drift | **The manifest contract + `revision` change detection** — the real protection. A type cannot tell you a CSS class was renamed; a re-read manifest can |

Frontend uses **`.jsx`**, backend uses **`.js`**. No `tsconfig.json`, no `tsc` build step, so Render
deploys with a plain `node src/server.js` — one less thing to break.

---

## 2. Frontend — React + Vite (JavaScript)

```
frontend/
├── index.html
├── vite.config.js
├── .env.example            # VITE_API_BASE
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── api/client.js       # fetch wrapper
    ├── components/
    │   ├── SearchPanel.jsx     # search store, pick product + option
    │   ├── ProductCard.jsx
    │   ├── Dashboard.jsx       # all tracked products, latest price/stock
    │   ├── HistoryChart.jsx    # Recharts price over time
    │   ├── HistoryTable.jsx    # price + stock history table
    │   ├── ScrapeLog.jsx       # per-product attempt log
    │   └── ExportButton.jsx    # CSV download
    └── styles.css
```

**Packages:** `react`, `react-dom`, `react-router-dom`, `recharts`, `vite`, `@vitejs/plugin-react`.

**Decisions**

- **Vite over CRA** — CRA is deprecated; Vite's dev server and build are far faster.
- **Plain CSS** (or a small utility set). No Tailwind, no component library — CSS is not the
  graded part and a UI kit costs install time we don't have.
- **Frontend talks to the Render API, never directly to Supabase.** One auth path, and it keeps
  the service-role key off the client. The Supabase JS client is used server-side only.
- **Export button** = plain `fetch` → `blob` → object URL download. No extra library.
- **Vite dev proxy** (`/api` → Render) so there is no CORS surface during local development;
  in production Vercel rewrites `/api/*` to Render, or the API sets permissive CORS for the
  Vercel origin.

**Deploy (Vercel)**

- Root directory: `frontend`
- Build: `vite build` · Output: `dist`
- Env: `VITE_API_BASE=https://<backend>.onrender.com`

---

## 3. Backend — Node + Express (JavaScript, ESM)

```
backend/
├── package.json            # "type": "module"
├── .env.example
├── src/
│   ├── server.js           # app + listen
│   ├── app.js              # express wiring
│   ├── config.js           # env validation
│   ├── routes/
│   │   ├── products.js     # search, track, list, delete
│   │   ├── history.js      # history + attempts
│   │   ├── export.js       # CSV
│   │   └── scrape.js       # /api/scrape/run (cron-secret guarded)
│   ├── services/
│   │   ├── catalog.js      # /api/v2/listings pager + cached index + substring search
│   │   ├── scraper.js      # the orchestrator (REQUIREMENTS §5)
│   │   ├── browser.js      # Playwright lifecycle, one shared browser
│   │   ├── extract.js      # manifest-driven, decoy-safe extraction
│   │   ├── manifest.js     # /api/v2/ui/manifest + revision tracking
│   │   ├── interaction.js  # the hover gate: 8+ trusted moves, >=40ms apart, 600ms dwell
│   │   ├── retry.js        # backoff + jitter + Retry-After
│   │   └── db.js           # Supabase queries
│   ├── db/migrations/001_init.sql
│   └── util/{logger.js,lock.js,parse.js}
└── scripts/
    ├── scrape.js           # CLI entry: --headed, --once, --product=<id>
    └── seed.js             # track 3 products for the submission requirement
```

**Packages:** `express`, `@supabase/supabase-js`, `playwright`, `zod`, `csv-stringify`,
`csv-parse` (for round-trip tests), `pino`, `pino-http`, `dotenv`, `cors`.

**Decisions**

- **ESM** (`"type": "module"`) — current default, and `import` reads better than `require`.
- **No build step.** `node src/server.js` on Render. Nothing to compile, nothing to cache wrong.
- **Zod at every boundary** — the single most valuable library in this project, because the
  scraped values are untrusted.
- **`pino` not `console.log`** — structured JSON, so attempt outcomes are greppable in Render logs.
- **`cors`** scoped to the Vercel origin only.
- **`/health`** returns last successful scrape time; cron-job.org hits it to keep the free
  instance awake.
- **DB lock** (`pg_advisory_lock` equivalent via a Supabase RPC, or a lock row) prevents the cron
  and a manual *Run now* from scraping concurrently.

**Deploy (Render)**

- Type: **Web Service** (not Background Worker — a cron service would be nicer but the free tier
  and the assignment's cron-job.org guidance point at a web service).
- Build: `npm ci`
- Start: `node src/server.js`
- Env: see §8
- Health check path: `/health`

---

## 4. Database — Supabase (PostgreSQL)

- Schema per `REQUIREMENTS.md` §3: `tracked_products`, `price_history`, `scrape_attempts`.
- Migrations as plain `.sql` in `backend/src/db/migrations/`, applied via the Supabase SQL editor
  (fastest for a 1-day deadline) or `supabase db push` with the CLI.
- **Client:** `@supabase/supabase-js` with the **service-role key**, server-side only.
  Row Level Security stays **on**; the service role bypasses it, and the anon key is never used
  from the browser because the browser never touches Supabase.
- **Connection:** the pooled/transactional connection string (`:6543` transaction mode, or
  `:3000` session mode). Note the free project pauses after inactivity — cron-job.org hitting
  `/health` mitigates this.
- **Indexes** on `price_history(tracked_product_id, scraped_at desc)` and
  `scrape_attempts(tracked_product_id, attempted_at desc)`.
- **Check constraint** on `scrape_attempts.outcome` ∈ (`success`,`retried`,`failed`).
- **Cron-job.org** also pinging Supabase directly is a viable keep-alive fallback.

---

## 5. Scraping — the hybrid decision

This is a graded criterion ("a sensible choice between lightweight fetching and a headless
browser"), so the split is deliberate and defensible.

| Target | Method | Justification |
|---|---|---|
| `/api/v2/listings?page=&limit=` | **native `fetch`** + `res.json()` | Plain JSON. A browser here is pure waste — slower and harder to run. Also the only way to enumerate all 960 products for search |
| `/api/v2/ui/manifest` | **native `fetch`** | Plain JSON, tiny, changes rarely → cache by `revision` |
| `/item/{id}` price + stock | **Playwright Chromium** | **Genuinely requires a browser** — see below |

### 5.1 Why the browser is unavoidable for price/stock

Verified against the live bundle:

1. `GET /` returns only `<div id="root"></div>` — **no price in the HTML**.
2. The price is **hover-gated**: ≥ **8** distinct `mousemove` events (`minMoves: 8`) with a
   **600 ms** dwell (`minDwellMs: 600`), and moves are throttled to one per **40 ms**.
3. The request signature includes **`trusted`** (`event.isTrusted`). Synthetic
   `element.dispatchEvent()` produces `isTrusted === false` and is rejected — we need CDP-dispatched
   real input, i.e. `page.mouse.move()`.
4. The price fetch is **signed**, returns a **`pass`** token, and the payload is
   **wrapped/encrypted** (`wr(json, pass)`) — not readable without executing the page's own JS.
5. The response is rate limited (`429`).

Cheerio/pure-HTTP cannot satisfy 2–4. This is the textbook case the assignment describes as
"only where the page genuinely requires it".

### 5.2 Why the browser is still kept minimal

- **One shared browser instance**, launched once per run, reused across products. Launching
  Chromium per product would dominate the runtime and trip rate limits.
- **Concurrency 1** for price scrapes — sequential, with backoff. Politeness and reliability beat
  speed for a 2-hourly job.
- Product context is reused where safe; a fresh context after a failure.
- `fetch` for the catalog, so bulk enumeration costs no browser time.
- **Hard timeouts on everything** (`navigationTimeout`, `actionTimeout`, overall attempt budget)
  so a hung page can never wedge a cron run.
- Chromium only — no Firefox/WebKit, no mobile emulation.
- Contexts/incognito profiles so no state leaks between attempts.

### 5.3 Selector strategy — manifest-driven, never hardcoded

`/api/v2/ui/manifest` hands out **randomized class names** per layout `revision`
(`classes.priceValue`, `classes.stock`, `classes.mrp`, …) plus `priceTag` and `priceCarrier`.
Selectors are therefore **resolved from the manifest at runtime**, and a `revision` change
invalidates the cache and re-reads it.

**Decoy safety.** The page renders hidden fake prices under a *stable* class `.price-value`
(`aria-hidden="true"`, `display:none`), plus a second decoy at real-price + 7, an MRP, a member
price, and a `<canvas>` watermark containing decoy digits. Rule: select by the manifest's
`priceValue` class, then discard `aria-hidden="true"` and non-rendered candidates. **Never select
`.price-value`.**

**Format normalization.** Price renders in 5 rotating variants (`en-IN` currency, `spaced`,
`euro`, `trailing`, `unicode`) and may be **one `<span>` per character** when
`priceCarrier: "split"`. Stock renders in 5 rotating templates (`N units available`,
`Last few: N`, `Available (N)`, `Stock: N remaining`, `Ready to ship — N available`) or
`Sold out` → `0`. Parse by **stripping to digits** and **`\d+` extraction** — never by matching a
specific template.

### 5.4 Headed mode

`HEADLESS=0` → visible Chromium, `slowMo` for legibility, optional `--record` to produce the
2–4 minute screen recording. `scripts/scrape.js` is the entry point:

```bash
npm run scrape:headed                 # watch it run
node scripts/scrape.js --headed --slowmo=400 --product=2022 --option=o2
```

Headed runs are **local only** — a headless Linux container on Render has no display, so the
recording is captured on a developer machine against the same code.

---

## 6. Scheduling — cron-job.org

```
cron-job.org (every 2 h)
        │  GET  https://<backend>.onrender.com/health      ← keep-alive ping
        │  POST https://<backend>.onrender.com/api/scrape/run
        │        X-Cron-Secret: <CRON_SECRET>
        ▼
   scrape all active tracked_products
        ▼
   insert scrape_attempts (+ price_history on success)
        ▼
   200 { runId, attempted, succeeded, failed }
```

- **No `node-cron`, no `setInterval`, no always-on loop.** Render's free tier sleeps; the
  assignment explicitly forbids relying on an always-on process.
- Every 2 hours is the assignment's required cadence.
- If a run risks exceeding Render's request timeout: return `202 { runId }` immediately and let
  the frontend poll `GET /api/scrape/runs/:id`.
- The same endpoint backs the dashboard's **Run now** button.
- **Start the cron early** — real unattended history needs ≥ 2 cycles of wall-clock time, and
  that is the one thing that cannot be rushed at the end.

---

## 7. Repository layout

```
ine-price-tracker/
├── REQUIREMENTS.md
├── TECH_STACK.md
├── README.md                 # setup, schedule, env vars  (deliverable)
├── DESIGN_NOTE.md            # reliability, trade-offs, AI-tool post-mortem (deliverable)
├── .env.example
├── frontend/                 # React + Vite        → Vercel
├── backend/                  # Node + Express      → Render
│   └── src/db/migrations/    # Supabase SQL
└── .github/workflows/ci.yml  # lint + test (bonus)
```

> **Note:** `C:\Users\HP\Desktop\INE` currently sits *inside* the git repository rooted at
> `C:\Users\HP` (the entire home directory is tracked). The public deliverable needs its **own**
> repository — create a clean project folder and `git init` there rather than committing into the
> home-directory repo.

---

## 8. Environment variables

### Backend (Render — server-side only)

| Variable | Example | Required | Purpose |
|---|---|---|---|
| `PORT` | `10000` | platform | Render injects it |
| `SUPABASE_URL` | `https://xxx.supabase.co` | ✅ | Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGci…` | ✅ | **server-side only** — bypasses RLS, never in the browser or in git |
| `CRON_SECRET` | 32+ random chars | ✅ | authenticates `POST /api/scrape/run` via `X-Cron-Secret` |
| `HEADLESS` | `1` (prod) / `0` (local) | ✅ | headed vs headless Chromium |
| `SCRAPE_BASE_URL` | `https://demo.inelabteamdev.com` | ✅ | target store — **only** this host is ever scraped |
| `SCRAPE_TIMEOUT_MS` | `30000` | ➖ | per-attempt budget |
| `SCRAPE_MAX_ATTEMPTS` | `6` | ➖ | matches the store's own `jr = 6` |
| `SCRAPE_CONCURRENCY` | `1` | ➖ | politeness; keep at 1 |
| `ALLOWED_ORIGIN` | `https://<app>.vercel.app` | ➖ | CORS allowlist |
| `LOG_LEVEL` | `info` | ➖ | pino level |

### Frontend (Vercel)

| Variable | Example | Purpose |
|---|---|---|
| `VITE_API_BASE` | `https://<backend>.onrender.com` | backend base URL |

> Only `VITE_*` variables reach the browser. **Never** prefix a secret with `VITE_`.

---

## 9. Local development

```bash
# backend
cd backend
npm install
npx playwright install chromium      # required once
cp .env.example .env                # fill in Supabase + CRON_SECRET
node src/server.js                  # http://localhost:10000
node scripts/scrape.js --headed     # watch the scraper work

# frontend
cd frontend
npm install
cp .env.example .env
npm run dev                         # http://localhost:5173, /api proxied to :10000
```

**Order of operations on a fresh machine:** `npm install` → `npx playwright install chromium`
(skipping this is the #1 cause of "browser not found" on Render).

---

## 10. CI (bonus)

`.github/workflows/ci.yml`: install deps, `npx playwright install --with-deps chromium`, lint,
run unit tests, validate migrations, verify the app boots and `/health` responds. No secrets in
CI logs; Supabase access via repository secrets or a throwaway project.

---

## 11. Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| **Cheerio / pure HTTP scraping** | Fails outright. The page ships no price markup, the price is behind a hover gate needing **trusted** events, and the payload is signed + encrypted. This is the assignment's explicit "only where genuinely required" case. |
| **Puppeteer instead of Playwright** | Playwright has better auto-waiting, first-class `expect` assertions, trace/screenshot/video built in (useful for the deliverable recording), and a cleaner multi-context API. Puppeteer is perfectly workable — this is a preference, not a limitation. |
| **Firecrawl / Apify / a scraping API** | Violates "scrape only INE's provided mock store" in spirit, adds a paid dependency, and can't satisfy the interaction gate anyway. |
| **Hardcoding today's CSS class names** | Guaranteed to break at the next `manifest.revision`. Manifest-driven resolution is the whole point. |
| **Django + DRF** | Allowed, but forces Python Playwright alongside a JS frontend — two languages, two dep trees, slower under the deadline. |
| **Vue 3 instead of React** | Allowed and fine. React chosen for ecosystem breadth and faster team/AI familiarity. |
| **TypeScript** | Excluded by choice. Compensated with Zod runtime validation + JSDoc typedefs (§1.1) — runtime validation matters more than compile-time types for untrusted scraped data. |
| **A design system / UI kit (MUI, AntD)** | The UI is explicitly not the graded part. Install time is better spent on scraper robustness. |
| **`node-cron` inside the backend** | Directly contradicts the free-tier-sleep constraint in the assignment. External cron only. |
| **Background Worker on Render** | Better architecture, but the free tier and the assignment's cron-job.org guidance both point at a web service. |
| **Direct browser → Supabase writes** | Bypasses validation, exposes the service-role key, and breaks the single-write-path that keeps history honest. All writes go through the backend. |

---

## 12. Constraints checklist

- [x] **Free tiers only** — Vercel, Render, Supabase, cron-job.org, Playwright OSS
- [x] **Frontend on Vercel**, **backend on Render**, **data on Supabase** — as required
- [x] **External cron** for scheduled scrapes, no always-on loop
- [x] **Scrape only** `https://demo.inelabteamdev.com` — enforced via `SCRAPE_BASE_URL`
- [x] **Playwright/Puppeteer** used only where JavaScript rendering is genuinely required
- [x] Secrets in platform env vars; service-role key server-side only
