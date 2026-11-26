#!/usr/bin/env python3
"""Build the selected catalogue source. No network, git writes or deployment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
CAT = ROOT / 'atlas/catalogue'


def plan(mode, out=None, screens_dir=None):
    selection = json.loads((CAT / 'selection.json').read_text())
    doc = json.loads((CAT / 'overviews.json').read_text())
    slugs = selection.get('slugs')
    if not slugs or len(slugs) != len(set(slugs)) or set(slugs) != set(doc['cards']):
        raise ValueError('selection must match overview IDs exactly')
    if set(slugs) & set(selection.get('deferred_slugs', [])):
        raise ValueError('deferred entries cannot be accepted in this batch')
    if mode == 'accepted' and any(r.get('state') != 'reviewed' or not r.get('check') for r in doc['cards'].values()):
        raise ValueError('accepted catalogue blocked: real revision-bound review receipts are incomplete')
    cmd = [sys.executable, str(ROOT / 'atlas/site/build.py'), '--data', str(CAT / 'snapshot.json'),
           '--overviews', str(CAT / 'overviews.json'), '--overview-selection', str(CAT / 'selection.json')]
    if mode == 'preview':
        cmd += ['--draft-preview', '--no-mirror']
    if out:
        cmd += ['--out', str(out)]
    env = os.environ.copy()
    if screens_dir:
        screens = Path(screens_dir).resolve()
        manifest = screens / 'manifest.json'
        expected = json.loads((CAT / 'image-binding.json').read_text())
        actual = hashlib.sha256(manifest.read_bytes()).hexdigest()
        if actual != expected['manifest_sha256']:
            raise ValueError('capture manifest differs from the reviewed candidate')
        rows = json.loads(manifest.read_text())['screens']
        for slug in slugs:
            row = rows.get(slug) or {}
            image = screens / (slug + '.webp')
            if not image.is_file() or hashlib.sha256(image.read_bytes()).hexdigest() != row.get('sha256'):
                raise ValueError(slug + ': screenshot byte binding failed')
            ref = doc['cards'][slug].get('screenshot') or {}
            if any(ref.get(k) != row.get(k) for k in ('sha256', 'source_url', 'captured_at')):
                raise ValueError(slug + ': source/capture metadata binding failed')
        env['CW_SCREENS_DIR'] = str(screens)
    elif mode == 'preview':
        raise ValueError('preview requires --screens-dir with the exact candidate capture package')
    # Accepted builds may use the existing screens.lock fetch mechanism. The build
    # validates every receipt and screenshot against that pinned source, failing closed.
    return cmd, env


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode', choices=['preview', 'accepted'], default='accepted')
    p.add_argument('--screens-dir')
    p.add_argument('--out')
    a = p.parse_args()
    try:
        cmd, env = plan(a.mode, a.out, a.screens_dir)
        subprocess.run(cmd, cwd=ROOT, env=env, check=True)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        p.exit(1, 'Catalogue build: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
