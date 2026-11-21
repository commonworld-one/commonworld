"""Failed-week counters: wording says what was recorded, a gap in the records never closes an extra entry, and a state that
comes from outside the checkout (open refresh PR, state kept by a failed run) only wins when it is valid and newer. Offline."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas'))
import refresh

SNAP = json.loads((ROOT / 'atlas/data/snapshot-verified-2026-10-15.json').read_text(encoding='utf-8'))


def run_refresh(state, state_from=(), slugs=('opentask',), now=None, boom=False, keep=None):
    """One real refresh.py main() on a one-site-per-slug copy of the snapshot pointing at a refused (non-public) address."""
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        snap = copy.deepcopy(SNAP)
        snap['platforms'] = [p for p in snap['platforms'] if p['slug'] in slugs]
        for p in snap['platforms']:
            p['canonical_url'] = 'http://127.0.0.1:9/'
            p['status'] = 'live'
        (d / 'snap.json').write_text(json.dumps(snap), encoding='utf-8')
        (d / 'events.jsonl').write_text('', encoding='utf-8')
        (d / 'state.json').write_text(json.dumps(state), encoding='utf-8')
        (d / 'sources.json').write_text('{"sources": {}}', encoding='utf-8')
        argv = ['refresh.py', '--snapshot', str(d / 'snap.json'), '--state', str(d / 'state.json'), '--sources', str(d / 'sources.json'),
                '--replications', str(d / 'none.json'), '--report', str(d / 'report.json'), '--summary', str(d / 'summary.md')]
        for p in state_from:
            argv += ['--state-from', str(p)]
        patches = [mock.patch.object(sys, 'argv', argv),
                   mock.patch.object(refresh, 'BACKOFF', (0,)),
                   mock.patch.object(refresh, 'run_replications', side_effect=RuntimeError('boom') if boom else None, return_value=False)]
        if now:
            patches.append(mock.patch.object(refresh, 'now_iso', return_value=now))
        for pt in patches:
            pt.start()
        try:
            refresh.main()
        except RuntimeError:
            if not boom:
                raise
        finally:
            mock.patch.stopall()
        if keep is not None:
            keep.update({'state': (d / 'state.json').read_text(encoding='utf-8'), 'snap': (d / 'snap.json').read_text(encoding='utf-8')})
        return (json.loads((d / 'snap.json').read_text(encoding='utf-8')), json.loads((d / 'state.json').read_text(encoding='utf-8')),
                (d / 'events.jsonl').read_text(encoding='utf-8'))


def st(weeks, at='2026-11-14T00:00:00Z', first='2026-11-14T00:00:00Z'):
    return {'version': 1, 'moved': {}, 'updated_at': at, 'entries': {'opentask': {'failed_weeks': weeks, 'first_failed_at': first, 'last_error': 'x'}}}


class Wording(unittest.TestCase):
    def test_closure_says_recorded_checks_with_the_recorded_count(self):
        snap, state, events = run_refresh(st(1))
        e = snap['platforms'][0]
        self.assertEqual(e['status'], 'closed')
        claim = e['claims'][0]
        self.assertIn('2 recorded weekly checks since 2026-11-14', claim['statement'])
        self.assertNotIn('consecutive weeks', claim['statement'])
        self.assertIn('2 recorded weekly checks since 2026-11-14', e['status_history'][-1]['reason'])
        self.assertEqual(claim['refresh']['failed_weeks_recorded'], 2)
        self.assertIn('2 recorded weekly checks since 2026-11-14', events)

    def test_first_failure_only_suspects(self):
        snap, state, _ = run_refresh({'version': 1, 'moved': {}, 'entries': {}})
        self.assertEqual(snap['platforms'][0]['status'], 'live')
        self.assertEqual(state['entries']['opentask']['failed_weeks'], 1)

    def test_a_week_missing_from_the_records_is_not_made_up(self):
        # counters are never inferred from calendar gaps: one recorded failure stays one, closure needs a second recorded failure
        snap, state, _ = run_refresh(st(1, at='2026-10-01T00:00:00Z', first='2026-10-01T00:00:00Z'), slugs=('opentask', 'clawbench'))
        by = {p['slug']: p for p in snap['platforms']}
        self.assertEqual(by['clawbench']['status'], 'live')
        self.assertEqual(state['entries']['clawbench']['failed_weeks'], 1)


def fresh(weeks, counted, first='2026-11-15T09:00:00Z'):
    d = st(weeks, at=first, first=first)
    if counted:
        d['entries']['opentask']['last_counted_at'] = counted
    return d


class SevenDayGap(unittest.TestCase):
    """A failed check adds a week only when >= 7 days passed since the previous counted failed check."""
    def test_same_week_reruns_do_not_count(self):
        for now in ('2026-11-21T19:10:54Z', '2026-11-22T08:30:00Z', '2026-11-28T08:00:00Z'):   # manual, scheduled next day, just under 7 days
            snap, state, _ = run_refresh(fresh(1, '2026-11-21T10:00:00Z', '2026-11-21T10:00:00Z'), now=now)
            self.assertEqual(snap['platforms'][0]['status'], 'live')
            self.assertEqual(state['entries']['opentask']['failed_weeks'], 1)
            self.assertEqual(state['entries']['opentask']['first_failed_at'], '2026-11-21T10:00:00Z')
            self.assertEqual(state['entries']['opentask']['last_counted_at'], '2026-11-21T10:00:00Z')

    def test_exactly_seven_days_counts_and_closes(self):
        s, state, _ = run_refresh(fresh(1, '2026-11-15T09:00:00Z'), now='2026-11-22T09:00:00Z')
        self.assertEqual(s['platforms'][0]['status'], 'closed')
        self.assertEqual((state['entries']['opentask']['failed_weeks'], state['entries']['opentask']['last_counted_at']), (2, '2026-11-22T09:00:00Z'))

    def test_manual_run_then_scheduled_then_a_week_later(self):
        _, a, _ = run_refresh({'version': 1, 'moved': {}, 'entries': {}}, now='2026-11-17T09:00:00Z')   # first failure, manual
        _, b, _ = run_refresh(a, now='2026-11-22T09:00:00Z')                                              # scheduled, 5 days later: no
        self.assertEqual(b['entries']['opentask']['failed_weeks'], 1)
        s, c, _ = run_refresh(b, now='2026-11-24T09:00:00Z')                                              # 7 days after the counted one
        self.assertEqual((s['platforms'][0]['status'], c['entries']['opentask']['failed_weeks']), ('closed', 2))

    def test_migration_one_week_entry_uses_first_failed_at_as_last_count(self):
        # current state shape: failed_weeks 1, no last_counted_at; counted once, at first_failed_at (grounded), so a run 13 h later is not a new week
        s, state, _ = run_refresh(fresh(1, None, '2026-11-21T19:10:54Z'), now='2026-11-22T08:30:00Z')
        self.assertEqual(s['platforms'][0]['status'], 'live')
        self.assertEqual(state['entries']['opentask']['failed_weeks'], 1)
        s, state, _ = run_refresh(fresh(1, None, '2026-11-21T19:10:54Z'), now='2026-11-28T19:10:54Z')
        self.assertEqual(s['platforms'][0]['status'], 'closed')

    def test_unknown_last_count_time_sets_a_baseline_and_does_not_count(self):
        # 3 recorded weeks, no last_counted_at: nothing is assumed. First run: no count, no close, baseline = this check.
        s, state, _ = run_refresh(fresh(3, None, '2026-11-01T09:00:00Z'), now='2026-11-22T09:00:00Z')
        e = state['entries']['opentask']
        self.assertEqual((e['failed_weeks'], e['first_failed_at'], e['interval_baseline_at']), (3, '2026-11-01T09:00:00Z', '2026-11-22T09:00:00Z'))
        self.assertNotIn('last_counted_at', e)
        self.assertEqual(s['platforms'][0]['status'], 'live')
        # early runs keep the baseline and still do not count (just under 168 h)
        _, early, _ = run_refresh(state, now='2026-11-29T08:59:59Z')
        self.assertEqual((early['entries']['opentask']['failed_weeks'], early['entries']['opentask']['interval_baseline_at']), (3, '2026-11-22T09:00:00Z'))
        # exactly 168 h after the baseline it counts, records last_counted_at and drops the baseline
        _, later, _ = run_refresh(early, now='2026-11-29T09:00:00Z')
        e = later['entries']['opentask']
        self.assertEqual((e['failed_weeks'], e['last_counted_at']), (4, '2026-11-29T09:00:00Z'))
        self.assertNotIn('interval_baseline_at', e)

    def test_one_failed_week_with_unknown_count_time_cannot_close_early(self):
        # failed_weeks 1 whose last_counted_at is present but malformed: unknown, so baseline, no close on the first or an early run
        bad = fresh(1, 'garbage', '2026-11-01T09:00:00Z')
        s, state, _ = run_refresh(bad, now='2026-11-22T09:00:00Z')
        self.assertEqual((s['platforms'][0]['status'], state['entries']['opentask']['failed_weeks']), ('live', 1))
        self.assertEqual(state['entries']['opentask']['interval_baseline_at'], '2026-11-22T09:00:00Z')
        _, early, _ = run_refresh(state, now='2026-11-25T09:00:00Z')
        self.assertEqual(early['entries']['opentask']['failed_weeks'], 1)
        s, closed, _ = run_refresh(early, now='2026-11-29T09:00:00Z')
        self.assertEqual((s['platforms'][0]['status'], closed['entries']['opentask']['failed_weeks']), ('closed', 2))

    def test_malformed_baseline_is_reset_not_counted(self):
        st_ = fresh(3, None, '2026-11-01T09:00:00Z')
        st_['entries']['opentask']['interval_baseline_at'] = 'garbage'
        _, state, _ = run_refresh(st_, now='2026-11-22T09:00:00Z')
        e = state['entries']['opentask']
        self.assertEqual((e['failed_weeks'], e['interval_baseline_at']), (3, '2026-11-22T09:00:00Z'))

    def test_earned_closure_is_applied_without_counting_again(self):
        # state kept by a run that counted the 2nd week then failed before publishing: the retry (live card, 2 weeks, valid count time) closes
        s, state, _ = run_refresh(fresh(2, '2026-11-22T09:00:00Z'), now='2026-11-23T09:00:00Z')
        e = state['entries']['opentask']
        self.assertEqual(s['platforms'][0]['status'], 'closed')
        self.assertEqual((e['failed_weeks'], e['last_counted_at']), (2, '2026-11-22T09:00:00Z'))
        self.assertIn('2 recorded weekly checks', s['platforms'][0]['claims'][0]['statement'])

    def test_earned_closure_unit(self):
        self.assertTrue(refresh.earned_closure({'failed_weeks': 2, 'last_counted_at': '2026-11-22T09:00:00Z'}))

    def test_legacy_history_without_a_valid_count_time_is_never_an_earned_closure(self):
        for entry in ({'failed_weeks': 3, 'first_failed_at': '2026-11-01T09:00:00Z'},
                      {'failed_weeks': 2, 'first_failed_at': '2026-11-01T09:00:00Z', 'last_counted_at': 'garbage'},
                      {'failed_weeks': 2, 'first_failed_at': '2026-11-01T09:00:00Z', 'last_counted_at': None},
                      {'failed_weeks': 1, 'first_failed_at': '2026-11-01T09:00:00Z', 'last_counted_at': '2026-11-22T09:00:00Z'}):
            self.assertFalse(refresh.earned_closure(entry))
        st_ = fresh(3, None, '2026-11-01T09:00:00Z')
        s, state, _ = run_refresh(st_, now='2026-11-22T09:00:00Z')
        self.assertEqual((s['platforms'][0]['status'], state['entries']['opentask']['failed_weeks']), ('live', 3))
        bad = fresh(2, 'garbage', '2026-11-01T09:00:00Z')
        s, state, _ = run_refresh(bad, now='2026-11-22T09:00:00Z')
        self.assertEqual((s['platforms'][0]['status'], state['entries']['opentask']['failed_weeks']), ('live', 2))

    def test_bad_timestamp_does_not_count(self):
        st_ = {'failed_weeks': 2, 'last_counted_at': 'garbage', 'first_failed_at': '2026-11-01T09:00:00Z'}
        self.assertFalse(refresh.counts_as_new_week(st_, '2026-11-22T09:00:00Z'))
        self.assertEqual(st_['interval_baseline_at'], '2026-11-22T09:00:00Z')

    def test_failed_refresh_leaves_no_partial_state_and_the_retry_counts_once(self):
        start = {'version': 1, 'moved': {}, 'entries': {}}
        kept = {}
        run_refresh(start, now='2026-11-17T09:00:00Z', boom=True, keep=kept)
        self.assertEqual(json.loads(kept['state']), start)                   # state file untouched by a run that died
        self.assertEqual(json.loads(kept['snap'])['platforms'][0]['status'], 'live')
        _, retry, _ = run_refresh(start, now='2026-11-17T12:00:00Z')
        self.assertEqual(retry['entries']['opentask']['failed_weeks'], 1)
        _, again, _ = run_refresh(retry, now='2026-11-18T12:00:00Z')
        self.assertEqual(again['entries']['opentask']['failed_weeks'], 1)


class StateFrom(unittest.TestCase):
    def write(self, d, name, obj):
        p = Path(d) / name
        p.write_text(json.dumps(obj), encoding='utf-8')
        return p

    def test_newer_valid_state_wins_older_and_invalid_are_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            older = self.write(d, 'older.json', st(5, at='2026-11-01T00:00:00Z'))
            newer = self.write(d, 'newer.json', st(1, at='2026-11-20T00:00:00Z'))
            bad = self.write(d, 'bad.json', {'version': 1, 'updated_at': '2099-01-01T00:00:00Z', 'entries': {'opentask': {'failed_weeks': 'lots'}}})
            main_state = st(0, at='2026-11-10T00:00:00Z')
            _, state, _ = run_refresh(main_state, [older, bad, newer])
            # started from `newer` (1 failed week), so this run records the 2nd and closes; neither `older` nor `bad` was used
            self.assertEqual(state['entries']['opentask']['failed_weeks'], 2)
            _, state, _ = run_refresh(main_state, [older, bad])
            self.assertEqual(state['entries']['opentask']['failed_weeks'], 1)

    def test_valid_state_shape(self):
        self.assertTrue(refresh.valid_state(st(1)))
        for bad in (None, [], {'version': 2, 'entries': {}}, {'version': 1, 'entries': []},
                    {'version': 1, 'entries': {'a': {'failed_weeks': True}}}):
            self.assertFalse(refresh.valid_state(bad))


if __name__ == '__main__':
    unittest.main()
