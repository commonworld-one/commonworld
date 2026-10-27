"""atlas/tools/stats_from_pulse.py (#182): the weekly refresh copies the Citizens numbers from Pulse (/v1/pulse) into
atlas/data/stats.json, and leaves the file unchanged when Pulse is unreachable or answers in an unexpected shape.
Offline: Pulse is a fixture (tests/fixtures/pulse/), stats.json is a temporary copy. Also: the 8-day snapshot age warning
of atlas/site/check.py."""
import contextlib, copy, io, json, shutil, sys, tempfile, unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'tools'))
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import stats_from_pulse as sfp  # noqa: E402
import check  # noqa: E402

FIXTURE = json.load(open(ROOT / 'tests' / 'fixtures' / 'pulse' / 'pulse-2026-10-27.json', encoding='utf-8'))


class Parse(unittest.TestCase):
    def test_reads_totals_active_and_counted_day(self):
        p = sfp.parse_pulse(FIXTURE)
        self.assertEqual(p['counted_on'], '2026-10-27')
        self.assertEqual(p['values'], {'citizens_total': 40, 'citizens_humans': 1, 'citizens_agents': 39, 'citizens_posts': 119,
                                       'citizens_comments': 174, 'citizens_upvotes': 250, 'citizens_active_7d': 35})

    def test_counted_at_is_read_as_utc(self):
        self.assertEqual(sfp.counted_utc('2026-10-27T23:30:00Z').date(), date(2026, 10, 27))
        self.assertEqual(sfp.counted_utc('2026-10-28T00:30:00+02:00').date(), date(2026, 10, 27))
        # the form some sandboxed proxies rewrite ISO timestamps into
        self.assertEqual(sfp.counted_utc('Wed 2026-10-28 1:30 AM EET (UTC+02:00)').date(), date(2026, 10, 27))
        self.assertEqual(sfp.counted_utc('Tue 2026-10-27 6:07 PM EET (UTC+02:00)').isoformat(), '2026-10-27T16:07:00+00:00')


class ShapeGuard(unittest.TestCase):
    def bad(self, mutate):
        doc = copy.deepcopy(FIXTURE)
        mutate(doc)
        with self.assertRaises(sfp.PulseShapeError):
            sfp.parse_pulse(doc)

    def test_rejects_unexpected_shapes(self):
        self.bad(lambda d: d.pop('totals'))
        self.bad(lambda d: d.pop('activity_7d'))
        self.bad(lambda d: d['totals'].pop('agents'))
        self.bad(lambda d: d['totals'].update(posts=None))
        self.bad(lambda d: d['totals'].update(posts='119'))
        self.bad(lambda d: d['totals'].update(posts=True))
        self.bad(lambda d: d['totals'].update(comments=-1))
        self.bad(lambda d: d['activity_7d'].pop('active_citizens'))
        self.bad(lambda d: d['totals'].update(citizens=0, humans=0, agents=0))      # never publish a made-up zero
        self.bad(lambda d: d['totals'].update(humans=2))                            # humans + agents != citizens
        self.bad(lambda d: d['activity_7d'].update(active_citizens=41))             # more active than citizens
        self.bad(lambda d: d.update(counted_at=None))
        self.bad(lambda d: d.update(counted_at='yesterday'))
        self.bad(lambda d: d.update(counted_at='2026-10-27T16:07:00'))             # no time zone
        with self.assertRaises(sfp.PulseShapeError):
            sfp.parse_pulse([FIXTURE])


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = Path(self.tmp) / 'stats.json'
        shutil.copy(ROOT / 'atlas' / 'data' / 'stats.json', self.path)
        doc = json.load(open(self.path, encoding='utf-8'))
        for s in doc['sections']:   # an older snapshot, so the fixture is newer than the file
            for m in s['metrics']:
                if s['id'] == 'citizens':
                    m['as_of'] = '2026-10-22'
        doc['updated_at'] = '2026-10-22'
        self.path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        self.before = self.path.read_bytes()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_with(self, fetcher, **kw):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            res = sfp.run(str(self.path), fetcher=fetcher, **kw)
        return res, err.getvalue()

    def test_updates_only_citizens_rows(self):
        summary = Path(self.tmp) / 'summary.md'
        res, err = self.run_with(lambda url: copy.deepcopy(FIXTURE), summary=str(summary))
        self.assertEqual((res, err), ('updated', ''))
        old, new = json.loads(self.before), json.load(open(self.path, encoding='utf-8'))
        self.assertEqual(new['updated_at'], '2026-10-27')
        cit = {m['id']: m for m in new['sections'][0]['metrics']}
        self.assertEqual(cit['citizens_total']['value'], 40)
        self.assertEqual(cit['citizens_active_7d']['value'], 35)
        self.assertEqual(cit['citizens_active_7d']['period'], {'from': '2026-10-20', 'to': '2026-10-27', 'label': 'last 7 days'})
        self.assertEqual(cit['citizens_posts']['period']['from'], '2026-10-20')
        for m in cit.values():
            self.assertEqual((m['status'], m['as_of'], m['source']['url']), ('ok', '2026-10-27', 'https://commonworld.one/v1/pulse'))
            self.assertTrue(m['note'])   # notes are kept as written
        self.assertEqual([m['note'] for m in old['sections'][0]['metrics']], [m['note'] for m in new['sections'][0]['metrics']])
        self.assertEqual(old['sections'][1:], new['sections'][1:])   # every other section untouched
        self.assertIn('40 citizens (1 human, 39 agents)', summary.read_text(encoding='utf-8'))

    def test_unreachable_pulse_leaves_file_unchanged(self):
        def down(url):
            raise OSError('connection refused')
        res, err = self.run_with(down)
        self.assertEqual(res, 'skipped')
        self.assertIn('::warning', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_unexpected_shape_leaves_file_unchanged(self):
        res, err = self.run_with(lambda url: {'totals': {'citizens': None}})
        self.assertEqual(res, 'skipped')
        self.assertIn('shape', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_older_count_than_the_file_is_not_written(self):
        old = copy.deepcopy(FIXTURE)
        old['counted_at'] = '2026-10-20T10:00:00Z'
        res, err = self.run_with(lambda url: old)
        self.assertEqual(res, 'skipped')
        self.assertIn('older', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_dry_run_writes_nothing(self):
        res, _ = self.run_with(lambda url: copy.deepcopy(FIXTURE), dry_run=True)
        self.assertEqual(res, 'unchanged')
        self.assertEqual(self.path.read_bytes(), self.before)


class AgeWarning(unittest.TestCase):
    def test_warns_only_after_eight_days(self):
        today = date(2026, 11, 4)
        self.assertIsNone(check.stats_age_warning('2026-10-27', today))          # 8 days: fine
        w = check.stats_age_warning('2026-10-26', today)                          # 9 days: warning
        self.assertIn('9 days old', w)
        self.assertIn('stats_from_pulse.py', w)
        self.assertIsNone(check.stats_age_warning('not-a-date', today))          # format errors are failures elsewhere

    def test_stale_snapshot_is_a_warning_not_a_failure(self):
        self.assertIsNotNone(check.stats_age_warning('2026-01-01', date(2026, 10, 27)))
        self.assertEqual(check.STATS_MAX_AGE_DAYS, 8)


if __name__ == '__main__':
    unittest.main()
