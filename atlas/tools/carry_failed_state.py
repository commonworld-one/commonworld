#!/usr/bin/env python3
"""Pick the newest usable refresh state kept by a failed run of this workflow (.github/workflows/refresh.yml).

A run that fails after the Refresh step opens no PR, so it uploads only atlas/data/refresh-state.json as the artifact
`atlas-refresh-state`. This script looks through the recent failed runs of the workflow on the default branch, downloads each
candidate artifact, keeps those that are valid refresh states and writes the one with the newest `updated_at` to --out.
Nothing here decides whether that state is used: atlas/refresh.py --state-from takes it only if it is newer than the other states.

Fail-safe: every problem (gh error, no run, expired or missing artifact, bad download, malformed state) skips that candidate;
if nothing usable is left --out is not written and the exit code is 0, so the refresh starts from the state it would have had anyway.
Needs the gh CLI and GH_TOKEN, GITHUB_REPOSITORY. Only reads."""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import refresh   # noqa: E402  (valid_state)

ARTIFACT = 'atlas-refresh-state'


def gh(*args):
    p = subprocess.run(['gh', *args], capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise RuntimeError(f'gh {args[0]} failed: {p.stderr.strip()[:200]}')
    return p.stdout


def candidates(repo, workflow, branch, limit):
    runs = json.loads(gh('run', 'list', '--workflow', workflow, '--branch', branch, '--limit', str(limit),
                         '--json', 'databaseId,headBranch,event,conclusion'))
    for r in runs:
        # Provenance: runs of this workflow on the default branch, started by the schedule or by hand.
        # gh --status takes one value, so filter the conclusion here: failure and timed_out both leave state behind (the upload step runs on failure()).
        if r.get('conclusion') in ('failure', 'timed_out') and r.get('headBranch') == branch and r.get('event') in ('schedule', 'workflow_dispatch') and isinstance(r.get('databaseId'), int):
            yield r['databaseId']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', required=True)
    ap.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY', ''))
    ap.add_argument('--workflow', default='refresh.yml')
    ap.add_argument('--branch', default='main')
    ap.add_argument('--limit', type=int, default=100)
    a = ap.parse_args()
    best, best_id = None, None
    tmp = tempfile.mkdtemp()
    try:
        try:
            ids = list(candidates(a.repo, a.workflow, a.branch, a.limit))
        except Exception as ex:   # noqa: BLE001
            print(f'no failed-run state: {ex}')
            return 0
        for rid in ids:
            try:
                arts = json.loads(gh('api', f'repos/{a.repo}/actions/runs/{rid}/artifacts'))['artifacts']
                ok = [x for x in arts if x.get('name') == ARTIFACT and x.get('expired') is False
                      and (x.get('workflow_run') or {}).get('head_branch') == a.branch]
                if not ok:
                    continue
                d = os.path.join(tmp, str(rid))
                gh('run', 'download', str(rid), '--name', ARTIFACT, '--dir', d)
                st = json.load(open(os.path.join(d, 'refresh-state.json'), encoding='utf-8'))
            except Exception as ex:   # noqa: BLE001
                print(f'skipping run {rid}: {type(ex).__name__}: {str(ex)[:120]}')
                continue
            if not refresh.valid_state(st) or not st.get('updated_at'):
                print(f'skipping run {rid}: not a valid refresh state')
                continue
            if best is None or st['updated_at'] > best['updated_at']:
                best, best_id = st, rid
        if best is None:
            print('no usable state kept by a failed run')
            return 0
        os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
        with open(a.out, 'w', encoding='utf-8') as f:
            json.dump(best, f, ensure_ascii=False, indent=1)
        print(f'using state of failed run {best_id} (updated_at {best["updated_at"]})')
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
