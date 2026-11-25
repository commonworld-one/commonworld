"""Offline regressions from review of the current catalogue contract."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas/site'))
import build
import check
import events


class StopAtSite(Exception):
    pass


class ReviewRegressions(unittest.TestCase):
    def projected_input(self, removed=(), explicit=False):
        captured = {}
        def site(cfg, data):
            captured.update(copy.deepcopy(data))
            raise StopAtSite()
        argv = ['build.py', '--no-mirror']
        if explicit:
            argv += ['--data', str(ROOT/'atlas/catalogue/snapshot.json'), '--overviews', str(ROOT/'atlas/catalogue/overviews.json')]
        with patch.object(sys, 'argv', argv), patch.object(build, 'load_removed', return_value=list(removed)), patch.object(build, 'Site', side_effect=site):
            with self.assertRaises(StopAtSite):
                build.main()
        return captured

    def test_bare_builder_selects_current_inputs_and_additions(self):
        data = self.projected_input()
        ids = {c['slug'] for c in data['platforms']}
        self.assertIn('aptets', ids)
        self.assertEqual(next(c for c in data['platforms'] if c['slug'] == 'agent-knowledge-network')['status'], 'closed')

    def test_safety_suppression_runs_after_editorial_additions(self):
        data = self.projected_input([{'slug': 'aptets'}], explicit=True)
        self.assertNotIn('aptets', {c['slug'] for c in data['platforms']})
        self.assertEqual(data['count'], len(data['platforms']))

    def test_explicit_custom_data_never_silently_switches_inputs(self):
        for data in ['/tmp/not-read.json', build.DEFAULT_DATA]:
            with patch.object(sys, 'argv', ['build.py', '--data', data]), patch.object(build, 'Site') as site:
                with self.assertRaises(SystemExit) as ex:
                    build.main()
                self.assertEqual(ex.exception.code, 2)
                site.assert_not_called()

    def test_events_use_retained_archive_when_current_cards_are_filtered(self):
        ev = {'date': '2026-11-01', 'slug': 'closed-one', 'type': 'closed', 'reason': 'Historical source https://old.example/', 'source': 'https://old.example/'}
        site = SimpleNamespace(catalogue_mode=True, cards=[{'slug': 'open-one', 'status': 'live'}], all_cards=[{'slug': 'closed-one', 'status': 'closed'}], base='/atlas', cfg={}, abs=lambda p: 'https://commonworld.one' + p)
        before = copy.deepcopy(ev)
        out = events.doc(site, [ev], '2026-11-25T00:00:00Z')
        self.assertNotIn('https://old.example', json.dumps(out))
        self.assertNotIn('<https://old.example', events.markdown(site, [ev]))
        self.assertEqual(ev, before)

    def test_generated_archive_headers_and_event_checker_reject_old_projection(self):
        dist = ROOT / 'atlas/site/dist'
        if not (dist / 'atlas/closed.json').exists():
            self.skipTest('accepted current build required')
        self.assertIn('/atlas/closed.json\n  Access-Control-Allow-Origin: *\n  Content-Type: application/json; charset=utf-8\n  X-Robots-Tag: noindex', (dist / '_headers').read_text())
        self.assertEqual(check.events_checks(), [])
        with tempfile.TemporaryDirectory() as td:
            import shutil
            fake = Path(td)
            shutil.copytree(dist / 'atlas', fake / 'atlas', ignore=shutil.ignore_patterns('assets', 'screens', 'og'))
            shutil.copy(dist / '_headers', fake / '_headers')
            p = fake / 'atlas/events.json'
            doc = json.loads(p.read_text())
            row = next(e for e in doc['events'] if e['slug'] == 'issuehunt')
            row['source'] = 'https://oss.issuehunt.io'
            p.write_text(json.dumps(doc))
            with patch.object(check, 'DIST', str(fake)):
                self.assertTrue(any('events differ' in f for f in check.events_checks()))

    def test_published_mcp_guidance_is_current_only(self):
        guide = (ROOT / 'platform/docs/MCP.md').read_text()
        self.assertNotIn('status=limited', guide)
        self.assertNotIn('status=closed', guide)
        self.assertNotIn('has_money_flow,', guide)
        self.assertIn('intentional', (ROOT / 'platform/src/pages/agent-docs.ts').read_text().lower())
        self.assertIn('Intentional breaking replacement', (ROOT / 'platform/CHANGELOG.md').read_text())
