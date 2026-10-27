"""JSON is for agents, not for search results (2026-10-26). Search Console listed API JSON (/api/v1/atlas/earn.json and the
platform's /v1/posts?...) among "crawled - currently not indexed" URLs. robots.txt stays open; instead every Atlas JSON file
says X-Robots-Tag: noindex (_headers) and every HTML link to one of our JSON files carries rel="nofollow"
(platform side: platform/test/json-noindex.test.ts)."""
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import build  # noqa: E402

DIST = ROOT / 'atlas' / 'site' / 'dist'


class NofollowJsonLinks(unittest.TestCase):
    def test_json_links_get_nofollow(self):
        f = build.nofollow_json_links
        self.assertEqual(f('<a href="/atlas/earn.json" type="application/json">'),
                         '<a href="/atlas/earn.json" type="application/json" rel="nofollow">')
        self.assertEqual(f('<a href="/api/v1/index.json">'), '<a href="/api/v1/index.json" rel="nofollow">')
        self.assertEqual(f('<link rel="alternate" type="application/json" href="/api/v1/atlas/page/1.json">'),
                         '<link rel="alternate nofollow" type="application/json" href="/api/v1/atlas/page/1.json">')

    def test_other_links_unchanged(self):
        f = build.nofollow_json_links
        for el in ('<a href="/atlas/earn/">', '<a href="/atlas/index.md">', '<link rel="canonical" href="https://commonworld.one/atlas/">',
                   '<a href="https://example.com/x.json" rel="nofollow noopener">', '<a href="/api/v1/x.json" rel="nofollow">'):
            self.assertEqual(f(el), el)


@unittest.skipUnless((DIST / '_headers').exists() and (DIST / 'atlas' / 'index.html').exists(), 'no Atlas build in atlas/site/dist')
class BuiltSite(unittest.TestCase):
    def test_json_rules_say_noindex(self):
        rules, cur = {}, None
        for line in (DIST / '_headers').read_text(encoding='utf-8').splitlines():
            if line and not line.startswith(' '):
                cur = line; rules[cur] = []
            elif cur and line.strip():
                rules[cur].append(line.strip())
        for pattern, headers in rules.items():
            if 'Content-Type: application/json; charset=utf-8' in headers:
                self.assertIn('X-Robots-Tag: noindex', headers, pattern)
        self.assertIn('X-Robots-Tag: noindex', rules['/api/*.json'])
        self.assertIn('X-Robots-Tag: noindex', rules['/atlas/data/*'])

    def test_robots_txt_stays_open(self):
        self.assertNotRegex((DIST / 'robots.txt').read_text(encoding='utf-8'), r'(?m)^Disallow:\s*/\S')

    def test_html_links_to_json_are_nofollow(self):
        bad = []
        for root, _, files in os.walk(DIST):
            for name in files:
                if not name.endswith('.html'):
                    continue
                path = Path(root) / name
                for el in re.findall(r'<(?:a|link)\b[^>]*>', path.read_text(encoding='utf-8')):
                    href = re.search(r'\bhref="([^"]*)"', el)
                    if href and build.is_json_href(href.group(1)):
                        rel = re.search(r'\brel="([^"]*)"', el)
                        if not rel or 'nofollow' not in rel.group(1).split():
                            bad.append(f'{path.relative_to(DIST)}: {el}')
        self.assertEqual(bad[:10], [])


if __name__ == '__main__':
    unittest.main()
