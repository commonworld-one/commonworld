import json, pathlib, sys, unittest, copy
from types import SimpleNamespace
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import limitations

class LimitationTests(unittest.TestCase):
    def setUp(self):
        self.doc=json.loads((ROOT/'atlas/catalogue/limitations.json').read_text())
        self.snap=json.loads((ROOT/'atlas/catalogue/snapshot.json').read_text())
        self.site=SimpleNamespace(cards=copy.deepcopy(self.snap['platforms']),overviews={})
    def test_exact_deferred_set(self):
        self.assertEqual(set(self.doc['cards']),set(json.loads((ROOT/'atlas/catalogue/selection.json').read_text())['deferred_slugs']))
    def test_no_source_record_change(self):
        limitations.attach(self.site,self.doc)
        for old,new in zip(self.snap['platforms'],self.site.cards):
            self.assertEqual(old,{k:v for k,v in new.items() if k!='_limitation'})
    def test_overlap_rejected(self):
        self.site.overviews={'snail':{}}
        with self.assertRaises(ValueError):limitations.attach(self.site,self.doc)
    def test_unknown_id_rejected(self):
        self.doc['cards']['made-up']=self.doc['cards']['snail']
        with self.assertRaises(ValueError):limitations.attach(self.site,self.doc)
    def test_future_date_rejected(self):
        self.doc['cards']['snail']['attempted_on']='2999-01-01'
        with self.assertRaises(ValueError):limitations.attach(self.site,self.doc)
    def test_attempt_not_completed_visit(self):
        limitations.attach(self.site,self.doc)
        for c in self.site.cards:
            if c.get('_limitation'):
                md=limitations.render_md(SimpleNamespace(abs=lambda x:'https://example.org'+x),dict(c,_url='/atlas/platforms/'+c['slug']+'/'))
                self.assertIn('Source check attempted: 2026-11-23',md)
                self.assertNotIn('Visit for this overview',md)
                self.assertNotIn('Screenshot captured',md)
