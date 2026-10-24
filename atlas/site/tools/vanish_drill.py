"""Staging drill for vanished list pages (PR #112, owner decision 2026-10-24 22:19 EEST): the full cycle N -> N-1 -> N pages
of one paged list on real Cloudflare Static Assets, checked over HTTP without following redirects.

Why a category list: the whole Atlas (374 cards, 8 pages) cannot shrink without removing cards, which check.py's growth
guard forbids. The social category has 102 cards = 3 pages; moving 2 of its cards to another category in a THROWAWAY
staging build makes it 100 cards = 2 pages, so /atlas/categories/social/page/3/ genuinely vanishes, then comes back when
the normal build is deployed again. Same code path as /atlas/page/8/ -> 7 -> 8.

  1. prepare  (in a throwaway checkout / branch, never merged):
       python3 atlas/site/tools/vanish_drill.py prepare
     moves the 2 last social cards (A to Z) to `work` in the snapshot and prints the expected URLs. Commit that on a
     throwaway branch only for the staging deploy.
  2. check    (after each staging deploy):
       python3 atlas/site/tools/vanish_drill.py check --base https://staging.commonworld.one --state full
       python3 atlas/site/tools/vanish_drill.py check --base https://staging.commonworld.one --state shrunk
     full   = page 3 of the list is a plain 200 (HTML, /page/3 slashless -> 308 (301 locally) to /page/3/, index.md, JSON), no Location;
     shrunk = page 3 answers 302 to page 2 with Cache-Control: no-store (HTML, slashless, index.md, JSON);
     always = /page/1/ answers 301 to the list; page 4 (never existed) is 404 in HTML, index.md and JSON;
              /atlas/page/8/ is 200 and /atlas/page/9/ is 404 (the whole Atlas did not change).
Sequence: deploy PR head -> check full; deploy the drill branch -> check shrunk; deploy PR head again -> check full.
Exit code 1 on any failure. Read-only: GET requests only.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, '..', '..', 'data', 'snapshot-verified-2026-10-15.json'))
LIST, CAT, TO_CAT, PAGE = '/atlas/categories/social/', 'social', 'work', 3


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(base, path):
    local = base.startswith(('http://127.0.0.1', 'http://localhost'))  # local serve.py: never through a proxy
    op = urllib.request.build_opener(*([urllib.request.ProxyHandler({})] if local else []), NoRedirect)
    req = urllib.request.Request(base.rstrip('/') + path, headers={'User-Agent': 'commonworld-vanish-drill/1', 'Cache-Control': 'no-cache'})
    try:
        with op.open(req, timeout=30) as r:
            return r.status, r.headers.get('location'), r.headers.get('cache-control')
    except urllib.error.HTTPError as ex:
        with ex:
            return ex.code, ex.headers.get('location'), ex.headers.get('cache-control')


def prepare():
    with open(DATA, encoding='utf-8') as fh:
        doc = json.load(fh)
    social = sorted((p for p in doc['platforms'] if p.get('category') == CAT), key=lambda p: (p.get('status') != 'live', p['name'].lower()))
    if len(social) not in (101, 102):
        sys.exit(f'drill expects 101-102 {CAT} cards (3 pages), found {len(social)}: adjust the count to move')
    move = social[100:]
    for p in move:
        p['category'] = TO_CAT
    with open(DATA, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f'moved {[p["slug"] if "slug" in p else p.get("id") for p in move]} from {CAT} to {TO_CAT}: {LIST} now has 2 pages')
    print(f'expect {LIST}page/{PAGE}/ -> 302 {LIST}page/2/ (Cache-Control: no-store), also index.md and JSON')


def check(base, state):
    fails = []
    api = f'/api/v1/atlas/categories/{CAT}/page/'

    def expect(path, ok, got):
        print(('PASS ' if ok else 'FAIL ') + f'{path} -> {got}')
        if not ok:
            fails.append(path)
    page = {f'{LIST}page/{PAGE}/': f'{LIST}page/2/', f'{LIST}page/{PAGE}/index.md': f'{LIST}page/2/index.md', f'{api}{PAGE}.json': f'{api}2.json'}
    for path, to in page.items():
        got = get(base, path)
        if state == 'full':
            expect(path, got[0] == 200 and got[1] is None, got)
        else:
            expect(path, got[0] == 302 and (got[1] or '').endswith(to) and got[2] == 'no-store', got)
    got = get(base, f'{LIST}page/{PAGE}')
    if state == 'full':
        expect(f'{LIST}page/{PAGE}', got[0] in (200, 301, 308) and (got[0] == 200 or (got[1] or '').endswith(f'{LIST}page/{PAGE}/')), got)
    else:
        expect(f'{LIST}page/{PAGE}', got[0] == 302 and (got[1] or '').endswith(f'{LIST}page/2/') and got[2] == 'no-store', got)
    got = get(base, f'{LIST}page/1/')
    expect(f'{LIST}page/1/', got[0] == 301 and (got[1] or '').endswith(LIST) and got[2] != 'no-store', got)
    for path in (f'{LIST}page/{PAGE + 1}/', f'{LIST}page/{PAGE + 1}/index.md', f'{api}{PAGE + 1}.json', '/atlas/page/9/', '/atlas/page/9/index.md', '/api/v1/atlas/page/9.json'):
        got = get(base, path)
        expect(path, got[0] == 404 and got[1] is None, got)
    for path in ('/atlas/page/8/', '/atlas/page/8/index.md', '/api/v1/atlas/page/8.json'):
        got = get(base, path)
        expect(path, got[0] == 200 and got[1] is None, got)
    print(f'{state}: {"OK" if not fails else f"{len(fails)} FAILED"}')
    return 1 if fails else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('prepare')
    c = sub.add_parser('check')
    c.add_argument('--base', required=True)
    c.add_argument('--state', choices=('full', 'shrunk'), required=True)
    a = ap.parse_args()
    if a.cmd == 'prepare':
        prepare()
    else:
        sys.exit(check(a.base, a.state))
