"""Strict zero-published-image proof must retain exact source package checks."""
import hashlib,json,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import catalogue_safety as cs
import build

class StrictZero(unittest.TestCase):
    def test_exact_source_required_even_when_removed(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td);cat=d/'cat';shots=d/'shots';cat.mkdir();shots.mkdir()
            image=b'RIFF'+bytes(4)+b'WEBP'+bytes(30)
            digest=hashlib.sha256(image).hexdigest()
            row={'width':1200,'height':750,'file':'synthetic.webp','sha256':digest,'source_url':'https://synthetic.example/','captured_at':'2026-11-23T00:00:00Z'}
            (shots/'synthetic.webp').write_bytes(image)
            (shots/'manifest.json').write_text(json.dumps({'screens':{'synthetic':row}}))
            (cat/'image-binding.json').write_text(json.dumps({'manifest_sha256':hashlib.sha256((shots/'manifest.json').read_bytes()).hexdigest()}))
            (cat/'selection.json').write_text('{"slugs":["synthetic"]}')
            (cat/'overviews.json').write_text(json.dumps({'cards':{'synthetic':{'screenshot':row}}}))
            self.assertTrue(cs.verify_source_package(cat,shots,{'synthetic'}))
            with self.assertRaises(ValueError):cs.verify_source_package(cat,shots,set())
            (shots/'synthetic.webp').unlink()
            with self.assertRaises(OSError):cs.verify_source_package(cat,shots,{'synthetic'})
            (shots/'synthetic.webp').write_bytes(b'wrong bytes')
            with self.assertRaises(ValueError):cs.verify_source_package(cat,shots,{'synthetic'})
            with self.assertRaises(OSError):cs.verify_source_package(cat,d/'missing',{'synthetic'})

    def test_archive_collection_url_and_name_not_dataset_root(self):
        class Site:
            cfg={}
            def abs(self,p):return 'https://commonworld.one'+p
        d=build.decisions_ld(Site(),[], '/atlas/decisions/archive/3/',3)
        self.assertEqual(d['url'],'https://commonworld.one/atlas/decisions/archive/3/')
        self.assertIn('page 3',d['name'])
        self.assertEqual(d['mainEntity']['url'],'https://commonworld.one/atlas/decisions/')

if __name__=='__main__':unittest.main()
