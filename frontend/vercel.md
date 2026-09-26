# vercel.json

This file sits in `frontend/`, not the repo root, and that is load-bearing.

## Why it is here and not at the repo root

The Vercel project's **Root Directory is `frontend`**. Vercel reads `vercel.json` from
the *project's* root directory, not the repository's. A `vercel.json` at the repo root
is silently ignored when Root Directory is set to a subdirectory, and nothing fails
loudly - the build succeeds and the deployment goes green while silently losing:

- `VITE_API_BASE_URL`, so `API_BASE` resolves to `''` in `src/api/client.js` and the
  dashboard fetches `/api/...` against the Vercel origin, where no API exists
- the SPA `rewrites`, so a hard refresh on `/` 404s
- the `Cache-Control` headers, so browsers pin a stale bundle pointing at deleted
  asset hashes

Every path inside this file (`npm run build`, `dist`, `npm ci`) is relative to the
project root, so moving the file required no changes to its contents.

## Why there are no `//` comment keys

An earlier version annotated this file with `//`-prefixed keys to explain the settings
inline. Vercel validates `vercel.json` against its published JSON schema and rejects
unknown properties outright:

```
Error: Invalid vercel.json - should NOT have additional property `//frontendRoot`.
```

The `//` convention is not honoured any more, so the explanations live in this file
instead.

## The settings, and why

- **`VITE_API_BASE_URL`** is public by nature. Vite inlines every `VITE_`-prefixed
  variable into the public JS bundle, so this must only ever be a URL. The Supabase
  service-role key and `CRON_SECRET` belong to the backend's environment and must
  never appear in a `VITE_` variable.

  Render suffixed the service with `-jmf0` because `ine-price-tracker-api` was already
  taken on the account by an unrelated older app. Our service is
  `srv-daru2ovavr4c7386v3g0` and the `-jmf0` hostname is the correct one. Do not
  "simplify" this back to the unsuffixed name - that hostname serves a different
  application entirely.

- **`rewrites`** - this is a single-page app with no client-side router, so `/` is the
  only route. The rewrite keeps a hard refresh from 404ing, and leaves `/api/*` alone.

- **`headers`** - the bundle is content-hashed, so `/assets/*` can be cached forever.
  `index.html` must *not* be, or browsers pin users to a stale bundle.
