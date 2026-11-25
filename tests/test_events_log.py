"""Atlas events log (atlas/data/events.jsonl -> /atlas/events.json + /atlas/events.md): schema, append-only order, and every
curated amendment from the log's start date has its events. check.py also verifies the built files in CI."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import events  # noqa: E402

SNAP = json.load(open(ROOT / 'atlas' / 'data' / 'snapshot-verified-2026-10-15.json', encoding='utf-8'))
SLUGS = {p['slug'] for p in SNAP['platforms']} | {r['slug'] for r in json.load(open(ROOT / 'atlas' / 'data' / 'removed.json'))['removed']}


SLUGS |= {p['slug'] for p in json.load(open(ROOT / 'atlas/catalogue/additions.json'))['platforms']}

class FakeSite:
    base = '/atlas'
    cfg = {'data_licence': 'CC BY 4.0'}

    @staticmethod
    def abs(p):
        return 'https://commonworld.one' + p


def ev(**kw):
    base = {'date': '2026-10-19', 'slug': 'dealwork-ai', 'type': 'corrected', 'reason': 'fee wording', 'source': 'https://dealwork.ai/terms'}
    base.update(kw)
    return {k: base[k] for k in events.FIELDS}


class EventsLog(unittest.TestCase):
    def test_repo_log_is_valid_and_complete(self):
        evs = events.load()
        self.assertTrue(evs)
        self.assertEqual(events.validate(evs, SLUGS), [])
        self.assertEqual(events.amendment_gaps(SNAP['amendments'], evs), [])

    def test_bad_lines_fail(self):
        self.assertTrue(events.validate([ev(type='deleted')], SLUGS))
        self.assertTrue(events.validate([ev(source='http://dealwork.ai')], SLUGS))
        self.assertTrue(events.validate([ev(slug='no-such-entry-xyz')], SLUGS))
        self.assertTrue(events.validate([ev(reason='')], SLUGS))
        self.assertTrue(events.validate([ev(date='2026-10-20'), ev(date='2026-10-19', reason='older')], SLUGS))
        self.assertTrue(events.validate([{'date': '2026-10-19', 'slug': 'dealwork-ai'}], SLUGS))
        self.assertTrue(events.validate([ev(), ev()], SLUGS))

    def test_amendment_without_event_is_a_gap(self):
        am = [{'date': '2026-10-19', 'tag': 't', 'added': ['touchstone'], 'entries': ['dealwork-ai'], 'died': ['agenty']}]
        gaps = events.amendment_gaps(am, [])
        self.assertEqual(len(gaps), 3)
        self.assertEqual(events.amendment_gaps(am, [ev(slug='touchstone', type='added'), ev(), ev(slug='agenty', type='closed')]), [])
        self.assertEqual(events.amendment_gaps([dict(am[0], date='2026-10-18')], []), [])  # before the log started

    def test_published_files(self):
        evs = events.load()
        doc = events.doc(FakeSite, evs, '2026-10-19T00:00:00Z')
        self.assertEqual(doc['count'], len(evs))
        self.assertEqual(doc['events'][0]['date'], max(e['date'] for e in evs))
        md = events.markdown(FakeSite, evs)
        for e in evs:
            self.assertIn(f"`{e['slug']}`", md)
            self.assertIn(e['source'], md)

    def test_append_writes_one_line(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / 'events.jsonl'
            events.append(str(f), '2026-10-19', 'dealwork-ai', 'closed', 'test', 'https://dealwork.ai/')
            self.assertEqual(events.load(str(f)), [ev(type='closed', reason='test', source='https://dealwork.ai/')])


if __name__ == '__main__':
    unittest.main()
