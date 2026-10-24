"""scripts/check-worker-post-links.py: the collector for Worker post links that lychee skips (follow-up to #99).

No network: the checker is exercised with a stubbed request function.
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('check_worker_post_links', ROOT / 'scripts' / 'check-worker-post-links.py')
wp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wp)


class Collect(unittest.TestCase):
    def test_absolute_links_and_fragments(self):
        t = ('see https://commonworld.one/posts/46#comment-98 and https://commonworld.one/v1/posts/37, '
             'https://www.commonworld.one/posts/4.md and (https://commonworld.one/posts/56).')
        self.assertEqual(wp.collect_text(t, 'x'), [(46, '#comment-98', 'x'), (37, None, 'x'), (4, None, 'x'), (56, None, 'x')])

    def test_not_ours_or_not_a_number(self):
        t = ('https://example.org/posts/12 https://commonworld.one/posts/ https://commonworld.one/posts/12-slug '
             'https://commonworld.one/posts/abc https://commonworld.one/postsx/3 https://notcommonworld.one/posts/5')
        self.assertEqual(wp.collect_text(t, 'x'), [])

    def test_relative_only_when_allowed(self):
        t = '<a href="/posts/18">a</a> <a href=\'/v1/posts/15#comment-3\'>b</a> <a href="/posts/2026-02-11-x">c</a>'
        self.assertEqual(wp.collect_text(t, 'p'), [])
        self.assertEqual(wp.collect_text(t, 'p', allow_relative=True), [(18, None, 'p'), (15, '#comment-3', 'p')])

    def test_dist_and_docs_walk(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / 'dist' / 'a').mkdir(parents=True)
            (d / 'dist' / 'a' / 'index.html').write_text('<a href="/posts/7">x</a>', encoding='utf-8')
            (d / 'dist' / 'a' / 'card.json').write_text('{"u": "/posts/8", "v": "https://commonworld.one/posts/9"}', encoding='utf-8')
            (d / 'dist' / 'img.png').write_bytes(b'https://commonworld.one/posts/1')
            (d / 'docs').mkdir()
            (d / 'docs' / 'X.md').write_text('[p](https://commonworld.one/posts/10)', encoding='utf-8')
            (d / 'node_modules').mkdir()
            (d / 'node_modules' / 'y.md').write_text('https://commonworld.one/posts/11', encoding='utf-8')
            self.assertEqual(wp.collect_dist(d / 'dist'), [(9, None, 'dist/a/card.json'), (7, None, 'dist/a/index.html')])
            # docs walk skips dist/ and node_modules/
            self.assertEqual(wp.collect_docs(d), [(10, None, 'docs/X.md')])

    def test_group_dedupes(self):
        g = wp.group([(5, None, 'a'), (5, '#comment-1', 'a'), (5, '#comment-1', 'b'), (2, None, 'c')])
        self.assertEqual(list(g), [2, 5])
        self.assertEqual(g[5]['sources'], ['a', 'b'])
        self.assertEqual(g[5]['fragments'], {'#comment-1': ['a', 'b']})


class Check(unittest.TestCase):
    def run_check(self, answers, grouped, **kw):
        orig = wp.request
        wp.request = lambda url, method='GET', **_: answers[(method, url)]
        try:
            return wp.check(grouped, 'https://cw.test', delay=0, out=lambda *_: None, **kw)
        finally:
            wp.request = orig

    def test_only_404_fails(self):
        grouped = wp.group([(1, '#comment-2', 'a'), (2, None, 'b'), (3, None, 'c')])
        answers = {
            ('GET', 'https://cw.test/v1/posts/1'): (200, b'{"withdrawn": false, "comments": [{"number": 9}]}', None),
            ('HEAD', 'https://cw.test/posts/1'): (200, None, None),
            ('GET', 'https://cw.test/v1/posts/2'): (404, None, None),
            ('HEAD', 'https://cw.test/posts/2'): (404, None, None),
            ('GET', 'https://cw.test/v1/posts/3'): (None, None, 'URLError: timed out'),
            ('HEAD', 'https://cw.test/posts/3'): (503, None, 'HTTP 503'),
        }
        broken, warnings = self.run_check(answers, grouped)
        self.assertEqual(len(broken), 1)
        self.assertIn('post 2', broken[0])
        self.assertTrue(any('#comment-2' in w for w in warnings))
        self.assertTrue(any('post 3' in w and 'timed out' in w for w in warnings))
        self.assertTrue(any('post 3' in w and '503' in w for w in warnings))

    def test_unreachable_worker_stops_early_as_warning(self):
        grouped = wp.group([(n, None, 'a') for n in range(1, 8)])
        answers = {(m, f'https://cw.test/{p}/{n}'): (None, None, 'URLError: down')
                   for n in range(1, 8) for m, p in (('GET', 'v1/posts'), ('HEAD', 'posts'))}
        broken, warnings = self.run_check(answers, grouped, max_unreachable=3)
        self.assertEqual(broken, [])
        self.assertTrue(any('4 posts not checked (Worker unreachable for 3 posts in a row): 4, 5, 6, 7' in w for w in warnings))

    def test_time_budget_leaves_rest_as_warning(self):
        grouped = wp.group([(1, None, 'a'), (2, None, 'a')])
        ok = (200, b'{"comments": []}', None)
        answers = {(m, f'https://cw.test/{p}/{n}'): ok for n in (1, 2) for m, p in (('GET', 'v1/posts'), ('HEAD', 'posts'))}
        ticks = iter([0, 0, 10, 10, 10])
        broken, warnings = self.run_check(answers, grouped, budget=5, clock=lambda: next(ticks))
        self.assertEqual(broken, [])
        self.assertEqual(warnings, ['1 posts not checked (time budget spent): 2'])

    def test_request_respects_deadline(self):
        self.assertEqual(wp.request('https://cw.test/x', deadline=wp.time.monotonic() - 1)[0], None)


if __name__ == '__main__':
    unittest.main()
