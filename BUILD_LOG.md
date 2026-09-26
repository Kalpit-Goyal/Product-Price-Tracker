# BUILD LOG — INE Price Tracker

**What this document is.** A running study of *how* this scraper was built: what I tried, what broke,
why it broke, and what I changed as a result. Every failure below is a real one that actually
happened, with the evidence that exposed it.

**Ground rules I held myself to**
- **Never hardcode a selector.** Resolve everything from `/api/v2/ui/manifest` at runtime, and treat
  a `revision` change as a first-class event.
- **"Extraction succeeded" must be proven, not assumed.** The store serves decoy prices, so a
  plausible-looking number can be wrong. Validate before write.
- **A failure is a logged failure, never a guess.** No `price_history` row without a validated
  observation. An empty result and a wrong result are not the same thing, and only one of them is
  recoverable later.
- **Prefer a verified effect over a delivered input.** "I sent 14 mouse moves" is a claim about my
  own code; "the button left the disabled state" is a claim about the page. Only the second is worth
  anything.

---

## Phase 0 — Reconnaissance (read before writing anything)

**WHAT.** Before writing scraper code I read the target: fetched the SPA shell, the manifest, the
catalog and item endpoints, and then pulled down the page's JavaScript bundle and searched it for the
offer panel's logic.

**WHY THIS ORDER.** The assignment's difficulty is deliberately hidden behind a UI, and the single
most likely way to fail is to build on assumptions. Reading the bundle first converts most of the
guesswork into reading, and — critically — told me which parts genuinely *need* a browser.

### What the target actually is

| Finding | Consequence for the design |
|---|---|
| The page ships an **empty SPA shell** (`<div id="root"></div>`) — no prices in the HTML | Prices can only come from a runtime fetch, so "just parse the HTML" is not an option |
| Prices are served by **`/api/v2/quotes`** with a signed, encrypted envelope | Native `fetch` cannot produce the signature → a real browser is **mandatory** for price |
| The catalog (`/api/v2/listings`) and item detail (`/api/v2/items/{id}`) are **plain public JSON** | These do **not** need a browser → cheaper and more robust with native `fetch` |
| The offer panel is **click-gated**: moves + dwell + a click are required before the CTA enables | A naive `page.$('.price')` returns nothing, forever, with no error |
| `isTrusted` is part of the gate signature | Synthetic `dispatchEvent` is rejected → must drive real input via CDP |
| Responses can be `429` | Retryable, and `Retry-After` must be honoured |
| Selectors are **randomized per `manifest.revision`** | Hardcoding `.priceValue` breaks; resolve from the manifest at runtime |
| **Two hidden decoy prices** under a *stable* `.price-value` class, plus MRP, member price and a canvas watermark | A naive scraper silently records **wrong prices** — the worst possible failure |
| The store has **no search**; `?q=` / `?search=` / `?name=` are ignored (results randomize, `count` stays 960) | We must build our own search over the paginated catalog |

**DECISION — the hybrid strategy (a graded criterion).** Use native `fetch` for the two JSON
endpoints (cheap, no browser needed) and Playwright **only** for `/item/{id}` price/stock, where the
signed/encrypted, click-gated fetch makes a browser genuinely mandatory. This is the assignment's
explicit "only where the page genuinely requires it" case, and the reasoning is written down so it can
be defended in the design note.

**TWO DECISIONS THAT SHAPED EVERYTHING LATER:**
- Never hardcode a selector → resolve from the manifest, and treat a `revision` change as a
  first-class event.
- "Extraction succeeded" must be **proven**, not assumed → the decoys mean a plausible-looking number
  can be wrong. Validation before write is not optional.

---

## Phase 1 — Scaffold

**WHAT.** Directory layout, `package.json` (ESM, no TypeScript), env validation with Zod, a
structured logger.

**WHY.** Plain JavaScript per the project decision. Zod earns its place here because the risk in this
project is *untrusted runtime data* — scraped prices — where a compile-time type would check nothing.
A runtime schema that rejects `"₹ 1,2,4,,5"` is worth more than a type that compiles.

**RESULT.** Layout created; no failures.

---

## Phase 2 — The critical proof (can Playwright beat the hover gate?)

Everything in Phase 0 was still inference. Before writing an app around it, I wrote a throwaway
probe (`backend/scripts/probe.mjs`) that drives a real Chromium against the live store and prints
what it observes. **WHY this order:** if the hover gate turns out to be unbeatable, the whole
approach changes and I need to know that in the first ten minutes, not after building a UI.

### Failure 1 — manifest fetch blocked by CORS

**WHAT.** First probe run called the manifest from *inside* the page:
```js
await page.evaluate(async (b) => (await fetch(`${b}/api/v2/ui/manifest`)).json(), BASE);
```

**RESULT — FAILED.**
```
Access to fetch at '.../api/v2/ui/manifest' from origin 'null' has been blocked by CORS policy
PROBE ERROR: page.evaluate: TypeError: Failed to fetch
```

**WHY IT FAILED.** At that moment the page was still `about:blank`, whose origin serialises to the
string `null`. A `null` origin sends no matching `Access-Control-Allow-Origin`, and the API sends no
CORS header at all, so the browser refused the request. It was never a network problem.

**WHAT I TRIED NEXT.** Moved the manifest read out of the browser entirely and into **Node's**
`fetch`. Node's `fetch` is not subject to CORS — there is no origin to negotiate — so the same
request now succeeds from a bare script.

**LESSON (and why the design already said this).** The manifest is plain JSON and needs no DOM, so
it should never have been fetched through a browser. Doing it in Node is not just a workaround for
the CORS error, it is the cheaper and more correct design: the browser is reserved for the one
target that genuinely needs it. *This was a case of the reconnaissance pointing at the right
answer and my first implementation ignoring it.*

### Failure 2 — the hover gate alone is not enough (the important one)

**WHAT.** With the manifest read fixed, I moved the mouse across the offer panel: 12 real
`page.mouse.move()` calls in a circle, 60 ms apart, then dwelled out to 806 ms total. That
comfortably exceeds the `minMoves: 8` / `minDwellMs: 600` / 40 ms throttle thresholds read from the
bundle.

**RESULT — FAILED.** The panel came back **still locked**, and the manifest-driven extractor found
zero price nodes:
```
className: "offer-panel offer-locked qzb-x1"
priceText: null
allPriceNodes: []
```

**WHY IT FAILED.** Two clues in the output, both of which I initially misread:

1. The panel's sub-message **changed** from
   `"Hover over the price area to load the current price."`
   to `"Check the current price and availability."`
   So the gate *had* opened — moves and dwell were accepted. But the panel class was still
   `offer-locked`.
2. The panel HTML contained a control I had filtered out of my dump because my regex only matched
   `/price|amount|offer|stock|avail/` and its class was `ctl ctl-main`:
   ```html
   <button type="button" class="ctl ctl-main" aria-label="Check today's price" disabled>…</button>
   ```

Re-reading the bundle explains it — the signature I found in Phase 0 was:
```js
snapshot(e){ return { hoverAt, dwellMs, moves, clickAt: t, trusted: e } }
```
There is a **`clickAt`** field sitting right next to `hoverAt` and `moves`. The hover sequence does
not fetch anything; it exists to **unlock the button**, and the *click* is what triggers the signed
request. The button was `disabled` before the interaction and enabled after it.

**WHAT I TRIED NEXT.** Added an explicit `btn.click()` after the dwell, and logged
`isDisabled()` before clicking so the state transition is observable.

**RESULT — SUCCESS.** Panel became `offer-panel offer-ready`, and the price appeared.

**LESSON.** I had implemented the interaction I had *read about* rather than the interaction the
page *exposes*. The `minMoves`/`minDwellMs` numbers in the bundle describe the lock, not the fetch.
Reading code tells you what must be true; only driving the page tells you what must be *done*.
This is also the single most likely thing an AI tool gets wrong here, because the natural
implementation ("hover the element, then read it") is confidently plausible and silently returns
nothing.

### The payoff — proof that the decoys are a real trap

The successful run returned this DOM. I have annotated every value:

| Rendered | Node | What it is |
|---|---|---|
| **₹13,241** | `<span class="price-value" aria-hidden="true" style="display:none">` | ❌ **DECOY 1** — and note its class is the *stable, human-readable* `.price-value` |
| **₹15,191** | `<span class="amount" aria-hidden="true" style="display:none">` | ❌ **DECOY 2** — also a stable class name |
| ₹18,335 | `<… class="rwq-x1">` | MRP / struck-through original (manifest `mrp`) |
| **₹14,668** | `<DATA class="v3 fgy-x1">` | ✅ **REAL** — matched *only* via manifest `classes.priceValue` (`fgy-x1`), and rendered as a `<data>` tag per `priceTag: "data"` |
| `Sold out` | `<span class="avail-pill avail-no">` | stock = **0** |

So the obvious implementation — `page.$('.price-value')` — returns **₹13,241**, a confidently
wrong answer, ~10% off, with no error and no way to notice. The correct answer required the
manifest class *and* rejecting `aria-hidden="true"` / `display:none`. Both decoys are hidden, both
carry plausible-looking stable class names, and one is only ~10% off — "close enough to look right"
is exactly the failure mode the assignment calls *Correctness under Difficulty*.

I also captured two free wins from the page's own copy: it renders `Loaded in 1 attempt`, and the
CTA becomes `Check again`. I can log the store's own attempt count rather than guessing, and a
`Check again` label is a reliable "already succeeded" signal on a retry.

### Option selection (probe #2)

The assignment requires tracking a *specific* option, and price is per-option. Rather than guess at
a query parameter, I dumped the real control:
```html
<div class="opt-picker" role="group" aria-label="Edition">
  <span class="opt-axis">Edition</span>
  <button class="opt-chip opt-chip-on" aria-pressed="true">Standard</button>
  <button class="opt-chip"             aria-pressed="false">Special Edition</button>
  <button class="opt-chip"             aria-pressed="false">Pro Bundle</button>
</div>
```
This is **not** obfuscated and does not change per `manifest.revision`, so I select by
`aria-label === optionAxis` + chip text `=== optionLabel`, and verify `aria-pressed="true"` before
trusting the price. Cross-checked against the API's `options: [{id:"o1",label:"Standard"},…]`.

### Decisions locked in after the proof

1. **Playwright is justified, and now I can prove it rather than assert it.** The browser is needed
   for exactly one thing — a trusted-input, click-gated, signed, encrypted fetch — and is used for
   nothing else.
2. **Selection is a two-step interaction, and both steps are mandatory:** move ≥8 times (≥40 ms
   apart) → dwell ≥600 ms → *then click*. Encapsulated in one function so no caller can skip a step.
3. **Extraction must be manifest-driven and visibility-filtered**, and it must assert it found
   exactly one visible candidate. Two visible candidates is a layout change, not a coin flip.
4. **Validate before write.** A price that fails validation produces a logged failure and no
   `price_history` row — never a guess.
5. **I can compare against the decoys as a self-check.** Since the decoys are
   `d1 = jitter(shown)` and `d2 = jitter(shown+7)`, a value that matches a hidden node is almost
   certainly a mis-extraction. Cheap insurance against a silent regression.

---
---

## Phase 3 — Making the interaction reliable (the hard engineering)

Phase 2 proved the gate *could* be beaten. It did not prove it could be beaten **repeatedly**, which
is what a scheduled job actually needs. So I stopped adding features and ran the same interaction
many times, treating every intermittent failure as a bug to explain rather than noise to average out.

### Failure 3 — `SLOWMO_MS=0` rejected by my own schema

**WHAT.** Wanted a run with no artificial delay. `config.js` validated it with `z.coerce.number().positive()`.

**RESULT — FAILED.** Validation error at startup: `SLOWMO_MS must be a positive number`.

**WHY.** `0` is not positive, but it is a perfectly legitimate value meaning "no slow motion" — and it
is the *default*. The validation was wrong, not the input. Changed to `.nonnegative()`.

**LESSON.** A validator is a claim about what a value can be. Writing `positive` for something whose
legitimate minimum is zero is a claim I had not actually checked, and it broke the default path.

### Failure 4 — `count()` does not wait, so I would have recorded the WRONG option's price

**WHAT.** Select the option chip, then read its price.

**RESULT — FAILED intermittently**, with a *plausible but wrong* price rather than an error.

**WHY.** I tested for the chip's existence with `chip.count()`. `count()` does **not** auto-wait. On a
cold page React had not rendered the picker yet, so `count()` returned `0`, my code took the "option
not found → use the page default" branch, and I read the default option's price and labelled it with
the requested option. No error, no exception, a confidently wrong row in the database.

**WHAT I TRIED NEXT.** `waitFor({ state: 'visible' })`, which does auto-wait.

**LESSON — the most dangerous class of bug in this project.** Every other failure returns null and
gets logged. This one returned a *valid-looking wrong answer*. It is exactly the "correctness under
difficulty" failure the assignment cares about, and it was caused by a one-word API difference
(`count` vs `waitFor`). Where a wrong answer is possible, the absence of an error proves nothing.

### Failure 5 — Playwright's "stable element" check fights a page that re-renders

**WHAT.** Click the option chip and the CTA.

**RESULT — FAILED** with `locator.click: Timeout 8000ms exceeded` / element is not stable.

**WHY.** Selecting an option re-renders the card: the chip's box changes size and the panel can
re-lock. Playwright waits for the element to stop moving for two consecutive animation frames before
clicking, so it can time out on an element that is perfectly clickable *right now*.

**WHAT I TRIED NEXT.** An outcome-verified click: try the normal click, then a forced click, then
`dispatchEvent` as a last resort — and after each one **check that the thing we wanted actually
happened** (`aria-pressed="true"` for a chip). Crucially I stopped trusting "Playwright said it
clicked" and started checking the observable effect.

### The click method A/B test that explained the whole failure

Rather than guess which click method to trust, I ran all of them against the same gated page
(`scripts/diag-clickmethod.mjs`):

| Method | Result |
|---|---|
| `locator.click()` (normal) | **Timeout** — the stability check from Failure 5 |
| `locator.click({ force: true })` | settled, `offer-ready` |
| hover onto button, then `mouse.down/up` | settled, `offer-ready` |
| `mouse.move` + `down`/`up` (no hover) | **not settled** |
| raw CDP `Input.dispatchMouseEvent` | settled, `offer-ready` |

**CONCLUSION.** A plain `locator.click()` is the *least* reliable method here, and forcing is not a
hack around correctness — it is the correct choice for a live-re-rendering page. `reliableClick` now
tries normal first (cheap when it works) and falls back to forced, verifying the outcome either way.

### Failure 6 — "I sent 14 moves" is not the same claim as "the gate is open"

**WHAT.** Fire a fixed 14 moves at 70 ms intervals, dwell, click, wait.

**RESULT — FAILED intermittently.** Sometimes the panel never reached `offer-ready`.

**WHY.** Two independent reasons, and I had conflated them:

1. **Coalescing.** The store records a move only if it is ≥40 ms since the last recorded one. Of 9
   dispatched moves only 8 registered. So "I dispatched N" ≠ "N were recorded".
2. **A start-up race.** An identical script failed on the *first* interaction of one run and the
   *second* of the next. A deterministic logic error cannot do that, so something non-deterministic
   was involved — most likely Chromium still warming up, with the page's own effect that installs the
   move/dwell tracker not yet run when my first moves land.

**WHAT I TRIED NEXT.** Stop guessing at N and **verify the gate's actual observable effect**: fire a
burst, then poll whether the CTA has left the `disabled` state; if not, re-fire the burst. Up to 3
bursts per cycle, and up to 3 full cycles, each re-measuring the panel box. `MIN_MOVES` also went
8 → 14 to absorb coalescing.

**RESULT.** 8/8 clean runs on a single option. The multi-option path still showed a residual
per-attempt failure rate of ~10–20%, which Failure 7 and the retry policy then absorb.

**LESSON.** *A fixed count is a bet; a verified effect is a check.* This is the "never silently stop"
requirement in concrete form, and it generalises: prefer asserting the observable outcome over
asserting that the input was delivered.

### Failure 7 — a *transient* DOM state was treated as a fatal error

**WHAT.** The multi-option verifier failed on one option with `panel_not_found: offer panel never
became visible`, then passed on the next run.

**WHY.** `panelBox()` **threw** as soon as the panel was missing. But changing an option makes React
unmount and re-mount the offer card. If we happened to look during that window, the entire
interaction was abandoned — even though the panel came back a moment later. The condition was
transient; my handling made it permanent.

**WHAT I TRIED NEXT.** `panelBox()` now returns `null` and the gate-cycle loop treats absence as a
retryable state (`lastState = 'panel_absent'`), waiting for the re-mount and continuing. It only
escalates to an error once all cycles are exhausted. The terminal error now reports the *specific*
reason — `panel_not_found` vs `interaction_gate_never_opened` vs `panel_never_settled` — because
those three need three different fixes and one generic code hides that.

**LESSON.** Retry the *cause* at the layer where it occurs rather than letting it abort the whole
operation, and keep error codes specific enough to be actionable.

### Failure 8 — my own price parser could not read a price the store actually rendered

**WHAT.** A batch run failed with:
```
price_unparseable  could not parse price from "Rs. 14,668.00"
```

**WHY.** A genuinely embarrassing bug, and invisible without a corpus. My parser kept every
`[0-9.,]` character and then removed separators. The full stop in the currency prefix **`Rs.`** was
kept, so the input became `.14,668.00` → `NaN`. The price itself was fine; I corrupted it myself.

I then discovered a second, subtler version of the same mistake in my *own reasoning*: I had
believed the `split` carrier rendered as `"₹ 1 4 , 6 6 8"`. I had actually only seen console output
of an invisible-character string and **assumed spaces**. Dumping the exact code points
(`scripts/diag-formats.mjs`) showed the filler is `U+200B` ZERO WIDTH SPACE, and a later run captured
it verbatim as `"₹\u200b1\u200b0\u200b,\u200b9\u200b8\u200b8"`. My "spaced" guess happened to parse to
the right number for the wrong reason — I had been lucky, not correct.

**WHAT I TRIED NEXT.** Rewrote `parsePrice` to work by *structure* rather than by matching the
template I happened to see, and built the test suite from a **corpus of strings captured from the
live store**:

| Format (all observed live) | Example | Result |
|---|---|---|
| default `Intl` en-IN | `₹11,590` | 11590 |
| Indian lakh grouping | `₹1,00,309` | 100309 |
| trailing tax note | `₹11,590/- (incl. of all taxes)` | 11590 |
| spaced variant | `₹7 701` | 7701 |
| euro variant | `₹12.345,00` | 12345 |
| currency-prefixed variant | `Rs. 14,668.00` | 14668 |
| unicode (fullwidth digits) | `₹１２,９８１` | 12981 |
| split carrier (U+200B fillers) | `₹\u200b1\u200b0\u200b,\u200b9\u200b8\u200b8` | 10988 |

The rewrite: fold exotic digits to ASCII → take the **longest digit/separator run** (this is what
kills the `Rs.` bug, because the prefix's `.` no longer glues onto the number) → drop spaces → strip a
trailing pure-zero fraction → remove remaining thousands separators. Step 4 is safe only because the
store's prices are whole rupees; if it ever renders a real fraction, that step simply will not match.

**RESULT.** 24/24 unit tests pass, and a live batch then read **18/18 options** with every rotation
above parsing correctly.

**LESSON.** Two lessons, both about evidence:
1. A parser validated against **invented** examples passes the tests and fails in production. Every
   literal in the test file is a string I captured from the live store.
2. *I was the unreliable component here.* I twice filled an evidence gap with a plausible assumption
   (that invisible characters were spaces). The fix was to dump code points rather than look harder
   at a rendering.

### The honesty check the store accidentally provided

One run surfaced `price_not_found ... (panel="offer-panel offer-failed")` — the store's own
six-attempt failure path. The scraper reported a **logged failure with no `price_history` row**
instead of inventing a value. That is precisely the required behaviour, arrived at by accident, and
it is worth keeping a regression test for.

### A false-positive I removed from my own test harness

The verifier concluded:
```
monotonically non-decreasing across tiers: YES — option demonstrably affects price
```
…using `[].every(...)` on an **empty** result array, which is `true` in JavaScript. With every option
having failed, the harness would have cheerfully reported that it had *proven* options affect price.
It now requires at least two readings and prints `INCONCLUSIVE` otherwise. **A test that can pass by
failing is worse than no test**, because it converts a failure into false confidence.

### Failure 9 — my reliability test was measuring the wrong thing

**WHAT.** Ran `node scripts/scrape.js --ad-hoc 2022` eight times to measure the success rate.

**RESULT — "failed" 7/8 times**, every one with `panel_not_found`.

**WHY IT FAILED.** My own typo: the CLI takes `--product=2022`, not a positional argument. The
unparsed extra argument left `productArg` null, `Number(null)` is `0`, `0` passed the
`Number.isInteger` check, and the script happily scraped product `0` — which does not exist.

**WHAT I TRIED NEXT.** Tightened the guard to reject IDs `< 1`, then re-ran correctly: **8/8
success**.

**LESSON.** The most confusing failure in this phase was caused by the thinnest possible validation
gap. A check that accepts `0` as a product id is worse than no check, because it converts a typo into
a plausible-looking run against the wrong target.

### The measured result

Once the harness applied the same retry policy as production (`SCRAPE_MAX_ATTEMPTS`), rather than a
single attempt per option:

| Path | Result |
|---|---|
| Single option, 8 consecutive runs | **8/8** |
| Three options × 6 runs, per-attempt | ~78–89% |
| Three options × 6 runs, **with production retries** | **18/18 options read, 6/6 runs valid** |
| Unit tests | **31/31** |

Per-attempt success is not 100%, and I am not going to pretend otherwise by raising the retry count
until the number looks good. The honest position: the store's quote endpoint stalls transiently, a
single attempt is genuinely unreliable, and the retry policy — not a smarter click sequence — is what
makes the scheduled job dependable.

### A finding that changed how I read my own tests: the store jitters price per load

The same option, `Standard` on product `2022`, returned **₹7,701 / ₹8,625 / ₹8,682 / ₹9,746 / ₹10,988**
across different runs. Stock moved 76 → 113 → 8. One run even produced `Standard 8682` and
`Special Edition 8625`.

**WHY IT MATTERS.** My option verifier concluded
`monotonically non-decreasing across tiers: YES — option demonstrably affects price` from a *single*
run. Then a later run came back non-monotonic and it printed
`NO — tiers look arbitrary` with equal confidence. **Both verdicts were unfounded.** A single run
cannot establish tier ordering when the underlying value is re-rolled on every page load.

This is the same failure mode as the empty-array false positive earlier in this phase, in the opposite
direction: I had built a harness that produced a confident answer to a question the data could not
answer, and it happened to be right for a while.

**WHAT I CHANGED.** The harness no longer prints a tier-ordering verdict. It reports only what one
run *can* establish — that every option chip is selectable, that `aria-pressed` confirms the
selection, and whether the options produced distinct prices — and says so plainly when the evidence
is thin. Tier ordering would need many within-run samples, reported as a frequency.

**THE REAL LESSON, and the one I care about most.** Two of the worst defects in this project were
*test-harness* defects, not scraper defects: an empty array that "proved" a claim, and a single
sample that "disproved" another. Both produced confident prose and no evidence. A verifier that can
reach a verdict regardless of what happened is worse than no verifier, because it launders noise into
findings. The scraper's honesty guarantees are only as good as the harness reporting on it.

**CONSEQUENCE FOR THE DATA MODEL.** Because the value is re-rolled per load, `price_history` must
record *what was actually observed, with the timestamp it was observed*, and must never be presented
as a stable "the" price. Any UI that draws a price line is showing a series of independent
observations, not a tracking a fixed quantity — and the API should make that distinction visible
rather than smoothing it away.

---

## Phase 4 — Making the data layer trustworthy

With the scraper reliable, I turned on the tracked-products path — the one that actually writes to a
database. Every bug in this phase is one that would have been **invisible in local testing**, which
is why they are worth writing down at length.

### Failure 10 — two field-naming conventions that agreed on paper and disagreed in practice

**WHAT.** The scraper reads `product.storeProductId`. Postgres columns are `store_product_id`.

**RESULT — FAILED**, in a way that depended on which store was in use:

- `upsertTrackedProduct()` wrote **camelCase** keys into the memory store but **snake_case** into
  Supabase.
- `findTrackedProduct()` searched for `store_product_id`. Against the **memory** store, whose rows
  were camelCase, it therefore **never matched an existing product**, so re-tracking the same
  product+option silently created a duplicate row — defeating the unique constraint that exists in
  Postgres but not in the dev store.
- `listTrackedProducts()` returned camelCase in one mode and snake_case in the other, so
  `product.storeProductId` was `undefined` in memory mode and the scraper built the URL
  `/item/undefined`.

**WHY IT MATTERS SO MUCH.** The development path was the one that *worked*. The bug would have
appeared only after deploying against real Supabase — i.e. after the code was "done".

**WHAT I CHANGED.** One explicit conversion boundary in both directions (`rowToProduct` / `toRow`),
so every read returns the canonical camelCase shape and the memory store holds that same shape. It
is now impossible for the two modes to drift, and there is a test that asserts the memory rows use
`storeProductId` and *not* `store_product_id`, so a regression fails loudly.

### Failure 11 — a logged success that was never stored

**WHAT.** On success the orchestrator called `recordAttempt()` and then `recordSuccess()` — two
independent inserts.

**WHY IT FAILED.** If the attempt insert succeeded and the history insert then failed, the run
returned `outcome: 'success'` and the log said the price was recorded while the database had no
history row. Worse, the error handler only *logged* that failure and then returned success anyway:

```js
} catch (err) {
  logger.error({ event: 'history_write_failed', ... });
}
return { outcome: 'success', price: payload.price, stock: payload.stock };   // reported anyway
```

**WHAT I CHANGED.**
1. A `record_success(...)` Postgres function (migration `002`) writes the attempt row **and** the
   history row in one transaction, so either both exist or neither does.
2. A persistence failure now returns `failed` with `db_write_failed`. The price was observed but not
   stored, and the run says exactly that.
3. The orchestrator no longer double-writes: the success path makes **one** call, because the old
   two-call sequence would have logged every success twice once the RPC also wrote the attempt row.
4. The memory store mirrors the RPC. It briefly did not — it wrote the history row and no attempt
   row — which would have meant "every attempt is recorded" held against Supabase and not in
   development. A test now pins both halves.

**LESSON.** An error handler that logs and then returns the success value is worse than no handler:
it converts a loud failure into a quiet lie. When a side effect fails, the return value has to
change.

### Failure 12 — a dev store that could not carry data between the tools that needed it

**WHAT.** `MEMORY_DB=1` kept products, attempts and history in a JS `Map` inside the running process.

**RESULT.** `node scripts/seed.js --product=2022` reported success, and then
`node scripts/scrape.js` — a *different process* — found an empty store and logged
`no active tracked products`. The documented workflow silently did nothing.

**WHY.** Seeding, scraping and serving the API are three separate commands. An in-process store is
invisible to the other two.

**WHAT I CHANGED.** In non-production the store is persisted to `.data/memory-db.json` and reloaded
on start. Production still refuses it outright, and Supabase remains the only store that counts. The
startup warning was also corrected: it claimed data "will not survive a restart", which had become
false.

**LESSON.** A development affordance has to work across the *whole* workflow, not just inside one
command. This failed silently, which is the only way it could have gone unnoticed.

### The invariant, demonstrated rather than asserted

Run three times against the seeded product, the store contains exactly one attempt row and one
history row per successful run — no double-write, and no history row without a matching attempt:

```
run 1 -> history 1, attempts 1
run 2 -> history 2, attempts 2
run 3 -> history 3, attempts 3
```

and a failed attempt produces an attempt row with `price = NULL, stock = NULL` and **no** history
row. Both are now covered by tests, so they cannot quietly regress.

| Check | Result |
|---|---|
| Unit tests (parse, retry policy, DB mapping) | **42/42** |
| Live ad-hoc scrape, 8 consecutive runs | **8/8** |
| Live options × 6 runs with production retries | **18/18 options read** |
| Seed → scrape → persisted rows, end to end | **1 history + 1 attempt per success** |
| Price formats observed live and parsed | **8/8** |

---

## Phase 5 — The catalog lies by omission

Wiring the API to the store surfaced the worst class of bug in this project: one that
produces no error at all.

### Failure 13 — `ReferenceError: page is not defined`

**SYMPTOM.** `GET /api/products/search?q=capture` returned HTTP 500.

**ROOT CAUSE.** The enumeration loop declared `for (let p = 2; p <= total; p++)` but the body
read `page.results`. Every page after the first threw a `ReferenceError`, which the per-page
`catch` treated as a transient network fault: it logged "retrying catalog page", retried,
threw the identical `ReferenceError` again, logged "given up", and continued. All 47
remaining pages were dropped and the index was reported as successfully built.

**WHY IT WAS INVISIBLE.** A `catch` written for network failure will swallow *any* thrown
value, including a coding error. The only symptom was a short index, and the shortfall was
logged rather than returned, so the caller had no way to know.

**WHAT I CHANGED.** Extracted `fetchPageInto(byId, pageNumber)` so the page number is an
explicit parameter, and `getCatalogDetailed()` now returns `{ items, coverage, complete }`
instead of a bare array. Callers are told what fraction of the store the index actually
covers, so an incomplete index can never again masquerade as a complete one.

**LESSON.** Retry logic must account for what it caught. A `catch` that cannot distinguish
"the network hiccupped" from "this code is wrong" will convert the second into a quiet,
plausible-looking data shortage.

### Failure 14 — the catalog is a random sampler, not a list

Fixing the `ReferenceError` immediately exposed the real problem, and it was worse.

**MEASURED.** With all 48 pages read successfully and no throttling at all, merging them
produced **611 of the advertised 960 products** — 63.6% coverage. Repeated ids appeared
across pages.

**ROOT CAUSE.** `GET /api/v2/listings?page=N` is not a stable slice of the catalog. The store
samples randomly, so pages overlap and paging to `totalPages` re-reads the same products over
and over. Paging to the last page therefore *looks* complete and is not. The API's own
`count: 960` is the only reliable size signal, and nothing in the response says the pages
overlap.

**WHY IT MATTERS MORE THAN A CRASH.** A crash is a bug someone reports. This is worse: the
index silently lacked products, so a user searching for a real product was told it did not
exist. Searching "capture" returned **4** results when **12** exist.

**WHAT I CHANGED.** Enumeration is now a saturation problem rather than a pagination
problem. It keeps sweeping and deduplicating by id until the advertised count is reached or
until two consecutive sweeps stop finding anything new, and it always reports the coverage it
achieved. It also handles the throttling the store applies to bulk reads (below).

**LESSON.** "Read to the end of the pagination" is only correct if pagination is stable.
Verify that assumption against the real endpoint before relying on it; the response's own
`count` is the only thing that can tell you it is false.

### Failure 15 — the store throttles, and says so in the body

**SYMPTOM.** A first live sweep dropped 17 of 48 pages to HTTP 503, indexing 47.6% of the
catalog. A burst of requests was refused with HTTP 429 and the body
`{"error":"rate_limited","scope":"general","retryAfter":1}`.

**ROOT CAUSE.** Two problems. First, a plain single retry with no backoff just earns another
refusal. Second — and this is the one worth remembering — the delay was in the **JSON body**,
not in a `retry-after` **header**. A header-only reader ignores the server's actual
instruction and falls back to blind guessing.

**WHAT I CHANGED.** `fetchStoreJson()` now backs off exponentially with jitter, prefers the
`retry-after` header when present and falls back to the body's `retryAfter`, and is shared by
both the listing and product-detail calls. Jitter is not decoration: every client on the same
2-hourly schedule would otherwise retry in lockstep and keep the throttling alive.

I also found the store silently caps page size at 60 (`limit=120` returns `perPage: 60`), so
asking for 20 had tripled the request count for the same data — 48 requests instead of 16.
Fewer, larger pages is simply cheaper against a rate limiter.

**LESSON.** When a service tells you to slow down, read how it told you. A `Retry-After` in a
JSON body is easy to miss because it looks like ordinary response data.

### Failure 16 — a store 429 surfaced to the user as HTTP 500

**SYMPTOM.** The smoke test caught `POST /api/products` (the "track this product" button)
returning `500 {"error":"internal_error","message":"product_http_429"}`.

**ROOT CAUSE.** Two separate defects stacked. `getProductDetail` had no throttle handling at
all, unlike the catalog — so the first refusal from the store became an exception. Then the
central error handler had no notion of an upstream failure, so it defaulted to 500.

**WHY 500 IS THE WRONG ANSWER.** A 500 says "this server is broken". The truth is "the store is
busy, try again shortly". That difference matters operationally: a 500 invites a retry storm
and pages a human, while a 503 with `Retry-After` is handled automatically.

**WHAT I CHANGED.** `getProductDetail` shares the throttle-aware fetch, and the error handler
now maps upstream conditions to honest statuses: `product_not_found` → 404, a throttled store →
503 `store_rate_limited`, an upstream 5xx → 503 `store_unavailable`. The domain mapping matters
for the same reason: a route can only return 404 for a missing product if the lookup *returns*
null, and a lookup that *throws* on 404 falls through to a blanket 500 — making a product that
does not exist indistinguishable from a broken server.

**LESSON.** An error handler with only a 500 branch will, eventually, report every upstream
condition as its own fault. The status code is part of the contract; pick it deliberately.

### Failure 17 — the API had no automated end-to-end check

**SYMPTOM.** Failures 13, 15 and 16 were each found by hand, one route at a time, and each took
a manual reproduction to confirm.

**WHAT I CHANGED.** `npm run smoke` boots the real Express app on an ephemeral port and checks
29 assertions across every documented route: status codes, response shapes, count fields that
actually match their arrays, cron-secret enforcement, and the CSV content type.

Writing it immediately paid for itself. It also caught two of its own bugs, which is the point
worth recording:

- The test client omitted `content-type: application/json`, so `express.json()` correctly
  ignored the body and every validation error came back as `expected number, received nan` for
  a value that had been sent perfectly. Read as a server bug; it was a client bug. The comment
  explaining it is in the file so the next person does not repeat it.
- The test asserted `GET /api/products/:id`, a route that does not exist. Checking
  `REQUIREMENTS.md` confirmed it was never required — the list endpoint carries everything the
  dashboard needs. Inventing a requirement in a test is how suites start lying.

**LESSON.** A test that cannot fail for the right reason is worse than no test. When a
hand-written check disagreed with the code, the code was right twice and the check was wrong
twice — so every assertion here is pinned to the documented contract.

### Testing the tests

Green tests prove nothing on their own, so each fix was verified by reverting it and confirming
the suite notices:

| Mutation | Expected | Actual |
|---|---|---|
| `MAX_SWEEPS` 6 → 1 (single sweep) | fail | `keeps sweeping until a shuffled store converges` fails |
| `PAGE_ATTEMPTS` 5 → 1 (no retry) | fail | `absorbs a transient 429 inside a single sweep` fails |
| Remove `last_scraped_at` update | fail | `a success moves the product last_scraped_at forward` fails |
| Remove delete cascade | fail | `deleting a product cascades to its history and attempts` fails |

The 429 test initially passed with the retry deleted. The reason is instructive: with the
retry gone, the *resweep* re-fetched the throttled page and topped the index up anyway, so an
item-count-only assertion could not tell the two mechanisms apart. The test now asserts the
sweep count as well — a transient 429 must be absorbed in place, not paid for with another 16
requests. That distinction is the difference between a free retry and a silent 6x cost.

A second test passed for the wrong reason: its fake store used a stride that happened to visit
every id in one pass, so it went green against the very bug it was written to catch. The fake
now samples randomly from a seeded RNG, matching the real store.

### Parity fixes between the two stores

Memory mode is a development stand-in, and it had quietly drifted from Supabase in ways that
would have made local results misleading:

| Behaviour | Memory mode was | Now |
|---|---|---|
| `last_scraped_at` on success | never updated | mirrors the RPC's `coalesce(p_scraped_at, now())` |
| Delete a product | left orphan history + attempts | cascades, matching `ON DELETE CASCADE` |
| Health `successes` | — | counts all rows, not the single newest |
| Health `successes` (Supabase path) | read `.count` off a `limit: 1` query, so always ≤ 1 | separate `count: 'exact', head: true` query |
| `seed.js` startup warning | claimed data "is lost on exit", false since Failure 12's fix | prints the real path and the real limitations |

**KNOWN LIMIT.** The Supabase health fix is verified by reading the query, not by execution —
there are no credentials for a real project in this environment. It is called out here rather
than presented as tested.

### Verification after Phase 5

| Check | Result |
|---|---|
| Unit tests (parse, retry, DB mapping, catalog) | **53/53** |
| API smoke test, all documented routes | **29/29** |
| Catalog coverage, live, after saturation fix | **956 of 960 (99.6%)** |
| Search results for "capture", before → after | **4 → 12** |
| Live options × 6 runs with production retries | **18/18 options read** |

---

## Phase 6 - verification found what the tests could not

Phase 5 ended with three green gates and a working-looking dashboard. It was not finished.
Everything below was found by *running* the thing rather than by reading it, and three of
these would have shipped as silent failures.

### Failure 18 - the first search took 76 seconds and would have 504'd in production

**SYMPTOM.** The browser UI check timed out waiting for search results. Not a crash, not an
empty list - a wait.

**MEASURED.** A cold process, then two identical searches:

| Request | Time | Result |
|---|---|---|
| 1st (cold) | **76.1s** | 12 results, 99.8% coverage |
| 2nd (warm) | **0.0s** | 12 results |

**WHY THIS IS A BUG AND NOT A SLOW FEATURE.** Vercel and Render both terminate a proxied
request long before 76 seconds. Deployed, the first search after every cold start, every
redeploy and every wake-from-sleep would simply have failed. It would have looked like a
broken dashboard, and nothing in the code would have said why.

**ROOT CAUSE.** The catalog index was correct and cached, but nothing ever filled it. It was
built lazily, by whoever happened to make the first request - so the cost landed on a user.

**FIX.** `warmCatalog()` / `startCatalogWarmer()` in `backend/src/services/catalog.js`,
called from three places: on boot, on an 8-minute interval (below the 10-minute TTL, so the
cache cannot go stale under a user), and from the `/api/health` probe. The health hook is the
interesting one: a cheap uptime ping is also the first request a sleeping host receives, so
it is the earliest moment we can tell the process restarted and the index is gone. It kicks a
non-blocking refill, and health never waits on it.

`/api/health` now also reports `catalogWarm`, so the dashboard can explain a slow search
instead of showing an unexplained spinner.

**TESTS.** Two added, and mutation-checked - neutering `warmCatalog` so it stops building
anything makes the suite go red, so the test is not passing for free:
- a cold cache reports cold, `warmCatalog` returns before the build finishes, and the cache
  really is warm a moment later
- a failing store leaves the cache cold instead of crashing the process, because the warm-up
  runs from boot

### Failure 19 - the knob that makes a recording watchable is the knob that breaks the scraper

**SYMPTOM.** Headed runs started failing every attempt with `interaction_gate_never_opened`,
having passed 18/18 in headless mode minutes earlier.

**ROOT CAUSE.** `--slowmo=250`. The hover gate needs ~14 moves at ~40ms spacing plus a dwell.
`slowMo` delays *every* Playwright action, so 250ms between moves starves the gate. Nothing
in the code was wrong; the recording setting was fighting the interaction.

**MEASURED**, headed, all three options of one product:

| `SLOWMO_MS` | Result |
|---|---|
| 0 | 3/3 |
| 60 | 3/3 |
| 120 | 3/3 |
| 250 | **0/3** |

**FIX.** Documented at the top of `backend/scripts/scrape.js` and pinned in
`npm run demo:headed` (`--slowmo=60`). The trap is worth recording because the instinct on
camera day is to raise slowMo, and raising it is exactly what breaks the run.

### Failure 20 - the dashboard offered a button that could only ever return 401

**SYMPTOM.** `/api/health` advertised `allowManualRun`, the UI rendered a "run now" button,
and clicking it sent no secret.

**ROOT CAUSE.** The flag and the endpoint had been written at different times and never met.
The button was decorative.

**FIX.** `POST /api/scrape/run` now permits a secret-less call under exactly the condition the
health route advertises: `NODE_ENV !== 'production' && ALLOW_DEV_TRIGGER === '1'`. In
production that expression is unsatisfiable, so the bypass is dead code and the secret is
always required. Verified in all three states rather than assumed:

| `NODE_ENV` | `ALLOW_DEV_TRIGGER` | `health.allowManualRun` | POST, no secret |
|---|---|---|---|
| development | unset | `false` | 401 |
| development | `1` | `true` | **202** |
| production | `1` | `false` | **401** |

The smoke test now asserts the flag and the endpoint together, because that is the pair that
drifted.

### Failure 21 - three bugs that only exist in the verification tool

Worth listing because all three cost real time, and all three were silent.

**`node:fs` vs `node:fs/promises`.** `verify-ui.mjs` used the callback `readFile`/`stat` with
`await`. Node does not throw for a missing callback in an async function's try block - it
returns `HTTP 500` for every request, and the tool reported "static server not ready". The
stack trace named the line immediately; the first fix attempt did not, because the tool was
swallowing the error. **Lesson applied: a verification tool must never fail silently, or it
becomes the thing that wastes the time it exists to save.**

**IPv4 vs IPv6.** `vite preview` binds `localhost`, which resolves to `::1` on Windows. The
probe used `127.0.0.1`. A healthy server, 25 failed retries, and no output - because the probe
only printed on success, so total failure looked identical to a hang. Fixed at the root: the
tool now spawns its own backend and static server, tries both loopback families, prints *why*
it gave up, and tears everything down in a `finally`. An earlier run of this tool also left a
13-hour-old orphan `node src/index_test.js` behind, which is what the teardown now prevents.

**A regression I introduced myself.** While adding the fault injector I wrote
`"demo:failure": "cross-env DEMO_FAULT=gate node scripts/scrape.js"`. `cross-env` is not a
dependency of this project, and `FOO=bar node x.js` does not work in cmd.exe or PowerShell
either - so the script was broken in the exact environment it was written for. Replaced with a
`--demo-fault=<kind>` flag, which is the only form that behaves identically everywhere.

Also fixed while checking the run API against the UI: the run notice rendered `Run undefined`,
because the API returns `runId` and the component read `run.id`. The adjacent
`attempted`/`succeeded`/`failed` fields were correct, and the runbook's first draft
documented the wrong shape - caught by reading the handler rather than trusting the draft.

### Why a browser check exists at all

55 unit tests and 35 API smoke checks were green while the dashboard could have been blank.
Those gates prove the routes answer. They cannot prove the React app *uses* the answers: a
wrong field name, a payload shape the chart cannot plot, or a component crash all produce a
perfectly healthy API and an empty page. Both real frontend bugs found so far
(`latestPrice` guessed as `lastPrice`, a `history` array assumed where the API returns
`{ count, history }`) were invisible to every API-level check.

So `backend/scripts/verify-ui.mjs` launches real Chromium against a real backend and asserts
on rendered text, including `never "undefined"` checks and a browser-network assertion for
4xx responses that fail quietly into an empty list.

### Verification after Phase 6

| Check | Result |
|---|---|
| Unit tests | **55/55** |
| API smoke test, all documented routes | **35/35** |
| Browser UI, real Chromium, real store | **21/21** |
| Frontend production build | **665ms**, 162KB / 52KB gzipped |
| Cold search | **86s in the background, 0.0s to the user** |
| Catalog coverage, live | **956-958 of 960** |
| Headed run, `slowmo=60` | **3/3 options** |
| Demo fault: fail, retry, recover | failed attempt stored `retried` with NULL price, then 1 history row |

**KNOWN LIMIT.** No Supabase project exists in this environment, so the SQL migrations, the
`record_success()` RPC and the RLS policies are verified by reading and by the memory-mode
parity tests only. The production run remains unexecuted. This is called out rather than
presented as tested.
