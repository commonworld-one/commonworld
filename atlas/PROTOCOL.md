# Atlas verification protocol

Version 1, used for the first verified release of the Commonworld Atlas (2026-10-15). Licence: CC BY 4.0. Any agent or person can follow it to re-check a card; corrections are welcome as GitHub issues.

## Brief given to each verifying agent

Goal: for each row in your batch, establish with evidence what is TRUE NOW about the platform, so only verified cards enter the public Atlas catalog. We act like a search-engine crawler with agents: every statement carries a source, a quote/observation and a UTC time.

Input row fields: legacy data from a scout census on 2026-10-15 (NOT evidence — treat as hints), plus `layer1` = an automated HTTP check done 2026-10-15 ~18:06 UTC (ok_content / ok_thin_or_js / network_error / http_404 / http_other / blocked_or_challenge / no_url). Layer-1 failures are NOT proof of death.

## For every row, check these claims (use web_fetch / web_search / curl in shell / GitHub API / public APIs)
1. `canonical_url` — the official URL. If missing (no_url), find it (official site, GitHub org, docs). If you cannot find any official presence after a real search, say so.
2. `site_reachable` — does the official page serve real content now? If layer1 or your first fetch failed, try at least TWO other methods before concluding anything: http vs https / www, alt URLs, an API/docs/status endpoint, GitHub repo, web_search for recent mentions, web.archive.org latest snapshot date. Cloudflare/JS shells = `needs_browser`, never "dead".
3. `description` — one-sentence factual description in YOUR OWN words (English), with the primary source URL and a short quote supporting it.
4. `recent_activity` — newest dated sign of life you can see (post, commit, release, changelog, tweet) with its date and URL.
5. `metric` / `economic_flow` (money: volumes, payouts, orders, transactions) — only if the platform or a credible source publishes it. Record exact value, unit, scope, time window, source URL, observed_at. Do NOT copy legacy numbers; re-observe or mark unverified. Separate operator claims from independent observations.
6. `announced_closed` — if the project appears dead: look for an official shutdown/sunset statement. "Dead" requires either an official statement OR ≥2 independent signals (e.g. domain fails by 2 methods AND no activity anywhere for 90+ days). Otherwise `unresolved`.

## How a card becomes closed (two routes)

A published card is marked closed in one of two ways, and the card says which. A single failed page load is never proof of closure, and a blocked or JavaScript-only page (401/403/429/503, Cloudflare challenge) counts as reachable.

1. **Human review** (this protocol, step 6): an official shutdown/sunset statement, or at least two independent signals (e.g. the domain fails by two methods AND no activity anywhere for 90+ days). Cards closed this way are never reopened automatically: a re-registered or parked domain can answer HTTP 200 too. Reopening needs a new check.
2. **Automated weekly check** (`atlas/refresh.py`): each week the primary URL is fetched with several attempts plus alternate URLs (http/https, www). The first failed week only marks the entry as suspected in `atlas/data/refresh-state.json`; nothing is published. A second consecutive failed week marks the card closed (`include_closed_history`) with a `site_reachable` claim (`direct_observation`, outcome `contradicted`) and a `status_history` record `by: atlas/refresh.py`. The card then shows "Closed by automated check since <date>". If the site answers again in a later weekly check, the card reopens automatically (back to live, with a new claim and history record). The checker validates every redirect and connects to the exact DNS addresses it validated, without using system proxies; private, local, cloud-internal and special platform addresses are refused and count as failed attempts. JSON reads are capped at 1 MB per response and 25 MB per aggregate source read; aggregate processing is capped at 100,000 rows and 50 pages. Pagination offsets must be decimal values of at most 12 digits.

### Between live and closed: reachability notes

A live card can still need a warning before either route closes it. Two notes exist (rules in [`site/reachability.py`](site/reachability.py), data in [`data/reachability.json`](data/reachability.json)):

- **stale**: the card says live, but no read got the site's own content (for example Cloudflare 530 "error code: 1033"). The card stays live with all its claims until the site answers again or one of the two routes above closes it.
- **challenge-walled**: the site is up and serves its own content, but plain scripts get a challenge page (for example 403 "Just a moment..."). This is still reachable under this protocol; the note says that what a client sees depends on the client.

A note needs two reads of the matching page type (`own_content`, `challenge`, `error`) at least two hours apart, one of them by the Atlas itself, so one bad minute or one outside report alone never moves a card. `status` keeps its two values; the note is the separate field `reachability`.

In both cases the page, the URL and the permanent ID are kept.

The same weekly run also re-reads replication counts for registers where review means replication (step 5 of `atlas/refresh.py`; rules in [CURATION.md](CURATION.md#replication-counts)): counted from the register's own files at a commit its validator passed, with that commit pinned.

## Entity type
Mark `entity_type`: `platform` (agents live/work/get paid/are listed there), `tool_catalog` (a registry/directory of tools/servers like MCP registries — one card per catalog), `protocol`, `project` (single tool/agent, not a platform), or `not_relevant`.

## Outcomes per claim
`supported` | `contradicted` | `inaccessible` (tried ≥3 methods, list them) | `needs_browser` | `unchecked`.

## Row verdict
- `include_verified` — canonical_url + site_reachable + description all supported.
  A Verified badge confirms three things, each with a dated source: the platform's official address, that its site is reachable now, and a factual description of what it does; payouts and other money figures are shown as separate claims, each with its own basis label.
- `include_closed_history` — closure supported (human review: official statement or ≥2 signals; or the automated weekly check, see "How a card becomes closed"); card kept as history.
- `needs_browser` — blocked by JS/Cloudflare; needs a real browser pass.
- `unresolved` — conflicting or insufficient evidence (explain).
- `exclude` — not an agent platform / duplicate (explain, name the duplicate id).

## Slug
Propose `slug`: lowercase, hyphenated full name (e.g. the-colony, colony-chat, agent-colony). Never shorten to a generic word.

## Output (mandatory)
Write `results/batch-NN.json` (array, one object per input row, same `id`):
```
{"id":1,"name":"…","slug":"…","entity_type":"platform","verdict":"include_verified",
 "canonical_url":"…","description_en":"…",
 "claims":[{"kind":"site_reachable","statement":"…","value":null,"unit":null,"window":null,
   "basis":"direct_observation|operator_claim|independent_source|inference",
   "source_url":"…","quote":"≤200 chars","observed_at":"2026-10-15T18:40:00Z",
   "methods":["web_fetch https://…","curl -I …"],"outcome":"supported"}],
 "legacy_diffs":["legacy said X, now Y"],"notes":"…"}
```
Also write `results/batch-NN.md`: counts by verdict, rows needing a browser, notable corrections vs legacy (esp. money and closures), and any NEW platforms you stumbled upon (name + URL, do not research them).

Times: UTC ISO. Unknown = null, never 0. Never invent a URL or number. Work efficiently: aim ~3–5 tool calls per healthy row, more only for failing/money rows. Save the JSON incrementally (rewrite the file every ~8 rows) so partial work survives. If something loops more than twice, record it as unresolved and move on.
