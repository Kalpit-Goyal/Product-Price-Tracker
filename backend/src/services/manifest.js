import { z } from 'zod';
import config from '../config.js';
import logger from '../util/logger.js';

/**
 * Reads and caches the store's UI manifest.
 *
 * WHY this exists: the store randomises its CSS class names per layout `revision`
 * (e.g. priceValue was "fgy-x1" at revision 633001). Any hardcoded selector is a
 * latent bug, so the extractor resolves class names from here at runtime instead.
 *
 * WHY a cache keyed on `revision`: the manifest is tiny, changes rarely, and a
 * revision change is a signal worth surfacing rather than silently absorbing.
 */

/** Runtime schema. If the store changes shape, we want a loud failure, not `undefined`. */
export const ManifestSchema = z.object({
  revision: z.number().int(),
  variant: z.number().int().optional(),
  validUntil: z.number().optional(),
  classes: z.object({
    priceWrap: z.string(),
    priceValue: z.string(),
    mrp: z.string(),
    sale: z.string(),
    badge: z.string(),
    stock: z.string(),
    seller: z.string().optional(),
    delivery: z.string().optional(),
    rating: z.string().optional(),
  }),
  order: z.array(z.string()).optional(),
  priceTag: z.string().optional(),
  priceCarrier: z.string().optional(),
  ratingAria: z.boolean().optional(),
  sellerTitle: z.boolean().optional(),
});

let cached = null;
let inFlight = null;

/**
 * @param {{force?: boolean}} opts
 * @returns {Promise<import('zod').infer<typeof ManifestSchema>>}
 */
export async function getManifest({ force = false } = {}) {
  if (cached && !force) return cached;
  // Collapse concurrent callers onto one request (several products scrape at once).
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const url = `${config.apiV2}/ui/manifest`;
    const started = Date.now();

    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': config.SCRAPE_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`manifest_http_${res.status}`);

    const parsed = ManifestSchema.safeParse(await res.json());
    if (!parsed.success) {
      // A schema break here means the store changed its contract. Surface it loudly.
      throw new Error(`manifest_schema_invalid: ${parsed.error.message}`);
    }

    const prev = cached;
    cached = parsed.data;

    if (prev && prev.revision !== cached.revision) {
      // NOT an error. The scraper is supposed to survive this; we just record that
      // it happened so a human can see the store changed under us.
      logger.warn(
        {
          event: 'layout_changed',
          fromRevision: prev.revision,
          toRevision: cached.revision,
          priceValueClass: cached.classes.priceValue,
        },
        'store layout revision changed — selectors re-resolved from the new manifest'
      );
    } else {
      logger.debug(
        { event: 'manifest_loaded', revision: cached.revision, ms: Date.now() - started },
        'manifest loaded'
      );
    }

    return cached;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** The revision currently in force — persisted on every scrape attempt. */
export async function getManifestRevision() {
  return (await getManifest()).revision;
}

/** Test seam. */
export function __resetManifestCache() {
  cached = null;
}
