"""Scoped earning selection tests, no network or payments."""
import copy,importlib.util,json,pathlib,sys,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import earning
from types import SimpleNamespace
class CurrentEarn(unittest.TestCase):
 def setUp(self):
  self.path=ROOT/'atlas/catalogue/earning.json'
  self.source=json.loads((ROOT/'atlas/catalogue/overviews.json').read_text())['cards']
 def site(self):
  return SimpleNamespace(cards=[{'slug':s,'name':s,'_overview':copy.deepcopy(r)} for s,r in self.source.items()])
 def test_membership(self):
  site=self.site();earning.attach(site,self.path);self.assertEqual(len(site.earning_rows),71)
  self.assertEqual(len(set(c['slug'] for c in site.earning_rows)),71)
 def test_stale_guard(self):
  site=self.site();c=next(c for c in site.cards if c['slug']=='agent-bounties');c['_overview']['text']+=' new'
  with self.assertRaisesRegex(ValueError,'stale'):earning.attach(site,self.path)
 def test_safety_removal(self):
  site=self.site();site.cards=[c for c in site.cards if c['slug']!='agent-bounties'];earning.attach(site,self.path)
  self.assertEqual(len(site.earning_rows),70)
if __name__=='__main__':unittest.main()
