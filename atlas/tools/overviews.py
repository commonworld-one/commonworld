#!/usr/bin/env python3
"""Local Atlas overview workbench. Never publishes, pushes or deploys.

migrate: preserve legacy sources and prepare all active-card drafts from an audit.
validate: check structure, optionally final content and pinned screenshot receipts.
revise: replace one overview, archive its old revision and invalidate its check.
preview: one command for local draft validation and an isolated build (no mirror).
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import overviews

DEFAULT_SNAPSHOT = ROOT / 'atlas/data/snapshot-verified-2026-10-15.json'


def read(path):
    return json.loads(Path(path).read_text())


def write(path, obj):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def migrate(snapshot, audit, base_sha):
    """An audit covering facts does NOT establish a whole-card visit or readiness."""
    by_slug = {}
    rows = list(audit['description_canonical_site_register'])
    for group in audit['registers'].values():
        rows.extend(group)
    for row in rows:
        by_slug.setdefault(row['slug'], []).append(row)
    cards = {}
    report = {'base_sha': base_sha, 'active': [], 'closed_history': [], 'missing_audit': [],
        'policy': 'Drafts only. Coverage is not PASS. No visit dates, checks or trial costs inferred.'}
    for c in snapshot['platforms']:
        s = c['slug']
        if c['status'] != 'live':
            report['closed_history'].append(s); continue
        found = by_slug.get(s, [])
        if not found:
            report['missing_audit'].append(s)
        desc = next((x for x in c.get('claims', []) if x.get('kind') == 'description'), {})
        text = c.get('description_en') or desc.get('statement') or c['name']
        urls = list(dict.fromkeys(u for u in [c.get('canonical_url'), desc.get('source_url')] if overviews.source_url(u)))
        cards[s] = {'state': 'held' if s == 'agent-knowledge-network' else 'draft',
            'text': text, 'visited_at': None, 'sources': urls, 'prepared_by': None,
            'screenshot': None, 'check': None}
        if s == 'agent-knowledge-network':
            cards[s]['editor_note'] = 'Product identity unresolved. Do not rename, redirect, merge or replace the old entity automatically.'
        statuses = {}
        for row in found:
            v = row.get('status') or row.get('bucket') or row.get('st') or 'unclassified'
            statuses[v] = statuses.get(v, 0) + 1
        report['active'].append({'slug': s, 'state': cards[s]['state'], 'audit_rows': len(found),
            'audit_status_counts': statuses, 'needs': ['whole-card editorial review', 'actual visit date',
                'screenshot correspondence and pixels', 'separate final-content check'],
            'audit_references': [{k: row[k] for k in ('claim_id', 'kind', 'status', 'bucket', 'source_url', 'url', 'note', 'detail') if k in row} for row in found]})
    return {'format': overviews.VERSION, 'base_sha': base_sha, 'cards': cards}, report


def revise(doc, slug, replacement):
    if slug not in doc['cards']:
        raise ValueError('unknown permanent slug')
    old = doc['cards'][slug]
    new = copy.deepcopy(replacement)
    history = copy.deepcopy(old.get('history', []))
    history.append({k: copy.deepcopy(v) for k, v in old.items() if k != 'history'})
    new['history'] = history
    new['state'] = 'draft'
    new['check'] = None
    doc['cards'][slug] = new
    return doc


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['migrate', 'validate', 'revise', 'preview', 'bundle', 'verify-bundle'])
    p.add_argument('--snapshot', default=str(DEFAULT_SNAPSHOT))
    p.add_argument('--file', required=True, help='local overview source JSON')
    p.add_argument('--audit')
    p.add_argument('--report')
    p.add_argument('--base-sha')
    p.add_argument('--slug')
    p.add_argument('--replacement')
    p.add_argument('--screens-dir', help='local directory with manifest.json and reviewed or draft image pixels')
    p.add_argument('--only', help='comma-separated permanent slugs for a handoff batch')
    p.add_argument('--screens-manifest')
    p.add_argument('--selection', help='explicit accepted batch JSON with slugs; exact coverage required')
    p.add_argument('--publishable', action='store_true')
    p.add_argument('--out', default=str(ROOT / 'atlas/site/dist'))
    a = p.parse_args()
    if a.action == 'verify-bundle':
        import overview_bundle
        bad = overview_bundle.verify(a.file)
        if bad:
            raise SystemExit('\n'.join(bad))
        print('Bundle integrity verified. Content review and publication are NOT asserted.')
        return
    if a.action == 'bundle':
        if not a.screens_dir:
            p.error('bundle requires --screens-dir; --out is a new handoff directory')
        import overview_bundle
        report = overview_bundle.make(a.file, a.snapshot, a.screens_dir, a.out,
            a.only.split(',') if a.only else None)
        print(json.dumps(report, indent=2))
        return
    snapshot = read(a.snapshot)
    if a.action == 'migrate':
        if not all((a.audit, a.report, a.base_sha)):
            p.error('migrate needs --audit, --report and --base-sha')
        if Path(a.file).exists() or Path(a.report).exists():
            p.error('refusing to overwrite migration work; choose new output paths')
        doc, report = migrate(snapshot, read(a.audit), a.base_sha)
        bad = overviews.problems(doc, snapshot['platforms'])
        if bad:
            raise SystemExit('\n'.join(bad))
        write(a.file, doc); write(a.report, report)
        print(f"Prepared {len(doc['cards'])} drafts; {len(report['closed_history'])} closed entries unchanged; {len(report['missing_audit'])} missing audit rows. No new visit/check dates.")
        return
    doc = read(a.file)
    if a.action == 'revise':
        if not a.slug or not a.replacement:
            p.error('revise needs --slug and --replacement')
        doc = revise(doc, a.slug, read(a.replacement))
    shots = read(a.screens_manifest).get('screens', {}) if a.screens_manifest else None
    bad = overviews.problems(doc, snapshot['platforms'], shots, a.publishable, complete=not a.publishable)
    if a.publishable:
        selection = read(a.selection).get('slugs') if a.selection else None
        if not selection or not isinstance(selection, list) or len(selection) != len(set(selection)) or set(selection) != set(doc['cards']):
            bad.append('accepted validation requires --selection with exactly the overview batch IDs')
    if bad:
        raise SystemExit('\n'.join(bad))
    if a.action == 'revise':
        write(a.file, doc)
    print(f"Structure valid: {len(doc['cards'])} overviews. Release readiness is {'required and passed' if a.publishable else 'NOT asserted'}.")
    if a.action == 'preview':
        if a.publishable:
            p.error('preview does not publish; use validate --publishable for readiness')
        subprocess.run([sys.executable, str(ROOT / 'atlas/site/build.py'), '--data', a.snapshot,
            '--overviews', a.file, '--draft-preview', '--no-mirror', '--out', a.out, '--local'], check=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        print('Overview workbench: ' + str(exc), file=sys.stderr)
        raise SystemExit(1)
