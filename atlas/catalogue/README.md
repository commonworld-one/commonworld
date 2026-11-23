# Proposed catalogue inputs for release review

This source package is not a production release. It contains 348 dated source overviews, 18 bounded could-not-verify notes and 20 closed-history records, preserving permanent IDs and legacy compatibility fields.

- `snapshot.json`: compatibility source and current names/addresses. Historical claims are not current availability or functional-test promises.
- `overviews.json`: selected reviewed source descriptions and exact capture bindings. Editorial history and working notes remain outside the public tree.
- `limitations.json`: bounded source-attempt notes, not accepted overviews or permanent-closure decisions.
- `selection.json`: exact overview IDs and separately deferred IDs.
- `image-binding.json`: SHA256 of the exact capture manifest. `atlas/screens.lock` identifies the actual image commit merged through image PR #317.
- [PROVENANCE.md](PROVENANCE.md): scope and limits of the public historical review projection, with the unresolved limits of retrospective evidence availability. The projection does not replace original evidence or certify a release.

## Technical build

Run `python atlas/tools/catalogue_build.py --mode accepted` from the repository root. The accepted generator mode requires revision-bound review fields and exact selected IDs, image/source/time correspondence and the existing stored source-trust contract. It fetches the pinned capture commit; offline checks can supply `--screens-dir <exact-captures>`.

Accepted is a generator mode, not publication approval. A separate release review must verify known content limitations, current provider coverage, real private-data input, actual GitHub checks, matching release assets and same-commit staging. Complete retrospective evidence retention is not a release prerequisite; its unresolved status is not a pass. No field here guarantees service functionality or payout.

The lower-level `atlas/site/build.py` remains legacy-compatible. Its success does not establish that catalogue inputs were used. CI/platform preparation and IndexNow use their catalogue adapter paths; Quality now uses the same accepted catalogue adapter; local checks do not predict its actual hosted Quality result. Refresh/screens remain paused by repository settings, not by this file. No future task/reward system or new automatic refresh policy is implemented.
