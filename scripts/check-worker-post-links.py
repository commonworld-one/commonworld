#!/usr/bin/env python3
"""Check that every platform post link referenced from the Atlas build and the repo docs exists on the live Worker.

Why: lychee.toml treats /posts/ (and /v1/) as Worker routes, because the static Atlas build has no platform post pages
(PR #99). So lychee no longer checks them at all. This script fills that gap, read-only and without secrets:

  1. collect   every https://commonworld.one/posts/N and /v1/posts/N link (and, in HTML, relative href="/posts/N")
               from the built Atlas (atlas/site/dist: .html .md .json .txt .xml) and the repo's Markdown files
  2. check     each distinct post once against the live Worker: GET /v1/posts/N (public, no key) and HEAD /posts/N
               (the page route the links point at); a #comment-N fragment is looked up in the post's visible comments

Exit code: 1 only when the Worker answers 404 (or 410) for a referenced post. Network errors (including a response
cut off midway, http.client.IncompleteRead), timeouts, 429/5xx after retries, posts left unchecked when the time
budget (default 300 s) runs out or the Worker stops answering, withdrawn posts and missing
#comment-N anchors are printed as GitHub ::warning:: lines and do not fail.

  python scripts/check-worker-post-links.py                  # dist + docs, against https://commonworld.one
  python scripts/check-worker-post-links.py --list           # only print what was collected, no network
  python scripts/check-worker-post-links.py --base URL --dist PATH --delay 1.0
"""
import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / 'atlas' / 'site' / 'dist'
DEFAULT_BASE = 'https://commonworld.one'
USER_AGENT = 'Mozilla/5.0 (compatible; CommonworldPostLinkCheck/1.0; +https://github.com/commonworld-one/commonworld)'
DIST_SUFFIXES = {'.html', '.md', '.json', '.txt', '.xml'}
SKIP_DIRS = {'.git', 'node_modules', 'dist', '.wrangler', '.venv', 'venv', '__pycache__'}
MAX_FILE_BYTES = 8 * 1024 * 1024

# absolute links to our own host; the post number must end at a non-word, non-hyphen character
ABS_RE = re.compile(r'https?://(?:www\.)?commonworld\.one/(v1/)?posts/(\d+)(?![\w-])(?:\.md)?(#[\w-]+)?')
# relative links count only inside our own HTML (href/src attributes); in Markdown and JSON a bare /posts/... is
# usually another site's path quoted in the Atlas data, so it is not ours to check
REL_RE = re.compile(r'''(?:href|src)\s*=\s*["'](/(?:v1/)?posts/(\d+)(?![\w-])(?:\.md)?(#[\w-]+)?)["']''')
COMMENT_RE = re.compile(r'^#comment-(\d+)$')


def collect_text(text, source, allow_relative=False):
    """Return [(post_number, fragment or None, source)] for every Worker post link in text."""
    found = []
    for m in ABS_RE.finditer(text):
        found.append((int(m.group(2)), m.group(3), source))
    if allow_relative:
        for m in REL_RE.finditer(text):
            found.append((int(m.group(2)), m.group(3), source))
    return found


def _read(path):
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None


def collect_dist(dist):
    refs = []
    dist = Path(dist)
    if not dist.is_dir():
        return refs
    for p in sorted(dist.rglob('*')):
        if p.is_file() and p.suffix.lower() in DIST_SUFFIXES:
            text = _read(p)
            if text and 'posts/' in text:
                refs += collect_text(text, 'dist/' + p.relative_to(dist).as_posix(), allow_relative=p.suffix.lower() == '.html')
    return refs


def collect_docs(root):
    refs = []
    root = Path(root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name.lower().endswith('.md'):
                p = Path(dirpath) / name
                text = _read(p)
                if text and 'posts/' in text:
                    refs += collect_text(text, p.relative_to(root).as_posix())
    return refs


def group(refs):
    """{post_number: {'fragments': {fragment: [sources]}, 'sources': [sources]}}, sources deduplicated in order."""
    out = {}
    for n, frag, src in refs:
        g = out.setdefault(n, {'fragments': {}, 'sources': []})
        if src not in g['sources']:
            g['sources'].append(src)
        if frag:
            fs = g['fragments'].setdefault(frag, [])
            if src not in fs:
                fs.append(src)
    return dict(sorted(out.items()))


def request(url, method='GET', retries=3, timeout=20, backoff=4.0, deadline=None):
    """Return (status, body bytes or None, error text or None). Retries network errors, 429 and 5xx.

    deadline (time.monotonic() value): no new attempt or wait starts after it, so the whole run stays bounded.
    """
    last = (None, None, 'not attempted (time budget spent)')
    for attempt in range(retries + 1):
        if deadline is not None:
            left = deadline - time.monotonic()
            if left <= 1:
                break
            timeout = min(timeout, left)
        req = urllib.request.Request(url, method=method, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, (r.read(4 * 1024 * 1024) if method == 'GET' else None), None
        except urllib.error.HTTPError as e:
            if e.code not in (429,) and e.code < 500:
                return e.code, None, None
            last = (e.code, None, f'HTTP {e.code}')
            wait = backoff * (attempt + 1)
            ra = e.headers.get('Retry-After') if e.headers else None
            if ra and ra.isdigit():
                wait = max(wait, min(int(ra), 60))
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as e:
            # http.client.HTTPException covers a response cut off midway (IncompleteRead while reading the body),
            # a garbled status line (BadStatusLine) and a dropped connection (RemoteDisconnected, which is also a
            # ConnectionResetError, an OSError): transient, so retried and then reported as a warning, never broken
            last = (None, None, f'{type(e).__name__}: {getattr(e, "reason", e)}')
            wait = backoff * (attempt + 1)
        if attempt < retries:
            if deadline is not None and time.monotonic() + wait >= deadline:
                break
            time.sleep(wait)
    return last


def check(grouped, base, delay=1.0, retries=3, out=print, budget=300.0, max_unreachable=3, clock=time.monotonic):
    """Check each post; return (broken, warnings) as lists of strings.

    budget: seconds for the whole run (well inside the CI job timeout). When it is spent, or after max_unreachable
    posts in a row got no HTTP answer at all, the remaining posts are reported as one warning, never as broken.
    """
    broken, warnings = [], []
    base = base.rstrip('/')
    first = True
    deadline = clock() + budget
    unreachable = 0
    items = list(grouped.items())
    for i, (n, g) in enumerate(items):
        if clock() >= deadline or unreachable >= max_unreachable:
            rest = [str(m) for m, _ in items[i:]]
            why = 'time budget spent' if unreachable < max_unreachable else f'Worker unreachable for {unreachable} posts in a row'
            warnings.append(f'{len(rest)} posts not checked ({why}): {", ".join(rest)}')
            break
        where = ', '.join(g['sources'][:5]) + (f' (+{len(g["sources"]) - 5} more)' if len(g['sources']) > 5 else '')
        results = {}
        for kind, url, method in (('api', f'{base}/v1/posts/{n}', 'GET'), ('page', f'{base}/posts/{n}', 'HEAD')):
            if not first:
                time.sleep(delay)
            first = False
            results[kind] = (url,) + tuple(request(url, method, retries=retries, deadline=deadline))
        statuses = {k: v[1] for k, v in results.items()}
        unreachable = unreachable + 1 if all(s is None for s in statuses.values()) else 0
        line = f'post {n}: api {statuses["api"]}, page {statuses["page"]}  <- {where}'
        dead = [k for k, s in statuses.items() if s in (404, 410)]
        if dead:
            broken.append(line)
            out(f'::error::{line}')
            continue
        for k, (url, status, _body, err) in results.items():
            if status is None or status != 200:
                warnings.append(f'post {n}: {url} -> {err or status}')
        api_url, api_status, body, _ = results['api']
        data = None
        if api_status == 200 and body:
            try:
                data = json.loads(body)
            except ValueError:
                warnings.append(f'post {n}: {api_url} did not return JSON')
        if isinstance(data, dict):
            if data.get('withdrawn'):
                warnings.append(f'post {n}: withdrawn by its author (still resolves)')
            numbers = {c.get('number') for c in data.get('comments') or [] if isinstance(c, dict)}
            for frag, srcs in g['fragments'].items():
                m = COMMENT_RE.match(frag)
                if m and int(m.group(1)) not in numbers:
                    warnings.append(f'post {n}: {frag} is not among its visible comments <- {", ".join(srcs[:3])}')
        out(line)
    for w in warnings:
        out(f'::warning::{w}')
    return broken, warnings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--base', default=DEFAULT_BASE)
    ap.add_argument('--dist', default=str(DEFAULT_DIST))
    ap.add_argument('--root', default=str(ROOT), help='repo root for the Markdown docs')
    ap.add_argument('--no-docs', action='store_true')
    ap.add_argument('--delay', type=float, default=1.0, help='seconds between requests (polite rate)')
    ap.add_argument('--retries', type=int, default=3)
    ap.add_argument('--budget', type=float, default=300.0, help='seconds for the whole check; the rest becomes a warning')
    ap.add_argument('--list', action='store_true', help='print collected links and exit (no network)')
    ap.add_argument('--summary', help='append a Markdown summary to this file (e.g. $GITHUB_STEP_SUMMARY)')
    a = ap.parse_args(argv)

    refs = collect_dist(a.dist)
    if not Path(a.dist).is_dir():
        print(f'::warning::no build at {a.dist}; checking docs only')
    if not a.no_docs:
        refs += collect_docs(a.root)
    grouped = group(refs)
    print(f'{len(refs)} links to {len(grouped)} distinct posts')
    if a.list:
        for n, g in grouped.items():
            print(f'post {n}: {", ".join(g["sources"])}' + (f'  fragments {sorted(g["fragments"])}' if g['fragments'] else ''))
        return 0
    broken, warnings = check(grouped, a.base, delay=a.delay, retries=a.retries, budget=a.budget)
    if a.summary:
        with open(a.summary, 'a', encoding='utf-8') as f:
            f.write(f'## Worker post links\n\n{len(grouped)} posts referenced, {len(broken)} broken (404/410), {len(warnings)} warnings.\n\n')
            for x in broken:
                f.write(f'- BROKEN {x}\n')
            for x in warnings:
                f.write(f'- warning: {x}\n')
    print(f'{len(grouped)} posts checked: {len(broken)} broken, {len(warnings)} warnings')
    return 1 if broken else 0


if __name__ == '__main__':
    sys.exit(main())
