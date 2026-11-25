"""Added then closed is history in every full-catalogue consumer. Offline only."""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'atlas/site'), str(ROOT/'atlas/tools')]
import current_catalogue as cc
import link_safety as ls
import check

class CatalogueProjectionOrder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.cat = self.d/'catalogue'; self.cat.mkdir()
        self.snapshot = {'platforms':[{'slug':'open-one','status':'live','canonical_url':'https://shared.example/'}]}
        self.write('snapshot.json',self.snapshot)
        self.write('additions.json',{'platforms':[{'slug':'added-closed','status':'live','canonical_url':'https://shared.example/','claims':[{'statement':'Retained history'}]}]})
        self.write('closures.json',{'ids':['added-closed'],'reason':'Synthetic closure fixture','recorded_at':'2026-11-24T12:00:00Z'})
        self.write('overviews.json',{'format':'commonworld-atlas-overviews/1','cards':{'open-one':{'state':'draft','text':'Open fixture','sources':['https://shared.example/'],'visited_at':None,'check':None}}})
        self.write('additional-overviews.json',{'cards':{}})
        self.write('limitations.json',{'cards':{}})
    def tearDown(self):self.tmp.cleanup()
    def write(self,name,value):(self.cat/name).write_text(json.dumps(value))
    def report(self):
        return {'flagged':['shared.example'],'hosts':{'shared.example':{'entries':['added-closed','open-one'],'status':'flagged','flagged_by':['synthetic'],'sources':[{'name':'synthetic','verdict':'flagged','evidence_url':'https://proof.example/'}]}},'sources':[{'id':'synthetic','name':'Synthetic'}],'standard':'https://proof.example/','summary':{},'removed_hosts':{}}
    def test_projection_closed_addition_and_no_source_mutation(self):
        before=copy.deepcopy(self.snapshot)
        projected=cc.project_snapshot(self.snapshot,self.cat)
        self.assertEqual(projected['platforms'][1]['status'],'closed')
        self.assertEqual(projected['platforms'][1]['claims'],[{'statement':'Retained history'}])
        self.assertEqual(self.snapshot,before)
        isolated=cc.project_snapshot(self.snapshot,self.cat,include_additions=False)
        self.assertEqual(isolated,self.snapshot)
        with self.assertRaisesRegex(ValueError,'duplicate permanent ID'):
            cc.project_snapshot(projected,self.cat)
    def test_host_queries_skip_closed_addition_but_not_live_shared_host(self):
        self.assertEqual(ls.catalogue_hosts(self.cat,self.snapshot,[]),{'shared.example':['open-one']})
    def test_stale_flag_removes_live_only_preserves_closed_input_bytes(self):
        removed=self.d/'removed.json';removed.write_text('{"removed":[],"decisions":[]}')
        before={p.name:p.read_bytes() for p in self.cat.iterdir()}
        report=self.report()
        actions=ls.apply_removals(report,str(self.cat/'snapshot.json'),str(removed),None,set(),'2026-11-25',preserve_inputs=True)
        self.assertEqual([r['slug'] for r in actions],['open-one'])
        self.assertEqual([r['slug'] for r in json.loads(removed.read_text())['removed']],['open-one'])
        self.assertEqual({p.name:p.read_bytes() for p in self.cat.iterdir()},before)
        # An old report containing only the closed ID creates no removal decision.
        report=self.report();report['hosts']['shared.example']['entries']=['added-closed']
        saved=removed.read_bytes()
        self.assertEqual(ls.apply_removals(report,str(self.cat/'snapshot.json'),str(removed),None,set(),'2026-11-25',preserve_inputs=True),[])
        self.assertEqual(removed.read_bytes(),saved)
    def test_real_safety_cli_never_queries_or_removes_closed_addition(self):
        removed=self.d/'removed.json';removed.write_text('{"removed":[],"decisions":[]}')
        hold=self.d/'hold.json';hold.write_text('{"hold":[]}')
        engine=self.d/'engine.json';engine.write_text(json.dumps({'results':{'shared.example':{'sources':[{'name':'synthetic','verdict':'flagged','checked_at':'2026-11-24T12:00:00Z','evidence_url':'https://proof.example/'}]}},'sources':[{'id':'synthetic','name':'Synthetic','url':'https://proof.example/'}],'run_at':'2026-11-24T12:00:00Z'}))
        before={p.name:p.read_bytes() for p in self.cat.iterdir()}
        out=self.d/'out.json'
        cmd=[sys.executable,str(ROOT/'atlas/tools/link_safety.py'),'--catalogue-dir',str(self.cat),'--curation-dir',str(self.d),'--removed',str(removed),'--hold',str(hold),'--tags',str(self.d/'absent.json'),'--out',str(out),'--report-in',str(engine),'--apply']
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
        # A flagged live host still returns the existing nonzero CLI status.
        self.assertEqual(r.returncode,1,r.stdout+r.stderr)
        self.assertEqual([row['slug'] for row in json.loads(removed.read_text())['removed']],['open-one'])
        self.assertNotIn('added-closed',out.read_text())
        self.assertEqual({p.name:p.read_bytes() for p in self.cat.iterdir()},before)

    def test_real_workbench_cli_does_not_require_current_overview_for_closed_addition(self):
        before={p.name:p.read_bytes() for p in self.cat.iterdir()}
        cmd=[sys.executable,str(ROOT/'atlas/tools/overviews.py'),'validate','--file',str(self.cat/'overviews.json'),'--snapshot',str(self.cat/'snapshot.json')]
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=30)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertEqual({p.name:p.read_bytes() for p in self.cat.iterdir()},before)
    def test_growth_checker_expects_closed_addition_and_keeps_strict_archive_gate(self):
        dist=self.d/'dist';(dist/'atlas/data').mkdir(parents=True)
        (dist/'atlas/data/snapshot.json').write_text('{"platforms":[]}')
        site=self.d/'site';site.mkdir()
        baseline=self.d/'baseline.txt';baseline.write_text(check.ORIGIN+'/atlas/\n')
        locs={check.ORIGIN+'/atlas/'};seen=[]
        def archive(dist,locs,expected):
            seen.append(expected);return expected
        with patch.object(check,'HERE',str(site)),patch.object(check,'DIST',str(dist)),patch.object(check,'BASELINE',str(baseline)),patch.object(check,'load_redirects',return_value={}),patch.object(check,'load_removed',return_value=[]),patch.object(check,'_git_snapshot_slugs',return_value={'added-closed'}),patch.object(check,'_preserved_archive_slugs',side_effect=archive):
            self.assertEqual(check.growth_guard(locs),[])
            self.assertEqual(seen,[{'added-closed'}])
            with patch.object(check,'_preserved_archive_slugs',return_value=set()):
                self.assertTrue(any('added-closed' in fail for fail in check.growth_guard(locs)))
    def test_no_ad_hoc_membership_status_projection_in_consumers(self):
        # Low-level functions stay private to the single ordering implementation.
        import ast
        callers=[]
        for p in (ROOT/'atlas').rglob('*.py'):
            if p.name=='current_catalogue.py':continue
            for n in ast.walk(ast.parse(p.read_text())):
                if isinstance(n,ast.ImportFrom) and n.module=='current_catalogue':
                    self.assertFalse({'add_new','apply_closures'} & {a.name for a in n.names},str(p))
                    if any(a.name=='project_snapshot' for a in n.names):callers.append(p.relative_to(ROOT).as_posix())
        self.assertEqual(set(callers),{'atlas/site/build.py','atlas/site/check.py','atlas/tools/link_safety.py','atlas/tools/overviews.py'})
