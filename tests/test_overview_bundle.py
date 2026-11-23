import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import overview_bundle
from PIL import Image

class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.screens=self.root/'images';self.screens.mkdir()
        image=self.screens/'example.webp';Image.new('RGB',(1200,750),'white').save(image,'WEBP')
        self.record={'file':'example.webp','sha256':overview_bundle.file_hash(image),'width':1200,'height':750,
            'captured_at':'2026-11-22T18:00:00Z','source_url':'https://example.org/','bytes':image.stat().st_size}
        self.save(self.screens/'manifest.json',{'screens':{'example':self.record}})
        self.source=self.root/'overviews.json';self.snapshot=self.root/'snapshot.json';self.out=self.root/'bundle'
        self.save(self.source,{'format':'commonworld-atlas-overviews/1','base_sha':'a'*40,'cards':{'example':{
            'state':'draft','text':'The operator describes an example tool.','visited_at':None,'sources':['https://example.org/'],
            'screenshot':None,'check':None,'prepared_by':None}}})
        self.save(self.snapshot,{'platforms':[{'slug':'example','status':'live'},{'slug':'old-history','status':'closed'}]})
    def tearDown(self):self.temp.cleanup()
    def save(self,path,obj):path.write_text(json.dumps(obj))
    def make(self):return overview_bundle.make(self.source,self.snapshot,self.screens,self.out)
    def test_deploy_packager_refuses_draft_before_copy(self):
        import subprocess
        dist=self.root/'dist';dist.mkdir()
        (dist/'atlas/data').mkdir(parents=True)
        (dist/'atlas/data/local-preview-marker.json').write_text('{}')
        result=subprocess.run(['node',str(ROOT/'platform/scripts/build-atlas-assets.mjs'),'--dist',str(dist)],text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('refusing local draft preview assets',result.stderr)

    def test_round_trip_and_no_invented_acceptance(self):
        report=self.make();self.assertFalse(report['ready_for_publication']);self.assertEqual(overview_bundle.verify(self.out),[])
        self.assertIsNone(json.loads((self.out/'overviews.json').read_text())['cards']['example']['visited_at'])
    def test_pixel_tamper_fails_before_any_bundle_written(self):
        (self.screens/'example.webp').write_bytes(b'not a screen')
        with self.assertRaisesRegex(ValueError,'manifest'):self.make()
        self.assertFalse(self.out.exists())
    def test_manifest_dimensions_are_not_trusted(self):
        image=self.screens/'example.webp';Image.new('RGB',(100,100),'white').save(image,'WEBP')
        self.record['sha256']=overview_bundle.file_hash(image)
        self.save(self.screens/'manifest.json',{'screens':{'example':self.record}})
        with self.assertRaisesRegex(ValueError,'size mismatch'):self.make()
    def test_unknown_slug_refused(self):
        with self.assertRaisesRegex(ValueError,'existing overview IDs'):
            overview_bundle.make(self.source,self.snapshot,self.screens,self.out,['other'])
    def test_bundle_tamper_detected(self):
        self.make();(self.out/'overviews.json').write_text('{}')
        self.assertIn('checksum mismatch: overviews.json',overview_bundle.verify(self.out))
    def test_unlisted_file_detected(self):
        self.make();(self.out/'extra.txt').write_text('unexpected')
        self.assertIn('bundle file inventory differs',overview_bundle.verify(self.out))
    def test_never_overwrites_old_bundle(self):
        self.make()
        with self.assertRaisesRegex(ValueError,'overwrite'):self.make()
    def test_missing_image_is_explicit_not_false_ready(self):
        self.save(self.screens/'manifest.json',{'screens':{}})
        report=self.make();self.assertEqual(report['missing_screenshots'],['example'])
        self.assertFalse(report['ready_for_publication'])

if __name__=='__main__':unittest.main()
