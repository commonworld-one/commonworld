"""atlas/tools/carry_failed_state.py with a fake `gh` (offline, read-only): which failed-run state is carried into the next refresh,
and that every failure of the carry path leaves the refresh starting from the state it would have had anyway."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from test_refresh_state_wording import run_refresh, st   # noqa: E402

SCRIPT = ROOT / 'atlas/tools/carry_failed_state.py'
FAKE_GH = '''#!/usr/bin/env python3
import json, os, shutil, sys
fx = json.load(open(os.environ["FAKE_GH"]))
a = sys.argv[1:]
if a[:2] == ["run", "list"]:
    if fx.get("list_error"): sys.stderr.write("boom"); sys.exit(1)
    print(json.dumps(fx["runs"]))
elif a[0] == "api":
    rid = a[1].split("/runs/")[1].split("/")[0]
    if rid in fx.get("api_error", []): sys.stderr.write("boom"); sys.exit(1)
    print(json.dumps({"artifacts": fx["artifacts"].get(rid, [])}))
elif a[:2] == ["run", "download"]:
    rid = a[2]; d = a[a.index("--dir") + 1]
    if rid in fx.get("download_error", []): sys.stderr.write("gone"); sys.exit(1)
    os.makedirs(d, exist_ok=True)
    body = fx["files"][rid]
    open(os.path.join(d, "refresh-state.json"), "w").write(body if isinstance(body, str) else json.dumps(body))
else:
    sys.exit(2)
'''


def art(branch='main', expired=False):
    return [{'name': 'atlas-refresh-state', 'expired': expired, 'workflow_run': {'head_branch': branch}}]


def run_of(i, branch='main', event='schedule', conclusion='failure'):
    return {'databaseId': i, 'headBranch': branch, 'event': event, 'conclusion': conclusion}


class Carry(unittest.TestCase):
    def pick(self, fx):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            gh = d / 'bin' / 'gh'
            gh.parent.mkdir()
            gh.write_text(FAKE_GH)
            gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
            (d / 'fx.json').write_text(json.dumps(fx))
            out = d / 'sub' / 'refresh-state.json'
            env = dict(os.environ, PATH=f'{gh.parent}:{os.environ["PATH"]}', FAKE_GH=str(d / 'fx.json'), GITHUB_REPOSITORY='o/r')
            p = subprocess.run([sys.executable, str(SCRIPT), '--out', str(out)], env=env, capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr)
            return (json.loads(out.read_text()) if out.exists() else None), p.stdout

    def test_newest_by_state_timestamp_not_by_run_order(self):
        # run 3 is the newest run but its state is older than run 2's (e.g. restarted from older state)
        fx = {'runs': [run_of(3), run_of(2), run_of(1)], 'artifacts': {'1': art(), '2': art(), '3': art()},
              'files': {'1': st(1, at='2026-11-01T00:00:00Z'), '2': st(2, at='2026-11-15T00:00:00Z'), '3': st(1, at='2026-11-08T00:00:00Z')}}
        got, _ = self.pick(fx)
        self.assertEqual(got['updated_at'], '2026-11-15T00:00:00Z')

    def test_run_that_failed_before_refresh_has_no_artifact_and_is_skipped(self):
        fx = {'runs': [run_of(3), run_of(2)], 'artifacts': {'3': [], '2': art()}, 'files': {'2': st(2, at='2026-11-15T00:00:00Z')}}
        got, _ = self.pick(fx)
        self.assertEqual(got['entries']['opentask']['failed_weeks'], 2)

    def test_expired_missing_or_unreadable_newest_falls_back_to_older_usable(self):
        fx = {'runs': [run_of(5), run_of(4), run_of(3), run_of(2)],
              'artifacts': {'5': art(expired=True), '4': art(), '3': art(), '2': art()},
              'download_error': ['4'], 'api_error': [],
              'files': {'3': 'not json {', '2': st(2, at='2026-11-08T00:00:00Z')}}
        got, out = self.pick(fx)
        self.assertEqual(got['updated_at'], '2026-11-08T00:00:00Z')
        self.assertIn('skipping run 4', out)
        self.assertIn('skipping run 3', out)

    def test_old_usable_state_beyond_five_runs_is_still_found(self):
        runs = [run_of(i) for i in range(40, 10, -1)]   # 30 runs of 100 scanned, newest first
        fx = {'runs': runs, 'artifacts': {'12': art()}, 'files': {'12': st(2, at='2026-10-01T00:00:00Z')}}
        got, _ = self.pick(fx)
        self.assertEqual(got['updated_at'], '2026-10-01T00:00:00Z')

    def test_provenance_branch_and_event(self):
        fx = {'runs': [run_of(3, branch='feature'), run_of(2, event='pull_request'), run_of(1)],
              'artifacts': {'3': art('feature'), '2': art(), '1': art('feature')},   # run 1 lists main but its artifact says another branch
              'files': {'3': st(9, at='2026-11-20T00:00:00Z'), '2': st(9, at='2026-11-19T00:00:00Z'), '1': st(9, at='2026-11-18T00:00:00Z')}}
        got, _ = self.pick(fx)
        self.assertIsNone(got)

    def test_conclusion_failure_or_timed_out_only(self):
        fx = {'runs': [run_of(4, conclusion='success'), run_of(3, conclusion='cancelled'), run_of(2, conclusion='timed_out'), run_of(1, conclusion='failure')],
              'artifacts': {'4': art(), '3': art(), '2': art(), '1': art()},
              'files': {'4': st(9, at='2026-11-20T00:00:00Z'), '3': st(9, at='2026-11-19T00:00:00Z'),
                        '2': st(2, at='2026-11-15T00:00:00Z'), '1': st(1, at='2026-11-08T00:00:00Z')}}
        got, _ = self.pick(fx)
        self.assertEqual(got['updated_at'], '2026-11-15T00:00:00Z')

    def test_partly_malformed_state_is_ignored_entirely(self):
        bad = st(2, at='2026-11-20T00:00:00Z')
        bad['entries']['broken'] = {'failed_weeks': 'x'}
        fx = {'runs': [run_of(2), run_of(1)], 'artifacts': {'2': art(), '1': art()}, 'files': {'2': bad, '1': st(1, at='2026-11-01T00:00:00Z')}}
        got, _ = self.pick(fx)
        self.assertEqual(got['updated_at'], '2026-11-01T00:00:00Z')
        self.assertNotIn('broken', got['entries'])

    def test_gh_failures_never_fail_the_step_and_write_nothing(self):
        for fx in ({'list_error': True}, {'runs': []}, {'runs': [run_of(1)], 'artifacts': {'1': art()}, 'download_error': ['1']},
                   {'runs': [run_of(1)], 'artifacts': {}, 'api_error': ['1']}):
            got, _ = self.pick(fx)
            self.assertIsNone(got)


class Chain(unittest.TestCase):
    """Consecutive runs through the real refresh.main: a state is counted once and a stale artifact never overrides newer state."""
    def write(self, d, name, obj):
        p = Path(d) / name
        p.write_text(json.dumps(obj), encoding='utf-8')
        return p

    def test_no_double_count_and_stale_artifact_loses(self):
        with tempfile.TemporaryDirectory() as d:
            # run A (Nov 15, failed after Refresh) kept 'opentask' at 1 failed week
            art_a = self.write(d, 'a.json', dict(st(1, at='2026-11-15T09:00:00Z'), entries={'opentask': {
                'failed_weeks': 1, 'first_failed_at': '2026-11-15T09:00:00Z', 'last_counted_at': '2026-11-15T09:00:00Z', 'last_error': 'x'}}))
            # run B (Nov 22, 7 days later) starts from A's artifact: 2nd counted week, closes, writes a newer state
            snap, state_b, _ = run_refresh({'version': 1, 'moved': {}, 'entries': {}}, [art_a], now='2026-11-22T09:00:00Z')
            self.assertEqual(snap['platforms'][0]['status'], 'closed')
            self.assertEqual(state_b['entries']['opentask']['failed_weeks'], 2)
            # run C, same week as B, with A's artifact still listed and B's state as main/PR state: B's state is newer, A is not used
            # again, and the same-week rerun adds nothing
            _, state_c, _ = run_refresh(state_b, [art_a], now='2026-11-22T12:00:00Z')
            self.assertEqual(state_c['entries']['opentask']['failed_weeks'], 2)
            # an artifact left by a failed run of the SAME week as the state it started from is not counted again either
            art_b2 = self.write(d, 'b2.json', state_b)
            snap_d, state_d, _ = run_refresh({'version': 1, 'moved': {}, 'entries': {}}, [art_b2], now='2026-11-22T15:00:00Z')
            # nothing new this week: no data change, so no state is written and nothing is counted a third time
            self.assertEqual(state_d, {'version': 1, 'moved': {}, 'entries': {}})
            self.assertEqual(snap_d['platforms'][0]['status'], 'live')   # the harness snapshot is not touched

if __name__ == '__main__':
    unittest.main()
