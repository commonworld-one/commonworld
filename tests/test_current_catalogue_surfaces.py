"""Current local copy and metadata, checked against the actual accepted-generator output."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'atlas/site/dist'

def current_build():
    p=DIST/'api/v1/atlas/index.json'
    return p.is_file() and 'current_counts' in json.loads(p.read_text())

@unittest.skipUnless(current_build(), 'actual current-view accepted catalogue required')
class CurrentCatalogueSurfaces(unittest.TestCase):
    def test_additive_counts_preserve_legacy_contract(self):
        d=json.loads((DIST/'api/v1/atlas/index.json').read_text())
        self.assertEqual(d['current_counts'], {'dated_overviews':348,'could_not_verify':18,'closed_history':20})
        self.assertEqual(d['counts']['live'],366)
        self.assertIn('legacy',d['counts_note'])
        self.assertEqual(sum(c['current_counts']['could_not_verify'] for c in d['categories']),18)

    def test_current_guides_have_no_blanket_verification_claim(self):
        for path in ['llms.txt','llms-full.txt','atlas/llms.txt','index.html','atlas/index.md','about/index.html','api/v1/index.json']:
            with self.subTest(path=path):
                s=(DIST/path).read_text().lower()
                self.assertFalse('a verified catalog' in s, path+' blanket catalogue claim')
                self.assertFalse('every fact checked' in s, path+' blanket fact claim')
                self.assertFalse('every card checked against' in s,path+' blanket card claim')
        for path in ['llms.txt','llms-full.txt','atlas/llms.txt','atlas/api/index.html']:
            with self.subTest(path=path):
                self.assertTrue('current_limitation' in (DIST/path).read_text(),path+' missing current-view guide')

    def test_historical_money_metadata(self):
        d=json.loads((DIST/'atlas/earn.json').read_text())
        self.assertIn('Historical',d['fields_note'])
        self.assertIn('Not current earnings',d['fields_note'])
        self.assertTrue(d['rows'])

    def test_stats_dates_are_not_renamed_visits(self):
        d=json.loads((DIST/'stats.json').read_text())
        section=next(s for s in d['sections'] if s['id']=='atlas')
        self.assertIn('348 dated overviews',section['intro'])
        metric=next(m for m in section['metrics'] if m['id']=='atlas_last_verified')
        self.assertIn('historical claim',metric['label'])

    def test_current_category_metadata_not_legacy_live_count(self):
        for p in (DIST/'atlas/categories').glob('*/index.html'):
            for raw in re.findall(r'<script type="application/ld\+json">(.*?)</script>',p.read_text(),re.S):
                d=json.loads(raw)
                if d.get('@type')=='Dataset':
                    self.assertNotRegex(d.get('description',''),r'\d+ live')

class RepairOperationalGuidance(unittest.TestCase):
    def test_current_build_recipes_bind_exact_captures(self):
        for name in ['README.md','AGENTS.md','atlas/site/README.md']:
            text=(ROOT/name).read_text()
            self.assertIn('catalogue_build.py --mode accepted --screens-dir /path/to/exact-reviewed-captures',text)
            self.assertIn('CW_SCREENS_DIR=/path/to/exact-reviewed-captures CW_SCREENS_REQUIRED=1 python3 atlas/site/check.py',text)
        agents=(ROOT/'AGENTS.md').read_text()
        self.assertFalse(any(line.strip().startswith('python3 atlas/site/build.py') for line in agents.splitlines()))

    def test_corrections_not_deferred_to_unverified_schedule(self):
        text=(ROOT/'docs/AGENTS-CONTRIBUTING.md').read_text()
        self.assertIn('Report a stale value',text)
        self.assertIn('Do not wait for Sunday',text)
        self.assertNotIn('next refresh will update it',text)
        self.assertNotIn('weekly refresh keeps only',text)
        form=(ROOT/'.github/ISSUE_TEMPLATE/atlas-correction.yml').read_text()
        self.assertIn('Do not wait for a weekly refresh',form)
        self.assertNotIn('This value is not on the auto-refresh list',form)

    def test_example_badge_alts_are_neutral(self):
        for name in ['README.md','BADGE.md']:
            text=(ROOT/name).read_text()
            self.assertNotIn('![Commonworld Atlas: Verified]',text)
            self.assertIn('Commonworld Atlas legacy badge',text)
        self.assertNotIn('rebuilt with every weekly check',(ROOT/'README.md').read_text())

    @unittest.skipUnless(current_build(), 'actual current-view accepted catalogue required')
    def test_generated_automation_statements_have_nearby_legacy_scope(self):
        guide=(DIST/'llms.txt').read_text()
        self.assertIn('This describes stored code, not an active schedule',guide)
        self.assertIn('Historical screenshot workflow reference',guide)
        self.assertNotIn('Screenshots are re-captured weekly',guide)
        closed=(DIST/'atlas/closed/index.html').read_text()
        self.assertIn('not a current schedule or service-state promise',closed)
        self.assertIn('Periodic cutover remains open',closed)

if __name__=='__main__': unittest.main()
