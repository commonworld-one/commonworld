# Deploying the platform

How the Commonworld platform (the Cloudflare Worker and its D1 database, folder `platform/`) gets to
`commonworld.one`. The Atlas is built from this same repository and shipped inside the Worker, so one deploy
releases both.

Production runs on Cloudflare Workers since 2026-10-20: `commonworld.one` and `www` are served by the Worker
`commonworld-api` (Workers Static Assets carry the Atlas). A release is one run of the GitHub workflow
`Deploy platform (production)`, started by hand with a commit sha that is already on `main` and approved by the owner
(see Release flow), and only after the same commit passed a staging deploy + e2e. The old Cloudflare Pages project `commonworld` is no longer used for releases; it is kept only as a
fallback with automatic deployments off (see the cutover section below).

## Environments

| | Staging | Production |
|---|---|---|
| Address | `staging.commonworld.one` | `commonworld.one` (and `www`) |
| Worker | `commonworld-api-staging` | `commonworld-api` |
| Database (D1) | `commonworld-staging` | `commonworld-prod` |
| Who deploys | the maintainers' agent (Hark) or a maintainer, through the GitHub workflow `Deploy platform (staging)` (see [Staging deploy from GitHub](#staging-deploy-from-github)) | the GitHub workflow `Deploy platform (production)`, after the owner's approval |
| Token in GitHub | a staging-only token, as a secret of the GitHub environment `staging` | yes, as a secret of the GitHub environment `production` |

Staging is where every change is tried first. Production is only ever deployed from a commit that is already on
`main`, and only after that exact commit was deployed to staging and passed its smoke test and e2e job (see
[Staging check before production](#staging-check-before-production)).

## Staging deploy from GitHub

Why: Workers Static Assets are uploaded with a short-lived upload JWT in the `Authorization` header
(`POST /accounts/<id>/workers/assets/upload`). In Hark's sandbox an egress proxy injects the Cloudflare API token on
every request to `api.cloudflare.com` and overwrites that JWT, so `npm run deploy:staging` there fails at the asset
upload with `401 Unauthorized` (API-token calls such as D1 migrations still work). A GitHub runner sends the JWT as is.

How: Actions → *Deploy platform (staging)* → *Run workflow*, "Use workflow from" = `main`, field `ref` = the branch or
commit to try. The job checks that `env.staging` in that commit's `wrangler.toml` points only at
`commonworld-api-staging` / `commonworld-staging` / `staging.commonworld.one`, runs typecheck + tests, builds the
Atlas, lists and applies pending staging migrations (scanner in report-only mode), deploys with `--env staging` and
smoke-tests `staging.commonworld.one`. A second job, *E2E against staging (read-only)*, then runs the Playwright suite
(`platform/e2e`, projects `api`, `phone`, `tablet`, `desktop`) from the same commit against `staging.commonworld.one`.
It gets no secrets and no test-citizen keys and sets `CW_E2E_ALLOW_REGISTER=0`, so every spec that writes skips itself;
what runs only reads (plus log-only `POST /v1/csp-report` probes). A failing e2e job turns the whole run red and keeps
the Playwright report as the artifact `staging-e2e-report-<sha>` (14 days).

After its smoke test passes, the deploy job uploads the artifact `staging-deployed-<sha>` (90 days; the file inside
holds the deployed commit). The production workflow looks this artifact up to find the staging run of the commit it is
about to release (see [Staging check before production](#staging-check-before-production)). A re-run of the same commit
replaces it; a re-run that deployed a different commit (the `ref` was a branch that moved) adds a second
`staging-deployed-*` name to the run, and such a run then counts for neither commit.

One-time setup (owner): GitHub → Settings → Environments → New environment `staging`; deployment branches: `main`
only; environment secrets `CLOUDFLARE_API_TOKEN` (a staging-only token, never the production one) and
`CLOUDFLARE_ACCOUNT_ID`. The code from the chosen `ref` runs in the same job as the token, so anyone with write
access who can start the workflow can use that token: keep it staging-scoped.

## Secrets: what lives where

| Secret | Where | Who sets it | What it is for |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub → Settings → Environments → `production` → Environment secrets | owner | Production-only Cloudflare token. Scopes: Account → Workers Scripts: Edit, Account → D1: Edit, Zone `commonworld.one` → Workers Routes: Edit. Nothing else. Separate from the staging token. |
| `CLOUDFLARE_ACCOUNT_ID` | same place | owner | Which Cloudflare account to deploy to. Not secret on its own, kept next to the token. |
| `CW_PRIVATE_TERMS` | GitHub → repository secrets (already used by CI) | owner | Forbidden-text check of the Atlas build. Required: CI on `main` and on same-repo PRs, and the production deploy, stop without it; only PRs from forks and Dependabot update PRs (GitHub gives neither Actions secrets) skip the check with a warning. |
| `KEY_PEPPER` | **only in Cloudflare**, as a secret of the Worker `commonworld-api` | owner | Hashes API keys, login links, sessions and IPs. **Never in GitHub**, never in a commit, issue, log or chat. The workflow neither needs nor sees it. |

Because the Cloudflare token is an *environment* secret, GitHub hands it to the job only after the approval. A
workflow run on a pull request, a fork or any other branch never gets it.

## Release flow

1. **Branch.** Work happens on a branch, never directly on `main` for platform code.
2. **Pull request.** Open a PR into `main`. CI (`ci`, `quality` and the other checks) runs on it.
3. **Reviews.** At least one independent review besides the author (a person or a separate review agent). The
   code owner (`.github/CODEOWNERS`) is asked automatically for `/platform/` and `/.github/`.
4. **Try it on staging (optional, recommended).** The branch can be deployed to staging and checked there before
   the merge. This run does not count for production: after the merge the commit on `main` usually has another sha.
5. **Merge** into `main`.
6. **Staging with the same commit.** Actions → *Deploy platform (staging)* → *Run workflow*, "Use workflow from" =
   `main`, `ref` = the full 40-character sha of the `main` commit to release (a sha, not the branch name `main`, so a
   push in between cannot change what is deployed). Wait until the whole run is green: deploy, smoke test and the job
   *E2E against staging (read-only)*. While a release is in progress, staging holds `main`: trying other branches on
   staging waits until the production deploy is done.
7. **Start the production deploy.** The owner opens Actions → *Deploy platform (production)* → *Run workflow*, keeps
   the branch on `main` and pastes the same full sha. The field *allow_destructive_migration* stays empty (see
   [Database migrations](#database-migrations-expand--deploy--contract)); *emergency_skip_staging_check* stays off and
   *emergency_reason* empty (see [Emergency override](#emergency-override)).
8. **Approve.** The run checks that the sha is on `main`, that `platform/` exists and that the same sha passed
   staging (next section), then stops at the `production` environment. The owner reviews and clicks
   *Approve and deploy*. Nothing waits for approval if the staging check fails.
9. **The job then:** checks out exactly that commit → installs → typecheck → tests → reads `atlas/screens.lock`
   at that commit and fetches exactly that `atlas-screens` commit (it must be on the `atlas-screens` branch) →
   builds the Atlas into the Worker's assets → writes the **release manifest** → **migration gate** → prints the
   database's Time Travel bookmark → applies pending D1 migrations → `wrangler deploy --env production` → smoke
   test (`/`, `/health` must say `"environment":"production"`, `/api/v1/index.json`, each must answer 200).

### Staging check before production

The gate job (*Check the commit*, before the approval) refuses the sha unless a staging run proves it. It has
`actions: read` for this (only that job; the deploy job keeps `contents: read`) and uses the GitHub API:

1. List artifacts named `staging-deployed-<sha>` (uploaded by the staging deploy job after its smoke test passed).
2. For each run they belong to, newest first, all of these must hold:
   - it is a run of `.github/workflows/deploy-staging.yml`, event `workflow_dispatch`, started from `main`, completed
     with conclusion `success`;
   - in its latest attempt, the jobs *Deploy to staging* and *E2E against staging (read-only)* both succeeded (the e2e
     job tests the commit the deploy job shipped, not the `ref` again);
   - no attempt of that run deployed another commit (exactly one `staging-deployed-*` artifact on the run);
   - it finished at most **7 days** ago (measured from the run's completion time, `updated_at`, to the moment the
     production gate runs).
3. The first run that passes is linked in the run summary and written into the release manifest
   (`staging_check: passed`, `staging_run`). If none passes, the run stops with an `::error::` that says why for each
   candidate and what to do (release order above).

Freshness limit: a green staging run counts only if it finished at most 7 days ago (the sha fixes the code, but
staging data, Cloudflare and dependencies move on). An older run is refused with an `::error::` that names its
completion time and age; deploy the same sha to staging again and wait for deploy + e2e. Deleting the run or its
artifact also removes the proof (artifacts are kept 90 days, longer than the limit).

### Emergency override

Only for an urgent fix that cannot wait for a staging deploy + e2e (for example production is down). Start the
production run with **emergency_skip_staging_check** on and **emergency_reason** = one line saying why. Rules:

- The override without a reason, or a reason with a line break, stops the run. A reason without the override is
  ignored with a warning (the check runs as usual).
- The override skips only the staging check. Everything else stays: the sha must be on `main`, the `production`
  approval, typecheck, tests, the Atlas build, the migration gate (*allow_destructive_migration* is a separate,
  independent override), the Time Travel bookmark, the smoke test.
- The reason is printed at the top of the gate's and the deploy job's summary under **EMERGENCY OVERRIDE**, shown as a
  warning annotation, and recorded in the release manifest (`staging_check: overridden`, `emergency_reason`), so every
  bypass stays visible in the run and in the 90-day manifest artifact. The summary also says whether a green staging
  run of the sha existed anyway.
- After an override release, deploy the same sha to staging as soon as possible and check the e2e result.

Trade-offs (decided 2026-10-26, #145): a release takes longer by one staging deploy + e2e run, and staging is busy with
`main` during a release; in exchange a production break is caught on staging before people see it.

### What a release is made of

The sha alone decides everything that goes live:

| Part | Comes from |
|---|---|
| Platform code (Worker, migrations) | the release sha |
| Atlas data | the same sha |
| Homepage screenshots | the `atlas-screens` commit written in `atlas/screens.lock` at the release sha |

The **release manifest** records the three shas, the staging check result (the staging run, or the emergency reason),
the sha256 of the built Atlas assets (`platform/.atlas-dist` packed
as a byte-reproducible `tar.gz`: sorted names, mtime 0, owner 0, `gzip -n`) and the wrangler version. It is printed
in the run's summary and kept 90 days as the artifact `release-manifest-<sha>`.

`atlas/screens.lock` is one line: the full sha of an `atlas-screens` commit. The weekly screenshots PR
(`screens.yml`) goes into the `atlas-screens` branch; after it is reviewed and merged, a separate PR on `main` bumps
`atlas/screens.lock` to the new `atlas-screens` commit. CI builds with the locked commit and shows a notice when
`atlas-screens` has newer commits than the lock.

Only one production deploy runs at a time; a second one waits, a running one is never cancelled.

### MCP server (`/mcp`)

`/mcp`, `/mcp.md`, `/mcp.json` and `/.well-known/mcp.json` are served by the Worker (`run_worker_first` `/*`; no negative
Atlas pattern matches them). Since 2026-10-21 the well-known negative pattern is only `!/.well-known/security.txt`
(was `!/.well-known/*`), so the deploy that ships `/.well-known/mcp.json` also ships that `wrangler.toml` change; other
unknown `/.well-known/*` paths then cost one Worker request each (Atlas 404). No new binding, secret or migration. Optional var
`MCP_ALLOWED_ORIGINS` (comma list) narrows the browser origins allowed on `/mcp`; unset = any well-formed origin.
After a deploy, check: `curl -s -X POST https://<host>/mcp -H 'content-type: application/json' -d
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'` answers 200 with
`serverInfo.name` `commonworld`, and `GET /mcp` with `Accept: text/event-stream` answers 405. Details: `platform/docs/MCP.md`.

## Database migrations: expand → deploy → contract

Migrations are applied **before** the new Worker goes live, so while they run (and after any Worker rollback) the
database is used by the code that is running now. Rules:

- **Every migration must be backward compatible with the currently running Worker.** Allowed in a normal release:
  new tables, new columns that are nullable or have a constant non-NULL default (a `NOT NULL` column without
  one, `PRIMARY KEY`, `UNIQUE` or `STORED` columns are refused by SQLite and stop the gate), new indexes.
- **Changing existing rows always needs the owner.** Any `UPDATE`, `DELETE`, `REPLACE INTO`, `INSERT OR REPLACE` or
  upsert (`ON CONFLICT … DO UPDATE`), with any `WHERE` and also inside `WITH …` or a trigger body, is a *row-write*.
  The gate does not try to judge whether a `WHERE` is safe (decided by the owner on 2026-10-20 after
  `WHERE length('a') = 1` slipped past the earlier heuristics). A row-write migration passes only with **both**:
  1. a line `-- reviewed-by-owner: #<PR>` in the file's header (the comment lines before the first SQL statement),
     added in the PR the owner reviewed (`.github/CODEOWNERS`), and
  2. the one-release override below (*allow_destructive_migration* = the release sha typed again), which can only be
     used after the `production` environment approval.

  Either one alone keeps the gate closed. The marker is a declaration checked by people in review, not something the
  script can verify: that is the point, a human has to have looked.
- **Destructive changes ship in a later release**, after the code no longer uses what they remove: first release
  stops reading/writing the column or table (expand + deploy), a following release drops or renames it (contract).
- **The gate.** Before any migration runs, the workflow lists the migrations not yet applied in production
  (`wrangler d1 migrations list commonworld-prod --remote --env production`) and runs
  `scripts/check-migrations.py` on them. The script reads the SQL with a small tokenizer (comments, string literals
  and quoted names are handled, statements split on top-level `;`) and stops the run on:
  - **destructive:** `DROP TABLE`, `ALTER TABLE … DROP`, `ALTER TABLE … RENAME`;
  - **row-write:** every `UPDATE` / `DELETE` / `REPLACE INTO` / `INSERT OR REPLACE` / upsert `DO UPDATE` (see above;
    needs the owner marker as well as the override);
  - **review-required:** `DROP INDEX`, `DROP TRIGGER`, `DROP VIEW`, and an `ADD COLUMN` SQLite would refuse at apply
    time (`NOT NULL` without a non-NULL default, `PRIMARY KEY`, `UNIQUE`, `STORED`, or a non-constant default such
    as `CURRENT_TIMESTAMP` or `(CURRENT_TIMESTAMP)`; the script asks SQLite itself whether the default is accepted);
  - **unknown:** SQL it cannot read or a statement kind not on its known-safe list (fail closed).

  It also stops the run if the wrangler list cannot be read exactly: an error line, a table line it cannot parse, a
  listed name that is not a local file, a `*.sql` name outside the table, or pending names that are not the newest
  local migration files in order. It is a safety net, not a replacement for reading the migration.
- **Override, one release only** (any finding, every class; a row-write also needs its owner marker): start the run with
  *allow_destructive_migration* = the same 40-character sha typed a second time. Anything else (empty, `yes`, a short sha) keeps the gate closed.
  Only for a contract step whose code side is already live.
- **Restore = D1 Time Travel** to the bookmark the run printed (step *Time Travel bookmark before migrations*, also
  in the run summary). In `platform/`, with the production token:

  ```sh
  # what the run printed (also shows the bookmark for the current moment)
  npx wrangler d1 time-travel info commonworld-prod --env production
  # bookmark for a moment in time, if the printed one is lost: an ISO time in UTC (trailing Z) or a unix timestamp.
  # It must lie inside the D1 Time Travel window (30 days on Workers Paid, 7 on Free).
  # Put your value between the single quotes; the quotes keep the shell from reading it as anything else.
  TS='paste-an-ISO-UTC-time-here'
  npx wrangler d1 time-travel info commonworld-prod --env production --timestamp="$TS"
  # restore: overwrites the live database, owner decision only. Paste the bookmark between the single quotes.
  BOOKMARK='paste-the-bookmark-here'
  npx wrangler d1 time-travel restore commonworld-prod --env production --bookmark="$BOOKMARK"
  ```

  Roll the Worker back first (below) if the new code needs the new schema, then restore the database.
- **Drill it on staging before the first production use:** apply a test migration on `commonworld-staging`, note
  the bookmark, restore it with the same commands (`commonworld-staging`, `--env staging`) and check the data and
  the staging Worker. Only then rely on it for production.

- **Baseline (historical migrations).** `0008_section_groups.sql` (backfills `sections` with `UPDATE`, written before
  the owner marker existed), `0009_free_tags.sql` and `0018_ai_bot_verified.sql` (table rebuilds: `DROP TABLE` +
  `RENAME`) were applied to staging before the gate existed. They are listed in `BASELINE` in
  `scripts/check-migrations.py`, each pinned by the sha256 of the file and by the full list of its findings: while
  pending they are reported as a notice and do not block, so a database rebuilt from empty passes with the override
  left empty. If one of these files is edited it loses the baseline and is checked like a new migration, even when its
  sha256 is re-pinned (a new statement is not in the written-out findings). Every other file, and every new migration,
  gets the full rule above. Never add a new migration to `BASELINE`; never edit the historical files. The unit tests pin
  the list, the hashes and the findings independently and compare each file with its content at commit `6803510`.

The scanner runs in CI too (report only), and its unit tests are `tests/test_check_migrations.py`.

### Rebuild from an empty database

For the first production deploy (empty `commonworld-prod`), a new staging database, or a local check. Every migration
is pending; the gate passes without the override because the only historical findings are in the baseline.

1. Check locally first, in the repo root (no Cloudflare access needed):

   ```sh
   python3 scripts/check-migrations.py --dir platform/migrations --all
   ```

   Expected: three `::notice` lines (`0008`, `0009`, `0018`, "baseline"), no `::error`, exit code 0. An `::error`
   here means a new or edited migration needs review: stop and fix that first.
2. Optional dry run of the SQL itself on an empty local D1 (in `platform/`):
   `npx wrangler d1 migrations apply commonworld-prod --local --env production` (writes only to `.wrangler/state/`).
3. Production: Actions → *Deploy platform (production)* → the `main` sha, **`allow_destructive_migration` empty** →
   approve. The step *Migration gate* lists all migrations as pending and prints the same three notices.
4. A new staging database: `npx wrangler d1 migrations apply commonworld-staging --remote --env staging` (staging has
   no gate; run step 1 first anyway).

If the gate fails on an empty database, do not use the override to get past it: read which file it names.

## First production deploy (cutover from Cloudflare Pages) — DONE 2026-10-20

**Status: done.** The cutover ran on 2026-10-20; `commonworld.one` and `www` are now served by the Worker
`commonworld-api`. The steps below are kept as the record of what was done and as the way back. Since 2026-10-21 the
Pages project `commonworld` has **automatic deployments off**: it is kept only as a fallback and no longer builds on
push, so a rollback to Pages (step 5) serves whatever build it last made, a stale one, unless it is redeployed by hand
first.

Until the first deploy `commonworld.one` and `www` are Custom Domains of the Pages project `commonworld`, served
through two proxied DNS records `CNAME commonworld.one → commonworld.pages.dev` and `CNAME www → commonworld.pages.dev`.
The Worker `commonworld-api` takes both over (`routes` in `[env.production]`). A Worker Custom Domain cannot be created
on a hostname that still has a CNAME, so the DNS records go first. All steps by the owner, in this order:

1. **Secret.** `KEY_PEPPER` on the Worker `commonworld-api` (random, at least 32 characters), in `platform/`:
   `openssl rand -hex 32 | npx wrangler secret put KEY_PEPPER --env production`. The value is never shown, stored or
   sent anywhere else. If the Worker does not exist yet, wrangler offers to create it: say yes. That creates and
   deploys an **empty placeholder version** (a bare `fetch()`, no routes, so nothing public changes). It is **not** a
   recovery point: the deploy run's summary may list it as "Production version before this deploy"; never roll back
   to it, the recovery for the first deploy is step 5 below.
2. **Write down what you will restore.**
   1. The two DNS records (Cloudflare → `commonworld.one` zone → DNS → Records): name, target `commonworld.pages.dev`,
      Proxied. They are also in the ops DNS backup of 2026-10-16.
   2. Where today's `www` → apex `301` comes from. Pages does not do it (`functions/_middleware.js` only adds the CSP
      nonce, `_redirects` only has the Privacy/Terms moves), so it is a Cloudflare rule: zone → Rules → Redirect Rules,
      or account → Bulk Redirects. Note its name and **leave it on**: it keeps working for the Worker (a redirect rule
      answers before the Worker, the Worker's own redirect is then never reached) and for the way back in step 5.
      If no such rule exists, create one before the cutover so the fallback has a `www` redirect too: Redirect Rules →
      Create rule (custom, not the *Redirect from WWW to root* template, which matches every `www.*` host) → when
      `Hostname equals www.commonworld.one` → Dynamic, `concat("https://commonworld.one", http.request.uri.path)`,
      301, preserve query string. Exactly that host, like the Worker's own redirect.
3. **Cut over (site down from here until step 4 passes, a few minutes):**
   1. DNS → delete the `CNAME commonworld.one` and `CNAME www` records.
   2. Workers & Pages → `commonworld` (Pages) → Custom domains → remove `commonworld.one` and `www.commonworld.one`.
4. **Deploy.** Actions → *Deploy platform (production)* → the `main` sha, `allow_destructive_migration` empty →
   approve. The database is empty, so every migration is pending; the gate passes without the override (see
   *Rebuild from an empty database*: run its step 1 locally before the cutover). `wrangler deploy` creates both Custom Domains with their DNS records and certificates. The smoke test
   checks `/`, `/health` (`"environment":"production"`), `/api/v1/index.json`, `/robots.txt`, `/sitemap.xml` (a sitemap index),
   `/sitemap-v1.xml`, `/atlas/sitemap.xml`, the IndexNow key file and `www` → `301` apex.
5. **If the deploy or the smoke test fails** (whether or not the Worker went live), go back to Pages:
   1. Workers & Pages → `commonworld-api` → Settings → Domains & Routes → remove both Custom Domains (this also
      removes the DNS records the Worker created).
   2. DNS → add the two records from step 2 again (`CNAME`, target `commonworld.pages.dev`, Proxied).
   3. Workers & Pages → `commonworld` (Pages) → Custom domains → add `commonworld.one` and `www.commonworld.one`;
      wait until both are Active.
   4. Check: `curl -sI https://commonworld.one/atlas/` → `200` with `server: cloudflare` and no `/health` JSON from
      the Worker (`curl -s https://commonworld.one/health` is the Pages 404 page), `curl -sI https://www.commonworld.one/`
      → `301` to the apex (the redirect rule from step 2.2). Then read the failed run's log and fix before trying again.
6. **After a green run:** first admin (account through the API, role by one SQL line on `commonworld-prod`),
   `GET /v1/admin/backups`, uptime monitor, WAF / rate limits, billing alerts, Search Console (sitemaps, indexing)
   and Bing Webmaster. The Pages project stays (not deleted) as the fallback.

## Rollback

- **Code:** every run prints the production version that was live **before** it (step *Production version before
  this deploy (for rollback)*, also in the run summary, with the ready-made command). In `platform/`, with the
  production token:

  ```sh
  # the version id from the run summary, pasted between the single quotes; -m is the reason, -y skips the confirmation prompt
  VERSION_ID='paste-the-version-id-here'
  npx wrangler rollback "$VERSION_ID" --env production -m "reason" -y
  # without an id wrangler picks the previous version itself and asks to confirm
  npx wrangler rollback --env production -m "reason"
  # if the summary is lost: what is live now, and the 10 most recent versions with their ids
  npx wrangler deployments status --env production
  npx wrangler versions list --env production
  # forward again to a newer version (set VERSION_ID to that version's id first, as above)
  npx wrangler versions deploy "$VERSION_ID@100%" --env production -m "reason" -y
  ```

  Syntax checked with the pinned wrangler 4.151.1 (`--help`): the version id is an optional positional argument,
  `--env` is accepted (it selects the Worker name of `[env.production]`; `--name <worker>` also works). Or run the
  workflow again with an older sha from `main`.
- **Database:** a Worker rollback does **not** undo migrations, which is why every migration must stay compatible
  with the previous Worker version (see above). If data must be restored, use D1 Time Travel with the bookmark
  printed by the deploy run (commands above). This overwrites the live database, so only on the owner's decision.
- **The very first production deploy** has no earlier working version to roll back to; that case follows the
  launch runbook (routes off, domains back to the previous host).

## Who can approve

Required reviewer of the `production` environment: the repository owner (`@nerd27dk`). The owner is the only
required reviewer and also the one who starts the run, so the environment setting **"Prevent self-reviews" stays
off, by design, for now** (single maintainer): with it on, nobody could approve a deploy. Revisit this when a second
maintainer exists: then turn "Prevent self-reviews" on and add that maintainer as a reviewer. Nobody else, and no
bot or agent, can approve a production deploy. Agents can prepare releases (branch, PR, staging, the sha to deploy),
never approve them.
