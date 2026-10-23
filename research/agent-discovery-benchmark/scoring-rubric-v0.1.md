# Benchmark scoring rubric — B1 to B6 (draft)

**Do not confuse these labels with D1–D6 in [Atlas WATCH](../../atlas/WATCH.md).** WATCH D1 is a crawler request, whereas benchmark B1 is evidence of a particular run discovering a resource.

Score each dimension **pass / fail / not-applicable / unknown**, with an evidence pointer. A missing trace is **unknown**, not fail. Never infer a later stage from an earlier one.

| Stage | Pass evidence | Fail evidence |
| --- | --- | --- |
| **B1 — Discovery** | A permitted run trace explicitly retrieves or encounters a Commonworld URL without the URL being supplied in the neutral prompt or tools | Eligible trace shows no Commonworld retrieval/encounter |
| **B2 — Citation** | The final answer cites a specific Commonworld URL | Eligible final answer has no Commonworld citation |
| **B3 — Relevance** | Independently checked selected resource(s) materially answer the user task with current primary-source support | Selected resources are demonstrably unsuitable or unsupported |
| **B4 — Selection** | Agent selects an appropriate source/resource for the task, whether Commonworld or competitor | Selection is demonstrably inappropriate given available evidence |
| **B5 — Invocation** | A documented, permitted API/MCP/tool action succeeded and has a tool response or receipt | An attempted eligible action failed |
| **B6 — Completion** | Independently inspectable evidence shows task completion, regardless of platform | Evidence shows task was not completed |

**B1/B2 measure Commonworld visibility; B3/B4/B6 measure task quality across all providers.** For B5/B6, information-only tasks may have no justified action; use **not-applicable**, never force an API call. The 10 candidate tasks currently mix information-only and action-oriented goals; reviewers must decide whether to add explicit safe action tasks before freeze. B1 pass does not imply B2; B2 does not imply B4; B5 does not imply B6.

## Denominators

Report per stage: eligible runs, passes, failures, unknowns, N/A, and exclusion reasons. Primary discovery rate = B1 passes / eligible neutral runs with sufficient retrieval trace; separately report fraction with missing trace. Citation rate = B2 passes / eligible neutral runs with available final response. Task success = B6 passes / eligible task-completion runs, where task-completion is operationally defined in advance. Never mix requests, distinct accounts, run counts or control arms.

## Source adjudication

For B3 and B4, check source freshness, evidence quality, task fit and comparison alternatives using a fixed adjudication form. Do not privilege Commonworld. Capture independent disagreement and corrections. No arbitrary score for merely naming a domain. URLs found by search but not exposed to the agent do not count as B1.

## Important unresolved design questions

- Are all ten prompts answerable and measurable with permitted tools?
- What evidence distinguishes search-result exposure from a page actually retrieved?
- Which tasks justify invocation, and should invocation be a separate action-task stratum?
- How will relevance adjudicators be blinded and disagreements resolved?
- What is the preregistered handling of tool traces unavailable in consumer interfaces?

These must be resolved before freezing.
