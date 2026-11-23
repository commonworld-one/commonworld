> Current local packaging scope, 23 November 2026: the owner chose dated catalogue preparation without requiring a complete retrospective raw-evidence archive. Missing originals remain unavailable/unverified, not passed. Source URLs, dates, known limits, exact images and available history are preserved. Quality is locally adapted to the accepted catalogue builder. The historical checkpoint and earlier proof below remain historical. No code publication, merge, deploy or automation activation is approved.

> Packaging checkpoint, 23 November 2026: earlier status statements below are historical, not current release acceptance. Exact captures are now merged only in atlas-screens through image PR #317 at 3e75274034c11b7afbe81389c26843ccc813a876. Main and production have not been updated. Safety and IndexNow local reviews remain scoped; Quality still uses legacy build input. Public provenance packaging is BLOCKED: original source-evidence body availability is unverified and the proposed public/private evidence split is not owner-approved. No missing original is replaced by its receipt, hash or a new visit under an old date.

# Atlas simple overviews: isolated working implementation

## Local catalogue checkpoint, 23 November 2026

The [current local catalogue contract](ATLAS-CURRENT-LOCAL-CONTRACT.md) supersedes earlier local checkpoint counts and current-view descriptions below. It describes 348 dated source overviews, 18 bounded notes and 20 closed-history records. Production has not been updated or verified by this checkpoint. Legacy claim/status fields remain compatibility data, not current availability or functional-test claims. No new recurring job or future agent queue is implemented.


## Current local checkpoint

See the [catalogue integration candidate](../atlas/catalogue/README.md) for the 348 reviewed source overviews, 18 bounded notes and 20 closed-history records, real receipt/image gates, proposed CI path and unchanged schedules. R3 and R4 have scoped independent local checks; this is not whole-site or release acceptance. Earlier counts/checkpoints below are historical. No new visits or capture dates are inferred, no history/agent-system redesign is required, and nothing is published.


Status: local candidate, not the production contract. No PR, push, merge,
workflow dispatch, staging run, production release or new recurring job is part
of preparing this candidate. The lower-level build remains legacy-compatible; the saved local CI and asset path now select catalogue_build.py. Actual GitHub runs and release cutover are unverified. Do not mistake this document for evidence
that the new format is already live.

## What changes

The new editorial source is a short overview, its public source links, the date
of the whole-card visit, and a reviewed screenshot. Optional actual trials have
their own date, action, result, access and cost, if known. Reading documentation
is not a functional trial. A published price is not a cost we incurred. Unknown
cost is null, never an invented zero. No registration or paid trial is required.

The contributor does not maintain claim rows, an evidence ladder, keys and
books, first tasks or numeric-count fields to write a new overview. Existing
claim records are retained for history and v1 consumers. This is not a CSS-only
change: HTML, Markdown and optional machine `overview` fields read the same
simple source through `atlas/site/overviews.py`.

The working migration file is `atlas/drafts/overviews.json`. It is deliberately
outside the production data directory. It contains all 366 active permanent
slugs at the baseline commit. The 20 closed entries stay in the original
snapshot as history. The migration report is a separate private working
artifact; it is not emitted into site JSON.

## Prepare and check locally

From the repository root:

```sh
# Draft validation plus an isolated build, no change to atlas/public:
python atlas/tools/overviews.py preview --file atlas/drafts/overviews.json

# Only structure, not a claim of content readiness:
python atlas/tools/overviews.py validate --file atlas/drafts/overviews.json

# Existing local serving rules, including CSP:
python atlas/site/serve.py
```

Open the local Atlas, card HTML and its Markdown/JSON twins. A draft preview
forces noindex on every HTML page, carries a visible local-preview notice, and
cannot write the committed public mirror. Do not deploy this preview tree.
Normal overview builds omit `--draft-preview` and refuse unreviewed records.
A schema-valid file is not a verified overview.

A whole overview is edited as one record, not as mandatory subclaims. To retain
the previous record and invalidate its final check:

```sh
python atlas/tools/overviews.py revise --file atlas/drafts/overviews.json \
  --slug <existing-permanent-slug> --replacement <replacement-record.json>
```

This command edits only the local overview source. It preserves the prior
revision in history, resets state to draft and discards the old check receipt.
Never hand-edit the history away to reuse a stale receipt.

No source audit automatically supplies `visited_at`. A successful script,
HTTP 200, screenshot capture, changed number, or a recent legacy claim timestamp
does not date a whole-card visit. The initial migration reused historical text as a starting point. The local
editorial pass has now proposed new text for all 366 active records, with a
source-claim ledger and the old text retained in history. An earlier local checkpoint on 23 November 2026 had 345 dated overview/capture pairs and 21 unfinished records. That checkpoint is superseded by the current local contract above. At that earlier checkpoint, 361 of 366 records were draft and five held, with formal checks null. These are historical checkpoint numbers, not current review state. Those 345 were an explicit candidate selection at that stage, not accepted records. Historical independent review lineage has been reconciled for their exact revisions; this is not a new visit, fresh all-image inspection or release approval. The original migration report describes an earlier stage, not these current candidate counts.

A clean screenshot can show the relevant public source page, not necessarily a homepage. Captions identify the page and its exact source address and capture date. An existing weekly capture workflow does not create a whole-overview visit or a new substantive revisit cadence. The 21 unfinished records stay unchanged outside the candidate selection, with permanent IDs and history retained.

## Final-content review

One contributor prepares the record. A separate reviewer checks the final
version against the sources and inspects actual screenshot pixels. The check
receipt binds to the digest of text, sources, visit date, screenshot, trials and
preparer. Editing one of those fields invalidates it. Merely giving two
identifiers different names does not establish independence; the review owner
must establish that separately.

A reviewed record needs an actual UTC whole-card visit, a final review receipt
and a screenshot matching the pinned manifest hash and capture date, explicitly
checked for clean pixels and correspondence with the overview. Sources and the
canonical domain need clean trust-engine results before a non-draft build.
No fixed weekly visit or image-replacement interval is introduced here.

Aptets remains held: continuity of the old Agent Knowledge Network entity with
the current product is unresolved. The existing slug and URL are not renamed,
redirected or silently repurposed. A blocked source is not proof of closure.

## Compatibility, not a second editorial system

- API v1 keeps old claims, verified_at, last_checked, evidence-level,
  keys-and-books, first-task, money and reachability fields with their old
  meanings. In particular verified_at is not relabelled as a whole-card visit.
- The additive optional `overview` object is the new primary editorial view:
  state, text, visited_at, sources, revision and actual trials when present.
  Internal editor notes, preparer/check identifiers and working history are
  excluded. The same text and date appear in HTML and Markdown.
- MCP card reads receive this object from the same v1 card file. Compact search
  rows and the TypeScript row selector preserve the optional overview too.
- A breaking removal or changed meaning requires a new major API path. Do not
  delete old fields under v1 to make its payload look simpler.
- The local candidate does not claim a released API minor version. Select the
  release version with the actual accepted cutover, not before publication.
- Legacy /earn data and badge URLs survive, explicitly labelled as legacy
  evidence, not proof of a new overview visit. Closed and safety-removed pages
  retain the existing history and no-outbound-link rules.

## Automation boundary

The existing refresh script has an explicit offline overview mode:

```sh
python atlas/refresh.py --overviews atlas/drafts/overviews.json --dry-run
```

It produces a review queue, makes zero network reads and changes no claim,
visit date, receipt, closure state or screen. A queue is not a completed visit.
The existing scheduled workflow is NOT switched to this mode by this candidate;
its current legacy work remains documented as such. The new mode does not
silently create a schedule or approve spending.

The old three-PR screenshot publication chain is still a production dependency:
card PR, atlas-screens PR, then a main screens.lock PR. Preparing the overview
and its image together locally removes repeated editorial forms, but does not
pretend those external merge boundaries have disappeared. Consolidating the
release packaging is a separate concrete cutover change, not an excuse to drop
pinned images, visual review, link safety or owner approval.

## Release and rollback boundary

Before a release proposal: finish the selected editorial batch; obtain separate
final-content review; verify source and screenshot safety; inspect desktop and
mobile; compare HTML/MD/JSON/MCP; run unit, schema, site, browser and privacy
checks; verify documentation and generated mirrors. Do not report a skipped
privacy scan as a pass. New and old API contracts must be checked independently.

The release mechanism itself remains the existing one: final SHA on main,
staging plus read-only E2E, then the same SHA and the owner's production
approval. Its manifest pins code/data SHA and screens.lock image SHA. This
candidate does not call, bypass or replace that mechanism. Connecting the
new overview input to the release build is still an explicit cutover task;
a normal legacy build must not be mistaken for testing the new source.

Preserve the baseline commit, overview-source hash, legacy snapshot hash,
screenshot lock and the exact test/preview artifacts. Before any release,
record the prior deployed Worker version. Worker rollback does not roll back
D1 migrations. No D1 migration is introduced here. Never promise that a database
restore is implicit in a code rollback.

## Required impact check

Use [ATLAS-CONSISTENCY-MATRIX.md](ATLAS-CONSISTENCY-MATRIX.md) for the source,
rendering, read APIs, documentation and automation inventory. It distinguishes
local implementation, legacy contract, pending cutover and live verification.
Updating these files does not prove that production documentation has changed.

## One local overview + screenshot handoff

A single command now packages the selected overview batch with the exact image
bytes, capture manifest, baseline snapshot and a hash inventory:

```sh
python atlas/tools/overviews.py bundle --file atlas/drafts/overviews.json \
  --screens-dir atlas/site/.screens-cache/branch \
  --only <slug>,<another-slug> --out <new-local-bundle-directory>
python atlas/tools/overviews.py verify-bundle --file <local-bundle-directory>
```

The bundle README gives an offline preview command using its own images. It
cannot overwrite an earlier bundle. Hash mismatches, extra files, bad IDs,
wrong real pixel dimensions and missing evidence are explicit. Missing images
are reported and do not create acceptance. A package is not a reviewer receipt.
The ordinary platform asset packager rejects the local draft-preview marker,
including when someone passes its directory through --dist. This reduces the
risk of confusing a working artifact with staging/production input.

A batch can be previewed alone against the full legacy snapshot: unselected
cards remain legacy. No all-or-nothing cutover of366cards is forced. The release
selection must explicitly list the reviewed batch; drafts remain outside it.


## Explicit accepted-batch selection

After actual visits, image review and independent final-content checks, make a
source file containing only that accepted batch and a separate JSON selection
file, for example `{"slugs": ["existing-permanent-slug"]}`. The sets must match
exactly, with no duplicate selection. These are future acceptance commands,
not commands that can accept the current draft file:

```sh
python atlas/tools/overviews.py validate --file <accepted-source.json> \
  --publishable --selection <selection.json> --screens-manifest <manifest.json>
python atlas/site/build.py --overviews <accepted-source.json> \
  --overview-selection <selection.json> --no-mirror --out <acceptance-dist>
```

The ordinary full snapshot remains the compatibility and identity input. A
new listing still needs its permanent identity and baseline snapshot entry,
closure/safety handling, event and history integration. This work is not a
replacement intake/identity registry. It removes mandatory claim-layer writing
from the proposed overview, not every existing new-card integration step.
