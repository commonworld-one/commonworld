# Atlas from the v1 Worker's Static Assets (routing option A3)

Owner decision 2026-10-18 13:45. Replaces "the Worker proxies the Atlas to Pages" (option A as built, `src/atlas-proxy.ts`)
for staging and production. **Status: live in production since 2026-10-20** (`../docs/DEPLOY.md`); the "Pages today" column
below is the state before the cutover, kept for the record. The old Cloudflare Pages project is only a rollback fallback now. Cost background: product note `COSTS-LOADS-2026-10-18.md` §5.

## What answers which request

| Request | Who answers | Billed Worker requests |
|---|---|---|
| Atlas static file: `/atlas/assets/*`, `/atlas/og/*`, `/atlas/screens/*`, `/atlas/badge/*`, `/atlas/data/*`, `/atlas/**.json`, `/atlas/**.txt`, `/atlas/**.xml`, `/atlas/**.md` (every Markdown twin: platform and category cards, decisions, events), `/stats.json`, `/stats/index.md`, `/about/index.md`, `/privacy/index.md`, `/terms/index.md`, `/api/*`, `/.well-known/security.txt` | Cloudflare Static Assets directly (headers from the Atlas `_headers`, redirects from `_redirects`) | **0** |
| A miss on one of those paths (a file that does not exist) | Static Assets: the **nearest** `404.html` with 404 (`not_found_handling = "404-page"`). The Atlas build writes typed ones (2026-10-25): `/api/404.html` = a JSON error body for every miss under `/api/` (e.g. `/api/v1/atlas/page/9.json`), `<list>/page/404.html` = Markdown for a missing list-page twin (e.g. `/atlas/page/9/index.md`); `_headers` gives the content type by the requested path; anything else gets the root `404.html` | **0** |
| Atlas HTML: `/atlas/…/`, `/privacy/`, `/terms/`, `/about/`, `/stats/`, Atlas 404s under those | Worker → `env.ASSETS.fetch` → + CSP nonce (`src/atlas-assets.ts`) | 1 |
| Slashless / `.html` Atlas URL (`/atlas/platforms/x`) | Worker, 308 to the slash form (as Pages) | 1 |
| Bare `/atlas`, `/privacy`, `/terms`, `/about`, `/stats` | Worker, 301 to the slash form | 1 |
| IndexNow key file `/<hex>.txt` | Worker → ASSETS | 1 |
| `/.well-known/mcp.json` (MCP discovery manifest) | Worker (`src/mcp/docs.ts` `mcpWellKnown`) | 1 |
| Any other `/.well-known/*` | Worker → ASSETS (Atlas 404) | 1 |
| `/`, v1 pages, `/v1/*`, `/assets/*`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/llms-full.txt`, `/favicon.ico` | Worker (v1); llms files append the Atlas file read from ASSETS (no network) | 1 |

Typed 404s (2026-10-25): a `run_worker_first` negative path never reaches the Worker, also on a miss (checked on staging:
with `not_found_handling = "none"` such a miss was an empty 404 without the Worker), so the JSON and Markdown 404 bodies are
static files found by the nearest-`404.html` rule. An HTML miss runs the Worker, which always answers with the root
`/404.html` (never the Markdown `404.html` of a list folder) and answers a direct request for one of those files
(`/atlas/page/404`) with 404 too.

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

## Staging check (current)

The A3 routing is live in production since the first successful production deploy, 2026-10-20 (`744fb1a`, run
[39474179999](https://github.com/commonworld-one/commonworld/actions/runs/39474179999); `ATLAS_SOURCE = "assets"` in `[env.production.vars]` at that commit), and production
answers `/atlas/` with `x-cw-upstream: atlas-assets` (checked 2026-10-27). Platform and Atlas live in this repository,
so there is no separate Atlas checkout: `scripts/build-atlas-assets.mjs` takes the repository root by default
(`--src` or `CW_PUBLIC_DIR` only override it).

1. In this repository: `cd platform && npm ci && npm test && npx tsc --noEmit`.
2. Deploy to staging with the manual workflow "Deploy platform (staging)" (`.github/workflows/deploy-staging.yml`,
   input `ref` = the branch or commit; `../docs/DEPLOY.md`, "Staging deploy from GitHub"). It builds the Atlas from the
   same checkout (`build-atlas-assets.mjs --src "$GITHUB_WORKSPACE" --build`) and runs the routing test before
   `wrangler deploy --env staging`. Locally, `npm run deploy:staging` does the same build and deploy.
3. Checks (`H=https://staging.commonworld.one`):
   - `curl -sI $H/atlas/assets/atlas.css` → 200, `cache-control: public, max-age=604800`, **no** `x-cw-upstream`.
   - `curl -sI $H/atlas/platforms.json`, `$H/api/v1/index.json`, `$H/.well-known/security.txt` → 200, no `x-cw-upstream`.
   - `curl -sI $H/atlas/` → 200, `x-cw-upstream: atlas-assets`, CSP with `'nonce-…'`; twice → two different nonces.
   - `curl -sI $H/atlas/platforms/1f916` → 308 `location: /atlas/platforms/1f916/`; `$H/atlas` → 301 `/atlas/`.
   - `curl -s -o /dev/null -w '%{http_code}' $H/atlas/nope/` → 404 (Atlas 404 page); `$H/atlas/assets/nope.css` → 404.
   - `curl -sI $H/api/v1/atlas/page/9.json` → 404 with `content-type: application/json; charset=utf-8` (body `{"error":{"code":"not_found",…}}`);
     `curl -sI $H/atlas/page/9/index.md` → 404 with `content-type: text/markdown; charset=utf-8` (no HTML in the body).
   - `$H/privacy/`, `/terms/`, `/about/`, `/stats/` → 200 Atlas pages; `$H/llms.txt` ends with the Atlas text;
     `$H/sitemap.xml` is the index; `$H/robots.txt` disallows all (closed staging).
   - Per-request Workers Logs are off on staging (`invocation_logs = false` in `[env.staging.observability.logs]`), so
     the "one invocation per Atlas view" check of the 2026-10-18 plan (History below) cannot be repeated from the logs.
   - Owner in a real browser: `/atlas/` and one platform page, DevTools console without CSP errors, theme toggle works.
4. Staging rollback: `npx wrangler rollback --env staging`, or `ATLAS_SOURCE = ""` in `[env.staging.vars]` + deploy
   (= the old proxy to `commonworld.pages.dev`).

## History: staging rehearsal plan of 2026-10-18 (kept as written)

Planned before the cutover, when the Atlas lived in the separate `cw-public` repository and A3 was on branch
`feat/atlas-static-assets`. Whether this rehearsal ran on staging before the cutover is not recorded here; the current
check is the section above.

### Staging rehearsal (not done yet; staging was in final QA on 2026-10-18)

1. Merge or check out `feat/atlas-static-assets`; `cd platform && npm ci && npm test && npx tsc --noEmit`.
2. `CW_PUBLIC_DIR=<cw-public on main> npm run deploy:staging`.
3. Checks (`H=https://staging.commonworld.one`):
   - `curl -sI $H/atlas/assets/atlas.css` → 200, `cache-control: public, max-age=604800`, **no** `x-cw-upstream`.
   - `curl -sI $H/atlas/platforms.json`, `$H/api/v1/index.json`, `$H/.well-known/security.txt` → 200, no `x-cw-upstream`.
   - `curl -sI $H/atlas/` → 200, `x-cw-upstream: atlas-assets`, CSP with `'nonce-…'`; twice → two different nonces.
   - `curl -sI $H/atlas/platforms/1f916` → 308 `location: /atlas/platforms/1f916/`; `$H/atlas` → 301 `/atlas/`.
   - `curl -s -o /dev/null -w '%{http_code}' $H/atlas/nope/` → 404 (Atlas 404 page); `$H/atlas/assets/nope.css` → 404.
   - `curl -sI $H/api/v1/atlas/page/9.json` → 404 with `content-type: application/json; charset=utf-8` (body `{"error":{"code":"not_found",…}}`);
     `curl -sI $H/atlas/page/9/index.md` → 404 with `content-type: text/markdown; charset=utf-8` (no HTML in the body).
   - `$H/privacy/`, `/terms/`, `/about/`, `/stats/` → 200 Atlas pages; `$H/llms.txt` ends with the Atlas text;
     `$H/sitemap.xml` is the index; `$H/robots.txt` disallows all (closed staging).
   - Workers Logs (staging has per-request logs until 2026-10-25): opening `/atlas/` in a browser shows **one**
     invocation (`/atlas/`), none for its CSS, JS, thumbnails.
   - Owner in a real browser: `/atlas/` and one platform page, DevTools console without CSP errors, theme toggle works.
4. Staging rollback: `npx wrangler rollback --env staging`, or `ATLAS_SOURCE = ""` in `[env.staging.vars]` + deploy
   (= the old proxy to `commonworld.pages.dev`).

## Vanished list pages: staging drill before release (PR #112)

A list page that vanished because its list got shorter answers a temporary **302** to the list's last page with
`Cache-Control: no-store` (owner decision 2026-10-24 22:19 EEST). HTML 302s run the Worker (`serveAtlasAsset` sets the
header); the `index.md` and JSON 302s are static (run_worker_first negatives) and get the header from the Atlas `_headers`.
Static Assets attaches `_headers` to `_redirects` responses too: `handleRequest` in cloudflare/workers-sdk
`packages/workers-shared/asset-worker/src/handler.ts` ends with `attachCustomHeaders(request, response, …)` for every
response, redirects included, and Miniflare (same code) shows it in `test/atlas-assets.test.ts`. The docs line "redirects
execute before headers … the redirect will win out" means the redirect is served instead of the file. This must still be
seen once on real Cloudflare before production:

1. The normal build has no vanished page (`check.py`: "0 redirect lines for vanished pages"), and the whole Atlas cannot
   shrink without removing cards (growth guard). So the drill shrinks one category in a **throwaway** branch, never merged:
   `python3 atlas/site/tools/vanish_drill.py prepare` moves 2 social cards to `work` (102 → 100 cards: 3 → 2 pages), then
   commit on e.g. `drill/vanish-social` (build + `check.py` pass on it; checked 2026-10-24).
2. Deploy the PR head to staging (Actions → *Deploy platform (staging)*), then
   `python3 atlas/site/tools/vanish_drill.py check --base https://staging.commonworld.one --state full`.
3. Deploy `drill/vanish-social` to staging, then `… check --base https://staging.commonworld.one --state shrunk`:
   `/atlas/categories/social/page/3/`, `/page/3`, `/page/3/index.md` and `/api/v1/atlas/categories/social/page/3.json`
   answer **302** to page 2 with **`cache-control: no-store`**.
4. Deploy the PR head again, then `… --state full`: page 3 is a plain **200** again (no `location`), not shadowed.
5. Every run also checks: `/page/1/` → **301** (no `no-store`); never-existed page 4 of social and page 9 of the whole Atlas
   → **404** in HTML, `index.md` and JSON; `/atlas/page/8/` (+ `index.md`, JSON) → 200. Delete the drill branch after.

If step 3 shows the static 302s **without** `no-store`, the fix is to serve those redirects from the Worker: route the
vanished `index.md` / JSON paths through the Worker (narrow the `!/atlas/*.md` / `!/api/*` negatives in run_worker_first)
and let `serveAtlasAsset` set the header, as it does for HTML. (Without any Cache-Control a 302 is not stored by browsers or
the Cloudflare cache by default, so the effect would be small, but the decision asks for the explicit header.)

`_headers` budget: Cloudflare allows 100 rules. The normal build writes 29; each vanished page adds 2 (its `index.md` and
its JSON page; HTML needs none). So about 35 pages can be vanished at once. `check.py` and
`scripts/build-atlas-assets.mjs` fail the build above 100 rules.

## Launch day and Pages retirement

Done on 2026-10-20 (cutover steps and their record: `../docs/DEPLOY.md`, "First production deploy"). Releases go only through
the `deploy-platform` workflow; the Pages project has automatic deployments off and is kept as a fallback. Still open: deleting
the Pages project together with the `ATLAS_ORIGIN` proxy fallback and `functions/_middleware.js` / `_routes.json`.

The steps as planned:
Owner steps (`../docs/DEPLOY.md`): remove the Pages custom domains, uncomment the production routes, `npm run deploy:production`,
smoke, then switch off the Pages project's automatic deployments (production off, previews none) and deploy through the
`deploy-platform` workflow. Keep the Pages project for a week as the rollback target, then delete it together with the
`ATLAS_ORIGIN` proxy fallback and the repository's `functions/_middleware.js` / `_routes.json`.
