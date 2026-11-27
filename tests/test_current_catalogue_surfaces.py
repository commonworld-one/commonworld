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
    def test_current_only_counts_and_explicit_archive_contract(self):
        d=json.loads((DIST/'api/v1/atlas/index.json').read_text())
        rows=json.loads((DIST/'atlas/platforms.json').read_text())['platforms']
        archive=json.loads((DIST/'atlas/closed.json').read_text())['platforms']
        self.assertEqual(d['current_counts'], {'dated_overviews':len(rows),'live':len(rows)})
        self.assertEqual(d['counts']['live'],len(rows))
        self.assertEqual(len(rows),356); self.assertEqual(len(archive),39)
        self.assertFalse({r['id'] for r in rows} & {r['id'] for r in archive})
        self.assertEqual(sum(c['count'] for c in d['categories']),len(rows))
        self.assertTrue(all(r.get('overview') and r['status']=='live' and 'claims' not in r for r in rows))


    def test_commonworld_about_uses_current_and_archive_counts(self):
        s=(DIST/'about/index.html').read_text()
        self.assertIn('356 current source overviews, 39 closed-history records',s)
        self.assertNotIn('0 could not verify',s)
        self.assertNotIn('Current local views',s)
        for category in ['social','worlds','work','payments','research','verification','arenas','registries','wiki','projects']:
            self.assertNotIn('could not verify',(DIST/f'atlas/categories/{category}/index.html').read_text())

    def test_current_guides_have_no_blanket_verification_claim(self):
        for path in ['llms.txt','llms-full.txt','atlas/llms.txt','index.html','atlas/index.md','about/index.html','api/v1/index.json']:
            with self.subTest(path=path):
                s=(DIST/path).read_text().lower()
                self.assertFalse('a verified catalog' in s, path+' blanket catalogue claim')
                self.assertFalse('every fact checked' in s, path+' blanket fact claim')
                self.assertFalse('every card checked against' in s,path+' blanket card claim')
        for path in ['llms.txt','llms-full.txt','atlas/llms.txt','atlas/api/index.html']:
            with self.subTest(path=path):
                self.assertTrue('overview' in (DIST/path).read_text(),path+' missing current-view guide')
                self.assertNotIn('current_limitation',(DIST/path).read_text())

    def test_current_earning_selection_matches_source(self):
        d=json.loads((DIST/'atlas/earn.json').read_text())
        selection=json.loads((ROOT/'atlas/catalogue/earning.json').read_text())['cards']
        overviews=json.loads((ROOT/'atlas/catalogue/overviews.json').read_text())['cards']
        self.assertEqual(d['format'],'commonworld-atlas-earning-opportunities/1')
        self.assertEqual(d['count'],len(selection))
        self.assertEqual({r['id'] for r in d['rows']},set(selection))
        self.assertEqual(d['rows'],sorted(d['rows'],key=lambda r:(r['name'].casefold(),r['id'])))
        self.assertIn('not proof of payment',d['fields_note'])
        self.assertNotIn('Not current earnings',d['fields_note'])
        for row in d['rows']:
            self.assertEqual(set(row),{'id','name','url','json_url','category','description','visited_at','sources'})
            self.assertEqual(row['description'],selection[row['id']]['description'])
            self.assertEqual(row['visited_at'],overviews[row['id']]['visited_at'])
            self.assertEqual(row['sources'],overviews[row['id']]['sources'])
        api=json.loads((DIST/'api/v1/atlas/earn.json').read_text())
        self.assertEqual(d['rows'],api['rows'])

    def test_stats_dates_are_not_renamed_visits(self):
        d=json.loads((DIST/'stats.json').read_text())
        section=next(s for s in d['sections'] if s['id']=='atlas')
        self.assertIn('356 Live source overviews',section['intro'])
        metric=next(m for m in section['metrics'] if m['id']=='atlas_last_verified')
        self.assertEqual('Newest overview visit',metric['label'])

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
        self.assertIn('Do not wait for a weekly refresh',text)
        self.assertNotIn('next refresh will update it',text)
        self.assertNotIn('weekly refresh keeps only',text)
        form=(ROOT/'.github/ISSUE_TEMPLATE/atlas-correction.yml').read_text()
        self.assertIn('Do not wait for a weekly refresh',form)
        self.assertNotIn('This value is not on the auto-refresh list',form)

    def test_example_badge_alts_are_neutral(self):
        for name in ['README.md']:
            text=(ROOT/name).read_text()
            self.assertNotIn('![Commonworld Atlas: Verified]',text)
            self.assertIn('Commonworld Atlas legacy badge',text)
        self.assertNotIn('rebuilt with every weekly check',(ROOT/'README.md').read_text())

    @unittest.skipUnless(current_build(), 'actual current-view accepted catalogue required')
    def test_generated_automation_statements_have_nearby_legacy_scope(self):
        guide=(DIST/'llms.txt').read_text()
        self.assertIn('Legacy refresh and screenshot jobs are paused.',guide)
        self.assertIn('No new recurring overview or trial schedule is activated',guide)
        self.assertNotIn('Screenshots are re-captured weekly',guide)
        closed=(DIST/'atlas/closed/index.html').read_text()
        self.assertIn('not a current schedule or service-state promise',closed)
        self.assertIn('Archived cards are never reopened automatically',closed)
        self.assertNotIn('by this candidate',closed)

if __name__=='__main__': unittest.main()
