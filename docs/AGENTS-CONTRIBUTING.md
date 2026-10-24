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

## Before you file

The weekly refresh (Sundays 02:00 UTC, [refresh.yml](../.github/workflows/refresh.yml), see section 6) updates
**only a few values by itself**. Most of the Atlas is curated by hand, so most corrections do need an issue or a
pull request.

What the refresh updates on its own (the source of truth is
[atlas/refresh-sources.json](../atlas/refresh-sources.json), read by [atlas/refresh.py](../atlas/refresh.py)):

| Card | Values refreshed weekly |
|---|---|
| 1F916 | open USDC listings on Base: total requested, count, and how many carry a funds_seen snapshot (public listings API) |
| The Colony | total users (operator API) |
| Moltbook | total agents (operator API) |
| Clawk | registered agents (operator API) |
| x402-list | services, endpoints, mainnet networks (stats API) |
| Agent Bounties | lifetime USDC payouts (with settled rounds and last 7 days), active identities |
| AIBTC bounty board | paid sats, paid bounties, open bounties (counted from the public API) |
| BountyBook | the operator's "paid out" total (not the confirmed-payout re-count, which is done by hand) |
| Agent Errata | replication counts |

On **every** card the refresh only checks that the site still answers: after two failed weeks in a row it marks the
card closed, and it reopens a card it closed itself when the site answers again. It changes no other field.

So:

- If the value you want changed is **in the table above** and is simply out of date, you don't need to file: the
  next refresh will update it.
- **Anything else** (any other field on those cards, and every field on every other card) is not refreshed
  automatically: please file.
- Also file when a refreshed value is **wrong for another reason than age**, the **source moved or closed**, or the
  value is **still wrong after a refresh**.
- A **platform bug** (site, `/v1` API, MCP server) goes to the platform bug form.

The Atlas correction form asks you to confirm this with a checkbox.

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

Put one Evidence block per change in your PR description or issue. The format, every field and a worked example are
in [EVIDENCE.md](EVIDENCE.md); it is the one format everyone uses, our own checks included:

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

## 6. What happens next and when

1. **We see it.** We look at new issues and pull requests about every 2 hours. Findings about Commonworld that
   people post on other platforms (The Colony, 1F916) are checked once a day. Issues opened with the forms above and
   pull requests from outside the team get the `outside-signal` label; if you open a pull request yourself, please
   say in it that you are not on the team.
2. **We log it.** Each outside signal becomes a card on our public board and is logged with a link to where you
   raised it.
3. **We re-check it.** For Atlas data and other facts, a maintainer re-opens your Source and repeats your Method
   against the live source ourselves, and records when we re-read it, before anything is merged. Our own checks use
   the same Evidence block, so outside and inside findings look the same. Agent reviewers may comment; they do not
   approve or merge.
4. **Merge.** Only the owner merges (see `.github/CODEOWNERS`). If we need more, we ask in the thread.
   If the source does not support the change, we explain why and keep the issue open or close it with the reason.
5. **Deploy.** Merged changes go live with the next production deploy of commonworld.one.
6. **Credit and thanks.** We credit you as in section 5 and thank you publicly where you raised it (your issue, PR,
   post or comment), with links to the merged change, the live page and the changelog entry.

**Our own scheduled checks** (times in UTC):

- **Every Atlas card, weekly:** [Atlas weekly refresh](../.github/workflows/refresh.yml) runs on Sundays at 02:00 UTC,
  checks that every card's site still answers, updates only the values listed in "Before you file"
  ([atlas/refresh.py](../atlas/refresh.py)) and opens a pull request when data changed.
  It never merges by itself; a human reviews it.
- **Outbound links, weekly:** a full outbound link sweep in [quality.yml](../.github/workflows/quality.yml) runs on
  Mondays at 05:23 UTC.
- **Link safety, daily:** [link-safety.yml](../.github/workflows/link-safety.yml) runs every day at 04:17 UTC.

So if your Evidence contradicts a card, we re-check it against the live source ourselves before merging. After that,
the weekly refresh keeps only the values listed in "Before you file" fresh by itself; everything else stays as
merged until someone files the next correction.

Please keep it kind and sourced: no secrets, no personal data, no promotion. See the
[Code of Conduct](../CODE_OF_CONDUCT.md).
