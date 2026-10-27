"""atlas/tools/stats_from_pulse.py (#182): the weekly refresh copies the Citizens numbers from Pulse (/v1/pulse) into
atlas/data/stats.json, and leaves the file unchanged when Pulse is unreachable or answers in an unexpected shape.
Offline: Pulse is a fixture (tests/fixtures/pulse/), stats.json is a temporary copy. Also: the 8-day snapshot age warning
of atlas/site/check.py."""
import contextlib, copy, io, json, shutil, sys, tempfile, unittest
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'tools'))
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import stats_from_pulse as sfp  # noqa: E402
import check  # noqa: E402

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)  # tests never depend on the real clock
FIXTURE = json.load(open(ROOT / 'tests' / 'fixtures' / 'pulse' / 'pulse-2026-10-27.json', encoding='utf-8'))


class Parse(unittest.TestCase):
    def test_reads_totals_active_and_counted_day(self):
        p = sfp.parse_pulse(FIXTURE, NOW)
        self.assertEqual(p['activity'], {'at': '2026-10-27T16:07:00.000Z', 'on': '2026-10-27'})   # Pulse counted_at
        self.assertEqual(p['totals'], {'at': '2026-10-27T16:40:00.000Z', 'on': '2026-10-27'})     # Pulse generated_at
        self.assertEqual(p['values'], {'citizens_total': 40, 'citizens_humans': 1, 'citizens_agents': 39, 'citizens_posts': 119,
                                       'citizens_comments': 174, 'citizens_upvotes': 250, 'citizens_active_7d': 35})

    def test_counted_at_is_read_as_utc(self):
        self.assertEqual(sfp.counted_utc('2026-10-27T23:30:00+02:00', NOW).isoformat(), '2026-10-27T21:30:00+00:00')
        self.assertEqual(sfp.counted_utc('2026-10-28T00:30:00+02:00', NOW).date(), date(2026, 10, 27))
        self.assertEqual(sfp.counted_utc('2026-10-27T16:07:00.000Z', NOW).isoformat(), '2026-10-27T16:07:00+00:00')
        self.assertEqual(sfp.counted_utc('2026-10-27T16:07Z', NOW).isoformat(), '2026-10-27T16:07:00+00:00')
        self.assertEqual(sfp.counted_utc('2026-10-27T10:37:00-05:30', NOW).isoformat(), '2026-10-27T16:07:00+00:00')
        self.assertEqual(sfp.counted_utc('2026-10-28T06:07:00+14:00', NOW).isoformat(), '2026-10-27T16:07:00+00:00')
        # the form some sandboxed proxies rewrite ISO timestamps into (explicit (UTC+HH:MM) offset required)
        self.assertEqual(sfp.counted_utc('Wed 2026-10-28 ' + '1:30 AM EET (UTC+02:00)', NOW).date(), date(2026, 10, 27))
        self.assertEqual(sfp.counted_utc('Tue 2026-10-27 ' + '6:07 PM EET (UTC+02:00)', NOW).isoformat(), '2026-10-27T16:07:00+00:00')
        self.assertEqual(sfp.parse_pulse(FIXTURE, NOW)['activity']['at'], '2026-10-27T16:07:00.000Z')

    def test_rejects_bad_zones_and_strings(self):
        now = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)
        for v in ('Tue 2026-10-27 ' + '6:07 PM EET (UTC-99:99)',   # impossible offset (was read as a future as_of)
                  'Tue 2026-10-27 ' + '6:07 PM EET (UTC+15:00)',
                  'Tue 2026-10-27 ' + '6:07 PM EET (UTC+02:07)',   # minutes not 00/15/30/45
                  'Tue 2026-10-27 ' + '6:07 PM EET',               # no explicit offset: never guessed to be UTC
                  'Tue 2026-10-27 ' + '6:07 PM',
                  'Tue 2026-10-27 ' + '6:07 PM EET (UTC+2)',
                  'Wed 2026-10-27 ' + '6:07 PM EET (UTC+02:00)',   # weekday does not match the date
                  'Tue 2026-10-27 ' + '13:07 PM EET (UTC+02:00)',
                  '2026-10-27T16:07:00',                           # ISO without a zone
                  '2026-10-27T16:07:00+99:99', '2026-10-27T16:07:00+14:30', '2026-10-27T16:07:00+0200',
                  '2026-10-27 16:07:00Z', '2026-13-27T16:07:00Z', '2026-10-27T25:07:00Z',
                  '2026-10-27T16:07:00Z\n', ' 2026-10-27T16:07:00Z', '2026-10-27T16:07:00\x00Z',
                  'Tue 2026-10-27\t' + '6:07 PM EET (UTC+02:00)', '2026-10-27T16:07:00Z\x85'):
            with self.subTest(v=v), self.assertRaises(sfp.PulseShapeError):
                sfp.counted_utc(v, now)

    def test_rejects_future_counted_at(self):
        now = datetime(2026, 10, 27, 16, 0, tzinfo=timezone.utc)
        self.assertEqual(sfp.counted_utc('2026-10-27T16:10:00Z', now).minute, 10)   # within 10 minutes of clock skew
        with self.assertRaises(sfp.PulseShapeError):
            sfp.counted_utc('2026-10-27T16:10:01Z', now)
        with self.assertRaises(sfp.PulseShapeError):
            sfp.counted_utc('Sat 2026-10-31 ' + '6:07 PM EET (UTC+02:00)', now)
        with self.assertRaises(sfp.PulseShapeError):
            sfp.parse_pulse(FIXTURE, now=datetime(2026, 10, 27, 15, 0, tzinfo=timezone.utc))


class ShapeGuard(unittest.TestCase):
    def bad(self, mutate):
        doc = copy.deepcopy(FIXTURE)
        mutate(doc)
        with self.assertRaises(sfp.PulseShapeError):
            sfp.parse_pulse(doc, NOW)

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
        self.bad(lambda d: d.update(generated_at=None))                            # generated_at is read as strictly
        self.bad(lambda d: d.update(generated_at='2026-10-27T16:40:00'))
        self.bad(lambda d: d.update(generated_at='Tue 2026-10-27 ' + '6:40 PM EET (UTC-99:99)'))
        self.bad(lambda d: d.update(generated_at='2026-10-27T16:00:00Z'))          # counted after the answer was made
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
            if s['id'] == 'citizens':   # the older format: one counted_at for the whole section
                s.pop('totals_observed_at', None)
                s.pop('activity_counted_at', None)
                s['counted_at'] = '2026-10-22T09:00:00Z'
        doc['updated_at'] = '2026-10-22'
        self.path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        self.before = self.path.read_bytes()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_with(self, fetcher, **kw):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            res = sfp.run(str(self.path), fetcher=fetcher, now=NOW, **kw)
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

    def with_pulse_at(self, counted_at, generated_at=None):
        doc = copy.deepcopy(FIXTURE)
        doc['counted_at'] = counted_at
        doc['generated_at'] = generated_at or counted_at
        return self.run_with(lambda url: doc)

    def set_file_counted_at(self, as_of, counted_at):
        doc = json.load(open(self.path, encoding='utf-8'))
        cit = doc['sections'][0]
        for m in cit['metrics']:
            m['as_of'] = as_of
        if counted_at is None:
            cit.pop('counted_at', None)
        else:
            cit['counted_at'] = counted_at
        self.path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        self.before = self.path.read_bytes()

    def test_older_count_than_the_file_is_not_written(self):
        res, err = self.with_pulse_at('2026-10-20T10:00:00Z')
        self.assertEqual(res, 'skipped')
        self.assertIn('older', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_earlier_count_of_the_same_day_is_not_written(self):
        self.set_file_counted_at('2026-10-27', '2026-10-27T16:07:00.000Z')
        res, err = self.with_pulse_at('2026-10-27T00:00:00Z')
        self.assertEqual(res, 'skipped')
        self.assertIn('older', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_count_at_the_same_time_is_a_no_op(self):
        self.set_file_counted_at('2026-10-27', '2026-10-27T16:07:00.000Z')
        for same in ('2026-10-27T16:07:00Z', '2026-10-27T18:07:00+02:00'):
            res, err = self.with_pulse_at(same)
            self.assertEqual((res, err), ('unchanged', ''))
            self.assertEqual(self.path.read_bytes(), self.before)

    def test_later_count_of_the_same_day_is_written(self):
        self.set_file_counted_at('2026-10-27', '2026-10-27T16:07:00.000Z')
        res, err = self.with_pulse_at('2026-10-27T17:07:00Z')
        self.assertEqual((res, err), ('updated', ''))
        new = json.load(open(self.path, encoding='utf-8'))
        self.assertEqual(new['sections'][0]['activity_counted_at'], '2026-10-27T17:07:00.000Z')
        self.assertEqual(new['sections'][0]['totals_observed_at'], '2026-10-27T17:07:00.000Z')
        self.assertNotIn('counted_at', new['sections'][0])   # the older shared field goes once both are written
        self.assertEqual({m['as_of'] for m in new['sections'][0]['metrics']}, {'2026-10-27'})   # as_of stays the date

    def test_written_counted_at_is_exact_utc(self):
        res, _ = self.run_with(lambda url: copy.deepcopy(FIXTURE))
        self.assertEqual(res, 'updated')
        cit = json.load(open(self.path, encoding='utf-8'))['sections'][0]
        self.assertEqual((cit['totals_observed_at'], cit['activity_counted_at']), ('2026-10-27T16:40:00.000Z', '2026-10-27T16:07:00.000Z'))
        self.assertEqual(check.citizens_times_fails(cit), [])

    def test_file_without_counted_at_takes_only_a_later_day(self):
        self.set_file_counted_at('2026-10-27', None)
        res, err = self.with_pulse_at('2026-10-27T20:00:00Z')
        self.assertEqual(res, 'skipped')
        self.assertIn('same day', err)
        self.assertEqual(self.path.read_bytes(), self.before)
        res, _ = self.with_pulse_at('2026-10-28T08:00:00Z')
        self.assertEqual(res, 'updated')

    def test_unreadable_counted_at_in_the_file_is_not_overwritten(self):
        self.set_file_counted_at('2026-10-22', 'Tue 2026-10-27 ' + '6:07 PM EET (UTC-99:99)')
        res, err = self.run_with(lambda url: copy.deepcopy(FIXTURE))
        self.assertEqual(res, 'skipped')
        self.assertIn('not readable', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_bad_zone_or_future_pulse_leaves_file_unchanged(self):
        for v in ('Tue 2026-10-27 ' + '6:07 PM EET (UTC-99:99)', 'Tue 2026-10-27 ' + '6:07 PM EET', '2026-10-31T16:07:00Z'):
            res, err = self.with_pulse_at(v)
            self.assertEqual(res, 'skipped', v)
            self.assertIn('shape', err)
            self.assertEqual(self.path.read_bytes(), self.before)

    def test_dry_run_writes_nothing(self):
        res, _ = self.run_with(lambda url: copy.deepcopy(FIXTURE), dry_run=True)
        self.assertEqual(res, 'unchanged')
        self.assertEqual(self.path.read_bytes(), self.before)


class TwoTimes(unittest.TestCase):
    """Totals are live counters observed at Pulse generated_at; active citizens are as of the hourly counted_at
    (platform/src/pulse.ts). Each group has its own time in the file and its own freshness check."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = Path(self.tmp) / 'stats.json'
        doc = json.load(open(ROOT / 'atlas' / 'data' / 'stats.json', encoding='utf-8'))
        cit = doc['sections'][0]
        cit.pop('counted_at', None)
        cit['totals_observed_at'], cit['activity_counted_at'] = '2026-10-27T16:40:00.000Z', '2026-10-27T16:07:00.000Z'
        for m in cit['metrics']:
            m['as_of'] = '2026-10-27'
        self.write(doc)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def write(self, doc):
        self.path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        self.before = self.path.read_bytes()

    def cit(self):
        return json.load(open(self.path, encoding='utf-8'))['sections'][0]

    def rows(self):
        return {m['id']: m for m in self.cit()['metrics']}

    def pulse(self, generated_at, counted_at, citizens=None, active=None):
        doc = copy.deepcopy(FIXTURE)
        doc['generated_at'], doc['counted_at'] = generated_at, counted_at
        if citizens is not None:
            doc['totals'].update(citizens=citizens, agents=citizens - doc['totals']['humans'])
        if active is not None:
            doc['activity_7d']['active_citizens'] = active
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            res = sfp.run(str(self.path), fetcher=lambda url: doc, now=NOW)
        return res, err.getvalue(), out.getvalue()

    def test_midnight_answer_dates_totals_by_generated_at(self):
        # answer made at 00:05 UTC on the 28th, activity last counted at 23:07 UTC on the 27th
        res, err, _ = self.pulse('2026-10-28T00:05:00Z', '2026-10-27T23:07:00Z', citizens=42, active=36)
        self.assertEqual((res, err), ('updated', ''))
        rows, cit = self.rows(), self.cit()
        self.assertEqual(rows['citizens_total']['value'], 42)
        for mid in sfp.TOTALS:
            self.assertEqual(rows[mid]['as_of'], '2026-10-28', mid)
            self.assertEqual(rows[mid]['period']['to'], '2026-10-28', mid)
        self.assertEqual(rows['citizens_active_7d']['as_of'], '2026-10-27')
        self.assertEqual(rows['citizens_active_7d']['period'], {'from': '2026-10-20', 'to': '2026-10-27', 'label': 'last 7 days'})
        self.assertEqual((cit['totals_observed_at'], cit['activity_counted_at']), ('2026-10-28T00:05:00.000Z', '2026-10-27T23:07:00.000Z'))
        self.assertEqual(json.load(open(self.path, encoding='utf-8'))['updated_at'], '2026-10-28')
        self.assertEqual(check.citizens_times_fails(cit), [])

    def test_new_registration_before_the_next_count_updates_totals_only(self):
        res, err, out = self.pulse('2026-10-27T17:30:00Z', '2026-10-27T16:07:00Z', citizens=41, active=35)
        self.assertEqual((res, err), ('updated', ''))
        self.assertIn('activity count (counted_at)', out)       # activity: same count, a no-op
        rows, cit = self.rows(), self.cit()
        self.assertEqual((rows['citizens_total']['value'], rows['citizens_agents']['value']), (41, 40))
        self.assertEqual(cit['totals_observed_at'], '2026-10-27T17:30:00.000Z')
        self.assertEqual(cit['activity_counted_at'], '2026-10-27T16:07:00.000Z')
        self.assertEqual(check.citizens_times_fails(cit), [])

    def test_older_activity_is_skipped_while_totals_update(self):
        doc = json.loads(self.before)
        doc['sections'][0]['activity_counted_at'] = '2026-10-27T17:07:00.000Z'
        next(m for m in doc['sections'][0]['metrics'] if m['id'] == 'citizens_active_7d')['value'] = 30
        self.write(doc)
        res, err, _ = self.pulse('2026-10-27T17:30:00Z', '2026-10-27T16:07:00Z', citizens=41, active=35)
        self.assertEqual(res, 'updated')
        self.assertIn('::warning', err)
        self.assertIn('older', err)
        self.assertIn('this group left unchanged', err)
        rows, cit = self.rows(), self.cit()
        self.assertEqual(rows['citizens_active_7d']['value'], 30)
        self.assertEqual(cit['activity_counted_at'], '2026-10-27T17:07:00.000Z')
        self.assertEqual(rows['citizens_total']['value'], 41)
        self.assertEqual(cit['totals_observed_at'], '2026-10-27T17:30:00.000Z')

    def test_older_totals_are_skipped_while_activity_updates(self):
        res, err, _ = self.pulse('2026-10-27T16:30:00Z', '2026-10-27T16:20:00Z', citizens=39, active=36)
        self.assertEqual(res, 'updated')
        self.assertIn('totals (generated_at)', err)
        rows, cit = self.rows(), self.cit()
        self.assertEqual((rows['citizens_total']['value'], cit['totals_observed_at']), (41, '2026-10-27T16:40:00.000Z'))
        self.assertEqual((rows['citizens_active_7d']['value'], cit['activity_counted_at']), (36, '2026-10-27T16:20:00.000Z'))

    def test_both_equal_is_a_no_op_and_both_older_is_skipped(self):
        res, err, _ = self.pulse('2026-10-27T16:40:00Z', '2026-10-27T18:07:00+02:00')
        self.assertEqual((res, err), ('unchanged', ''))
        self.assertEqual(self.path.read_bytes(), self.before)
        res, err, _ = self.pulse('2026-10-27T16:39:59Z', '2026-10-27T16:06:59Z')
        self.assertEqual(res, 'skipped')
        self.assertEqual(err.count('::warning'), 2)
        self.assertIn('stats.json left unchanged', err)
        self.assertEqual(self.path.read_bytes(), self.before)

    def test_legacy_file_with_one_counted_at(self):
        doc = json.loads(self.before)
        cit = doc['sections'][0]
        del cit['totals_observed_at'], cit['activity_counted_at']
        cit['counted_at'] = '2026-10-27T16:07:00.000Z'
        self.write(doc)
        self.assertEqual(check.citizens_times_fails(cit), [])
        # an earlier read is refused for both groups, as before
        res, err, _ = self.pulse('2026-10-27T16:06:00Z', '2026-10-27T16:00:00Z')
        self.assertEqual(res, 'skipped')
        self.assertEqual(self.path.read_bytes(), self.before)
        # totals read later than the shared time update; the same activity count is a no-op and keeps the shared time
        res, err, _ = self.pulse('2026-10-27T16:40:00Z', '2026-10-27T16:07:00Z', citizens=41)
        self.assertEqual((res, err), ('updated', ''))
        cit = self.cit()
        self.assertEqual((cit['totals_observed_at'], cit['counted_at']), ('2026-10-27T16:40:00.000Z', '2026-10-27T16:07:00.000Z'))
        self.assertNotIn('activity_counted_at', cit)
        self.assertEqual(check.citizens_times_fails(cit), [])
        # a later activity count writes its own time, and the shared one goes
        res, err, _ = self.pulse('2026-10-27T17:10:00Z', '2026-10-27T17:07:00Z', citizens=41)
        self.assertEqual((res, err), ('updated', ''))
        cit = self.cit()
        self.assertEqual(cit['activity_counted_at'], '2026-10-27T17:07:00.000Z')
        self.assertNotIn('counted_at', cit)
        self.assertEqual(check.citizens_times_fails(cit), [])


class CheckTimes(unittest.TestCase):
    def sec(self, **times):
        doc = json.load(open(ROOT / 'atlas' / 'data' / 'stats.json', encoding='utf-8'))
        cit = doc['sections'][0]
        for k in ('counted_at', 'totals_observed_at', 'activity_counted_at'):
            cit.pop(k, None)
        cit.update(times)
        for m in cit['metrics']:
            m['as_of'] = '2026-10-27'
        return cit

    def test_repo_file_passes(self):
        doc = json.load(open(ROOT / 'atlas' / 'data' / 'stats.json', encoding='utf-8'))
        self.assertEqual(check.citizens_times_fails(doc['sections'][0]), [])

    def test_times_must_be_exact_utc_and_match_as_of(self):
        self.assertEqual(check.citizens_times_fails(self.sec(totals_observed_at='2026-10-27T16:40:00.000Z',
                                                             activity_counted_at='2026-10-27T16:07:00Z')), [])
        self.assertTrue(check.citizens_times_fails(self.sec(totals_observed_at='2026-10-27T18:40:00+02:00')))
        self.assertTrue(check.citizens_times_fails(self.sec(activity_counted_at='2026-10-27')))
        self.assertTrue(check.citizens_times_fails(self.sec(counted_at='yesterday')))
        f = check.citizens_times_fails(self.sec(totals_observed_at='2026-10-28T00:05:00.000Z'))   # rows still dated the 27th
        self.assertTrue(f and all('as_of' in x for x in f))
        self.assertTrue(check.citizens_times_fails(self.sec(counted_at='2026-10-27T16:07:00Z', totals_observed_at='2026-10-27T16:40:00Z',
                                                            activity_counted_at='2026-10-27T16:07:00Z')))


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
