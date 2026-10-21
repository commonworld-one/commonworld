#!/usr/bin/env python3
"""Ping IndexNow (Bing, Yandex, Seznam, Naver...) with sitemap URLs that are new or whose <lastmod> changed.

Usage: indexnow.py NEW_DIST [OLD_DIST] [--all] [--dry-run]
Compares sitemap.xml + atlas/sitemap.xml of two builds. Waits until the live site (the platform Worker, which serves
the Atlas build) serves the new sitemap before submitting. Key comes from atlas/site/site-config.json.
"""
import json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, '..', 'site', 'site-config.json')))
KEY = CFG['indexnow_key']
SITEMAPS = ('sitemap.xml', 'atlas/sitemap.xml')


def read(dist):
    out = {}
    for sm in SITEMAPS:
        p = os.path.join(dist, sm)
        if os.path.exists(p):
            for loc, lm in re.findall(r'<loc>([^<]+)</loc>(?:<lastmod>([^<]+)</lastmod>)?', open(p).read()):
                out[loc] = lm
    return out


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'commonworld-indexnow/1'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.read().decode()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    new = read(args[0])
    old = read(args[1]) if len(args) > 1 else {}
    urls = sorted(new) if '--all' in sys.argv else sorted(u for u, lm in new.items() if old.get(u) != lm)
    if not urls:
        print('IndexNow: nothing changed in sitemaps'); return
    host = re.match(r'https://([^/]+)', urls[0]).group(1)
    print(f'IndexNow: {len(urls)} URL(s) on {host}')
    for u in urls[:20]: print('  ', u)
    if '--dry-run' in sys.argv: return
    want = open(os.path.join(args[0], 'atlas', 'sitemap.xml')).read()
    for i in range(40):  # up to ~10 min for the deployed build to show up (edge caches)
        try:
            st, live = get(f'https://{host}/atlas/sitemap.xml?cb={time.time()}')
            kst, kbody = get(f'https://{host}/{KEY}.txt')
            if live.strip() == want.strip() and kbody.strip() == KEY: break
        except Exception as ex:
            print('  waiting for deploy:', ex)
        time.sleep(15)
    else:
        sys.exit('IndexNow: live site never matched the new build; not submitting')
    body = json.dumps({'host': host, 'key': KEY, 'keyLocation': f'https://{host}/{KEY}.txt', 'urlList': urls[:10000]}).encode()
    for attempt in range(6):  # a brand-new key is verified asynchronously: 403 SiteVerificationNotCompleted for a few minutes
        req = urllib.request.Request('https://api.indexnow.org/indexnow', data=body, method='POST',
                                     headers={'Content-Type': 'application/json; charset=utf-8'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print('IndexNow response:', r.status); return
        except urllib.error.HTTPError as ex:
            msg = ex.read()[:300]
            print('IndexNow response:', ex.code, msg)
            if ex.code == 403 and b'SiteVerificationNotCompleted' in msg and attempt < 5:
                time.sleep(90); continue
            if ex.code in (403, 429):
                print(f'::warning::IndexNow not accepted ({ex.code}); will be retried on the next deploy or manual run'); return
            sys.exit(1)

if __name__ == '__main__':
    main()
