import json,re,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];D=ROOT/'atlas/site/dist'
@unittest.skipUnless((D/'atlas/closed.json').exists(),'current build required')
class ReleasePreparation(unittest.TestCase):
    def test_public_contract_has_no_local_release_placeholders(self):
        for f in ['api/v1/index.json','api/v1/changelog.json','api/v1/openapi.json','api/v1/CHANGELOG.md','atlas/api/index.html','atlas/llms.txt']:
            s=(D/f).read_text().lower()
            for term in ['local candidate','local build contract','proof of a production deployment','proof of deployment']:
                self.assertNotIn(term,s,f)
    def test_closure_reason_uses_role_not_private_person(self):
        d=json.loads((ROOT/'atlas/catalogue/closures.json').read_text())
        self.assertEqual(d['reason'],'Explicit editorial closure decisions recorded 24 November 2026. Aptets is a distinct new entry.')
        for row in json.loads((D/'atlas/closed.json').read_text())['platforms']:
            for event in row['archive']['history'].get('status_history',[]):
                if event.get('on')=='2026-11-24':self.assertEqual(event.get('reason'),d['reason'])
    def test_all_vanished_pagination_formats_have_real_last_page_and_no_store(self):
        lines=(D/'_redirects').read_text().splitlines();headers=(D/'_headers').read_text()
        redirects=[x.split() for x in lines if x.endswith(' 302')]
        self.assertEqual(len(redirects),12)
        for old,new,status in redirects:
            p=D/new.lstrip('/')
            if new.endswith('/'):p=p/'index.html'
            self.assertTrue(p.is_file(),new)
            if not old.endswith('/') and not old.endswith(('.json','.md')):continue
            if old.endswith(('.json','.md')):self.assertIn(old+'\n  Cache-Control: no-store',headers)
        for old in ['/atlas/page/8/','/atlas/platforms/page/8/','/atlas/categories/social/page/3/']:
            self.assertTrue(any(a==old for a,b,c in redirects))

    def test_current_revision_receipt_and_frozen_input_are_distinct(self):
        base=json.loads((ROOT/'atlas/catalogue/overviews.json').read_text())['cards']['meta-muse']
        current=json.loads((D/'atlas/platforms/meta-muse.json').read_text())['overview']
        self.assertNotEqual(base['visited_at'],current['visited_at'])
        self.assertEqual(current['visited_at'],'2026-11-24T22:00:49Z')
        self.assertEqual(json.loads((ROOT/'atlas/catalogue/current-revisions.json').read_text())['cards']['meta-muse']['screenshot']['sha256'],'523dc84c29836740cd3b6599f429f2c552c7b40855af7017ab264985622cbddf')
    def test_mirror_has_archive_index_and_no_legacy_search_arguments(self):
        self.assertEqual(len(json.loads((ROOT/'atlas/public/closed.json').read_text())['platforms']),38)
        s=(ROOT/'platform/src/mcp/tools.ts').read_text()
        self.assertNotIn("has_money_flow: { type:",s)
        self.assertNotIn("enum: ['live', 'limited', 'closed']",s)
