Dependabot update lifecycle: executable procedure
==================================================

How a routine Dependabot dependency update becomes a verified production deploy
on the Commonworld platform (repo: https://github.com/commonworld-one/commonworld),
with every step gated by an explicit owner approval. Written so that any agent
can read it, check every source, and run the full chain.

Executed end to end for PR #287 (wrangler 4.155.0 -> 4.156.2, /platform
devDependencies) on 2026-11-06; that run is the example set. The observed run's
facts and links were verified on 2026-11-06 against main @
042d901b5912590a67e89a66a00f11224166f54e and the GitHub API. Commands and routes
shown from their owning sources are [RULE] citations, not re-executions.

Scope: a ROUTINE devDependency batch (version bumps in platform/package.json +
package-lock.json only). "Routine" never means risk-free: a build- or
deploy-tool bump (wrangler is exactly that) changes the tooling that builds and
ships production, which is why Step 1 reviews the tool's own changes, not just
CI. A PR that touches migrations, source, workflows or runtime (non-dev)
dependencies leaves this path: same gates, deeper owner review, and the
migration rules in docs/DEPLOY.md apply in full.

Conventions
-----------
- [RULE]     = written repo source, linked.
- [CI]       = enforced by the repo's own workflows, linked.
- [PRACTICE] = maintainer habit observed across runs, not a written mandate.
- [OBSERVED] = a verified fact of the 2026-11-06 run (one data point, not a
  universal rule).
- [TEMPLATE] = a URL shape with placeholders (<N>, <sha>); not fetched as-is.
  Non-template links were checked on 2026-11-06; re-check them when executing.
- Every step: Prerequisites / Action / Readiness gate (where to look, what
  exactly must match, when to stop) / GO.
- GO means an explicit, scoped human approval. A GO covers only the action it
  answers; no upstream yes covers a downstream step. Every public or external
  write (comment, tag push, merge, workflow dispatch, backup run) is requested
  with its exact content BEFORE the action and carries its own GO. Nothing is
  retried, deleted or re-created automatically: a failed or stale write is
  reported and re-authorized, not silently repeated.
- Report the moment a write lands, then report checks separately as they
  finish; never hold a landed action (a merge, a dispatch) until checks
  complete [OBSERVED: expectation set during the 2026-11-06 run].
- English only in the repo: code, data, commit messages, PR text, docs
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/AGENTS.md].


Step 0. Identities and decision rights
--------------------------------------
- The owner (GitHub account nerd27dk) makes every merge and deploy decision.
  The written repo rule: "Nothing merges or deploys without the owner's
  explicit decision" and "Agents never merge, never force-push main, never
  bypass checks"
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/AGENTS.md].
  That rule stands, and this procedure gives no agent a merge path: an agent
  prepares, verifies and reports; the owner performs every merge. In the
  observed run the tag, the #287 squash merge and the two deploy dispatches
  are recorded under the team's GitHub App cw-instinct[bot]; GitHub metadata
  records the acting account, and the one-off arrangement behind it was the
  owner's personal decision for that run alone, deliberately outside this
  written procedure [OBSERVED:
  https://github.com/commonworld-one/commonworld/pull/287,
  https://github.com/commonworld-one/commonworld/actions/runs/42187809698].
- The production environment approval is personal: only the owner, as the
  environment's required reviewer, clicks "Approve and deploy". No bot or agent
  can approve a production deploy
  [RULE: docs/DEPLOY.md, "Who can approve";
   https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/deploy-platform.yml].
- dependabot[bot] opens the update PRs; after a sibling merges it may rebase
  the rest onto the new main (force-push notifications are routine, not new
  work items), but this is observed behavior, not a guarantee - a conflicting
  or stale sibling can need an explicit rebase request or owner attention
  [OBSERVED: after the #287 merge, #288, #289, #290 received new heads].
- chatgpt-codex-connector[bot] runs the requested code review. In two observed
  runs only the owner account's `@codex review` comment started a review;
  cw-instinct[bot]'s identical comment was refused
  [OBSERVED, 2026-11-05 and 2026-11-06: PR #283 and PR #287 issue comments].
- The platform's on-demand backup routes are admin-only: any account with an
  active admin role and its API key can call them
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/platform/src/routes/admin-backups.ts].


Step 1. Triage the Dependabot batch
-----------------------------------
Prerequisites: one or more open Dependabot PRs.

Action, for each PR:
1. Read the full file list (PR -> Files changed, or
   `gh api repos/commonworld-one/commonworld/pulls/<N>/files`) and the head
   sha. The routine path expects package.json + package-lock.json only. STOP
   and escalate if the diff adds migrations (platform/migrations/), source,
   workflow files, or runtime (non-dev) dependencies.
2. Review what the bump actually brings, beyond CI: the package's own release
   notes / changelog for the version range, and the lockfile diff's transitive
   additions. Judge the tool's role in the deploy path: a test-only library and
   the tool that builds and deploys the Worker carry different weight.
   Cross-check platform/wrangler.toml's pinned compatibility_date: a wrangler
   bump does not move the runtime behavior date
   [RULE: https://github.com/commonworld-one/commonworld/blob/main/platform/wrangler.toml;
   OBSERVED: compatibility_date "2026-10-01" unchanged by #287; the wrangler
   4.155.0 -> 4.156.2 changelog review found no breaking change for this repo's
   usage, 2026-11-06].
3. Confirm no automation will merge the PR: the per-PR auto-merge flag
   (`gh api repos/commonworld-one/commonworld/pulls/<N>` -> auto_merge is null)
   and no auto-merge workflow - the Dependabot config file alone does not prove
   this [OBSERVED 2026-11-06: weekly config, auto_merge null on #287-#290, no
   auto-merge workflow].
4. CI green on the CURRENT head sha. CI is necessary, never sufficient: it does
   not replace the changelog/compatibility review above.

Readiness gate: for each PR you can state: exact file list, head sha,
changelog/compatibility verdict with source, auto-merge status, CI state on
that sha, and whether it fits the routine path.

GO: the owner picks which ONE PR ships first. Batch decisions are per-PR: the
observed run shipped #287 alone while #288-#290 stayed parked.


Step 2. Codex review on the PR
------------------------------
Prerequisites: Step 1 GO for this PR.

Action: the owner posts the comment `@codex review` on the PR (each invocation
is its own GO). An invocation is not a result: wait for the receipt comment
from chatgpt-codex-connector[bot].

Readiness gate: the receipt names the CURRENT head sha and reports no major
issues; the bot's structured summary shows has_any_findings: false; zero inline
review comments. Note what the receipt is and is not: a code review of the
diff, not a security audit (the observed summary's security_review field was
null) [OBSERVED: PR #287 receipt 2026-11-06T07:52:29Z, "Reviewed commit
83bece7db1", matching the head 83bece7db1f3dd916b37aea9f738d522245df8f3;
https://github.com/commonworld-one/commonworld/pull/287#issuecomment-6680030320].
STOP if the receipt sha lags the head or findings appear: fix only with a
scoped GO, then the owner requests a fresh review of the new head.


Step 3. Pre-merge rollback tag
------------------------------
Prerequisites: Step 2 green; the owner has decided to merge THIS PR.

Action [PRACTICE]: with its own GO, tag the CURRENT head of main
<scope>-pre-pr<N>-<yyyymmdd> (scope = the area the PR touches; convention
observed back to atlas-pre-pr40-2026-10-21; date formats vary). Verify the ref
exists remotely and points at the intended sha
(`gh api repos/commonworld-one/commonworld/git/refs/tags/<name>`).
Observed example: platform-pre-pr287-20261106 -> 06fd5d7f3ea88a1c768412e5fbb08ac762fd75e5
(https://github.com/commonworld-one/commonworld/tree/platform-pre-pr287-20261106).

Readiness gate: the tag ref exists and its sha equals main's current head.
Coverage, stated exactly: the tag pins main - platform code and the Atlas data
in git. It does NOT cover the atlas-screens orphan branch (homepage screenshots
live there; their version is pinned by atlas/screens.lock), and it is not a
database backup and not a site rollback by itself.


Step 4. Merge
-------------
Prerequisites: Steps 2-3 green.

Action, in order:
1. Re-verify SECONDS before merging: PR head still the reviewed sha, PR base
   still exactly the tagged sha, mergeable_state clean, CI green on the head.
   STOP on any drift and report.
2. The owner decides AND performs the merge (Step 0; an agent never merges).
   Use the repo's observed convention: squash (recent main history is
   single-parent commits titled "... (#N)"). The 2026-11-06 run is recorded
   differently: the #287 squash merge of 2026-11-06T08:05:01Z is recorded
   under cw-instinct[bot], a one-off arrangement for that run alone, outside
   this procedure [OBSERVED:
   https://github.com/commonworld-one/commonworld/commit/042d901b5912590a67e89a66a00f11224166f54e].
3. Verify through the API: PR state closed/merged, merge_commit_sha recorded,
   the merge commit's first parent equals the tagged pre-merge base.
4. Watch the post-merge CI on main: every check green. Expect the outbound-link
   sweep (links-external) to be the slow one (observed ~7 minutes; the rest
   finished in ~3) [OBSERVED: 9/9 success on 042d901].

Readiness gate: merge verified AND post-merge CI fully green. Note for the
batch: after a sibling merges, Dependabot may rebase the remaining PRs onto the
new main (observed, not guaranteed); whatever happens to their heads, earlier
CI greens and Codex receipts never carry to a new head - each later merge needs
fresh CI and a fresh Codex review [OBSERVED: #288-#290 received new heads
2026-11-06 ~08:07 UTC].


Step 5. Staging deploy and staging verification
-----------------------------------------------
Prerequisites: Step 4 verified; the merge sha known.

Action: with a scoped GO, dispatch Actions -> "Deploy platform (staging)" ->
Run workflow: "Use workflow from" = main (this ref selects where the workflow
FILE comes from), and the workflow INPUT named `ref` = the FULL 40-character
merge sha (a sha, not the branch name, so a push in between cannot change what
deploys)
[RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/deploy-staging.yml].
The workflow deploys ONLY the staging Worker + staging D1 (it stops if
wrangler.toml at that ref maps otherwise). Credentials, stated exactly: the
deploy job uses the staging-environment Cloudflare token, which must be a
staging-only token, never the production token; the e2e job gets no secrets,
and its write-specs self-skip, so the e2e does not modify staging data
[RULE: deploy-staging.yml header]. After the deploy the workflow runs the smoke
test, the route smoke list and the read-only Playwright e2e suite.

Readiness gate, two parts:
(a) Run green end to end; the artifact staging-deployed-<sha> exists and names
    exactly your sha - the production gate will require it
    [RULE: docs/DEPLOY.md, "Staging check before production"].
(b) Look at staging itself: https://staging.commonworld.one/ answers 200 and
    the rendered homepage looks right (real layout, plausible staging numbers),
    not only a status code [OBSERVED: run
    https://github.com/commonworld-one/commonworld/actions/runs/42186482738,
    2026-11-06, deploy + smoke + route smoke + e2e all success, ~6 minutes].
STOP on any red job or a broken render: fix forward; the production gate
refuses a sha whose green staging run is older than 7 days.


Step 6. Fresh production backup before the release
--------------------------------------------------
Prerequisites: Step 5 green; the owner wants a fresh restore point beyond the
daily 03:00 UTC dump and D1 Time Travel. How fresh is fresh enough is the
owner's decision at deploy time, weighed against the writes since the newest
dump [OBSERVED 2026-11-06: backup at 10:26 Riga for a 10:33 deploy; the morning
dump would have left ~5.5 hours of writes to Time Travel alone].

Action: with a scoped GO that discloses the same-day caveat, run the backup
through the platform's own admin API - the same runBackup() code as the daily
cron, no new credentials, no local dump files:
  POST https://commonworld.one/v1/admin/backups/run  {"job": "backup"}
then verify it immediately:
  POST https://commonworld.one/v1/admin/backups/run  {"job": "restore-check"}
and confirm on GET /v1/admin/backups: healthy true, problems empty, the newest
backup's created_utc is your run
[RULE: https://github.com/commonworld-one/commonworld/blob/main/platform/src/backup.ts,
 https://github.com/commonworld-one/commonworld/blob/main/platform/src/routes/admin-backups.ts].
Caveat to disclose WITH the GO: R2 keys are date-only (<env>/d1/YYYY-MM-DD.sql.gz),
so a same-day manual run REPLACES that morning's dump object with the fresher
one; older days are untouched [OBSERVED: approved and executed 2026-11-06].
What the check proves and does not: the dump file is whole, parses fully, and
its row counts and counters match the manifest - a parse-level verification,
NOT a full restore into a scratch database (that drill is a separate decision)
[RULE: platform/docs/ops/BACKUP-RESTORE.md, sections 2-3].
Data handling: the dump contains all public content plus account credential
hashes; on this path it never leaves the private R2 bucket (35-day lifecycle).
Nothing is downloaded, committed or pasted anywhere
[RULE: platform/docs/ops/BACKUP-RESTORE.md].

Readiness gate: backup ok true with bytes/tables/rows recorded [OBSERVED:
862,619 bytes, 38 tables, 45,379 rows, 2026-11-06T08:26:06Z]; restore-check
ok true against THE FRESH dump (age_hours 0), result stored at
prod/checks/<date>.json [OBSERVED: prod/checks/2026-11-06.json].


Step 7. Production deploy
-------------------------
Prerequisites: Step 5 fully green and at most 7 days old (the workflow's hard
gate); Step 6 backup fresh enough per the owner's decision (Step 6).

Action:
1. Owner release review: the owner reviews the exact sha; a release ships all
   of main at that sha, not only this PR (platform code and Atlas data from the
   sha, screenshots from the atlas-screens commit pinned in atlas/screens.lock
   at that sha) [RULE: docs/DEPLOY.md, "What a release is made of"].
2. Migration state, two distinct moments. PREFLIGHT (read-only, before
   dispatch): list platform/migrations/ at the selected sha and confirm the
   routine expectation - this PR adds none and no unrelated pending migrations
   are expected at that sha. Anything else goes to the owner before dispatch.
   This preflight is owner POLICY for a routine release, not a code guarantee.
   ACTUAL ENFORCEMENT (after the approval, inside the deploy job, with the
   production token): the migration gate scans the SQL pending against the
   deployed database and stops the run on destructive, row-writing,
   review-required or unreadable migrations; ordinary pending migrations are
   APPLIED by design - they do not stop the run
   [RULE: deploy-platform.yml header and steps "Migration gate" / "Apply
   database migrations"; docs/DEPLOY.md, "Database migrations"].
3. With the owner's GO, dispatch Actions -> "Deploy platform (production)":
   "Use workflow from" = main, and the workflow INPUT named `sha` = the full
   40-character sha; allow_destructive_migration empty,
   emergency_skip_staging_check off. The gate job re-verifies the sha is on
   main and finds the green staging proof; it is read-only.
4. The deploy job then WAITS at the `production` environment: no Cloudflare
   secrets reach the runner before approval. The OWNER personally clicks
   "Review deployments" -> production -> "Approve and deploy" on the run page
   [RULE: deploy-platform.yml; docs/DEPLOY.md, "Who can approve"].
5. Only after that tap does the job: print the live Worker version id and the
   ready-made rollback command -> record the D1 Time Travel bookmark -> apply
   pending migrations -> deploy the Worker -> run the smoke test and the
   production route smoke list.

Readiness gate: the run is green end to end [OBSERVED: run
https://github.com/commonworld-one/commonworld/actions/runs/42187809698 -
gate success, owner approval 2026-11-06T08:30Z, run success 08:33:37Z; smoke
18/18 tests, route smoke list 30 routes, zero migrations applied at 042d901].
Record from the run summary for the rollback reference: the PREVIOUS Worker
version id, the new version id, and the Time Travel bookmark. Keep the actual
values in the run summary and the owner's private ops records - published docs
carry the placeholder, not the values (same convention as BACKUP-RESTORE.md's
"<bookmark>").
STOP on any red step: the run summary's printed version id and rollback
command are the first remedy; see the Rollback reference.


Step 8. Live verification (last operational step)
-------------------------------------------------
Prerequisites: production run green.

Action and readiness gate: check the live surfaces and keep the evidence (open
the page and look; do not trust status codes alone):
- https://commonworld.one/ answers 200 and the homepage renders correctly with
  live data (layout, stat cards, sections, feed) [OBSERVED 2026-11-06: verified
  by screenshot after the #287 deploy].
- Cross-check the release manifest artifact (release-manifest-<sha>): its
  platform_sha and atlas_data_sha equal the deployed merge sha, and its
  screens_sha equals the content of atlas/screens.lock at that sha; a screen
  image pinned by that commit serves live [OBSERVED 2026-11-06: manifest of run
  42187809698 - platform_sha = atlas_data_sha = 042d901b..., screens_sha =
  e0f4e1ab38c36bd71b1af3e7c5937dc51bd2f17a = screens.lock at 042d901, and
  https://commonworld.one/atlas/screens/agent-knowledge-network.webp answers
  200 image/webp. The manifest also records the deploying wrangler version
  itself: 4.156.2 - direct evidence the bumped tool built this release].
- The deploy run's smoke outputs are green (Step 7 gate).
STOP on any mismatch: decide fix-forward vs rollback with the owner before any
further action.


Rollback and failure reference (consult from any step)
------------------------------------------------------
- Worker rollback: from `platform/`, with the production token:
  `npx wrangler rollback <PREVIOUS_VERSION_ID> --env production -m "rollback from <sha>" -y`
  with the version id printed in the deploy run's summary
  [RULE: docs/DEPLOY.md, "Rollback"].
- Database restore: D1 Time Travel to the bookmark the deploy run printed
  before migrations:
  `npx wrangler d1 time-travel restore commonworld-prod --env production --bookmark='<bookmark>'`;
  overwrites the live DB, owner decision only [RULE: docs/DEPLOY.md;
  platform/docs/ops/BACKUP-RESTORE.md, section 1].
- Code restore point: the <scope>-pre-pr<N>-<date> tag on pre-merge main
  (Step 3); revert through a new PR, never a force-push
  [RULE: AGENTS.md, Workflow].
- File-level database restore: the verified dump in R2 (Step 6) restored into a
  scratch D1 by platform/scripts/d1-restore.sh; switching production to a
  restored DB is a separate owner decision [RULE: platform/docs/ops/BACKUP-RESTORE.md].
- CI red anywhere: report; fix only with a scoped GO; after any head move the
  owner re-requests Codex; nothing merges or deploys red.
- A failed or stale write (tag, comment, dispatch, backup) is reported and
  re-authorized, never silently repeated; duplicate-side-effect checks come
  before any retry.


Observed technical follow-ups from the 2026-11-06 run
-----------------------------------------------------
- The remaining batch PRs #288, #289, #290 received new heads after the #287
  merge; their earlier CI greens and Codex state predate those heads, so each
  needs fresh checks before its own merge GO.
- Weekly restore-check cron: the code comment in platform/src/backup.ts says
  "Mon 04:30 UTC", but the Cloudflare Quartz expression `30 4 * * 1` fires on
  SUNDAY (Quartz weekdays run 1 = Sunday to 7 = Saturday)
  [RULE: https://developers.cloudflare.com/workers/configuration/cron-triggers/;
  https://github.com/commonworld-one/commonworld/blob/main/platform/src/backup.ts].
  Code comment and actual behavior disagree.
- The repo's backup runbook documents the full end-to-end restore drill (a
  production dump restored into a scratch D1) as the second line behind D1 Time
  Travel. Recorded to date: a restore drill on STAGING data (2026-10-18, which
  is also how the raw-export import failure was found) and parse-level
  verifications of the production dumps; no record of a full production-dump
  restore into a scratch D1 [RULE: platform/docs/ops/BACKUP-RESTORE.md].


If this procedure becomes a repo doc [PROPOSED]
-----------------------------------------------
Suggested location: docs/DEPENDABOT-UPDATE-LIFECYCLE.md (next to DEPLOY.md and
ATLAS-SUGGESTION-LIFECYCLE.md). This path is a proposal only; creating the file
is a repo change needing its own PR, review and GO.
