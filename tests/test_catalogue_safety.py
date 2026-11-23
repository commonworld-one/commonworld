"""Offline synthetic safety tests. No source visits or real safety decisions."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/tools'))
sys.path.insert(0,str(ROOT/'atlas/site'))
import overviews
import catalogue_safety as cs
import link_safety as ls


class CatalogueSafety(unittest.TestCase):
    def test_projection_only_explicit_removed_ids_without_mutation(self):
        doc={'format':'x','cards':{'good':{'text':'keep'},'bad':{'text':'retain in source'},'unknown':{}}}
        before=copy.deepcopy(doc)
        active=cs.active_document(doc,{'bad'})
        self.assertEqual(set(active['cards']),{'good','unknown'})
        self.assertEqual(doc,before)

    def test_current_url_union_excludes_editorial_history(self):
        with tempfile.TemporaryDirectory() as td:
            cat=Path(td)
            record={'text':'Read https://prose.example/','sources':['https://source.example/'],
                    'trials':[{'proof_url':'https://proof.example/','result':'https://result.example/'}],
                    'screenshot':{'source_url':'https://capture.example/'},
                    'history':[{'sources':['https://history.example/']}],
                    'editor_note':'https://private.example/','check':{'evidence':'https://review.example/'}}
            (cat/'overviews.json').write_text(json.dumps({'cards':{'sample':record}}))
            (cat/'limitations.json').write_text(json.dumps({'cards':{'limited':{'sources':['https://limited.example/']}}}))
            snap={'platforms':[{'slug':'sample','canonical_url':'https://official.example/'}, {'slug':'limited'}]}
            with patch.object(ls,'DATA',td):hosts=ls.catalogue_hosts(cat,snap,[])
            self.assertEqual(set(hosts),{'official.example','prose.example','source.example','proof.example','result.example','capture.example','limited.example'})
            self.assertEqual(hosts['capture.example'],['sample'])

    def test_unknown_current_id_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td)
            for name in ('overviews','limitations'):(d/(name+'.json')).write_text(json.dumps({'cards':{'unknown':{}}}))
            with self.assertRaisesRegex(ValueError,'unknown'):ls.catalogue_hosts(d,{'platforms':[]},[])

    def test_overlay_removal_preserves_every_source_byte_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td);snap=d/'snapshot.json';removed=d/'removed.json';tags=d/'tags.json';cur=d/'first-tasks.json'
            snap.write_text(json.dumps({'platforms':[{'slug':'sample','canonical_url':'https://official.example/'}],'count':1}))
            removed.write_text(json.dumps({'removed':[],'decisions':[]}));tags.write_text('{"tags":{"sample":["x"]}}');cur.write_text('{"tasks":{"sample":{"text":"history"}}}')
            files=[(str(cur),'tasks')];before={p:p.read_bytes() for p in (snap,tags,cur)}
            report={'flagged':['source.example'],'hosts':{'source.example':{'entries':['sample'],'flagged_by':['test'],
                    'sources':[{'name':'test','verdict':'flagged','evidence_url':'https://evidence.example/'}], 'status':'flagged'}},'sources':[{'id':'test','name':'Synthetic source'}], 'standard':'https://evidence.example/','removed_hosts':{},'summary':{}}
            acts=ls.apply_removals(report,str(snap),str(removed),str(tags),set(),'2026-11-23',files,preserve_inputs=True)
            self.assertEqual([a['slug'] for a in acts],['sample'])
            self.assertEqual({p:p.read_bytes() for p in before},before)
            self.assertNotIn('source.example',report['hosts'])
            self.assertIn('source.example',report['removed_hosts'])
            count=len(json.loads(removed.read_text())['decisions'])
            self.assertEqual(ls.apply_removals(report,str(snap),str(removed),str(tags),set(),'2026-11-23',files,preserve_inputs=True),[])
            self.assertEqual(len(json.loads(removed.read_text())['decisions']),count)

    def test_empty_selected_projection_allowed_but_none_not_allowed(self):
        site=SimpleNamespace(cards=[],shots={},safety={'hosts':{}})
        overviews.attach(site,{'format':overviews.VERSION,'cards':{}},expected=[])
        with self.assertRaises(ValueError):overviews.attach(site,{'format':overviews.VERSION,'cards':{}},expected=None)

    def test_catalogue_cli_source_flag_removes_via_overlay_no_network(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td);cat=d/'catalogue';cat.mkdir()
            snap={'count':2,'platforms':[{'slug':'sample','canonical_url':'https://official.example/'},{'slug':'held','canonical_url':'https://held.example/'}]}
            (cat/'snapshot.json').write_text(json.dumps(snap))
            (cat/'overviews.json').write_text(json.dumps({'cards':{'sample':{'sources':['https://source.example/']}}}))
            (cat/'limitations.json').write_text(json.dumps({'cards':{'held':{'sources':['https://held.example/']}}}))
            (d/'removed.json').write_text('{"removed":[],"decisions":[]}')
            (d/'hold.json').write_text('{"hold":["held.example"]}')
            source={'id':'synthetic','name':'Synthetic','url':'https://evidence.example/'}
            results={h:{'sources':[{'name':'synthetic','verdict':v,'checked_at':'2026-11-23T00:00:00Z','evidence_url':'https://evidence.example/'}]} for h,v in [('source.example','flagged'),('official.example','no_data'),('held.example','flagged')]}
            (d/'engine.json').write_text(json.dumps({'results':results,'sources':[source],'run_at':'2026-11-23T00:00:00Z'}))
            before={p.name:p.read_bytes() for p in cat.iterdir()}
            args=['--catalogue-dir',str(cat),'--curation-dir',str(d),'--removed',str(d/'removed.json'),'--hold',str(d/'hold.json'),'--tags',str(d/'absent.json'),'--out',str(d/'out.json'),'--report-in',str(d/'engine.json'),'--apply']
            with patch.object(ls,'DATA',str(d)),patch.object(ls,'run_engine',side_effect=AssertionError('network forbidden')):
                self.assertEqual(ls.main(args),1)
            self.assertEqual({p.name:p.read_bytes() for p in cat.iterdir()},before)
            self.assertEqual([r['slug'] for r in json.loads((d/'removed.json').read_text())['removed']],['sample'])
            self.assertEqual(json.loads((d/'out.json').read_text())['hosts']['held.example']['status'],'flagged')

    def test_repeated_errors_cannot_erase_a_previous_flag(self):
        prev={'sources':[{'name':'synthetic','verdict':'flagged','checked_at':'2026-11-20T00:00:00Z','evidence_url':'https://evidence.example/'}]}
        err={'sources':[{'name':'synthetic','verdict':'no_data','checked_at':None,'error':'offline timeout','evidence_url':'https://evidence.example/'}]}
        for _ in range(3):
            prev=ls.merge_host(err,prev)
            self.assertEqual(prev['status'],'flagged')
            self.assertTrue(prev['sources'][0]['stale'])

    def test_workflow_keeps_security_and_uses_catalogue_without_preflight_stop(self):
        text=(ROOT/'.github/workflows/link-safety.yml').read_text()
        self.assertIn('schedule:',text);self.assertIn("cron: '17 4 * * *'",text)
        self.assertIn('--catalogue-dir atlas/catalogue --apply',text)
        self.assertIn('catalogue_build.py --mode accepted',text)
        self.assertNotIn('legacy-guard',text)
        self.assertIn('atlas/data/removed.json atlas/data/link-safety.json atlas/public',text)


if __name__=='__main__':unittest.main()
