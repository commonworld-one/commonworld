"""atlas.js renderCard() must build exactly the card that build.card_from_row() builds (and the build asserts that
card_from_row gives back card_html for every card), so a card found by search or a filter looks like the same card on a
list page. Runs the real atlas.js function under node; skipped when node is not installed."""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import build  # noqa: E402

HEAD = {'card_base': '/atlas/platforms/', 'tag_href': '/atlas/?tag=', 'thumb': {'path': '/atlas/screens/t/', 'w': 600, 'h': 250},
        'cat_labels': {'social': 'Social & forums', 'work': 'Work <boards>'}, 'reach_text': {'stale': 'No read got "its" content'}, 'tag_limit': 6}
ROWS = [
    ['a1', 'A & B "quoted"', 'social', 'live', 'platform', "It's <fine>", ['3,440', 'citizens · all-time · 23 Oct 2026'], 'x402 mcp a2a usdc base token api', 1, 1, 1, 11, 1792846200, 0, 'words'],
    ['b2', 'Closed one', 'work', 'closed', 'project', 'Gone.', 0, '', 0, 0, 0, 0, 0, 0, ''],
    ['c3', 'Stale', 'social', 'live', 'protocol', 'Up?', 0, 'one', 0, 0, 1, 2, 5, ['stale', 'stale'], 'x'],
]
JS = r"""
const fs = require('fs'); const src = fs.readFileSync(process.argv[1], 'utf8');
const a = src.indexOf('var ESC'), b = src.indexOf('// the whole Atlas: fetched once');
const renderCard = new Function(src.slice(a, b) + '; return renderCard;')();
const inp = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(inp.rows.map(r => renderCard(inp.head, r))));
"""


@unittest.skipUnless(shutil.which('node'), 'node not installed')
class RenderCardMatchesBuild(unittest.TestCase):
    def test_same_markup(self):
        out = subprocess.run(['node', '-e', JS, str(ROOT / 'atlas' / 'site' / 'static' / 'atlas.js')], input=json.dumps({'head': HEAD, 'rows': ROWS}),
                             capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(out), [build.card_from_row(HEAD, r) for r in ROWS])


if __name__ == '__main__':
    unittest.main()
