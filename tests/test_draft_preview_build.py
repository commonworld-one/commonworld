"""Full offline draft-preview builds, not just renderer or date-expression checks."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]

class DraftPreviewBuild(unittest.TestCase):
    def build_fixture(self, mode):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            for name in ['site','catalogue','data']:
                shutil.copytree(ROOT/'atlas'/name,root/'atlas'/name,ignore=shutil.ignore_patterns('dist','.screens-cache','.og-cache','__pycache__'))
            cat=root/'atlas/catalogue'; active={}
            for name in ['overviews.json','additional-overviews.json','current-revisions.json']:
                doc=json.loads((cat/name).read_text())
                for slug,r in doc['cards'].items():
                    r['state']='draft';r['check']=None
                    if mode=='undated' or slug in ['1f916','agent-colony-juluo']:r['visited_at']=None
                    active[slug]=r
                (cat/name).write_text(json.dumps(doc))
            # Keep fixture earning explanations revision-bound, never disable the guard.
            earn=json.loads((cat/'earning.json').read_text())
            for slug,row in earn['cards'].items():
                bound={k:active[slug].get(k) for k in ('text','visited_at','sources')}
                row['overview_sha256']=hashlib.sha256(json.dumps(bound,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
            (cat/'earning.json').write_text(json.dumps(earn))
            out=root/'preview'; env=dict(os.environ,CW_SCREENS='off',CW_SCREENS_REQUIRED='0')
            result=subprocess.run([sys.executable,str(root/'atlas/site/build.py'),'--data',str(cat/'snapshot.json'),'--overviews',str(cat/'overviews.json'),'--overview-selection',str(cat/'selection.json'),'--draft-preview','--no-mirror','--out',str(out)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90)
            self.assertEqual(result.returncode,0,result.stdout[-3000:])
            self.assertTrue((out/'atlas/data/local-preview-marker.json').exists())
            rows=json.loads((out/'atlas/platforms.json').read_text())['platforms']
            self.assertEqual(len(rows),349)
            newest=json.loads((out/'atlas/platforms.json').read_text())['newest_observation']
            expected=max((r['visited_at'] for r in active.values() if r.get('visited_at')),default=None)
            # Public iso() follows parse_time's existing minute precision.
            expected=expected[:16]+':00Z' if expected else None
            self.assertEqual(newest,expected)
            page=(out/'atlas/platforms/1f916/index.html').read_text()
            self.assertIn('Draft · not verified',page)
            self.assertIn('noindex',page)
            self.assertNotIn('Live · Verified',page)
            self.assertIn('Listed',(out/'atlas/badge/1f916.svg').read_text())
            self.assertNotIn('Verified',(out/'atlas/badge/1f916.svg').read_text())
            self.assertEqual(json.loads((out/'atlas/earn.json').read_text())['count'],71)
            self.assertIn('unknown',(out/'atlas/earn/index.html').read_text())
            self.assertNotIn('<url>',(out/'sitemap.xml').read_text())
            self.assertFalse((root/'atlas/public').exists())
            sys.path.insert(0,str(ROOT/'atlas/site'))
            import api_v1
            schema_dir=out/'api/v1/schemas'
            schemas={p.name:json.loads(p.read_text()) for p in schema_dir.glob('*.json')}
            self.assertEqual(schemas['earn-row.schema.json']['properties']['visited_at']['type'],'string')
            self.assertEqual(schemas['earn-row-preview.schema.json']['properties']['visited_at']['type'],['string','null'])
            api_earn=json.loads((out/'api/v1/atlas/earn.json').read_text())
            self.assertTrue(api_earn['schema'].endswith('/earn-preview.schema.json'))
            self.assertFalse(any('preview' in name for name in api_v1.schemas('https://commonworld.one',['social'])))
            checked=0
            for path in (out/'api/v1').rglob('*.json'):
                doc=json.loads(path.read_text())
                if not isinstance(doc,dict) or 'schema' not in doc:continue
                name=doc['schema'].rsplit('/',1)[-1]
                self.assertEqual(api_v1.validate(doc,schemas[name],schemas,name,limit=3),[],str(path))
                checked+=1
            self.assertGreater(checked,400)
            # The preview checker expects resolved source, not the frozen input layer.
            projected=cat/'resolved-preview-overviews.json'
            projected.write_text(json.dumps({'cards':active}))
            checker=subprocess.run([sys.executable,str(root/'atlas/site/tools/check_overview_preview.py'),'--source',str(projected),'--dist',str(out)],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=30)
            self.assertEqual(checker.returncode,0,checker.stdout[-3000:])
            self.assertEqual(json.loads(checker.stdout)['overviews_checked'],349)


    def test_mixed_dated_and_undated_full_preview(self):
        self.build_fixture('mixed')
    def test_all_undated_full_preview(self):
        self.build_fixture('undated')
