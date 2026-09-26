# Deployment runbook

Deploy order matters: **Supabase -> Render -> Vercel -> cron.** Each step depends on
the one before it, and the last two need values the earlier steps produce.

Total hands-on time: roughly 30 minutes. Most of it is waiting on builds.

---

## 0. Before you start

You need:

| Thing | Why | Free? |
| --- | --- | --- |
| Supabase project | the database | yes |
| Render account | the API | free tier, **read the warning in step 2** |
| Vercel account | the dashboard | yes |
| cron-job.org account | the 2-hourly schedule | yes |

Generate the cron secret now and keep it somewhere you can copy from twice:

```powershell
# PowerShell, run once. Copy the output; you will paste it into Render and cron-job.org.
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

---

## 1. Supabase

1. Create a project, wait for it to provision.
2. Open **SQL Editor** and run these **in order**:
   - `backend/src/db/migrations/001_init.sql` — tables, indexes, `latest_prices` view.
   - `backend/src/db/migrations/002_success_transaction_and_rls.sql` — the atomic
     `record_success()` function and RLS policies.

   Order is required: `002` replaces `record_attempt`/`record_success` with a single
   transactional function and enables RLS on tables created by `001`.
3. **Settings -> API** -> copy:
   - Project URL -> `SUPABASE_URL`
   - `service_role` key -> `SUPABASE_SERVICE_ROLE_KEY`

> The `service_role` key bypasses RLS. It lives only in Render's environment. It must
> never be committed, and never given a `VITE_` prefix — every `VITE_` variable is
> compiled into the browser bundle.

**Verify before moving on** — paste into the SQL editor and run:

```sql
select count(*) from tracked_products;   -- expect 0, not an error
select proname from pg_proc where proname = 'record_success';  -- expect 1 row
```

If either errors, the migrations did not run in order.

---

## 2. Render (the API)

### The free tier will break the schedule — read this first

Render idles free web services after ~15 minutes of inactivity, and a cold start takes
roughly 50 seconds. This project is driven by a **2-hourly** cron, so the service will
be asleep every single time the cron fires. That produces two failures that look like
scraper bugs but are not:

1. The cold start consumes most of the request budget before scraping begins.
2. The in-memory search index is gone on wake, so the first search pays the ~60-75s
   rebuild.

**You need both of these:**

- Use a **paid** instance type, **or**
- Keep the service awake with a **separate ping every 10 minutes** (step 4b). The
  scrape job at 2 hours is far too sparse to do this job.

A second limit: free plans cap memory at 512MB. One Chromium context fits comfortably.
A full 958-product sweep in a single process does not — the scraper is written to be
resumable so a long sweep can be run in batches rather than one enormous run.

### Deploy

1. Render dashboard -> **New -> Blueprint**.
2. Connect `Kalpit-Goyal/Product-Price-Tracker`.
3. Render reads `render.yaml` and pre-fills everything.
4. Set the three secrets it marks `sync: false`:

   | Key | Value |
   | --- | --- |
   | `SUPABASE_URL` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 |
   | `ALLOWED_ORIGIN` | your Vercel URL, e.g. `https://product-price-tracker.vercel.app` |

   `CRON_SECRET` uses `generateValue: true`, so Render creates it. **Copy it from the
   dashboard now** — you need it in step 4 and Render will not show it again.
5. Deploy. Watch the logs for:

   ```
   INE price tracker API listening on :10000
   catalog cache warm
   ```

   The second line is the background search-index build finishing. It takes about a
   minute. That is expected and it is not blocking the deploy.

### Health check settings

`render.yaml` can only set the health check *path* (it is already `/api/health`). Set
the rest in the dashboard:

- Interval `30s`
- Timeout `10s`
- Failure threshold `3`

A lower failure threshold restarts the service mid-scrape and throws away a run that
was about to succeed.

**Verify:** `curl https://<api>.onrender.com/api/health` should return
`"status":"ok"`. The very first call may take ~50s while the service wakes.

---

## 3. Vercel (the dashboard)

1. Vercel -> **Add New -> Project**, import `Kalpit-Goyal/Product-Price-Tracker`.
2. Set **Root Directory** to `frontend`. This is the step people miss; without it
   Vercel looks for a `package.json` at the repo root and fails.
3. Framework preset: **Vite**. Build `npm run build`, output `dist`.
   (`vercel.json` already carries these, so the preset is mostly cosmetic.)
4. Environment variable:

   ```
   VITE_API_BASE_URL = https://<api>.onrender.com
   ```

   This one **is** public — it is compiled into the bundle, and that is correct. It is
   a URL, not a credential.
5. Deploy, then copy the resulting URL and put it into Render's `ALLOWED_ORIGIN`
   (step 2.4) so the browser is allowed to call the API.

**Verify:** open the Vercel URL. You should see the header, a health strip, and the
tracked-products panel. If the strip says `degraded` or the browser console shows CORS
errors, `ALLOWED_ORIGIN` is wrong — it must match the Vercel origin exactly, scheme
included, with no trailing slash.

---

## 4. Scheduling

### 4a. The 2-hourly scrape

On cron-job.org create a job:

| Field | Value |
| --- | --- |
| URL | `https://<api>.onrender.com/api/scrape/run` |
| Method | `POST` |
| Schedule | every 2 hours |
| Headers | `X-Cron-Secret: <the CRON_SECRET from step 2.4>` |

The endpoint returns `202` with a `runId` and runs asynchronously — a 2-hourly cron
cannot wait on a scrape, so it hands off and returns. Watch progress at:

```
GET /api/scrape/runs/<runId>
  -> { runId, trigger, startedAt, finishedAt, status, attempted, succeeded, failed }
```

`status` is `running` until `finishedAt` is set, then `finished`. The run is
considered failed if `failed > 0`, so alert on that, not on the status string.

`POST /api/scrape/run` rejects a missing or wrong secret with `401`. It is the only way
to start a scrape, which is the point: the browser cannot trigger one.

### 4b. The keep-warm ping (do not skip this on the free tier)

| Field | Value |
| --- | --- |
| URL | `https://<api>.onrender.com/api/health` |
| Method | `GET` |
| Schedule | **every 10 minutes** |

Ten minutes, not two hours — it has to beat the 15-minute idle timeout. This endpoint
is cheap, and it doubles as a self-heal: when it detects the process has restarted it
kicks off a background rebuild of the search index, so the index is ready before
anyone searches. UptimeRobot works too if you prefer it to cron-job.org.

---

## 5. Verify the whole thing

Run these in order. Each one failing tells you which step to go back to.

```powershell
$api = 'https://<api>.onrender.com'

# 1. API alive, index warm. catalogWarm should be true.
curl "$api/api/health"

# 2. Search answers fast and honestly reports coverage.
curl "$api/api/products/search?q=capture"
#    expect: resultCount > 0, indexCoverage near 1, and the response in well under a
#    second. If this takes ~60s the warm-up is not working.

# 3. Track something, then confirm it persisted.
curl -X POST "$api/api/products" -H 'Content-Type: application/json' -d '{
  "storeProductId": 2662, "optionId": "o1", "optionLabel": "Standard"
}'
curl "$api/api/products"

# 4. The cron secret is enforced (this must be 401).
curl -X POST "$api/api/scrape/run"
```

Then wait for one cron cycle and confirm real unattended history exists — a row whose
`trigger` is the cron, not a manual run. That is the deliverable, and nothing else
substitutes for it.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Search hangs ~60s | service woke, index cold | expected on the free tier; add the 10-min keep-warm ping |
| CORS error in the browser | `ALLOWED_ORIGIN` mismatch | must match the Vercel origin exactly, no trailing slash |
| `401` from the cron | header name/value wrong | `X-Cron-Secret`, and it must equal Render's `CRON_SECRET` |
| Scrape run dies after ~50s | cold start consumed the budget | keep-warm ping, or a paid instance |
| Health check restarts mid-scrape | failure threshold too low | raise to 3 |
| Vercel build fails instantly | Root Directory not set to `frontend` | set it in project settings |
| `config_invalid` in the logs | a secret is shorter than the minimum | `CRON_SECRET` needs 16+, service key 20+ |
| `product_http_429` in the attempt log | the store throttled us | working as intended; retries back off automatically |
