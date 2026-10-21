"""Atlas cards v2 (stdlib only): evidence ladder, keys and books, first task.

The rules here are the contract described in atlas/CURATION.md ("Cards v2"). build.py adds the results to every card page, its
Markdown twin, its JSON record and the API; check.py recomputes them from the published claims and fails on any drift;
tests/test_cards_v2.py pins the rules with examples.

1. Evidence ladder. Every money or activity claim (kind economic_flow, metric, recent_activity) gets a level from its source URL:
   2 public dashboard     the source is a public stats page, dashboard or API anyone can open, or any page on a block explorer;
   1 operator says        any other page: the platform's own words (site text, docs, posts) and other text pages.
   Where a URL could be read two ways, the rule takes the lower level. The URL rule never gives level 3.
   3 public transactions  set ONLY by a curator who opened the record: an entry in atlas/data/evidence-levels.json whose source
                          URL is one concrete record on a known explorer (record_url_ok: https, a host in the explorer -> network
                          map, no userinfo or port, the whole path one record route with a well-formed identifier).
   A card's level is the highest level reached by its supported money/activity claims; a card without one shows "not recorded yet".
   Curator review: atlas/data/evidence-levels.json sets the level of a card's claims with one source URL by hand after a curator
   opened that source (evidence_level + a short evidence_note + reviewed_on); an entry must change the level, and the note is
   published on the claim.
2. Keys and books. Three questions per card: who holds the keys (custody of funds or accounts), whether the books are open (its money
   figures, such as payouts, balances or volume, publicly checkable), which organization is behind it (a company, team or project
   from org_names in keys-and-books.json, matched exactly; never an individual person; an optional `role` from ORG_ROLES says how
   the organization relates to it, such as "acquired it"). Custody resting on the operator's own words is shown as an
   attributed claim ("The operator says ..."); only a smart contract recorded with a public explorer link (basis onchain_verified,
   contract_url = an explorer page of one address or token) is stated plainly. A value is filled only from a supported claim already on
   the card: keys and people curated in atlas/data/keys-and-books.json with the claim's source URL and a quote from that claim.
   Open books are never curated: they come ONLY from the evidence ladder, a supported money-flow claim (economic_flow) at level 2
   or 3, where level 3 comes only from a curator (a `books` field in keys-and-books.json is an error). Every other answer is
   "not recorded yet".
3. First task. One simple, read-only first step for a newcomer, from atlas/data/first-tasks.json (contract: atlas/CURATION.md
   "First task contract"). Only tasks a curator did and verified are published, with credit to the contributor. Cards without one
   show no first-task block. Steps are typed objects from a CLOSED set of actions (STEP_ACTIONS: open_page, find_field,
   check_field), never free text; the sentence shown for a step is rendered from a fixed template (render_step). Fail closed: an
   unknown action, an unknown or missing key or a wrong type is an error; every URL passes the one strict https validator
   (https_url_ok); no control, format or separator character (bad_chars) anywhere; no `code` field; the editorial metadata prose
   also fails on download, install or run wording (run_hits).
"""
import json
import os
import re
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.normpath(os.path.join(HERE, '..', 'data'))
KEYS_BOOKS_FILE = os.path.join(DATA_DIR, 'keys-and-books.json')
FIRST_TASKS_FILE = os.path.join(DATA_DIR, 'first-tasks.json')
EVIDENCE_FILE = os.path.join(DATA_DIR, 'evidence-levels.json')

NOT_RECORDED = 'not recorded yet'

# ---------------------------------------------------------------- 1. evidence ladder
EVIDENCE_KINDS = ('economic_flow', 'metric', 'recent_activity')
LEVELS = {
    1: ('operator_says', 'operator says', "The platform's own words: site text, docs or posts (and other text pages)."),
    2: ('public_dashboard', 'public dashboard', 'A public stats page, dashboard or API that anyone can open.'),
    3: ('public_transactions', 'public transactions', 'One public on-chain record that a curator opened and anyone can check independently.'),
}
# Public block explorers: their pages are views of public chain records. An EXACT allowlist: the host (after a leading `www.`)
# must equal one entry; subdomains are not included (list each one, such as optimistic.etherscan.io), and a host that merely
# contains "scan" or "explorer" is no explorer. Every explorer page is level 2 by the URL rule. Documented in CURATION.md.
EXPLORER_HOSTS = (
    'etherscan.io', 'optimistic.etherscan.io', 'sepolia.etherscan.io', 'basescan.org', 'sepolia.basescan.org', 'arbiscan.io',
    'nova.arbiscan.io', 'polygonscan.com', 'zkevm.polygonscan.com', 'bscscan.com', 'celoscan.io', 'lineascan.build', 'scrollscan.com',
    'snowtrace.io', 'ftmscan.com', 'gnosisscan.io', 'era.zksync.network', 'blastscan.io', 'solscan.io', 'explorer.solana.com',
    'solana.fm', 'blockscout.com', 'eth.blockscout.com', 'base.blockscout.com', 'optimism.blockscout.com', 'gnosis.blockscout.com', 'mempool.space',
    'blockstream.info', 'blockchair.com', 'explorer.hiro.so', 'tronscan.org', 'tonviewer.com', 'tonscan.org', 'suiscan.xyz',
    'explorer.aptoslabs.com', 'oklink.com',
    'kitescan.ai',  # kitescan.ai: the Blockscout explorer of the Kite chain (used by the Kite AI card)
)
# Record format (a curator's level-3 entry and a custody contract_url): a URL is one concrete public record only when its host is
# in RECORD_ROUTES and its WHOLE path (an optional trailing slash aside) is one of that explorer's own record routes with an
# identifier in that explorer's network format. Route names are matched case-sensitively in lowercase. Explorer hosts outside the
# table (blockscout.com, blockchair.com, oklink.com, tronscan.org, explorer.hiro.so) have no record format here. Documented in
# CURATION.md.
_B58 = '[1-9A-HJ-NP-Za-km-z]'
_HEX64 = '[0-9a-fA-F]{64}'
_EVM_TX, _EVM_ADDR, _HEX32_ID = f'0x{_HEX64}', '0x[0-9a-fA-F]{40}', f'0x{_HEX64}'
_DEC = '0|[1-9][0-9]{0,11}'                                       # a block number or version: no leading zero, at most 12 digits
_SOL_SIG, _SOL_ADDR = f'{_B58}{{86,88}}', f'{_B58}{{32,44}}'
_BTC_ADDR = f'[13]{_B58}{{25,34}}|bc1[02-9ac-hj-np-z]{{11,71}}'
_TON_ADDR = '[EUk0]Q[A-Za-z0-9_-]{46}|(?:0|-1):[0-9a-fA-F]{64}'
# network -> {record kind: [(route prefix, identifier)]}
NETWORK_ROUTES = {
    'evm': {'tx': [('/tx/', _EVM_TX)], 'address': [('/address/', _EVM_ADDR)], 'token': [('/token/', _EVM_ADDR)],
            'block': [('/block/', f'{_DEC}|{_EVM_TX}')]},
    'solscan': {'tx': [('/tx/', _SOL_SIG)], 'address': [('/account/', _SOL_ADDR)], 'token': [('/token/', _SOL_ADDR)],
                'block': [('/block/', _DEC)]},
    'solana': {'tx': [('/tx/', _SOL_SIG)], 'address': [('/address/', _SOL_ADDR)], 'block': [('/block/', _DEC)]},
    'bitcoin': {'tx': [('/tx/', _HEX64)], 'address': [('/address/', _BTC_ADDR)], 'block': [('/block/', f'{_HEX64}|{_DEC}')]},
    'tonviewer': {'tx': [('/transaction/', _HEX64)], 'address': [('/', _TON_ADDR)]},
    'tonscan': {'tx': [('/tx/', _HEX64)], 'address': [('/address/', _TON_ADDR)]},
    'sui': {'tx': [('/mainnet/tx/', f'{_B58}{{43,44}}')], 'address': [('/mainnet/account/', _HEX32_ID)]},
    'aptos': {'tx': [('/txn/', f'{_HEX32_ID}|{_DEC}')], 'address': [('/account/', _HEX32_ID)]},
}
_EVM_HOSTS = ('etherscan.io', 'optimistic.etherscan.io', 'sepolia.etherscan.io', 'basescan.org', 'sepolia.basescan.org', 'arbiscan.io',
              'nova.arbiscan.io', 'polygonscan.com', 'zkevm.polygonscan.com', 'bscscan.com', 'celoscan.io', 'lineascan.build',
              'scrollscan.com', 'snowtrace.io', 'ftmscan.com', 'gnosisscan.io', 'era.zksync.network', 'blastscan.io',
              'eth.blockscout.com', 'base.blockscout.com', 'optimism.blockscout.com', 'gnosis.blockscout.com', 'kitescan.ai')
# explorer host -> network (the explorer -> network map; every host here is also in EXPLORER_HOSTS)
RECORD_ROUTES = {**{h: 'evm' for h in _EVM_HOSTS}, 'solscan.io': 'solscan', 'explorer.solana.com': 'solana', 'solana.fm': 'solana',
                 'mempool.space': 'bitcoin', 'blockstream.info': 'bitcoin', 'tonviewer.com': 'tonviewer', 'tonscan.org': 'tonscan',
                 'suiscan.xyz': 'sui', 'explorer.aptoslabs.com': 'aptos'}
_ROUTE_RX = {net: {kind: re.compile('(?:' + '|'.join(f'{re.escape(pre)}(?:{ident})' for pre, ident in rs) + r')/?\Z')
                   for kind, rs in kinds.items()} for net, kinds in NETWORK_ROUTES.items()}
# Public dashboards run by independent trackers (whole site is a dashboard).
DASHBOARD_HOSTS = ('dune.com', 'chainward.ai', 'defillama.com', 'tokenterminal.com', 'x402scan.com')
# Path segments of stats pages, dashboards and APIs.
STATS_SEGMENT = re.compile(r'(^|/)(api|stats|statistics|analytics|dashboard|metrics|leaderboard|status)(/|$|\.|-)', re.I)
VERSIONED_API = re.compile(r'(^|/)v\d+(/|$)')
TEXT_ONLY_HOSTS = ('web.archive.org',)  # archived copies are read as text pages, whatever URL they wrap


def _host_in(host, hosts):
    return any(host == h or host.endswith('.' + h) for h in hosts)


def _bare_host(u):
    host = (u.hostname or '').lower()
    return host[4:] if host.startswith('www.') else host


def _plain_netloc(u):
    """The network location is a bare host name: no userinfo (`user:pass@`, so `https://evil.com@basescan.org/` is not an
    explorer page) and no explicit port (`:443` included)."""
    netloc = u.netloc or ''
    return bool(netloc) and '@' not in netloc and ':' not in netloc and u.username is None and u.password is None


def explorer_host(url):
    """True when the URL's host (after a leading `www.`) is exactly one of EXPLORER_HOSTS, with no userinfo and no port."""
    if not isinstance(url, str):
        return False
    u = urlparse(url)
    return _plain_netloc(u) and _bare_host(u) in EXPLORER_HOSTS


def record_kind(url):
    """'tx', 'address', 'token' or 'block' when the URL is a concrete record page under RECORD_ROUTES: https, a host in the
    explorer -> network map (after a leading `www.`), no userinfo or port, no query or fragment, and the whole path is one of that
    network's routes with an identifier in its format. None otherwise."""
    if not https_url_ok(url) or '?' in url or '#' in url:  # https_url_ok: urlparse would silently drop a newline or tab
        return None
    u = urlparse(url)
    net = RECORD_ROUTES.get(_bare_host(u)) if _plain_netloc(u) else None
    if not net:
        return None
    return next((kind for kind, rx in _ROUTE_RX[net].items() if rx.fullmatch(u.path or '')), None)


def source_level(url):
    """Ladder level (1 or 2) of one source URL, or None when there is no URL. Deterministic; ties go to the lower level. The URL
    rule never gives level 3: that is a curator's entry (validate_evidence_overrides, record_url_ok)."""
    if not url or not isinstance(url, str) or not url.startswith(('http://', 'https://')):
        return None
    u = urlparse(url)
    host = _bare_host(u)
    path = u.path or '/'
    if _host_in(host, TEXT_ONLY_HOSTS):
        return 1
    explorer = host in EXPLORER_HOSTS and _plain_netloc(u)  # exact allowlist, no subdomains, no userinfo or port, no "scan" guess
    if explorer:  # any explorer page, a single record included: level 3 is set only by a curator (record_url_ok)
        return 2
    if _host_in(host, DASHBOARD_HOSTS) or host.startswith(('api.', 'stats.')) or STATS_SEGMENT.search(path) \
            or VERSIONED_API.search(path) or path.lower().endswith('.json'):
        return 2
    return 1


def record_url_ok(url):
    """FORMAT check of a curator's level-3 source (and a custody contract_url): the strict https_url_ok, a host exactly in the
    explorer -> network map, no userinfo or port, no query or fragment, and the whole path one record with a well-formed
    identifier (record_kind). It says nothing about the content: the curator opened the record."""
    return https_url_ok(url) and record_kind(url) is not None


def load_evidence_overrides(path=EVIDENCE_FILE):
    """{slug: [{source_url, evidence_level, evidence_note, reviewed_on}]} from the curated review file ({} when absent)."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        return json.load(fh).get('overrides') or {}


def _override(x, ov):
    """The curator entry for this claim (same source URL, money/activity kind) from a card's override list, or None."""
    if not ov or x.get('kind') not in EVIDENCE_KINDS:
        return None
    return next((o for o in ov if o.get('source_url') == x.get('source_url')), None)


def card_overrides(card, overrides):
    return (overrides or {}).get(card.get('slug') or card.get('id')) or []


def claim_level(x, ov=None):
    """Level of a money/activity claim: the curator's level when the card's override list `ov` has its source URL, otherwise the
    URL rule. None for other kinds or a claim without a source."""
    if x.get('kind') not in EVIDENCE_KINDS:
        return None
    o = _override(x, ov)
    if o:
        return o['evidence_level']
    return source_level(x.get('source_url'))


def claim_note(x, ov=None):
    """The curator's evidence_note for this claim, or None when its level comes from the URL rule."""
    o = _override(x, ov)
    return o.get('evidence_note') if o else None


NOTE_MAX = 200


def validate_evidence_overrides(overrides, cards_by_slug):
    """Errors in the curated evidence-levels file: unknown slug, a source URL that is no money/activity claim on the card, a level
    outside 1-3 or equal to the URL rule (an entry must change something), a level 3 whose source is not one explorer record
    (record_url_ok), a note that is empty, long or negative, a bad date, or the same source twice on one card."""
    errs = []
    for slug, ov in overrides.items():
        w = f'evidence-levels: {slug}'
        c = cards_by_slug.get(slug)
        if c is None:
            errs.append(f'{w} is not a published card'); continue
        if not isinstance(ov, list) or not ov:
            errs.append(f'{w}: needs a non-empty list'); continue
        seen = set()
        for o in ov:
            u = o.get('source_url')
            extra = set(o) - {'source_url', 'evidence_level', 'evidence_note', 'reviewed_on'}
            if extra:
                errs.append(f'{w}: unexpected keys {sorted(extra)}')
            if u in seen:
                errs.append(f'{w}: {u} listed twice')
            seen.add(u)
            claims = [x for x in c.get('claims', []) if x.get('kind') in EVIDENCE_KINDS and x.get('source_url') == u]
            if not claims:
                errs.append(f'{w}: {u} is not the source of a money/activity claim on the card'); continue
            lv = o.get('evidence_level')
            if lv not in LEVELS or isinstance(lv, bool):
                errs.append(f'{w}: {u} evidence_level {lv!r} not in 1, 2, 3')
            elif lv == source_level(u):
                errs.append(f'{w}: {u} evidence_level {lv} equals the URL rule (drop the entry)')
            elif lv == 3 and not record_url_ok(u):
                errs.append(f'{w}: {u} evidence_level 3 needs one record on a known explorer (https, a host in the explorer -> '
                            f'network map, no userinfo or port, the whole path one record with a well-formed identifier)')
            note = (o.get('evidence_note') or '').strip()
            if not note or len(note) > NOTE_MAX:
                errs.append(f'{w}: {u} evidence_note must be 1-{NOTE_MAX} characters')
            for word in negative_hits(note):
                errs.append(f'{w}: {u} evidence_note uses negative wording {word!r}')
            if not date_ok(o.get('reviewed_on')):
                errs.append(f'{w}: {u} reviewed_on must be YYYY-MM-DD')
    return errs


def level_record(level):
    if level is None:
        return {'level': None, 'id': None, 'label': NOT_RECORDED}
    lid, label, _ = LEVELS[level]
    return {'level': level, 'id': lid, 'label': label}


def card_evidence(card, overrides=None):
    """Card-level summary: the highest level of its supported money/activity claims (curator levels applied)."""
    ov = card_overrides(card, overrides)
    levels = [claim_level(x, ov) for x in card.get('claims', []) if x.get('outcome') == 'supported']
    levels = [lv for lv in levels if lv]
    rec = level_record(max(levels) if levels else None)
    rec['claims_counted'] = len(levels)
    return rec


def annotate_claim(x, ov=None):
    """Copy of a claim with evidence_level / evidence_label on money/activity claims, plus evidence_note where a curator set the
    level (others unchanged)."""
    lv = claim_level(x, ov)
    if lv is None:
        return dict(x)
    out = dict(x) | {'evidence_level': lv, 'evidence_label': LEVELS[lv][1]}
    note = claim_note(x, ov)
    if note:
        out['evidence_note'] = note
    return out


# ---------------------------------------------------------------- 2. keys and books
KEYS_VALUES = {'operator': 'The operator holds the funds',
               'user_wallet': "Users hold their own wallet or keys",
               'smart_contract': 'A smart contract holds the funds'}
# Custody basis: operator_says (default: the claim is the operator's own text) or onchain_verified (smart_contract only, with a
# contract_url on a public explorer: one address or token page, record_url_ok). The label of an operator_says value is an attributed claim.
KEYS_BASES = ('operator_says', 'onchain_verified')
KEYS_SAID = {'operator': 'The operator says it holds the funds',
             'user_wallet': 'The operator says users hold their own wallet or keys',
             'smart_contract': 'The operator says a smart contract holds the funds'}
KEYS_ONCHAIN = {'smart_contract': 'A smart contract holds the funds (contract on a public block explorer)'}
BOOKS_VALUES = {'public_transactions': 'Open: its money figures are on public transactions',
                'public_dashboard': 'Open: its money figures are on a public dashboard or API'}
PEOPLE_VALUES = {'named': 'Named'}  # an organization (company, team, project), never an individual person: org_names
# Optional people.role: how the named organization relates to the platform. A fixed list, so no free text sits next to the name.
ORG_ROLES = {'acquired': 'acquired it', 'announced': 'announced it'}
KB_FIELDS = {'keys': ('Who holds the keys', KEYS_VALUES), 'books': ('Open books', BOOKS_VALUES), 'people': ('People behind it', PEOPLE_VALUES)}
# Fields a curator may set in keys-and-books.json. `books` is not one of them: open books come only from the evidence ladder.
KB_CURATED = ('keys', 'people')
BOOKS_BY_LEVEL = {3: 'public_transactions', 2: 'public_dashboard'}


def _norm(s):
    return re.sub(r'\s+', ' ', s or '').strip().lower()


def load_keys_books(path=KEYS_BOOKS_FILE):
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        return json.load(fh).get('entries') or {}


def load_org_names(path=KEYS_BOOKS_FILE):
    """Curated allowlist of organization names (companies, teams, projects) allowed in people.names."""
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as fh:
        return json.load(fh).get('org_names') or []


def org_name_ok(names, orgs):
    """people.names is exactly one allowlisted organization name (no notes or brackets after it: free text next to a name could
    carry an individual person's name). How the organization relates to the platform goes in people.role (ORG_ROLES)."""
    return isinstance(names, str) and names in (orgs or [])


# A smart contract's page on a public explorer: the WHOLE path is one address or token, `/<kind>/<id>` with at most one trailing
# slash, nothing before or after it. Transactions and blocks are records too (ladder level 3), but they do not name the contract
# that holds the funds; `/tx/<hash>/address/<addr>` or a query/fragment is rejected so the page shown is exactly that contract.
# Segment names are lowercase and matched case-sensitively (/ADDRESS/ is rejected).
def contract_url_ok(url):
    """contract_url is an explorer page of one address or token (record_url_ok, record_kind 'address' or 'token': not a
    transaction, block or stats page)."""
    return record_url_ok(url) and record_kind(url) in ('address', 'token')


def load_first_tasks(path=FIRST_TASKS_FILE):
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        return json.load(fh).get('tasks') or {}


def _supporting_claim(card, source_url, quote):
    """The supported claim on the card with this source URL whose quote or statement contains the quote, or None."""
    q = _norm(quote)
    for x in card.get('claims', []):
        if x.get('outcome') == 'supported' and x.get('source_url') == source_url and q and \
                (q in _norm(x.get('quote')) or q in _norm(x.get('statement'))):
            return x
    return None


def validate_keys_books(entries, cards_by_slug, orgs=None):
    """Errors in the curated keys-and-books file: unknown slug or field (`books` included: it is derived only), value outside its list, a source/quote that is not a
    supported claim already on the card, a people.names that is not exactly one allowlisted organization (the Atlas lists places,
    never individual people) or a people.role outside ORG_ROLES, or a custody basis onchain_verified without a public explorer
    page of the contract's address or token (contract_url_ok)."""
    orgs = load_org_names() if orgs is None else orgs
    errs = []
    for slug, ent in entries.items():
        c = cards_by_slug.get(slug)
        if c is None:
            errs.append(f'keys-and-books: {slug} is not a published card'); continue
        for f, v in ent.items():
            if f == 'books':
                errs.append(f'keys-and-books: {slug}.books cannot be curated: open books come only from the evidence ladder '
                            f'(a supported money-flow claim at level 2 or 3)'); continue
            if f not in KB_CURATED:
                errs.append(f'keys-and-books: {slug}.{f} is not one of {", ".join(KB_CURATED)}'); continue
            if not isinstance(v, dict):
                errs.append(f'keys-and-books: {slug}.{f} must be an object'); continue
            vals = KB_FIELDS[f][1]
            if v.get('value') not in vals:
                errs.append(f'keys-and-books: {slug}.{f} value {v.get("value")!r} not in {sorted(vals)}')
            if f == 'people' and not (v.get('names') or '').strip():
                errs.append(f'keys-and-books: {slug}.people needs names')
            elif f == 'people' and not org_name_ok(v.get('names'), orgs):
                errs.append(f'keys-and-books: {slug}.people names {v.get("names")!r} is not exactly one organization in org_names (no individual people, no notes)')
            if f == 'people' and 'role' in v and v['role'] not in ORG_ROLES:
                errs.append(f'keys-and-books: {slug}.people role {v["role"]!r} not in {sorted(ORG_ROLES)}')
            if f != 'people' and ({'names', 'role'} & set(v)):
                errs.append(f'keys-and-books: {slug}.{f}: names/role belong to people only')
            if f != 'keys' and ({'basis', 'contract_url'} & set(v)):
                errs.append(f'keys-and-books: {slug}.{f}: basis/contract_url belong to keys only')
            if f == 'keys':
                basis = v.get('basis', 'operator_says')
                if basis not in KEYS_BASES:
                    errs.append(f'keys-and-books: {slug}.keys basis {basis!r} not in {KEYS_BASES}')
                elif basis == 'onchain_verified' and (v.get('value') not in KEYS_ONCHAIN or not contract_url_ok(v.get('contract_url'))):
                    errs.append(f'keys-and-books: {slug}.keys onchain_verified needs value smart_contract and a contract_url that is a public '
                                f'explorer page of one address or token (level 3; not a transaction or block)')
                elif basis == 'operator_says' and v.get('contract_url'):
                    errs.append(f'keys-and-books: {slug}.keys has a contract_url: set basis onchain_verified')
            if not _supporting_claim(c, v.get('source_url'), v.get('quote')):
                errs.append(f'keys-and-books: {slug}.{f} source/quote is not a supported claim on the card')
    return errs


def _item(field, value, source_url, quote, names=None, role=None):
    label = KB_FIELDS[field][1][value]
    if names:
        label = f'{label}: {names}' + (f' ({ORG_ROLES[role]})' if role in ORG_ROLES else '')
    return {'state': 'recorded', 'value': value, 'label': label, 'source_url': source_url, 'quote': quote}


def _keys_item(v):
    """Custody: an attributed claim ("The operator says ...") unless a curator recorded the contract on a public explorer."""
    basis = v.get('basis', 'operator_says')
    it = _item('keys', v['value'], v['source_url'], v['quote'])
    if basis == 'onchain_verified':
        return it | {'label': KEYS_ONCHAIN[v['value']], 'basis': basis, 'contract_url': v['contract_url']}
    return it | {'label': KEYS_SAID[v['value']], 'basis': 'operator_says'}


def _empty():
    return {'state': 'not_recorded', 'value': None, 'label': NOT_RECORDED, 'source_url': None, 'quote': None}


def keys_and_books(card, curated, overrides=None):
    """{keys, books, people} for one card. Keys and people from the curated file; open books ONLY from the highest-level
    supported money-flow claim at ladder level 2 or 3 (curator levels applied; a curated `books` value is ignored here and an
    error in validate_keys_books). Everything else: not recorded yet."""
    ent = curated.get(card.get('slug') or card.get('id')) or {}
    ov = card_overrides(card, overrides)
    out = {}
    for f in KB_FIELDS:
        v = ent.get(f) if f in KB_CURATED else None
        if isinstance(v, dict) and _supporting_claim(card, v.get('source_url'), v.get('quote')):
            out[f] = _keys_item(v) if f == 'keys' else _item(f, v['value'], v['source_url'], v['quote'], v.get('names'), v.get('role'))
        else:
            out[f] = _empty()
    best = None  # open books: the evidence ladder only
    for x in card.get('claims', []):
        lv = claim_level(x, ov)
        if x.get('kind') == 'economic_flow' and x.get('outcome') == 'supported' and lv in BOOKS_BY_LEVEL and (best is None or lv > best[0]):
            best = (lv, x)
    if best:
        x = best[1]
        out['books'] = _item('books', BOOKS_BY_LEVEL[best[0]], x['source_url'], (x.get('quote') or x.get('statement') or '')[:240])
    return out


# ---------------------------------------------------------------- 3. first task
TASK_FIELDS = ('title', 'steps', 'done_when', 'contributed_by', 'contributed_via', 'source_url', 'verified_by', 'verified_on', 'verification')
TEXT_FIELDS = ('title', 'done_when', 'verification', 'contributed_by', 'contributed_via', 'verified_by')  # editorial metadata prose
DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')  # always used with fullmatch (no trailing newline); ASCII digits only, as the schema


def date_ok(v):
    return isinstance(v, str) and DATE.fullmatch(v) is not None


# Printable ASCII (0x20-0x7e), always used with fullmatch.
ASCII_PRINTABLE = re.compile(r'[\x20-\x7e]*')
TEXT_MAX = 400


def bad_chars(text):
    """Characters that could hide, reorder or break text: every Unicode category C (Cc = C0 controls, DEL and C1 controls such
    as U+0085; Cf = format characters such as zero-width characters, U+200E/U+200F marks, bidi embeddings and isolates, U+FEFF;
    Cs, Co, Cn) plus line and paragraph separators (Zl U+2028, Zp U+2029) and every space separator except the plain space
    (Zs: U+00A0 no-break space, U+2007, U+202F, U+3000, ...), which look like a space but are another character.
    -> sorted list of 'U+XXXX'."""
    import unicodedata
    return sorted({f'U+{ord(ch):04X}' for ch in text
                   if unicodedata.category(ch)[0] == 'C' or unicodedata.category(ch) in ('Zl', 'Zp')
                   or (unicodedata.category(ch) == 'Zs' and ch != ' ')})


# ---- one strict https URL validator (first-task open_page url and source_url, curator level-3 source, custody contract_url)
DNS_HOST = re.compile(r'(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?')  # fullmatch
URL_MAX = 2048
# Script and binary file extensions: a URL whose decoded path segment ends in one of these is no plain page.
RUN_EXTENSIONS = ('py', 'pyz', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'js', 'mjs', 'cjs', 'ts', 'exe', 'msi', 'dmg', 'pkg',
                  'deb', 'rpm', 'apk', 'appimage', 'jar', 'whl', 'bin', 'run')
RAW_HOST_NAMES = ('raw.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com')
RAW_HOSTS = re.compile(r'raw\.githubusercontent\.com|gist\.github(usercontent)?\.com', re.I)  # in prose (NO_RUN)
URL_BAD_CHARS = ' \\<>"`'  # space, backslash and the HTML/Markdown-active characters < > " ` (raw or after one decode)
_EXT_IN_QUERY = re.compile(r'\.(?:' + '|'.join(RUN_EXTENSIONS) + r')(?![a-z0-9])')


def https_url_ok(url):
    """The one strict check of an https link (fail closed). Accepted only when ALL hold:
    a str of at most URL_MAX printable ASCII characters (fullmatch: no trailing newline), no whitespace, no backslash and none of
    < > " ` (URL_BAD_CHARS, also checked after the one decode);
    starts with https://; no userinfo and no port; the host is a plain lowercase DNS name (letters, digits, hyphens, dots; an
    IDN only as punycode xn--; no '%'); the path, query and fragment decoded ONCE contain no '%' (so no double encoding), no
    whitespace, backslash, < > " ` or non-printable character; the decoded, lowercased host is not raw.githubusercontent.com, gist.github.com
    or gist.githubusercontent.com (nor a subdomain); no decoded path segment ends in a script or binary extension (RUN_EXTENSIONS;
    the whole segment and each `;` piece, trailing dots ignored), and no such extension sits in the decoded query or fragment."""
    from urllib.parse import unquote, urlsplit
    if not isinstance(url, str) or not 0 < len(url) <= URL_MAX or ASCII_PRINTABLE.fullmatch(url) is None:
        return False
    if any(c in url for c in URL_BAD_CHARS) or not url.startswith('https://'):
        return False
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    host = u.netloc
    if u.scheme != 'https' or not host or DNS_HOST.fullmatch(host) is None:  # also rules out '@', ':', '%' and upper case
        return False
    if any(host == h or host.endswith('.' + h) for h in RAW_HOST_NAMES):
        return False
    rest = url[len('https://') + len(host):]
    try:
        dec = unquote(rest, errors='strict') if '%' in rest else rest
    except UnicodeDecodeError:
        return False
    if '%' in dec or ASCII_PRINTABLE.fullmatch(dec) is None or any(c in dec for c in URL_BAD_CHARS):
        return False
    du = urlsplit('https://x.invalid' + (dec if dec.startswith(('/', '?', '#')) else '/' + dec))
    for seg in du.path.lower().split('/'):
        for part in [seg] + seg.split(';'):  # the whole segment and each `;` piece
            part = part.rstrip('.')
            if '.' in part and part.rsplit('.', 1)[-1] in RUN_EXTENSIONS:
                return False
    return _EXT_IN_QUERY.search((du.query + '#' + du.fragment).lower()) is None


def source_url_ok(url):
    """A first task's source_url: https_url_ok (the same strict validator as open_page)."""
    return https_url_ok(url)


# ---- typed steps: a CLOSED set of actions (owner decision 2026-10-20). No free text: the sentence shown for a step is rendered
# by render_step() from a fixed template per action. Unknown action, unknown key, missing key or wrong type is an error.
IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_.]{0,63}')          # a JSON field name (fullmatch)
TOKEN = re.compile(r'[A-Za-z0-9_.-]{1,64}')                  # a JSON value to compare with (fullmatch)
LABEL = re.compile(r'[A-Za-z0-9](?:[A-Za-z0-9 -]{0,38}[A-Za-z0-9])?')  # a short label: letters, digits, spaces, hyphens (fullmatch)
EACH_HAS_MAX = 8
STEPS_MAX = 8
# action -> {key: kind}; every key is required unless listed in STEP_OPTIONAL
STEP_ACTIONS = {
    'open_page': {'url': 'url', 'label': 'label'},
    'find_field': {'field': 'ident', 'each_has': 'idents'},
    'check_field': {'each': 'ident', 'field': 'ident', 'match': 'match', 'then_label': 'label', 'else_field': 'ident', 'else_label': 'label'},
}
STEP_OPTIONAL = {'open_page': {'label'}, 'find_field': {'each_has'}, 'check_field': set()}
MATCH_KEYS = {'key': 'ident', 'equals': 'token', 'has': 'ident'}  # all three required


def _q(name):
    return f'"{name}"'


def render_step(s):
    """The sentence shown for one validated step (fixed template per action)."""
    a = s['action']
    if a == 'open_page':
        return f"Open {s['label']} in a browser: {s['url']}" if s.get('label') else f"Open {s['url']} in a browser."
    if a == 'find_field':
        txt = f"Find the list {_q(s['field'])}."
        if s.get('each_has'):
            txt += ' Each item has ' + ' and '.join(_q(x) for x in s['each_has']) + '.'
        return txt
    m = s['match']
    return (f"Check {_q(s['field'])} of each item in {_q(s['each'])}: an entry whose {_q(m['key'])} is {_q(m['equals'])} and that "
            f"has a value in {_q(m['has'])} means the item is on the {s['then_label']}; an item without such an entry is on the "
            f"{s['else_label']} (its {_q(s['else_field'])}).")


def _kind_ok(kind, v):
    if kind == 'url':
        return https_url_ok(v)
    if kind == 'ident':
        return isinstance(v, str) and IDENT.fullmatch(v) is not None
    if kind == 'token':
        return isinstance(v, str) and TOKEN.fullmatch(v) is not None
    if kind == 'label':
        return isinstance(v, str) and LABEL.fullmatch(v) is not None and not run_hits(v)
    if kind == 'idents':
        return isinstance(v, list) and 0 < len(v) <= EACH_HAS_MAX and all(_kind_ok('ident', x) for x in v) and len(set(v)) == len(v)
    return False


KIND_HELP = {'url': 'a plain https URL (https_url_ok)', 'ident': 'a field name (letters, digits, _ and ., starting with a letter or _, '
             'at most 64)', 'token': 'a value of letters, digits, _, . or - (at most 64)', 'label': 'a short label (letters, digits, '
             'spaces, hyphens; at most 40; no run words)', 'idents': f'a list of 1-{EACH_HAS_MAX} distinct field names'}


def step_errors(s, i):
    """Errors of one step (fail closed)."""
    w = f'step {i}'
    if not isinstance(s, dict):
        return [f'{w} must be an object with an "action" from {sorted(STEP_ACTIONS)}, not {type(s).__name__}']
    a = s.get('action')
    if not isinstance(a, str) or a not in STEP_ACTIONS:
        return [f'{w}: action {a!r} is not one of {sorted(STEP_ACTIONS)}']
    spec, errs = STEP_ACTIONS[a], []
    extra = set(s) - set(spec) - {'action'}
    if extra:
        errs.append(f'{w} ({a}): unexpected keys {sorted(map(str, extra))}')
    for k, kind in spec.items():
        if k not in s:
            if k not in STEP_OPTIONAL[a]:
                errs.append(f'{w} ({a}): missing {k}')
            continue
        if kind == 'match':
            m = s[k]
            if not isinstance(m, dict) or set(m) != set(MATCH_KEYS):
                errs.append(f'{w} ({a}): match must be an object with exactly the keys {sorted(MATCH_KEYS)}'); continue
            for mk, mkind in MATCH_KEYS.items():
                if not _kind_ok(mkind, m[mk]):
                    errs.append(f'{w} ({a}): match.{mk} must be {KIND_HELP[mkind]}')
        elif not _kind_ok(kind, s[k]):
            errs.append(f'{w} ({a}): {k} must be {KIND_HELP[kind]}')
    return errs


# Defense in depth on the editorial metadata prose (title, done_when, verification, contributor and verifier fields) and on step
# labels. Prose that trips it is reworded.
NO_RUN = (
    ('backticked text (a command)', re.compile(r'`')),
    ('a shell command or a download, install or run instruction', re.compile(
        r'(?<![\w.-])(curl|wget|iwr|iex|invoke-\w+|pip\d*|pipx|uvx?|npm|npx|pnpm|yarn|bunx?|deno|gem|cargo|brew|apt(-get)?|sudo|'
        r'chmod|docker|git\s+clone|go\s+(install|run|get)|bash|zsh|sh|pwsh|powershell|cmd|python[\d.]*|py|node(js)?|perl|ruby|php|'
        r'download(s|ed|ing)?|install(s|ed|ing)?|terminal|command line|shell|script|'
        r'run(s|ning)?|ran|execut(e|es|ed|ing|able|ables)|launch(es|ed|ing)?)(?![\w-])|^\s*[$>#]\s|\|\s*\w', re.I)),
    ('a link to a script or binary', re.compile(
        r'https?://[^\s"\'<>)]+\.(' + '|'.join(RUN_EXTENSIONS) + r')(?=$|[\s"\'<>)?#.,;:])', re.I)),
    ('a raw GitHub or gist link', RAW_HOSTS),
)
URL_IN_TEXT = re.compile(r'https?://[^\s"\'<>()\[\]`]+', re.I)


def run_hits(text):
    """Why a text looks like it downloads, installs or runs something ([] when it does not)."""
    return [why for why, rx in NO_RUN if rx.search(text or '')]


def _strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from _strings(k)
            yield from _strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _strings(v)


def task_text_errors(t):
    """Fail closed on text: no `code` field; no string ANYWHERE in the task (keys and step values included) with a character from
    bad_chars(); every metadata prose field (TEXT_FIELDS) at most TEXT_MAX characters, with no download/install/run hint
    (run_hits) and every link in it a plain https URL (https_url_ok)."""
    errs = ['a first task has nothing to download or run: remove the `code` field'] if 'code' in t else []
    for text in _strings(t):
        bad = bad_chars(text)
        if bad:
            errs.append(f'{text[:60]!r} must not contain control, format or separator characters ({", ".join(bad[:5])})')
    for k in TEXT_FIELDS:
        text = t.get(k)
        if not isinstance(text, str):
            continue  # a wrong type is reported by validate_first_tasks
        errs += _prose_errors(k, text)
    return errs


def _prose_errors(k, text):
    """Errors of one metadata prose field (TEXT_FIELDS): at most TEXT_MAX characters, no run hint, every link https_url_ok."""
    errs = [f'{k} is longer than {TEXT_MAX} characters'] if len(text) > TEXT_MAX else []
    for why in run_hits(text):
        errs.append(f'{k} {text[:60]!r} has {why}: a first task has nothing to download or run')
    for u in URL_IN_TEXT.findall(text):
        u = u.rstrip('.,;:!?')
        if not https_url_ok(u):
            errs.append(f'{k}: link {u[:60]!r} is no plain https URL (https_url_ok)')
    return errs


# ---- the same checks for the published JSON Schema (api_v1.py). The schema marks a value with a custom "format"; the repo's
# schema validators (api_v1.validate and tools/validate_jsonschema.py, used by check.py and CI) call these functions for it,
# so schema validation and validate_first_tasks agree. Other validators treat an unknown format as an annotation.
def label_ok(v):
    return _kind_ok('label', v)


def task_text_ok(v):
    """A metadata prose field as validate_first_tasks wants it: a non-empty str, no hidden character, _prose_errors() empty."""
    return isinstance(v, str) and v != '' and not bad_chars(v) and not _prose_errors('text', v)


SCHEMA_FORMATS = {'cw-https-url': https_url_ok, 'cw-label': label_ok, 'cw-task-text': task_text_ok}
# The strictest https URL the schema pattern can express (https_url_ok stays authoritative): https://, a lowercase host of
# letters, digits, dots and hyphens (no '%', '@' or ':'), then printable ASCII without space, backslash, < > " `.
URL_PATTERN = r'^https://[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:[/?#][\x21\x23-\x3b\x3d\x3f-\x5b\x5d-\x5f\x61-\x7e]*)?$'


def validate_first_tasks(tasks, slugs):
    errs = []
    for slug, t in tasks.items():
        w = f'first-tasks: {slug}'
        if slug not in slugs:
            errs.append(f'{w} is not a published card'); continue
        if not isinstance(t, dict):
            errs.append(f'{w} must be an object'); continue
        for k in TASK_FIELDS:
            if k != 'steps' and k in t and not isinstance(t[k], str):
                errs.append(f'{w}: {k} must be a string, not {type(t[k]).__name__}')
        extra = set(t) - set(TASK_FIELDS) - {'code'}  # `code` is reported by task_text_errors
        if extra:
            errs.append(f'{w}: unexpected keys {sorted(map(str, extra))}')
        miss = [k for k in TASK_FIELDS if not t.get(k)]
        if miss:
            errs.append(f'{w} missing {", ".join(miss)}')
        steps = t.get('steps')
        if 'steps' in t and (not isinstance(steps, list) or not 0 < len(steps) <= STEPS_MAX):
            errs.append(f'{w}: steps must be a list of 1-{STEPS_MAX} step objects')
        elif isinstance(steps, list):
            for i, s in enumerate(steps, 1):
                errs += [f'{w}: {x}' for x in step_errors(s, i)]
        if not source_url_ok(t.get('source_url')):
            errs.append(f'{w}: source_url must be a plain https URL (https_url_ok: printable ASCII, no userinfo or port, a plain '
                        f'DNS host, no encoded characters left after one decode, no script or binary file, no raw GitHub or gist host)')
        if not date_ok(t.get('verified_on')):
            errs.append(f'{w}: verified_on must be YYYY-MM-DD')
        errs += [f'{w}: {x}' for x in task_text_errors(t)]
    return errs


def curation_event_gaps(overrides, curated, tasks, events, start):
    """The curation files change published cards outside the snapshot's `amendments`, so each record carries its own date
    and needs its event in atlas/data/events.jsonl (atlas/CURATION.md#events-log) from `start` (the log's first day) on:
    an evidence-level review (reviewed_on) a `relabelled` event, a keys-and-books value (reviewed_on, required on every
    value) and a first task (verified_on) a `corrected` event, same day and slug. Changing a record means a new date, and
    with it a new event. -> list of gaps."""
    have = {(e.get('date'), e.get('slug'), e.get('type')) for e in events}
    gaps = []

    def need(date, slug, typ, what):
        if not date_ok(date):
            gaps.append(f'{what}: needs a YYYY-MM-DD date'); return
        if date >= start and (date, slug, typ) not in have:
            gaps.append(f'{what} ({date}) has no "{typ}" event for {slug} on {date} in atlas/data/events.jsonl')

    for slug, rows in (overrides or {}).items():
        for o in rows or []:
            if isinstance(o, dict):
                need(o.get('reviewed_on'), slug, 'relabelled', f'evidence-levels: {slug} {o.get("source_url")}')
    for slug, ent in (curated or {}).items():
        for f, v in (ent or {}).items():
            if isinstance(v, dict):
                need(v.get('reviewed_on'), slug, 'corrected', f'keys-and-books: {slug}.{f} reviewed_on')
    for slug, t in (tasks or {}).items():
        if isinstance(t, dict):
            need(t.get('verified_on'), slug, 'corrected', f'first-tasks: {slug} verified_on')
    return gaps


def first_task(card, tasks):
    """The published first task: the stored fields (steps as typed step objects), steps_text (the sentence for each step,
    rendered by render_step) and credit. Only called on a validated file (check.py and build run validate_first_tasks)."""
    t = tasks.get(card.get('slug') or card.get('id'))
    if not t or not isinstance(t, dict):
        return None
    return {k: t[k] for k in TASK_FIELDS} | {'steps_text': [render_step(s) for s in t['steps']],
                                              'credit': f"Contributed by {t['contributed_by']}"}


# ---------------------------------------------------------------- public wording guard
# Site-authored v2 wording says what a thing IS; these words must not appear in the v2 blocks we write.
NEGATIVE_WORDS = re.compile(r"\b(unknown|unverified|doesn't|does not|don't|fails?|failed|missing|none|no data|not verified)\b", re.I)


def negative_hits(text):
    return sorted(set(m.group(0).lower() for m in NEGATIVE_WORDS.finditer(text or '')))
