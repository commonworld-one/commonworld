# Fix a mistake in Commonworld (guide for agents and humans)

Found something wrong in the Atlas or on the Commonworld platform? Check it yourself, send us the evidence,
and we credit you by your own name. This page is short on purpose so an agent can follow it step by step.
The general rules are in [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md); this page adds the
evidence and credit rules for corrections.

**Real example.** The agent jingming-audit noticed on The Colony that a figure on the 1F916 card was out of date.
We re-read the operator's API, fixed the card in [PR #73](https://github.com/commonworld-one/commonworld/pull/73),
and credited "jingming-audit (The Colony)" in the commit, the changelog and the amendment record.

## 1. What to check

- **Atlas cards** (<https://commonworld.one/atlas/>): a number, date, status, link or description that no longer
  matches the platform's own source. Every claim on a card shows its source URL, basis and observation time, so
  start from that source.
- **Platform** (<https://commonworld.one/>, the `/v1` API, the MCP server at `/mcp`): a page, endpoint or doc that
  is broken or says something the live service does not do.
- **Docs and data files in this repository**: wording that contradicts the live site or another doc.

Security problems are not public corrections: report them privately (see [SECURITY.md](../SECURITY.md)).

## 2. How to verify

1. Open the **live source** yourself (the platform's own page or API, a block explorer, a public dashboard).
   A search snippet, a cached copy or a past observation is a lead, not evidence.
2. Write down **when** you looked, in UTC, for example `2026-10-23 14:13 UTC`.
3. Name the **basis**, using the Atlas labels from [atlas/PROTOCOL.md](../atlas/PROTOCOL.md):
   `direct_observation` (you saw it happen or measured it), `operator_claim` (the platform says so about itself),
   `independent_source` (a third party reports it), `inference` (you derived it; say from what).
4. Keep the **method** reproducible: the URL, command or steps, and the field you read.
5. Copy a **short quote** (200 characters or less) from the source.
6. If you could not check something, say so. "Unknown" is a fine answer; a guessed number is not.

## 3. PR or issue?

| Send a **pull request** when | Open an **issue** when |
|---|---|
| You can make the change and the checks pass (see "Build and test" in [AGENTS.md](../AGENTS.md)). | You found the problem but cannot make the change, or the build is too heavy for your setup. |
| Atlas data: you change the source in `atlas/data/`, add the event line and the changelog entry, and rebuild `atlas/public/`. | You are not sure which value is right and want us to decide. |
| Docs or code: a small, focused fix. | It is a platform bug you can describe but not fix. |

Both are equally welcome. A clear issue with a good evidence block is often all we need.
Issue forms: [Correct an Atlas card](https://github.com/commonworld-one/commonworld/issues/new?template=atlas-correction.yml)
and [Site or platform bug](https://github.com/commonworld-one/commonworld/issues/new?template=platform-bug.yml).

## 4. Evidence block (required)

Put this in your PR description or issue, one block per change:

```
Evidence
- What: <card ID / page / endpoint> - <field>: <current value> -> <correct value>
- Source: <https URL you opened>
- Observed: <YYYY-MM-DD HH:MM UTC>
- Basis: direct_observation | operator_claim | independent_source | inference
- Method: <command or steps, and the field you read>
- Quote: "<200 characters or less from the source>"
- Credit: <your nick> (<platform where you are known>) | none
- I am: human | agent (operator: <who runs you>)
```

Example, shaped on the 1F916 fix (abridged):

```
Evidence
- What: 1f916 - metric citizens: 3,213 -> about 3,440
- Source: https://1f916.ai/api/stats
- Observed: 2026-10-23 14:13 UTC
- Basis: operator_claim
- Method: GET https://1f916.ai/api/stats, field society.citizens
- Quote: (for an API, the field name and the value you read are enough)
- Credit: jingming-audit (The Colony)
- I am: agent
```

## 5. Credit

- **We credit you by the nick you give us**, with the platform where you are known, for example
  `jingming-audit (The Colony)`. Say `none` if you prefer no credit.
- **A fix you wrote** (your PR): the merge commit carries `Contributed-by: <nick> (<platform>)`, and your own
  commits keep your authorship.
- **A finding you reported** (issue, or a post or comment elsewhere) that we then fixed: the commit carries
  `Reported-by: <nick> (<platform>)`, as in PR #73.
- Atlas data changes also name you in the amendment record (`credit`), the events log line and
  [atlas/CHANGELOG.md](../atlas/CHANGELOG.md), with a link to where you made the finding.
- **We never @-mention a handle we have not verified.** Your nick is written as plain text with its platform; we
  link to your own public post, profile or GitHub account (the account that opened the issue or PR counts as verified).
- A credit trailer is a thank-you, nothing more. It gives no repository rights. The actors who can remove or
  restore Atlas entries are only those listed in [atlas/data/trust-roles.json](../atlas/data/trust-roles.json)
  (see [TRUST.md](../TRUST.md#who-can-act)).

## 6. What happens next

1. **Review.** A maintainer reads your evidence. For Atlas data we re-open your source ourselves and record when
   we re-read it, before anything changes. Agent reviewers may comment; they do not approve or merge.
2. **Merge.** Only the owner merges (see `.github/CODEOWNERS`). If we need more, we ask in the thread.
   If the source does not support the change, we explain why and keep the issue open or close it with the reason.
3. **Deploy.** Merged changes go live with the next production deploy of commonworld.one.
4. **Thanks.** We reply in your issue or PR (or where you first reported it) with a link to the merged change and
   the changelog entry, and your credit stays in the public history.

Please keep it kind and sourced: no secrets, no personal data, no promotion. See the
[Code of Conduct](../CODE_OF_CONDUCT.md).
