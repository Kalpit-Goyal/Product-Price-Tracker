/**
 * Environment configuration, validated once at boot.
 *
 * WHY validate at boot rather than reading process.env inline: a typo in an env var
 * should crash the process immediately and loudly, not surface hours later as an
 * undefined-token error inside a 2-hourly cron run that nobody is watching.
 */
import { z } from 'zod';
import dotenv from 'dotenv';

// WHY THE PATH IS OVERRIDABLE. dotenv.config() with no argument always reads ./.env,
// and it runs *after* any test harness has adjusted process.env -- so a harness cannot
// stop a real .env from leaking in. scripts/smoke.mjs needs ALLOW_DEV_TRIGGER absent so
// its "secret-less run must be refused" checks are meaningful, and it sets
// DOTENV_CONFIG_PATH to a file that does not exist. dotenv never overrides a value
// already in process.env, so this also cannot shadow a real .env when unset.
dotenv.config(process.env.DOTENV_CONFIG_PATH ? { path: process.env.DOTENV_CONFIG_PATH } : {});

const boolish = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === '1' || v === 'true'));

const intish = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().positive());

// 0 is a meaningful value for some knobs (e.g. SLOWMO_MS=0 means "no artificial
// delay"), so those must NOT be validated with .positive(). See BUILD_LOG Failure 3.
const nonNegIntish = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  NODE_ENV: z.string().optional().default('development'),
  PORT: intish(10000),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  CRON_SECRET: z.string().min(16),

  // 1 = headless (production), 0 = headed (local screen recording)
  HEADLESS: boolish(true),
  // slowMo is only honoured in headed mode; it makes the interaction legible on camera.
  SLOWMO_MS: nonNegIntish(0),

  // The ONLY host we are permitted to scrape. Hard-scoped on purpose.
  SCRAPE_BASE_URL: z
    .string()
    .url()
    .optional()
    .default('https://demo.inelabteamdev.com'),

  SCRAPE_TIMEOUT_MS: intish(30000),
  SCRAPE_MAX_ATTEMPTS: intish(6),
  SCRAPE_CONCURRENCY: intish(1),
  SCRAPE_USER_AGENT: z
    .string()
    .optional()
    .default('ine-price-tracker/1.0 (+assignment; contact: student@example.com)'),

  ALLOWED_ORIGIN: z.string().optional().default('*'),
  LOG_LEVEL: z.string().optional().default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill it in.\n');
  process.exit(1);
}

/** Guard-rail: refuse to run against anything except INE's mock store. */
const ALLOWED_SCRAPE_HOSTS = ['demo.inelabteamdev.com'];

const scrapeUrl = new URL(parsed.data.SCRAPE_BASE_URL);
if (!ALLOWED_SCRAPE_HOSTS.includes(scrapeUrl.hostname)) {
  console.error(
    `\nRefusing to run: SCRAPE_BASE_URL host "${scrapeUrl.hostname}" is not ` +
      `INE's mock store. The assignment permits scraping ${ALLOWED_SCRAPE_HOSTS.join(', ')} only.\n`
  );
  process.exit(1);
}

export const config = {
  ...parsed.data,
  headless: parsed.data.HEADLESS,
  slowMo: parsed.data.SLOWMO_MS,
  scrapeBaseUrl: scrapeUrl.origin,
  apiV2: `${scrapeUrl.origin}/api/v2`,
};

export default config;
