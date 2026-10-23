# Agent Discovery Benchmark — draft protocol v0.1

**Pre-registration candidate only. No scored runs authorized or performed.**

## Research questions

RQ1: Under a neutral information-seeking task, does an agent retrieve or cite Commonworld without explicit prompting? RQ2: Does it choose the best-supported relevant resource regardless of provider? RQ3: When an appropriate resource is selected, can it invoke a documented capability and complete a verifiable task?

Separate Commonworld discovery from overall task success. A competing platform can be the correct answer. Do not optimize prompts against observed benchmark outputs.

## Study arms

- **Neutral primary arm:** exact prompts in the task bank; no project-specific hints, Commonworld connector, seeded tabs, custom search boosts or user-provided Commonworld links. Fresh session and disclosed model memory settings. This cannot prove that pretrained weights or public indexes never contained Commonworld.
- **Known-context arm:** explicitly disclose project familiarity; separately analyzed, not in the 60-run primary denominator.
- **Direct-access positive control:** supply an exact canonical resource URL to test access and usability, not discovery. Separately analyzed.
- **Negative controls:** independently chosen tasks where Commonworld is not an appropriate or best source; score over-selection. Define and freeze the exact prompts before any run.

## Design and ordering

Primary: 10 tasks × 2 model families × 3 runs = 60. Fix family/model versions, provider, search/browser/API capabilities, run budgets, region, system prompt, account/session isolation, execution order and seed policy before freeze. Randomize task order with a preregistered seed. Never silently replace a failed run or unavailable model. Model drift is a new stratum or protocol version.

A human adjudicator must independently verify source claims using primary URLs; a second blind adjudicator reviews a predeclared subset. Adjudicators should not know which platform is the study sponsor when evaluating relevance, where feasible. Resolve disagreements with a logged rationale.

## Procedure

1. Verify preflight approvals and immutable protocol commit.
2. Create an isolated session, record provider/model/tool versions, context exposure and UTC time.
3. Run the **exact** task text, without platform-specific follow-ups or covert hints.
4. Preserve permitted search/tool trace, raw final answer, retrieved/cited URLs and failure information.
5. Score B1–B6 independently using the frozen rubric. Distinguish observed traces from inferred actions.
6. Validate evidence, mark missing fields as unknown, record exclusions without deleting rows.
7. Publish aggregate tables with denominators, uncertainty, limitations, counterexamples and non-Commonworld choices.

## Exclusion and stopping policy

Before freeze specify timeouts, maximum cost, retry allowance, unavailable provider handling, disallowed tool errors and exact eligibility checks. Default draft rule: **all initiated runs remain in the dataset**; exclude only documented invalid environment/setup runs, never because the result is unfavorable. Stop after planned runs; no optional early success stopping. Do not count controls in primary totals.

## Evidence, privacy and integrity

Use UTC ISO-8601 timestamps; retain exact prompt bytes and SHA-256; pin external resources when licensing permits. Source URLs, snapshots, public receipts and command versions should enable replay. A hash is evidence of byte identity, not independent proof of execution or time. Do not expose private account identifiers, IPs, tokens or sessions. Treat Cloudflare crawler telemetry as contextual observations, **not** proof of any benchmark run.

## Preflight release gate

Resolve review checklist, lock task text and negative controls, scoring rules and denominators, environment matrix, adjudicator protocol, data retention, costs and exclusions. Record reviewer findings and dispositions. Then compute SHA-256 for canonical bytes, publish manifest and commit SHA, and only then begin scored runs.

## Interpretation

The pilot is small, model/tool dependent, and potentially contaminated by public model knowledge. Report descriptive rates, confidence/uncertainty where justified, per-task breakdown and failure stages; never claim representative population statistics or causal effects from observational differences.
