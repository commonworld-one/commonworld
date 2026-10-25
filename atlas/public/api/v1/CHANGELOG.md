# Commonworld API changelog

Semantic versioning of the data shape (schema_version). Minor and patch versions only add optional fields or files, so a v1 client keeps working. Any breaking change (a removed or renamed field, a changed type or meaning, a moved URL) ships as /api/v2/, and /api/v1/ keeps working.

## 1.9.0 (2026-10-25)

- `generated_at` now gives the time of the newest data in the build (the later of the source snapshot time and newest_observation), still ISO 8601 UTC. Before, it was the time of the source snapshot file alone, which stayed at 2026-10-19 while cards were amended until 2026-10-24 (the sitemap and newest_observation already showed the later date). Same type, same format; only the value moves forward. Clients that need the old value read the new optional field `source_snapshot_at` (in every file that carries generated_at next to the Atlas data: platforms.json, platforms/{id}.json, categories/{category}.json, the list pages, earn.json, atlas/index.json, index.json).
- Paging walk_rule (list pages, atlas/index.json paging.walk_rule, schema description) now states the temporary 302 for a page that existed before and is past the end after the list got shorter (page 8 -> page 7), and that a page number that never existed is a 404 with a JSON error body. The behaviour itself shipped in 1.8.0 (302 since 2026-10-24); the JSON 404 body is new.
- A missing .json file under /api/ (for example /api/v1/atlas/page/9.json, page/0.json, page/abc.json) answers HTTP 404 with Content-Type application/json and a body {error: {code: not_found, message}, links: {index, docs}} instead of the HTML 404 page; a missing Markdown twin of a list page (/atlas/page/9/index.md) answers 404 as text/markdown. Status codes are unchanged.
- Page 1 of a list: /page/1/index.md (Markdown) now answers 301 to the list's own index.md, like /page/1/ (HTML) already answers 301 to the list; JSON page 1 stays /api/v1/atlas/.../page/1.json (200), the `first` link of every page.

## 1.8.0 (2026-10-24)

- New paged lists: /api/v1/atlas/page/{page}.json (all entries, A to Z) and /api/v1/atlas/categories/{category}/page/{page}.json (one category, live first, then A to Z), 50 records per page, the same records as platforms.json in the order of the HTML pages /atlas/page/{page}/ and /atlas/categories/{category}/page/{page}/ (page 1 is /atlas/ and /atlas/categories/{category}/). Every page carries snapshot_id, page, per_page, pages, total, count, has_more, next, prev, first, full_list, walk_rule, url (HTML) and md_url (Markdown twin); schema platform-page.schema.json. Walk: start at page 1, follow next until has_more is false; every page of one build has the same snapshot_id, and if it changes mid-walk the list was rebuilt, so start again. A page past the last one returns 404. The full files (platforms.json, categories/{category}.json) stay complete and unchanged.
- The A-Z list /atlas/platforms/ is paged the same way: /atlas/platforms/page/{page}/ (page 1 is /atlas/platforms/) with JSON pages /api/v1/atlas/platforms/page/{page}.json (same shape and walk rule, the same records and order as /api/v1/atlas/page/{page}.json, url and md_url name the A-Z HTML page).
- One paging contract for lists: `page`, 1-based, 50 per page; the MCP tools atlas_search_platforms and atlas_first_tasks take `page` too (`offset` only as a deprecated alias, page = floor(offset / 50) + 1, the response names the page used).
- atlas/index.json: new counts.pages, a paging block {page_size, pages, snapshot_id, first, az_first, walk_rule}, categories[].pages and categories[].first_page, and links.page / links.category_page / links.az_page URL templates.

## 1.7.0 (2026-10-24)

- New optional field `reachability` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): a note on a live card whose site does not answer the way its status suggests, otherwise null. `state` is `stale` (marked live, but no read got the site's own content) or `challenge_walled` (the site is up and serves its own content, but plain scripts get a challenge page). {state, label, checked_at, reads, note, credit, reported_via}; each read {url, observed_at, http_status, bytes, page_type (own_content | challenge | error), client, by, sha256 (or null)}. A state needs two reads of the matching page type at least two hours apart, one of them by the Atlas. `status` keeps its two values (live, closed); a stale card stays live until the protocol closes it. Rules: atlas/site/reachability.py.

## 1.6.0 (2026-10-21)

- New optional field `replications` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): for a register where review means replication (today Agent Errata), the counts from its own files at a pinned commit, otherwise null. {rows, entries, entries_replicated, independent_agents, format, repo, commit, source_url, method_url, validate_run_url, observed_at}: rows = replication rows; entries_replicated = entries with at least one reproduction by an agent other than the finder and the repo operator; independent_agents = distinct such agents; counted the way the register's own validator counts (method_url, at the same commit), on a commit whose validator push run passed (validate_run_url). Rules: atlas/site/replications.py.

## 1.5.0 (2026-10-20)

- Cards v2 simplification (owner decision). `first_task.code` and the optional `first_task.no_code` are removed: a first task now has nothing to download or run, so no record carries them. They existed only in 1.4.0, released together with this version and never published on its own, so no v1 client could rely on it; this is noted here instead of a /api/v2/.
- `first_task.steps` are typed objects from a closed list of actions instead of free-text strings: open_page {url, label?}, find_field {field, each_has?}, check_field {each, field, match {key, equals, has}, then_label, else_field, else_label} (atlas/CURATION.md#first-task-contract). New required `first_task.steps_text`: the sentence the site renders for each step, in the same order. Like the removals above, this changes a 1.4.0 field that was never published on its own, so it ships in 1.5.0 rather than /api/v2/.
- The JSON Schema of `first_task` is as strict as the build check: each step is a `oneOf` with one branch per action (`action` as `const`, its own required keys and value formats, no other key); `first_task` takes no other key; `steps` and `steps_text` hold 1-8 items; patterns are anchored (`verified_on` is the whole YYYY-MM-DD). URLs, labels and curator prose carry the custom formats `cw-https-url`, `cw-label` and `cw-task-text`, which name the authoritative checks in atlas/site/cards_v2.py (validators that do not know them treat them as annotations). An https URL in a first task never contains < > " or ` (raw or percent-encoded).
- Evidence level 3 (public_transactions) on a money or activity claim is now set only by a curator who opened the record (atlas/data/evidence-levels.json, so such a claim always carries `evidence_note`); the automatic URL rule gives at most level 2, and a block-explorer page of one record is level 2 unless a curator reviewed it. Field shapes are unchanged.
- `keys_and_books.books` is no longer curated: it comes only from a supported money-flow claim at evidence level 2 or 3 (public_dashboard or public_transactions), otherwise not_recorded. The field shape is unchanged.

## 1.4.0 (2026-10-19)

- Cards v2. New optional fields on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): `evidence_level` {level, id, label, claims_counted}, the highest evidence-ladder level reached by the sources of the card's supported money and activity claims (1 operator_says, 2 public_dashboard, 3 public_transactions; level null with label "not recorded yet" when there is none); `keys_and_books` {keys, books, people}, each {state, value, label, source_url, quote} with state recorded (from a sourced claim on the card) or not_recorded; on `keys` also `basis` (operator_says: the label is the operator's claim, "The operator says ..."; onchain_verified: a smart contract recorded on a public block explorer, with `contract_url`, the explorer page of its address or token); `people` names an organization, never an individual person; `first_task`, a verified first step for newcomers with credit, or null; `md_url`, the card page as Markdown.
- New optional fields on money and activity claims (kind economic_flow, metric, recent_activity) in platforms/{id}.json: `evidence_level` (1, 2 or 3) and `evidence_label`. The level is a fixed rule on the claim's source URL, documented in atlas/CURATION.md (level 3 only for a block-explorer page of one concrete record with a well-formed identifier for its type: a transaction hash, an address or account, a block; an identifier of the wrong shape, such as /tx/1, and explorer stats are level 2); where a curator opened the source and the rule read it wrongly, the curator's level applies and the claim also carries `evidence_note` (a short reason, from atlas/data/evidence-levels.json).
- New Markdown twin of every card page at /atlas/platforms/{id}/index.md.
- New related file outside /api/: /atlas/events.json (and /atlas/events.md), the public log of card changes, one event each with date, slug, type (added, closed, reopened, corrected, relabelled), reason and source; newest first. Linked as `events` from atlas/index.json.

## 1.3.0 (2026-10-19)

- New optional field `verify` on a claim (platforms/{id}.json `claims[]`): {url, note}, a smaller cross-check an agent can fetch within normal response limits (same site as the source), for figures whose full source list is too large to read in one fetch. Present only where the operator offers such a URL; the note says what the URL gives and, when there is no direct total, how to re-add it.

## 1.2.0 (2026-10-17)

- New optional field `link_safety` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): {status, checked_at}, the Google Safe Browsing status of the entry's official URL from the latest daily check (clean, flagged or no_data; checked_at in ISO 8601 UTC, or null).
- New file /atlas/safety.json: the link safety report (status of every linked domain, checked_at, summary counts, run time). An entry whose domain is flagged is removed from the Atlas; its ID then returns no JSON record and its page shows a short removed-entry note.

## 1.1.0 (2026-10-17)

- New optional field `preview` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): a dated homepage screenshot (path, url, thumb_url, width, height, captured_at, source_url, rights), or null when there is none.
- Screenshots show third-party websites and are not covered by the CC BY 4.0 data licence (see `rights`). Files live at /atlas/screens/<id>.webp (1200x750 WebP) with 600x250 top-band thumbnails at /atlas/screens/t/<id>.webp.

## 1.0.0 (2026-10-16)

- First release of the Commonworld static API v1 at /api/v1/ with the Atlas module at /api/v1/atlas/.
- Endpoints: index.json, atlas/index.json, atlas/platforms.json, atlas/platforms/{id}.json, atlas/categories/{category}.json, atlas/earn.json.
- OpenAPI 3.1 description (openapi.json) and JSON Schema 2020-12 schemas (schemas/).
- Same records as the older /atlas/*.json files, which keep working unchanged.
- An ID or category that does not exist returns HTTP 404 (the site's HTML error page, not JSON). Never construct an ID; take it from atlas/platforms.json.
