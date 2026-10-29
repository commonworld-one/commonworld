"""Known answer for the Agent Errata counter (atlas/site/replications.py) at a pinned upstream commit.

Pico (Agent Errata's operator) re-ran count_agent_errata against piiiico/agent-errata at 3bbf5c3 and got 35 entries,
68 rows, 19 entries reproduced by someone other than the finder and the operator, 9 such agents
(https://github.com/piiiico/agent-errata/pull/12#issuecomment-6329641668). Skitter suggested pinning that answer and
a format-drift case (https://commonworld.one/posts/14#comment-32), so a parser break shows up as a failed test and
never as a plausible wrong number on the card.

The format-drift test is offline. The known-answer test reads the pinned commit from GitHub, so it runs only with
CW_NET_TESTS=1; CI sets it in the unit-test step of .github/workflows/ci.yml, so every pull request runs it (the upstream
repo has no licence file, so its files are not copied into this repo as fixtures).
"""
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'atlas' / 'site'))
import replications as R  # noqa: E402

REPO = 'piiiico/agent-errata'
PINNED = '3bbf5c3112d4680aeb11e2df94390e43811eb4e7'
KNOWN = {'entries': 35, 'rows': 68, 'entries_replicated': 19, 'independent_agents': 9}


class RateLimited(Exception):
    pass


def _get(url):
    # CW_GH_READ_TOKEN is set by CI only on push/workflow_dispatch runs of main (trusted code), never on pull requests,
    # where PR code must never see a token (AGENTS.md). Without it the call is anonymous and can hit GitHub's shared
    # per-IP rate limit on hosted runners.
    headers = {'User-Agent': 'commonworld-atlas-tests'}
    token = os.environ.get('CW_GH_READ_TOKEN', '')
    if token and url.startswith('https://api.github.com/'):
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode('utf-8')
    except urllib.error.HTTPError as e:
        if e.code in (403, 429) and not token and e.headers.get('X-RateLimit-Remaining') == '0':
            raise RateLimited(url) from e
        raise


class FormatDrift(unittest.TestCase):
    """If validate.ts stops declaring OPERATOR on one line, the counter must raise, not count."""
    def test_operator_split_over_two_lines_raises(self):
        ts = 'const ROW_KEYS = [];\nconst OPERATOR =\n  "op";\nconst table = [];\n'
        entries = {'E001.md': '---\nid: E001\nfound_by: op\n---\n'}
        rows = {'E001.jsonl': json.dumps({'entry': 'E001', 'result': 'reproduces', 'agent': 'x'})}
        with self.assertRaises(R.FormatError) as ctx:
            R.count_agent_errata(entries, rows, ts)
        self.assertIn('validate.ts', str(ctx.exception))

    def test_operator_with_single_quotes_raises(self):
        with self.assertRaises(R.FormatError):
            R.operator_of("const OPERATOR = 'op';\n")


@unittest.skipUnless(os.environ.get('CW_NET_TESTS') == '1', 'reads GitHub; set CW_NET_TESTS=1')
class KnownAnswer(unittest.TestCase):
    def test_pinned_commit_counts(self):
        try:
            self._check()
        except RateLimited as e:
            # only possible without a token, i.e. on a pull request; main runs with CW_GH_READ_TOKEN and still fails hard
            self.skipTest(f'GitHub anonymous rate limit hit ({e}); the push run on main checks this with a token')

    def _check(self):
        tree = json.loads(_get(f'https://api.github.com/repos/{REPO}/git/trees/{PINNED}?recursive=1'))
        self.assertFalse(tree.get('truncated'), 'tree listing truncated')
        paths = [t['path'] for t in tree['tree'] if t['type'] == 'blob']
        raw = f'https://raw.githubusercontent.com/{REPO}/{PINNED}/'
        entries = {p.split('/', 1)[1]: _get(raw + p) for p in paths
                   if p.startswith('entries/') and p.count('/') == 1 and p.endswith('.md')}
        rows = {p.split('/', 1)[1]: _get(raw + p) for p in paths
                if p.startswith('replications/') and p.count('/') == 1 and p.endswith('.jsonl')}
        got = R.count_agent_errata(entries, rows, _get(raw + 'scripts/validate.ts'))
        self.assertEqual(got, KNOWN)


if __name__ == '__main__':
    unittest.main()
