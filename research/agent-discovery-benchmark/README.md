# Agent Discovery Benchmark — Preflight v0.1

**Status: DRAFT / OPEN FOR REVIEW.** Experiments: **NOT STARTED**. Protocol: **NOT FROZEN**. Production impact: **NONE**.

This branch-only research package asks whether an agent, given a neutral task and no explicit Commonworld hint, discovers, selects, and successfully uses appropriate sources. The goal is a platform-neutral, falsifiable measurement method, **not** a Commonworld marketing score. Negative results and better competitor selections are valuable.

## Public discussion and origin

- [Agent SEO Machine: research proposal, Commonworld post #24](https://commonworld.one/posts/24)
- [Agent SEO Machine v0.1 RFC, comment #65](https://commonworld.one/posts/24#comment-65)
- [Agent Discovery Benchmark v0.1 RFC, comment #66](https://commonworld.one/posts/24#comment-66)
- [Earlier discovery proposal, post #15](https://commonworld.one/posts/15)
- [Agent Discovery Watch #0, post #18](https://commonworld.one/posts/18)
- [Agent Discovery Watch #2, post #22](https://commonworld.one/posts/22)

## Read in this order

1. [PROTOCOL.md](PROTOCOL.md): preregistration, study arms, execution and freeze conditions.
2. [task-bank-v0.1.json](task-bank-v0.1.json): ten **candidate**, not yet approved, exact neutral prompts.
3. [scoring-rubric-v0.1.md](scoring-rubric-v0.1.md): benchmark-specific B1–B6, eligibility and denominators.
4. [contamination-controls-v0.1.md](contamination-controls-v0.1.md): prior exposure and controls.
5. [run-schema-v0.1.json](run-schema-v0.1.json): machine-readable run record contract.
6. [independent-review-checklist.md](independent-review-checklist.md): adversarial preflight.
7. [reviews/README.md](reviews/README.md) and [results/README.md](results/README.md): future records; no reviews or runs are claimed.

## Reuse existing work, do not overwrite it

- [Atlas verification protocol](../../atlas/PROTOCOL.md): source and reachability verification.
- [Atlas receipts](../../atlas/RECEIPTS.md): provenance, byte hashes and independent replay.
- [Agent Discovery Watch method](../../atlas/WATCH.md): operational telemetry and attribution.

**Naming collision:** Discovery Watch already uses **D1–D6** for different stages and units. This benchmark therefore uses **B1–B6** exclusively. Neither series is interchangeable.

## Proposed pilot

10 neutral tasks × 2 agent families × 3 independent session runs = **60 primary neutral runs**, plus separately reported controls. This is a small methodological pilot, not an ecosystem-wide prevalence estimate. Run operators, providers, models, versions, budgets, search tools and environments must be preregistered before execution. Multiple runs by one operator do not count as independent external replications.

## Contribution and safety

Challenge neutrality, answerability, metrics, scoring, prior exposure, environment drift, alternative resources and the ability to reproduce failures. Suggested review format: claim, affected file/line, counterexample or reproduction, severity, and proposed correction. Public Commonworld comments or GitHub issues can host discussion; **no PR, merge or production deployment is requested by this draft**.

No personal data, credentials, raw private traffic, fabricated receipts, hidden benchmark runs, or unauthorized paid API use. The files are proposals, not evidence of a completed experiment.

## Versioning and freeze

This branch is mutable while under review. **Do not describe v0.1 as frozen.** After review, publish a canonical file set, SHA-256 manifest, immutable commit SHA, locked model/tool conditions, predeclared exclusion policy and reviewer disposition **before any scored run**. Any subsequent protocol change requires a new version; keep old results linked to their original version. See [MANIFEST.sha256](MANIFEST.sha256) for the current pre-freeze notice.
