/**
 * Parsing/normalising helpers for scraped values.
 *
 * Deliberately separate from the DOM plumbing so they can be unit tested against
 * every format the store is known to emit, without launching a browser.
 *
 * EVERY STRING IN THE TESTS BELOW WAS CAPTURED FROM THE LIVE STORE. That matters:
 * the format rotates, so a parser validated against invented examples would pass
 * the tests and fail in production on the first rotated render.
 */

/**
 * Fold non-ASCII digits to ASCII.
 *
 * The store has a `unicode` format variant that substitutes fullwidth digits
 * (１２,９８１). Left alone these are not matched by \d, so the whole value would
 * be discarded and the scrape would fail as "unparseable" for no visible reason.
 */
function foldDigits(input) {
  return String(input).replace(/[^\u0000-\u007F]/g, (ch) => {
    const cp = ch.codePointAt(0);
    // Fullwidth digits U+FF10..U+FF19
    if (cp >= 0xff10 && cp <= 0xff19) return String(cp - 0xff10);
    const nfkc = ch.normalize('NFKC');
    // Any other character that normalises to an ASCII digit.
    return /^[0-9]$/.test(nfkc) ? nfkc : '';
  });
}

/**
 * Normalise a rendered price to a Number.
 *
 * Formats observed live (all of them appear in rotation):
 *   "₹11,590"                     default, Intl en-IN, 0 fraction digits
 *   "₹1,00,309"                   Indian lakh grouping
 *   "₹11,590/- (incl. of all taxes)"  the `trailing` variant
 *   "₹7 701"                      the `spaced` variant (comma -> space)
 *   "₹12.345,00"                  the `euro` variant (comma -> dot, ",00" appended)
 *   "Rs. 14,668.00"               a currency-prefixed variant
 *   "₹１２,９８１"                  the `unicode` variant (fullwidth digits)
 *   "₹1 4 , 6 6 8" + fillers      the `split` carrier (one <span> per character)
 *
 * The approach is deliberately NOT "match the template I saw" — the template is
 * precisely what rotates. Instead:
 *
 *   1. Fold exotic digits to ASCII.
 *   2. Take the LONGEST run of digit/separator characters. This is what kills the
 *      "Rs." bug: the full stop in the currency prefix would otherwise be kept and
 *      glued onto the front of the number, producing ".14,668.00" -> NaN.
 *   3. Drop spaces (the `spaced` variant's thousands separator).
 *   4. Strip a trailing zero fraction — the store only ever renders a whole-rupee
 *      amount, and the variants that look fractional only append ",00"/".00".
 *   5. Whatever separators remain are thousands separators, so remove them.
 *
 * Step 4 is safe precisely because the true prices are whole rupees. If the store
 * ever renders a genuine fractional price, step 4 simply will not match and the
 * decimals survive.
 */
export function parsePrice(raw) {
  if (raw === null || raw === undefined) return null;
  const folded = foldDigits(raw);

  // Longest run of characters that could form a number, allowing spaces as
  // thousands separators. Everything else (currency symbols, letters, "/-",
  // parentheses) terminates the run.
  const runs = folded.match(/[\d][\d.,\s]*[\d]|\d/g);
  if (!runs || runs.length === 0) return null;

  // The price is the most digit-dense run. A decoy or a "41% saving" suffix
  // could otherwise win by appearing later in the string.
  const best = runs
    .map((r) => ({ r, digits: (r.match(/\d/g) ?? []).length }))
    .sort((a, b) => b.digits - a.digits)[0].r;

  let s = best.replace(/\s+/g, '');

  // Strip a pure-zero fraction: ",00" or ".00" at the end.
  s = s.replace(/[.,]00$/, '');

  // Anything left is a thousands separator. Guard against a stray leading or
  // trailing separator that survived step 2.
  s = s.replace(/^[.,]+|[.,]+$/g, '').replace(/[.,]/g, '');

  if (!/^\d+$/.test(s)) return null;

  const value = Number(s);
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalise rendered stock to a non-negative integer.
 *
 * The store rotates five templates based on `stock % 5`:
 *   "12 units available" | "Last few: 12" | "Available (12)"
 *   "Stock: 12 remaining" | "Ready to ship — 12 available"
 * and renders the literal string "Sold out" when stock is 0. CSS may uppercase the
 * text, so the match is case-insensitive. Note the rendered text is styled with
 * text-transform, so textContent can be either case depending on how it is read.
 */
export function parseStock(raw) {
  if (raw === null || raw === undefined) return null;
  const folded = foldDigits(raw);
  const text = String(raw);

  if (/sold[\s-]?out/i.test(text)) return 0;
  if (/out of stock/i.test(text)) return 0;

  const runs = folded.match(/\d[\d.,\s]*\d|\d/g);
  if (!runs) return null;

  const best = runs
    .map((r) => ({ r, digits: (r.match(/\d/g) ?? []).length }))
    .sort((a, b) => b.digits - a.digits)[0].r;

  const n = Number.parseInt(best.replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read "Loaded in N attempt(s)" that the store renders in the panel footer. */
export function parseStoreAttemptCount(panelText) {
  const m = /loaded in (\d+) attempt/i.exec(String(panelText ?? ''));
  return m ? Number.parseInt(m[1], 10) : null;
}
