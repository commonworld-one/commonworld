"""Atlas events log (stdlib only).

atlas/data/events.jsonl is the public, append-only log of card changes: one JSON object per line,

    {"date": "YYYY-MM-DD", "slug": "<entry id>", "type": "added|closed|reopened|corrected|relabelled",
     "reason": "<short reason>", "source": "https://<the page the change was checked on>"}

build.py publishes it as /atlas/events.json (newest first) and /atlas/events.md; check.py validates every line, that the
published files match it, and that every curated amendment in the snapshot from START on has its events (an added slug has an
`added` event, a changed entry has a non-`added` event, refresh.py's died/revived have `closed`/`reopened`). Automated number
refreshes (refresh.py `number_updates`) and link-safety removals (their own decision log) are not card events.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
FILE = os.path.normpath(os.path.join(HERE, '..', 'data', 'events.jsonl'))
JSON_PATH = '/atlas/events.json'
MD_PATH = '/atlas/events.md'
START = '2026-10-19'  # first day of the log; amendments before it are summarised in atlas/CHANGELOG.md only
TYPES = ('added', 'closed', 'reopened', 'corrected', 'relabelled')
FIELDS = ('date', 'slug', 'type', 'reason', 'source')
DATE = re.compile(r'\d{4}-\d{2}-\d{2}')
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,80}')
MAX_REASON = 300
LEAD = ('Recorded editorial card changes: event date, permanent entry ID, change type, reason and supporting source. '
        'The 25 November 2026 migration was backfilled from repository records; its events do not claim new source visits or trials. '
        'Earlier rows retain their original scope. Build time is not event time.')


def load(path=FILE):
    """Lines in file order (oldest first). Raises ValueError on a line that is not a JSON object."""
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding='utf-8') as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
            except ValueError as ex:
                raise ValueError(f'events.jsonl line {n}: not JSON ({ex})')
            if not isinstance(ev, dict):
                raise ValueError(f'events.jsonl line {n}: not a JSON object')
            out.append(ev)
    return out


def validate(events, slugs=None):
    """Schema + order errors. slugs: every entry ID that exists (published or removed stub)."""
    errs, prev = [], ''
    for n, ev in enumerate(events, 1):
        w = f'events.jsonl #{n}'
        if tuple(ev) != FIELDS:
            errs.append(f'{w}: fields must be exactly {", ".join(FIELDS)} in that order (got {", ".join(ev)})')
            continue
        d, s, t, r, u = (ev[k] for k in FIELDS)
        if not (isinstance(d, str) and DATE.fullmatch(d)): errs.append(f'{w}: date {d!r} is not YYYY-MM-DD')
        elif d < prev: errs.append(f'{w}: date {d} is older than the line before ({prev}); the log is append-only')
        else: prev = d
        if not (isinstance(s, str) and SLUG.fullmatch(s)): errs.append(f'{w}: slug {s!r} invalid')
        elif slugs is not None and s not in slugs: errs.append(f'{w}: slug {s} is not an Atlas entry')
        if t not in TYPES: errs.append(f'{w}: type {t!r} not one of {", ".join(TYPES)}')
        if not (isinstance(r, str) and r.strip() and len(r) <= MAX_REASON and '\n' not in r): errs.append(f'{w}: reason empty, multi-line or over {MAX_REASON} chars')
        if not (isinstance(u, str) and u.startswith('https://') and ' ' not in u): errs.append(f'{w}: source {u!r} is not an https URL')
    seen = set()
    for ev in events:
        k = tuple(ev.get(x) for x in ('date', 'slug', 'type', 'reason'))
        if k in seen: errs.append(f'events.jsonl: duplicate event {k[:3]}')
        seen.add(k)
    return errs


def amendment_gaps(amendments, events, start=START):
    """Curated card changes (snapshot `amendments` from `start` on) that have no matching event."""
    have = {(e.get('date'), e.get('slug'), e.get('type')) for e in events}
    any_change = {(e.get('date'), e.get('slug')) for e in events if e.get('type') != 'added'}
    gaps = []
    for a in amendments:
        d = a.get('date') or ''
        if d < start:
            continue
        tag = a.get('tag') or d
        for s in a.get('added') or []:
            if (d, s, 'added') not in have: gaps.append(f'{tag}: {s} added without an "added" event on {d}')
        for s in a.get('died') or []:
            if (d, s, 'closed') not in have: gaps.append(f'{tag}: {s} closed by refresh without a "closed" event on {d}')
        for s in a.get('revived') or []:
            if (d, s, 'reopened') not in have: gaps.append(f'{tag}: {s} revived by refresh without a "reopened" event on {d}')
        for s in a.get('entries') or []:
            if s in (a.get('added') or []):
                continue
            if (d, s) not in any_change: gaps.append(f'{tag}: {s} changed without an event on {d}')
    return gaps


def current_layer_gaps(catalogue, events, current_records):
    """Revision-bound editorial coverage. The baseline is explicit, never inferred from build time."""
    import hashlib
    from pathlib import Path
    cat = Path(catalogue)
    try:
        ledger = json.loads((cat / 'event-coverage.json').read_text())
        closures = json.loads((cat / 'closures.json').read_text())
        additions = json.loads((cat / 'additions.json').read_text())
        revisions = json.loads((cat / 'current-revisions.json').read_text())
    except (OSError, ValueError) as ex:
        return ['current event coverage missing or invalid: ' + str(ex)]
    have = {(e.get('date'), e.get('slug'), e.get('type')) for e in events}
    errors = []
    def covered(group, slug, field, value):
        row = ledger.get(group, {}).get(slug, {})
        if row.get(field) != value:
            errors.append(slug + ': current ' + group + ' event coverage is stale or missing')
        if (row.get('date'), slug, row.get('type')) not in have:
            errors.append(slug + ': current ' + group + ' event is missing')
    for record in current_records:
        covered('current', record['id'], 'revision', record.get('overview', {}).get('revision'))
    for slug in closures.get('ids', []):
        covered('closed', slug, 'recorded_on', closures.get('recorded_on'))
    for group, values in [('additions', {r['slug']: r for r in additions.get('platforms', [])}), ('revisions', revisions.get('cards', {}))]:
        for slug, record in values.items():
            digest = hashlib.sha256(json.dumps(record, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            covered(group, slug, 'sha256', digest)
    return errors


def newest_first(events):
    return [e for _, e in sorted(enumerate(events), key=lambda x: (x[1].get('date') or '', x[0]), reverse=True)]


def publication_events(site, events):
    if not getattr(site, 'catalogue_mode', False): return events
    from closed_archive import inert
    closed = {c['slug'] for c in getattr(site, 'all_cards', site.cards) if c.get('status') == 'closed'}
    return [inert(e) if e.get('slug') in closed else e for e in events]


def doc(site, events, generated_at):
    return {'name': 'Commonworld Atlas events log', 'url': site.abs(JSON_PATH), 'markdown': site.abs(MD_PATH),
            'source': 'https://github.com/commonworld-one/commonworld/blob/main/atlas/data/events.jsonl',
            'generated_at': generated_at, 'licence': site.cfg.get('data_licence') or 'not yet specified',
            'coverage': {'migration_backfill': '2026-11-25', 'event_dates_are_not_build_dates': True}, 'about': LEAD, 'types': list(TYPES), 'count': len(events), 'events': [dict(e) for e in newest_first(publication_events(site, events))]}


def markdown(site, events):
    A = site.abs
    cell = lambda v: str(v or '').replace('|', '\\|').replace('\n', ' ')
    L = ['# Atlas events log', '', f'> {LEAD}', '',
         f'JSON: {A(JSON_PATH)} · Source file: https://github.com/commonworld-one/commonworld/blob/main/atlas/data/events.jsonl · '
         f'How the Atlas works: {A(site.base + "/about/")}', '',
         'Newest first. Automated weekly number refreshes are not listed here; link-safety removals have their own '
         f'decision log ({A("/atlas/decisions/")}).', '']
    if events:
        L += ['| Date | Entry ID | Event | Reason | Source |', '|---|---|---|---|---|']
        for e in newest_first(publication_events(site, events)):
            L.append(f"| {cell(e['date'])} | [`{cell(e['slug'])}`]({A(site.base + '/platforms/' + e['slug'] + '/')}) | {cell(e['type'])} | "
                     f"{cell(e['reason'])} | <{e['source']}> |")
    else:
        L.append('No events recorded yet.')
    return '\n'.join(L) + '\n'


def append(path, date, slug, typ, reason, source):
    """Append one event line (used by refresh.py and by curators' scripts)."""
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'date': date, 'slug': slug, 'type': typ, 'reason': reason, 'source': source}, ensure_ascii=False) + '\n')
