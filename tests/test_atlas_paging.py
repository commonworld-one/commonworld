"""Paged Atlas lists (ADR-0001, owner decisions D1-D4 of 2026-10-24): /atlas/ is page 1, /atlas/page/N/ the rest, 50 cards a
page; JSON pages under /api/v1/atlas/ (location: open question Q6, one function api_v1.page_json). The whole built site is
checked by atlas/site/check.py (paged_list_checks, paged_json_checks); these tests pin the rules of the helpers."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import api_v1  # noqa: E402
import build  # noqa: E402
import check  # noqa: E402


class FakeSite:
    base, origin = '/atlas', 'https://commonworld.one'

    def __init__(self, n_all, cats):
        self.cards = [{'slug': f'c{i}', 'name': f'C{i:04d}', 'status': 'live', 'category': 'social'} for i in range(n_all)]
        self.cats = list(cats)
        self.by_cat = {k: [{'slug': f'{k}{i}', 'name': f'{k}{i:04d}', 'status': 'live', 'category': k} for i in range(n)] for k, n in cats.items()}

    def abs(self, p):
        return self.origin + p


class Helpers(unittest.TestCase):
    def test_one_page_size_everywhere(self):
        self.assertEqual(build.PAGE_SIZE, 50)
        self.assertEqual(api_v1.PAGE_SIZE, build.PAGE_SIZE)
        self.assertEqual(check.PAGE_SIZE, build.PAGE_SIZE)

    def test_chunks(self):
        self.assertEqual([len(x) for x in build.chunks(list(range(374)))], [50] * 7 + [24])
        self.assertEqual([len(x) for x in build.chunks(list(range(100)))], [50, 50])  # no empty page after a full one
        self.assertEqual(build.chunks([]), [[]])  # page 1 always exists

    def test_list_path_page_1_is_the_list(self):
        self.assertEqual(build.list_path('/atlas/', 1), '/atlas/')
        self.assertEqual(build.list_path('/atlas/', 2), '/atlas/page/2/')
        self.assertEqual(build.list_path('/atlas/categories/social/', 3), '/atlas/categories/social/page/3/')

    def test_page_json_paths(self):
        self.assertEqual(api_v1.page_json(1), '/atlas/page/1.json')
        self.assertEqual(api_v1.page_json(4, 'work'), '/atlas/categories/work/page/4.json')
        for p in (api_v1.page_json(2), api_v1.page_json(2, 'social')):
            self.assertTrue(check.PAGED_JSON_RE.match(p), p)
        self.assertFalse(check.PAGED_JSON_RE.match('/atlas/platforms/page.json'))  # a card slug "page" never collides

    def test_pager(self):
        self.assertEqual(build.pager_html('/atlas/', 1, 1), '')
        h = build.pager_html('/atlas/', 1, 8)
        self.assertIn('Page 1 of 8', h)
        self.assertNotIn('rel="prev"', h)
        self.assertIn('rel="next" href="/atlas/page/2/"', h)
        self.assertIn('href="/atlas/" aria-current="page"', h)
        h = build.pager_html('/atlas/', 8, 8)
        self.assertIn('rel="prev" href="/atlas/page/7/"', h)
        self.assertNotIn('rel="next"', h)
        h = build.pager_html('/atlas/', 5, 20)
        for n in (1, 3, 4, 5, 6, 7, 20):
            self.assertIn(f'aria-label="Page {n}"', h)
        self.assertNotIn('aria-label="Page 2"', h)
        self.assertEqual(h.count('class="gap"'), 2)

    def test_item_list_positions_continue(self):
        site = FakeSite(0, {})
        cs = [{'_url': f'/atlas/platforms/x{i}/'} for i in range(3)]
        ld = build.page_item_list(site, cs, 'x', 3)
        self.assertEqual([x['position'] for x in ld['itemListElement']], [101, 102, 103])

    def test_expand_paths_pages(self):
        spec = {'paths': {'/atlas/page/{page}.json': {}, '/atlas/categories/{category}/page/{page}.json': {}, '/atlas/platforms/{id}.json': {}}}
        out = api_v1.expand_paths(spec, ['a'], ['social', 'wiki'], {None: 3, 'social': 2, 'wiki': 1})
        self.assertEqual(out, ['/atlas/page/1.json', '/atlas/page/2.json', '/atlas/page/3.json', '/atlas/categories/social/page/1.json',
                               '/atlas/categories/social/page/2.json', '/atlas/categories/wiki/page/1.json', '/atlas/platforms/a.json'])


class Redirects(unittest.TestCase):
    def run_with_baseline(self, site, urls):
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write('# baseline\n' + ''.join(u + '\n' for u in urls))
        old = build.SITEMAP_BASELINE
        build.SITEMAP_BASELINE = f.name
        try:
            return build.paged_redirects(site).splitlines()
        finally:
            build.SITEMAP_BASELINE = old
            os.unlink(f.name)

    def test_page_1_redirects_to_the_list(self):
        lines = self.run_with_baseline(FakeSite(120, {'social': 10}), [])
        self.assertIn('/atlas/page/1/ /atlas/ 301', lines)
        self.assertIn('/atlas/page/1 /atlas/ 301', lines)
        self.assertIn('/atlas/categories/social/page/1/ /atlas/categories/social/ 301', lines)

    def test_published_page_past_the_end_moves_to_the_last_page(self):
        O = 'https://commonworld.one'
        lines = self.run_with_baseline(FakeSite(120, {'social': 10}), [O + '/atlas/page/3/', O + '/atlas/page/4/', O + '/atlas/categories/social/page/2/',
                                                                         O + '/atlas/categories/gone/page/2/', O + '/atlas/platforms/x/'])
        self.assertNotIn('/atlas/page/3/ /atlas/page/3/ 301', lines)  # page 3 still exists (120 cards = 3 pages)
        self.assertIn('/atlas/page/4/ /atlas/page/3/ 301', lines)
        self.assertIn('/atlas/categories/social/page/2/ /atlas/categories/social/ 301', lines)
        self.assertIn('/atlas/categories/gone/page/2/ /atlas/ 301', lines)
        self.assertFalse(any(l.startswith('/atlas/platforms/') for l in lines))


if __name__ == '__main__':
    unittest.main()
