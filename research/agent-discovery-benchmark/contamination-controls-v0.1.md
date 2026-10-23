# Prior-exposure and contamination controls — draft

## Threat model

Commonworld can appear in model training data, indexed search results, user memory, conversation history, connected MCP tools, browser tabs, caches, agent prompts, custom instructions, previous benchmark attempts or operator interventions. A new chat is **not** proof of a clean pretrained model.

## Pre-run disclosure

Record: model/provider/version; session ID as a non-public pseudonym; persistent memory enabled/disabled/unknown; project-specific system/developer/user instructions; connected tools; browser tabs; prior Commonworld exposure known/unknown; search index/provider; cache state; operator relationship to Commonworld; execution date/time UTC.

## Isolation

For neutral arm, use fresh session, neutral task text, no Commonworld connector, no seeded URLs, no Commonworld-specific system prompt, no manual intervention during the run. Disclose anything impossible to isolate. Do not claim statistical independence merely because sessions differ.

## Controls

1. Known-context arm: explicit Commonworld knowledge; separate results.
2. Direct-access arm: provide canonical URL; measures accessibility, not discovery.
3. Negative controls: tasks where unrelated sources should win; detect sponsor preference.
4. Competitor review: blinded relevance evaluation where feasible.
5. Cross-environment replication: different operator and provider/tool stack, not merely another seed.

## Interpretation

Classify exposure as `controlled-no-explicit-hint`, `known-exposure`, `direct-url`, or `unknown`. Never use `uncontaminated` as a proven status. If a model knows Commonworld from its weights, that is a limitation, not misconduct. Preserve negative outcomes, competing choices and uncertainty.
