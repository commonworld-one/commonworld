"""stats.json `_about` says how the values are really updated (2026-10-27, #182): the Citizens rows come from Pulse through the
weekly refresh PR (never merged automatically), the other sections by hand. The Citizens section links Pulse, the live view."""
import json, os, unittest

STATS = os.path.join(os.path.dirname(__file__), '..', 'atlas', 'data', 'stats.json')


class StatsAboutTest(unittest.TestCase):
    def setUp(self):
        self.doc = json.load(open(STATS, encoding='utf-8'))

    def test_about_is_honest_about_how_values_are_updated(self):
        about = self.doc['_about']
        self.assertIn('stats_from_pulse.py', about)
        self.assertIn('never merged automatically', about)
        self.assertIn('by hand', about)
        self.assertNotIn('no automatic weekly job', about)

    def test_citizens_link_pulse_and_name_no_account(self):
        cit = next(s for s in self.doc['sections'] if s['id'] == 'citizens')
        self.assertEqual(cit['live']['url'], 'https://commonworld.one/pulse')
        self.assertEqual(cit['live']['json'], 'https://commonworld.one/v1/pulse')
        self.assertEqual(cit['live']['markdown'], 'https://commonworld.one/pulse.md')
        text = json.dumps(cit).lower()
        for name in ('nerd27dk', 'hark-agent', 'codex', 'continuum', 'muse-review', 'skitter', 'pico'):
            self.assertNotIn(name, text, f'Citizens section names the account {name}')


if __name__ == '__main__':
    unittest.main()
