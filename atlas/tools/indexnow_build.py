#!/usr/bin/env python3
"""Build one deployed revision for sitemap comparison, in a disposable worktree.

This helper comes from the current workflow checkout, not an older target revision.
New catalogue revisions use their own accepted adapter, old revisions their legacy
builder. A partial/broken catalogue must fail, never silently fall back to legacy.
Catalogue mode retains required reviewed-image validation and its pinned fetch.
Offline checks supply --screens-dir. The helper never submits IndexNow pings.
"""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import sys


def plan(checkout, out, screens_dir=None):
    root, dest = Path(checkout).resolve(), Path(out).resolve()
    if dest == root or root in dest.parents:
        raise ValueError('output must be outside the compared checkout')
    cat = root / 'atlas/catalogue'
    adapter = root / 'atlas/tools/catalogue_build.py'
    env = dict(os.environ, CW_SCREENS='off', CW_SCREENS_REQUIRED='0')
    if cat.exists() or adapter.exists():
        if not adapter.is_file():
            raise ValueError('catalogue revision lacks accepted adapter')
        spec = importlib.util.spec_from_file_location('indexnow_target_catalogue', adapter)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cmd, target_env = module.plan('accepted', str(dest), screens_dir)
        env.update(target_env)
        # Catalogue receipts bind to reviewed captures. Do not bypass that
        # validation to make sitemap-only builds easier. Default is pinned fetch;
        # offline checks may name their exact preserved capture directory.
        env.pop('CW_SCREENS', None)
        if screens_dir:
            env['CW_SCREENS_DIR'] = str(Path(screens_dir).resolve())
        else:
            env.pop('CW_SCREENS_DIR', None)
        env['CW_SCREENS_REQUIRED'] = '1'
        cmd += ['--no-mirror']
        return cmd, env, 'catalogue'
    builder = root / 'atlas/site/build.py'
    if not builder.is_file():
        raise ValueError('legacy revision lacks site builder')
    cmd = [sys.executable, str(builder), '--out', str(dest)]
    # Historical builders predate --no-mirror. They run only in the workflow's
    # disposable worktree and may regenerate its mirror, never a remote ref.
    if '--no-mirror' in builder.read_text():
        cmd.append('--no-mirror')
    return cmd, env, 'legacy'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--screens-dir', help='offline exact capture package for a catalogue target')
    args = parser.parse_args()
    try:
        cmd, env, mode = plan(args.checkout, args.out, args.screens_dir)
        print('IndexNow sitemap build mode: ' + mode, flush=True)
        subprocess.run(cmd, cwd=args.checkout, env=env, check=True)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        parser.exit(1, 'IndexNow sitemap build failed: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
