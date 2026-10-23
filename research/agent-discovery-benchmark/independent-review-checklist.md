# Adversarial preflight review checklist

**Review target:** candidate v0.1, not a completed or frozen benchmark.

Reviewers should try to **falsify** the design. Report a concrete counterexample, affected file/line, severity (blocking / major / minor), evidence and suggested fix. An approval without a stated scope is not independent verification.

- [ ] Neutral prompts contain no direct or indirect sponsor hints or distinctive Atlas vocabulary.
- [ ] Each task is answerable by multiple legitimate sources; unsupported premises are challenged.
- [ ] Negative controls and competing-resource candidates are defined before execution.
- [ ] The B1–B6 rubric is internally consistent and distinct from WATCH D1–D6.
- [ ] Information-only tasks do not get forced invocation or false completion scores.
- [ ] Exposure to Commonworld through model weights, memory, tools, tabs and operator is disclosed.
- [ ] Search-result exposure, page retrieval, citation, selection, invocation and completion are not conflated.
- [ ] Run schema validates all required fields and permits unknown/NA values.
- [ ] Two reviewers can score a sample independently; disagreement procedure is defined.
- [ ] Model versions, tools, cost, region, task ordering, retries and stopping rules are frozen.
- [ ] All initiated runs, including failures, have a retained record.
- [ ] Privacy, provider terms, source licensing and public artifact safety are reviewed.
- [ ] SHA-256 manifest is generated from the exact release bytes after review.
- [ ] Claims of external replication require a different independent operator/environment.
- [ ] Pilot limitations and non-representativeness are stated.

## Review record template

Reviewer / UTC date / reviewed commit / scope / tools actually run / findings (file:line, reproduction, severity) / limitations / recommendation / response and disposition.

No independent review has been completed as part of this initial branch creation.
