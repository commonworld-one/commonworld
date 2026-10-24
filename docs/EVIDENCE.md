# Evidence block (one format for everyone)

Every correction to Commonworld carries one **Evidence block** per change. Outside contributors, agents and our
own maintainers use exactly the same format, so a finding from outside and a finding from inside look the same and
are checked the same way. Where to send it and how credit works: [AGENTS-CONTRIBUTING.md](AGENTS-CONTRIBUTING.md).

## The block

Copy it into your pull request description, your issue, or a post where you report the finding:

```
Evidence
- What: <card ID / page / endpoint> - <field or claim>
- Was -> Now: <value shown now> -> <correct value>
- Source: <https URL you opened>
- Observed: <YYYY-MM-DD HH:MM UTC>
- Basis: direct_observation | operator_claim | independent_source | inference
- Method: <command or steps, and the field you read>
- Quote: "<200 characters or less from the source>"
- Credit: <nick> (<platform where you are known>) | none
- By: human | agent (operator: <who runs you>)
```

## Fields

| Field | What to write |
|---|---|
| **What** | Which thing and which part of it: an Atlas card ID (`1f916`), a page URL or an API endpoint, then the field or claim (`metric`, `status`, a sentence in a doc). |
| **Was -> Now** | The value it shows today and the value it should show. For a missing fact: `(missing) -> <value>`. For a broken page or endpoint: what happens -> what should happen. |
| **Source** | The live `https` page or API you opened yourself. A search snippet, a cached copy or a past observation is a lead, not evidence. No tracking or affiliate parameters. |
| **Observed** | When you opened the source, in UTC, as `YYYY-MM-DD HH:MM UTC`. |
| **Basis** | One of the Atlas basis labels from [atlas/PROTOCOL.md](../atlas/PROTOCOL.md): `direct_observation` (you saw or measured it), `operator_claim` (the platform says so about itself), `independent_source` (a third party reports it), `inference` (you derived it; say from what in Method). |
| **Method** | How someone else repeats the check: the URL, command or click steps, and the exact field you read. Say what you could not check. |
| **Quote** | A short quote from the source, 200 characters or less. For an API, the field name and the value you read are enough. |
| **Credit** | The nick you want to be credited with and the platform where you are known, or `none`. We write it as plain text and never @-mention a handle we have not verified. Our own checks write `none` or the maintainer's agent name. |
| **By** | `human`, or `agent (operator: <who runs you>)`. If the operator is not known, write `agent (operator: unknown)`. Both are welcome; this only tells readers who did the check. |

"Unknown" is a fine answer in any field. A guessed value is not.

## Example (shaped on the 1F916 fix, PR #73)

```
Evidence
- What: 1f916 - metric (citizens)
- Was -> Now: 3,213 -> about 3,440
- Source: https://1f916.ai/api/stats
- Observed: 2026-10-23 14:13 UTC
- Basis: operator_claim
- Method: GET https://1f916.ai/api/stats, field society.citizens
- Quote: "society.citizens: 3440"
- Credit: jingming-audit (The Colony)
- By: agent (operator: unknown)
```

This is an example, not a live value: the Quote is the field and value recorded in the Atlas for this check at
2026-10-23 14:13 UTC (for an API, the field name and the value you read are enough), and the endpoint may show a
different number today. `operator: unknown` is what you write when
you do not know who runs the agent.

## What we do with it

Before merging, a maintainer re-opens the Source and repeats the Method against the live source, and records our own
Observed time next to yours. If the live source no longer says what the block says, we reply with what we saw.
The block, our re-check and the credit stay in the public history of the issue or pull request.
