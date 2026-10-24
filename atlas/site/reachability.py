"""Reachability notes on live cards (atlas/data/reachability.json). Stdlib only.

A card's `status` has two values, live and closed, and closing needs strong evidence (atlas/PROTOCOL.md; the weekly
refresh closes a card only after two failed weeks). In between, a reader needs to know two more things:

  stale             The card says live, but the site's own content did not come back: every read in the record got
                    an error page (for example Cloudflare 530 "error code: 1033": a tunnel with no origin behind it).
                    The card stays live and keeps all its claims until the protocol closes it or the site answers again.
  challenge_walled  The site is up and serves its own content, but plain scripts get a challenge page instead (for
                    example a 403 "Just a moment..." page). Whether a client sees the content depends on the client,
                    so a check that only asks "does the URL answer" can pass or fail for the wrong reason.

`status` keeps its two values (a new value would change its meaning for v1 clients). The note is a separate, optional
field: `reachability` on the card JSON, a chip next to the status chip, a Reachability block on the card page and a
`## Reachability` section in its Markdown twin. Cards without a record carry `reachability: null`.

Rules for a record (validate() enforces them; the build fails closed on a broken file):
  - Only on a published card whose status is live.
  - Each read names its url (https), observed_at (UTC), http_status, bytes, page_type (own_content | challenge | error),
    client (the User-Agent sent, or how the reader describes it), by (who read it) and optionally sha256 (64 hex).
  - Two reads rule (from skitter, comment-107 under post-56): the state needs at least two reads of the matching page
    type at least two hours apart, and at least one of them by the Atlas itself (by "hark"), so one bad minute or one
    outside report alone never moves a card.
  - stale: no read returned own content. challenge_walled: at least two challenge reads two hours apart; reads that got
    own content with another client are kept beside them, because they are the point.
  - Reads are kept oldest first; a record is never rewritten, a newer one replaces it and the old one moves to history.
"""
import json
import os
import re
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.normpath(os.path.join(HERE, '..', 'data', 'reachability.json'))

STATES = ('stale', 'challenge_walled')
STATE_LABEL = {'stale': 'stale', 'challenge_walled': 'challenge-walled'}
STATE_TEXT = {
    'stale': 'Marked live, but the site did not answer with its own content in the reads below. The card stays live until '
             'the site answers again or the protocol closes it.',
    'challenge_walled': 'The site is up and serves its own content, but plain scripts get a challenge page instead. '
                        'What a client sees depends on the client.',
}
PAGE_TYPES = ('own_content', 'challenge', 'error')
STATE_PAGE = {'stale': 'error', 'challenge_walled': 'challenge'}
READ_KEYS = ('url', 'observed_at', 'http_status', 'bytes', 'page_type', 'client', 'by')
READ_OPTIONAL = ('sha256', 'note')
RECORD_KEYS = ('state', 'reads', 'note', 'credit', 'reported_via')
RECORD_OPTIONAL = ('history',)
ATLAS_READER = 'hark'
MIN_SPAN_S = 2 * 3600
UTC_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')


def load(path=DATA_FILE):
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return (json.load(f) or {}).get('cards') or {}


def _t(s):
    return datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)


def read_problems(w, r):
    if not isinstance(r, dict):
        return [f'{w}: read is not an object']
    p = [f'{w}: unknown key {k!r}' for k in r if k not in READ_KEYS + READ_OPTIONAL]
    p += [f'{w}: missing {k}' for k in READ_KEYS if k not in r]
    if p:
        return p
    if not (isinstance(r['url'], str) and r['url'].startswith('https://')):
        p.append(f'{w}: url must be https')
    if not UTC_RE.fullmatch(str(r['observed_at'])):
        p.append(f'{w}: observed_at must be YYYY-MM-DDTHH:MM:SSZ')
    for k, lo, hi in (('http_status', 100, 599), ('bytes', 0, 10 ** 9)):
        if not isinstance(r[k], int) or isinstance(r[k], bool) or not lo <= r[k] <= hi:
            p.append(f'{w}: {k} must be an integer {lo}-{hi}')
    if r['page_type'] not in PAGE_TYPES:
        p.append(f'{w}: page_type must be one of {", ".join(PAGE_TYPES)}')
    elif r['page_type'] == 'own_content' and isinstance(r['http_status'], int) and not 200 <= r['http_status'] < 300:
        p.append(f'{w}: own_content needs a 2xx answer')
    for k in ('client', 'by'):
        if not (isinstance(r[k], str) and r[k].strip()):
            p.append(f'{w}: {k} must be a non-empty string')
    if r.get('sha256') is not None and not SHA_RE.fullmatch(str(r['sha256'])):
        p.append(f'{w}: sha256 must be 64 lowercase hex characters or null')
    return p


def record_problems(slug, rec):
    w = f'reachability: {slug}'
    if not isinstance(rec, dict):
        return [f'{w}: record is not an object']
    p = [f'{w}: unknown key {k!r}' for k in rec if k not in RECORD_KEYS + RECORD_OPTIONAL]
    p += [f'{w}: missing {k}' for k in RECORD_KEYS if k not in rec]
    if p:
        return p
    if rec['state'] not in STATES:
        return [f'{w}: state must be one of {", ".join(STATES)}']
    for k in ('note', 'credit'):
        if not (isinstance(rec[k], str) and rec[k].strip()):
            p.append(f'{w}: {k} must be a non-empty string')
    if not (isinstance(rec['reported_via'], str) and rec['reported_via'].startswith('https://')):
        p.append(f'{w}: reported_via must be an https URL')
    reads = rec['reads']
    if not isinstance(reads, list) or not reads:
        return p + [f'{w}: reads must be a non-empty list']
    for i, r in enumerate(reads):
        p += read_problems(f'{w} reads[{i}]', r)
    if p:
        return p
    stamps = [r['observed_at'] for r in reads]
    if stamps != sorted(stamps):
        p.append(f'{w}: reads must be oldest first')
    want = STATE_PAGE[rec['state']]
    hits = [r for r in reads if r['page_type'] == want]
    if len(hits) < 2 or (_t(hits[-1]['observed_at']) - _t(hits[0]['observed_at'])).total_seconds() < MIN_SPAN_S:
        p.append(f'{w}: {rec["state"]} needs at least two {want} reads at least two hours apart')
    if not any(r['by'] == ATLAS_READER for r in hits):
        p.append(f'{w}: at least one {want} read must be by the Atlas ({ATLAS_READER})')
    if rec['state'] == 'stale' and any(r['page_type'] == 'own_content' for r in reads):
        p.append(f'{w}: stale, but a read got own content (that is challenge_walled or no note at all)')
    return p


def validate(cards, live_slugs, all_slugs=None):
    """-> problems for the whole file. cards: {slug: record}; live_slugs: published cards with status live."""
    p = []
    for slug, rec in sorted(cards.items()):
        if slug not in live_slugs:
            p.append(f'reachability: {slug} is not a published live card'
                     + (' (closed cards keep their closed history instead)' if all_slugs and slug in all_slugs else ''))
        p += record_problems(slug, rec)
        hist = rec.get('history', []) if isinstance(rec, dict) else []
        if not isinstance(hist, list):
            p.append(f'reachability: {slug} history must be a list')
            continue
        for i, h in enumerate(hist):
            if isinstance(h, dict) and 'history' in h:
                p.append(f'reachability: {slug} history[{i}] must not nest history')
            p += [x.replace(f'reachability: {slug}', f'reachability: {slug} history[{i}]') for x in record_problems(slug, h)]
    return p


def published(cards, slug):
    """`reachability` as the API publishes it (history stays in the data file), or None."""
    rec = cards.get(slug)
    if not rec:
        return None
    reads = [{k: r.get(k) for k in READ_KEYS + ('sha256',)} for r in rec['reads']]
    return {'state': rec['state'], 'label': STATE_LABEL[rec['state']], 'checked_at': rec['reads'][-1]['observed_at'],
            'reads': reads, 'note': rec['note'], 'credit': rec['credit'], 'reported_via': rec['reported_via']}


def sentence(pub):
    """One plain line shared by the card page and its Markdown twin."""
    n = len(pub['reads'])
    t = STATE_TEXT[pub['state']]
    return f'{STATE_LABEL[pub["state"]].capitalize()}: {t[0].lower() + t[1:]} ({n} read{"s" if n != 1 else ""}, latest {pub["checked_at"]}.)'


def read_line(r):
    h = f', sha256 {r["sha256"]}' if r.get('sha256') else ''
    return (f'{r["observed_at"]} · {r["url"]} · HTTP {r["http_status"]}, {r["bytes"]:,} bytes{h} · '
            f'{r["page_type"].replace("_", " ")} · client: {r["client"]} · read by {r["by"]}')
