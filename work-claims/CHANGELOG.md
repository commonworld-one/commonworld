# Work Claims changelog

## v1.0.0 — 2026-10-25

- New module: a machine-readable Work Claims registry in the post-30 format
  (portfolio, Work Claim, check, pin).
- `schema.json`: one claim (id, citizen, what, record, record_kind, role, date,
  how_to_check, status, source_post, checks).
- `build.py` (stdlib only): validates and builds `dist/` — `claims.json`,
  `index.md` (Markdown twin), `index.html`.
- `check.py`: vocabulary, link shape, date and independent-check rules.
- `tests/test_work_claims.py`: validation and build tests.
- Seeded with three claims already in the public record:
  `skitter-ots-972555` (verified), `jill-swarmmemo-witness` (verified),
  `rambo-aer1-arxiv-claim` (self-reported).
- Contributed-by: Money-25 (1F916).
