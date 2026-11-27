"""The links-external job closes the "Outbound link report" issue after a clean sweep.

The step is read out of .github/workflows/quality.yml (no YAML library needed) and its shell body is run against a
fake `gh`, so the exact-title match and the "close nothing" cases are tested on the real workflow text.
"""
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/quality.yml').read_text()
STEP_NAME = 'Close the report after a clean sweep'


def step_text():
    start = WORKFLOW.index('      - name: ' + STEP_NAME)
    nxt = WORKFLOW.find('\n      - ', start + 10)
    nxt_job = WORKFLOW.find('\n  lighthouse:', start)
    ends = [e for e in (nxt, nxt_job) if e != -1]
    return WORKFLOW[start:min(ends)]


def step_condition():
    m = re.search(r'^        if: (.+)$', step_text(), re.M)
    return m.group(1)


def step_run_script():
    lines = step_text().split('\n')
    i = next(n for n, l in enumerate(lines) if l.startswith('        run: |'))
    body = [l[10:] if l.startswith('          ') else l for l in lines[i + 1:]]
    return '\n'.join(body) + '\n'


def condition_holds(exit_code, event):
    expr = step_condition()
    expr = expr.replace('steps.lychee.outputs.exit_code', repr(exit_code))
    expr = expr.replace('github.event_name', repr(event))
    expr = expr.replace('&&', ' and ').replace('||', ' or ')
    return bool(eval(expr, {'__builtins__': {}}))  # noqa: S307 - the expression comes from our own workflow file


FAKE_GH = r'''#!/bin/bash
# fake gh: "issue list" prints the issues in $FAKE_ISSUES through the jq filter given by the script; other calls are logged
if [ "$1 $2" = "issue list" ]; then
  printf '%s' "$FAKE_ISSUES" | jq -r "${@: -1}"
else
  echo "gh $*" >> "$FAKE_LOG"
fi
'''


class ReportAutocloseTests(unittest.TestCase):
    def run_step(self, issues_json):
        with tempfile.TemporaryDirectory() as tmp:
            gh = Path(tmp) / 'gh'
            gh.write_text(FAKE_GH)
            gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
            log = Path(tmp) / 'log'
            log.write_text('')
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ['PATH'], FAKE_ISSUES=issues_json,
                       FAKE_LOG=str(log), RUN_URL='https://example.test/run/1')
            subprocess.run(['bash', '-ec', step_run_script()], env=env, check=True)
            return log.read_text().splitlines()

    def test_runs_only_on_clean_scheduled_or_manual_sweeps(self):
        self.assertTrue(condition_holds('0', 'schedule'))
        self.assertTrue(condition_holds('0', 'workflow_dispatch'))
        self.assertFalse(condition_holds('0', 'push'))
        self.assertFalse(condition_holds('0', 'pull_request'))
        self.assertFalse(condition_holds('2', 'schedule'))
        self.assertFalse(condition_holds('', 'schedule'))

    def test_report_step_still_runs_only_when_errors_were_found(self):
        self.assertIn("if: steps.lychee.outputs.exit_code != '0'", WORKFLOW)

    def test_closes_only_the_exact_title(self):
        issues = ('[{"number":7,"title":"Outbound link report"},'
                  '{"number":9,"title":"Other: Outbound link report mention"},'
                  '{"number":11,"title":"outbound link report"}]')
        calls = self.run_step(issues)
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].startswith('gh issue comment 7 --body Closing:'))
        self.assertIn('https://example.test/run/1', calls[0])
        self.assertEqual(calls[1], 'gh issue close 7 --reason completed')

    def test_closes_nothing_when_no_report_is_open(self):
        self.assertEqual(self.run_step('[]'), [])
        self.assertEqual(self.run_step('[{"number":9,"title":"Other: Outbound link report mention"}]'), [])


if __name__ == '__main__':
    unittest.main()
