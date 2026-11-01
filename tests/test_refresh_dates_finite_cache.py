"""atlas/refresh.py review fixes for the x402-list mappings (PR #270): the source's own as-of time is kept next to our
observed_at, a last-settlement time is never the as-of, NaN/Infinity never pass as numbers or reach the snapshot, and
each URL is requested once per run. Offline: fetch is replaced by fixture API responses, no network."""
import json
import math
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas'))
import refresh

STATS_URL = 'https://x402-list.com/api/v1/stats'
FAC_URL = 'https://x402-list.com/api/v1/facilitators?timeframe=30d&per_page=100'
TS = '2026-11-01T09:44:00Z'


def sources():
    return json.loads((ROOT / 'atlas' / 'refresh-sources.json').read_text(encoding='utf-8'))['sources']


def mapping(mid):
    return next(m for s in sources().values() for m in s.get('numbers', []) if m['id'] == mid)


def stats_doc(as_of='2026-10-28T11:42:52.410Z', volume=326934.950202):
    t = {'unique_buyers_30d': 11129, 'volume_usd_30d': volume, 'settlement_count_30d': 1840501, 'top_10_services_share_pct': 95.4,
         'top_1_service_share_pct': 70.1, 'measured_flow_freshness': {'total_facilitators': 40}}
    if as_of is not None:
        t['as_of'] = as_of
    return {'data': {'total_services': 1200, 'total_endpoints': 5000, 'total_networks': 9, 'facilitator_volume_usd_30d': 2500000.5,
                     'computed_at': '2026-11-01T09:44:10.000Z', 'traction': t}}


def service_doc(last='2026-10-28T12:29:01.000Z', volume=1234.5678):
    return {'data': {'assessment': {'traction': {'volume_usd_30d': volume, 'unique_buyers_30d': 7, 'tx_count_30d': 42,
                                                 'top_buyer_share_30d': 0.4, 'last_settlement_at': last}}}}


def fac_doc(ids):
    return {'meta': {'total': len(ids), 'total_pages': 1},
            'data': [{'facilitator_id': i, 'volume_usd_30d': 1000.25 + n, 'tx_count_30d': 10 + n, 'volume_usd_7d': 100.5,
                      'last_activity_at': '2026-11-01T00:00:00.000Z'} for n, i in enumerate(ids)]}


class FakeFetch:
    """Stands in for refresh.fetch: serves raw JSON bodies by URL and counts the requests."""

    def __init__(self, bodies, fail=()):
        self.bodies, self.fail, self.calls = bodies, set(fail), []

    def __call__(self, url, want_body=False, limit=65536, body_limit=None):
        self.calls.append(url)
        if url in self.fail or url not in self.bodies:
            return {'status': 503, 'body': None, 'error': None, 'final_url': url}
        body = self.bodies[url]
        body = body if isinstance(body, bytes) else json.dumps(body).encode()
        return {'status': 200, 'body': body, 'error': None, 'final_url': url}


def read_with(bodies, m, fail=()):
    fake = FakeFetch(bodies, fail)
    fields = {}
    with mock.patch.object(refresh, 'fetch', fake), mock.patch.object(refresh.time, 'sleep'):
        val, quote, methods, err = refresh.read_mapping(m, fields)
    return val, quote, methods, err, fields, fake


class SourceAsOf(unittest.TestCase):
    def test_traction_as_of_is_kept_next_to_observed_at(self):
        m = mapping('x402-list-traction-30d')
        self.assertEqual(m['as_of_field'], 'data.traction.as_of')
        val, quote, methods, err, fields, _ = read_with({STATS_URL: stats_doc()}, m)
        self.assertIsNone(err)
        self.assertEqual(val, 326934.95)
        self.assertEqual(fields['source_as_of'], '2026-10-28T11:42:52Z')
        self.assertIn('read data.traction.as_of (source as-of time)', methods)
        entry = {'slug': 'x402-list', 'claims': []}
        self.assertEqual(refresh.apply_number(entry, m, val, quote, methods, TS, fields)[0], 'new')
        c = entry['claims'][0]
        self.assertEqual(c['observed_at'], TS)                       # our read, UTC
        self.assertEqual(c['source_as_of'], '2026-10-28T11:42:52Z')  # the source's own snapshot time, UTC
        self.assertNotIn('last_settlement_seen_at', c)

    def test_missing_malformed_or_future_as_of_changes_nothing(self):
        m = mapping('x402-list-traction-30d')
        for bad in (None, 'Oct 28', '2026-10-28', '2027-01-01T00:00:00Z'):
            with self.subTest(as_of=bad):
                val, _q, _m, err, _f, _ = read_with({STATS_URL: stats_doc(as_of=bad)}, m)
                self.assertIsNone(val)
                self.assertIn('data.traction.as_of', err)

    def test_as_of_moving_alone_is_a_re_observation_with_history(self):
        m = mapping('x402-list-traction-30d')
        entry = {'slug': 'x402-list', 'claims': []}
        val, q, me, _e, f, _ = read_with({STATS_URL: stats_doc(as_of='2026-10-21T10:00:00Z')}, m)
        refresh.apply_number(entry, m, val, q, me, '2026-10-25T09:00:00Z', f)
        val, q, me, _e, f, _ = read_with({STATS_URL: stats_doc(as_of='2026-10-28T11:42:52.410Z')}, m)
        what, _old = refresh.apply_number(entry, m, val, q, me, TS, f)
        c = entry['claims'][0]
        self.assertEqual(what, 'note')
        self.assertEqual(c['source_as_of'], '2026-10-28T11:42:52Z')
        self.assertEqual(c['history'][-1]['source_as_of'], '2026-10-21T10:00:00Z')
        self.assertIn('as-of or last-settlement time moved', c['history'][-1]['reason'])
        val, q, me, _e, f, _ = read_with({STATS_URL: stats_doc(as_of='2026-10-28T11:42:52.410Z')}, m)
        self.assertEqual(refresh.apply_number(entry, m, val, q, me, TS, f)[0], 'same')


class LastSettlementIsNotAsOf(unittest.TestCase):
    def test_service_last_settlement_is_its_own_field(self):
        m = mapping('laso-finance-x402-list-30d')
        self.assertNotIn('as_of_field', m)
        self.assertNotIn('see last_settlement_at', m['window'])
        val, quote, methods, err, fields, _ = read_with({m['url']: service_doc()}, m)
        self.assertIsNone(err)
        entry = {'slug': 'laso-finance', 'claims': []}
        refresh.apply_number(entry, m, val, quote, methods, TS, fields)
        c = entry['claims'][0]
        self.assertEqual(c['last_settlement_seen_at'], '2026-10-28T12:29:01Z')
        self.assertNotIn('source_as_of', c)
        self.assertIn('read data.assessment.traction.last_settlement_at (last settlement seen, not the as-of time)', methods)

    def test_no_settlement_yet_is_null_not_an_error(self):
        m = mapping('laso-finance-x402-list-30d')
        val, _q, _m, err, fields, _ = read_with({m['url']: service_doc(last=None, volume=0)}, m)
        self.assertIsNone(err)
        self.assertEqual(val, 0)
        self.assertIsNone(fields['last_settlement_seen_at'])


class NonFinite(unittest.TestCase):
    def test_as_number_rejects_nan_and_infinity(self):
        for v in (float('nan'), float('inf'), float('-inf'), 'NaN', 'Infinity', True, None):
            self.assertIsNone(refresh.as_number(v), v)
        self.assertEqual(refresh.as_number(1.5), 1.5)
        self.assertEqual(refresh.as_number('12'), 12)

    def test_nan_or_infinity_in_the_api_response_is_rejected(self):
        m = mapping('x402-list-traction-30d')
        good = json.dumps(stats_doc())
        for token in ('NaN', 'Infinity', '-Infinity', '1e999'):
            with self.subTest(value=token):
                body = good.replace('326934.950202', token).encode()
                val, _q, _m, err, _f, _ = read_with({STATS_URL: body}, m)
                self.assertIsNone(val)
                self.assertIn('no number at data.traction.volume_usd_30d', err)

    def test_non_finite_quote_or_statement_field_is_rejected(self):
        m = mapping('x402-list-traction-30d')
        body = json.dumps(stats_doc()).replace('"unique_buyers_30d": 11129', '"unique_buyers_30d": NaN').encode()
        val, _q, _m, err, _f, _ = read_with({STATS_URL: body}, m)
        self.assertIsNone(val)
        self.assertEqual(err, 'non-finite number at data.traction.unique_buyers_30d')

    def test_non_finite_sum_is_rejected(self):
        m = {'id': 'sum-test', 'kind': 'economic_flow', 'url': 'https://example.com/list', 'unit': 'USD', 'basis': 'direct_observation',
             'agg': {'op': 'sum', 'list': 'items', 'field': 'v'}}
        body = {'items': [{'v': 1e308}, {'v': 1e308}]}
        val, _q, _m, err, _f, _ = read_with({m['url']: body}, m)
        self.assertIsNone(val)
        self.assertEqual(err, 'sum of v is not a finite number')

    def test_snapshot_dump_is_strict_json(self):
        self.assertEqual(refresh.dump({'v': 1.5}), '{\n "v": 1.5\n}\n')
        for bad in (float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                refresh.dump({'claims': [{'value': bad}]})


class InRunCache(unittest.TestCase):
    def tearDown(self):
        refresh.stop_json_cache()

    def all_x402_mappings(self):
        return [m for s in sources().values() for m in s.get('numbers', []) if m['url'].startswith('https://x402-list.com/')]

    def bodies(self, maps):
        fac_ids = [m['select']['where']['facilitator_id'] for m in maps if m.get('select')]
        out = {STATS_URL: stats_doc(), FAC_URL: fac_doc(fac_ids)}
        out.update({m['url']: service_doc() for m in maps if '/api/v1/services/' in m['url']})
        return out

    def test_each_url_is_requested_once_per_run(self):
        maps = self.all_x402_mappings()
        self.assertEqual(len(maps), 29)          # 3 on the x402-list card, 13 facilitator cards, 13 service cards
        bodies = self.bodies(maps)
        fake = FakeFetch(bodies)
        refresh.start_json_cache()
        with mock.patch.object(refresh, 'fetch', fake), mock.patch.object(refresh.time, 'sleep'):
            errs = [refresh.read_mapping(m, {})[3] for m in maps]
        self.assertEqual(errs, [None] * len(maps))
        unique = {m['url'] for m in maps}
        self.assertEqual(len(unique), 15)
        self.assertEqual(len(fake.calls), 15)    # was 29 without the cache
        self.assertEqual(sorted(fake.calls), sorted(unique))

    def test_a_failing_url_is_not_retried_per_mapping(self):
        maps = [m for m in self.all_x402_mappings() if m['url'] == FAC_URL]
        self.assertEqual(len(maps), 13)
        fake = FakeFetch({}, fail={FAC_URL})
        refresh.start_json_cache()
        with mock.patch.object(refresh, 'fetch', fake), mock.patch.object(refresh.time, 'sleep'):
            errs = [refresh.read_mapping(m, {})[3] for m in maps]
        self.assertTrue(all(e and 'HTTP 503' in e for e in errs))
        self.assertEqual(len(fake.calls), refresh.ATTEMPTS)   # one read (with its retries) for the whole run

    def test_callers_get_their_own_copy(self):
        refresh.start_json_cache()
        with mock.patch.object(refresh, 'fetch', FakeFetch({STATS_URL: stats_doc()})):
            a, _ = refresh.get_json(STATS_URL)
            a['data']['traction']['volume_usd_30d'] = -1
            b, _ = refresh.get_json(STATS_URL)
        self.assertEqual(b['data']['traction']['volume_usd_30d'], 326934.950202)

    def test_cache_is_off_outside_a_run(self):
        fake = FakeFetch({STATS_URL: stats_doc()})
        with mock.patch.object(refresh, 'fetch', fake):
            refresh.get_json(STATS_URL)
            refresh.get_json(STATS_URL)
        self.assertEqual(len(fake.calls), 2)


class Validator(unittest.TestCase):
    """atlas/site/check.py refuses what refresh.py must never write: NaN/Infinity, and as-of / last-settlement times that
    are not normalised UTC (they are kept apart from observed_at)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
        import check
        cls.check = check

    def test_non_finite_claim_or_history_value_is_flagged(self):
        c = {'value': float('nan'), 'history': [{'value': float('inf')}]}
        probs = self.check.claim_number_problems(c, refresh)
        self.assertEqual(len(probs), 2)
        self.assertTrue(all('not a finite number' in p for p in probs))

    def test_dates_must_be_normalised_utc(self):
        ok = {'value': 1.5, 'observed_at': '2026-11-01T09:44:00Z', 'source_as_of': '2026-10-28T11:42:00Z',
              'last_settlement_seen_at': None}
        self.assertEqual(self.check.claim_number_problems(ok, refresh), [])
        for bad in ('2026-10-28', '2026-10-28T13:42:00+02:00', 'yesterday'):
            probs = self.check.claim_number_problems({'value': 1, 'source_as_of': bad}, refresh)
            self.assertEqual(len(probs), 1, bad)

    def test_snapshot_with_a_nan_token_fails_the_check(self):
        import tempfile, os
        snap = {'platforms': [{'slug': 'x', 'claims': [{'value': 1}]}]}
        raw = json.dumps(snap).replace('"value": 1', '"value": NaN')
        with tempfile.TemporaryDirectory() as d:
            fp = os.path.join(d, 'snapshot-verified-2099-01-01.json')
            Path(fp).write_text(raw, encoding='utf-8')
            with mock.patch.object(refresh, 'default_snapshot', return_value=fp):
                fails = self.check.refresh_note_checks()
        self.assertTrue(any('non-finite number NaN' in f for f in fails), fails)


class Display(unittest.TestCase):
    """atlas/site/build.py shows the source's dates on the claim line, apart from our observed_at."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
        import build
        cls.build = build

    def test_source_as_of_and_last_settlement_shown_separately(self):
        html = self.build.source_dates_html({'observed_at': TS, 'source_as_of': '2026-10-28T11:42:00Z',
                                             'last_settlement_seen_at': '2026-10-28T12:29:00Z'})
        self.assertIn('source data as of <time datetime="2026-10-28T11:42Z"', html)
        self.assertIn('last settlement seen <time datetime="2026-10-28T12:29Z"', html)
        self.assertNotIn('2026-11-01', html)                 # observed_at is not repeated here

    def test_nothing_shown_without_source_dates(self):
        self.assertEqual(self.build.source_dates_html({'observed_at': TS}), '')
        self.assertEqual(self.build.source_dates_html({'last_settlement_seen_at': None}), '')


if __name__ == '__main__':
    unittest.main()
