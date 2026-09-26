import logger from '../util/logger.js';

/**
 * The interaction gate.
 *
 * The store will not reveal a price until the user has interacted with the offer
 * panel in a specific, measured way. From the store's own bundle:
 *
 *   new Ar({ minMoves: 8, minDwellMs: 600 })   need >=8 moves and >=600ms dwell
 *   var Or = 40, kr = 40                        a move is only recorded if it is
 *                                               >=40ms since the last recorded move
 *   snapshot(e) { ... trusted: e }              the signature includes isTrusted
 *
 * and, discovered the hard way in BUILD_LOG "Failure 2":
 *
 *   snapshot(e) { ... clickAt: t }              a CLICK is also required
 *
 * Four separate reasons a naive implementation returns nothing:
 *  1. `element.hover()` is ONE move, not eight.
 *  2. Moves fired back-to-back with no delay are all but ONE recorded move,
 *     because of the 40ms throttle.
 *  3. Moves + dwell only UNLOCK the button. The click is what triggers the fetch.
 *  4. The CTA is `disabled` until the gate opens, so a click before the gate is a
 *     no-op that returns a still-locked panel.
 *
 * `isTrusted` is the subtle one: dispatching synthetic events from page script
 * (element.dispatchEvent) yields isTrusted === false and is rejected. Playwright's
 * page.mouse / locator.click go through CDP Input.dispatchMouseEvent, which the
 * browser reports as trusted. So we must drive real input, not fake events.
 */

const MIN_MOVES = 14;        // store requires 8; measured ~1 in 10 is lost to
                             // event coalescing, so overshoot generously
const MOVE_GAP_MS = 70;     // store throttles at 40ms; 70ms keeps every move recorded
const MIN_DWELL_MS = 800;   // store requires 600ms; 800ms for margin
const GATE_OPEN_TIMEOUT_MS = 3000; // how long to wait for the CTA to enable
const MOVE_BURSTS = 3;      // re-fire the burst if the gate has not opened yet
const SETTLE_PER_CYCLE_MS = 12000;
const PANEL_VISIBLE_TIMEOUT_MS = 20000;
const GATE_CYCLES = 3;

export class InteractionError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'InteractionError';
    this.code = code;
  }
}

/**
 * A click that trusts the OUTCOME rather than Playwright's actionability heuristics.
 *
 * WHY THIS EXISTS (BUILD_LOG Failure 5). Selecting an option causes two things at
 * once: the selected chip is restyled and RESIZED (observed 86px -> 106px when
 * "Special Edition" became selected), and the offer panel is reset from
 * `offer-ready` back to `offer-locked`. Playwright's `click()` waits for the target
 * to be *stable* — the same bounding box across two animation frames — before it
 * will act. A resize landing mid-check makes a perfectly good click time out, and
 * the store re-renders on a ~250ms interval, so this race is frequent, not rare.
 *
 * The heuristic guards against something we can check directly. So: try the normal
 * click first (it gets scrolling, visibility and hit-testing for free), then fall
 * back to `force: true`, and in every case confirm the effect actually happened.
 * The forced click is still a real, trusted, CDP-dispatched event — we are only
 * giving up on Playwright's guess about whether the element has stopped moving.
 */
async function reliableClick(locator, { timeout = 6000, attempts = 3, verify, describe = 'element' } = {}) {
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    try {
      await locator.click({ timeout });
      if (!verify || (await verify())) return true;
      lastErr = new Error('click registered but the expected state change did not occur');
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  if (lastErr && /Timeout .* exceeded/.test(lastErr.message ?? '')) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      await locator.click({ timeout: 3000, force: true });
      if (!verify || (await verify())) return true;
    } catch (err) {
      lastErr = err;
    }
  }

  throw new InteractionError(
    'click_failed',
    `could not click ${describe}: ${lastErr?.message?.split('\n')[0] ?? 'unknown'}`
  );
}

/**
 * Bounding box of the offer panel, or null if it is not currently on screen.
 *
 * WHY NULL INSTEAD OF A THROW (BUILD_LOG Failure 7). This originally threw
 * `panel_not_found` as soon as the panel was missing. That turned a *transient*
 * condition into a fatal one: changing the option causes React to unmount and
 * re-mount the offer card, and if we happened to look during that window the
 * whole interaction was abandoned even though the panel came back a moment later.
 * Observed live as an intermittent "offer panel never became visible" on the
 * second option of a run, while the same script passed on every other run.
 *
 * So absence is now reported to the caller, which retries it across gate cycles
 * and only escalates to an error once the cycles are exhausted.
 */
async function panelBox(page, panelSelector) {
  const el = page.locator(panelSelector).first();
  try {
    await el.waitFor({ state: 'visible', timeout: PANEL_VISIBLE_TIMEOUT_MS });
  } catch {
    return null;
  }
  const box = await el.boundingBox();
  if (!box || box.width < 5 || box.height < 5) return null;
  return box;
}

/** Coarse state of the panel's little state machine. */
function readPanelState(page, panelSelector) {
  return page
    .evaluate((sel) => {
      const p = document.querySelector(sel);
      if (!p) return 'absent';
      if (p.classList.contains('offer-locked')) return 'locked';
      if (p.classList.contains('offer-ready')) return 'ready';
      if (p.classList.contains('offer-failed')) return 'failed';
      return 'other';
    }, panelSelector)
    .catch(() => 'absent');
}

/**
 * Select the product option, satisfy the interaction gate, click, and wait for a
 * settled panel.
 *
 * The function establishes its own known starting state. The offer panel is a
 * state machine (locked -> loading -> retrying -> ready | failed) and it RE-LOCKS
 * whenever the option changes. If we arrive on a page whose panel is already
 * `offer-ready` — which happens when one page is reused to read several options —
 * the unlock sequence is undefined and the CTA click can land against stale state.
 * So if the panel is not locked on entry we reload first. One extra navigation is a
 * cheap price for a deterministic gate.
 *
 * @param {import('playwright').Page} page
 * @param {{ optionAxis?: string, optionLabel?: string }} option
 * @param {string} panelSelector manifest-derived selector for the offer panel
 * @param {{ slowMo?: number, productUrl?: string }} opts
 */
export async function unlockPrice(page, option, panelSelector, { slowMo = 0, productUrl } = {}) {
  const started = Date.now();

  // ------------------------------------------------- 0. known starting state
  const entryState = await readPanelState(page, panelSelector);
  if (entryState !== 'locked' && entryState !== 'absent' && productUrl) {
    logger.debug(
      { event: 'panel_reset', entryState },
      'panel was not locked on entry — reloading for a clean gate'
    );
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector(panelSelector, { state: 'visible', timeout: PANEL_VISIBLE_TIMEOUT_MS }).catch(() => {});
  }

  // ---------------------------------------------------------------- 1. option
  // The option chips are NOT obfuscated and do not change per manifest revision,
  // so a stable selector is correct here. We verify aria-pressed afterwards rather
  // than assuming the click landed.
  if (option?.optionLabel) {
    try {
      const picker = option.optionAxis
        ? page.locator(`.opt-picker[aria-label="${cssEscape(option.optionAxis)}"]`)
        : page.locator('.opt-picker');

      // BUG FOUND IN TESTING (BUILD_LOG Failure 4): this originally used
      // `chip.count()` to test existence. count() does NOT auto-wait, so on a cold
      // page load React had not rendered the picker yet and count() returned 0 --
      // we then fell back to the page default and would have recorded the WRONG
      // option's price, silently. waitFor() does auto-wait.
      const chip = picker.locator('button.opt-chip', { hasText: exactText(option.optionLabel) }).first();

      let found = true;
      try {
        await chip.waitFor({ state: 'visible', timeout: 6000 });
      } catch {
        found = false;
      }

      if (found) {
        await reliableClick(chip, {
          describe: `option "${option.optionLabel}"`,
          verify: async () => (await chip.getAttribute('aria-pressed')) === 'true',
        });
        logger.debug({ event: 'option_selected', option: option.optionLabel }, 'option selected');
      } else {
        // WHY THIS IS NOW FATAL (BUILD_LOG Failure 4, second half). The previous
        // version logged a warning and continued, on the theory that "the store may
        // have only one option, so the default is already the tracked one". That
        // theory is not safe: a selector mismatch, a changed axis label, or a
        // product whose options were renamed would all take this branch, and the
        // result would be the DEFAULT option's price written to the database under
        // the REQUESTED option's label. No error, no null -- just a confidently
        // wrong history row, which is the one outcome this project must never
        // produce.
        //
        // So the requested option must be positively confirmed. The only safe
        // way to proceed without a matching chip is if the page exposes exactly one
        // option and that option IS the one we were asked for.
        const labels = await page
          .locator('.opt-picker button.opt-chip')
          .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
          .catch(() => []);

        const onlyOptionIsTheRequestedOne =
          labels.length === 1 &&
          labels[0] === String(option.optionLabel).trim();

        if (onlyOptionIsTheRequestedOne) {
          logger.info(
            { event: 'option_single_match', option: option.optionLabel },
            'page exposes exactly one option and it is the requested one'
          );
        } else if (labels.length === 0) {
          // The picker never rendered at all. That is a page timing problem, not a
          // product-data problem, so let the attempt be retried.
          throw new InteractionError(
            'option_picker_absent',
            `option picker never rendered for axis "${option.optionAxis ?? '(unknown)'}"`
          );
        } else {
          // The picker IS there, but the option we were asked for is not one of the
          // options. Retrying cannot help: this is a permanent mismatch between what
          // is tracked and what the product actually sells. Fail immediately and
          // loudly rather than writing another option's price.
          logger.error(
            { event: 'option_not_found', option: option.optionLabel, axis: option.optionAxis, labels },
            'requested option not present on the page — refusing to record another option’s price'
          );
          throw new InteractionError(
            'option_not_found',
            `option "${option.optionLabel}" not found; page offers ${JSON.stringify(labels)}`
          );
        }
      }
    } catch (err) {
      if (err instanceof InteractionError) throw err;
      throw new InteractionError('option_select_failed', err.message);
    }
  }

  // ------------------------------------------- 2-4. gate cycles, self-healing
  //
  // WHY CYCLES (BUILD_LOG Failure 6). A single "moves -> dwell -> click -> wait"
  // pass is not reliable enough on a cold page. Observed live: identical code
  // failed on the FIRST interaction of one run and on the SECOND of the next,
  // which rules out a deterministic logic error and points at a start-up race --
  // Chromium is still warming up and the page's own effect that installs the
  // move/dwell tracker may not have run when our first moves land. Rather than
  // diagnose the exact race we make the sequence self-healing: each cycle
  // re-measures the panel box, fires a fresh burst of moves, and waits a bounded
  // time for the panel to settle. If it does not settle, we run the cycle again.
  // The attempt-level retry in the scraper stays as a backstop.
  //
  // Why this is safe: a cycle that fails to settle leaves the panel locked, and
  // the next cycle re-measures everything. We never extract from an unsettled
  // panel, so a partial or stale state can never be recorded.
  let lastState = 'unknown';
  let dwell = 0;
  let moves = 0;

  for (let cycle = 1; cycle <= GATE_CYCLES; cycle++) {
    // ---- 2. moves + dwell, then VERIFY the gate actually opened
    //
    // WHY VERIFY INSTEAD OF ASSUME (BUILD_LOG Failure 6). The store requires 8
    // recorded moves. Measured live: of 9 dispatched moves only 8 registered, and
    // the CTA enables on the next ~250ms re-render — so "I sent N moves" is not the
    // same claim as "the gate is open", and a fixed N is a bet rather than a
    // guarantee. (It is also not deterministic: an identical script failed on the
    // first interaction of one run and the second of the next, which is why a
    // single cold-start run appeared to work and a batch did not.)
    //
    // So we dispatch a burst, then poll for the observable effect — the CTA leaving
    // the disabled state — and re-fire the burst if it has not happened. This turns
    // an assumption into a check, which is the whole point of the assignment's
    // "never silently stop" requirement.
    const box = await panelBox(page, panelSelector);
    if (!box) {
      // Transient: the panel is mid-remount (typically right after the option
      // chip re-rendered the card). Wait for it to come back and try again on the
      // next cycle rather than abandoning the interaction.
      lastState = 'panel_absent';
      logger.warn(
        { event: 'panel_absent', cycle, of: GATE_CYCLES },
        'offer panel not on screen this cycle — waiting for re-mount'
      );
      await page.waitForTimeout(1000);
      continue;
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Keep the whole path inside the panel so no move is clipped against the
    // viewport edge and every mousemove targets the panel's own handler.
    const rx = Math.max(8, Math.min(box.width / 3, box.width / 2 - 4));
    const ry = Math.max(8, Math.min(box.height / 3, box.height / 2 - 4));

    const button = page.locator('button.ctl.ctl-main').first();
    try {
      await button.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      throw new InteractionError('cta_not_found', 'price CTA never appeared');
    }

    const fireBurst = async () => {
      const burstStart = Date.now();
      for (let i = 0; i < MIN_MOVES; i++) {
        // A circular path guarantees every move is DISTINCT — a repeated coordinate
        // would not advance the store's move counter.
        const angle = (i / MIN_MOVES) * Math.PI * 2;
        await page.mouse.move(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
        await page.waitForTimeout(MOVE_GAP_MS + (slowMo ? Math.random() * slowMo : 0));
      }
      // Dwell is measured from the FIRST move of this burst.
      const elapsed = Date.now() - burstStart;
      if (elapsed < MIN_DWELL_MS) await page.waitForTimeout(MIN_DWELL_MS - elapsed);
      return Date.now() - burstStart;
    };

    let gateOpen = false;
    for (let burst = 1; burst <= MOVE_BURSTS && !gateOpen; burst++) {
      dwell = await fireBurst();
      moves += MIN_MOVES;

      // Poll for the observable effect rather than assuming it.
      const deadline = Date.now() + GATE_OPEN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!(await button.isDisabled().catch(() => true))) {
          gateOpen = true;
          break;
        }
        await page.waitForTimeout(150);
      }

      logger.debug(
        { event: 'gate_burst', burst, of: MOVE_BURSTS, gateOpen, dwellMs: dwell },
        gateOpen ? 'interaction gate is open' : 'gate still closed — re-firing hover burst'
      );
    }

    if (!gateOpen) {
      lastState = 'gate_not_open';
      await page.mouse.move(2, 2);
      await page.waitForTimeout(400);
      continue; // next gate cycle gets a clean, fresh burst
    }

    // ---- 3. the click
    // This is the step whose absence produced a silent, empty result. The hover
    // sequence exists to enable this button; the click is what fetches the price.
    await reliableClick(button, {
      describe: 'the price CTA',
      verify: async () => true, // the settled-state wait below is the real check
    });

    // ---- 4. wait for a settled panel
    // Waiting for a terminal state specifically means we never read a
    // half-rendered panel.
    try {
      await page.waitForFunction(
        (sel) => {
          const p = document.querySelector(sel);
          if (!p) return false;
          return p.classList.contains('offer-ready') || p.classList.contains('offer-failed');
        },
        panelSelector,
        { timeout: SETTLE_PER_CYCLE_MS }
      );
      lastState = 'settled';
      break;
    } catch {
      lastState = 'unsettled';
      logger.warn(
        { event: 'gate_cycle_unsettled', cycle, of: GATE_CYCLES },
        'panel did not settle after a gate cycle — repeating the interaction'
      );
      // Move the pointer off the panel so the next cycle's first move is a real
      // re-entry rather than a continuation of the previous hover.
      await page.mouse.move(2, 2);
      await page.waitForTimeout(400);
    }
  }

  if (lastState !== 'settled') {
    // Report the *specific* reason rather than one generic code, so a run log
    // actually distinguishes "the panel never re-mounted" from "the panel kept
    // coming back but never loaded a price". Those need different fixes.
    const code =
      lastState === 'panel_absent' ? 'panel_not_found' :
      lastState === 'gate_not_open' ? 'interaction_gate_never_opened' :
      'panel_never_settled';
    throw new InteractionError(
      code,
      `offer panel never reached ready/failed after ${GATE_CYCLES} gate cycles (last state: ${lastState})`
    );
  }

  return { dwellMs: dwell, moves, elapsedMs: Date.now() - started };
}

/** Exact-text matcher, so "Pro" does not also match "Pro Bundle". */
function exactText(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

/** Minimal CSS attribute-value escaping for our own known axis labels. */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
