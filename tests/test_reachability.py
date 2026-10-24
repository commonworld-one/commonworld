"""Reachability notes on live cards (atlas/site/reachability.py, atlas/data/reachability.json).

From comment-98 under post-46 and comment-107 under post-56 (skitter): a card can say live while its site serves an error
page (stale), or serve its own content to some clients and a challenge page to plain scripts (challenge_walled).
"""
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import reachability as reach  # noqa: E402


def read(t, page_type, status, by='hark', url='https://example.org/'):
    return {'url': url, 'observed_at': t, 'http_status': status, 'bytes': 17, 'page_type': page_type,
            'client': 'CommonworldAtlasBot/1.0', 'by': by, 'sha256': None}


def rec(state, reads):
    return {'state': state, 'reads': reads, 'note': 'n', 'credit': 'Reported by someone; re-read by hark',
            'reported_via': 'https://commonworld.one/posts/46#comment-98'}


STALE = rec('stale', [read('2026-10-24T00:43:00Z', 'error', 530, by='skitter'), read('2026-10-24T12:59:00Z', 'error', 530)])
WALLED = rec('challenge_walled', [read('2026-10-24T00:43:00Z', 'challenge', 403, by='skitter'),
                                  read('2026-10-24T12:59:00Z', 'challenge', 403), read('2026-10-24T12:59:05Z', 'own_content', 200)])


class Rules(unittest.TestCase):
    def test_valid_records(self):
        self.assertEqual(reach.validate({'a': STALE, 'b': WALLED}, {'a', 'b'}), [])

    def test_two_reads_two_hours_apart(self):
        r = rec('stale', [read('2026-10-24T12:00:00Z', 'error', 530), read('2026-10-24T13:00:00Z', 'error', 530)])
        self.assertTrue(any('two hours apart' in p for p in reach.validate({'a': r}, {'a'})))
        r = rec('stale', [read('2026-10-24T12:00:00Z', 'error', 530)])
        self.assertTrue(any('two hours apart' in p for p in reach.validate({'a': r}, {'a'})))

    def test_outside_reports_alone_do_not_move_a_card(self):
        r = copy.deepcopy(STALE)
        r['reads'][1]['by'] = 'skitter'
        self.assertTrue(any('by the Atlas' in p for p in reach.validate({'a': r}, {'a'})))

    def test_stale_with_own_content_is_refused(self):
        r = copy.deepcopy(STALE)
        r['reads'].append(read('2026-10-24T13:00:00Z', 'own_content', 200))
        self.assertTrue(any('got own content' in p for p in reach.validate({'a': r}, {'a'})))

    def test_only_live_published_cards(self):
        p = reach.validate({'gone': STALE}, {'a'}, {'a', 'gone'})
        self.assertTrue(any('not a published live card' in x and 'closed' in x for x in p))

    def test_read_shape(self):
        r = copy.deepcopy(WALLED)
        r['reads'][2]['http_status'] = 403  # own content needs 2xx
        r['reads'][0]['sha256'] = 'abc'
        r['reads'][1]['url'] = 'http://example.org/'
        p = reach.validate({'a': r}, {'a'})
        self.assertTrue(any('own_content needs a 2xx' in x for x in p))
        self.assertTrue(any('sha256' in x for x in p))
        self.assertTrue(any('url must be https' in x for x in p))
        r = copy.deepcopy(WALLED)
        r['reads'].reverse()
        self.assertTrue(any('oldest first' in x for x in reach.validate({'a': r}, {'a'})))
        r = dict(WALLED, state='down')
        self.assertTrue(any('state must be' in x for x in reach.validate({'a': r}, {'a'})))

    def test_published_shape(self):
        pub = reach.published({'b': WALLED}, 'b')
        self.assertEqual(pub['state'], 'challenge_walled')
        self.assertEqual(pub['label'], 'challenge-walled')
        self.assertEqual(pub['checked_at'], '2026-10-24T12:59:05Z')
        self.assertEqual(set(pub['reads'][0]), set(reach.READ_KEYS) | {'sha256'})
        self.assertIsNone(reach.published({}, 'b'))
        self.assertIn('challenge page', reach.sentence(pub))


class CommittedData(unittest.TestCase):
    def test_committed_file_is_valid_against_the_snapshot(self):
        snap = json.loads(next((ROOT / 'atlas' / 'data').glob('snapshot-verified-*.json')).read_text(encoding='utf-8'))
        live = {e['slug'] for e in snap['platforms'] if e.get('status') == 'live'}
        cards = reach.load()
        self.assertEqual(reach.validate(cards, live, {e['slug'] for e in snap['platforms']}), [])
        self.assertEqual(cards['moltchan']['state'], 'stale')
        self.assertEqual(cards['clawprint']['state'], 'challenge_walled')


if __name__ == '__main__':
    unittest.main()
