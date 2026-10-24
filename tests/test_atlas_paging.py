"""Paged Atlas lists (ADR-0001, owner decisions D1-D4 of 2026-10-24): /atlas/ is page 1, /atlas/page/N/ the rest, 50 cards a
page; JSON pages under /api/v1/atlas/ (location: open question Q6, one function api_v1.page_json). The whole built site is
checked by atlas/site/check.py (paged_list_checks, paged_json_checks); these tests pin the rules of the helpers."""
import json
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


class SnapshotId(unittest.TestCase):
    REC = [{'id': 'a', 'name': 'A', 'link_safety': {'status': 'clean', 'checked_at': '2026-10-24T00:00:00Z'}, 'preview': None},
           {'id': 'b', 'name': 'B', 'link_safety': {'status': 'clean', 'checked_at': '2026-10-24T00:00:00Z'}, 'preview': None}]

    def test_stable_across_daily_link_check_and_screenshots(self):
        # the id is in the committed GitHub mirror: a daily link-safety report or a new screenshot must not change it (Codex review of #107)
        later = [r | {'link_safety': {'status': 'clean', 'checked_at': '2026-10-25T00:00:00Z'}, 'preview': {'path': '/atlas/screens/a.webp'}} for r in self.REC]
        self.assertEqual(build.snapshot_id_of(self.REC), build.snapshot_id_of(later))

    def test_checked_at_only_change_keeps_the_id(self):
        # Codex review of #107 (P1): a daily link-safety run that only moves checked_at must not change snapshot_id
        later = [r | {'link_safety': r['link_safety'] | {'checked_at': 'Sun 2026-10-25 3:00 AM EEST (UTC+03:00)'}} for r in self.REC]
        self.assertEqual(build.snapshot_id_of(self.REC), build.snapshot_id_of(later))

    def test_changes_with_the_list(self):
        sid = build.snapshot_id_of(self.REC)
        self.assertRegex(sid, r'^[0-9a-f]{16}$')
        self.assertNotEqual(sid, build.snapshot_id_of(self.REC[:1]))
        self.assertNotEqual(sid, build.snapshot_id_of([self.REC[0] | {'name': 'A2'}, self.REC[1]]))


class AzList(unittest.TestCase):
    """The A-Z list /atlas/platforms/ is paged like the other lists (#107): /atlas/platforms/page/N/, JSON
    /api/v1/atlas/platforms/page/N.json, and a letter jump bar that links each letter to the page where it starts."""

    def test_letters(self):
        self.assertEqual(build.az_letter('agentlux'), 'A')
        self.assertEqual(build.az_letter('Émile'), 'E')  # accents fold to their letter
        self.assertEqual(build.az_letter('0xAgents'), '#')
        self.assertEqual(build.az_letter('_x'), '#')
        self.assertEqual(build.az_letter(''), '#')
        self.assertEqual(check.az_letter('Émile'), build.az_letter('Émile'))  # check.py uses the same rule
        self.assertEqual(build.AZ_LETTERS, check.AZ_LETTERS)
        self.assertEqual(build.az_anchor('#'), 'az-0')
        self.assertEqual(build.az_anchor('Q'), 'az-q')

    def test_starts_name_the_page_where_a_letter_begins(self):
        cards = [{'slug': f'a{i}', 'name': f'A{i:03d}'} for i in range(60)] + [{'slug': 'b0', 'name': 'B'}, {'slug': 'c0', 'name': 'C'}]
        st = build.az_starts(cards)
        self.assertEqual(st, {'A': (1, 'a0'), 'B': (2, 'b0'), 'C': (2, 'c0')})
        h = build.az_jump_html('/atlas/platforms/', st)
        self.assertIn('href="/atlas/platforms/#az-a"', h)
        self.assertIn('href="/atlas/platforms/page/2/#az-b"', h)
        self.assertIn('<span aria-hidden="true">Z</span>', h)  # a letter with no entry is not a link
        self.assertEqual(h.count('<li>'), 27)

    def test_json_path_and_reserved_slug(self):
        self.assertEqual(api_v1.page_json(3, api_v1.AZ_LIST), '/atlas/platforms/page/3.json')
        self.assertTrue(check.AZ_JSON_RE.match('/atlas/platforms/page/3.json'))
        self.assertFalse(check.AZ_JSON_RE.match('/atlas/platforms/page.json'))
        self.assertNotRegex(api_v1.AZ_LIST, api_v1.ID_PATTERN)  # can never be a category id
        self.assertIn('page', build.RESERVED_SLUGS)
        self.assertTrue(check.is_card_url('/atlas/platforms/bountybook/'))
        for u in ('/atlas/platforms/', '/atlas/platforms/page/2/', '/atlas/platforms/page/'):
            self.assertFalse(check.is_card_url(u), u)
        self.assertTrue(check.PAGED_HTML_RE.match('/atlas/platforms/page/2/'))

    def test_openapi_promises_az_pages(self):
        spec = {'paths': {'/atlas/platforms/page/{page}.json': {}}}
        self.assertEqual(api_v1.expand_paths(spec, [], [], {None: 2}), ['/atlas/platforms/page/1.json', '/atlas/platforms/page/2.json'])


class SearchIndex(unittest.TestCase):
    """Slim search index (owner decision 2026-10-24): short rows, claim words the card does not show, a 60 KB gzip budget
    per file, shards by first letter once the whole index would be over it."""

    def test_budget_is_the_same_in_build_and_check(self):
        self.assertEqual(build.SEARCH_GZ_BUDGET, 60 * 1024)
        self.assertEqual(check.SEARCH_GZ_BUDGET, build.SEARCH_GZ_BUDGET)

    def test_words_leave_out_what_the_card_shows(self):
        c = {'name': 'Lightning Hub', '_desc': 'Pays agents in sats.', 'claims': [
            {'statement': 'Agents earned 12,000 sats over Lightning in October', 'unit': 'sats'}, {'statement': 'Open API for agents'}]}
        w = build.search_words(c).split()
        self.assertEqual(w, sorted(w))
        self.assertIn('earned', w)
        self.assertIn('october', w)
        self.assertIn('api', w)
        for gone in ('lightning', 'sats', 'agents', 'the', '12', '000', 'in'):
            self.assertNotIn(gone, w)

    def test_shards_are_contiguous_letter_slices_in_order(self):
        rows = [[f'r{i}', 'x' * 400 + str(i)] for i in range(60)]
        letters = ['A'] * 20 + ['B'] * 20 + ['C'] * 20
        big = build.shard_rows(rows, letters, 10 ** 9)
        self.assertEqual([(a, z, len(r)) for a, z, r in big], [('A', 'C', 60)])
        small = build.shard_rows(rows, letters, 1)  # tiny budget: one shard per letter, never cut inside a letter
        self.assertEqual([(a, z, len(r)) for a, z, r in small], [('A', 'A', 20), ('B', 'B', 20), ('C', 'C', 20)])
        self.assertEqual([r for _, _, rs in small for r in rs], rows)


class Redirects(unittest.TestCase):
    def run_with_baseline(self, site, urls, record=None):
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write('# baseline\n' + ''.join(u + '\n' for u in urls))
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as r:
            json.dump({'lists': record or {}}, r)
        old, old_rec = build.SITEMAP_BASELINE, build.PAGED_RECORD
        build.SITEMAP_BASELINE, build.PAGED_RECORD = f.name, r.name
        try:
            return build.paged_redirects(site).splitlines()
        finally:
            build.SITEMAP_BASELINE, build.PAGED_RECORD = old, old_rec
            os.unlink(f.name)
            os.unlink(r.name)

    def test_q8_a_page_that_ever_existed_never_404s(self):
        # owner decision Q8 (2026-10-24): the committed record of the highest page ever built; a shrunk list sends every
        # vanished page (HTML, Markdown twin, JSON) to its last page; numbers above the record never existed and stay 404
        site = FakeSite(120, {'social': 60})  # 3 pages now; social 2 pages
        lines = self.run_with_baseline(site, [], {'/atlas/': 5, '/atlas/platforms/': 5, '/atlas/categories/social/': 2, '/atlas/categories/gone/': 2})
        for n in (4, 5):
            self.assertIn(f'/atlas/page/{n}/ /atlas/page/3/ 301', lines)
            self.assertIn(f'/atlas/page/{n} /atlas/page/3/ 301', lines)
            self.assertIn(f'/atlas/page/{n}/index.md /atlas/page/3/index.md 301', lines)
            self.assertIn(f'/api/v1/atlas/page/{n}.json /api/v1/atlas/page/3.json 301', lines)
            self.assertIn(f'/atlas/platforms/page/{n}/ /atlas/platforms/page/3/ 301', lines)
            self.assertIn(f'/atlas/platforms/page/{n}/index.md /atlas/platforms/page/3/index.md 301', lines)
            self.assertIn(f'/api/v1/atlas/platforms/page/{n}.json /api/v1/atlas/platforms/page/3.json 301', lines)
        self.assertFalse(any(l.startswith(('/atlas/page/6', '/atlas/platforms/page/6', '/api/v1/atlas/page/6')) for l in lines))  # never existed
        self.assertFalse(any(l.startswith(('/atlas/page/3', '/atlas/page/2')) for l in lines))  # still exist
        self.assertFalse(any(l.startswith('/atlas/categories/social/page/2') for l in lines))  # social still has 2 pages
        self.assertIn('/atlas/categories/gone/page/2/ /atlas/ 301', lines)  # a whole list gone: to the Atlas home
        self.assertIn('/api/v1/atlas/categories/gone/page/2.json /api/v1/atlas/page/1.json 301', lines)

    def test_record_file_covers_every_list(self):
        rec = build.load_paged_record()
        self.assertIn('/atlas/', rec)
        self.assertIn('/atlas/platforms/', rec)
        self.assertEqual(rec['/atlas/'], rec['/atlas/platforms/'])

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
        # card URLs are never redirected; only the A-Z list's own /page/1/ rule names /atlas/platforms/
        self.assertEqual([l for l in lines if l.startswith('/atlas/platforms/')],
                         ['/atlas/platforms/page/1/ /atlas/platforms/ 301', '/atlas/platforms/page/1 /atlas/platforms/ 301'])

    def test_az_list_page_1_and_shrinking(self):
        O = 'https://commonworld.one'
        lines = self.run_with_baseline(FakeSite(120, {}), [O + '/atlas/platforms/page/3/', O + '/atlas/platforms/page/5/'])
        self.assertIn('/atlas/platforms/page/1/ /atlas/platforms/ 301', lines)
        self.assertNotIn('/atlas/platforms/page/3/ /atlas/platforms/page/3/ 301', lines)
        self.assertIn('/atlas/platforms/page/5/ /atlas/platforms/page/3/ 301', lines)


if __name__ == '__main__':
    unittest.main()
