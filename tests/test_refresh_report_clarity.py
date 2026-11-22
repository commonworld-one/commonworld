"""Weekly refresh report: older failed-week counts are labelled as what they are, and a number change says whether the
old and new records come from the same source and window label. Report text only: counts, first_failed_at, claim
values, observed_at and history are not touched by this wording. Offline."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas'))
sys.path.insert(0, str(ROOT / 'tests'))
import refresh
from test_refresh_state_wording import SNAP

NOW = '2026-11-22T09:05:55Z'


def summary_of(entries):
    """Run refresh.main() once and return (summary text, state after) for the given state entries."""
    box = {}
    real = refresh.summary_md
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        snap = copy.deepcopy(SNAP)
        snap['platforms'] = [p for p in snap['platforms'] if p['slug'] in entries]
        for p in snap['platforms']:
            p['canonical_url'] = 'http://127.0.0.1:9/'
            p['status'] = 'live'
        (d / 'snap.json').write_text(json.dumps(snap), encoding='utf-8')
        (d / 'events.jsonl').write_text('', encoding='utf-8')
        (d / 'state.json').write_text(json.dumps({'version': 1, 'moved': {}, 'updated_at': '2026-11-21T19:10:54Z', 'entries': entries}), encoding='utf-8')
        (d / 'sources.json').write_text('{"sources": {}}', encoding='utf-8')
        argv = ['refresh.py', '--snapshot', str(d / 'snap.json'), '--state', str(d / 'state.json'), '--sources', str(d / 'sources.json'),
                '--replications', str(d / 'none.json'), '--report', str(d / 'report.json'), '--summary', str(d / 'summary.md')]
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(refresh, 'BACKOFF', (0,)), \
                mock.patch.object(refresh, 'run_replications', return_value=False), mock.patch.object(refresh, 'now_iso', return_value=NOW), \
                mock.patch('builtins.print'):
            refresh.main()
        box['md'] = (d / 'summary.md').read_text(encoding='utf-8')
        box['state'] = json.loads((d / 'state.json').read_text(encoding='utf-8'))['entries']
    return box['md'], box['state']


class OlderCounts(unittest.TestCase):
    OLD = {'failed_weeks': 3, 'first_failed_at': '2026-11-01T08:27:19Z', 'last_error': 'x', 'closed_at': '2026-11-21T19:10:54Z'}
    FIRST = {'failed_weeks': 1, 'first_failed_at': '2026-11-21T19:10:54Z', 'last_error': 'x', 'last_counted_at': '2026-11-21T19:10:54Z'}

    def test_older_counts_are_not_called_first_week(self):
        md, state = summary_of({'bountybook': dict(self.OLD), 'opentask': dict(self.FIRST)})
        first, older = md.split('### Older failed weeks on record')
        self.assertIn('### Suspected down (first failed week; nothing published)', first)
        self.assertIn('opentask', first)
        self.assertNotIn('bountybook', first.split('### Suspected down')[1], 'a 3-week record must not sit under the first-week heading')
        self.assertIn('bountybook', older)
        self.assertIn('| 3 | 2026-11-01 | yes, set by an earlier run: 2026-11-21T19:10:54Z | ' + NOW + ' |', older)
        self.assertIn('| suspected down (1st failed week) | 1 |', md)
        self.assertIn('| older failed weeks on record, not counted this run, not closed | 1 |', md)

    def test_report_wording_changes_no_counter(self):
        _, state = summary_of({'bountybook': dict(self.OLD)})
        e = state['bountybook']
        self.assertEqual((e['failed_weeks'], e['first_failed_at'], e['closed_at']), (3, '2026-11-01T08:27:19Z', '2026-11-21T19:10:54Z'))
        self.assertEqual(e['interval_baseline_at'], NOW)
        self.assertNotIn('last_counted_at', e)

    def test_no_older_section_when_there_are_none(self):
        md, _ = summary_of({'opentask': dict(self.FIRST)})
        self.assertNotIn('Older failed weeks on record', md)


def claim(**kw):
    c = {'kind': 'metric', 'statement': 'old', 'value': 1, 'unit': 'u', 'window': 'w1', 'basis': 'direct_observation',
         'source_url': 'https://s.example/a', 'quote': 'q', 'observed_at': '2026-11-01T00:00:00Z', 'methods': ['GET'], 'outcome': 'supported',
         'refresh_id': 'x'}
    c.update(kw)
    return c


def mapping(**kw):
    m = {'id': 'x', 'kind': 'metric', 'url': 'https://s.example/a', 'unit': 'u', 'basis': 'direct_observation', 'window': 'w1', 'path': 'v'}
    m.update(kw)
    return m


class Comparison(unittest.TestCase):
    def run_one(self, claim_kw, map_kw, val=2):
        e = {'slug': 's', 'claims': [claim(**claim_kw)]}
        what, _ = refresh.apply_number(e, mapping(**map_kw), val, 'q', ['GET'], NOW)
        return what, refresh.comparison_of(e['claims'][0], what), e['claims'][0]

    def test_same_source_and_window(self):
        self.assertEqual(self.run_one({}, {})[:2], ('changed', 'same'))

    def test_window_label_changed(self):
        self.assertEqual(self.run_one({'window': 'trailing 30d to 2026-10-15'}, {})[:2], ('changed', 'window'))

    def test_source_changed(self):
        self.assertEqual(self.run_one({'source_url': 'https://s.example/old'}, {})[:2], ('changed', 'source'))

    def test_both_changed_and_history_kept(self):
        what, cmp_, c = self.run_one({'source_url': 'https://s.example/old', 'window': 'old window'}, {})
        self.assertEqual(cmp_, 'source+window')
        self.assertEqual((c['history'][-1]['value'], c['history'][-1]['window'], c['history'][-1]['source_url']), (1, 'old window', 'https://s.example/old'))

    def test_new_claim_has_nothing_to_compare(self):
        e = {'slug': 's', 'claims': []}
        what, _ = refresh.apply_number(e, mapping(), 2, 'q', ['GET'], NOW)
        self.assertEqual((what, refresh.comparison_of(e['claims'][0], what)), ('new', None))

    def test_summary_flags_not_like_for_like(self):
        rep = {'run_at': NOW, 'counts': {'ok': 2}, 'died': [], 'suspected': [], 'recovered': [], 'revived': [], 'moved': [], 'closed_responding': [],
               'numbers': [{'slug': 'a', 'id': 'i1', 'kind': 'metric', 'basis': 'direct_observation', 'unit': 'u', 'old': 1, 'new': 2, 'action': 'changed', 'source': 'https://s', 'comparison': 'same'},
                           {'slug': 'b', 'id': 'i2', 'kind': 'metric', 'basis': 'direct_observation', 'unit': 'u', 'old': 5, 'new': 9, 'action': 'changed', 'source': 'https://s', 'comparison': 'source+window'}],
               'number_errors': [], 'note_drift': [], 'notes': [], 'replications': [], 'confirmed': []}
        md = refresh.summary_md(rep, None)
        self.assertIn('| of which source or window label changed (not like for like) | 1 |', md)
        self.assertIn('**1 of 2 number changes below', md)
        self.assertIn('| yes |', md)
        self.assertIn('| no: source+window changed |', md)

    def test_all_same_prints_no_warning(self):
        rep = {'run_at': NOW, 'counts': {'ok': 1}, 'died': [], 'suspected': [], 'recovered': [], 'revived': [], 'moved': [], 'closed_responding': [],
               'numbers': [{'slug': 'a', 'id': 'i1', 'kind': 'metric', 'basis': 'direct_observation', 'unit': 'u', 'old': 1, 'new': 2, 'action': 'changed', 'source': 'https://s', 'comparison': 'same'}],
               'number_errors': [], 'note_drift': [], 'notes': [], 'replications': [], 'confirmed': []}
        self.assertNotIn('Do not read old to new', refresh.summary_md(rep, None))


if __name__ == '__main__':
    unittest.main()
