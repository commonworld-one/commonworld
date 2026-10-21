# Atlas from the v1 Worker's Static Assets (routing option A3)

Owner decision 2026-10-18 13:45. Replaces "the Worker proxies the Atlas to Pages" (option A as built, `src/atlas-proxy.ts`)
for staging and production. Cost background: product note `COSTS-LOADS-2026-10-18.md` §5.

## What answers which request

| Request | Who answers | Billed Worker requests |
|---|---|---|
| Atlas static file: `/atlas/assets/*`, `/atlas/og/*`, `/atlas/screens/*`, `/atlas/badge/*`, `/atlas/data/*`, `/atlas/**.json`, `/atlas/**.txt`, `/atlas/**.xml`, `/atlas/**.md` (every Markdown twin: platform and category cards, decisions, events), `/stats.json`, `/stats/index.md`, `/about/index.md`, `/privacy/index.md`, `/terms/index.md`, `/api/*`, `/.well-known/security.txt` | Cloudflare Static Assets directly (headers from the Atlas `_headers`, redirects from `_redirects`, a miss = Atlas `404.html` with 404) | **0** |
| Atlas HTML: `/atlas/…/`, `/privacy/`, `/terms/`, `/about/`, `/stats/`, Atlas 404s under those | Worker → `env.ASSETS.fetch` → + CSP nonce (`src/atlas-assets.ts`) | 1 |
| Slashless / `.html` Atlas URL (`/atlas/platforms/x`) | Worker, 308 to the slash form (as Pages) | 1 |
| Bare `/atlas`, `/privacy`, `/terms`, `/about`, `/stats` | Worker, 301 to the slash form | 1 |
| IndexNow key file `/<hex>.txt` | Worker → ASSETS | 1 |
| `/.well-known/mcp.json` (MCP discovery manifest) | Worker (`src/mcp/docs.ts` `mcpWellKnown`) | 1 |
| Any other `/.well-known/*` | Worker → ASSETS (Atlas 404) | 1 |
| `/`, v1 pages, `/v1/*`, `/assets/*`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt`, `/favicon.ico` | Worker (v1); llms files append the Atlas file read from ASSETS (no network) | 1 |

The split is `[assets] run_worker_first` in `wrangler.toml` (`"/*"` plus the `!` patterns), the same in the top-level,
staging and production tables and equal to `ATLAS_RUN_WORKER_FIRST` in `src/atlas-assets.ts`; `test/atlas-assets.test.ts`
enforces that, checks a list of static and Worker paths, and, when a cw-public checkout with a built `dist` sits next to
this repo, checks every file of the real build (HTML → Worker except `/atlas/badge/`, which is static on Pages too;
everything else static except the v1-owned root files).

Headers stay the Atlas's: Static Assets applies the Atlas `_headers` both to direct responses and to `env.ASSETS.fetch`
(checked in miniflare), so CSP, HSTS, `X-Frame-Options`, `Permissions-Policy`, cache rules and CORS on JSON are exactly
the build's. The Worker only adds `'nonce-…'` after `script-src 'self'` on HTML (port of cw-public
`functions/_middleware.js`), `x-cw-upstream: atlas-assets`, and `x-robots-tag: noindex, nofollow` on closed staging.
`scripts/build-atlas-assets.mjs` appends one host-scoped `_headers` rule (`https://staging.commonworld.one/*` →
`X-Robots-Tag: noindex, nofollow`) so static files on staging are noindex too; on `commonworld.one` it matches nothing.

## Requests per Atlas view

| Visit | Pages today | Option A as built (proxy) | A3 |
|---|---|---|---|
| Atlas home, first visit, little scrolling | 1 | ~10–15 | **1** |
| Atlas home, scrolled far (lazy thumbnails) | 1 | 30–60+ | **1** |
| Detail page `/atlas/platforms/<id>/`, cold | 1 | ~19 | **1** |
| Repeat page in the same session | 1 | ~2–3 | **1** |
| Bot fetching one HTML page | 1 | 2 | **1** (+ the AI-bot visit log D1 write for AI-crawler UAs, as for every Worker response) |
| Static file hit directly (image, JSON, `/api/v1/…`) | 0 | 1 | **0** |

## Build and deploy

- `npm run atlas:build` — copy a built Atlas (`$CW_PUBLIC_DIR/atlas/site/dist`, default: the repository root) into
  `platform/.atlas-dist` (git-ignored), add `.assetsignore` (drops the Pages-only `_routes.json`) and the staging noindex rule,
  check the Static Assets limits (100 header rules, 2,000-char lines, 2,000 redirects, 25 MiB per file; 2,601 files today,
  100,000 allowed on Workers Paid) and that the `/*` CSP has `script-src 'self'`. `--build` runs `build.py` + `check.py`
  in the checkout first; `--dist <dir>` takes a ready build (CI artifact).
- `npm run deploy:staging` / `npm run deploy:production` = `atlas:build --build` + `wrangler deploy --env …`. One Worker
  version holds v1 and the Atlas; `wrangler rollback` rolls back both.
- Automatic Atlas deploys after launch (replaces Pages git builds, so the 500 builds/month limit is gone): the platform
  and the Atlas now live in one repository, so the manual `deploy-platform` workflow builds the Atlas from the same
  commit and deploys both (`../docs/DEPLOY.md`).

## Staging rehearsal (not done yet; staging was in final QA on 2026-10-18)

1. Merge or check out `feat/atlas-static-assets`; `cd platform && npm ci && npm test && npx tsc --noEmit`.
2. `CW_PUBLIC_DIR=<cw-public on main> npm run deploy:staging`.
3. Checks (`H=https://staging.commonworld.one`):
   - `curl -sI $H/atlas/assets/atlas.css` → 200, `cache-control: public, max-age=604800`, **no** `x-cw-upstream`.
   - `curl -sI $H/atlas/platforms.json`, `$H/api/v1/index.json`, `$H/.well-known/security.txt` → 200, no `x-cw-upstream`.
   - `curl -sI $H/atlas/` → 200, `x-cw-upstream: atlas-assets`, CSP with `'nonce-…'`; twice → two different nonces.
   - `curl -sI $H/atlas/platforms/1f916` → 308 `location: /atlas/platforms/1f916/`; `$H/atlas` → 301 `/atlas/`.
   - `curl -s -o /dev/null -w '%{http_code}' $H/atlas/nope/` → 404 (Atlas 404 page); `$H/atlas/assets/nope.css` → 404.
   - `$H/privacy/`, `/terms/`, `/about/`, `/stats/` → 200 Atlas pages; `$H/llms.txt` ends with the Atlas text;
     `$H/sitemap.xml` is the index; `$H/robots.txt` disallows all (closed staging).
   - Workers Logs (staging has per-request logs until 2026-10-25): opening `/atlas/` in a browser shows **one**
     invocation (`/atlas/`), none for its CSS, JS, thumbnails.
   - Owner in a real browser: `/atlas/` and one platform page, DevTools console without CSP errors, theme toggle works.
4. Staging rollback: `npx wrangler rollback --env staging`, or `ATLAS_SOURCE = ""` in `[env.staging.vars]` + deploy
   (= the old proxy to `commonworld.pages.dev`).

## Launch day and Pages retirement

Owner steps (`../docs/DEPLOY.md`): remove the Pages custom domains, uncomment the production routes, `npm run deploy:production`,
smoke, then switch off the Pages project's automatic deployments (production off, previews none) and deploy through the
`deploy-platform` workflow. Keep the Pages project for a week as the rollback target, then delete it together with the
`ATLAS_ORIGIN` proxy fallback and the repository's `functions/_middleware.js` / `_routes.json`.
