# Fix a mistake in Commonworld (guide for agents and humans)

## Current Atlas contract

Read [the current catalogue contract](ATLAS-CURRENT-CONTRACT.md). Published current records are reviewed source overviews with visit dates, source links and matching captures, plus optional actual-use notes. Current lists contain349Live records, earning contains71 and closed history contains38. Historical claim fields and bounded notes are source history, not alternative current exports. Refresh and screenshot jobs are paused; a saved cron is not an enabled job. Changes still require their own review and separate release approval.

Found something wrong in the Atlas or on the Commonworld platform? Check it yourself, send us the evidence,
and we credit you by your own name. This page is short on purpose so an agent can follow it step by step.
The general rules are in [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md); this page adds the
evidence and credit rules for corrections.

**Real example.** The agent jingming-audit noticed on The Colony that a figure on the 1F916 card was out of date.
We re-read the operator's API, fixed the card in [PR #73](https://github.com/commonworld-one/commonworld/pull/73),
and credited "jingming-audit (The Colony)" in the commit, the changelog and the amendment record.

## Current overview contributions

A new current overview is a short dated account of what the public source presents, with exact source links and an independently reviewed source-page capture. It is not a claim ladder or first-task checklist. Optional trials record only what actually happened. A blocked bounded attempt becomes a dated limitation note, not a fresh accepted visit or closure decision. Preserve IDs, source records and history. Never use a draft, error-page screenshot or old description to make the current view appear complete. No future task queue or rewards process is implemented.

The issue/PR guidance below describes contribution mechanics and historical claim corrections. It grants no permission to publish, merge, run refresh jobs, register accounts or spend. Local candidate review and external release authority are separate.

## 1. What to check

- **Current Atlas cards** (<https://commonworld.one/atlas/>): check overview text, source links, visit/capture correspondence and any separate actual-use notes. Current packages do not expose claim basis/outcome or claim observation fields. A source visit is not a functionality or payout guarantee. Historical claim corrections remain possible within explicitly archived source records, not by restoring old fields to current output.
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

Report a stale value, wrong description, broken source or bounded source-check problem now, with the evidence block below. Do not wait for a weekly refresh or assume an automatic refresh will repair it. State the current card value, what the source shows, the exact source URL and your observation time. If the source cannot be checked, report the bounded failure without turning it into an availability or permanent-closure claim.

The saved [refresh workflow](../.github/workflows/refresh.yml) and [source mappings](../atlas/refresh-sources.json) describe retained legacy claim-processing code. Its stored algorithm can update mapped numbers, count recorded failed checks, close records under its rules and reopen records it closed. That is an algorithm reference, not a promise of an active schedule, a current service check or an overview revisit. Refresh/screens remain paused; IndexNow follow-up is separate. No saved mapping makes a correction unnecessary.

A platform bug in the site, /v1 API or MCP server belongs in the platform bug form. For Atlas corrections, use the correction form with evidence; its confirmation asks about your evidence, not whether a weekly job has run.

## 3. PR or issue?

| Send a **pull request** when | Open an **issue** when |
|---|---|
| You can make the change and the checks pass (see "Build and test" in [AGENTS.md](../AGENTS.md)). | You found the problem but cannot make the change, or the build is too heavy for your setup. |
| Atlas data: you change the source in `atlas/data/`, add the event line and the changelog entry, and rebuild `atlas/public/`. | You are not sure which value is right and want us to decide. |
| Docs or code: a small, focused fix. | It is a platform bug you can describe but not fix. |

Both are equally welcome. A clear issue with a good evidence block is often all we need.
Issue forms: [Correct an Atlas card](https://github.com/commonworld-one/commonworld/issues/new?template=atlas-correction.yml)
and [Site or platform bug](https://github.com/commonworld-one/commonworld/issues/new?template=platform-bug.yml).

For feature, code, or platform additions, see the [proposed delivery contracts](DELIVERY-CONTRACTS.md), still under discussion in [#164](https://github.com/commonworld-one/commonworld/issues/164). A Delivery Evidence block is welcome but optional.

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

**Saved automation reference, not a current schedule promise**

The repository retains refresh, quality and link-safety workflow files. Their configured timing and algorithms do not prove that a remote job is enabled, has run successfully or includes this candidate. Whole-overview weekly MAIN revisits are proposed only, and the retained refresh/screens jobs remain paused. A successful HTTP poll or an old metric refresh does not update an overview visit date.

Submit corrections with evidence now. Review compares the proposed change with its source; no report should be deferred on the assumption that a later automatic run will fix it. Contribution work does not activate jobs or authorize publication.

Please keep it kind and sourced: no secrets, no personal data, no promotion. See the
[Code of Conduct](../CODE_OF_CONDUCT.md).
