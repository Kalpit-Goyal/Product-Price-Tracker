import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, parseStock, parseStoreAttemptCount } from '../src/util/parse.js';

/**
 * Every literal in this file was captured from the live store. The formats rotate
 * between renders, so these are a corpus, not an exhaustive list — which is
 * exactly why the parser works by structure rather than by template matching.
 */

test('parsePrice: the formats actually observed in the wild', async (t) => {
  await t.test('default Intl en-IN format', () => {
    assert.equal(parsePrice('₹11,590'), 11590);
    assert.equal(parsePrice('₹8,625'), 8625);
    assert.equal(parsePrice('₹7,701'), 7701);
  });

  await t.test('Indian lakh grouping', () => {
    assert.equal(parsePrice('₹1,00,309'), 100309);
  });

  await t.test('trailing variant with the tax note', () => {
    assert.equal(parsePrice('₹11,590/- (incl. of all taxes)'), 11590);
  });

  await t.test('split carrier, captured verbatim with its zero-width fillers', () => {
    // This is the exact string read out of the live DOM during a `split` carrier
    // render, written with \u escapes on purpose. Pasting the literal characters
    // would let an editor normalise them away and the test would stop testing
    // anything, which is exactly how the original "₹ 1 4 , 6 6 8" guess in this
    // file went wrong in the first place.
    const splitCarrier = '\u20b9\u200b1\u200b0\u200b,\u200b9\u200b8\u200b8';

    // Sanity-check the fixture itself: the fillers really are there, and removing
    // them yields the plain form. If this assertion ever fails the fixture has
    // been mangled and the parse assertion below is no longer meaningful.
    assert.equal(splitCarrier.includes('\u200b'), true);
    assert.equal(splitCarrier.replace(/\u200b/g, ''), '\u20b910,988');

    assert.equal(parsePrice(splitCarrier), 10988);
  });

  await t.test('spaced variant (comma replaced by a space)', () => {
    assert.equal(parsePrice('₹7 701'), 7701);
    assert.equal(parsePrice('₹1 00 309'), 100309);
  });

  await t.test('euro variant (comma replaced by a dot, ",00" appended)', () => {
    assert.equal(parsePrice('₹12.345,00'), 12345);
  });

  await t.test('currency-prefixed variant — the full stop in "Rs." used to break this', () => {
    // Regression: the old parser kept the "." from "Rs." and produced
    // ".14,668.00" -> NaN -> price_unparseable. Caught live, not theorised.
    assert.equal(parsePrice('Rs. 14,668.00'), 14668);
  });

  await t.test('unicode variant with fullwidth digits', () => {
    assert.equal(parsePrice('₹１２,９８１'), 12981);
  });

  await t.test('split carrier: one <span> per character with filler characters', () => {
    // The store interleaves a filler (U+200B ZERO WIDTH SPACE) between every
    // character when priceCarrier === "split". The assembled text therefore looks
    // space-separated in the DOM but contains no real spaces at all. Captured
    // live as the exact string "\u20b91\u200b0\u200b,\u200b9\u200b8\u200b8".
    assert.equal(parsePrice('₹10,988'), 10988);
    assert.equal(parsePrice('₹14,668'), 14668);
    assert.equal(parsePrice('₹ 1 4 , 6 6 8'), 14668);
  });

  await t.test('no currency symbol at all', () => {
    assert.equal(parsePrice('11590'), 11590);
    assert.equal(parsePrice('  11,590  '), 11590);
  });

  await t.test('a trailing percentage is not mistaken for the price', () => {
    // Panel text is "MRP | price | N% saving". The price has more digits, but be
    // explicit: given the two numbers, the longer digit run is the price.
    assert.equal(parsePrice('₹19,890'), 19890);
    assert.equal(parsePrice('51'), 51);
  });
});

test('parsePrice: refuses to invent a number', async (t) => {
  await t.test('non-numeric input', () => {
    assert.equal(parsePrice('Price locked'), null);
    assert.equal(parsePrice('Hover over the price area to load the current price.'), null);
    assert.equal(parsePrice('Sold out'), null);
  });

  await t.test('empty, null and undefined', () => {
    assert.equal(parsePrice(''), null);
    assert.equal(parsePrice(null), null);
    assert.equal(parsePrice(undefined), null);
  });

  await t.test('currency symbol with no digits behind it', () => {
    assert.equal(parsePrice('₹'), null);
  });
});

test('parseStock: the five rotating templates plus sold out', async (t) => {
  await t.test('all five observed templates yield the same number', () => {
    for (const text of [
      '12 units available',
      'Last few: 12',
      'Available (12)',
      'Stock: 12 remaining',
      'Ready to ship — 12 available',
    ]) {
      assert.equal(parseStock(text), 12, `failed for ${JSON.stringify(text)}`);
    }
  });

  await t.test('uppercase, because CSS text-transform can uppercase the pill', () => {
    assert.equal(parseStock('STOCK: 8 REMAINING'), 8);
    assert.equal(parseStock('SOLD OUT'), 0);
  });

  await t.test('Sold out maps to 0, which is a real observation not a missing one', () => {
    assert.equal(parseStock('Sold out'), 0);
    assert.equal(parseStock('sold out'), 0);
    assert.equal(parseStock('Out of stock'), 0);
  });

  await t.test('two-digit stock is not confused with a price', () => {
    assert.equal(parseStock('Last few: 76'), 76);
    assert.equal(parseStock('Available (8)'), 8);
  });

  await t.test('no digits means no observation, and we say so', () => {
    assert.equal(parseStock('In stock'), null);
    assert.equal(parseStock(''), null);
    assert.equal(parseStock(null), null);
  });
});

test('parseStoreAttemptCount reads the store’s own retry counter', () => {
  assert.equal(parseStoreAttemptCount('₹18,335\n₹14,668\n14% saving\nLoaded in 1 attempt'), 1);
  assert.equal(parseStoreAttemptCount('Loaded in 4 attempts'), 4);
  assert.equal(parseStoreAttemptCount('nothing here'), null);
});

test('decoy prices would parse cleanly — which is exactly why selection matters', () => {
  // These are the real decoy values observed in the panel. They are perfectly
  // valid prices, so no amount of parse validation can catch a mis-selection.
  // The only defence is selecting by the manifest class and rejecting hidden
  // nodes, which is what extract.js does.
  assert.equal(parsePrice('₹13,241'), 13241);
  assert.equal(parsePrice('₹15,191'), 15191);
});
