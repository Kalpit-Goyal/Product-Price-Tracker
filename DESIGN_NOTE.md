# Design Note

Why the system is built this way, and what the first drafts got wrong.

Companion to [`README.md`](README.md) (how to run it) and
[`BUILD_LOG.md`](BUILD_LOG.md) (what broke and when).

---

## The single idea

Most of this code exists to prevent one specific failure: **reporting a price the
system never actually observed.**

The store jitters prices on every load, serves a randomized sample of products
rather than a full listing, hides decoy price nodes, and only reveals the real
price after a hover interaction. Every one of those is a way to produce a
plausible, confident, wrong number. So the design rule is:

> A value reaches the database only if it was read from a node that passed every
> check. If any check fails, the attempt is stored with no value at all.

`NULL` is a real, load-bearing value here. It is not a gap in the schema, it is
the honest answer to "this attempt did not get a price."

---

## The parts that matter

### Selector provenance

Selectors are fetched from `/api/v2/ui/manifest` immediately before every attempt,
with a hard fail if that fetch fails.

The tempting optimisation is to fetch the manifest once at startup. It would be
faster and it would be wrong: the store can revise its markup, and a cached
manifest means a class-name rotation turns into a silent `null` on every product
forever. The store is the authority on its own DOM, so the store is asked every
time. A 10s timeout on that fetch turns a rotation into a loud, retried failure.

### Refusing decoy nodes

The store renders more than one node with a price-ish class. Only one is the real
value. The extraction is a manifest walker that keeps only nodes a human could
read, and it rejects on:

- zero dimensions
- hidden or zero-opacity nodes
- computed visibility
- ancestor `overflow: hidden` with the node scrolled out
- `aria-hidden`, or an ancestor `pointer-events: none`
- text that is not a clean currency/number shape

Each rule is a separate committed test. `extract.js` is the highest-risk file in
the repo for exactly this reason, so its tests are the most literal.

### The hover gate

A real pointer path: move to the price node, make many small moves toward it,
pause, then click the CTA. `slowMo` is disabled for the moves and applied only to
the dwell and the click, because `slowMo` delays *every* action and therefore
destroys the very timing the gate is testing.

This is the single most fragile part of the system and it is fragile for a reason
that is not a bug in this code: it is emulating a human on a timer. The gate
budgets 14 moves at 40ms plus dwell. It has to be tuned against the real store, and
`BUILD_LOG.md` Failure 19 is the measurement that stopped me from "improving" it
into uselessness.

### The catalog is a sampler, not a listing

`/listings` is randomized and capped at 60 per page. Three consequences drove the
design:

1. **Pagination is not enumeration.** A 16-page sweep covered 611 of 960 products.
   Pagination produced the *appearance* of completeness and a third of the catalog.
2. **A search miss is not absence.** Not appearing in a random 60-item sample says
   nothing about whether a product exists. Treating it as absence produced wrong
   "product not found" errors on products that were right there.
3. **Coverage must be reported.** So search sweeps until the covered set stops
   growing, and returns `indexCoverage: 957/960` and `indexComplete: false` rather
   than an unqualified list. A caller can now see the difference between "there is
   no such product" and "I have not seen it yet."

The sampler is throttled (250ms between calls, adaptive backoff) because a
respectful client is a requirement, not an optimisation.

### Attempt logging

Every attempt gets a row, success or failure, including the error code and a
`recovered` flag. On recovery the earlier failure is updated to `outcome: 'retried'`
instead of being rewritten as if it had never happened. This is what makes the
attempt log in the dashboard meaningful: you can see the failure and the retry that
saved it, which is the behaviour the recording deliverable is meant to show.

### The two-state manual trigger

`POST /api/scrape/run` accepts a secret-less call only when
`NODE_ENV !== 'production' && ALLOW_DEV_TRIGGER === '1'`. That exact expression is
unsatisfiable in production, so the bypass cannot be reached there. The dashboard
reads `health.allowManualRun` to decide whether to render the button at all, so the
UI cannot offer an action the API will refuse.

The condition is written out in both places rather than shared through a helper
because the failure mode was real: the two drifted, and the dashboard rendered a
"run now" button that could only ever return 401. There is now a smoke check that
asserts the flag and the endpoint agree.

### Local memory mode

A JSON file store with the same interface as the Supabase adapter, so the whole app
runs with no credentials. It is not durable, not concurrent-safe, and not used in
production. It exists so that a reviewer can clone and run in under a minute, which
matters more than the tidiness of having one storage path.

---

## What I got wrong first

Kept here because the failures are more informative than the final code, and
because the process of finding them is the part of the work worth being able to
see.

**The first draft read prices without interacting with the page.** It looked
plausible, scraped fast, and produced numbers. They were the decoy values, always.
Nothing in the output said "I am not sure"; it said a price, confidently. The
failure was not a crash, it was a wrong answer that looked like a right one, which
is the hardest kind to catch by reading the code.

**The first pagination looked complete.** Sixteen pages, no errors, a tidy list. It
covered 611 of 960 products and the loop reported success. I had built the
*appearance* of enumeration. The tell was a coverage number nobody had asked for:
once the sampler was measured, "no errors" and "complete" turned out to be unrelated
statements.

**The first retry policy retried everything.** A missing product got retried as
hard as a throttle. Not dangerous, just wrong in a way that wastes the store's
patience, which is the exact resource the politeness work exists to protect.

**The first history view implied a trend.** It drew a line and the eye supplies
"rising". Against jittered prices, that line is noise rendered as signal. Removing
the trend reading, and showing min/max/spread instead, was the change that made the
chart honest rather than decorative.

**The first dashboard read `run.id`.** The API returns `runId`. The header rendered
"Run undefined" and every API check was green, because the API was correct and the
UI was reading a field that did not exist. This is the clearest example in the repo
of why a real browser is in the loop at all.

**The first self-verification harness hid its own failures.** It swallowed errors and
printed only on success, so a broken tool presented as a passing tool. A verifier
that fails quietly is worse than no verifier, because it converts "I checked" into a
claim you can no longer trust. Every harness here prints progress as it goes,
tears down in a `finally`, and treats "no output" as a failure.

**And the loop repeated in the tooling.** The same IPv4/IPv6 loopback assumption
broke the first browser harness, and then broke a second throwaway script written
long after the fix was already sitting in the first one. The lesson is not about
IPv6. It is that a working pattern in a repo is an asset, and re-deriving
infrastructure from scratch is a way to lose it.

---

## The recurring theme

Nearly every failure above was **confident and quiet**. Not one of them announced
itself. Each was found by measuring the thing against reality and comparing the
result to the claim: coverage against a real count, prices against a second read,
options against the store, UI against a browser, the manifest against a revision
change, a run against a CSV.

The code is written to make claims checkable rather than to look finished. Where
the data does not support a conclusion, the system says so in the response instead
of smoothing it over.
