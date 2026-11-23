import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('screens_artifact', ROOT/'atlas/tools/screens_artifact.py')
sa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sa)

class ImportedCaptureMetadataTests(unittest.TestCase):
    def setUp(self):
        self.data = (ROOT/'tests/fixtures/webp/lossy-1200x750.webp').read_bytes()
        import hashlib
        self.row = {'file':'demo.webp','sha256':hashlib.sha256(self.data).hexdigest(),'dhash':sa.stored_webp_dhash(self.data),'website':'https://example.org/','source_url':'https://example.org/','http_status':None,'title':'Demo','captured_at':'2026-10-18T04:10:00Z','width':1200,'height':750,'bytes':len(self.data),'imported_capture_metadata':{'format':'stored-webp-import/1','http_status_reason':'not-recorded-in-retained-capture-evidence','dhash_basis':'decoded-stored-webp','computed_at':'2026-11-23T21:34:47Z'}}
    def test_explicit_import_valid(self):
        self.assertEqual(sa.record_problems('demo',self.row),[])
        self.assertIsNone(sa.imported_hash_problem(self.data,self.row))
    def test_import_cannot_claim_http_200(self):
        self.row['http_status']=200
        self.assertTrue(sa.record_problems('demo',self.row))
    def test_import_requires_all_provenance(self):
        for key in self.row['imported_capture_metadata']:
            r=copy.deepcopy(self.row);del r['imported_capture_metadata'][key]
            self.assertTrue(sa.record_problems('demo',r),key)
    def test_import_bad_basis_reason_format_date_type(self):
        for key,value in [('dhash_basis','original-capture'),('http_status_reason','timeout'),('format','anything'),('computed_at','2026-02-30T00:00:00Z'),('computed_at','2099-01-01T00:00:00Z')]:
            r=copy.deepcopy(self.row);r['imported_capture_metadata'][key]=value
            self.assertTrue(sa.record_problems('demo',r))
        for value in [None,True,[],{},'imported']:
            r=copy.deepcopy(self.row);r['imported_capture_metadata']=value
            self.assertTrue(sa.record_problems('demo',r))
    def test_hash_corruption_and_different_bytes_rejected(self):
        self.row['dhash']='0'*16
        self.assertIsNotNone(sa.imported_hash_problem(self.data,self.row))
        self.assertIsNotNone(sa.imported_hash_problem(b'not webp',self.row))
    def test_normal_capture_schema_unchanged(self):
        del self.row['imported_capture_metadata']
        self.row['http_status']=200
        self.assertEqual(sa.record_problems('demo',self.row),[])
        self.row['http_status']=None
        self.assertEqual(sa.record_problems('demo',self.row),[])
        for key in ['dhash','http_status']:
            r=copy.deepcopy(self.row);del r[key]
            self.assertTrue(sa.record_problems('demo',r))

    def test_stored_checks_still_reject_bad_metadata_hash_bytes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'demo.webp').write_bytes(self.data)
            def problems(row):
                (root/'manifest.json').write_text(json.dumps({'screens':{'demo':row}}))
                return sa.stored_problems(root)
            self.assertEqual(problems(self.row),[])
            for key,value in [('sha256','f'*64),('bytes',1),('width',1),('height',1),('source_url','javascript:bad'),('captured_at','invalid'),('dhash','0'*16)]:
                row=copy.deepcopy(self.row);row[key]=value
                self.assertTrue(problems(row),key)
            row=copy.deepcopy(self.row);row['imported_capture_metadata']['computed_at']='2020-01-01T00:00:00Z'
            self.assertTrue(problems(row))
            (root/'demo.webp').write_bytes(b'not WebP')
            self.assertTrue(problems(self.row))
