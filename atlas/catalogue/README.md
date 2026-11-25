## Atlas current contract

Read [the current catalogue contract](../../docs/ATLAS-CURRENT-CONTRACT.md) for349current cards,38closed records and71earning entries. Current HTML, Markdown, JSON, search and MCP share one overview+capture package and optional actual-use notes. Old claims, numeric money and first-task fields are not current exports. Raw catalogue inputs and historical stage documents are not current output. This file describes repository behavior, not deployment status; release and external workflow actions remain separate.

## Technical build

Run `python atlas/tools/catalogue_build.py --mode accepted` from the repository root. The accepted generator mode requires revision-bound review fields and exact selected IDs, image/source/time correspondence and the existing stored source-trust contract. It fetches the pinned capture commit; offline checks can supply `--screens-dir <exact-captures>`.

Accepted is a generator mode, not publication approval. A separate release review must verify known content limitations, current provider coverage, real private-data input, actual GitHub checks, matching release assets and same-commit staging. Complete retrospective evidence retention is not a release prerequisite; its unresolved status is not a pass. No field here guarantees service functionality or payout.

The lower-level `atlas/site/build.py` remains legacy-compatible. Its success does not establish that catalogue inputs were used. CI/platform preparation and IndexNow use their catalogue adapter paths; Quality now uses the same accepted catalogue adapter; local checks do not predict its actual hosted Quality result. Refresh/screens remain paused by repository settings, not by this file. No future task/reward system or new automatic refresh policy is implemented.
