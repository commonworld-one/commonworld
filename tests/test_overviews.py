import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas/site'))
import overviews

spec = importlib.util.spec_from_file_location('overview_workbench', ROOT / 'atlas/tools/overviews.py')
workbench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workbench)


class OverviewTests(unittest.TestCase):
    def setUp(self):
        self.cards = [{'slug': 'example', 'status': 'live'}]
        self.r = {'state': 'draft', 'text': 'The operator describes an agent tool.',
            'visited_at': None, 'sources': ['https://example.org/'], 'prepared_by': None,
            'screenshot': None, 'check': None}
        self.doc = {'format': overviews.VERSION, 'cards': {'example': self.r}}
        self.now = datetime(2026, 11, 22, 20, tzinfo=timezone.utc)
        self.shots = {'example': {'sha256': 'a'*64, 'captured_at': '2026-11-22T18:00:00Z', 'source_url': 'https://example.org/'}}

    def bad(self, publishable=False):
        return overviews.problems(self.doc, self.cards, self.shots, publishable, self.now)

    def ready(self):
        self.r.update(state='reviewed', visited_at='2026-11-22T18:30:00Z', prepared_by='preparer-A',
            screenshot=dict(self.shots['example'], pixels_checked=True, matches_overview=True))
        self.r['check'] = {'by': 'reviewer-B', 'checked_at': '2026-11-22T19:00:00Z', 'revision': overviews.digest(self.r)}

    def test_current_disclosure_does_not_refresh_historical_research(self):
        card={'disclosure':'Historic full research record',
              'disclosure_current':'Current participant relationship'}
        self.assertEqual(overviews.relationship_disclosure(card),'Current participant relationship')
        self.assertEqual(card['disclosure'],'Historic full research record')

    def test_share_payload_never_inherits_legacy_verification(self):
        import build
        from html.parser import HTMLParser
        from urllib.parse import urlsplit, parse_qs
        class Links(HTMLParser):
            def __init__(self):super().__init__();self.hrefs=[]
            def handle_starttag(self,tag,attrs):
                attrs=dict(attrs)
                if tag=='a' and attrs.get('href'):self.hrefs.append(attrs['href'])
        for state in ('draft','held','reviewed'):
            card={'name':'Example','status':'live','claims':[{'verified':True}],
                  '_overview':{'state':state},'_badge':{'status':'verified'}}
            text=overviews.share_text(card)
            self.assertEqual(text,'Example on Commonworld Atlas')
            payload=build.cw.share_bar({},'https://commonworld.one/atlas/platforms/example/',text)
            self.assertIn('data-share-text="'+text+'"',payload)
            links=Links();links.feed(payload)
            shared=[]
            for href in links.hrefs:
                for key,value in parse_qs(urlsplit(href).query).items():
                    if key in ('text','title','body','subject'):shared.extend(value)
            self.assertTrue(shared)
            self.assertIn(text,' '.join(shared))
            for forbidden in ('verified','accepted','reviewed','live','closed'):
                self.assertNotIn(forbidden,' '.join(shared).lower())

    def test_draft_never_acquires_a_visit(self):
        self.assertEqual(self.bad(), [])
        self.assertIsNone(overviews.public(self.r)['visited_at'])
        self.assertIn('not reviewed', ' '.join(self.bad(True)))

    def test_final_review_and_pinned_screenshot_required(self):
        self.ready()
        self.assertEqual(self.bad(True), [])
        self.r['screenshot']['sha256'] = 'b'*64
        self.assertIn('pinned image', ' '.join(self.bad(True)))

    def test_whole_card_date_not_derived_from_claims(self):
        self.ready(); self.r['visited_at'] = None
        self.assertIn('actual whole-card visit', ' '.join(self.bad()))

    def test_receipt_stales_on_any_public_edit(self):
        self.ready()
        for k, v in [('text', 'Changed text'), ('sources', ['https://example.net/']), ('visited_at', '2026-11-22T18:45:00Z'), ('trials', [{'result':'changed'}])]:
            saved = copy.deepcopy(self.r)
            self.r[k] = v
            self.assertIn('stale or absent', ' '.join(self.bad()))
            self.r.clear(); self.r.update(saved)

    def test_different_reviewer_required_but_not_claimed_independence(self):
        self.ready(); self.r['check']['by'] = self.r['prepared_by']
        self.assertIn('separate final-content reviewer', ' '.join(self.bad()))

    def test_future_and_malformed_dates_rejected(self):
        for value in ('2026-11-23T01:00:00Z', '2026-11-22', '2026-02-30T12:00:00Z'):
            self.r['visited_at'] = value
            self.assertTrue(self.bad())

    def test_private_editor_notes_not_exported(self):
        self.r['editor_note'] = 'private research note'
        self.r['check'] = {'by': 'private-reviewer'}
        self.r['history'] = [{'text': 'private old draft'}]
        output = json.dumps(overviews.public(self.r))
        self.assertNotIn('private', output)

    def test_urls_require_public_web_shape_not_embedded_credentials(self):
        for value in ('javascript:alert(1)', 'https://user:password@example.org/', 'https://example.org/\nattack', 'file:///tmp/test'):
            self.r['sources'] = [value]
            self.assertTrue(self.bad())

    def test_unknown_cost_stays_null_and_zero_is_explicit(self):
        trial = {'performed_at': '2026-11-22T18:40:00Z', 'service': 'Example', 'action':'read an endpoint',
            'result':'got the documented response', 'access':'free', 'proof_url':'https://example.org/proof', 'cost':None}
        self.r['trials'] = [trial]
        self.assertEqual(self.bad(), [])
        self.assertIsNone(overviews.public(self.r)['trials'][0]['cost'])
        trial['cost'] = {'amount': 0, 'currency': 'EUR'}
        self.assertEqual(self.bad(), [])
        trial['cost']['amount'] = True
        self.assertIn('actual cost', ' '.join(self.bad()))

    def test_revision_keeps_old_content_and_invalidates_check(self):
        self.ready()
        old = copy.deepcopy(self.r)
        replacement = copy.deepcopy(self.r); replacement['text'] = 'A new overview.'
        workbench.revise(self.doc, 'example', replacement)
        current = self.doc['cards']['example']
        self.assertEqual(current['history'][-1], old)
        self.assertEqual(current['state'], 'draft')
        self.assertIsNone(current['check'])

    def test_main_revision_retains_omitted_trial(self):
        old={'text':'old','visited_at':'2026-11-01T00:00:00Z','trials':[{'performed_at':'2026-11-01T01:00:00Z','result':'actual result'}]}
        doc={'cards':{'example':copy.deepcopy(old)}}
        workbench.revise(doc,'example',{'text':'new','visited_at':'2026-11-02T00:00:00Z'})
        self.assertEqual(doc['cards']['example']['trials'],old['trials'])
        self.assertEqual(doc['cards']['example']['visited_at'],'2026-11-02T00:00:00Z')
        self.assertEqual(old['text'],'old')

    def test_trial_only_revision_preserves_main_package(self):
        old={'text':'old','visited_at':'2026-11-01T00:00:00Z','sources':['https://example.org/'],'screenshot':{'sha256':'a'*64},'trials':[]}
        doc={'cards':{'example':copy.deepcopy(old)}}
        workbench.revise_trials(doc,'example',[{'performed_at':'2026-11-03T00:00:00Z','result':'new trial'}])
        for k in ('text','visited_at','sources','screenshot'): self.assertEqual(doc['cards']['example'][k],old[k])
        self.assertIsNone(doc['cards']['example']['check'])
        self.assertEqual(doc['cards']['example']['state'],'draft')

    def test_migration_coverage_is_not_acceptance(self):
        snap = {'platforms': [{'slug':'example','status':'live','name':'Example', 'canonical_url':'https://example.org/',
            'description_en':'Old description', 'claims':[{'kind':'description','statement':'Old description',
            'source_url':'https://example.org/docs','observed_at':'2026-11-21T12:00:00Z'}]},
            {'slug':'closed-history','status':'closed'}]}
        audit = {'description_canonical_site_register':[{'slug':'example','status':'context_read_consistent'}], 'registers':{}}
        doc, report = workbench.migrate(snap, audit, 'a'*40)
        self.assertEqual(len(doc['cards']), 1)
        self.assertIsNone(doc['cards']['example']['visited_at'])
        self.assertIsNone(doc['cards']['example']['check'])
        self.assertEqual(report['closed_history'], ['closed-history'])
        self.assertEqual(doc['cards']['example']['text'], 'Old description')

    def test_identity_hold_not_silent_pivot(self):
        snap={'platforms':[{'slug':'agent-knowledge-network','status':'live','name':'AKN',
            'canonical_url':'https://aptets.com/','description_en':'Historical description'}]}
        doc,_ = workbench.migrate(snap, {'description_canonical_site_register':[], 'registers':{}}, 'a'*40)
        r=doc['cards']['agent-knowledge-network']
        self.assertEqual(r['state'], 'held')
        self.assertIn('Do not rename', r['editor_note'])
        self.assertEqual(r['text'], 'Historical description')

    def test_explicit_batch_selection_detects_a_missing_record(self):
        from types import SimpleNamespace
        self.ready()
        site=SimpleNamespace(cards=self.cards,shots=self.shots,safety={'hosts':{'example.org':{'status':'clean'}}})
        with self.assertRaisesRegex(ValueError,'explicit batch selection'):
            overviews.attach(site,self.doc,expected=['example','silently-missing'])
        with self.assertRaisesRegex(ValueError,'explicit batch selection'):
            overviews.attach(site,self.doc)
        overviews.attach(site,self.doc,expected=['example'])
        self.assertEqual(site.overviews,self.doc['cards'])

    def test_draft_notice_distinguishes_visit_from_final_acceptance(self):
        self.assertIn('No whole-card visit', overviews.draft_notice(self.r))
        self.r['visited_at'] = '2026-11-22T18:45:00Z'
        notice = overviews.draft_notice(self.r)
        self.assertIn('A source visit is recorded', notice)
        self.assertIn('review is still pending', notice)
        self.assertNotIn('not a new verified visit', notice)
        self.r['state'] = 'reviewed'
        self.assertEqual(overviews.draft_notice(self.r), '')

    def test_all_current_active_cards_get_drafts(self):
        source = ROOT/'atlas/drafts/overviews.json'
        if not source.exists():
            self.skipTest('private migration source not included')
        doc = json.loads(source.read_text())
        snapshot=json.loads(workbench.DEFAULT_SNAPSHOT.read_text())
        self.assertEqual(overviews.problems(doc,snapshot['platforms']),[])
        self.assertEqual(set(doc['cards']),{c['slug'] for c in snapshot['platforms'] if c['status']=='live'})
        self.assertTrue(all(r['visited_at'] is None and r['check'] is None for r in doc['cards'].values()))


if __name__ == '__main__':
    unittest.main()
