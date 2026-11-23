"""Safety bulk/last-member page regressions, no network."""
import copy,json,re,sys,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import build

class EdgePages(unittest.TestCase):
    def site(self):
        cfg=json.loads((ROOT/'atlas/site/site-config.json').read_text())
        snap=json.loads((ROOT/'atlas/catalogue/snapshot.json').read_text())
        site=build.Site(cfg,snap);site.catalogue_mode=True;site.overviews={};site.limitations={};site.safety={};site.removed=[]
        site.img_v="synthetic";site.asset_v="synthetic"
        build.enrich(site,{})
        return site

    def test_bulk_decisions_bounded_pages_and_complete_downloads(self):
        site=self.site()
        rows=[{'action':'remove','slug':f'synthetic-{i}','host':'synthetic.example','by':'hark','on':'2026-11-23','reason':'Synthetic offline bulk fixture','evidence':'https://evidence.example/synthetic'} for i in range(401)]
        with patch.object(build,'load_decisions',return_value=(rows,{'actors':[]})):
            combined=''
            for n in range(1,7):
                text=build.build_decisions(site,n);combined+=text
                self.assertLess(len(text.encode()),150*1024)
                self.assertLessEqual(text.count('<tr><td><time'),80)
                self.assertIn('rel="canonical"',text)
            self.assertEqual(combined.count('<tr><td><time'),401)
            self.assertEqual(len(build.decisions_doc(site)['decisions']),401)
            md=build.build_decisions_md(site)
            for row in rows:self.assertIn('`'+row['slug']+'`',md)

    def test_empty_category_has_permanent_html_markdown_and_zero_dataset(self):
        site=self.site();site.by_cat['verification']=[]
        text=build.build_category(site,'verification')
        self.assertIn('No entries are currently listed',text)
        self.assertIn('/atlas/decisions/',text)
        self.assertIn('0 entries',text)
        md=build.build_category_md(site,'verification',1)
        self.assertIn('0 entries',md)
        ds=build.dataset_ld(site,[],name='empty',description='empty',url='/atlas/categories/verification/',downloads=[],keywords=[])
        self.assertIn('dateModified',ds)
        self.assertEqual(ds['size'],'0 entries')

if __name__=='__main__':unittest.main()
