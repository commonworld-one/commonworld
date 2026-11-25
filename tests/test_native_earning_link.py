"""The earning counter is ordinary navigation, never a DOM-to-script URL redirect."""
from html.parser import HTMLParser
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site/components'))
import cw_components as cw

class NativeEarningLink(unittest.TestCase):
    def test_link_tile_is_native_and_button_filters_unchanged(self):
        link=cw.stats_strip([('71','Earn',{'href':'/atlas/earn/'},None,True)])
        self.assertIn('<a class="cw-stat" href="/atlas/earn/">',link)
        self.assertNotIn('aria-pressed',link)
        button=cw.stats_strip([('349','Live',{'data-filter':'reset'},'live',True)])
        self.assertIn('<button class="cw-stat" type="button" aria-pressed="false"',button)
    def test_dom_redirect_primitive_removed(self):
        js=(ROOT/'atlas/site/static/atlas.js').read_text()
        self.assertNotIn('data-href',js)
        self.assertNotIn('window.location.href=',js)
        source=(ROOT/'atlas/site/build.py').read_text()
        self.assertIn("{'href': site.base + '/earn/'}",source)
        self.assertNotIn("'data-href'",source)
    def test_link_attributes_remain_escaped(self):
        link=cw.stats_strip([('71','<Earn>',{'href':'/atlas/earn/?x="<&'},None,True)])
        self.assertIn('&lt;Earn&gt;',link)
        self.assertIn('&quot;&lt;&amp;',link)
