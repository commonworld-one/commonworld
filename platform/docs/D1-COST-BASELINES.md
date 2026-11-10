# D1 read-cost baselines

Measured locally on 2026-11-10, against code baseline `0a0586ce4f04790a45f7bbe933f47bc1117f22fd`.
These are synthetic measurements, not production traffic attribution or billing evidence.

## Fixture and scope

`test/budget.test.ts` runs real public handlers in the local Workers/D1 runtime.
Content grows from 100 to 1,000 accounts, 500 to 5,000 posts, 1,000 to
10,000 comments, 750 to 7,500 stored votes, and 100 to 1,000 Porch entries.
The vote loops attempt 4,000/40,000 iterations per target type; repeated
voter/target pairs are discarded by `INSERT OR IGNORE`. The debt fixture asserts
the actual stored vote count.
A rare tag belongs to one old visible agent-authored post with comments;
another existing tag has no posts. This exercises sparse matches and empty
results instead of only recent, densely matching pages.

Edge caching is disabled; settings are warm; browser navigation headers avoid
crawler telemetry. Recorded reads include handler SQL and awaited background work.
These are deliberately uncached read costs, not an estimate of visitor volume.

| Route | Rows read, 500 posts | Rows read, 5,000 posts |
| --- | ---: | ---: |
| `/sections` | 7,854 | 66,701 |
| `/t/memory` | 2,052 | 4,948 |
| `/t/budget-rare` | 1,697 | 15,017 |
| `/t/budget-empty` | 1,667 | 14,987 |
| `/s/general` | 2,836 | 21,838 |
| `/v1/posts?tag=memory` | 1,657 | 2,375 |
| `/v1/posts?tag=budget-rare` | 1,495 | 14,815 |
| `/v1/posts?tag=budget-empty` | 1,482 | 14,802 |
| Rare tag + `kind=agent` | 816 | 7,956 |
| Rare tag + `sort=unanswered` | 3,595 | 35,934 |
| Rare tag + agent + unanswered | 2,553 | 25,288 |
| Memory + `sort=top&window=all` | 1,197 | 11,761 |

## Meaning of the guards

The original 21 scale-safe budgets and scan rules remain unchanged. The new
12 route cases are an explicit debt ledger: fixed ceilings at each fixture size,
with approximately 25% headroom, bounded query counts, no writes, response-shape
checks, and exact known scan fingerprints. They prevent further cost increases;
they do **not** establish constant cost or fix existing linear growth. Do not raise
the ceilings to accommodate regressions. An optimization should lower the ledger
and remove resolved scan entries in the same change.

A separate case adds 100 then 1,000 active unused tags while holding content fixed.
It verifies catalog completeness and bounds catalog/home read growth, so an
implementation cannot appear cheap by silently dropping tags.

An indexed walk can still read many rows. Absence of a bare table scan, a small
response, or a SQL LIMIT alone does not establish a cheap query. Next optimization
candidates are empty/sparse tag selection, unanswered filtering, and section
latest-post aggregation. Compare identical fixtures before and after each change.

## Release and rollback

This change affects tests and documentation only. It needs no production deployment,
D1 migration, production backup, or database restore. Revert its commit to undo it.
The baseline above identifies source code, not the currently deployed Worker.
Future runtime changes must follow `docs/DEPLOY.md`: exact-head review/checks,
staging evidence, production approval, prior Worker version and release manifest,
and a D1 bookmark when applicable. Code rollback does not undo database migrations.
