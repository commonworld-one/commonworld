"""Exact shell failure paths and removed-only validator projection, fully offline."""
import json, os, re, subprocess, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import check
import cards_v2

class FailurePaths(unittest.TestCase):
    def test_actual_rebuild_body_reports_false_without_step_failure(self):
        text=(ROOT/'.github/workflows/link-safety.yml').read_text()
        block=text.split('      - name: Rebuild and check after a removal')[1].split('      - name: Commit')[0]
        body=block.split('        run: |\n')[1]
        body='\n'.join(line[10:] for line in body.splitlines())
        for failing in ('private','fetch','adapter','checker',None):
            with self.subTest(failing=failing),tempfile.TemporaryDirectory() as td:
                d=Path(td);bin=d/'bin';bin.mkdir();trace=d/'trace'
                (bin/'python').write_text('#!/bin/bash\necho "python $*" >> "$TRACE"\nif [[ "$FAIL_AT" == adapter && "$*" == *catalogue_build.py* ]] || [[ "$FAIL_AT" == checker && "$*" == *check.py* ]]; then exit 9; fi\nif [[ "$*" == *check.py* ]]; then echo "ALL CHECKS PASSED"; fi\n')
                (bin/'git').write_text('#!/bin/bash\necho git >> "$TRACE"\n[[ "$FAIL_AT" != fetch ]]\n')
                for p in bin.iterdir():p.chmod(0o755)
                env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'CW_PRIVATE_TERMS':'' if failing=='private' else 'synthetic','RUNNER_TEMP':td,'GITHUB_OUTPUT':str(d/'output'),'TRACE':str(trace),'FAIL_AT':failing or ''}
                result=subprocess.run(['bash','-e','-o','pipefail','-c',body],env=env,capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertIn('ok='+('true' if failing is None else 'false'),(d/'output').read_text())
                self.assertTrue((d/'check.txt').exists())
                if failing=='private':self.assertFalse(trace.exists())
        self.assertIn('committing only the report',text)
        self.assertIn('curator step',text)

    def test_checker_projects_only_explicit_removed_curation(self):
        with tempfile.TemporaryDirectory() as td:
            d=Path(td);(d/'atlas/platforms').mkdir(parents=True)
            # Stop after validator calls, before unrelated rendering comparisons.
            def capture(rows,*args):
                self.assertEqual(set(rows),{'unknown-unremoved'})
                return ['unknown-unremoved is not published']
            with patch.object(check,'DIST',td),patch.object(check,'load_removed',return_value=[{'slug':'gone'}]),patch.object(cards_v2,'load_keys_books',return_value={'gone':{},'unknown-unremoved':{}}),patch.object(cards_v2,'load_first_tasks',return_value={'gone':{},'unknown-unremoved':{}}),patch.object(cards_v2,'load_evidence_overrides',return_value={'gone':[],'unknown-unremoved':[]}),patch.object(cards_v2,'validate_keys_books',side_effect=capture),patch.object(cards_v2,'validate_evidence_overrides',side_effect=capture),patch.object(cards_v2,'validate_first_tasks',side_effect=capture):
                # End function reads platforms.json too.
                (d/'atlas/platforms.json').write_text('{"platforms":[]}')
                fails=check.cards_v2_checks({})
                self.assertEqual(sum('unknown-unremoved' in x for x in fails),3)

if __name__=='__main__':unittest.main()
