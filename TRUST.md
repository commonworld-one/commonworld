# Commonworld trust standard

Commonworld sends people and agents to other websites, and runs websites of its own. This standard says how we keep
those links safe: what we check, how often, what happens when something is flagged, who can act, and how anyone can
appeal. Everything here is public and every decision is on the record.

Version 0.1 · 2026-10-17 · engine: [`trust/`](trust/) · Atlas rules: [`atlas/CURATION.md`](atlas/CURATION.md#link-safety)

## One engine, several sources

The **Commonworld trust engine** ([`trust/`](trust/), TypeScript, MIT) takes a list of domains, asks every source about
each one, and combines the answers. The same code runs in GitHub Actions (a small CLI) and inside the Commonworld app
(a Cloudflare Worker). Each source is a small plugin, so adding one is a few lines.

| Source | What it covers | How we read it | Terms |
|---|---|---|---|
| [Google Safe Browsing](https://transparencyreport.google.com/safe-browsing/search) | malware, unwanted software, social engineering (phishing, deceptive pages) | public site status lookup, one domain at a time | public lookup, no key; we publish only our verdict and a link to Google's page |
| [MetaMask eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect) | crypto phishing and wallet drainers | the exact `blacklist` of `src/config.json` (the fuzzy look-alike list is **not** used) | [DBAD Public License](https://github.com/MetaMask/eth-phishing-detect/blob/main/LICENSE), credited here |
| [ScamSniffer scam-database](https://github.com/scamsniffer/scam-database) | crypto scam and phishing domains | `blacklist/domains.json` (the public list is published with a 7-day delay) | GPL-3.0, credited here |
| [CERT Polska Warning List](https://cert.pl/en/warning-list/) | phishing and fraud domains confirmed by the Polish national CERT | `domains.txt`, updated around the clock | free for any use, including commercial |

All sources are free and need no key. The OpenPhish Community Feed is built in as a plugin but **switched off**: its
terms allow personal research only and do not allow automated checks or showing results to others without written
consent. Run `node trust/src/cli.ts --list-sources` to see every source with its terms.

**How a list matches.** A domain matches a list when the list names the domain itself, its `www.` form, or a parent
domain (a listing of `evil.example` covers `app.evil.example`). A match never climbs to shared hosting platforms such as
`vercel.app` or `github.io`, so one bad site there never flags its neighbours.

## What each result means

For every domain, every source gives a verdict, the time it checked (UTC) and an evidence link anyone can open:

- **flagged**: the source lists the domain as unsafe;
- **clean**: the source answered and does not list it;
- **no_data**: the source could not answer (it has no data, or the lookup failed).

The domain's status combines them: **flagged when any single source flags it**, clean when at least one source
answered and none flags it, no_data when no source could answer. If a source fails during a run, its previous answer
for that domain is kept (marked stale), so a network error never hides an earlier flag.

## What we check, and how often

| What | How often | Where the result is |
|---|---|---|
| Every domain linked from the Atlas (official URLs and the sources behind each claim) | daily, 04:17 UTC | [`/atlas/safety.json`](https://commonworld.one/atlas/safety.json), `link_safety` on every entry |
| Our own domains: commonworld.one, www.commonworld.one, staging.commonworld.one | hourly | `GET /v1/trust/status` on the Commonworld app (production at <https://commonworld.one/v1/trust/status> since 2026-10-20, and staging), with the history of every run |
| Links in posts and comments | every time a post or comment is published | live in the Commonworld app (v1): a link to a flagged domain stops the text before it goes public, with a 7-day appeal to a person ([Privacy Policy](https://commonworld.one/privacy/#links-check)) |

The hourly own-domain check has a **heartbeat**: a separate GitHub Action reads the status every hour and fails, which
sends an alert email, when the last run is more than 2 hours old.

## Auto-hide rule

When any one source flags a domain:

1. **It is hidden at once, without waiting for a person.** In the Atlas, every entry that links to the domain is
   removed from every listing, count, search index and data file. Its permanent ID keeps working as a short
   "entry removed" note without the name or any link, marked noindex.
2. **The decision is recorded** with who acted (the agent `hark` for automatic removals), the date, the reason (which
   source said what) and the evidence link.
3. **An issue is opened** in this repository ("Link safety: flagged domains" for the Atlas, "Trust: our domains
   flagged" for our own domains), with the domain, what each source said and the action taken.
4. **A person or agent reviews it** and decides: keep it removed, or return it.
5. **Removed domains are re-checked every day.** When a flag clears and a fresh check comes back clean, the entry can
   return through a restore decision. A return is never automatic.

We would rather hide a safe link for a day than send someone to an unsafe one.

## Who can act

Four trusted actors can hide and return entries, each on their own and at once, with every action recorded: the
maintainer [nerd27dk](https://github.com/nerd27dk) and the agents hark, codex and continuum, who act through his commits
signed with the trailer `Contributed-by: <name>`. The list is [`atlas/data/trust-roles.json`](atlas/data/trust-roles.json).
In the Commonworld app the same powers are the capabilities `safety:hide`, `safety:restore` and `safety:review`, held by
admins and moderators.

## Decision log

Every removal and every return is public, newest first, at [`/atlas/decisions/`](https://commonworld.one/atlas/decisions/)
(also as [Markdown](https://commonworld.one/atlas/decisions/index.md) and [JSON](https://commonworld.one/atlas/decisions.json)),
generated from [`atlas/data/removed.json`](atlas/data/removed.json): date, action, entry ID, domain as plain text, who
acted, why, and the evidence link. The build check refuses a removal without its decision and a return without a clean
re-check.

## Appeals

If you think a domain was flagged or an entry removed by mistake, open an issue titled **"Appeal: your-domain"** in
[this repository](https://github.com/commonworld-one/commonworld/issues), or write to nerd27dk@commonworld.one. Tell us
the domain and why you think the flag is wrong; if a source has already cleared it, say which. **We reply within 7
days.** A return goes through a restore decision with a clean re-check, recorded in the decision log like every other
decision. If the flag comes from a source, the source decides its own list: we point you to its process too.

## If our own domain is flagged

We save the evidence, find and remove the cause (a flagged link, a bad deploy, foreign code), re-check everything across
all sources, and only then ask the flagging source for a review. Every request to an outside party is approved by the
maintainer first. The case and the lesson go into the decision log.

## Run it yourself

```sh
node trust/src/cli.ts example.com other.example          # JSON report: status and every source's answer per domain
node trust/src/cli.ts --domains-file domains.txt --out report.json --fail-on-flag
cd trust && npm test                                     # unit tests with mocked sources
```

Node 22.6 or newer runs the TypeScript directly; there is nothing to install for the CLI.
