"""Offline end-to-end closure and isolated bundle transitions."""
import copy
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import overview_bundle

class CatalogueLifecycle(unittest.TestCase):
    def copy(self,root):
        for n in ['site','data','catalogue']:
            shutil.copytree(ROOT/'atlas'/n,root/'atlas'/n,ignore=shutil.ignore_patterns('dist','.og-cache','.screens-cache','__pycache__'))
        shutil.copytree(ROOT/'atlas/tools',root/'atlas/tools',ignore=shutil.ignore_patterns('__pycache__'))
        with (root/'atlas/data/events.jsonl').open('a') as fh:
            fh.write('\n'+json.dumps({'date':'2026-11-24','slug':'kradleverse','type':'closed','reason':'Lifecycle fixture','source':'https://kradleverse.com/fixture'})+'\n')
    def run_build(self,root,args):
        env=dict(os.environ,CW_SCREENS='off',CW_SCREENS_REQUIRED='0')
        r=subprocess.run([sys.executable,str(root/'atlas/site/build.py')]+args,env=env,capture_output=True,text=True,timeout=90)
        self.assertEqual(r.returncode,0,r.stderr[-2500:])
    def assert_closed_projections(self,out,slugs):
        current=json.loads((out/'atlas/platforms.json').read_text())['platforms']
        for slug in slugs:
            for f,key in [('atlas/platforms.json','platforms'),('atlas/earn.json','rows'),('api/v1/atlas/mcp-index.json','rows'),('atlas/data/snapshot.json','platforms')]:
                self.assertNotIn(slug,[r.get('id',r.get('slug')) for r in json.loads((out/f).read_text())[key]],f)
            for f in ['atlas/llms.txt','llms.txt']:
                if (out/f).exists():self.assertNotIn('/platforms/'+slug+'/',(out/f).read_text())
            self.assertNotIn('/platforms/'+slug+'/',(out/'sitemap.xml').read_text())
            self.assertNotIn('Live · Verified',(out/f'atlas/platforms/{slug}/index.html').read_text())
            self.assertNotIn('Live · Verified',(out/f'atlas/platforms/{slug}/index.md').read_text())
            api=json.loads((out/f'api/v1/atlas/platforms/{slug}.json').read_text())
            self.assertEqual(api['status'],'closed');self.assertIn('overview',api['archive']['history'])
        events=json.loads((out/'atlas/events.json').read_text())['events']
        for event in events:
            if event.get('slug') in slugs:self.assertNotIn('https://',json.dumps(event))

    def test_reviewed_accepted_to_closed_with_exact_captures(self):
        captures=Path(os.environ.get('CW_SCREENS_DIR','/nonexistent'))
        if not (captures/'manifest.json').exists():self.skipTest('exact reviewed captures required')
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.copy(root);cat=root/'atlas/catalogue'
            d=json.loads((cat/'closures.json').read_text());d['ids']+=['aptets'];(cat/'closures.json').write_text(json.dumps(d))
            # Rebuild the safety report through the real CLI from recorded engine
            # answers. This is offline replay, not a new live safety claim.
            safety=root/'atlas/data/link-safety.json';previous=json.loads(safety.read_text())
            engine=root/'engine-replay.json';engine.write_text(json.dumps({'results':{h:{'sources':r['sources']} for h,r in (previous['hosts']|previous.get('removed_hosts',{})).items()},'sources':previous['sources'],'run_at':previous['run_at']}))
            regenerated=subprocess.run([sys.executable,str(root/'atlas/tools/link_safety.py'),'--catalogue-dir',str(cat),'--curation-dir',str(root/'atlas/data'),'--removed',str(root/'atlas/data/removed.json'),'--hold',str(root/'atlas/data/trust-hold.json'),'--out',str(safety),'--report-in',str(engine)],capture_output=True,text=True,timeout=30)
            self.assertEqual(regenerated.returncode,0,regenerated.stdout+regenerated.stderr)
            hosts=json.loads(safety.read_text())['hosts']
            self.assertEqual(hosts['kradle.ai']['entries'],['kradlebench'])
            self.assertNotIn('kradleverse',hosts['kradle.ai']['entries'])
            out=root/'out';env=dict(os.environ,CW_SCREENS_DIR=str(captures));env.pop('CW_SCREENS',None)
            r=subprocess.run([sys.executable,str(root/'atlas/site/build.py'),'--no-mirror','--out',str(out)],env=env,capture_output=True,text=True,timeout=90)
            self.assertEqual(r.returncode,0,r.stderr[-2000:]);self.assert_closed_projections(out,['kradleverse','aptets'])
            for slug in ['kradleverse','aptets']:
                self.assertNotIn('Live · Verified',(out/f'atlas/platforms/{slug}/index.html').read_text())
                self.assertNotIn('Live · Verified',(out/f'atlas/platforms/{slug}/index.md').read_text())
                self.assertIn('Closed · history',(out/f'atlas/badge/{slug}.svg').read_text())

    def test_reviewed_to_closed_retains_history_not_current_dispatch(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.copy(root);cat=root/'atlas/catalogue'
            closure=json.loads((cat/'closures.json').read_text());closure['ids']+=['aptets'];(cat/'closures.json').write_text(json.dumps(closure))
            for n in ['overviews.json','additional-overviews.json','current-revisions.json']:
                d=json.loads((cat/n).read_text())
                for r in d['cards'].values():r.update(state='draft',check=None)
                (cat/n).write_text(json.dumps(d))
            # Both existing current and newly added current cards honor closure evidence.
            out=root/'out';self.run_build(root,['--data',str(cat/'snapshot.json'),'--overviews',str(cat/'overviews.json'),'--draft-preview','--no-mirror','--out',str(out)])
            self.assert_closed_projections(out,['kradleverse','aptets'])
            current=json.loads((out/'atlas/platforms.json').read_text())['platforms'];self.assertEqual(len(current),348)
            for slug in ['kradleverse','aptets']:
                html=(out/f'atlas/platforms/{slug}/index.html').read_text();md=(out/f'atlas/platforms/{slug}/index.md').read_text();rec=json.loads((out/f'atlas/platforms/{slug}.json').read_text())
                self.assertEqual(rec['status'],'closed');self.assertEqual(rec['archive']['external_links'],'disabled')
                self.assertIn('overview',rec['archive']['history'])
                self.assertTrue(rec['archive']['history'].get('claims') is not None)
                self.assertIn('Historical overview',html);self.assertIn('Historical overview',md)
                self.assertIn('Closed archive.',html);self.assertIn('Closed (history)',md)
                for text in ['Live · Verified','Draft · not verified']:self.assertNotIn(text,html);self.assertNotIn(text,md)
                self.assertIn('Closed · history',(out/f'atlas/badge/{slug}.svg').read_text())
                self.assertFalse(any(r['id']==slug for r in current))
                self.assertNotIn('href="https://kradleverse.',html)
                self.assertNotIn('https://aptets.com',md)
            for f in ['atlas/earn.json','api/v1/atlas/mcp-index.json','atlas/llms.txt']:
                self.assertNotIn('"id": "kradleverse"',(out/f).read_text())
    def test_real_bundle_generated_command_is_custom_input_isolated(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.copy(root);screens=root/'screens';screens.mkdir()
            Image.new('RGB',(1200,750),'white').save(screens/'example.webp','WEBP')
            shot={'file':'example.webp','sha256':overview_bundle.file_hash(screens/'example.webp'),'source_url':'https://example.org/','captured_at':'2026-11-22T00:00:00Z','width':1200,'height':750,'bytes':(screens/'example.webp').stat().st_size}
            (screens/'manifest.json').write_text(json.dumps({'screens':{'example':shot}}))
            # Full snapshot intentionally contains unrelated live records.
            snap=json.loads((root/'atlas/catalogue/snapshot.json').read_text());example=copy.deepcopy(snap['platforms'][0]);example.update(slug='example',name='Example',status='live',canonical_url='https://example.org/',claims=[],qa=[]);snap['platforms'].append(example)
            snapshot=root/'snapshot.json';snapshot.write_text(json.dumps(snap))
            source=root/'source.json';source.write_text(json.dumps({'format':'commonworld-atlas-overviews/1','cards':{c['slug']:{'state':'draft','visited_at':None,'text':'Example tool.','sources':['https://example.org/'],'check':None} for c in snap['platforms'] if c['status']=='live'}}))
            bundle=root/'bundle';overview_bundle.make(source,snapshot,screens,bundle,['example'])
            self.assertEqual(overview_bundle.verify(bundle),[])
            env=dict(os.environ,CW_SCREENS_DIR=str(bundle/'screens'),CW_SCREENS_REQUIRED='0');env.pop('CW_SCREENS',None)
            out=root/'out'
            recipe=(bundle/'README.md').read_text().split('  CW_SCREENS_DIR=',1)[1].split('\n  python atlas/site/serve.py',1)[0]
            args=[v for v in shlex.split(('CW_SCREENS_DIR='+recipe).replace('PATH/TO/BUNDLE',str(bundle))) if v.strip()][1:]
            args[0]=sys.executable;args[1]=str(root/args[1]);args[-1]=str(out)
            r=subprocess.run(args,env=env,capture_output=True,text=True,timeout=90);self.assertEqual(r.returncode,0,r.stderr[-2000:])
            rows=json.loads((out/'atlas/platforms.json').read_text())['platforms'];self.assertEqual([r['id'] for r in rows],['example'])
            self.assertFalse((out/'atlas/platforms/aptets.json').exists());self.assertFalse((out/'atlas/platforms/meta-muse.json').exists())
            self.assertEqual(set(json.loads((out/'atlas/screens/manifest.json').read_text())['screens']),{'example'})
            self.assertTrue((out/'atlas/data/local-preview-marker.json').exists())
            self.assertEqual((out/'atlas/screens/example.webp').read_bytes(),(bundle/'screens/example.webp').read_bytes())
            self.assertEqual(rows[0]['overview']['text'],'Example tool.')
            self.assertFalse((root/'atlas/public').exists())
            self.assertNotIn('<url>',(out/'sitemap.xml').read_text())

            checker=subprocess.run([sys.executable,str(root/'atlas/site/tools/check_overview_preview.py'),'--source',str(bundle/'overviews.json'),'--dist',str(out)],capture_output=True,text=True,timeout=30)
            self.assertEqual(checker.returncode,0,checker.stdout+checker.stderr)
