"""Confirmed dates (issue #273, owner decision 2026-11-01): the weekly refresh.py and screens.py write a check record
(confirmed_at, UTC) for every fact they re-read and find unchanged; a re-check never changes observed_at; only a real
change of the value is a new observation. Cards show "Observed <date> · Confirmed <date>" (Confirmed only when a re-check
exists) in HTML, the Markdown twin and platforms/<id>.json; check.py, replications.py and screens_artifact.py refuse a
confirmed_at that is malformed, in the future or earlier than the observation it confirms. Offline, no network."""
import copy
import hashlib
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas'))
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import refresh  # noqa: E402

_spec = importlib.util.spec_from_file_location('atlas_tools_screens_273', ROOT / 'atlas' / 'tools' / 'screens.py')
tools_screens = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tools_screens)
_spec = importlib.util.spec_from_file_location('screens_artifact_273', ROOT / 'atlas' / 'tools' / 'screens_artifact.py')
sa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sa)


def utc(day, hm='02:00'):
    """'2026-11-<day>T<hm>:00Z' (built here so the fixtures read as plain dates)."""
    return f'2026-{day}T{hm}:00' + 'Z'


OBS = utc('10-25')            # first observation
CONF = utc('11-01')           # a later weekly re-check
CONF2 = utc('11-08')          # the next one
MAPPING = {'id': 'demo-users', 'kind': 'metric', 'basis': 'operator_claim', 'unit': 'users', 'url': 'https://demo.example/api/stats'}


def number_entry(value=100):
    return {'slug': 'demo', 'status': 'live', 'claims': [
        {'kind': 'metric', 'statement': f'{value} users', 'value': value, 'unit': 'users', 'window': None, 'basis': 'operator_claim',
         'source_url': MAPPING['url'], 'quote': f'"users":{value}', 'observed_at': OBS, 'methods': ['GET'], 'outcome': 'supported',
         'refresh_id': MAPPING['id']}]}


class RefreshNumbers(unittest.TestCase):
    def test_same_value_sets_confirmed_at_and_keeps_observed_at(self):
        e = number_entry()
        before = copy.deepcopy(e['claims'][0])
        self.assertEqual(refresh.apply_number(e, MAPPING, 100, '"users":100', ['GET again'], CONF), ('same', 100))
        c = e['claims'][0]
        self.assertEqual(c['confirmed_at'], CONF)
        self.assertEqual({k: v for k, v in c.items() if k != 'confirmed_at'}, before, 'nothing but confirmed_at moves')
        self.assertNotIn('history', c)
        # the next week moves confirmed_at forward, observed_at still the first observation
        refresh.apply_number(e, MAPPING, 100, '"users":100', ['GET'], CONF2)
        self.assertEqual((c['observed_at'], c['confirmed_at']), (OBS, CONF2))

    def test_real_change_is_a_new_observation_and_moves_the_confirmation_into_history(self):
        e = number_entry()
        refresh.apply_number(e, MAPPING, 100, '"users":100', ['GET'], CONF)
        what, old = refresh.apply_number(e, MAPPING, 120, '"users":120', ['GET'], CONF2)
        self.assertEqual((what, old), ('changed', 100))
        c = e['claims'][0]
        self.assertEqual((c['value'], c['observed_at']), (120, CONF2))
        self.assertNotIn('confirmed_at', c, 'a new observation starts without a confirmation')
        h = c['history'][-1]
        self.assertEqual((h['value'], h['observed_at'], h['confirmed_at']), (100, OBS, CONF))

    def test_a_new_claim_has_no_confirmation(self):
        e = {'slug': 'demo', 'status': 'live', 'claims': []}
        self.assertEqual(refresh.apply_number(e, MAPPING, 7, '"users":7', ['GET'], CONF)[0], 'new')
        self.assertNotIn('confirmed_at', e['claims'][0])


class RefreshReachability(unittest.TestCase):
    URL = 'https://demo.example'

    def entry(self, status='live', outcome='supported', src=None):
        return {'slug': 'demo', 'status': status, 'claims': [
            {'kind': 'site_reachable', 'statement': 'site answers', 'basis': 'direct_observation', 'outcome': outcome,
             'source_url': src or self.URL, 'observed_at': OBS},
            {'kind': 'description', 'statement': 'd', 'basis': 'direct_observation', 'outcome': 'supported',
             'source_url': self.URL, 'observed_at': OBS}]}

    def test_ok_answer_from_the_claims_own_url_confirms_it(self):
        e = self.entry(src=self.URL + '/')
        self.assertEqual(refresh.confirm_reachability(e, {'cls': 'ok', 'via': self.URL}, CONF), 1)
        self.assertEqual((e['claims'][0]['confirmed_at'], e['claims'][0]['observed_at']), (CONF, OBS))
        self.assertNotIn('confirmed_at', e['claims'][1], 'only site_reachable claims are confirmed by the reachability check')

    def test_blocked_failed_other_url_closed_or_unsupported_confirm_nothing(self):
        for e, r in ((self.entry(), {'cls': 'blocked', 'via': self.URL}),
                     (self.entry(), {'cls': 'fail', 'via': self.URL}),
                     (self.entry(), {'cls': 'ok', 'via': 'https://www.demo.example'}),
                     (self.entry(status='closed'), {'cls': 'ok', 'via': self.URL}),
                     (self.entry(outcome='contradicted'), {'cls': 'ok', 'via': self.URL})):
            self.assertEqual(refresh.confirm_reachability(e, r, CONF), 0, (e['status'], r))
            self.assertFalse(any('confirmed_at' in c for c in e['claims']))


class Validation(unittest.TestCase):
    def test_confirmed_problem(self):
        self.assertIsNone(refresh.confirmed_problem({'observed_at': OBS}))
        self.assertIsNone(refresh.confirmed_problem({'observed_at': OBS, 'confirmed_at': CONF}))
        self.assertIn('earlier than observed_at', refresh.confirmed_problem({'observed_at': CONF, 'confirmed_at': OBS}))
        self.assertIn('future', refresh.confirmed_problem({'observed_at': OBS, 'confirmed_at': '2999-01-01T00:00:00' + 'Z'}))
        self.assertIn('not normalised', refresh.confirmed_problem({'observed_at': OBS, 'confirmed_at': '2026-11-01T02:00' + 'Z'}))
        self.assertIn('not an ISO 8601', refresh.confirmed_problem({'observed_at': OBS, 'confirmed_at': 'last week'}))

    def test_check_py_flags_a_bad_confirmation_on_a_claim_or_in_history(self):
        import check
        good = {'value': 1, 'observed_at': OBS, 'confirmed_at': CONF, 'history': [{'value': 0, 'observed_at': OBS, 'confirmed_at': OBS}]}
        self.assertEqual(check.claim_number_problems(good, refresh), [])
        bad = dict(good, history=[{'value': 0, 'observed_at': CONF, 'confirmed_at': OBS}])
        self.assertTrue(any('confirmed_at' in p for p in check.claim_number_problems(bad, refresh)))

    def test_replications_record_accepts_only_a_later_confirmation(self):
        import replications as R
        sha = 'a' * 40
        rec = {'rows': 2, 'entries': 1, 'entries_replicated': 1, 'independent_agents': 1, 'format': 'agent-errata', 'repo': 'o/r',
               'commit': sha, 'source_url': f'https://github.com/o/r/tree/{sha}/replications',
               'method_url': f'https://github.com/o/r/blob/{sha}/scripts/validate.ts',
               'validate_run_url': 'https://github.com/o/r/actions/runs/1', 'observed_at': OBS}
        self.assertEqual(R.record_problems('x', dict(rec, confirmed_at=CONF)), [])
        self.assertTrue(R.record_problems('x', dict(rec, confirmed_at=utc('10-01'))))
        self.assertTrue(R.record_problems('x', dict(rec, confirmed_at='soon')))
        self.assertEqual(R.published({'x': dict(rec, confirmed_at=CONF)}, 'x')['confirmed_at'], CONF)


class Screens(unittest.TestCase):
    OLD = {'file': 'x.webp', 'dhash': '0000000000000000', 'captured_at': OBS, 'sha256': 'b' * 64}

    def test_no_visible_change_confirms_the_stored_image_only(self):
        now = tools_screens.parse_iso(CONF)
        old = dict(self.OLD, captured_at=utc('09-01'))
        self.assertEqual(tools_screens.decide('x', {'ok': True, 'dhash': '0000000000000003'}, old, now, set()), 'keep:no visible change')
        new = tools_screens.confirm_record(old, CONF)
        self.assertEqual(new, dict(old, confirmed_at=CONF))
        self.assertNotIn('confirmed_at', old, 'the stored record object is not mutated')
        self.assertEqual(tools_screens.confirm_record(new, OBS), new, 'confirmed_at never moves backwards')

    def test_artifact_check_allows_only_a_later_confirmed_at_on_a_stored_entry(self):
        stored = dict(self.OLD, title='t')
        self.assertTrue(sa.only_confirmed(dict(stored, confirmed_at=CONF), stored))
        self.assertTrue(sa.only_confirmed(dict(stored, confirmed_at=CONF2), dict(stored, confirmed_at=CONF)))
        self.assertFalse(sa.only_confirmed(dict(stored, confirmed_at=CONF), dict(stored, confirmed_at=CONF2)), 'backwards')
        self.assertFalse(sa.only_confirmed(dict(stored, confirmed_at=CONF, title='other'), stored), 'another field moved')
        self.assertFalse(sa.only_confirmed(dict(stored), stored), 'no confirmed_at: not a confirmation')

    def test_record_problems_on_confirmed_at(self):
        b = b'x'
        rec = {'file': 'alpha.webp', 'sha256': hashlib.sha256(b).hexdigest(), 'dhash': '00ff00ff00ff00ff', 'website': 'https://a.example',
               'source_url': 'https://a.example/', 'http_status': 200, 'title': 'a', 'captured_at': OBS, 'width': 1200, 'height': 750, 'bytes': 1}
        self.assertEqual(sa.record_problems('alpha', dict(rec, confirmed_at=CONF)), [])
        self.assertTrue(any('earlier than captured_at' in p for p in sa.record_problems('alpha', dict(rec, confirmed_at=utc('10-01')))))
        self.assertTrue(sa.record_problems('alpha', dict(rec, confirmed_at='2999-01-01T00:00:00' + 'Z')))
        self.assertTrue(sa.record_problems('alpha', dict(rec, confirmed_at='2026-11-01')))


class Display(unittest.TestCase):
    """The card page, its Markdown twin and platforms/<id>.json agree: Observed first, then Confirmed when a re-check exists."""

    @classmethod
    def setUpClass(cls):
        import build
        cls.build = build

    def card(self, **extra):
        b = self.build
        cfg = json.loads((ROOT / 'atlas' / 'site' / 'site-config.json').read_text(encoding='utf-8'))
        data = json.loads(Path(b.DEFAULT_DATA).read_text(encoding='utf-8'))
        c = copy.deepcopy(next(p for p in data['platforms'] if p['slug'] == 'laso-finance'))
        x = next(x for x in c['claims'] if x['kind'] == 'economic_flow')
        x['observed_at'] = OBS
        for k in ('confirmed_at', 'source_as_of', 'last_settlement_seen_at'):
            x.pop(k, None)
        x.update(extra)
        site = b.Site(cfg, dict(data, platforms=[c]))
        site.removed, site.safety, site.claim_labels, site.img_v, site.asset_v = [], b.load_link_safety(), {}, 'test', 'test'
        b.enrich(site, {})
        c = site.cards[0]
        return b.build_platform(site, c), b.build_platform_md(site, c), b.platform_json_claims(c)

    def test_observed_then_confirmed_in_html_markdown_and_json(self):
        html, md, claims = self.card(confirmed_at=CONF)
        o, k = self.build.parse_time(OBS), self.build.parse_time(CONF)
        self.assertRegex(html, r'Observed <time datetime="[^"]+" title="' + re.escape(o.strftime('%Y-%m-%d %H:%M UTC')) + r'">[^<]+</time>'
                         r' · Confirmed <time datetime="[^"]+" title="' + re.escape(k.strftime('%Y-%m-%d %H:%M UTC')) + r'">'
                         + re.escape(self.build.fmt_date(k)) + '</time>')
        self.assertIn(f'| {o.strftime("%Y-%m-%d %H:%M UTC")} · Confirmed {k.strftime("%Y-%m-%d %H:%M UTC")} |', md)
        rec = next(y for y in claims if y.get('confirmed_at'))
        self.assertEqual((rec['observed_at'], rec['confirmed_at']), (OBS, CONF))

    def test_confirmed_comes_before_source_dates(self):
        html, md, _ = self.card(confirmed_at=CONF, source_as_of=utc('10-24'))
        self.assertRegex(html, r'Observed <time[^>]+>[^<]+</time> · Confirmed <time[^>]+>[^<]+</time> · source data as of <time')
        self.assertRegex(md, r'UTC · Confirmed [0-9-]+ [0-9:]+ UTC · source data as of ')

    def test_only_observed_without_a_recheck_or_with_a_bad_one(self):
        for extra in ({}, {'confirmed_at': utc('10-01')}, {'confirmed_at': 'soon'}):
            html, md, _ = self.card(**extra)
            self.assertNotIn('Confirmed <time', html, extra)
            self.assertNotIn('· Confirmed ', md, extra)
            self.assertIn('Observed <time', html)

    def test_replication_and_screenshot_lines(self):
        b = self.build
        sha = 'a' * 40
        r = {'rows': 2, 'entries': 1, 'entries_replicated': 1, 'independent_agents': 1, 'repo': 'o/r', 'commit': sha,
             'source_url': 'https://github.com/o/r', 'method_url': 'https://github.com/o/r', 'validate_run_url': 'https://github.com/o/r',
             'observed_at': OBS, 'confirmed_at': CONF}
        self.assertRegex(b.repl_html(r), r'Observed <time[^>]+>[^<]+</time> · Confirmed <time[^>]+>[^<]+</time>\.')
        self.assertTrue(b.repl_md(r)[-1].endswith(f'Observed {OBS} · Confirmed {CONF}.'))
        self.assertTrue(b.repl_md(dict(r, confirmed_at=None))[-1].endswith(f'Observed {OBS}.'))


class ApiContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import api_v1
        import build
        cls.api_v1, cls.build = api_v1, build
        cls.reg = api_v1.schemas('https://commonworld.one', ['payments'])

    def test_confirmed_at_declared_optional_nullable_utc(self):
        defs = self.reg['platform.schema.json']['$defs']
        for where, schema in (('claim', defs['claim']), ('preview', defs['preview']),
                              ('replications', defs['platformSummary']['properties']['replications'])):
            prop = schema['properties']['confirmed_at']
            self.assertEqual(prop['type'], ['string', 'null'], where)
            self.assertIn('1.11.0', prop['description'], where)
            self.assertNotIn('confirmed_at', schema.get('required', []), where)

    def test_release_1_11_0(self):
        self.assertEqual(self.api_v1.SCHEMA_VERSION, '1.11.0')
        top = self.api_v1.CHANGELOG[0]
        self.assertEqual(top['schema_version'], '1.11.0')
        self.assertIn('`confirmed_at`', ' '.join(top['changes']))

    def test_emitted_claim_validates(self):
        rec = {'kind': 'metric', 'statement': 's', 'basis': 'operator_claim', 'outcome': 'supported', 'value': 1,
               'observed_at': OBS, 'confirmed_at': CONF}
        val = lambda r: self.api_v1.validate(r, {'$ref': 'platform.schema.json#/$defs/claim'}, self.reg, 'platform.schema.json')
        self.assertEqual(val(self.build.rfc3339(rec)), [])
        self.assertEqual(val(dict(rec, confirmed_at=None)), [])
        self.assertTrue(val(dict(rec, confirmed_at='2026-11-01 02:00')))

    def test_docs_and_llms_mention_confirmed_dates(self):
        src = (ROOT / 'atlas' / 'site' / 'build.py').read_text(encoding='utf-8')
        for marker in ('id="confirmed-dates"', '- Confirmed dates (schema_version 1.11.0)', '- Confirmed dates: a claim may carry confirmed_at',
                       "'Confirmed dates (schema_version 1.11.0)"):
            self.assertIn(marker, src)


class RefreshRun(unittest.TestCase):
    """refresh.main() end to end on a temporary snapshot (check and read_mapping stubbed): an unchanged week writes
    confirmed_at for the re-read number and the reachability claim, keeps observed_at, and lists them in the amendment."""

    def test_unchanged_week_writes_confirmations_only(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            e = number_entry()
            e.update(name='Demo', canonical_url='https://demo.example')
            e['claims'].append({'kind': 'site_reachable', 'statement': 'site answers', 'value': None, 'unit': None, 'window': None,
                                'basis': 'direct_observation', 'source_url': 'https://demo.example', 'quote': 'q', 'observed_at': OBS,
                                'methods': ['GET'], 'outcome': 'supported'})
            snap = td / 'snapshot-verified-2026-10-15.json'
            snap.write_text(json.dumps({'generated_at': OBS, 'count': 1, 'platforms': [e], 'amendments': []}))
            src = td / 'sources.json'
            src.write_text(json.dumps({'sources': {'demo': {'numbers': [MAPPING]}}}))
            ok = {'cls': 'ok', 'status': 200, 'final_url': 'https://demo.example/', 'error': None, 'attempts': 1,
                  'methods': ['GET https://demo.example -> 200'], 'via': 'https://demo.example'}
            argv = ['refresh.py', '--snapshot', str(snap), '--sources', str(src), '--state', str(td / 'state.json'),
                    '--replications', str(td / 'replications.json'), '--summary', str(td / 'summary.md'), '--workers', '1']
            with mock.patch.object(sys, 'argv', argv), mock.patch.object(refresh, 'check', lambda url, extra=(): dict(ok)), \
                    mock.patch.object(refresh, 'read_mapping', lambda m, fields=None: (100, '"users":100', ['GET'], None)), \
                    mock.patch.object(refresh, 'now_iso', lambda: CONF), mock.patch('builtins.print'):
                refresh.main()
            out = json.loads(snap.read_text())
            claims = out['platforms'][0]['claims']
            self.assertEqual([(c['observed_at'], c.get('confirmed_at')) for c in claims], [(OBS, CONF), (OBS, CONF)])
            self.assertEqual([c['value'] for c in claims], [100, None])
            self.assertFalse(any('history' in c for c in claims), 'a confirmation is not a re-observation')
            self.assertEqual(out['amendments'][-1]['confirmed'], ['demo:site_reachable', 'demo:demo-users'])
            self.assertEqual(out['amendments'][-1]['number_updates'], [])
            self.assertIn('| facts confirmed unchanged (confirmed_at set, observed_at kept) | 2 |', (td / 'summary.md').read_text())


if __name__ == '__main__':
    unittest.main()
