"""Historical host exemption is status-scoped, not a validation bypass."""
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import overviews
import closed_archive

class ClosedOverviewSafety(unittest.TestCase):
    def fixture(self,status='closed'):
        shot={'sha256':'a'*64,'source_url':'https://host.example/','captured_at':'2026-11-22T18:00:00Z'}
        row={'state':'reviewed','text':'Historical operator claims.','sources':['https://host.example/'],'visited_at':'2026-11-22T18:30:00Z','prepared_by':'fixture-A','screenshot':dict(shot,pixels_checked=True,matches_overview=True),'check':{'by':'fixture-B','checked_at':'2026-11-22T19:00:00Z'}}
        row['check']['revision']=overviews.digest(row)
        card={'slug':'sample','status':status,'canonical_url':'https://host.example/'}
        return SimpleNamespace(cards=[card],shots={'sample':shot},safety={'hosts':{}}),{'format':overviews.VERSION,'cards':{'sample':row}}
    def attach(self,site,doc):overviews.attach(site,doc,expected=list(doc['cards']))
    def test_only_explicit_closed_status_exempts_missing_or_flagged_host(self):
        for status in ['closed','live',None,'unknown']:
            for safety in [{},{'host.example':{'status':'flagged'}},{'host.example':{'status':'no_data'}}]:
                with self.subTest(status=status,safety=safety):
                    site,doc=self.fixture(status);site.safety['hosts']=safety
                    if status=='closed':self.attach(site,doc)
                    else:
                        with self.assertRaisesRegex(ValueError,'clean safety result'):self.attach(site,doc)
    def test_current_shared_host_still_checked_despite_closed_owner(self):
        site,doc=self.fixture();current=copy.deepcopy(site.cards[0]);current.update(slug='live-one',status='live');site.cards.append(current);doc['cards']['live-one']=copy.deepcopy(doc['cards']['sample']);site.shots['live-one']=copy.deepcopy(site.shots['sample'])
        with self.assertRaisesRegex(ValueError,'live-one: source domain'):self.attach(site,doc)
        site.safety['hosts']['host.example']={'status':'clean'};self.attach(site,doc)
    def test_each_current_canonical_source_and_trial_host_keeps_clean_gate(self):
        for field in ['canonical','source','trial']:
            with self.subTest(field=field):
                site,doc=self.fixture('live');row=doc['cards']['sample']
                site.safety['hosts']={'host.example':{'status':'clean'}}
                if field=='canonical':site.cards[0]['canonical_url']='https://unchecked.example/'
                if field=='source':row['sources']=['https://unchecked.example/']
                if field=='trial':row['trials']=[{'performed_at':'2026-11-22T18:00:00Z','service':'Fixture','action':'Read','result':'Not tested','access':'public','proof_url':'https://unchecked.example/','cost':None}]
                row['check']['revision']=overviews.digest(row)
                with self.assertRaisesRegex(ValueError,'unchecked.example'):self.attach(site,doc)
                site.safety['hosts']['unchecked.example']={'status':'clean'};self.attach(site,doc)

    def test_closed_stale_receipt_missing_pixels_bad_source_and_selection_rejected(self):
        def stale(site,row):row['text']='changed without review'
        def missing(site,row):site.shots={}
        def badurl(site,row):row['sources']=['javascript:alert(1)']
        def badtrial(site,row):row['trials']=[{'proof_url':'file:///etc/passwd'}]
        def badstate(site,row):row['state']='draft'
        for mutate in [stale,missing,badurl,badtrial,badstate]:
            with self.subTest(mutate=mutate.__name__):
                site,doc=self.fixture();mutate(site,doc['cards']['sample'])
                with self.assertRaises(ValueError):self.attach(site,doc)
        site,doc=self.fixture()
        with self.assertRaisesRegex(ValueError,'explicit batch selection'):overviews.attach(site,doc,expected=[])
    def test_validated_hostile_history_remains_inert_and_not_current(self):
        site,doc=self.fixture();row=doc['cards']['sample']
        row.update(text='<a href="https://host.example/phish">operator text</a> https://host.example/',sources=['https://host.example/phish'])
        row['trials']=[{'performed_at':'2026-11-22T18:00:00Z','service':'Fixture','action':'<script>not executable text</script>','result':'Read https://host.example/','access':'public','proof_url':'https://host.example/proof','cost':None}]
        row['check']['revision']=overviews.digest(row)
        site.safety['hosts']={'host.example':{'status':'flagged'}};self.attach(site,doc)
        public=closed_archive.inert(overviews.public(row))
        self.assertNotIn('https://host.example',json.dumps(public))
        self.assertIn('https[:]//host[.]example',json.dumps(public))
        import html
        raw='<main id="main"><section><p>'+html.escape(row['text'])+'</p><a href="https://host.example/proof">Evidence</a></section></main>'
        rendered=closed_archive.html_document(raw)
        self.assertNotIn('<a href="https://host.example',rendered)
        self.assertNotIn('<script>',rendered)
        self.assertIn('&lt;a href=',rendered)
