Atlas suggestion lifecycle: executable procedure
=================================================

How an inbound Atlas suggestion becomes a live, verified card and a reply to the
applicant, on the Commonworld Atlas (repo: https://github.com/commonworld-one/commonworld).
Written so that any agent can read it, check every source, and run the full chain.

Executed end to end for Agent Knowledge Network (Aptets) on 2026-11-05; that run
(card PR #283, screenshot PR #284, screens.lock PR #285) is the example set.
All commands, file paths and links below were verified on 2026-11-05 against
main @ 929e57d5e334a644353806c9732b2ed275599e23 and the GitHub API.

Conventions
-----------
- [RULE]     = written repo source, linked.
- [CI]       = enforced by the repo's own workflows, linked.
- [PRACTICE] = maintainer habit observed across many runs, not a written mandate.
- [OBSERVED] = a verified fact of the 2026-11-05 run (one data point, not a universal rule).
- [TEMPLATE] = a URL shape with placeholders (<slug>, <N>, <sha>); not fetched as-is.
  Non-template links were checked on 2026-11-05; re-check them when executing.
- Every step: Prerequisites / Action / Readiness gate (where to look, what exactly
  must match, when to stop) / GO.
- GO means an explicit, scoped human approval. A GO covers only the action it
  answers; no upstream yes covers a downstream step. Every public or external
  write (PR open, comment, tag push, workflow dispatch, fix push, decline or
  reply message, deploy dispatch) is requested with its exact content BEFORE the
  action and carries its own GO. Nothing is retried, deleted or re-created
  automatically: a failed or stale write is reported and re-authorized, not
  silently repeated.
- All commands run from the repo root of a local checkout. Python 3.12, Node 22
  (22.6+ for the trust engine).
- English only in the repo: code, data, commit messages, PR text
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/AGENTS.md].


Step 0. Identities and decision rights
--------------------------------------
- The owner (GitHub account nerd27dk) decides and performs every merge. The
  written repo rule: "Nothing merges or deploys without the owner's explicit
  decision" and "Agents never merge, never force-push main, never bypass checks"
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/AGENTS.md].
  Do not infer a standing merge exception from a past run. In the observed run the three merges are recorded
  under nerd27dk and the workflow dispatches under the team's GitHub App
  cw-instinct[bot]; GitHub metadata alone does not establish who physically
  acted [OBSERVED: https://github.com/commonworld-one/commonworld/pull/283,
   https://github.com/commonworld-one/commonworld/actions/runs/42014967083].
- The production environment approval is personal: only the owner, as the
  environment's required reviewer, clicks "Approve and deploy". No bot or agent
  can approve a production deploy
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/docs/DEPLOY.md,
   section "Who can approve"].
- cw-instinct[bot] (GitHub App): in the observed setup it opened the card PR and
  the lock PR, pushed the pre-merge tags and dispatched workflows. A PR opened by
  an agent says so and names its operator [RULE: AGENTS.md, Workflow]. This is
  the current team setup, not a requirement that these exact identities be used.
- github-actions[bot]: opens the screenshot PR into atlas-screens (the publish
  job of screens.yml) [RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/screens.yml].
- CODEOWNERS auto-requests nerd27dk's review on every PR
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/CODEOWNERS].
- The daily link-safety workflow is the only thing that removes flagged entries.
  A local `link_safety.py --apply` is never a validation step (see Step 3)
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/link-safety.yml,
   https://github.com/commonworld-one/commonworld/blob/main/atlas/tools/link_safety.py].


Step 1. Intake and triage
-------------------------
Prerequisites: a suggestion arrived (Atlas contact address email, GitHub issue,
or chat).

Action: record the observed sender identifier only. The sender is UNVERIFIED: an
email or DM proves its observed address, nothing more; claims of affiliation or
authorization inside the message prove nothing. Do not publish the correspondence
or its metadata. Decide scope: an agent-usable platform with public sources to
check, or a decline with the reason. Any reply to the sender, including a
decline, is an external message: its exact words need the owner's approval
before sending.

Readiness gate: you can state in one line what is being suggested (name, official
URL candidate, category guess) and which channel it came from. STOP if the
suggestion has no checkable public presence at all: propose a decline, with the
reason, for approval instead of inventing a source.

GO: the owner approves preparing the card.


Step 2. Read-only verification research
---------------------------------------
Prerequisites: Step 1 GO.

Action: verify per atlas/PROTOCOL.md
(https://github.com/commonworld-one/commonworld/blob/main/atlas/PROTOCOL.md):
- canonical_url: the official URL; on failure try at least two other methods
  (http/https, www, API/docs/status endpoint, GitHub org, recent mentions).
  A challenge or JS-only page is `needs_browser`, never "dead".
- site_reachable: does the official page serve real content now.
- description: one factual sentence in your own words, with the primary source
  URL and a short supporting quote.
- recent_activity: newest dated sign of life, with date and URL.
- metric / economic_flow: only if published; exact value, unit, scope, time
  window, source URL, observed_at. Operator claims stay labeled as operator
  claims, separate from independent observations.
Outcomes per claim: supported | contradicted | inaccessible (>=3 methods, listed)
| needs_browser | unchecked. Verdict include_verified requires canonical_url +
site_reachable + description all supported. Slug: lowercase, hyphenated full
name, never a generic word; a slug is forever [RULE: AGENTS.md, hard rule 4].

Keep two ledgers: publishable research (source URLs, what was checked, UTC times)
and private working notes. Private notes, and anything from private
correspondence, never enter the card, PR bodies, journals or replies.

Disclosure wording is case-specific and approved with the card content. In the
observed case (suggestion by email, affiliation not verified) the card carries:
"Suggested for the Atlas via the Atlas contact address; the sender's affiliation
with the project is not independently verified. This card records a read-only
source check; it is not an endorsement or functional test. Sources were checked
read-only by Instinct; contributed through cw-instinct[bot]."
[OBSERVED: https://commonworld.one/atlas/platforms/agent-knowledge-network/]
A verified sender or a different intake path calls for different wording that
fits the evidence.

Readiness gate: every claim destined for the card has a public source_url, basis,
outcome and observed_at; unknowns stay null, never invented [RULE: AGENTS.md,
hard rule 4]. STOP if any load-bearing claim has no source: collect more or
propose a decline. Example of the expected research record: the "Checked
read-only on 2026-11-05 (UTC)" and "Limits" sections of
https://github.com/commonworld-one/commonworld/pull/283.

GO: the owner approves the researched card content, including the exact
disclosure wording.


Step 3. Local data change and validation
----------------------------------------
Prerequisites: Step 2 GO; local checkout of main, up to date.

Setup (once, mirrors the CI install steps
[RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/ci.yml]):
  python -m pip install -r requirements.txt playwright
  python -m playwright install --with-deps chromium
  python -m pip install --only-binary=:all: -r requirements-ci.txt
  git fetch --no-tags origin +refs/heads/atlas-screens:refs/remotes/origin/atlas-screens
  (Fetch before building/checking: the pinned screenshot data must be available.)

Action, on branch atlas-<slug>:
1. Prepare the card record. First read the sources that own the shape:
   atlas/CURATION.md (curation standards), the API v1 schema source
   atlas/site/api_v1.py (the build generates dist/api/v1/schemas/*.schema.json
   from it; the validator is atlas/site/tools/validate_jsonschema.py), and a
   recently accepted card record in the active snapshot as the concrete example
   to follow
   [RULE: https://github.com/commonworld-one/commonworld/blob/main/atlas/CURATION.md,
    https://github.com/commonworld-one/commonworld/blob/main/atlas/site/api_v1.py,
    https://github.com/commonworld-one/commonworld/blob/main/atlas/site/tools/validate_jsonschema.py].
   Choose the next free numeric ID from the snapshot and verify: no duplicate
   slug, ID or host on main. The active snapshot is the pinned constant
   DEFAULT_DATA in atlas/site/build.py (line 38; currently
   atlas/data/snapshot-verified-2026-10-15.json). Read the constant; do not glob
   for the newest file
   [RULE: https://github.com/commonworld-one/commonworld/blob/main/atlas/site/build.py;
    snapshot file: https://github.com/commonworld-one/commonworld/blob/main/atlas/data/snapshot-verified-2026-10-15.json].
   Then add the card record to that snapshot.
2. Add the matching entry to the snapshot's `amendments` list, one `added` line
   to atlas/data/events.jsonl, and a dated section to atlas/CHANGELOG.md.
   Every data change is recorded in the snapshot's amendments list, and the build
   check fails on a curated amendment without a matching event
   [RULE: CURATION.md, "Events log";
    https://github.com/commonworld-one/commonworld/blob/main/atlas/CHANGELOG.md].
   The exact observed event line (one line in the file):
   {"date": "2026-11-05", "slug": "agent-knowledge-network", "type": "added", "reason": "New card from an Atlas suggestion email (sender affiliation unverified, disclosed): agents exchange firsthand API integration findings; free search, agent self-registration over MCP/REST, internal credits without cash withdrawal; re-checked read-only by Instinct", "source": "https://aptets.com/"}
   [OBSERVED: https://github.com/commonworld-one/commonworld/blob/main/atlas/data/events.jsonl]
3. Refresh the link-safety report:
   `python3 atlas/tools/link_safety.py --data atlas/data/snapshot-verified-2026-10-15.json`
   Pass --data with the ACTIVE snapshot (the file build.py's DEFAULT_DATA names):
   without it the run defaults to the newest snapshot-verified-*.json, which can
   differ from the snapshot the build uses [RULE: link_safety.py CLI arguments].
   A plain run only checks every linked host against the trust engine (Google
   Safe Browsing, MetaMask eth-phishing-detect, ScamSniffer, CERT Polska;
   standard: https://github.com/commonworld-one/commonworld/blob/main/TRUST.md)
   and writes the report atlas/data/link-safety.json. NEVER pass --apply: that
   removes every entry linking any flagged domain, including unrelated cards,
   and is reserved to the daily workflow with its own rebuild, check, commit and
   issue handling [RULE: link_safety.py docstring; link-safety.yml].
   Exit codes: 0 = no published host flagged; 1 = a host flagged (STOP, see
   below); 2 = the engine could not run.
4. Build: `python atlas/site/build.py` (regenerates atlas/site/dist/ AND the
   committed mirror atlas/public/). Commit the regenerated mirror in the same
   PR: AGENTS.md hard rule 3 ("atlas/public/ is generated... rebuild, commit the
   result") and the CI step "GitHub data mirror is up to date" fail the PR if the
   mirror is stale [RULE: AGENTS.md; ci.yml]. Expect churn across many mirror
   files when counts change; that is normal [OBSERVED: PR #283's file list
   includes the full mirror refresh].
5. Grow the sitemap baseline: `python3 atlas/site/check.py --update-baseline`
   (adds the new card's URLs to atlas/data/sitemap-urls.txt, never removes)
   [RULE: check.py docstring;
    https://github.com/commonworld-one/commonworld/blob/main/atlas/site/check.py;
    baseline file: https://github.com/commonworld-one/commonworld/blob/main/atlas/data/sitemap-urls.txt].
6. Validate, all from the repo root:
   - `python -m unittest discover -s tests -p 'test_*.py' -v`
   - `CW_SCREENS_REQUIRED=1 python atlas/site/check.py`
   - `python atlas/site/tools/validate_jsonschema.py atlas/site/dist/api/v1`
   - `git status --porcelain -- atlas/public` must print nothing once the mirror
     is committed.
   Screenshot note: a brand-new card legitimately validates with preview null and
   a "No homepage preview yet" placeholder; check.py's rule is "preview null <=>
   no image" and build.py sets preview null without a screenshot. The new image
   only enters the build after the lock PR (Step 10). CW_SCREENS_REQUIRED=1
   requires the atlas-screens branch data to be present, not the new card's image
   [RULE: build.py preview_record ("null without a screenshot"); check.py
   docstring; AGENTS.md, "Build and test"].
   Privacy caveat: check.py's forbidden-text scan needs CW_PRIVATE_TERMS (or the
   git-ignored atlas/site/.private-terms). Without it the scan is SKIPPED with a
   warning; say so in the PR and never claim that check passed
   [RULE: AGENTS.md, "Build and test"].

Readiness gate: every command above exits 0 and you hold the exact numbers for
the PR body (tests run/passed/skipped/failed; schema files and errors; link-safety
hosts and flags). Observed precedent wording: "Local build and check.py passed;
464 tests total: 460 passed, 4 skipped, 0 failed. JSON Schema: 429 files, 0
errors. Link-safety run at 2026-11-05 09:06 UTC: 528 hosts, none flagged."
[OBSERVED: https://github.com/commonworld-one/commonworld/pull/283 body]
STOP if link_safety exits 1 (a flagged domain is a curator matter, never edited
around), if any test fails, or if the mirror is dirty after a fresh build.

GO: the owner approves opening the card PR with this exact content.


Step 4. Open the card PR
------------------------
Prerequisites: Step 3 green.

Action: with the GO for the exact title and body, open the PR from branch
atlas-<slug> into main (in the observed setup as cw-instinct[bot]), title
"Atlas: add <Name>". Body in the precedent shape of
https://github.com/commonworld-one/commonworld/pull/283:
- Card: id, slug, category, entity type, verdict, platform count before -> after,
  "No duplicate slug, ID or host on main."
- Checked read-only on <date> (UTC): the sourced findings.
- Limits: what could not be verified or is operator-reported.
- Checks: the exact Step 3 numbers.
- Screenshot and merge order: name the screenshot PR when known and state the
  human merge order (card PR, screenshot PR, lock PR).
- Disclosure: identical wording to the card JSON.
Reference the triggering issue as "Refs #N", never "Fixes". State that you are an
agent and who operates you [RULE: AGENTS.md, Workflow].

Readiness gate: the PR page exists with the expected head branch and file set
(snapshot, events.jsonl, CHANGELOG.md, sitemap-urls.txt, link-safety.json,
atlas/public/*; no hand edits inside atlas/public), and CI has started
(PR -> Checks). Note the PR number: later tags and the screenshot PR reference it.


Step 5. CI and Codex review on the card PR
------------------------------------------
Prerequisites: PR open.

Action: watch CI (PR -> Checks, or
https://github.com/commonworld-one/commonworld/actions). The atlas job runs:
unit tests; screens.lock fetch plus the pinned-WebP artifact check; build; mirror
freshness; check.py (with the CW_PRIVATE_TERMS secret on same-repo PRs); JSON
Schema validation; browser smoke (atlas/site/tools/smoke_test.py)
[RULE: ci.yml;
 https://github.com/commonworld-one/commonworld/blob/main/atlas/site/tools/smoke_test.py].

Codex stage: in the observed run only the owner account's `@codex review` comment
started a review; cw-instinct[bot]'s identical comment got the reply "To use
Codex here, create a Codex account and connect to github." from
chatgpt-codex-connector[bot]. Treat "the owner requests the Codex review" as this
repo's current working rule [OBSERVED, one run, 2026-11-05], not a universal
product fact. Each invocation is its own GO. An invocation is not a result: wait
for the review receipt comment. The observed receipt: "Codex Review: Didn't find
any major issues... Reviewed commit: aad2a5897a", matching the final PR head
aad2a5897a723a1afc1d5e98013dfb83cb4e2497 [OBSERVED: PR #283 issue comments].

Readiness gate: (a) every CI check green on the CURRENT head sha; (b) the Codex
receipt names the current head sha and reports no major issues, or its findings
are fixed. STOP if CI is red or the receipt sha lags the head: report, and only
with a scoped GO push fix commits; after any head move the owner requests a fresh
review of the new head. The Codex re-review and the merge GO are separate
approvals; neither covers the other.


Step 6. Screenshot capture dispatch
-----------------------------------
Prerequisites: the card data is final on the card branch (slug and URL settled);
CI and Codex green on that head.

Action: with a scoped GO, dispatch Actions -> "Atlas weekly screenshots" ->
Run workflow, selecting the CARD BRANCH as the ref, with input `only` = the new
slug. The workflow's only input is `only` (comma-separated slugs, empty = every
live card); the capture job checks out the dispatch-selected ref, reads the card
data from that checkout, and shoots the live external homepage with the network
guard on (capture job token is read-only)
[RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/screens.yml;
 capture rules: https://github.com/commonworld-one/commonworld/blob/main/atlas/tools/screens.py].
Timing: dispatch from the card branch BEFORE the card merge so the new card
exists in the checkout data [OBSERVED: run
https://github.com/commonworld-one/commonworld/actions/runs/41999975221 on branch
atlas-agent-knowledge-network]. Valid alternative: dispatch on main AFTER the
card merge, when the card is in main's data.

Readiness gate: the run succeeds; its artifact `screens-review` holds the old|new
preview; you have LOOKED at the pixels: real homepage, no consent wall, no
loading placeholder, no blank render. Every capture uses the same format: 1280x800
viewport to a 1200x750 WebP [RULE: screens.py capture rule 3]. Confirm the
captured slug and shot URL match the final card; if the card branch moved after
the dispatch, confirm the move did not change the slug or URL, otherwise
re-dispatch (re-dispatch is a new GO). STOP if the summary lists the capture as
failed or the preview looks wrong: a failed capture is never stored [RULE:
screens.py capture rule 6]; report, fix the cause, and only then re-dispatch.


Step 7. Screenshot preview review
---------------------------------
Prerequisites: Step 6 green; the publish job has opened the screenshot PR into
atlas-screens automatically (author github-actions[bot], branch screens/<date>).
The workflow never auto-merges; its PR body itself instructs the follow-up lock
PR [RULE: screens.yml header].

Action: review the old|new previews (linked in the PR body as the run's
screens-review artifact) and record the verdict as a PR comment.

Readiness gate: the PR shows exactly the expected files (atlas/screens/<slug>.webp
and atlas/screens/manifest.json) [OBSERVED:
https://github.com/commonworld-one/commonworld/pull/284], the base is
atlas-screens, and your verdict comment states what you saw. STOP on any extra
or missing file, or a preview that fails the capture rules.

GO: the verdict comment is a public write; request approval of its exact words
before posting.


Step 8. Card PR merge
---------------------
Prerequisites: Steps 5-7 green; the owner has decided to merge THIS PR at THIS
head sha.

Action, in order:
1. Tag the pre-merge base [PRACTICE]: atlas-pre-pr<N>-<yyyymmdd> pointing at the
   CURRENT head of main, with its own GO. Verify the tag ref exists remotely and
   points at the intended sha (GitHub -> Code -> Tags, or
   `gh api repos/commonworld-one/commonworld/git/refs/tags/<name>`).
   Observed example: https://github.com/commonworld-one/commonworld/tree/atlas-pre-pr283-20261105
   (convention observed back to atlas-pre-pr40-2026-10-21; date formats vary).
2. Re-verify immediately before merge that main's head is still the tagged sha.
   If main moved, STOP and report; any tag change is a new scoped GO, never an
   automatic delete or re-create.
3. The owner performs the merge (Step 0). In the observed run #283's merge is
   recorded 2026-11-05T10:04:44Z [OBSERVED:
   https://github.com/commonworld-one/commonworld/pull/283].
4. Verify the merge through the API (`gh api repos/commonworld-one/commonworld/pulls/<N>`):
   state closed, merged true, base.ref = main, head.sha = the reviewed head, and
   record merge_commit_sha. For a squash merge the merge sha differs from the
   reviewed head; that is expected. Check the merge commit's first parent equals
   the tagged pre-merge base (`gh api repos/commonworld-one/commonworld/commits/<merge_sha>`)
   [OBSERVED: #283 squash eeac668aac7196a267b1d2ff9ad13bfdc6f81141, parent
   762a467b8c70e3e0c58c5434b11c46c555e2afad].

Readiness gate: all four verification points match. STOP on any mismatch and
report before touching anything else.


Step 9. Screenshot PR merge
---------------------------
Prerequisites: Step 8 verified; the owner has decided to merge the screenshot PR.

Action, same pattern as Step 8:
1. Tag the atlas-screens base [PRACTICE]: atlas-screens-pre-pr<N>-<date> on the
   current head of atlas-screens, with its own GO. Observed example:
   atlas-screens-pre-pr284-2026-11-05 -> e85af1c55bddd0b98ece42df2df3e17e317c770e
   (verified via the refs API).
2. Re-verify the base has not drifted; then the owner performs the merge.
3. API verification: merged true, base.ref = atlas-screens, head = screens/<date>;
   record the merge commit sha; its first parent equals the tagged base
   [OBSERVED: #284 merge commit e0f4e1ab38c36bd71b1af3e7c5937dc51bd2f17a, parents
   e85af1c5 + d4215d50; https://github.com/commonworld-one/commonworld/pull/284].

Readiness gate: you hold the verified atlas-screens merge commit sha; the lock PR
in the next step pins exactly that sha. STOP on any mismatch.


Step 10. screens.lock PR on main
--------------------------------
Prerequisites: Step 9 verified.

Action: open a PR on main changing exactly one file: atlas/screens.lock, set to
the full 40-character lowercase sha of the atlas-screens merge commit, one line
[RULE: ci.yml step "Fetch homepage screenshots" enforces one line, 40-char hex,
and that the commit is on atlas-screens; screens.yml's header explains why the
workflow cannot bump the lock itself;
file: https://github.com/commonworld-one/commonworld/blob/main/atlas/screens.lock].
Observed precedent: PR #285, "Atlas: bump screens.lock to e0f4e1a (Agent
Knowledge Network screenshot)" [OBSERVED:
https://github.com/commonworld-one/commonworld/pull/285].
Opening the PR is a GO-scoped write. Wait for CI green. If main moves while the
lock PR is open, the release scope changes: re-check what the new main head would
ship before merge. Then pre-merge tag atlas-pre-pr<N>-<date> (GO), base-drift
re-check, the owner's merge decision, the merge, and the same API verification as
Step 8 [OBSERVED: #285 squash 929e57d5e334a644353806c9732b2ed275599e23, parent
eeac668].

Readiness gate: CI green on the lock PR (including the screens.lock fetch step);
the PR diff is the one line; the merge is verified through the API; you hold the
final main sha that a release would ship. STOP if CI reports the pinned sha is
not on atlas-screens: you pinned the wrong commit (use the MERGE commit, not the
screens/<date> branch head).


Step 11. Staging deploy and staging verification
------------------------------------------------
Prerequisites: Step 10 verified; the final main sha is known; the owner
authorizes a staging run.

Action: with that GO, dispatch Actions -> "Deploy platform (staging)" ->
Run workflow, "Use workflow from" = main, ref = the FULL 40-character main sha
(a sha, not the branch name, so a push in between cannot change what deploys)
[RULE: https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/deploy-staging.yml;
 https://github.com/commonworld-one/commonworld/blob/main/docs/DEPLOY.md,
 "Staging deploy from GitHub"]. In the observed run the dispatch is recorded
 under cw-instinct[bot] [OBSERVED:
 https://github.com/commonworld-one/commonworld/actions/runs/42012886126].

Readiness gate, two parts:
(a) Run green: deploy job, smoke test, route smoke list, and the job "E2E against
    staging (read-only)" all succeeded; the run uploaded the artifact
    staging-deployed-<sha> whose content is exactly your sha. The migration
    scanner runs report-only here; read its output and distinguish "no pending
    migrations" from "pending migrations listed and applied". Any pending
    migration becomes part of the owner's release review in Step 12; a
    destructive or row-writing one stops the production gate unless the
    documented owner-marker plus one-release override path is used, which is
    outside a routine card release [RULE: docs/DEPLOY.md, "Database migrations"].
(b) Content on staging: open the staging card surfaces and check them like the
    live ones: card HTML <TEMPLATE https://staging.commonworld.one/atlas/platforms/<slug>/
    (verified example: https://staging.commonworld.one/atlas/platforms/agent-knowledge-network/)>,
    its .json and index.md twins, the card's presence in the staging Atlas index,
    and the screenshot image, looking at the rendered page and the image pixels,
    not only status codes.
STOP on a red job or any staging content mismatch: fix forward; the production
gate refuses a sha without a green staging run that is at most 7 days old
[RULE: docs/DEPLOY.md, "Staging check before production"].


Step 12. Production deploy
--------------------------
Prerequisites: Step 11 fully green and at most 7 days old.

Action:
1. Owner release review: the owner reviews the exact sha to release and
   everything main carries at that sha since the currently live version; a
   release ships all of main at that sha, not only the card (platform code and
   Atlas data from the sha, screenshots from the atlas-screens commit in
   atlas/screens.lock at that sha) [RULE: docs/DEPLOY.md, "What a release is
   made of"]. Pre-existing unrelated changes on main are part of this review.
2. With the owner's GO, dispatch Actions -> "Deploy platform (production)" with
   the same full sha, allow_destructive_migration empty,
   emergency_skip_staging_check off. The gate job verifies the sha is on main
   and finds the green staging proof.
3. The job waits at the `production` environment. The OWNER personally clicks
   "Approve and deploy"; only then does the job receive the production secrets
   [RULE: docs/DEPLOY.md, Release flow and "Who can approve";
    https://github.com/commonworld-one/commonworld/blob/main/.github/workflows/deploy-platform.yml].

Readiness gate: the run is green end to end: migration gate, wrangler deploy,
smoke test (/health answers "environment":"production"), route smoke list all
PASS [OBSERVED: https://github.com/commonworld-one/commonworld/actions/runs/42014967083,
head_sha 929e57d5, success]. Note: /health proves the environment, not the sha;
the sha evidence is the run's checkout step and the release manifest (artifact
release-manifest-<sha> records the code sha, the data sha and the screens.lock
sha). STOP on a red step: the run summary prints the pre-deploy version id and
the ready-made rollback command; see the Rollback appendix.


Step 13. Live verification (penultimate operational step)
---------------------------------------------------------
Prerequisites: production run green.

Action and readiness gate: check each live surface and keep the evidence (open
the page and look, do not trust status codes alone):
- Card HTML: <TEMPLATE https://commonworld.one/atlas/platforms/<slug>/>
  verified example: https://commonworld.one/atlas/platforms/agent-knowledge-network/
  - 200, correct title, description, disclosure wording, screenshot figure.
- Card JSON: <TEMPLATE https://commonworld.one/atlas/platforms/<slug>.json>
  verified example: https://commonworld.one/atlas/platforms/agent-knowledge-network.json
  - parses, carries the new claims with their sources.
- Markdown twin: <TEMPLATE https://commonworld.one/atlas/platforms/<slug>/index.md>
  verified example: https://commonworld.one/atlas/platforms/agent-knowledge-network/index.md
- Screenshot: <TEMPLATE https://commonworld.one/atlas/screens/<slug>.webp>
  verified example: https://commonworld.one/atlas/screens/agent-knowledge-network.webp
  - serves as a WebP image; visually compare with the reviewed preview (1200x750,
    the format fixed by screens.py capture rule 3).
- Catalog presence: the card appears in https://commonworld.one/atlas/platforms.json
  and the Atlas index; the sitemap gained exactly the card's URLs.
- Link safety: https://commonworld.one/atlas/safety.json lists the new domain
  clean.
[OBSERVED 2026-11-05: all six checks passed for agent-knowledge-network.]

STOP on any mismatch: do not reply to the applicant yet; decide fix-forward vs
rollback with the owner.


Step 14. Reply to the applicant (LAST operational step)
-------------------------------------------------------
Prerequisites: Step 13 fully green; the owner has approved the exact reply words.

Action: reply in the ORIGINAL intake thread (the same channel the suggestion
arrived on), from the approved account, to the current recipient address shown on
that thread, with the approved body. Include nothing from private working notes
and no private addresses beyond the approved public contact.

Readiness gate: re-read the thread after sending: the reply is there exactly
once, in the right thread, to the right recipient. If the send result is
uncertain, do NOT retry blindly (that is how duplicates happen): verify the
thread state first, and report if it stays ambiguous. Keep the thread reference
in the handoff note.


Rollback and failure reference (consult from any step; not a step after the reply)
----------------------------------------------------------------------------------
- CI red on a PR: report; fix commits only with a scoped GO; the owner re-requests
  the Codex review if the head moved; nothing merges red.
- Capture failed: a failed capture is never stored; report, fix the cause,
  re-dispatch with a new GO [RULE: screens.py capture rule 6].
- Bad merge on main or atlas-screens: the pre-merge tags are the restore points;
  revert through a new PR, never a force-push [RULE: AGENTS.md, Workflow].
- Production rollback: From `platform/`, with the production token:
  `npx wrangler rollback "$VERSION_ID" --env production -m "reason" -y`
  with the version id printed in the deploy run's summary; database restore via
  D1 Time Travel to the run's printed bookmark, owner decision only
  [RULE: docs/DEPLOY.md, "Rollback"].
- Flagged link found at any time: report it. Removal is the daily link-safety
  workflow's job: any single source flag removes every entry linking that domain,
  with a public decision in atlas/data/removed.json
  [RULE: https://github.com/commonworld-one/commonworld/blob/main/atlas/CURATION.md,
   "Link safety"].


If this procedure becomes a repo doc [PROPOSED]
-----------------------------------------------
Suggested location: docs/ATLAS-SUGGESTION-LIFECYCLE.md (the docs/ folder already
holds DEPLOY.md and AGENTS-CONTRIBUTING.md). This path is a proposal only; the
file does not exist and no URL is claimed for it. Creating it is a repo change
needing its own PR and GO.
