# REQUIREMENTS — INE Store Price Tracker

**Source:** `Software_Engineer_Intern_Assignment[1].pdf`
**Target site:** https://demo.inelabteamdev.com/ (INE's mock store — scrape this only)
**Hard deadline:** Sunday, **27 September 2026, 11:59 PM IST**
**Submission form:** https://forms.gle/6LGyJV9yi6W1gna18

---

## 1. What this is

A small full-stack web app where a user searches INE's mock store, picks a product **and one of its
options**, and the app then scrapes that product's current **price** and **stock** every **2 hours**.
The user sees the price/stock history as a chart and a table, sees a per-product log of every scrape
attempt, and can export the whole history as CSV.

**The interface is not the point.** The assignment states the scraping is "the heart of this
assignment" and that what matters is the scraper "keeps working correctly over many unattended runs."
Effort allocation should reflect that: ~80% scraper robustness, ~20% UI.

### 1.1 The four required capabilities

| # | Capability |
|---|---|
| 1 | Search for and pick a product by **partial or full** product name |
| 2 | Track it, so the app scrapes current price and stock on a fixed schedule |
| 3 | View price and stock history over time as a **chart or table** |
| 4 | See a **per-product scrape log** of each attempt and its outcome |

---

## 2. Reverse-engineering findings (these define the build)

Everything below was verified by probing the live site. **Do not skip this section — it is the
reason the scraper is written the way it is.**

### 2.1 The store is a client-rendered SPA

`GET /` returns only a shell:

```html
<div id="root"></div>
<script type="module" src="/assets/index-GaW5Fnef.js"></script>
```

There is **no product markup in the HTML**. A naive `fetch` + Cheerio parse returns nothing.

### 2.2 There is a JSON API underneath

Found by reading the SPA bundle:

| Endpoint | Purpose | Verified response |
|---|---|---|
| `GET /api/v2/listings?page=&limit=` | Catalog, paginated | `{"page":1,"perPage":2,"totalPages":480,"count":960,"results":[{id,slug,name,brand,category,sku,description}]}` |
| `GET /api/v2/items/{id}` | Product detail | `{id,slug,name,brand,category,sku,description,specs{…},reviews[…],optionAxis,options[{id,label}]}` |
| `GET /api/v2/ui/manifest` | Layout/selector contract | see below |

- **960 products, 48 pages** at `limit=20`.
- Product page route is **`/item/{id}`** with a **numeric** id (router path is `/item/:id`).
  This is the "store's product ID (as shown in the product page URL)" the CSV must export.
- `/api/v2/items/{id}` contains **no price and no stock**. Price is fetched separately, at runtime,
  through a guarded flow (2.3).
- Example: item `2022` = "Junova Capture Card One", `optionAxis: "Edition"`, options
  `o1 Standard`, `o2 Special Edition`, `o3 Pro Bundle`. **Price is per-option.**

### 2.3 Price is hover-gated, signed, and encrypted — a browser is mandatory

The bundle's price flow (`Dr`) does all of the following:

1. `GET /api/v2/ui/manifest` → layout contract + random class names.
2. Builds a **signature** from a *hover snapshot*: `{hoverAt, dwellMs, moves, clickAt, trusted}`.
   - `moves` must contain **≥ 8 distinct mousemove coordinates** (`minMoves: 8`)
   - dwell must be **≥ 600 ms** from first move (`minDwellMs: 600`)
   - the snapshot records **`trusted`** (i.e. `event.isTrusted`) — synthetic `dispatchEvent` fails
   - moves are throttled: a move is only recorded if **≥ 40 ms** since the last recorded move
     (buffer holds the last 40 moves)
3. `POST` manifest + computed signature + `itemId` + `optionId` with a signature header.
   - `429` → rate limited, must be treated as retryable
   - non-2xx → fatal error
4. Response returns a **`pass`** token.
5. `GET` a follow-up resource with that `pass`; the payload is **wrapped/encrypted** (`wr(json, pass)`)
   and only decryptable with the token.

**Conclusion: the price cannot be obtained by plain HTTP.** It requires a real browser producing
**trusted** input events with correct timing. `page.hover()` is not enough — we must dispatch a
sequence of ≥ 8 real mouse moves, spaced ≥ 40 ms apart, then hold ≥ 600 ms.

The UI itself exposes up to **6 attempts** (`jr = 6`) with phases `loading` → `retrying` → `failed`.

### 2.4 The manifest — selectors are randomized, so never hardcode them

`GET /api/v2/ui/manifest` (a live sample):

```json
{
  "revision": 633001,
  "variant": 1,
  "validUntil": 1790408618627,
  "classes": {
    "priceWrap": "qzb-x1", "priceValue": "fgy-x1", "mrp": "rwq-x1",
    "sale": "myt-x1", "badge": "ewn-x1", "rating": "kof-x1",
    "seller": "jal-x1", "delivery": "vpm-x1", "stock": "hdq-x1"
  },
  "order": ["stock", "seller", "delivery", "rating"],
  "priceTag": "data",
  "priceCarrier": "text",
  "ratingAria": true,
  "sellerTitle": true
}
```

Implications:

- Class names are **generated per revision** and will differ from the sample above at runtime.
  `revision` is a layout version → use it for change detection (§5.6).
- `priceTag: "data"` means the price element may be a `<data>` tag, not a `<span>`
  (code is `priceTag ?? 'span'`). Select by **tag + class**, not tag alone.
- `priceCarrier: "split"` means the price is rendered **one `<span>` per character**, separated by
  a non-ASCII char (`Mr`, with `\xA0` also used). A `split` carrier requires reading the
  container's `textContent` and stripping non-numeric characters.
- `order` declares the panel's layout sequence — useful as a sanity check that we read the panel
  we think we are reading.

### 2.5 Decoys — the main correctness trap

The product page renders **multiple price-like numbers**. Only one is real.

| Element | Real or decoy | How to tell |
|---|---|---|
| `<TAG class="{random v<n>} {classes.priceValue}">` | ✅ **REAL** | Carries the manifest's `priceValue` class |
| `<span class="price-value" aria-hidden="true" style="display:none">` | ❌ **DECOY** | `price-value` is a *stable, non-obfuscated* class — so a naive scraper grabs this |
| second decoy (real price **+7**, jittered) | ❌ **DECOY** | also hidden / `aria-hidden` |
| `classes.mrp` | ❌ struck-through original | different manifest class |
| `classes.sale` ("Member price …") | ❌ | different manifest class |
| `<canvas>` watermark drawing `INE store — price … 1 42.9` | ❌ decoy | not in DOM, but poisons screenshots/OCR |

The two decoys are computed as `fmt(jitter(shown))` and `fmt(jitter(shown + 7))`.

**Rule: match on the manifest's `priceValue` class, then discard any candidate that is
`aria-hidden="true"` or not visibly rendered. Never select by `.price-value`.**

### 2.6 Price and stock formats rotate

**Price** is rendered through a formatter with 5 variants selected at runtime:

| Variant | Output shape |
|---|---|
| default | `₹12,345` via `Intl.NumberFormat('en-IN', currency, maxFractionDigits: 0)` |
| `spaced` | commas → spaces |
| `euro` | commas → dots, `,00` appended |
| `trailing` | `12,345/- (incl. of all taxes)` |
| `unicode` | non-ASCII digit substitution |

**Stock** rotates through 5 templates based on `stock % 5`:

1. `N units available`
2. `Last few: N`
3. `Available (N)`
4. `Stock: N remaining`
5. `Ready to ship — N available`

and when `stock === 0` it renders `Sold out` in a `.avail-no` pill.

**Rule: normalize by stripping everything except digits, `.` and `,`; extract stock with a single
`\d+` match; map `Sold out` → `0`.** Never regex-match a specific template.

### 2.7 The store has no search — we must build it

The SPA's catalog is a bare 48-page pager with **no search input**, and the API **ignores**
`?q=`, `?search=` and `?name=` (results come back randomized, `count` unchanged at 960).

**Requirement: our backend builds the search.** Paginate `/api/v2/listings`, cache the index, and
filter on `name` (case-insensitive substring) to satisfy "partial or full product name".

### 2.8 Other noise

- The card "Open item" button is a no-op ~35% of the time and delayed 900ms ~50% of the time.
  Do **not** drive the UI through that button — navigate directly to `/item/{id}`.
- Responses are sometimes slow (observed 27ms–240ms) and occasionally error. Retries are mandatory.

---

## 3. Data model (Supabase / PostgreSQL)

Three tables. The split between `price_history` and `scrape_attempts` is deliberate: history holds
**only verified values**, the log holds **every attempt including failures**.

### 3.1 `tracked_products`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` pk | `gen_random_uuid()` |
| `store_product_id` | `integer` | numeric id from `/item/{id}` URL — **exported in CSV** |
| `product_name` | `text` | |
| `brand` | `text` | |
| `category` | `text` | |
| `sku` | `text` | |
| `option_axis` | `text` | e.g. `Edition` |
| `option_id` | `text` | e.g. `o2` |
| `option_label` | `text` | e.g. `Special Edition` — **exported in CSV** |
| `source_url` | `text` | `https://demo.inelabteamdev.com/item/2022` |
| `active` | `boolean` | default `true`; paused products are skipped by the cron |
| `created_at` | `timestamptz` | default `now()` |

Unique constraint on `(store_product_id, option_id)`.

### 3.2 `price_history`

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` pk | |
| `tracked_product_id` | `uuid` fk → `tracked_products(id)` on delete cascade | |
| `price` | `numeric(12,2)` | **NULL never allowed on write** — only verified values |
| `currency` | `text` | e.g. `INR` |
| `stock` | `integer` | `0` is valid and meaningful |
| `scraped_at` | `timestamptz` | ISO-8601 UTC |

Index on `(tracked_product_id, scraped_at desc)`.

### 3.3 `scrape_attempts`

One row per attempt. **Failures are recorded here with NULL price/stock — never hidden, never deleted.**

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` pk | |
| `tracked_product_id` | `uuid` fk → `tracked_products(id)` on delete cascade | |
| `attempted_at` | `timestamptz` | ISO-8601 UTC — **exported in CSV** |
| `outcome` | `text` | check in (`success`, `retried`, `failed`) — **exported in CSV** |
| `attempt_number` | `integer` | 1-based, within the run |
| `price` | `numeric(12,2)` | NULL on failure |
| `stock` | `integer` | NULL on failure |
| `http_status` | `integer` | nullable |
| `error_code` | `text` | e.g. `hover_timeout`, `parse_failed`, `http_429`, `http_5xx`, `nav_error`, `layout_changed` |
| `error_message` | `text` | nullable |
| `duration_ms` | `integer` | |
| `manifest_revision` | `integer` | layout revision in force during the attempt |

### 3.4 Outcome semantics (must match the CSV exactly)

- `success` — a price **and** stock were extracted and validated.
- `retried` — this attempt failed, but the run continued and a later attempt succeeded.
  The final failing attempt of a run that never recovers is `failed`, not `retried`.
- `failed` — the run exhausted its attempts (or hit a fatal error) without a valid extraction.

A `retried` row still has NULL `price`/`stock` — only the eventual `success` row carries values.

---

## 4. CSV export

A single **Export** button on the dashboard downloads the **full scrape history** as `.csv`,
**one row per scrape attempt**, with exactly these columns in this order:

```
store_product_id,product_name,option_label,scraped_at,price,stock,outcome
```

| Column | Source | Rule |
|---|---|---|
| `store_product_id` | `tracked_products.store_product_id` | id as shown in the product page URL |
| `product_name` | `tracked_products.product_name` | |
| `option_label` | `tracked_products.option_label` | the **selected** option |
| `scraped_at` | `scrape_attempts.attempted_at` | **ISO 8601, UTC** (e.g. `2026-09-26T14:05:11.000Z`) |
| `price` | `scrape_attempts.price` | **empty on failure** |
| `stock` | `scrape_attempts.stock` | **empty on failure** |
| `outcome` | `scrape_attempts.outcome` | `success` / `retried` / `failed` |

Rules:

- **Failed attempts must be included**, with `price` and `stock` left empty.
- Header row included.
- RFC 4180 quoting; `Content-Type: text/csv; charset=utf-8` with `Content-Disposition: attachment`.
- Covers **all** tracked products and **all** time, not just the filtered product.

---

## 5. Scraper specification (the core deliverable)

Runs server-side, triggered externally. Chromium via Playwright.

### 5.1 Hybrid strategy — the judgment call

| Target | Method | Reason |
|---|---|---|
| Catalog search | **native `fetch`** + JSON | The listings endpoint is plain JSON; a browser would be wasteful |
| Layout contract | **native `fetch`** for `/api/v2/ui/manifest` | JSON, trivially cheap |
| Price + stock | **Playwright Chromium** | Genuinely requires it: empty HTML shell (§2.1), hover gate with trusted events (§2.3), signed + encrypted payload (§2.3) |

A browser is used **only** where it is genuinely required. This is a graded criterion
("a sensible choice between lightweight fetching and a headless browser") and is the core of the
design note.

### 5.2 Per-attempt procedure

For each active `tracked_products` row:

1. **Fetch the manifest** (native `fetch`, short timeout). Cache it; on `revision` change, refresh
   selectors and emit a `layout_changed` observation (§5.6).
2. **Launch/navigate** Chromium to `https://demo.inelabteamdev.com/item/{store_product_id}?option={option_id}`
   (or set the option via the UI control — whichever the page exposes; do not assume a query param
   works, verify it).
3. **Wait for the offer panel**, which renders in one of: `idle` (locked), `loading`, `retrying`,
   `failed`. Wait for the *resolved* state, not just for load.
4. **Satisfy the interaction gate** (§2.3) — this is the step naive scrapers get wrong:
   - Locate the price/offer panel element (via `classes.priceWrap`).
   - Dispatch **≥ 8 distinct real mouse moves** inside it, spaced **≥ 40 ms** apart.
     Use Playwright's `mouse.move()` (CDP-dispatched → `isTrusted === true`).
     8 moves at 60 ms spacing ≈ 480 ms, then wait out the remainder of the 600 ms dwell.
   - Verify the gate actually opened (panel no longer `offer-locked`, price node present).
     If it did not, treat as `hover_timeout` and retry — do not read a locked panel.
5. **Select the price** using the **manifest class only**, then filter out `aria-hidden="true"`
   and non-rendered nodes (§2.5). Read `textContent` of the container so `priceCarrier: "split"`
   works; strip all characters except digits, `.` and `,`.
6. **Select stock** via `classes.stock`, extract with `\d+`, map `Sold out` → `0`.
7. **Validate** before writing: price parses to a finite number in a sane range; stock is a
   non-negative integer; the option label on the page matches the tracked option. If validation
   fails → `parse_failed`, **write nothing to `price_history`**.
8. **Write atomically**: insert the `scrape_attempts` row, and on `success` also insert the
   `price_history` row, in a single transaction. Record `manifest_revision` and `duration_ms`.

### 5.3 Retry policy

- **Max 6 attempts per product per run** (mirrors the store's own `jr = 6`).
- **Exponential backoff with jitter**: base 2 s → `min(2 * 2^(n-1) + rand(0,1000), 30 s)`.
  Jitter matters — the 2-hourly cron plus the store's own 429 handling means thundering-herd
  retries make rate limiting worse.
- **Retryable**: navigation timeout, `429`, `5xx`, network errors, `hover_timeout`,
  `parse_failed`, lock-panel-not-released.
- **Honour `Retry-After`** on `429` when present (clamp to 60 s so a run cannot hang).
- **Fatal, no retry**: product id `404` (product removed from the store), or a genuine
  authentication/authorization rejection.
- Between attempts, **reset page state** (fresh navigation or fresh context) — do not assume a
  half-loaded panel can be recovered in place.

### 5.4 Honest failure handling (graded: "Honest History and Logging")

- **Never write a price or stock value that was not fully extracted and validated.** A missing
  value is stored as NULL, never `0`, never a guess, never a carry-forward of the previous value.
- **Never silently stop.** Every attempt produces a `scrape_attempts` row. A product that fails
  all 6 attempts produces 6 rows and a final `failed`.
- **A run that dies mid-way still logs what it did.** Persist each attempt as it completes rather
  than buffering to the end, and wrap the whole run in `try/finally` so the browser context and any
  scrape mutex are always released.
- **One product's failure must not abort the others.** Iterate with per-product error isolation.
- **Concurrent-run protection**: a DB-backed lock (or advisory lock) so a manual "Run now" and the
  2-hourly cron cannot scrape simultaneously and produce interleaved/duplicated attempts.

### 5.5 Scheduling (free-tier constraint)

Render's free tier sleeps, so **no in-process interval or `node-cron` loop**.

```
cron-job.org  ──every 2h──▶  POST https://<backend>.onrender.com/api/scrape/run
                                        │  header: X-Cron-Secret: $CRON_SECRET
                                        ▼
                              scrape all active tracked_products
                                        ▼
                              write price_history + scrape_attempts
```

- `GET /health` used to keep the instance warm if needed.
- The endpoint is **not** a long-running job: scrape a bounded set of products and return. If a run
  risks exceeding Render's request timeout, return `202` with a run id and let the frontend poll
  `GET /api/scrape/runs/:id`.
- Manual **Run now** button reuses the same endpoint with the same secret.

### 5.6 Change detection (bonus criterion)

`manifest.revision` is persisted on every attempt. When it differs from the last known revision:

- log an observation (DB row / structured log) — do **not** crash
- discard cached selectors and re-read the manifest
- extract using the new classes
- surface it in the scrape log so a grader can see the scraper recovered from a layout change

Hardcoded selectors anywhere in the extraction path are a defect, because they are guaranteed to
break on the next revision.

---

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | uptime + last successful scrape; hit by cron-job.org to keep warm |
| `GET` | `/api/products/search?q=` | search the store by partial/full name (§2.7) |
| `GET` | `/api/products` | list tracked products with latest price/stock |
| `POST` | `/api/products` | track a product + option |
| `DELETE` | `/api/products/:id` | stop tracking (cascades history + attempts) |
| `GET` | `/api/products/:id/history` | price/stock series for the chart + table |
| `GET` | `/api/products/:id/attempts` | scrape log, newest first |
| `GET` | `/api/attempts.csv` | **Export** — full history, §4 |
| `POST` | `/api/scrape/run` | run the scraper now; `X-Cron-Secret` required |
| `GET` | `/api/scrape/runs/:id` | status of an async run |

All bodies validated with Zod. Search input is length-capped and the catalog fetch is
concurrency-limited.

---

## 7. Acceptance criteria

Mapped to the assignment's four evaluation criteria. Each is a concrete pass/fail test.

### 7.1 Scraping Reliability *(highest weight)*

- [ ] Given a normal run, every active product produces ≥ 1 `scrape_attempts` row.
- [ ] Given repeated 2-hourly runs over ≥ 24h, no run ends silently; success rate is visible.
- [ ] Given an induced `5xx`/timeout, the attempt is retried with backoff and the retried attempt
      is logged as `retried`.
- [ ] Given sustained `429`, `Retry-After` is honoured and no attempt is dropped.
- [ ] `price_history` never contains a NULL, zero-valued, or unvalidated price.

### 7.2 Correctness under Difficulty

- [ ] Extracted price equals the price shown on the product page for the **selected option** —
      verified by opening `/item/{id}` in a headed browser and comparing.
- [ ] Extracted stock matches, including the `Sold out` → `0` case.
- [ ] The **decoy** prices (§2.5) are never captured.
- [ ] Works when the manifest's class names, `priceTag`, or `priceCarrier` differ from the sampled
      values — proven by re-running after a revision change.
- [ ] On failure, `price` and `stock` are empty/NULL, never stale or invented.

### 7.3 Honest History and Logging

- [ ] The scrape log lists **every** attempt with timestamp and outcome.
- [ ] The CSV contains failed attempts with empty price/stock.
- [ ] `retried` and `failed` are distinguishable, and neither is ever hidden.
- [ ] Timestamp format in the CSV is ISO 8601 UTC.

### 7.4 Judgment

- [ ] Native `fetch` used where JSON is available; browser used only for the hover-gated price (§5.1).
- [ ] No in-process scheduler; external cron only.
- [ ] The design note explains this trade-off in writing.

### 7.5 Deployment

- [ ] Frontend live on Vercel, backend on Render, data on Supabase.
- [ ] The public Vercel URL reaches the live data end to end.
- [ ] All secrets are in platform env vars; the service-role key is server-side only.

### 7.6 Submission gates

- [ ] **≥ 2–3 products tracked** on the live dashboard at submission time.
- [ ] Price history and scrape log reflect **real unattended runs** (not backfilled by hand).
- [ ] Public GitHub repo with all source.
- [ ] 2–4 minute screen recording of a **headed** run, including slow/failing response handling.

---

## 8. Headed (observable) mode

The grader must be able to *watch* the scraper.

- `HEADLESS=0` (default `1` in production) → visible Chromium window.
- Run locally via `npm run scrape:headed`; also selectable in the dashboard for local dev.
- The headed run must make the interaction gate (§2.3) **visible on camera**: real mouse moves
  across the price panel, the dwell, the panel unlocking, then the price appearing.
- The recording must include **one slow or failing response** and show the retry + logging.
- Slow it down deliberately if needed (`slowMo`) so the behaviour is legible in 2–4 minutes.
- Surface the live attempt state in the UI (loading / retrying *n*/6 / failed) so the recording
  shows the state machine, not just a closed browser.

---

## 9. Deliverables checklist

| # | Deliverable | Status |
|---|---|---|
| 1 | Link to the hosted, live site (Vercel) | ☐ |
| 2 | Public GitHub repository URL with all source | ☐ |
| 3 | 2–4 min screen recording of a **headed** run incl. slow/failing response | ☐ |
| 4 | **README** — setup, scrape schedule, env vars | ☐ |
| 5 | **Design note** — how scraping was made reliable, trade-offs, **what the AI tools got wrong first and how it was corrected** | ☐ |
| 6 | PDF resume | ☐ |
| 7 | Submit via https://forms.gle/6LGyJV9yi6W1gna18 | ☐ |

**Deadline: 27 Sep 2026, 23:59 IST.**

### 9.1 Prioritisation given the deadline

Because the deadline is tight, build in this order:

1. **P0 — the scraper working reliably** (5.1–5.4). Without this nothing else matters.
2. **P0 — data honesty** (`price_history` never wrong; all attempts logged; CSV correct).
3. **P0 — deployment** (Render + Supabase + Vercel reachable).
4. **P0 — 2–3 products tracked with real unattended history** (needs ≥ 2 cron cycles, so start
   the cron early even before the UI is finished).
5. **P1 — dashboard** (search, track, history chart+table, scrape log, Export button).
6. **P1 — headed mode + screen recording** (needs a free slot to record).
7. **P2 — README, design note, resume.**
8. **P3 — bonus items** (§10).

> **Practical warning:** requirement 4 needs real elapsed wall-clock time. Turning on the cron
> early is the single highest-leverage scheduling decision here.

---

## 10. Out of scope / bonus backlog

Explicitly permitted extras, in descending value-per-hour:

- [ ] **Change detection** that flags when the store's page structure changes (§5.6) — largely
      covered already; surfacing it in the UI is the remainder.
- [ ] **Configurable scrape frequency per product** (cron sweeps due products).
- [ ] **Scrape multiple options of one product in a single run**.
- [ ] **Multi-product dashboard** with extra product info (brand, category, SKU, rating, delivery).
- [ ] **Price-drop / back-in-stock alerts**, in-app and/or email via SendGrid.
- [ ] **CI/CD with GitHub Actions** (lint + test + migrate on push).

### 10.1 Hard constraints

- **Free tiers only** (Vercel, Render, Supabase, cron-job.org).
- **Scrape only** `https://demo.inelabteamdev.com`. Do not scrape real retailers or any third party.
- Be a polite client: concurrency-limited, backoff on `429`, identifiable user agent, no hammering.
