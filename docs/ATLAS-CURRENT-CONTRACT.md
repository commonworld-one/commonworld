# Atlas current catalogue contract

This document describes the repository build, not whether it has been deployed. Production changes require the separate release process.

## Current projection
-349 current Live cards:348 preserved reviewed overview inputs plus the separate Aptets entry. Current projection uses347 unchanged original packages and one explicitly reviewed Meta Muse reshoot/revisit.
-38 closed records:20 historical closed records plus18 explicit closures. Closed resource links are inert, retained records are not queried or reopened automatically.
-71 earning-opportunity entries, a broad editorial selection with caveats, not verified payouts.
-HTML, Markdown, JSON, search and MCP use current descriptions, sources, overview visit dates, matching screenshots and optional actual-use notes. Old claims, summary, numeric money and first-task fields are not current records.
-Verified uses the overview visit date, not an availability or functional-test guarantee. Trials have separate dates. Revising an overview without trials retains existing trials; revise-trials leaves main text/date unchanged. Both invalidate the old independent review and return the changed record to draft.
-This is a breaking replacement on existing Atlas URLs. No old default feed is retained. The1.12.0 identifier is not a claim of semver compatibility.

## Source layers, not competing catalogues
`atlas/catalogue/snapshot.json`, `overviews.json`, `selection.json`, `image-binding.json` and the original348 capture bytes are retained inputs. The raw snapshot and limitations can contain old membership and fields. Do not count them as current public output.

`current-revisions.json` explicitly replaces Meta Muse in the current projection with a fresh whole-overview visit and clean capture, while preserving the original input. `closures.json` applies explicit closure IDs, `additions.json` adds Aptets once, `additional-overviews.json` supplies its separately reviewed text, and `additional-captures/` supplies its hash-pinned image. `archive-captures/` retains 19 historic closed-card images (IssueHunt, Clawsino, Agent Knowledge Network and 16 more restored from the pinned `atlas-screens` bytes with their original capture dates; no new visit). `limitations.json` is retained source history for the18 closed records, not an active public limited category.

The accepted build applies these layers before current membership, safety queries and public projection. It also writes the committed `atlas/public` mirror. `atlas/site/dist` is generated site output. Historical protocol sections and original-source provenance do not authorize external work or supply current membership.

## Build and checks
```sh
python atlas/tools/catalogue_build.py --mode accepted --screens-dir /path/to/pinned-captures
CW_SCREENS_DIR=/path/to/pinned-captures CW_SCREENS_REQUIRED=1 python atlas/site/check.py
CW_SCREENS_DIR=/path/to/pinned-captures python -m unittest discover -s tests
cd platform && npm run typecheck && npm test
```
Without `--screens-dir`, accepted builds use the existing pinned screenshot-source mechanism. Preview is local and never updates the mirror. CI rejects a stale committed mirror. The repository private-term scan requires its existing protected denylist; a supplemental local scan is not equivalent.

## Historical pagination
Former list pages beyond the current last page return302 with no-store in HTML, Markdown and JSON, to the current last page. Current targets return200. Never-existing page numbers retain404 behavior. Removed historical money/number filters are ignored in current views; remaining search/category/tag filters still apply. An old address with status=closed (without live) opens the closed archive page: the search text and other filters in that address are not carried over, only the #fragment is kept. With status=live (alone or together with closed) the catalogue opens with the Live filter; any other status value is ignored.

## Scope boundaries
No database migration, new recurring job, queue, reward system or new agent identity system is part of this change. Existing refresh/screens/IndexNow/release workflows are not activated by the source update. A screenshot-only check does not create a new overview visit. A new visit or trial needs its own actual evidence and independent review.

## Local draft preview validation
`build.py --draft-preview --no-mirror` can render undated drafts. Missing visit dates remain null in JSON and unrecorded in the page; they never become Verified or inherit a historical date. Date aggregates use only recorded visits, or null when none exist. Earning explanations remain revision-bound; changing an overview does not bypass that check.

A local preview is not the release API. Its earning API document names `earn-preview.schema.json`, with `earn-row-preview.schema.json` allowing a null visit date. These two schemas are generated only for draft previews. The published `earn.schema.json` and `earn-row.schema.json` remain unchanged and require dated rows. No earning rows are hidden to satisfy a schema.

`tests/test_draft_preview_build.py` runs complete mixed-date and undated preview builds and validates their generated API documents against their named schemas. It also checks the preview marker, noindex, draft status, Listed badges and absent mirror writes. The production `check.py` is a release gate, not a preview validator: its indexability, canonical, image, sitemap and growth rules deliberately do not describe local previews. Passing preview tests does not mean the release gate passed. The preview marker still makes the deployment packager refuse these artifacts.

The narrower `atlas/site/tools/check_overview_preview.py --source SOURCE --dist DIST` checks local noindex, links and cross-surface overview equality. `SOURCE` must be the resolved preview document after additions and current revisions (and explicit removals), not the frozen `overviews.json` input alone. It does not apply overlays itself. Comparing the frozen input with a build containing the reviewed Meta Muse revision reports three machine-overview mismatches; that is an input-layer mismatch, not a changed capture or invented visit. The full preview regression constructs the resolved source and runs this checker for all 349 fixture records. Neither this checker nor the preview regression replaces independent content review or the protected privacy gate.

## Closed transitions and isolated batches
A card closed after a reviewed overview keeps its public overview as inert historical material, alongside snapshot history and any retained capture. It cannot dispatch to the current overview renderer, appear in current counts, earning rows, MCP or sitemap, or retain active outbound links. Closure decisions apply after additions, including a newly added card that is subsequently closed.

The repository's own snapshot and overview paths select the complete current catalogue layers. Explicit custom snapshot/overview inputs, including generated review bundles, do not inherit unrelated additions, current revisions or replacement captures. Closure and safety decisions still apply to matching IDs. An isolated draft preview publishes only its selected overview IDs and matching captures, even when its packaged snapshot contains more records. Replication/reachability validation considers the supplied snapshot, not absent global cards. Preview landing links never advertise absent example cards or categories.

`tests/test_catalogue_lifecycle.py` runs full accepted and draft closure transitions and executes the preview command emitted by a real generated and verified one-card bundle. The accepted lifecycle test requires `CW_SCREENS_DIR` pointing at the exact reviewed captures; without it that test skips, rather than manufacturing receipts or pixels.

## Current editorial event coverage

The append-only events.jsonl keeps its original148lines. The25November migration backfill records18editorial closures, Aptets addition and Meta Muse revision on their24November source-record dates, then349per-card25November migration events. Migration entries describe packaging, never a new source visit, screenshot or trial. Original dated history is retained; generated_at is a build timestamp, not event coverage.

`atlas/catalogue/event-coverage.json` binds each current overview revision and the addition/revision/closure layers to a dated event. When those inputs change, add a supported event and renew that specific binding. Never renew a binding just to silence a failure, invent an event date, or claim retrospective completeness without evidence. The checker rejects a stale binding or missing event. Safety decisions and automated numeric-history changes retain their existing separate records and exclusions.

The published release schemas admit only reviewed, dated, nonempty current overview packages with sources and captures, or explicit inert closed-history records. Historical source-field definitions remain under a named historical schema definition, not a public-response alternative. Preview schemas remain local-only and cannot authorize release. Schema structure checks do not prove source/image correspondence or independent review, which remain acceptance checks.
