"""Commonworld static API v1 (/api/v1/): JSON Schemas, OpenAPI 3.1 description, changelog and a tiny JSON Schema validator.

Stdlib only. build.py writes the files; check.py validates every generated document against the schemas here.
Stability rule: within v1 only backwards-compatible changes (new optional fields, new files) bump the minor
schema_version; removing or renaming a field, changing its type or meaning, or moving a URL is a breaking change
and ships as /api/v2/ while /api/v1/ keeps working.
"""
import json
import re

from cards_v2 import (BOOKS_VALUES, EACH_HAS_MAX, KEYS_BASES, KEYS_VALUES, LEVELS, NOT_RECORDED, PEOPLE_VALUES,  # cards v2 vocabulary (one source)
                      SCHEMA_FORMATS, STEP_ACTIONS, STEP_OPTIONAL, STEPS_MAX, TEXT_MAX, URL_MAX, URL_PATTERN)

API_VERSION = 'v1'
SCHEMA_VERSION = '1.9.0'
API_BASE = '/api/v1'
STATUSES = ['live', 'closed']
ENTITY_TYPES = ['platform', 'tool_catalog', 'protocol', 'project']
BASES = ['direct_observation', 'operator_claim', 'independent_source', 'inference']
OUTCOMES = ['supported', 'contradicted', 'unchecked', 'inaccessible', 'needs_browser']
ID_PATTERN = r'^[a-z0-9][a-z0-9-]*$'
UTC_PATTERN = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$'  # ISO 8601 UTC (seconds optional, as in the source claims)

# newest first; build.py writes changelog.json and CHANGELOG.md from this list
CHANGELOG = [
    {'schema_version': '1.9.0', 'date': '2026-10-25', 'changes': [
        '`generated_at` now gives the time of the newest data in the build (the later of the source snapshot time and newest_observation), '
        'still ISO 8601 UTC. Before, it was the time of the source snapshot file alone, which stayed at 2026-10-19 while cards were amended '
        'until 2026-10-24 (the sitemap and newest_observation already showed the later date). Same type, same format; only the value moves '
        'forward. Clients that need the old value read the new optional field `source_snapshot_at` (in every file that carries generated_at '
        'next to the Atlas data: platforms.json, platforms/{id}.json, categories/{category}.json, the list pages, earn.json, atlas/index.json, index.json).',
        'Paging walk_rule (list pages, atlas/index.json paging.walk_rule, schema description) now states the temporary 302 for a page that '
        'existed before and is past the end after the list got shorter (page 8 -> page 7), and that a page number that never existed is a 404 '
        'with a JSON error body. The behaviour itself shipped in 1.8.0 (302 since 2026-10-24); the JSON 404 body is new.',
        'A missing .json file under /api/ (for example /api/v1/atlas/page/9.json, page/0.json, page/abc.json) answers HTTP 404 with '
        'Content-Type application/json and a body {error: {code: not_found, message}, links: {index, docs}} instead of the HTML 404 page; '
        'a missing Markdown twin of a list page (/atlas/page/9/index.md) answers 404 as text/markdown. Status codes are unchanged.',
        'Page 1 of a list: /page/1/index.md (Markdown) now answers 301 to the list\'s own index.md, like /page/1/ (HTML) already '
        'answers 301 to the list; JSON page 1 stays /api/v1/atlas/.../page/1.json (200), the `first` link of every page.']},
    {'schema_version': '1.8.0', 'date': '2026-10-24', 'changes': [
        'New paged lists: /api/v1/atlas/page/{page}.json (all entries, A to Z) and /api/v1/atlas/categories/{category}/page/{page}.json '
        '(one category, live first, then A to Z), 50 records per page, the same records as platforms.json in the order of the HTML pages '
        '/atlas/page/{page}/ and /atlas/categories/{category}/page/{page}/ (page 1 is /atlas/ and /atlas/categories/{category}/). '
        'Every page carries snapshot_id, page, per_page, pages, total, count, has_more, next, prev, first, full_list, walk_rule, url (HTML) and md_url '
        '(Markdown twin); schema platform-page.schema.json. Walk: start at page 1, follow next until has_more is false; every page of one build '
        'has the same snapshot_id, and if it changes mid-walk the list was rebuilt, so start again. A page past the last one returns 404. '
        'The full files (platforms.json, categories/{category}.json) stay complete and unchanged.',
        'The A-Z list /atlas/platforms/ is paged the same way: /atlas/platforms/page/{page}/ (page 1 is /atlas/platforms/) with JSON pages '
        '/api/v1/atlas/platforms/page/{page}.json (same shape and walk rule, the same records and order as /api/v1/atlas/page/{page}.json, '
        'url and md_url name the A-Z HTML page).',
        'One paging contract for lists: `page`, 1-based, 50 per page; the MCP tools atlas_search_platforms and atlas_first_tasks take `page` too '
        '(`offset` only as a deprecated alias, page = floor(offset / 50) + 1, the response names the page used).',
        'atlas/index.json: new counts.pages, a paging block {page_size, pages, snapshot_id, first, az_first, walk_rule}, categories[].pages and '
        'categories[].first_page, and links.page / links.category_page / links.az_page URL templates.']},
    {'schema_version': '1.7.0', 'date': '2026-10-24', 'changes': [
        'New optional field `reachability` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): a note on a live '
        'card whose site does not answer the way its status suggests, otherwise null. `state` is `stale` (marked live, but no read got the site\'s own '
        'content) or `challenge_walled` (the site is up and serves its own content, but plain scripts get a challenge page). '
        '{state, label, checked_at, reads, note, credit, reported_via}; each read {url, observed_at, http_status, bytes, page_type (own_content | challenge | error), '
        'client, by, sha256 (or null)}. A state needs two reads of the matching page type at least two hours apart, one of them by the Atlas. '
        '`status` keeps its two values (live, closed); a stale card stays live until the protocol closes it. Rules: atlas/site/reachability.py.']},
    {'schema_version': '1.6.0', 'date': '2026-10-21', 'changes': [
        'New optional field `replications` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): for a register '
        'where review means replication (today Agent Errata), the counts from its own files at a pinned commit, otherwise null. '
        '{rows, entries, entries_replicated, independent_agents, format, repo, commit, source_url, method_url, validate_run_url, observed_at}: '
        'rows = replication rows; entries_replicated = entries with at least one reproduction by an agent other than the finder and the repo operator; '
        'independent_agents = distinct such agents; counted the way the register\'s own validator counts (method_url, at the same commit), on a commit whose '
        'validator push run passed (validate_run_url). Rules: atlas/site/replications.py.']},
    {'schema_version': '1.5.0', 'date': '2026-10-20', 'changes': [
        'Cards v2 simplification (owner decision). `first_task.code` and the optional `first_task.no_code` are removed: a first task now '
        'has nothing to download or run, so no record carries them. They existed only in 1.4.0, released together with this version and never published on its own, so no v1 '
        'client could rely on it; this is noted here instead of a /api/v2/.',
        '`first_task.steps` are typed objects from a closed list of actions instead of free-text strings: open_page {url, label?}, '
        'find_field {field, each_has?}, check_field {each, field, match {key, equals, has}, then_label, else_field, else_label} '
        '(atlas/CURATION.md#first-task-contract). New required `first_task.steps_text`: the sentence the site renders for each step, in the same order. '
        'Like the removals above, this changes a 1.4.0 field that was never published on its own, so it ships in 1.5.0 rather than /api/v2/.',
        'The JSON Schema of `first_task` is as strict as the build check: each step is a `oneOf` with one branch per action (`action` as `const`, its own '
        'required keys and value formats, no other key); `first_task` takes no other key; `steps` and `steps_text` hold 1-8 items; patterns are anchored '
        '(`verified_on` is the whole YYYY-MM-DD). URLs, labels and curator prose carry the custom formats `cw-https-url`, `cw-label` and `cw-task-text`, '
        'which name the authoritative checks in atlas/site/cards_v2.py (validators that do not know them treat them as annotations). An https URL in a '
        'first task never contains < > " or ` (raw or percent-encoded).',
        'Evidence level 3 (public_transactions) on a money or activity claim is now set only by a curator who opened the record '
        '(atlas/data/evidence-levels.json, so such a claim always carries `evidence_note`); the automatic URL rule gives at most level 2, '
        'and a block-explorer page of one record is level 2 unless a curator reviewed it. Field shapes are unchanged.',
        '`keys_and_books.books` is no longer curated: it comes only from a supported money-flow claim at evidence level 2 or 3 '
        '(public_dashboard or public_transactions), otherwise not_recorded. The field shape is unchanged.']},
    {'schema_version': '1.4.0', 'date': '2026-10-19', 'changes': [
        'Cards v2. New optional fields on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): '
        '`evidence_level` {level, id, label, claims_counted}, the highest evidence-ladder level reached by the sources of the card\'s supported '
        'money and activity claims (1 operator_says, 2 public_dashboard, 3 public_transactions; level null with label "not recorded yet" when there is none); '
        '`keys_and_books` {keys, books, people}, each {state, value, label, source_url, quote} with state recorded (from a sourced claim on the card) '
        'or not_recorded; on `keys` also `basis` (operator_says: the label is the operator\'s claim, "The operator says ..."; onchain_verified: '
        'a smart contract recorded on a public block explorer, with `contract_url`, the explorer page of its address or token); `people` names an organization, never an individual person; '
        '`first_task`, a verified first step for newcomers with credit, or null; `md_url`, the card page as Markdown.',
        'New optional fields on money and activity claims (kind economic_flow, metric, recent_activity) in platforms/{id}.json: '
        '`evidence_level` (1, 2 or 3) and `evidence_label`. The level is a fixed rule on the claim\'s source URL, documented in atlas/CURATION.md '
        '(level 3 only for a block-explorer page of one concrete record with a well-formed identifier for its type: a transaction hash, an address or account, a block; '
        'an identifier of the wrong shape, such as /tx/1, and explorer stats are level 2); '
        'where a curator opened the source and the rule read it wrongly, the curator\'s level applies and the claim also carries `evidence_note` '
        '(a short reason, from atlas/data/evidence-levels.json).',
        'New Markdown twin of every card page at /atlas/platforms/{id}/index.md.',
        'New related file outside /api/: /atlas/events.json (and /atlas/events.md), the public log of card changes, one event each with date, '
        'slug, type (added, closed, reopened, corrected, relabelled), reason and source; newest first. Linked as `events` from atlas/index.json.']},
    {'schema_version': '1.3.0', 'date': '2026-10-19', 'changes': [
        'New optional field `verify` on a claim (platforms/{id}.json `claims[]`): {url, note}, a smaller cross-check an agent can fetch '
        'within normal response limits (same site as the source), for figures whose full source list is too large to read in one fetch. '
        'Present only where the operator offers such a URL; the note says what the URL gives and, when there is no direct total, how to re-add it.']},
    {'schema_version': '1.2.0', 'date': '2026-10-17', 'changes': [
        'New optional field `link_safety` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): '
        '{status, checked_at}, the Google Safe Browsing status of the entry\'s official URL from the latest daily check '
        '(clean, flagged or no_data; checked_at in ISO 8601 UTC, or null).',
        'New file /atlas/safety.json: the link safety report (status of every linked domain, checked_at, summary counts, run time). '
        'An entry whose domain is flagged is removed from the Atlas; its ID then returns no JSON record and its page shows a short removed-entry note.']},
    {'schema_version': '1.1.0', 'date': '2026-10-17', 'changes': [
        'New optional field `preview` on every platform record (platforms.json, platforms/{id}.json, categories/{category}.json): '
        'a dated homepage screenshot (path, url, thumb_url, width, height, captured_at, source_url, rights), or null when there is none.',
        'Screenshots show third-party websites and are not covered by the CC BY 4.0 data licence (see `rights`). Files live at /atlas/screens/<id>.webp '
        '(1200x750 WebP) with 600x250 top-band thumbnails at /atlas/screens/t/<id>.webp.']},
    {'schema_version': '1.0.0', 'date': '2026-10-16', 'changes': [
        'First release of the Commonworld static API v1 at /api/v1/ with the Atlas module at /api/v1/atlas/.',
        'Endpoints: index.json, atlas/index.json, atlas/platforms.json, atlas/platforms/{id}.json, atlas/categories/{category}.json, atlas/earn.json.',
        'OpenAPI 3.1 description (openapi.json) and JSON Schema 2020-12 schemas (schemas/).',
        'Same records as the older /atlas/*.json files, which keep working unchanged.',
        'An ID or category that does not exist returns HTTP 404 (the site\'s HTML error page, not JSON). Never construct an ID; take it from atlas/platforms.json.']},
]
# Paged lists (ADR-0001, decisions D2-D4): static JSON pages of PAGE_SIZE records each, built with the site.
# The location is still an open question (Q6): every page URL is made by page_json() below, so moving them is one edit here.
PAGE_SIZE = 50
PAGING_CONTRACT = ('One paging contract everywhere: `page`, 1-based, 50 per page, as in /api/v1/atlas/page/{page}.json. The MCP tools '
                   'atlas_list_page, atlas_search_platforms and atlas_first_tasks take `page`; `offset` is only a deprecated alias '
                   '(page = floor(offset / 50) + 1) and the response names the page used.')
PAGE_WALK_RULE = ('Start at page 1 and follow `next` until `has_more` is false. Every page of one build carries the same `snapshot_id`; '
                  'if it changes between two pages, the list was rebuilt in between: start again from page 1. '
                  'When a list gets shorter, a page number that existed before and is now past the last page answers HTTP 302 '
                  '(temporary, never cached) to that list\'s last page, for example page 8 -> page 7 after the list shrank from 8 pages to 7; '
                  'the page you land on has a different `page` than you asked for and a new `snapshot_id`, so start again from page 1. '
                  'The redirect goes away when the list grows back and the page exists again (plain HTTP 200). '
                  'A page number that never existed (0, not a number, or above the highest page ever built) returns HTTP 404 '
                  'with a JSON error body (application/json).')

PAGE_ONE_RULE = ('Page 1 of a list is the list itself: /page/1/ and /page/1/index.md answer 301 to the list URL and its index.md; '
                 'JSON page 1 is the file page/1.json (the `first` link of every page).')
# Typed 404s (Atlas paging findings, 2026-10-25): a missing JSON page answers a JSON error body, a missing Markdown twin of a
# list page answers Markdown, never the HTML 404 page. The API and the Markdown twins are static files served without the
# Worker, so the bodies are static files too: Cloudflare Static Assets (not_found_handling "404-page") serves the NEAREST
# 404.html, and build.py writes /api/404.html (this JSON) and <list>/page/404.html (NOT_FOUND_MD); _headers gives them their
# content type. platform/src/atlas-assets.ts and serve.py use the same texts (tests/test_atlas_paging.py compares them).
NOT_FOUND_MESSAGE = ('No such file in the Atlas API. List pages are numbered from 1; the number of pages is `pages` on every page '
                     'and counts.pages in /api/v1/atlas/index.json.')
NOT_FOUND_MD = ('# Not found\n\nThere is no Markdown page at this address. The Atlas starts at /atlas/index.md; '
                'list pages are numbered from 1 (page 1 is the list itself).\n')
NOT_FOUND_SHAPE = '{"error": {"code": "not_found", "message": "..."}, "links": {"index": ".../api/v1/atlas/index.json", "docs": ".../atlas/api/"}}'


def not_found_doc(origin):
    """Body of the JSON 404 (static /api/404.html, and the Worker's own JSON 404)."""
    return {'error': {'code': 'not_found', 'message': NOT_FOUND_MESSAGE},
            'links': {'index': f'{origin}{API_BASE}/atlas/index.json', 'docs': f'{origin}/atlas/api/'}}


PAGE_MISSING = {
    '302': {'description': 'This page number existed before and is past the last page now (the list got shorter): temporary redirect '
                           '(Cache-Control: no-store) to the last page of the list. Start the walk again from page 1.'},
    '404': {'description': 'This page number never existed (or the category does not exist). JSON error body.',
            'content': {'application/json': {'schema': {'type': 'object', 'required': ['error'], 'properties': {
                'error': {'type': 'object', 'required': ['code'], 'properties': {'code': {'const': 'not_found'}, 'message': {'type': 'string'}}},
                'links': {'type': 'object'}}}}}},
}


AZ_LIST = '@az'  # list key of the A-Z list /atlas/platforms/ (never a category id: those match ID_PATTERN)


def page_json(n, category=None):
    """Path (under API_BASE) of JSON list page n (1-based): the whole Atlas, one category, or the A-Z list (AZ_LIST)."""
    if category == AZ_LIST:
        return f'/atlas/platforms/page/{n}.json'
    return f'/atlas/page/{n}.json' if category is None else f'/atlas/categories/{category}/page/{n}.json'


GENERATED_AT_DESC = ('Time of the newest data in this build, ISO 8601 UTC: the later of source_snapshot_at and newest_observation, '
                     'so it moves when a card is amended (since schema_version 1.9.0; before, it was the source snapshot time alone).')
SOURCE_SNAPSHOT_AT_DESC = 'Time the source data snapshot file was produced, ISO 8601 UTC (what generated_at held before schema_version 1.9.0).'
NEWEST_OBSERVATION_DESC = 'Newest observed_at of any published claim, ISO 8601 UTC; never later than generated_at.'
VERSIONING = ('Semantic versioning of the data shape (schema_version). Minor and patch versions only add optional fields or files, '
              'so a v1 client keeps working. Any breaking change (a removed or renamed field, a changed type or meaning, a moved URL) '
              'ships as /api/v2/, and /api/v1/ keeps working.')


def schema_url(origin, name):
    return f'{origin}{API_BASE}/schemas/{name}'


# ---------------------------------------------------------------- schemas
def _nullable(t):
    return {'type': [t, 'null']} if isinstance(t, str) else t


def schemas(origin, categories):
    """{file name: JSON Schema 2020-12}. categories: list of category keys (enum)."""
    S = lambda n: schema_url(origin, n)
    utc = {'type': 'string', 'pattern': UTC_PATTERN, 'format': 'date-time'}
    utc_n = {'type': ['string', 'null'], 'pattern': UTC_PATTERN, 'format': 'date-time'}
    gen_at = utc_n | {'description': GENERATED_AT_DESC}
    src_at = utc_n | {'description': SOURCE_SNAPSHOT_AT_DESC}
    newest_obs = utc_n | {'description': NEWEST_OBSERVATION_DESC}
    uri = {'type': 'string', 'format': 'uri', 'pattern': '^https?://'}
    # First-task step values. Patterns are anchored ^...$ (ECMA-262: $ is the end of the string, no trailing-newline allowance) and
    # equal to the runtime regexes in cards_v2.py; the repo's validators apply them with that meaning (see validate()).
    ident = {'type': 'string', 'pattern': r'^[A-Za-z_][A-Za-z0-9_.]{0,63}$', 'description': 'A JSON field name.'}
    token = {'type': 'string', 'pattern': r'^[A-Za-z0-9_.-]{1,64}$'}
    label = {'type': 'string', 'pattern': r'^[A-Za-z0-9](?:[A-Za-z0-9 -]{0,38}[A-Za-z0-9])?$', 'format': 'cw-label',
             'description': 'A short label (letters, digits, spaces, hyphens; at most 40). format cw-label: also no download, install or run '
                            'wording (cards_v2.label_ok, atlas/CURATION.md#first-task-contract).'}
    cw_url = {'type': 'string', 'minLength': 9, 'maxLength': URL_MAX, 'pattern': URL_PATTERN, 'format': 'cw-https-url',
              'description': 'A plain https URL. The pattern is the strictest form JSON Schema can express; the authoritative check is '
                             'https_url_ok in atlas/site/cards_v2.py (format cw-https-url: one decode, no remaining %, no raw GitHub or gist host, '
                             'no script or binary file; atlas/CURATION.md#first-task-contract), which the Commonworld build and CI apply for this format.'}
    text = {'type': 'string', 'minLength': 1, 'maxLength': TEXT_MAX, 'format': 'cw-task-text',
            'description': f'Curator prose, at most {TEXT_MAX} characters. format cw-task-text: no control, format or separator character, '
                           'no download, install or run wording, every link a plain https URL (cards_v2.task_text_ok).'}
    step_keys = {'url': cw_url, 'label': label, 'field': ident, 'each': ident, 'then_label': label, 'else_field': ident, 'else_label': label,
                 'each_has': {'type': 'array', 'minItems': 1, 'maxItems': EACH_HAS_MAX, 'uniqueItems': True, 'items': ident},
                 'match': {'type': 'object', 'additionalProperties': False, 'required': ['key', 'equals', 'has'],
                           'properties': {'key': ident, 'equals': token, 'has': ident}}}

    def step_branch(a):
        keys = STEP_ACTIONS[a]
        return {'type': 'object', 'additionalProperties': False,
                'required': ['action'] + [k for k in keys if k not in STEP_OPTIONAL[a]],
                'properties': {'action': {'const': a}} | {k: step_keys[k] for k in keys}}
    step = {'description': 'One typed first-task step: exactly one of the closed list of actions, each with its own keys (no other key). '
                           'open_page: url (a plain https page), optional label. find_field: field, optional each_has (1-8 distinct field names each item has). '
                           'check_field: each (the list), field (the list inside each item), match {key, equals, has} (an entry whose `key` equals `equals` '
                           'and that has `has`), then_label, else_field, else_label.',
            'oneOf': [step_branch(a) for a in STEP_ACTIONS]}
    uri_n = {'type': ['string', 'null'], 'format': 'uri'}
    scalar = {'type': ['number', 'string', 'null']}

    def kb_item(vals, keys=False):
        it = {'type': 'object', 'required': ['state', 'value', 'label', 'source_url', 'quote'],
              'properties': {'state': {'enum': ['recorded', 'not_recorded']}, 'value': {'enum': sorted(vals) + [None]},
                             'label': {'type': 'string', 'minLength': 1}, 'source_url': uri_n, 'quote': {'type': ['string', 'null']}}}
        if keys:
            it['properties'] |= {
                'basis': {'enum': list(KEYS_BASES), 'description': 'On a recorded value: operator_says = custody rests on the operator\'s own '
                          'words and the label is an attributed claim ("The operator says ..."); onchain_verified = a smart contract recorded '
                          'on a public block explorer (contract_url).'},
                'contract_url': uri | {'description': 'The explorer page of the contract\'s address or token on a public block explorer, not a transaction '
                                 'or block page (basis onchain_verified only).'}}
        return it
    money_flow = {'type': 'object', 'description': 'A supported money-flow claim as shown on the card.',
                  'required': ['statement', 'value', 'unit', 'window', 'basis', 'observed_at', 'source_url'],
                  'properties': {'statement': {'type': 'string'}, 'value': scalar, 'unit': {'type': ['string', 'null']},
                                 'window': {'type': ['string', 'null']}, 'basis': {'enum': BASES}, 'observed_at': utc_n, 'source_url': uri_n}}
    key_number = {'type': ['object', 'null'], 'description': 'The headline figure shown on the card, or null.',
                  'required': ['kind', 'value', 'unit', 'window', 'basis', 'observed_at', 'source_url'],
                  'properties': {'kind': {'type': 'string'}, 'value': scalar, 'unit': {'type': ['string', 'null']}, 'window': {'type': ['string', 'null']},
                                 'basis': {'enum': BASES}, 'observed_at': utc_n, 'source_url': uri_n}}
    claim = {'type': 'object', 'description': 'One checked statement with its source, basis, outcome and observation time. Extra keys (history, recheck, methods, verify) may appear.',
             'required': ['kind', 'statement', 'basis', 'outcome'],
             'properties': {'kind': {'type': 'string'}, 'statement': {'type': 'string'}, 'value': scalar, 'unit': {'type': ['string', 'null']},
                            'window': {'type': ['string', 'null']}, 'basis': {'enum': BASES}, 'outcome': {'enum': OUTCOMES},
                            'source_url': uri_n, 'quote': {'type': ['string', 'null']}, 'observed_at': utc_n,
                            'methods': {'type': 'array', 'items': {'type': 'string'}}, 'history': {'type': 'array', 'items': {'type': 'object'}},
                            'recheck': {'type': 'object'},
                            'verify': {'type': 'object', 'description': 'Smaller cross-check for this figure: a URL an agent can fetch within '
                                       'normal limits and a note on what it gives. Added in schema_version 1.3.0.',
                                       'required': ['url', 'note'], 'properties': {'url': uri, 'note': {'type': 'string', 'minLength': 1}}},
                            'evidence_level': {'enum': [1, 2, 3], 'description': 'Evidence-ladder level of this money or activity claim, from its source URL (or a curator review, see evidence_note): '
                                               '1 operator says, 2 public dashboard, 3 public transactions (only by a curator who opened the record, since 1.5.0). Added in schema_version 1.4.0.'},
                            'evidence_label': {'enum': [LEVELS[k][1] for k in (1, 2, 3)]},
                            'evidence_note': {'type': 'string', 'minLength': 1, 'description': 'Present when a curator opened the source and set the '
                                              'level by hand (atlas/data/evidence-levels.json): the short reason. Added in schema_version 1.4.0.'}}}
    summary_props = {
        'id': {'type': 'string', 'pattern': ID_PATTERN, 'description': 'Permanent ID (URL slug). Never construct one: take it from platforms.json.'},
        'name': {'type': 'string'}, 'url': uri, 'json_url': uri, 'website': uri_n,
        'category': {'enum': categories}, 'category_label': {'type': 'string'}, 'type': {'enum': ENTITY_TYPES + [None]},
        'status': {'enum': STATUSES}, 'summary': {'type': 'string'}, 'tags': {'type': 'array', 'items': {'type': 'string'}},
        'has_money_flow': {'type': 'boolean'}, 'money_flow': {'type': 'array', 'items': {'$ref': '#/$defs/moneyFlow'}},
        'key_number': {'$ref': '#/$defs/keyNumber'}, 'verified_at': utc_n, 'last_checked': utc_n,
        'claims_count': {'type': 'integer', 'minimum': 0}, 'disclosure': {'type': ['string', 'null']},
        'preview': {'$ref': '#/$defs/preview'},
        'link_safety': {'type': 'object', 'description': 'Google Safe Browsing status of the official URL from the latest daily check '
                        '(report: /atlas/safety.json). Added in schema_version 1.2.0.', 'required': ['status', 'checked_at'],
                        'properties': {'status': {'enum': ['clean', 'flagged', 'no_data']}, 'checked_at': utc_n}},
        'md_url': uri | {'description': 'The card page as Markdown. Added in schema_version 1.4.0.'},
        'evidence_level': {'type': 'object', 'description': 'Highest evidence-ladder level reached by the sources of the card\'s supported money and '
                           'activity claims (1 operator_says, 2 public_dashboard, 3 public_transactions); level null = not recorded yet. Added in schema_version 1.4.0.',
                           'required': ['level', 'id', 'label', 'claims_counted'],
                           'properties': {'level': {'enum': [1, 2, 3, None]}, 'id': {'enum': [LEVELS[k][0] for k in (1, 2, 3)] + [None]},
                                          'label': {'enum': [LEVELS[k][1] for k in (1, 2, 3)] + [NOT_RECORDED]}, 'claims_counted': {'type': 'integer', 'minimum': 0}}},
        'keys_and_books': {'type': 'object', 'description': 'Who holds the keys, whether the books are open, who is behind it: each filled only from a '
                           'sourced claim on the card, otherwise state not_recorded. Added in schema_version 1.4.0.',
                           'required': ['keys', 'books', 'people'],
                           'properties': {f: kb_item(vals) for f, vals in (('keys', KEYS_VALUES), ('books', BOOKS_VALUES), ('people', PEOPLE_VALUES))}
                           | {'keys': kb_item(KEYS_VALUES, keys=True)}},
        'first_task': {'type': ['object', 'null'], 'description': 'A verified, read-only first step for newcomers, with credit to its contributor, or null. '
                       '`steps` are typed objects from a closed list of actions (open_page, find_field, check_field; atlas/CURATION.md#first-task-contract), '
                       'never free text; `steps_text` holds the sentence the site renders for each step, in the same order. It has nothing to download or run '
                       '(first_task.code and first_task.no_code were removed in schema_version 1.5.0, when steps became typed objects). Added in schema_version 1.4.0.',
                       'additionalProperties': False,
                       'required': ['title', 'steps', 'steps_text', 'done_when', 'contributed_by', 'contributed_via', 'source_url', 'verified_by', 'verified_on', 'verification', 'credit'],
                       'properties': {'title': text, 'steps': {'type': 'array', 'minItems': 1, 'maxItems': STEPS_MAX, 'items': step},
                                      'steps_text': {'type': 'array', 'minItems': 1, 'maxItems': STEPS_MAX, 'items': {'type': 'string', 'minLength': 1}},
                                      'done_when': text, 'contributed_by': text, 'contributed_via': text,
                                      'source_url': cw_url, 'verified_by': text,
                                      'verified_on': {'type': 'string', 'pattern': r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$', 'description': 'YYYY-MM-DD (the whole string).'},
                                      'verification': text, 'credit': {'type': 'string', 'pattern': '^Contributed by '}}}}
    summary_props['replications'] = {
        'type': ['object', 'null'], 'additionalProperties': False,
        'description': 'Replication counts for a register where review means replication, read at a pinned commit and counted the way the register\'s own '
                       'validator counts (atlas/site/replications.py), or null. rows = replication rows; entries_replicated = entries with at least one reproduction '
                       'by an agent other than the finder and the repo operator; independent_agents = distinct such agents. Added in schema_version 1.6.0.',
        'required': ['rows', 'entries', 'entries_replicated', 'independent_agents', 'format', 'repo', 'commit', 'source_url', 'method_url', 'validate_run_url', 'observed_at'],
        'properties': {'rows': {'type': 'integer', 'minimum': 0}, 'entries': {'type': 'integer', 'minimum': 0},
                       'entries_replicated': {'type': 'integer', 'minimum': 0}, 'independent_agents': {'type': 'integer', 'minimum': 0},
                       'format': {'enum': ['agent-errata']}, 'repo': {'type': 'string', 'pattern': r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'},
                       'commit': {'type': 'string', 'pattern': '^[0-9a-f]{40}$'},
                       'source_url': {'type': 'string', 'format': 'uri', 'pattern': '^https://github\\.com/'},
                       'method_url': {'type': 'string', 'format': 'uri', 'pattern': '^https://github\\.com/'},
                       'validate_run_url': {'type': 'string', 'format': 'uri', 'pattern': '^https://github\\.com/[^/]+/[^/]+/actions/runs/[0-9]+$'},
                       'observed_at': {'type': 'string', 'pattern': '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'}}}
    summary_props['reachability'] = {
        'type': ['object', 'null'], 'additionalProperties': False,
        'description': 'A note on a live card whose site does not answer the way its status suggests, or null. stale = marked live, but no read got the '
                       'site\'s own content; challenge_walled = the site is up and serves its own content, but plain scripts get a challenge page. '
                       'Two reads of the matching page type at least two hours apart, one by the Atlas (atlas/site/reachability.py). '
                       '`status` is unchanged by it. Added in schema_version 1.7.0.',
        'required': ['state', 'label', 'checked_at', 'reads', 'note', 'credit', 'reported_via'],
        'properties': {'state': {'enum': ['stale', 'challenge_walled']}, 'label': {'enum': ['stale', 'challenge-walled']}, 'checked_at': utc,
                       'note': {'type': 'string', 'minLength': 1}, 'credit': {'type': 'string', 'minLength': 1},
                       'reported_via': {'type': 'string', 'format': 'uri', 'pattern': '^https://'},
                       'reads': {'type': 'array', 'minItems': 1, 'items': {
                           'type': 'object', 'additionalProperties': False,
                           'required': ['url', 'observed_at', 'http_status', 'bytes', 'page_type', 'client', 'by', 'sha256'],
                           'properties': {'url': {'type': 'string', 'format': 'uri', 'pattern': '^https://'}, 'observed_at': utc,
                                          'http_status': {'type': 'integer', 'minimum': 100, 'maximum': 599}, 'bytes': {'type': 'integer', 'minimum': 0},
                                          'page_type': {'enum': ['own_content', 'challenge', 'error']}, 'client': {'type': 'string', 'minLength': 1},
                                          'by': {'type': 'string', 'minLength': 1}, 'sha256': {'type': ['string', 'null'], 'pattern': '^[0-9a-f]{64}$'}}}}}}
    optional = {'preview', 'link_safety', 'md_url', 'evidence_level', 'keys_and_books', 'first_task', 'replications', 'reachability'}  # added in 1.1.0 / 1.2.0 / 1.4.0 / 1.6.0: optional, so older records stay valid
    summary = {'type': 'object', 'description': 'Stable public fields of one published Atlas entry (as in platforms.json).',
               'required': [k for k in summary_props if k not in optional], 'properties': summary_props}
    preview = {'type': ['object', 'null'], 'description': 'Dated homepage screenshot of the entry, or null. Third-party website content: '
               'not covered by the Atlas CC BY 4.0 data licence (see rights). Added in schema_version 1.1.0.',
               'required': ['path', 'url', 'width', 'height', 'captured_at', 'source_url'],
               'properties': {'path': {'type': 'string', 'pattern': '^/atlas/screens/[a-z0-9-]+\\.webp$'}, 'url': uri, 'thumb_url': uri,
                              'width': {'type': 'integer', 'minimum': 1}, 'height': {'type': 'integer', 'minimum': 1},
                              'captured_at': utc, 'source_url': {'type': 'string', 'format': 'uri', 'pattern': '^https://'},
                              'rights': {'type': 'string'}}}
    defs = {'platformSummary': summary, 'moneyFlow': money_flow, 'keyNumber': key_number, 'claim': claim, 'preview': preview}
    platform = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': S('platform.schema.json'),
                'title': 'Commonworld Atlas entry', 'description': 'One published Atlas entry with all its claims and sources (/api/v1/atlas/platforms/{id}.json).',
                'type': 'object', 'allOf': [{'$ref': '#/$defs/platformSummary'}],
                'required': ['schema_version', 'licence', 'source', 'generated_at', 'badge_status', 'badge_svg', 'badge_svg_dark', 'badge_page', 'claims'],
                'properties': {'schema_version': {'type': 'string'}, 'licence': {'type': 'string'}, 'source': uri, 'generated_at': gen_at,
                               'source_snapshot_at': src_at, 'badge_status': {'type': 'string'}, 'badge_svg': uri, 'badge_svg_dark': uri, 'badge_page': uri,
                               'claims': {'type': 'array', 'items': {'$ref': '#/$defs/claim'}}, 'qa_status': {'type': ['string', 'null']}},
                '$defs': defs}
    list_meta = {'schema_version': {'type': 'string'}, 'name': {'type': 'string'}, 'description': {'type': 'string'}, 'url': uri,
                 'generated_at': gen_at, 'source_snapshot_at': src_at, 'newest_observation': newest_obs, 'licence': {'type': 'string'}, 'licence_url': uri, 'source': uri,
                 'corrections': uri, 'protocol': uri, 'full_data': uri, 'count': {'type': 'integer', 'minimum': 0}, 'fields_note': {'type': 'string'},
                 'platforms': {'type': 'array', 'items': {'$ref': 'platform.schema.json#/$defs/platformSummary'}}}
    plist = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': S('platform-list.schema.json'),
             'title': 'Commonworld Atlas entry list', 'description': 'All published entries (/api/v1/atlas/platforms.json).',
             'type': 'object', 'required': ['schema_version', 'name', 'url', 'generated_at', 'licence', 'count', 'platforms'], 'properties': list_meta}
    category = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': S('category.schema.json'),
                'title': 'Commonworld Atlas category', 'description': 'Published entries of one category (/api/v1/atlas/categories/{category}.json).',
                'type': 'object', 'required': ['schema_version', 'name', 'generated_at', 'licence', 'category', 'category_label', 'count', 'platforms'],
                'properties': list_meta | {'category': {'enum': categories}, 'category_label': {'type': 'string'}}}
    earn_row = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': S('earn-row.schema.json'),
                'title': 'Where agents get paid: one row', 'description': 'One live entry with a supported money figure, as shown on its card. Values are never converted between units.',
                'type': 'object', 'required': ['id', 'name', 'url', 'json_url', 'category', 'value', 'unit', 'window', 'basis', 'observed_at', 'source_url', 'unit_family', 'tier', 'note', 'group'],
                'properties': {'id': {'type': 'string', 'pattern': ID_PATTERN}, 'name': {'type': 'string'}, 'url': uri, 'json_url': uri,
                               'category': {'enum': categories}, 'value': scalar, 'unit': {'type': ['string', 'null']}, 'window': {'type': ['string', 'null']},
                               'basis': {'enum': BASES}, 'observed_at': utc_n, 'source_url': uri_n, 'unit_family': {'type': 'string'},
                               'tier': {'type': 'string'}, 'note': {'type': ['string', 'null']}, 'group': {'type': 'string'}}}
    earn = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': S('earn.schema.json'),
            'title': 'Where agents get paid', 'description': 'Rows grouped by unit (/api/v1/atlas/earn.json).',
            'type': 'object', 'required': ['schema_version', 'name', 'url', 'generated_at', 'licence', 'count', 'no_figure', 'rows'],
            'properties': {'schema_version': {'type': 'string'}, 'name': {'type': 'string'}, 'url': uri, 'generated_at': gen_at, 'source_snapshot_at': src_at,
                           'licence': {'type': 'string'}, 'source': uri, 'fields_note': {'type': 'string'}, 'count': {'type': 'integer', 'minimum': 0},
                           'no_figure': {'type': 'array', 'items': {'type': 'string', 'pattern': ID_PATTERN}},
                           'rows': {'type': 'array', 'items': {'$ref': 'earn-row.schema.json'}}}}
    nurl = {'type': ['string', 'null'], 'format': 'uri', 'pattern': '^https?://'}
    ppage = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': S('platform-page.schema.json'),
             'title': 'Commonworld Atlas list page',
             'description': f'One page of {PAGE_SIZE} published entries (/api/v1/atlas/page/{{page}}.json, /api/v1/atlas/categories/{{category}}/page/{{page}}.json, '
                            f'/api/v1/atlas/platforms/page/{{page}}.json for the A-Z list). '
                            + PAGE_WALK_RULE + ' Added in schema_version 1.8.0.',
             'type': 'object',
             'required': ['schema_version', 'name', 'url', 'generated_at', 'licence', 'snapshot_id', 'page', 'per_page', 'pages', 'total', 'count',
                          'has_more', 'next', 'prev', 'first', 'full_list', 'platforms'],
             'properties': list_meta | {
                 'md_url': uri | {'description': 'This page as Markdown.'},
                 'snapshot_id': {'type': 'string', 'pattern': '^[0-9a-f]{16}$', 'description': 'Id of the published list: the same on every page of one build; '
                                 'it changes when an entry is added, removed or changed, not with the daily link-safety check or a new screenshot.'},
                 'page': {'type': 'integer', 'minimum': 1}, 'per_page': {'type': 'integer', 'minimum': 1},
                 'pages': {'type': 'integer', 'minimum': 1}, 'total': {'type': 'integer', 'minimum': 0},
                 'has_more': {'type': 'boolean', 'description': 'true when a next page exists.'},
                 'next': nurl | {'description': 'URL of the next page, or null on the last page.'},
                 'prev': nurl | {'description': 'URL of the previous page, or null on page 1.'},
                 'first': uri, 'full_list': uri | {'description': 'The complete list in one file (platforms.json or the category file).'},
                 'walk_rule': {'type': 'string'},
                 'category': {'enum': categories}, 'category_label': {'type': 'string'}}}
    return {'platform.schema.json': platform, 'platform-list.schema.json': plist, 'category.schema.json': category,
            'platform-page.schema.json': ppage,
            'earn-row.schema.json': earn_row, 'earn.schema.json': earn}


# ---------------------------------------------------------------- OpenAPI 3.1
def openapi(origin, categories, example_ids, docs_url, licence):
    js = lambda ref, desc: {'200': {'description': desc, 'content': {'application/json': {'schema': {'$ref': ref}}}}}
    obj = lambda desc: {'200': {'description': desc, 'content': {'application/json': {'schema': {'type': 'object'}}}}}
    idp = {'name': 'id', 'in': 'path', 'required': True,
           'description': 'Permanent entry ID (URL slug). Never construct or guess an ID; take it from atlas/platforms.json (or a category file). An ID not listed there does not exist.',
           'schema': {'type': 'string', 'pattern': ID_PATTERN}, 'examples': {x: {'value': x} for x in example_ids}}
    catp = {'name': 'category', 'in': 'path', 'required': True, 'description': 'Category key, as listed in atlas/index.json.',
            'schema': {'type': 'string', 'enum': categories}}
    pagep = {'name': 'page', 'in': 'path', 'required': True,
             'description': 'Page number, 1-based. The number of pages is in atlas/index.json (counts.pages, categories[].pages) and in every page (pages).',
             'schema': {'type': 'integer', 'minimum': 1}}
    return {
        'openapi': '3.1.0',
        'info': {'title': 'Commonworld Atlas API', 'version': SCHEMA_VERSION,
                 'summary': 'Static, read-only JSON API of the Commonworld Atlas of agent platforms. The live platform API is separate: ' + origin + '/openapi.json',
                 'description': ('Plain static JSON files, rebuilt with every change to the site. ' + PAGING_CONTRACT + ' '
                                 'generated_at: ' + GENERATED_AT_DESC + ' source_snapshot_at: ' + SOURCE_SNAPSHOT_AT_DESC + ' newest_observation: ' + NEWEST_OBSERVATION_DESC + ' '
                                 'A .json file that does not exist answers HTTP 404 with a JSON error body ' + NOT_FOUND_SHAPE + '. '
                                 'No key, no rate limit beyond fair use; '
                                 'CORS is open (Access-Control-Allow-Origin: *). Responses may be cached by Cloudflare and browsers for up to a few hours. '
                                 + VERSIONING + ' Related file outside /api/: ' + origin + '/atlas/events.json, the public log of card changes '
                                 '(also as /atlas/events.md). '
                                 'Money and activity claims carry evidence_level (1 operator says, 2 public dashboard, 3 public transactions, set only by a curator who opened the record) and '
                                 'evidence_label; where a curator opened the source and set the level by hand, the claim also carries evidence_note, '
                                 'a short reason (manual relabel rules: https://github.com/commonworld-one/commonworld/blob/main/atlas/CURATION.md#curator-review-of-a-level). '
                                 + f'Human documentation: {docs_url}'),
                 'license': {'name': f'Data: {licence}', 'url': 'https://creativecommons.org/licenses/by/4.0/'}},
        'servers': [{'url': f'{origin}{API_BASE}', 'description': 'Commonworld (canonical)'}],
        'externalDocs': {'url': docs_url, 'description': 'Commonworld Atlas API documentation'},
        'tags': [{'name': 'api', 'description': 'API root'}, {'name': 'atlas', 'description': 'Atlas of agent platforms'}],
        'paths': {
            '/index.json': {'get': {'tags': ['api'], 'operationId': 'getApiIndex', 'summary': 'API root: version, modules and links', 'responses': obj('API root document')}},
            '/changelog.json': {'get': {'tags': ['api'], 'operationId': 'getChangelog', 'summary': 'Changelog of schema_version', 'responses': obj('Changelog')}},
            '/atlas/index.json': {'get': {'tags': ['atlas'], 'operationId': 'getAtlasIndex', 'summary': 'Atlas module: counts, categories and links', 'responses': obj('Atlas index')}},
            '/atlas/platforms.json': {'get': {'tags': ['atlas'], 'operationId': 'listPlatforms', 'summary': 'All published entries',
                                              'responses': js('./schemas/platform-list.schema.json', 'All published entries')}},
            '/atlas/platforms/{id}.json': {'get': {'tags': ['atlas'], 'operationId': 'getPlatform', 'summary': 'One entry with all claims and sources', 'parameters': [idp],
                                                   'responses': js('./schemas/platform.schema.json', 'One entry') | {'404': {'description': 'No entry with this ID'}}}},
            '/atlas/categories/{category}.json': {'get': {'tags': ['atlas'], 'operationId': 'listCategory', 'summary': 'Entries of one category', 'parameters': [catp],
                                                          'responses': js('./schemas/category.schema.json', 'Entries of one category') | {'404': {'description': 'No such category'}}}},
            '/atlas/page/{page}.json': {'get': {'tags': ['atlas'], 'operationId': 'listPlatformsPage',
                                                'summary': f'One page of {PAGE_SIZE} entries, A to Z (snapshot_id, has_more, next)', 'description': PAGE_WALK_RULE,
                                                'parameters': [pagep],
                                                'responses': js('./schemas/platform-page.schema.json', 'One list page') | PAGE_MISSING}},
            '/atlas/platforms/page/{page}.json': {'get': {'tags': ['atlas'], 'operationId': 'listPlatformsAzPage',
                                                          'summary': f'One page of {PAGE_SIZE} entries of the A-Z list /atlas/platforms/ (same records and order as /atlas/page/{{page}}.json)',
                                                          'description': PAGE_WALK_RULE, 'parameters': [pagep],
                                                          'responses': js('./schemas/platform-page.schema.json', 'One A-Z list page') | PAGE_MISSING}},
            '/atlas/categories/{category}/page/{page}.json': {'get': {'tags': ['atlas'], 'operationId': 'listCategoryPage',
                                                                      'summary': f'One page of {PAGE_SIZE} entries of one category, live first', 'description': PAGE_WALK_RULE,
                                                                      'parameters': [catp, pagep],
                                                                      'responses': js('./schemas/platform-page.schema.json', 'One category list page') | PAGE_MISSING}},
            '/atlas/earn.json': {'get': {'tags': ['atlas'], 'operationId': 'getEarn', 'summary': 'Where agents get paid: money figures grouped by unit',
                                         'responses': js('./schemas/earn.schema.json', 'Money figures by unit')}},
        },
    }


def expand_paths(spec, ids, categories, pages=None):
    """Every concrete file path (under API_BASE) the OpenAPI spec promises. pages: {None: pages of the whole list,
    category: pages of that category} (from atlas/index.json)."""
    out, pages = [], pages or {}
    for p in spec['paths']:
        if '{page}' in p:
            for k in ([c for c in categories] if '{category}' in p else [None]):
                out += [(p.replace('{category}', k) if k else p).replace('{page}', str(n)) for n in range(1, pages.get(k, 1) + 1)]
        elif '{id}' in p:
            out += [p.replace('{id}', i) for i in ids]
        elif '{category}' in p:
            out += [p.replace('{category}', k) for k in categories]
        else:
            out.append(p)
    return out


def changelog_md():
    lines = ['# Commonworld API changelog', '', VERSIONING, '']
    for r in CHANGELOG:
        lines += [f"## {r['schema_version']} ({r['date']})", ''] + [f'- {c}' for c in r['changes']] + ['']
    return '\n'.join(lines)


# ---------------------------------------------------------------- tiny JSON Schema validator (subset of 2020-12 used above)
_TYPES = {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'null': type(None)}


def _is(v, t):
    if t == 'integer':
        return isinstance(v, int) and not isinstance(v, bool)
    if t == 'number':
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return isinstance(v, _TYPES[t])


def _resolve(ref, base_name, registry):
    name, _, frag = ref.partition('#')
    name = name or base_name
    if name.startswith('./'):
        name = name[2:]
    doc = registry[name]
    node = doc
    for part in [x for x in frag.split('/') if x]:
        node = node[part]
    return node, name


def ecma_pattern(p):
    """A JSON Schema `pattern` (ECMA-262 regex) as a Python regex with the same meaning for the patterns used here: search semantics
    (unanchored unless the pattern anchors itself), and every unescaped `$` outside a character class is the end of the string
    (Python's `$` would also match before a trailing newline, so it becomes `\\Z`). Compiled with re.ASCII (\\d is [0-9] as in ECMA)."""
    return _ECMA.get(p) or _ECMA.setdefault(p, re.compile(_dollar_to_z(p), re.ASCII))


_ECMA = {}


def _dollar_to_z(p):
    out, i, cls = [], 0, False
    while i < len(p):
        c = p[i]
        if c == '\\':
            out.append(p[i:i + 2]); i += 2; continue
        if cls:
            cls = c != ']'
        elif c == '[':
            cls = True
        elif c == '$':
            c = r'\Z'
        out.append(c); i += 1
    return ''.join(out)


def pattern_ok(p, s):
    return ecma_pattern(p).search(s) is not None


def format_ok(fmt, v):
    """Commonworld's own formats (cards_v2.SCHEMA_FORMATS, e.g. cw-https-url -> https_url_ok); any other format is an annotation here."""
    f = SCHEMA_FORMATS.get(fmt)
    return f is None or not isinstance(v, str) or f(v)


def validate(inst, schema, registry, base_name, path='$', errs=None, limit=20):
    """Validate inst against schema; registry maps schema file name -> schema. Supports $ref (local and file#/$defs/x),
    allOf, oneOf, const, type, enum, required, properties, additionalProperties: false, items, minItems, maxItems, uniqueItems,
    pattern (ECMA meaning, ecma_pattern), minLength, maxLength, minimum and the cw-* formats (format_ok). Returns a list of 'path: message' strings."""
    errs = [] if errs is None else errs
    if len(errs) >= limit:
        return errs
    if '$ref' in schema:
        node, nb = _resolve(schema['$ref'], base_name, registry)
        validate(inst, node, registry, nb, path, errs, limit)
    for sub in schema.get('allOf', []):
        validate(inst, sub, registry, base_name, path, errs, limit)
    if 'oneOf' in schema:
        res = [validate(inst, sub, registry, base_name, path, [], limit) for sub in schema['oneOf']]
        ok = [r for r in res if not r]
        if len(ok) != 1:
            hint = '' if ok else ': ' + min(res, key=len)[0]
            errs.append(f'{path}: matches {len(ok)} of the {len(res)} oneOf branches, not exactly one{hint}')
    t = schema.get('type')
    if t is not None:
        ts = t if isinstance(t, list) else [t]
        if not any(_is(inst, x) for x in ts):
            errs.append(f'{path}: expected {"/".join(ts)}, got {type(inst).__name__}')
            return errs
    if 'const' in schema and not (type(inst) is type(schema['const']) and inst == schema['const']):
        errs.append(f'{path}: {inst!r} is not {schema["const"]!r}')
    if 'enum' in schema and inst not in schema['enum']:
        errs.append(f'{path}: {inst!r} not in {schema["enum"]}')
    if isinstance(inst, str):
        if 'pattern' in schema and not pattern_ok(schema['pattern'], inst):
            errs.append(f'{path}: {inst[:60]!r} does not match {schema["pattern"]}')
        if len(inst) < schema.get('minLength', 0) or ('maxLength' in schema and len(inst) > schema['maxLength']):
            errs.append(f'{path}: length {len(inst)} outside {schema.get("minLength", 0)}-{schema.get("maxLength", "")}')
        if 'format' in schema and not format_ok(schema['format'], inst):
            errs.append(f'{path}: {inst[:60]!r} is not a valid {schema["format"]}')
    if isinstance(inst, (int, float)) and not isinstance(inst, bool) and 'minimum' in schema and inst < schema['minimum']:
        errs.append(f'{path}: {inst} < {schema["minimum"]}')
    if isinstance(inst, dict):
        for k in schema.get('required', []):
            if k not in inst:
                errs.append(f'{path}: missing required {k!r}')
        for k, sub in (schema.get('properties') or {}).items():
            if k in inst:
                validate(inst[k], sub, registry, base_name, f'{path}.{k}', errs, limit)
        if schema.get('additionalProperties') is False:
            for k in sorted(set(inst) - set(schema.get('properties') or {}), key=str):
                errs.append(f'{path}: unexpected key {k!r}')
    if isinstance(inst, list):
        if len(inst) < schema.get('minItems', 0) or ('maxItems' in schema and len(inst) > schema['maxItems']):
            errs.append(f'{path}: {len(inst)} items, outside {schema.get("minItems", 0)}-{schema.get("maxItems", "")}')
        if schema.get('uniqueItems') and len({json.dumps(v, sort_keys=True) for v in inst}) != len(inst):
            errs.append(f'{path}: items are not unique')
        if 'items' in schema:
            for i, v in enumerate(inst):
                validate(v, schema['items'], registry, base_name, f'{path}[{i}]', errs, limit)
    return errs
