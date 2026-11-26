#!/usr/bin/env python3
"""Atlas link safety through the Commonworld trust engine (trust/, TRUST.md). Stdlib only; needs Node 22.6+ for the engine.

    python3 atlas/tools/link_safety.py            # check every linked domain, write atlas/data/link-safety.json
    python3 atlas/tools/link_safety.py --apply    # ... and remove the entries of every flagged domain (the rule below)
    python3 atlas/tools/link_safety.py --report-in r.json   # use an engine report you already have (tests, re-runs)

1. The hosts to check go to the engine, which asks every source (Google Safe Browsing, MetaMask eth-phishing-detect,
   ScamSniffer, CERT Polska) and combines the answers: flagged when ANY one source flags the domain, clean when at
   least one source answered and none flags it, no_data when no source could answer. Which hosts:
   - with --catalogue-dir (what the daily workflow runs): the host of each live (not closed) card's official URL, plus the
     links in its current overview, plus the hosts of removed entries. Closed-history records and
     older source material (compat-export claims and QA, notes, cards v2 curation files, reachability reads) are not
     checked and never decide a removal.
   - without it (older snapshot mode, not used by the workflow): every host linked from the live cards of the snapshot and
     from their cards v2 curation records.
2. A source that could not answer for a host this run keeps its previous answer for that host (marked stale), so a
   network error never hides an earlier flag.
3. atlas/data/link-safety.json gets the summary, the per-source answers for every host (verdict, checked_at, evidence
   link) and, for Google Safe Browsing, its code and threat names. The site build publishes it as /atlas/safety.json.
4. With --apply, the rule (atlas/CURATION.md#link-safety): every entry that links to a flagged host is removed at once,
   with a decision in atlas/data/removed.json (actor hark, reason naming the source and what it said, evidence link),
   its card dropped from the snapshot, the census tags and the cards v2 curation files (first-tasks.json,
   keys-and-books.json, evidence-levels.json, and replications.json, in the snapshot's directory; the old records stay in git history for a
   restore), so the rebuild check does not fail on curation of a card that is no longer published. The slug keeps a noindex stub page (build.py). Hosts listed in
   atlas/data/trust-hold.json `hold` are reported but not removed (a curator is looking at them).
   --actions-out writes what was removed (for the issue text).

Exit code 1 when a published host is flagged (removed or held), 0 otherwise, 2 when the engine could not run.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import safebrowsing_check as sb  # noqa: E402  (host extraction is shared with the older single-source check)

ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
DATA = os.path.join(ROOT, 'atlas', 'data')
CLI = os.path.join(ROOT, 'trust', 'src', 'cli.ts')
REPORT_NAME = 'Commonworld Atlas link safety report'
TRUST_URL = 'https://github.com/commonworld-one/commonworld/blob/main/TRUST.md'
GSB = 'google_safe_browsing'


# slug-keyed card files (cards v2 curation, atlas/site/cards_v2.py; replication counts, atlas/site/replications.py):
# file name -> top-level key holding {slug: record}
CURATION = (('first-tasks.json', 'tasks'), ('keys-and-books.json', 'entries'), ('evidence-levels.json', 'overrides'),
            ('replications.json', 'cards'))
URL_IN_TEXT = sb.URL_IN_TEXT  # one URL pattern for the snapshot and the curation files


def curation_files(data_dir):
    return [(os.path.join(data_dir, f), k) for f, k in CURATION]


def _write_json(path, doc, ascii_=False):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(doc, ensure_ascii=ascii_, indent=1) + '\n')


def _texts(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _texts(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _texts(v)


def curation_hosts(slugs, files):
    """host -> set of slugs, for every URL (whole value or inside a text) in the curation records of the given slugs."""
    out = {}
    for path, key in files:
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as fh:
            recs = json.load(fh).get(key) or {}
        for slug, rec in recs.items():
            if slug not in slugs:
                continue
            for t in _texts(rec):
                for u in URL_IN_TEXT.findall(t):
                    h = sb.norm_host(u.rstrip('.,;:!?'))
                    if h and '.' in h and h not in sb.OWN_HOSTS:
                        out.setdefault(h, set()).add(slug)
    return out


def linked_hosts(snap, files):
    """host -> sorted slugs: the snapshot's own links plus the cards v2 curation links of its published cards."""
    active = dict(snap, platforms=[c for c in snap.get('platforms') or [] if c.get('status') != 'closed'])
    out = {h: set(v) for h, v in sb.extract_hosts(active).items()}
    for h, v in curation_hosts({c.get('slug') for c in active['platforms']}, files).items():
        out.setdefault(h, set()).update(v)
    return {h: sorted(v) for h, v in sorted(out.items())}


def catalogue_hosts(catalogue, snap, files):
    """Hosts the current catalogue links to: each card's primary URL and its current overview links.
    Everything older (compat-export claims/qa/notes/..., curation files, reachability reads) stays as history and never
    decides an exclusion here. `files` is kept for the call signature of the legacy path."""
    directory = Path(catalogue)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'site'))
    from catalogue_safety import current_links
    from current_catalogue import project_snapshot, new_overviews
    snap = project_snapshot(snap, directory)
    out = {}
    closed = {c['slug'] for c in snap['platforms'] if c.get('status') == 'closed'}
    for c in snap['platforms']:
        if c['slug'] in closed:
            continue
        for h in sb.hosts_of_entry({'canonical_url': c.get('canonical_url')}):
            out.setdefault(h, set()).add(c['slug'])
    known = {c['slug'] for c in snap['platforms']}
    for name in ('overviews.json',):
        document = json.loads((directory / name).read_text())
        if name == 'overviews.json': document = new_overviews(document, directory)
        records = document['cards']
        if set(records) - known:
            raise ValueError('current-link source contains unknown catalogue IDs')
        for slug, record in records.items():
            if slug in closed:
                continue
            for h in sb.hosts_of_entry(current_links(record)):
                out.setdefault(h, set()).add(slug)
    return {h: sorted(v) for h, v in sorted(out.items())}


def prune_curation(gone, files):
    """Drop the records of removed slugs from every curation file. Returns the names of the files that changed."""
    changed = []
    for path, key in files:
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as fh:
            raw = fh.read()
        doc = json.loads(raw)
        recs = doc.get(key)
        if not isinstance(recs, dict) or not (gone & set(recs)):
            continue
        doc[key] = {k: v for k, v in recs.items() if k not in gone}
        _write_json(path, doc, ascii_=raw.isascii() and '\\u' in raw)
        changed.append(os.path.basename(path))
    return changed


def utc_now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def run_engine(hosts):
    node = shutil.which('node')
    if not node:
        raise SystemExit('link safety: node (22.6+) is required for the trust engine')
    with tempfile.TemporaryDirectory() as td:
        inp, out = os.path.join(td, 'hosts.txt'), os.path.join(td, 'report.json')
        open(inp, 'w').write('\n'.join(hosts) + '\n')
        p = subprocess.run([node, '--experimental-strip-types', '--no-warnings', CLI, '--domains-file', inp, '--out', out],
                           capture_output=True, text=True, timeout=1800)
        sys.stderr.write(p.stderr)
        if p.returncode not in (0, 1) or not os.path.exists(out):
            print(f'link safety: trust engine failed (exit {p.returncode})', file=sys.stderr)
            raise SystemExit(2)
        return json.load(open(out, encoding='utf-8'))


def merge_host(res, prev):
    """Engine result for one host + the host's previous record -> new record. A source that errored keeps its previous answer."""
    old = {s.get('name'): s for s in (prev or {}).get('sources') or []}
    srcs = []
    for s in res['sources']:
        o = old.get(s['name'])
        if s.get('error') and o and o.get('verdict') in ('clean', 'flagged'):
            s = dict(o, stale=True, error=s['error'])
        srcs.append(s)
    if any(s['verdict'] == 'flagged' for s in srcs): status = 'flagged'
    elif any(s['verdict'] == 'clean' for s in srcs): status = 'clean'
    else: status = 'no_data'
    rec = {'status': status,
           'checked_at': max((s.get('checked_at') for s in srcs if s.get('checked_at') and not s.get('stale')), default=(prev or {}).get('checked_at')),
           'flagged_by': [s['name'] for s in srcs if s['verdict'] == 'flagged'],
           'sources': srcs}
    if any(s.get('error') for s in srcs):
        rec['error'] = '; '.join(f"{s['name']}: {s['error']}" for s in srcs if s.get('error'))
    return rec


def flag_reason(rec, sources_meta):
    names = {m['id']: m['name'] for m in sources_meta}
    parts = []
    for s in rec['sources']:
        if s['verdict'] == 'flagged':
            # a detail that names a domain ("listed as x.example") stays out: the decision log never prints a removed host as text
            det = s.get('detail') if s.get('detail') and '.' not in s['detail'] else ('listed' if s.get('detail') else '')
            parts.append(f"{names.get(s['name'], s['name'])} flagged the domain" + (f" ({det})" if det else ''))
    return '; '.join(parts) or 'flagged'


def build_report(linked, removed_hosts, eng, prev_doc):
    prev = (prev_doc.get('hosts') or {}) | (prev_doc.get('removed_hosts') or {})
    res = eng['results']
    def rec(h):
        r = res.get(h) or {'sources': [{'name': m['id'], 'verdict': 'no_data', 'checked_at': None, 'evidence_url': m['url'], 'error': 'not checked'} for m in eng['sources']]}
        return merge_host(r, prev.get(h))
    pub = {h: rec(h) | {'entries': linked[h]} for h in linked}
    rem = {h: rec(h) for h in removed_hosts}
    count = lambda st: sum(1 for r in pub.values() if r['status'] == st)
    return {
        'name': REPORT_NAME,
        'engine': eng.get('engine'), 'engine_version': eng.get('engine_version'), 'standard': TRUST_URL,
        'sources': eng['sources'],
        'rule': 'A domain is flagged when ANY one source flags it; every live Atlas entry that links to a flagged domain gets a removal decision '
                '(who, reason, evidence) in the repository; the live site changes with the next release. clean = at least one source answered and none flags it; no_data = no source could answer.',
        'method': 'Each day the Commonworld trust engine checks the hosts of the current catalogue against every source listed under sources: the official URL of each live card, '
                  'the links in its current overview, and the hosts of removed entries. Closed-history records and older source material '
                  '(claims, QA, notes, curation, reachability) are not checked. Each host carries the answer of each source (verdict, checked_at, evidence_url).',
        'run_started_at': eng.get('run_started_at'), 'run_at': eng.get('run_at') or utc_now(),
        'summary': {'hosts': len(pub), 'clean': count('clean'), 'flagged': count('flagged'), 'no_data': count('no_data'),
                    'query_errors': sum(1 for r in pub.values() if r.get('error'))},
        'flagged': sorted(h for h, r in pub.items() if r['status'] == 'flagged'),
        'hosts': pub,
        'removed_hosts': rem,
    }


def apply_removals(report, snap_path, removed_path, tags_path, hold, today, curation=(), preserve_inputs=False):
    """Remove every entry linking to a flagged, not-held host. Returns the list of actions."""
    snap = json.load(open(snap_path, encoding='utf-8'))
    removed_doc = json.load(open(removed_path, encoding='utf-8'))
    tags = json.load(open(tags_path, encoding='utf-8')) if tags_path and os.path.exists(tags_path) else None
    have = {r['slug'] for r in removed_doc.get('removed') or []}
    projected = snap
    if preserve_inputs:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'site'))
        from current_catalogue import project_snapshot
        projected = project_snapshot(snap, Path(snap_path).parent)
    closed = {c['slug'] for c in projected.get('platforms', []) if c.get('status') == 'closed'}
    actions = []
    for h in report['flagged']:
        if h in hold:
            continue
        r = report['hosts'][h]
        ev = next((s['evidence_url'] for s in r['sources'] if s['verdict'] == 'flagged'), None) or report['standard']
        reason = flag_reason(r, report['sources'])
        for slug in r['entries']:
            if slug in have or slug in closed:
                continue
            removed_doc.setdefault('removed', []).append({'slug': slug, 'host': h, 'removed_on': today, 'reason': '+'.join(r['flagged_by']) or 'flagged'})
            removed_doc.setdefault('decisions', []).append({'action': 'remove', 'slug': slug, 'host': h, 'by': 'hark', 'on': today,
                                                            'reason': reason, 'evidence': ev})
            have.add(slug)
            actions.append({'slug': slug, 'host': h, 'reason': reason, 'evidence': ev, 'flagged_by': r['flagged_by']})
    if not actions:
        return actions
    gone = {a['slug'] for a in actions}
    snap['platforms'] = [c for c in snap.get('platforms') or [] if c.get('slug') not in gone]
    snap['count'] = len(snap['platforms'])
    if not preserve_inputs:
        with open(snap_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(snap, ensure_ascii=False, indent=1) + '\n')
    with open(removed_path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(removed_doc, ensure_ascii=False, indent=1) + '\n')
    if not preserve_inputs and tags is not None and isinstance(tags.get('tags'), dict):
        for s_ in gone:
            tags['tags'].pop(s_, None)
        with open(tags_path, 'w', encoding='utf-8') as f:
            f.write(json.dumps(tags, ensure_ascii=False, indent=1) + '\n')
    pruned = [] if preserve_inputs else prune_curation(gone, curation)
    for a_ in actions:
        a_['curation_pruned'] = pruned
    # the removed entries' hosts are no longer published: move them under removed_hosts
    for hh, rr in list(report['hosts'].items()):
        rr['entries'] = [x for x in rr['entries'] if x not in gone]
        if not rr['entries']:
            report['removed_hosts'][hh] = {k: v for k, v in report['hosts'].pop(hh).items() if k != 'entries'}
    report['flagged'] = sorted(x for x in report['flagged'] if x in report['hosts'])
    pub = report['hosts']
    report['summary'].update(hosts=len(pub), **{st: sum(1 for r in pub.values() if r['status'] == st) for st in ('clean', 'flagged', 'no_data')})
    return actions


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--catalogue-dir', help='current catalogue directory; safety removals are an overlay, source inputs stay unchanged')
    ap.add_argument('--data', default=None, help='snapshot-verified-*.json (default: newest in atlas/data/)')
    ap.add_argument('--removed', default=os.path.join(DATA, 'removed.json'))
    ap.add_argument('--tags', default=os.path.join(DATA, 'census-tags-2026-10-15.json'))
    ap.add_argument('--hold', default=os.path.join(DATA, 'trust-hold.json'))
    ap.add_argument('--out', default=os.path.join(DATA, 'link-safety.json'))
    ap.add_argument('--curation-dir', default=None, help='directory of the cards v2 curation files (default: the snapshot\'s)')
    ap.add_argument('--report-in', default=None, help='engine report to use instead of running the engine')
    ap.add_argument('--apply', action='store_true', help='remove the entries of flagged hosts (the link safety rule)')
    ap.add_argument('--actions-out', default=None, help='write the removals of this run as JSON')
    a = ap.parse_args(argv)

    snap_path = a.data or (os.path.join(a.catalogue_dir, 'snapshot.json') if a.catalogue_dir else sb.snapshot_path())
    curation = curation_files(a.curation_dir or (DATA if a.catalogue_dir else os.path.dirname(os.path.abspath(snap_path))))
    snap = json.load(open(snap_path, encoding='utf-8'))
    linked = catalogue_hosts(a.catalogue_dir, snap, curation) if a.catalogue_dir else linked_hosts(snap, curation)
    # Previously removed records remain stored but never count as currently published.
    gone = {r['slug'] for r in (json.load(open(a.removed)).get('removed') or [])} if os.path.exists(a.removed) else set()
    linked = {h: [s for s in slugs if s not in gone] for h, slugs in linked.items() if set(slugs) - gone}
    removed = (json.load(open(a.removed)).get('removed') or []) if os.path.exists(a.removed) else []
    removed_hosts = sorted({sb.norm_host('https://' + r['host']) for r in removed if r.get('host')} - set(linked))
    prev_doc = {}
    if os.path.exists(a.out):
        try: prev_doc = json.load(open(a.out, encoding='utf-8'))
        except (ValueError, OSError): prev_doc = {}
    eng = json.load(open(a.report_in, encoding='utf-8')) if a.report_in else run_engine(list(linked) + removed_hosts)
    report = build_report(linked, removed_hosts, eng, prev_doc)
    hold = set((json.load(open(a.hold)).get('hold') or []) if os.path.exists(a.hold) else [])
    flagged_before = list(report['flagged'])
    actions = apply_removals(report, snap_path, a.removed, a.tags, hold, report['run_at'][:10], curation, preserve_inputs=bool(a.catalogue_dir)) if a.apply else []
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, 'w', encoding='utf-8') as f:
        f.write(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    if a.actions_out:
        held = [h for h in flagged_before if h in hold]
        json.dump({'run_at': report['run_at'], 'removed': actions, 'held': held,
                   'flagged': {h: {'reason': flag_reason(r, report['sources']), 'entries': r.get('entries', []),
                                   'evidence': [s['evidence_url'] for s in r['sources'] if s['verdict'] == 'flagged']}
                               for h, r in ((h, (report['hosts'].get(h) or report['removed_hosts'].get(h))) for h in flagged_before)}},
                  open(a.actions_out, 'w'), indent=1)
    s = report['summary']
    print(f"link safety: {s['hosts']} hosts ({len(report['sources'])} sources): {s['clean']} clean, {s['flagged']} flagged, {s['no_data']} no data, "
          f"{s['query_errors']} with source errors -> {a.out}")
    for h, r in report['removed_hosts'].items():
        print(f"removed entry host {h}: {r['status']}" + (f" ({', '.join(r['flagged_by'])})" if r['flagged_by'] else ''))
    for x in actions:
        print(f"REMOVED {x['slug']} ({x['host']}): {x['reason']}")
    if flagged_before:
        for h in flagged_before:
            r = report['hosts'].get(h) or report['removed_hosts'].get(h)
            print(f"FLAGGED {h}: {flag_reason(r, report['sources'])}" + (' [held for curator review]' if h in hold else ''))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
