"""Replication counts on a card (atlas/site/replications.py, atlas/refresh.py step 5, atlas/data/replications.json)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
sys.path.insert(0, str(ROOT / 'atlas'))
import replications as R  # noqa: E402
import refresh  # noqa: E402

SHA = '919465f08748a2dfa4612406f441cc6e0332cf60'
SHA2 = 'a539b57115771c0ae38456ca3aba3be71e73ff2f'
REPO = 'piiiico/agent-errata'
VALIDATE_TS = 'const ROW_KEYS = [];\nconst OPERATOR = "op";\nconst table = [];\n'


def entry(eid, found_by):
    return f'---\nid: {eid}\ntitle: t\nfound_by: {found_by}\ndate: 2026-10-01\n---\n## Replication 0\n'


def row(eid, agent, result='reproduces'):
    return json.dumps({'entry': eid, 'result': result, 'agent': agent, 'observed_defect': 'd', 'observed_control': 'c',
                       'stack': 's', 'date': '2026-10-01'})


def files():
    entries = {'E001.md': entry('E001', 'op'), 'E002.md': entry('E002', 'finder'), 'E003.md': entry('E003', '"a, b"'),
               'E004.md': entry('E004', 'op')}
    rows = {
        # E001: operator's replication 0, two independent agents (one twice), one does-not-reproduce
        'E001.jsonl': '\n'.join([row('E001', 'op'), row('E001', 'x'), row('E001', 'y'), row('E001', 'x'),
                                 row('E001', 'z', 'does-not-reproduce'), '']),
        # E002: the finder's own run and the operator's run are not independent; x again (counted once overall)
        'E002.jsonl': '\n'.join([row('E002', 'finder'), row('E002', 'op'), '', row('E002', 'x')]),
        # E003: found_by "a, b" is one string for validate.ts (r.agent !== e.found_by), so agent "a" counts as independent
        'E003.jsonl': '\n'.join([row('E003', 'op'), row('E003', 'a')]),
        # E004: only not-applicable from others: not replicated
        'E004.jsonl': '\n'.join([row('E004', 'op'), row('E004', 'w', 'not-applicable')]),
    }
    return entries, rows


def record(**kw):
    r = {'rows': 13, 'entries': 4, 'entries_replicated': 3, 'independent_agents': 4, 'format': 'agent-errata', 'repo': REPO,
         'commit': SHA, 'source_url': f'https://github.com/{REPO}/tree/{SHA}/replications',
         'method_url': f'https://github.com/{REPO}/blob/{SHA}/scripts/validate.ts',
         'validate_run_url': f'https://github.com/{REPO}/actions/runs/39508705693', 'observed_at': '2026-10-20T22:53:26Z'}
    r.update(kw)
    return r


class Counting(unittest.TestCase):
    """count_agent_errata mirrors scripts/validate.ts: the ok line (entries, replication rows) and the standing table
    (distinct agents with result reproduces, the entry's finder and OPERATOR excluded)."""
    def test_counts_follow_validate_ts(self):
        e, r = files()
        self.assertEqual(R.count_agent_errata(e, r, VALIDATE_TS),
                         {'rows': 12, 'entries': 4, 'entries_replicated': 3, 'independent_agents': 3})  # x, y, a; never z, w, op or finder

    def test_independent_agents_are_distinct_across_entries(self):
        e, r = files()
        r['E002.jsonl'] += '\n' + row('E002', 'y')
        got = R.count_agent_errata(e, r, VALIDATE_TS)
        self.assertEqual((got['independent_agents'], got['rows']), (3, 13))  # y reproduced E002 too, but is counted once

    def test_entry_without_jsonl_fails_closed(self):
        # validate.ts: rowsByEntry.get(id) ?? [] has no "reproduces" row -> "needs a replication-0 row that reproduces"
        e, r = files()
        e['E005.md'] = entry('E005', 'op')
        with self.assertRaises(R.FormatError):
            R.count_agent_errata(e, r, VALIDATE_TS)
        r['E005.jsonl'] = '\n'  # file present but no rows
        with self.assertRaises(R.FormatError):
            R.count_agent_errata(e, r, VALIDATE_TS)

    def test_entry_without_reproduces_row_fails_closed(self):
        e, r = files()
        e['E005.md'] = entry('E005', 'finder')
        r['E005.jsonl'] = '\n'.join([row('E005', 'x', 'does-not-reproduce'), row('E005', 'y', 'not-applicable')])
        with self.assertRaises(R.FormatError):
            R.count_agent_errata(e, r, VALIDATE_TS)

    def test_replication_zero_by_finder_or_operator_satisfies_the_rule(self):
        # validate.ts counts any agent's "reproduces" row as replication 0; it is not an independent reproduction
        e, r = files()
        e['E005.md'], r['E005.jsonl'] = entry('E005', 'finder'), row('E005', 'finder')
        e['E006.md'], r['E006.jsonl'] = entry('E006', 'finder'), row('E006', 'op')
        got = R.count_agent_errata(e, r, VALIDATE_TS)
        self.assertEqual((got['entries'], got['entries_replicated'], got['rows'], got['independent_agents']), (6, 3, 14, 3))

    def test_operator_is_read_from_validate_ts(self):
        e, r = files()
        got = R.count_agent_errata(e, r, VALIDATE_TS.replace('"op"', '"x"'))
        # with x as operator, "op" becomes independent on E002/E003/E004 (it is the finder of E001 and E004 only)
        self.assertEqual(got['independent_agents'], len({'y', 'op', 'a'}))

    def test_unexpected_shapes_fail_closed(self):
        e, r = files()
        bad = [
            (dict(e), dict(r), 'no OPERATOR', VALIDATE_TS.replace('const OPERATOR', 'let OPERATOR')),
            (dict(e), dict(r), 'two OPERATOR lines', VALIDATE_TS + 'const OPERATOR = "z";\n'),
            (dict(e, **{'E001.md': '---\nid: E001\nfound_by: |\n  op\n---\n'}), dict(r), 'block scalar', VALIDATE_TS),
            (dict(e, **{'E001.md': 'id: E001\n'}), dict(r), 'no front matter', VALIDATE_TS),
            (dict(e, **{'E001.md': '---\nid: E001\n---\n'}), dict(r), 'no found_by', VALIDATE_TS),
            (dict(e), dict(r, **{'E009.jsonl': row('E009', 'x')}), 'rows without entry', VALIDATE_TS),
            (dict(e), dict(r, **{'E001.jsonl': '{not json'}), 'bad JSON', VALIDATE_TS),
            (dict(e), dict(r, **{'E001.jsonl': '[1]'}), 'not an object', VALIDATE_TS),
            (dict(e, **{'readme.md': 'x'}), dict(r), 'bad entry file name', VALIDATE_TS),
            ({}, {}, 'no entries', VALIDATE_TS),
        ]
        for ee, rr, why, ts in bad:
            with self.assertRaises(R.FormatError, msg=why):
                R.count_agent_errata(ee, rr, ts)

    def test_quoted_found_by(self):
        self.assertEqual(R.front_matter_value("---\nfound_by: 'x y'\n---\n", 'found_by'), 'x y')
        self.assertEqual(R.front_matter_value('---\nfound_by: Blockchain-365, AgentVitals\n---\n', 'found_by'), 'Blockchain-365, AgentVitals')


class DataFile(unittest.TestCase):
    def test_good_record_and_published_shape(self):
        self.assertEqual(R.validate({'agent-errata': record()}, {'agent-errata'}), [])
        pub = R.published({'agent-errata': record(history=[record(rows=12, observed_at='2026-10-10T00:00:00Z')])}, 'agent-errata')
        self.assertEqual(list(pub), list(R.RECORD_KEYS) + ['confirmed_at'])
        self.assertIsNone(pub['confirmed_at'])
        self.assertIsNone(R.published({}, 'agent-errata'))

    def test_bad_records(self):
        bad = {
            'unknown slug': ({'nope': record()}, None),
            'unknown key': ({'agent-errata': record(extra=1)}, None),
            'missing key': ({'agent-errata': {k: v for k, v in record().items() if k != 'commit'}}, None),
            'negative': ({'agent-errata': record(rows=-1)}, None),
            'bool': ({'agent-errata': record(rows=True)}, None),
            'replicated > entries': ({'agent-errata': record(entries_replicated=5)}, None),
            'agents without entries': ({'agent-errata': record(entries_replicated=0)}, None),
            'short sha': ({'agent-errata': record(commit=SHA[:12])}, None),
            'source on another commit': ({'agent-errata': record(source_url=f'https://github.com/{REPO}/tree/{SHA2}/replications')}, None),
            'method elsewhere': ({'agent-errata': record(method_url='https://example.com/validate.ts')}, None),
            'run of another repo': ({'agent-errata': record(validate_run_url='https://github.com/x/y/actions/runs/1')}, None),
            'javascript url': ({'agent-errata': record(source_url='javascript:alert(1)')}, None),
            'local time': ({'agent-errata': record(observed_at='2026-10-20 22:53')}, None),
            'format': ({'agent-errata': record(format='other')}, None),
            'history after current': ({'agent-errata': record(history=[record(observed_at='2027-01-01T00:00:00Z')])}, None),
            'bad history item': ({'agent-errata': record(history=[record(commit='x')])}, None),
        }
        for why, (cards, _) in bad.items():
            self.assertTrue(R.validate(cards, {'agent-errata'}), why)

    def test_committed_file_is_valid(self):
        snap = sorted((ROOT / 'atlas' / 'data').glob('snapshot-verified-*.json'))[-1]
        slugs = {p['slug'] for p in json.loads(snap.read_text(encoding='utf-8'))['platforms']}
        cards = R.load()
        self.assertEqual(R.validate(cards, slugs), [])
        self.assertIn('agent-errata', cards)

    def test_sentence(self):
        self.assertEqual(R.sentence(record(rows=1, entries=1, entries_replicated=1, independent_agents=1)),
                         '1 replication row across 1 entry; 1 entry independently reproduced by 1 agent other than the finder and the repo operator.')
        self.assertIn('68 replication rows across 35 entries; 19 entries', R.sentence(record(rows=68, entries=35, entries_replicated=19, independent_agents=9)))


class RefreshStep(unittest.TestCase):
    CFG = {'format': 'agent-errata', 'repo': REPO, 'workflow': 'validate.yml', 'branch': 'main'}

    def fake(self, runs=None, listing=None):
        e, r = files()
        runs = runs if runs is not None else {'workflow_runs': [{'head_sha': SHA, 'html_url': f'https://github.com/{REPO}/actions/runs/7'}]}
        listing = listing or {'entries': list(e), 'replications': list(r)}
        seen = []

        def get_json(url, *a, **k):
            seen.append(url)
            if '/actions/workflows/validate.yml/runs?' in url:
                return runs, None
            for d in ('entries', 'replications'):
                if url == f'https://api.github.com/repos/{REPO}/contents/{d}?ref={SHA}':
                    return [{'name': n, 'type': 'file'} for n in listing[d]] + [{'name': 'sub', 'type': 'dir'}], None
            return None, 'unexpected'

        def get_text(url):
            seen.append(url)
            pre = f'https://raw.githubusercontent.com/{REPO}/{SHA}/'
            if not url.startswith(pre):
                return None, f'{url}: not pinned'
            p = url[len(pre):]
            if p == 'scripts/validate.ts':
                return VALIDATE_TS, None
            d, n = p.split('/', 1)
            return (e if d == 'entries' else r)[n], None
        return get_json, get_text, seen

    def read(self, **kw):
        gj, gt, seen = self.fake(**kw)
        with mock.patch.object(refresh, 'get_json', gj), mock.patch.object(refresh, '_get_text', gt):
            got, methods, err = refresh.read_replications(self.CFG, workers=2)
        return got, err, seen

    def test_reads_at_the_commit_validate_passed(self):
        got, err, seen = self.read()
        self.assertIsNone(err)
        self.assertEqual({k: got[k] for k in R.COUNT_KEYS}, {'rows': 12, 'entries': 4, 'entries_replicated': 3, 'independent_agents': 3})
        self.assertEqual(got['commit'], SHA)
        self.assertEqual(got['validate_run_url'], f'https://github.com/{REPO}/actions/runs/7')
        self.assertIn('status=success', seen[0]); self.assertIn('event=push', seen[0]); self.assertIn('branch=main', seen[0])
        self.assertTrue(all(SHA in u for u in seen[1:]), 'every file is read at the pinned commit')
        self.assertEqual(R.validate({'agent-errata': got | {'observed_at': '2026-10-20T00:00:00Z'}}, {'agent-errata'}), [])

    def test_no_successful_run_or_odd_listing_is_an_error(self):
        self.assertIn('no successful', self.read(runs={'workflow_runs': []})[1])
        self.assertIn('no successful', self.read(runs={'workflow_runs': [{'head_sha': 'abc', 'html_url': 'x'}]})[1])
        self.assertIn('html_url', self.read(runs={'workflow_runs': [{'head_sha': SHA, 'html_url': 'https://evil.example/r'}]})[1])
        e, r = files()
        self.assertIn('validator rejects', self.read(listing={'entries': list(e) + ['notes.txt'], 'replications': list(r)})[1])
        self.assertEqual(refresh.read_replications(dict(self.CFG, repo='../../x'))[2], 'bad replications config')

    def test_apply_only_changes_on_a_count_change(self):
        cards = {}
        got = record(observed_at=None)
        self.assertEqual(refresh.apply_replications(cards, 'agent-errata', got, '2026-10-20T00:00:00Z')[0], 'new')
        first = json.dumps(cards)
        # a newer commit with the same counts: only a check record (confirmed_at, issue #273); the pinned commit and
        # observed_at stay the ones first observed
        self.assertEqual(refresh.apply_replications(cards, 'agent-errata', dict(got, commit=SHA2), '2026-10-27T00:00:00Z')[0], 'same')
        self.assertEqual(cards['agent-errata'].pop('confirmed_at'), '2026-10-27T00:00:00Z')
        self.assertEqual(json.dumps(cards), first)
        cards['agent-errata']['confirmed_at'] = '2026-10-27T00:00:00Z'
        new = dict(got, rows=14, commit=SHA2, source_url=f'https://github.com/{REPO}/tree/{SHA2}/replications',
                   method_url=f'https://github.com/{REPO}/blob/{SHA2}/scripts/validate.ts')
        what, old = refresh.apply_replications(cards, 'agent-errata', new, '2026-10-27T00:00:00Z')
        self.assertEqual((what, old['rows']), ('changed', 13))
        rec = cards['agent-errata']
        self.assertEqual((rec['rows'], rec['commit'], rec['observed_at']), (14, SHA2, '2026-10-27T00:00:00Z'))
        self.assertEqual([(h['rows'], h['commit'], h['observed_at']) for h in rec['history']], [(13, SHA, '2026-10-20T00:00:00Z')])
        # the old record keeps its last confirmation in history; the new observation starts without one
        self.assertEqual(rec['history'][0]['confirmed_at'], '2026-10-27T00:00:00Z')
        self.assertNotIn('confirmed_at', rec)
        self.assertEqual(R.validate(cards, {'agent-errata'}), [])

    def test_run_writes_only_on_change_and_skips_failed_entries(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, 'replications.json')
            entries = [{'slug': 'agent-errata', 'status': 'live'}, {'slug': 'down', 'status': 'live'}]
            sources = {'agent-errata': {'replications': self.CFG}, 'down': {'replications': self.CFG}}
            gj, gt, _ = self.fake()
            rep = {'replications': [], 'replication_errors': []}
            with mock.patch.object(refresh, 'get_json', gj), mock.patch.object(refresh, '_get_text', gt):
                self.assertTrue(refresh.run_replications(entries, sources, {'down': {'cls': 'fail'}}, rep, '2026-10-20T00:00:00Z', path, False))
                raw = Path(path).read_text(encoding='utf-8')
                rep2 = {'replications': [], 'replication_errors': []}
                # unchanged counts: the file changes only by confirmed_at (issue #273); counts, commit and observed_at stay
                self.assertTrue(refresh.run_replications(entries, sources, {'down': {'cls': 'fail'}}, rep2, '2026-10-27T00:00:00Z', path, False))
            after = json.loads(Path(path).read_text(encoding='utf-8'))
            self.assertEqual(after['cards']['agent-errata'].pop('confirmed_at'), '2026-10-27T00:00:00Z')
            self.assertEqual(after, json.loads(raw), 'unchanged counts change nothing but confirmed_at')
            self.assertEqual([r['action'] for r in rep2['replications']], ['same'])
            self.assertEqual(list(json.loads(raw)['cards']), ['agent-errata'])
            self.assertEqual([r['action'] for r in rep['replications']], ['new'])
            self.assertIn('12 rows', refresh.replications_md(rep | {'run_at': '2026-10-20T00:00:00Z'}))


class LinkSafety(unittest.TestCase):
    def test_replication_record_is_pruned_with_a_removed_card_and_its_hosts_checked(self):
        sys.path.insert(0, str(ROOT / 'atlas' / 'tools'))
        import link_safety as ls
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / 'replications.json'
            p.write_text(json.dumps({'_help': 'x', 'cards': {'agent-errata': record(), 'other': record()}}, indent=1))
            files = ls.curation_files(td)
            self.assertIn('github.com', ls.curation_hosts({'agent-errata'}, files))
            self.assertEqual(ls.prune_curation({'agent-errata'}, files), ['replications.json'])
            self.assertEqual(list(json.loads(p.read_text())['cards']), ['other'])


if __name__ == '__main__':
    unittest.main()
