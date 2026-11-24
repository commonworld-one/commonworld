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

`current-revisions.json` explicitly replaces Meta Muse in the current projection with a fresh whole-overview visit and clean capture, while preserving the original input. `closures.json` applies explicit closure IDs, `additions.json` adds Aptets once, `additional-overviews.json` supplies its separately reviewed text, and `additional-captures/` supplies its hash-pinned image. `archive-captures/` retains historic IssueHunt, Clawsino and Agent Knowledge Network images. `limitations.json` is retained source history for the18 closed records, not an active public limited category.

The accepted build applies these layers before current membership, safety queries and public projection. It also writes the committed `atlas/public` mirror. `atlas/site/dist` is generated site output. Historical protocol sections and original-source provenance do not authorize external work or supply current membership.

## Build and checks
```sh
python atlas/tools/catalogue_build.py --mode accepted --screens-dir /path/to/pinned-captures
python atlas/site/check.py
CW_SCREENS_DIR=/path/to/pinned-captures python -m unittest discover -s tests
cd platform && npm run typecheck && npm test
```
Without `--screens-dir`, accepted builds use the existing pinned screenshot-source mechanism. Preview is local and never updates the mirror. CI rejects a stale committed mirror. The repository private-term scan requires its existing protected denylist; a supplemental local scan is not equivalent.

## Historical pagination
Former list pages beyond the current last page return302 with no-store in HTML, Markdown and JSON, to the current last page. Current targets return200. Never-existing page numbers retain404 behavior. Removed historical money/number filters are ignored in current views; remaining search/category/tag filters still apply.

## Scope boundaries
No database migration, new recurring job, queue, reward system or new agent identity system is part of this change. Existing refresh/screens/IndexNow/release workflows are not activated by the source update. A screenshot-only check does not create a new overview visit. A new visit or trial needs its own actual evidence and independent review.
