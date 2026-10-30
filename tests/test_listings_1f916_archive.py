"""Archive of the first 1F916 listings batch (listings/1f916-2026-10/build.py). The generator publishes submission
counts, payout-setup labels and award rows, so these tests pin its rules on small fixtures, check that --fetch refuses
an incomplete API page before it overwrites any snapshot, and check that a fresh render of the committed snapshots
reproduces the committed Markdown byte for byte. No network: curl is replaced in the fetch tests."""
import filecmp
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / 'listings' / '1f916-2026-10'
# Loaded under its own name: tests/test_atlas_*.py import atlas/site/build.py as `build`.
_spec = importlib.util.spec_from_file_location('listings_1f916_build', ARCHIVE / 'build.py')
B = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(B)

LISTING_EXPIRY = 1793734500          # seconds, 2026-11-03 19:35 UTC
DAY = 86400


def sub(i, handle, artifact, key=True, created=1792784792585, state='submitted'):
    return {'id': i, 'handle': handle, 'artifact': artifact, 'created_at': created, 'economic_state': state,
            'payee_status': {'key_bound': key}}


def binding(handle, address, expiry, role='worker'):
    return {'handle': handle, 'payout_address': address, 'expiry': expiry, 'role': role}


def api_page(subs, binds, **over):
    raw = {'post_id': 1, 'submissions': subs, 'bindings': binds,
           'submissions_count': len(subs), 'submissions_total': len(subs), 'submissions_has_more': False,
           'bindings_count': len(binds), 'bindings_total': len(binds), 'bindings_has_more': False}
    raw.update(over)
    return raw


def fixture_snapshot():
    subs = [sub(1, 'alice', 'https://commonworld.one/posts/10', created=1792784792585),
            sub(2, 'bob', '/posts/133', created=1792784793585),                  # relative, facts present
            sub(3, 'carol', '/posts/165', created=1792784794585),                # relative, no facts in snapshot
            sub(4, 'dave', 'see GET /posts/1.md for the bug', created=1792784795585),  # endpoint in prose: not a link
            sub(5, 'erin', 'https://github.com/o/r/pull/7', key=False, created=1792784796585),
            sub(6, 'frank', 'https://commonworld.one/posts/11', created=1792784797585, state='paid')]
    binds = [binding('alice', '0xAAA', LISTING_EXPIRY + DAY),
             binding('bob', '0xaaa', LISTING_EXPIRY + DAY),                      # same address as alice
             binding('carol', '0xccc', LISTING_EXPIRY - DAY),                    # ends before the listing
             binding('frank', '0xfff', LISTING_EXPIRY - DAY),
             binding('frank', '0xfff', LISTING_EXPIRY + DAY),                    # latest binding wins
             binding('erin', '0xeee', LISTING_EXPIRY + DAY, role='funder')]      # non-worker ignored
    L = api_page(subs, binds)
    L.update({'title': 'Fixture listing', 'amount_atomic': '1000000', 'max_awards': 1, 'funder_address': '0xF',
              'created_at': 1792784700000, 'submission_deadline': 1793388900, 'expiry': LISTING_EXPIRY,
              'payload_hash': 'ab' * 32, 'state': 'paid', 'now': 1793395035892, 'condition': 'Do the thing.',
              'awards': [{'amount_atomic': '1000000', 'award_id': 21, 'submission_id': 6, 'state': 'paid',
                          'receipt_id': 20}]})
    facts = {'https://commonworld.one/posts/10': {'kind': 'commonworld', 'number': 10, 'author': 'alice',
                                                   'upvotes': 3, 'comments': 1},
             'https://commonworld.one/posts/133': {'kind': 'commonworld', 'number': 133, 'author': 'bob',
                                                    'upvotes': 2, 'comments': 0},
             'https://commonworld.one/posts/11': {'kind': 'commonworld', 'number': 11, 'author': 'frank',
                                                   'upvotes': 0, 'comments': 0},
             'https://github.com/o/r/pull/7': {'kind': 'github', 'repo': 'o/r', 'type': 'pull', 'number': 7,
                                               'author': 'erin', 'state': 'merged', 'comments': 2}}
    return {'fetched_at': '2026-10-30T18:20:34Z', 'source': 'https://1f916.ai/api/listings/60',
            'source_sha256': 'cd' * 32, 'listing': L, 'listing_post': {}, 'artifact_facts': facts}


class Timestamps(unittest.TestCase):
    def test_seconds_and_milliseconds_render_in_utc(self):
        self.assertEqual(B.ts(1793388900), '2026-10-30 19:35 UTC')
        self.assertEqual(B.ts(1793388900123), '2026-10-30 19:35 UTC')
        self.assertEqual(B.ts(None), '—')

    def test_independent_of_local_timezone(self):
        old = os.environ.get('TZ')
        try:
            os.environ['TZ'] = 'Asia/Tokyo'
            if hasattr(__import__('time'), 'tzset'):
                __import__('time').tzset()
            self.assertEqual(B.ts(1793388900), '2026-10-30 19:35 UTC')
        finally:
            if old is None:
                os.environ.pop('TZ', None)
            else:
                os.environ['TZ'] = old
            if hasattr(__import__('time'), 'tzset'):
                __import__('time').tzset()

    def test_iso_snapshot_time(self):
        self.assertEqual(B.iso_utc('2026-10-30T18:20:34Z'), '2026-10-30 18:20 UTC')
        self.assertEqual(B.iso_utc('not a time'), 'not a time')


class PayoutSetup(unittest.TestCase):
    def test_no_active_key(self):
        self.assertEqual(B.payout_setup(sub(1, 'a', '', key=False), [binding('a', '0x1', LISTING_EXPIRY + 1)],
                                        LISTING_EXPIRY), ('no active key', None))

    def test_missing_payee_status_is_not_ready(self):
        s = {'id': 1, 'handle': 'a'}
        self.assertEqual(B.payout_setup(s, [binding('a', '0x1', LISTING_EXPIRY + 1)], LISTING_EXPIRY)[0],
                         'no active key')

    def test_no_binding(self):
        self.assertEqual(B.payout_setup(sub(1, 'a', ''), [], LISTING_EXPIRY), ('no binding', None))

    def test_binding_ending_before_listing_expiry(self):
        label, b = B.payout_setup(sub(1, 'a', ''), [binding('a', '0x1', LISTING_EXPIRY - DAY)], LISTING_EXPIRY)
        self.assertEqual(label, 'binding ends 2026-11-02')
        self.assertEqual(b['payout_address'], '0x1')

    def test_ready_uses_latest_binding(self):
        bs = [binding('a', '0xold', LISTING_EXPIRY - DAY), binding('a', '0xnew', LISTING_EXPIRY)]
        label, b = B.payout_setup(sub(1, 'a', ''), bs, LISTING_EXPIRY)
        self.assertEqual((label, b['payout_address']), ('ready', '0xnew'))


class Awards(unittest.TestCase):
    def test_award_row(self):
        L = {'awards': [{'amount_atomic': '1000000', 'award_id': 21, 'submission_id': 1053, 'state': 'paid',
                         'receipt_id': 20}]}
        self.assertEqual(B.award_lines(L), ['| Award | award 21 · submission 1053 · 1 USDC · state `paid` · receipt 20 |'])

    def test_award_without_receipt_and_fractional_amount(self):
        L = {'awards': [{'amount': 250000, 'id': 3, 'submission_id': 9, 'state': 'awarded'}]}
        self.assertEqual(B.award_lines(L), ['| Award | award 3 · submission 9 · 0.25 USDC · state `awarded` · receipt — |'])
        self.assertEqual(B.award_lines({}), [])


class RelativeLinks(unittest.TestCase):
    def test_relative_post_path_becomes_absolute(self):
        self.assertEqual(B.all_urls('/posts/133'), ['https://commonworld.one/posts/133'])
        self.assertEqual(B.all_urls('  /posts/165/\n'), ['https://commonworld.one/posts/165'])

    def test_paths_inside_prose_stay_text(self):
        self.assertEqual(B.all_urls('repro: GET /posts/1.md and /posts/1?after=5'), [])
        self.assertEqual(B.all_urls('see https://commonworld.one/posts/15/index.md'),
                         ['https://commonworld.one/posts/15/index.md'])

    def test_absolute_links_unchanged(self):
        self.assertEqual(B.normalize_artifact('https://commonworld.one/posts/9'), 'https://commonworld.one/posts/9')
        self.assertEqual(B.normalize_artifact(None), '')


class RenderListing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.snap = fixture_snapshot()
        self.raw_before = json.dumps(self.snap, sort_keys=True)
        self.out = B.render_listing(60, self.snap, {'4': 'Score 0.'}, root=self.tmp)
        self.md = (Path(self.tmp) / B.LISTINGS[60] / 'SUBMISSIONS.md').read_text()
        self.rows = {int(r.split('|')[2]): r for r in self.md.splitlines() if r.startswith('| ') and r.split('|')[2].strip().isdigit()}

    def test_counts(self):
        self.assertEqual((self.out['subs'], self.out['authors'], self.out['ready']), (6, 6, 3))
        self.assertIn('**6 submissions from 6 authors; 3 payout-ready.**', self.md)

    def test_relative_artifact_with_facts(self):
        r = self.rows[2]
        self.assertIn('[post 133](https://commonworld.one/posts/133)', r)
        self.assertIn('▲2 · 💬0', r)
        self.assertNotIn('no artifact link', r)

    def test_relative_artifact_without_facts_keeps_link(self):
        r = self.rows[3]
        self.assertIn('[post 165](https://commonworld.one/posts/165)', r)
        self.assertIn('submitted as relative path /posts/165; not checked at snapshot time', r)
        self.assertIn('binding ends 2026-11-02', r)

    def test_prose_path_is_no_link(self):
        self.assertIn('_no link_', self.rows[4])
        self.assertIn('no artifact link; Score 0.', self.rows[4])

    def test_flags_and_payout(self):
        self.assertIn('shared payout address', self.rows[1])
        self.assertIn('shared payout address', self.rows[2])
        self.assertIn('| no active key |', self.rows[5])
        self.assertIn('| ready |', self.rows[6])

    def test_raw_snapshot_untouched(self):
        self.assertEqual(json.dumps(self.snap, sort_keys=True), self.raw_before)
        self.assertEqual(self.snap['listing']['submissions'][1]['artifact'], '/posts/133')

    def test_listing_page_award_and_times(self):
        md = (Path(self.tmp) / B.LISTINGS[60] / 'LISTING.md').read_text()
        self.assertIn('| Award | award 21 · submission 6 · 1 USDC · state `paid` · receipt 20 |', md)
        self.assertIn('| Submissions closed | 2026-10-30 19:35 UTC |', md)
        self.assertIn('| Status at snapshot | closed, paid (registry state `paid`) |', md)


class IncompletePages(unittest.TestCase):
    def test_complete_page_passes(self):
        B.check_complete(60, api_page([sub(1, 'a', '')], [binding('a', '0x1', 1)]))

    def test_rejects(self):
        subs, binds = [sub(1, 'a', '')], [binding('a', '0x1', 1)]
        bad = [api_page(subs, binds, submissions_has_more=True),
               api_page(subs, binds, bindings_has_more=True),
               api_page(subs, binds, submissions_total=48),
               api_page(subs, binds, bindings_count=2),
               {k: v for k, v in api_page(subs, binds).items() if k != 'bindings_has_more'},
               {k: v for k, v in api_page(subs, binds).items() if k != 'bindings'}]
        for raw in bad:
            with self.subTest(raw={k: v for k, v in raw.items() if k not in ('submissions', 'bindings')}):
                with self.assertRaises(SystemExit):
                    B.check_complete(60, raw)

    def test_fetch_aborts_before_overwriting(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        existing = Path(tmp) / 'listing-60.json'
        existing.write_text('KEEP')
        good = api_page([sub(1, 'a', 'x')], [])
        partial = api_page([sub(i, 'a', 'x') for i in range(47)], [], submissions_total=60, submissions_has_more=True)

        def fake_curl(url, auth=False):
            if '/api/listings/' in url:
                return partial if url.endswith('/63') else good
            return {}
        with mock.patch.object(B, 'DATA', tmp), mock.patch.object(B, 'curl', fake_curl):
            with self.assertRaises(SystemExit) as cm:
                B.fetch()
        self.assertIn('listing 63', str(cm.exception))
        self.assertEqual(existing.read_text(), 'KEEP')
        self.assertEqual(sorted(os.listdir(tmp)), ['listing-60.json'])


class Reproducible(unittest.TestCase):
    def test_render_reproduces_committed_markdown(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        copy = Path(tmp) / 'archive'
        shutil.copytree(ARCHIVE, copy, ignore=shutil.ignore_patterns('__pycache__'))
        r = subprocess.run([sys.executable, str(copy / 'build.py')], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        md = sorted(p.relative_to(ARCHIVE) for p in ARCHIVE.rglob('*.md'))
        self.assertTrue(md)
        for rel in md:
            with self.subTest(file=str(rel)):
                self.assertTrue(filecmp.cmp(ARCHIVE / rel, copy / rel, shallow=False), f'{rel} is stale: run build.py')
        self.assertEqual(sorted(p.relative_to(copy) for p in copy.rglob('*.md')), md)


if __name__ == '__main__':
    unittest.main()
