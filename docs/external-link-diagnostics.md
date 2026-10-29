# Advisory external-link diagnostics

This is a partial checker-diagnostics proposal for [#167](https://github.com/commonworld-one/commonworld/issues/167), not completion of its link triage.

The external-link job still runs Lychee with the same arguments, accepted statuses and non-blocking behavior. Its original summary, raw report, exit code and tracking-issue step remain authoritative and unchanged. An additional advisory summary explains two explicitly annotated API responses; it does not convert Lychee failures into successes or replace the issue body.

## Proposed annotation contract

`lychee-api-endpoints.json` has version `1` and an `endpoints` list. Each entry has exactly:
- `card`: an existing snapshot slug;
- `url`: the exact URL in a supported, directly observed `protocol` claim;
- `accept`: a nonempty list drawn from `401, 402, 405, 406`;
- `reason`: a nonempty review explanation.

The initial entries are only AsterPay's documented unpaid GET (402) and Arkham's documented POST endpoint, which returns 405 to the checker's GET. This schema and these annotations are proposed for maintainer review, not an assertion of prior approval. Do not infer eligibility from an `api` hostname, URL prefix or prose mentioning a status code.

Matching remains literal, including query/fragment/trailing slash. Canonical homepages are rejected, including query/trailing-slash variants; decoded dot-segment paths are rejected conservatively rather than normalized into a broader match. Unknown cards, statuses, schemas, unsupported claims or report formats are rejected. Other URLs, TLS errors, timeouts, 404s and 5xx responses stay unresolved.

“Alive” means the recorded response was classified as requiring authentication, payment, another method or content negotiation. It does **not** establish current health, authenticated access or a working paid service.

## Operational behavior

The classifier reads files and emits JSON; it never performs network requests. Exit 0 means parsing/classification succeeded, **not that the link check passed**. Invalid input returns 2 with no JSON result.

The advisory wrapper requires Bash and GNU `realpath -m` (provided on the Ubuntu CI runner). It checks raw-report/summary path aliases before writing anything, including same files, symlinks, hardlinks and equivalent missing paths. If it cannot establish separation it exits nonzero on stderr without appending through either path. This is a pre-write path check, not a concurrent-filesystem locking mechanism.

With distinct paths, missing Python or rejected input gives an explicit UNCLASSIFIED advisory; the original report and exit are retained. The step has `continue-on-error: true` so a diagnostics problem does not suppress the existing Report step.

## Tests

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
```

The public fixture is a small, documented excerpt, with recomputed counts: 7 errors and 1 timeout become 5 unresolved errors, 1 timeout and 2 annotated responses. Tests exercise the CLI, exact workflow run block, malformed inputs, shell-text handling and file-alias protection. These offline checks do not execute Actions, Lychee, the site build or live endpoint probes. #167's remaining domain rechecks and broader annotation decisions are separate work.

