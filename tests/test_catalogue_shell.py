"""Accepted shell is not a draft; local preview stays visibly non-release."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]

class CatalogueShellTests(unittest.TestCase):
    def test_accepted_and_preview_use_distinct_flags(self):
        # Full rendered accepted and preview assertions are also exercised by browser/build checks.
        source=(ROOT/'atlas/site/build.py').read_text()
        self.assertIn("if getattr(site, 'overview_preview', False) else ('' if getattr(site, 'catalogue_mode', False) else cw.announcement_bar(cfg))",source)
        self.assertIn("· dated source overviews",source)
        self.assertIn('Local working preview.',source)
    def test_recent_sort_is_total_for_mixed_dated_undated(self):
        import subprocess
        text=(ROOT/'atlas/site/static/atlas.js').read_text()
        line=next(s for s in text.splitlines() if "by === 'recent'" in s)
        expression=line.split('return ',1)[1].split(' || name',1)[0]
        script="const rows=[{s:'a',dataset:{}},{s:'b',dataset:{ver:'20'}},{s:'c',dataset:{ver:'10'}},{s:'d',dataset:{}}];rows.sort((a,b)=>"+expression+"); if(rows.map(r=>r.s).join(',')!=='b,c,a,d') process.exit(1); if('ver' in rows[2].dataset) process.exit(2);"
        subprocess.run(['node','-e',script],check=True)
