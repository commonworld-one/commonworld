"""Weekly refresh of the x402-list-sourced cards (atlas/refresh.py `select` + `round`, and the mapping owning a claim's
source and window). Offline: get_json is mocked, no network."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas'))
import refresh

FAC = 'https://x402-list.com/api/v1/facilitators?timeframe=30d&per_page=100'
FLUXA = {'id': 'fluxa-x402-list-30d', 'kind': 'economic_flow', 'url': FAC,
         'select': {'list': 'data', 'where': {'facilitator_id': 'fluxa'}}, 'path': 'volume_usd_30d', 'round': 2,
         'unit': 'USDC (gross settlement)', 'window': 'trailing 30d at observation time', 'basis': 'independent_source',
         'quote_fields': ['volume_usd_30d', 'tx_count_30d', 'volume_usd_7d', 'last_activity_at'],
         'statement': 'x402-list on-chain measurement: FluxA facilitator settled ${value} over 30 d ({tx_count_30d} settlements; '
                      '${volume_usd_7d} over the last 7 d), settlement to anyone (gross, not seller revenue)',
         'match': {'source_url': 'https://x402-list.com/facilitators', 'unit': 'USDC (gross settlement)'}}


def facilitators(*rows):
    return {'meta': {'total': len(rows), 'total_pages': 1}, 'data': list(rows)}


ROW_FLUXA = {'facilitator_id': 'fluxa', 'volume_usd_30d': 846278.634, 'tx_count_30d': 333710, 'volume_usd_7d': 84588.54,
             'last_activity_at': '2026-10-31T00:00:00.000Z'}
ROW_OTHER = {'facilitator_id': 'coinbase', 'volume_usd_30d': 525465.77, 'tx_count_30d': 2341384, 'volume_usd_7d': 95503.12}


def read(m, d):
    fields = {}
    with mock.patch.object(refresh, 'get_json', return_value=(d, None)):
        val, quote, methods, err = refresh.read_mapping(m, fields)
    return val, quote, methods, err, fields


def hand_claim():
    """The claim as it was entered by hand on 2026-10-15 from the HTML facilitators page."""
    return {'kind': 'economic_flow', 'statement': 'x402-list on-chain measurement: FluxA facilitator settled $323.1k over 30 d '
                                                  '($143.5k over 7 d), settlement to anyone (gross, not seller revenue).',
            'value': '$323.1k', 'unit': 'USDC (gross settlement)', 'window': '30d to 2026-10-15', 'basis': 'independent_source',
            'source_url': 'https://x402-list.com/facilitators', 'quote': 'FluxA ... $143.5k $323.1k', 'observed_at': '2026-10-15T18:10Z',
            'outcome': 'supported'}


class Select(unittest.TestCase):
    def test_reads_the_one_matching_row_and_renders_from_it(self):
        val, quote, methods, err, fields = read(FLUXA, facilitators(ROW_OTHER, ROW_FLUXA))
        self.assertIsNone(err)
        self.assertEqual(val, 846278.63)                       # round: 2 on the published value
        self.assertIn('"volume_usd_30d":846278.634', quote)    # the quote keeps the source's raw number
        self.assertIn('select the one row of data with facilitator_id=fluxa (2 rows read)', methods)
        text, missing = refresh.render_statement(FLUXA['statement'], val, fields)
        self.assertEqual(missing, [])
        self.assertIn('settled $846,278.63 over 30 d (333,710 settlements; $84,588.54 over the last 7 d)', text)

    def test_missing_row_is_an_error_never_zero(self):
        val, _q, _m, err, _f = read(FLUXA, facilitators(ROW_OTHER))
        self.assertIsNone(val)
        self.assertIn('0 rows of data match facilitator_id=fluxa', err)

    def test_duplicated_row_is_an_error(self):
        val, _q, _m, err, _f = read(FLUXA, facilitators(ROW_FLUXA, dict(ROW_FLUXA)))
        self.assertIsNone(val)
        self.assertIn('2 rows of data match', err)

    def test_no_list_is_an_error(self):
        val, _q, _m, err, _f = read(FLUXA, {'data': {'facilitator_id': 'fluxa'}})
        self.assertIsNone(val)
        self.assertIn('no list at data', err)

    def test_round_on_plain_path_mapping(self):
        m = {'id': 'x', 'url': 'https://x402-list.com/api/v1/stats', 'path': 'data.traction.volume_usd_30d', 'round': 2}
        val, quote, methods, err, _f = read(m, {'data': {'traction': {'volume_usd_30d': 326934.950202}}})
        self.assertIsNone(err)
        self.assertEqual(val, 326934.95)
        self.assertEqual(quote, '"volume_usd_30d":326934.950202')
        self.assertIn('read data.traction.volume_usd_30d (rounded to 2 decimals)', methods)

    def test_round_keeps_integers(self):
        self.assertEqual(refresh.round_value(1204, 2), 1204)
        self.assertEqual(refresh.round_value(12.5, 0), 12)
        self.assertEqual(refresh.round_value(1.23456, None), 1.23456)


class OwnsSourceAndWindow(unittest.TestCase):
    def test_hand_entered_claim_takes_the_api_source_and_rolling_window(self):
        e = {'slug': 'fluxa', 'claims': [hand_claim()]}
        val, quote, methods, err, fields = read(FLUXA, facilitators(ROW_FLUXA))
        what, old = refresh.apply_number(e, FLUXA, val, quote, methods, '2026-11-01T02:00:00Z', fields)
        c = e['claims'][0]
        self.assertEqual((what, old), ('changed', '$323.1k'))
        self.assertEqual(c['value'], 846278.63)
        self.assertEqual(c['source_url'], FAC)
        self.assertEqual(c['window'], 'trailing 30d at observation time')
        self.assertEqual(c['refresh_id'], 'fluxa-x402-list-30d')
        h = c['history'][-1]
        self.assertEqual((h['value'], h['source_url'], h['window']), ('$323.1k', 'https://x402-list.com/facilitators', '30d to 2026-10-15'))
        self.assertIn('source and window now from the mapping', h['reason'])
        self.assertIsNone(refresh.note_drift(c, FLUXA))
        # a second run with the same fetch changes nothing
        again = refresh.apply_number(e, FLUXA, val, quote, methods, '2026-11-08T02:00:00Z', fields)
        self.assertEqual(again, ('same', 846278.63))
        self.assertEqual(len(c['history']), 1)

    def test_published_source_keeps_the_reviewed_page(self):
        # the configured facilitator mappings keep the HTML page a curator reviewed (atlas/data/evidence-levels.json) as the
        # claim's source; the JSON the script read is in methods and in verify
        m = dict(FLUXA, source_url='https://x402-list.com/facilitators',
                 verify={'url': FAC, 'note': 'The same figure as JSON: the one row of data with facilitator_id=fluxa.'})
        self.assertEqual(refresh.mapping_problems(m), [])
        e = {'slug': 'fluxa', 'claims': [hand_claim()]}
        val, quote, methods, err, fields = read(m, facilitators(ROW_FLUXA))
        refresh.apply_number(e, m, val, quote, methods, '2026-11-01T02:00:00Z', fields)
        c = e['claims'][0]
        self.assertEqual(c['source_url'], 'https://x402-list.com/facilitators')
        self.assertEqual(c['verify']['url'], FAC)
        self.assertIn(f'GET {FAC}', c['methods'])
        self.assertEqual(c['window'], 'trailing 30d at observation time')
        self.assertNotIn('source and window now from the mapping', c['history'][-1]['reason'].split(';')[0])
        bad = dict(m, source_url='https://example.org/facilitators')
        self.assertTrue(any('source_url must be' in p for p in refresh.mapping_problems(bad)))

    def test_same_value_but_dated_window_is_a_note_re_observation(self):
        m = {'id': 'x402-list-services', 'kind': 'metric', 'url': 'https://x402-list.com/api/v1/stats', 'path': 'data.total_services',
             'unit': 'services', 'basis': 'direct_observation', 'window': 'now (at observation time)',
             'match': {'source_url': 'https://x402-list.com/api/v1/stats', 'unit': 'services'}}
        c = {'kind': 'metric', 'statement': '1,204 services', 'value': 1204, 'unit': 'services', 'window': '2026-10-15',
             'basis': 'direct_observation', 'source_url': m['url'], 'quote': '"total_services":1204', 'outcome': 'supported',
             'observed_at': '2026-10-25T19:17:00Z', 'refresh_id': m['id']}
        e = {'slug': 'x402-list', 'claims': [c]}
        what, _old = refresh.apply_number(e, m, 1204, '"total_services":1204', ['GET'], '2026-11-01T02:00:00Z', {})
        self.assertEqual(what, 'note')
        self.assertEqual(c['window'], 'now (at observation time)')
        self.assertEqual(c['history'][-1]['window'], '2026-10-15')

    def test_mapping_without_window_leaves_the_window_alone(self):
        m = {'id': 'm', 'kind': 'metric', 'url': 'https://example.org/s', 'path': 'n', 'unit': 'agents', 'basis': 'operator_claim'}
        c = {'kind': 'metric', 'statement': '5 agents', 'value': 5, 'unit': 'agents', 'window': 'all-time', 'basis': 'operator_claim',
             'source_url': m['url'], 'quote': '"n":5', 'outcome': 'supported', 'observed_at': '2026-10-25T19:17:00Z', 'refresh_id': 'm'}
        e = {'slug': 's', 'claims': [c]}
        self.assertEqual(refresh.apply_number(e, m, 5, '"n":5', ['GET'], '2026-11-01T02:00:00Z', {}), ('same', 5))
        self.assertNotIn('history', c)

    def test_summary_shows_a_hand_entered_old_value(self):
        self.assertEqual(refresh.fmt_value('$323.1k'), '$323.1k')
        self.assertEqual(refresh.fmt_value(846278.63), '846,278.63')


class Lint(unittest.TestCase):
    def test_select_and_round_problems(self):
        self.assertEqual(refresh.mapping_problems(FLUXA), [])
        bad = dict(FLUXA, select={'list': 'data', 'where': {}})
        self.assertTrue(any('select must be' in p for p in refresh.mapping_problems(bad)))
        with_agg = {'id': 'a', 'url': FAC, 'agg': {'list': 'data', 'op': 'count'}, 'select': FLUXA['select']}
        self.assertTrue(any('select is only for path mappings' in p for p in refresh.mapping_problems(with_agg)))
        for r in (True, -1, 7, 1.5):
            self.assertTrue(any('round must be' in p for p in refresh.mapping_problems(dict(FLUXA, round=r))), r)


class Config(unittest.TestCase):
    """Every x402-list mapping in atlas/refresh-sources.json lints clean and continues exactly one existing claim, so the
    weekly run updates the card's own number instead of adding a second one beside it."""

    def test_x402_list_mappings_match_one_claim_each(self):
        srcs = json.loads((ROOT / 'atlas' / 'refresh-sources.json').read_text(encoding='utf-8'))['sources']
        snap = json.loads(Path(refresh.default_snapshot()).read_text(encoding='utf-8'))
        by = {e['slug']: e for e in snap['platforms']}
        seen = 0
        for slug, v in srcs.items():
            for m in v.get('numbers', []):
                if 'x402-list.com' not in m['url']:
                    continue
                seen += 1
                self.assertEqual(refresh.mapping_problems(m), [], m['id'])
                self.assertIn(slug, by, m['id'])
                mt = m['match']
                hits = [c for c in by[slug]['claims'] if c.get('refresh_id') == m['id'] or (
                    c.get('source_url') in (mt['source_url'], m['url']) and c.get('unit') == mt['unit']
                    and c.get('kind') == m['kind'] and c.get('basis') == m['basis'])]
                self.assertEqual(len(hits), 1, f'{slug} {m["id"]}: {len(hits)} claims')
        self.assertGreaterEqual(seen, 28)


if __name__ == '__main__':
    unittest.main()
