> Current local packaging scope, 23 November 2026: the owner chose dated catalogue preparation without requiring a complete retrospective raw-evidence archive. Missing originals remain unavailable/unverified, not passed. Source URLs, dates, known limits, exact images and available history are preserved. Quality is locally adapted to the accepted catalogue builder. The historical checkpoint and earlier proof below remain historical. No code publication, merge, deploy or automation activation is approved.

> Packaging checkpoint, 23 November 2026: earlier status statements below are historical, not current release acceptance. Exact captures are now merged only in atlas-screens through image PR #317 at 3e75274034c11b7afbe81389c26843ccc813a876. Main and production have not been updated. Safety and IndexNow local reviews remain scoped; Quality still uses legacy build input. Public provenance packaging is BLOCKED: original source-evidence body availability is unverified and the proposed public/private evidence split is not owner-approved. No missing original is replaced by its receipt, hash or a new visit under an old date.

# Local Atlas catalogue contract, 23 November 2026

This is the current **local candidate**, not a statement that production has been updated. No push, PR, merge, workflow, schedule, staging or production action is part of this checkpoint. Older release records and executed procedures retain their original dates.

## Current presentation

- 386 permanent entries: 348 dated source overviews, 18 bounded could-not-verify notes and 20 closed-history records.
- `atlas/catalogue/overviews.json` contains the 348 reviewed records. A visit dates the source overview, not a guarantee that the service works now. Optional trials describe only actions actually performed, with their own scope and cost.
- `atlas/catalogue/limitations.json` contains dated source attempts, not accepted overviews, new screenshots or permanent-closure decisions. `current_limitation` takes priority over older compatibility text.
- HTML, Markdown, list/search snippets and link previews use the current source view. Images retain exact source addresses, hashes and capture times. No diagnostic error page is presented as a current product screenshot.
- UI status groups are dated overview, could not verify and closed history. The existing query token `status=live` selects the dated-overview group, not service availability. `status=limited` selects bounded notes. Search uses current text rather than old claims when a current view exists.

## Agent tools and compatibility

Read `current_limitation` first when present, otherwise `overview.text`, `overview.sources` and `overview.visited_at`. A full card can contain both this current view and legacy v1 fields. Existing `status`, `summary`, `verified_at`, `last_checked`, claims, evidence levels, money-flow and first-task fields retain their historical meanings. They are not fresh availability, earnings or task-opportunity claims. Do not turn missing trial data into a claim that a service was tested.

The compact MCP index and `slimRow` carry the same optional current-view objects as full cards. MCP search matches current text when present; `limited` separates bounded notes from legacy-live records. `atlas_get_platform` returns the full card; `atlas_list_page` preserves stable paging. Start at page 1, follow `next` while `has_more`, and restart when `snapshot_id` changes. IDs come from returned records, never guessed from names.

`disclosure_history` is public dated disclosure history, separate from current relationship wording. Internal editorial history, preparer notes and review correspondence are not public fields. Overview content digests do not independently certify renderer/CSS/disclosure changes; those need separate component checks.

Historical money tables and `earn.json` retain their source dates and units. They are not current payout verification. Existing badges are compatibility endpoints; the 18 bounded-note badges say Listed, not Verified. A legacy badge date is not a new overview visit.

## Build and checks

Use `python atlas/tools/catalogue_build.py --mode accepted --screens-dir <exact-reviewed-captures>` for local accepted-generator checks. Accepted is a generator mode, not publication approval. Preview mode is visibly marked, noindex and no-mirror. Preserve the screenshot manifest and byte bindings. The committed public mirror must be generated from the same input.

The saved local CI and asset-preparation proposal already call `catalogue_build.py`; older documents saying default CI is still legacy describe a superseded local checkpoint. Actual GitHub workflows, environments and run results have not been checked here. Local success is not evidence of live CI or deployment.

## Freshness and release boundaries

The legacy refresh workflow still declares Sunday 02:00 UTC and screenshots Sunday 04:00 UTC. Their presence is not proof of an active current schedule, nor a new whole-overview revisit process. Weekly MAIN-only substantive revisits are proposed, not activated. Supplements have no new automatic schedule. Refresh, screenshot, quality, safety and IndexNow cutover need separate work and authority before release.

The exact reviewed captures remain local. No image-branch commit or replacement `screens.lock` SHA is invented. Private-term and previous-git-snapshot checks were skipped in the provided environment; a local green check must preserve those caveats. Live CI, staging and release checks remain open. Saved deploy guards are code, not a live environment audit. Worker rollback does not undo D1 migrations.

A future contribution/task queue, refresh timers, contributor IDs, reservation expiry and rewards are design ideas only. They are not implemented and do not block this catalogue presentation work.

## Unreleased additive API fields

The saved schema_version remains 1.11.0, the historical released contract. The optional overview, current_limitation and disclosure_history objects are local candidate extensions, not a claim that an API release occurred. Existing consumers can ignore them. Do not remove, rename or reinterpret required legacy fields. An eventual version/changelog cutover and deployed-consumer check need release review before publication.

The category tool labels legacy counts explicitly. Search matches current text, but money/first-task booleans remain historical filters. The first-task and earn tools are historical records, not invitations to execute or spend, and their descriptions direct the reader to the current full card first.

## Verification scope for this local copy candidate

The normal accepted-generator site checker passed with the existing private-term and previous-snapshot skips. Python tests passed locally; targeted real-build MCP and Worker agent-doc tests passed. A whole-platform test invocation was interrupted before its final result and is not a suite PASS. Desktop/mobile source-view, filter, metadata and OG checks cover the changed surfaces, not a fresh test of the listed services. Exact independent global consistency review remains required.
