import { z } from 'zod';
import logger from '../util/logger.js';
import { parsePrice, parseStock, parseStoreAttemptCount } from '../util/parse.js';

/**
 * Manifest-driven, decoy-safe extraction of price + stock.
 *
 * THE PROBLEM THIS SOLVES. The store renders several plausible-looking numbers in
 * the offer panel. Observed live at manifest revision 633001:
 *
 *   <span class="price-value" aria-hidden="true" style="display:none">₹13,241</span>  <- DECOY
 *   <span class="amount"      aria-hidden="true" style="display:none">₹15,191</span>  <- DECOY
 *   <... class="rwq-x1">₹18,335</...>                                                <- MRP
 *   <DATA class="v3 fgy-x1">₹14,668</DATA>                                           <- REAL
 *
 * The two decoys carry STABLE, human-readable class names while the real price
 * carries a class that is randomised per manifest revision. So the intuitive
 * selector (.price-value) returns a wrong answer with no error, and the correct
 * selector can only be obtained from the manifest.
 *
 * THE RULES.
 *  1. Select price nodes ONLY by manifest classes.priceValue.
 *  2. Discard anything aria-hidden="true" or not rendered.
 *  3. Require exactly one surviving candidate. Zero => layout/unlock problem.
 *     More than one => the page changed shape; refuse to guess.
 *  4. Never fall back to any other selector. A missing price is a logged failure,
 *     not an invitation to scrape a decoy.
 */

const ExtractionSchema = z.object({
  price: z.number().finite().nonnegative(),
  stock: z.number().int().nonnegative(),
  currency: z.string().default('INR'),
  mrp: z.number().finite().nonnegative().nullable(),
  salePrice: z.number().finite().nonnegative().nullable(),
  seller: z.string().nullable(),
  delivery: z.string().nullable(),
  storeAttemptCount: z.number().int().nullable(),
  manifestRevision: z.number().int(),
  priceText: z.string(),
  stockText: z.string(),
  decoyTexts: z.array(z.string()).default([]),
});

export class ExtractionError extends Error {
  constructor(code, message, detail = {}) {
    super(message ?? code);
    this.name = 'ExtractionError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {import('./manifest.js').ManifestSchema} manifest
 */
export async function extractOffer(page, manifest) {
  const { classes } = manifest;

  const raw = await page.evaluate(
    ({ classes, priceTag, priceCarrier }) => {
      const isRendered = (el) => {
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
      };

      // The price node is identified SOLELY by the manifest class. priceTag tells
      // us the tag name (the store used <data>, not <span>), so we match on both
      // rather than assuming <span>.
      const priceSel = `.${CSS.escape(classes.priceValue)}`;
      const priceNodes = [...document.querySelectorAll(priceSel)];
      const visiblePriceNodes = priceNodes.filter(isRendered);

      // textContent of the ELEMENT, not of its children: when priceCarrier is
      // "split" the price is one <span> per character with filler characters
      // between them, and only the container's textContent reassembles it.
      const priceCandidates = visiblePriceNodes.map((el) => ({
        tag: el.tagName,
        text: el.textContent ?? '',
        matchesTag: priceTag ? el.tagName.toLowerCase() === priceTag.toLowerCase() : true,
        cls: el.className,
      }));

      // Decoys, recorded only so we can WARN if we ever appear to match one.
      const decoyTexts = priceNodes.filter((el) => !isRendered(el)).map((el) => el.textContent ?? '');

      const text = (sel) => {
        const el = document.querySelector(sel);
        return el && isRendered(el) ? (el.textContent ?? '').trim() : null;
      };

      const panel = document.querySelector('.offer-panel');
      const stockPill = document.querySelector(`.${CSS.escape(classes.stock)}`);

      return {
        panelClass: panel?.className ?? null,
        panelText: panel?.innerText ?? null,
        priceTag,
        priceCarrier,
        priceCandidates,
        decoyTexts,
        mrp: text(`.${CSS.escape(classes.mrp)}`),
        sale: text(`.${CSS.escape(classes.sale)}`),
        seller: classes.seller ? text(`.${CSS.escape(classes.seller)}`) : null,
        delivery: classes.delivery ? text(`.${CSS.escape(classes.delivery)}`) : null,
        stockText:
          stockPill && isRendered(stockPill)
            ? (stockPill.textContent ?? '').trim()
            : stockPill
              ? (stockPill.textContent ?? '').trim()
              : null,
      };
    },
    { classes, priceTag: manifest.priceTag, priceCarrier: manifest.priceCarrier }
  );

  // --------------------------------------------------- rule 3: exactly one
  if (raw.priceCandidates.length === 0) {
    throw new ExtractionError(
      'price_not_found',
      `no visible price node for manifest class .${classes.priceValue} (panel="${raw.panelClass}")`,
      { panelClass: raw.panelClass, decoyTexts: raw.decoyTexts }
    );
  }
  if (raw.priceCandidates.length > 1) {
    throw new ExtractionError(
      'price_ambiguous',
      `${raw.priceCandidates.length} visible price nodes — refusing to guess which is real`,
      { candidates: raw.priceCandidates }
    );
  }

  const candidate = raw.priceCandidates[0];

  // priceTag is advisory: warn if it disagrees, but do not fail the run over it,
  // because the class match is the authoritative signal.
  if (!candidate.matchesTag) {
    logger.warn(
      { event: 'price_tag_mismatch', expected: raw.priceTag, actual: candidate.tag },
      'price tag differs from manifest priceTag'
    );
  }

  const price = parsePrice(candidate.text);
  if (price === null) {
    throw new ExtractionError('price_unparseable', `could not parse price from ${JSON.stringify(candidate.text)}`, {
      candidate,
    });
  }

  // A plausibility band. A mock store's prices are thousands of rupees; a value
  // outside this range means we grabbed a badge, a rating or a decoy, and writing
  // it to history would be a silent data-corruption bug.
  if (price < 1 || price > 10_000_000) {
    throw new ExtractionError('price_implausible', `price ${price} outside plausible range`, { candidate });
  }

  if (raw.stockText === null) {
    throw new ExtractionError('stock_not_found', 'no stock element for manifest class', {
      panelClass: raw.panelClass,
    });
  }
  const stock = parseStock(raw.stockText);
  if (stock === null) {
    throw new ExtractionError('stock_unparseable', `could not parse stock from ${JSON.stringify(raw.stockText)}`);
  }

  // Self-check against the decoys. The store builds them as jitter(shown) and
  // jitter(shown+7), so landing exactly on one is possible but should be rare.
  // If it happens we still have the manifest class as proof, so we only warn.
  const decoyHit = raw.decoyTexts.find((d) => parsePrice(d) === price);
  if (decoyHit !== undefined) {
    logger.warn(
      { event: 'price_matches_decoy', price, decoyText: decoyHit },
      'extracted price coincides with a hidden node — manifest class match is authoritative, but noting it'
    );
  }

  const parsed = ExtractionSchema.safeParse({
    price,
    stock,
    currency: 'INR',
    mrp: parsePrice(raw.mrp),
    salePrice: parsePrice(raw.sale),
    seller: cleanField(raw.seller),
    delivery: cleanField(raw.delivery),
    storeAttemptCount: parseStoreAttemptCount(raw.panelText),
    manifestRevision: manifest.revision,
    priceText: candidate.text,
    stockText: raw.stockText,
    decoyTexts: raw.decoyTexts,
  });

  if (!parsed.success) {
    throw new ExtractionError('extraction_schema_invalid', parsed.error.message, { raw });
  }
  return parsed.data;
}

/** Strip the zero-width joiners the store sprinkles into seller/delivery strings. */
function cleanField(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned.length ? cleaned : null;
}
