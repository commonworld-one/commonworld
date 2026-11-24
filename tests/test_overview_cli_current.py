import copy,json,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class CurrentWorkbenchCLI(unittest.TestCase):
    def test_real_commands_on_separate_current_sources(self):
        captures=ROOT/'atlas/site/.screens-cache'
        # The test can use an externally supplied package or the build cache.
        import os
        captures=Path(os.environ.get('CW_SCREENS_DIR',captures))
        if not (captures/'manifest.json').exists():self.skipTest('pinned captures package required')
        with tempfile.TemporaryDirectory() as td:
            d=Path(td)/'catalogue';shutil.copytree(ROOT/'atlas/catalogue',d)
            base=json.loads((d/'overviews.json').read_text());extra=json.loads((d/'additional-overviews.json').read_text());before=(d/'overviews.json').read_bytes()
            trial=[{'performed_at':'2026-11-22T18:40:00Z','service':'Synthetic fixture','action':'fixture','result':'fixture','access':'public','proof_url':'https://example.org/','cost':None}]
            replacement=Path(td)/'replacement.json'
            def run(action,slug,value):
                replacement.write_text(json.dumps(value))
                p=subprocess.run([sys.executable,str(ROOT/'atlas/tools/overviews.py'),action,'--file',str(d/'overviews.json'),'--snapshot',str(d/'snapshot.json'),'--screens-dir',str(captures),'--slug',slug,'--replacement',str(replacement)],capture_output=True,text=True)
                self.assertEqual(p.returncode,0,p.stderr)
            run('revise-trials','kradleverse',trial)
            first=json.loads((d/'overviews.json').read_text())['cards']['kradleverse'];original=base['cards']['kradleverse']
            for k in ['text','visited_at','sources','screenshot']:self.assertEqual(first[k],original[k])
            self.assertEqual(first['trials'],trial);self.assertEqual(first['state'],'draft');self.assertIsNone(first['check'])
            replacement_row={k:v for k,v in original.items() if k not in ['history','trials']}
            run('revise','kradleverse',replacement_row)
            self.assertEqual(json.loads((d/'overviews.json').read_text())['cards']['kradleverse']['trials'],trial)
            main_after=(d/'overviews.json').read_bytes();run('revise-trials','aptets',trial)
            self.assertEqual((d/'overviews.json').read_bytes(),main_after)
            new=json.loads((d/'additional-overviews.json').read_text())['cards']['aptets']
            revision_before=(d/'overviews.json').read_bytes();run('revise-trials','meta-muse',trial)
            self.assertEqual((d/'overviews.json').read_bytes(),revision_before)
            self.assertEqual(json.loads((d/'current-revisions.json').read_text())['cards']['meta-muse']['trials'],trial)
            self.assertEqual(new['trials'],trial);self.assertEqual(new['visited_at'],extra['cards']['aptets']['visited_at']);self.assertEqual(new['state'],'draft')
