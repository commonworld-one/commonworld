"""Structure of .github/workflows/refresh.yml (text only, no YAML library): the step that keeps refresh-state.json after a failure must run
after every publishing and cleanup step, otherwise failure() cannot see a failure of those steps (Codex P2 on PR 313)."""
import re
import unittest
from pathlib import Path

WF = (Path(__file__).resolve().parents[1] / '.github/workflows/refresh.yml').read_text(encoding='utf-8')


def steps():
    out = []
    for p in re.split(r'(?m)^(?=      - name: )', WF[WF.index('    steps:'):])[1:]:
        out.append((re.match(r'      - name: (.*)', p).group(1).strip(), p))
    return out


class Order(unittest.TestCase):
    def test_keep_state_step_is_last_and_keeps_its_condition(self):
        names = [n for n, _ in steps()]
        keep = [i for i, n in enumerate(names) if n.startswith('Keep state')]
        self.assertEqual(len(keep), 1)
        self.assertEqual(keep[0], len(names) - 1, names)
        body = steps()[keep[0]][1]
        self.assertIn("if: failure() && steps.refresh.outcome == 'success'", body)
        self.assertIn('name: atlas-refresh-state', body)
        self.assertIn('path: atlas/data/refresh-state.json', body)

    def test_it_comes_after_refresh_and_every_publishing_or_cleanup_step(self):
        names = [n for n, _ in steps()]
        keep = next(i for i, n in enumerate(names) if n.startswith('Keep state'))
        for must_precede in ('Refresh', 'Build', 'Check', 'Smoke (browser)', 'Open PR', 'Close superseded refresh PRs'):
            self.assertLess(names.index(must_precede), keep, must_precede)

    def test_refresh_step_has_the_id_the_condition_reads(self):
        refresh = next(b for n, b in steps() if n == 'Refresh')
        self.assertIn('id: refresh', refresh)


if __name__ == '__main__':
    unittest.main()
