#!/usr/bin/env python3
"""Static checks for the built Atlas (stdlib only). Exit code 1 on any failure.

    python3 atlas/site/check.py

Checks: every internal link/asset resolves (incl. #fragments), trailing-slash consistency, every page has
lang=en, <title>, meta description, canonical (= its own clean URL), robots meta, JSON-LD that parses
(+ BreadcrumbList), unique titles/descriptions, external links carry rel nofollow+noopener (sponsored links
rel sponsored), sitemap lists exactly the indexable pages, robots.txt references the sitemap, 404 is noindex,
no page over 150 KB raw (catalog index: 360 KB, it server-renders every card) and none over 60 KB gzipped.
Open Graph: every indexable page has its own og:image (/atlas/og/<name>.png, exists, 1200x630 PNG, <= 100 KB),
width/height/alt, twitter:card=summary_large_image, twitter:image = og:image, twitter:site = @commonworldone.
Official channels: every page's footer shows X + GitHub (icon + label, rel="me noopener"); landing and llms.txt/llms-full.txt carry an
"Official channels" line; landing and /about/ Organization JSON-LD sameAs = [X, GitHub org]. Share bars: every platform page (and the
index) has one; every share link carries the page's canonical URL; the copy button copies the canonical URL.
Legal + navigation: the site-wide Commonworld legal pages (site.privacy_url /privacy/, site.terms_url /terms/) exist (WebPage JSON-LD,
Last updated, draft note only while legal_draft=true and never after, indexable, scope line, launch sections: account recovery, link checks,
"Not available yet", no pre-launch "no accounts" text; required privacy items incl. the link-check sources and the AI-bot log); no page loads a third-party
script, image or stylesheet (Google's gtag.js is injected by JS only after Accept); the old /atlas/privacy/ and /atlas/terms/ are noindex redirect stubs
(meta refresh + canonical to the new URL) and dist/_redirects carries their 301s; every page's footer links Privacy and Terms, the
cookie banner links site.privacy_url, the sidebar "Commonworld" item sits above
"Directions" and links site.product_url, and the top-right home icon links site.product_url. About page carries the approved wording.
Platform pages carry exactly one share bar, inside the header card.
Sitemaps: /sitemap.xml (site-level pages) + /atlas/sitemap.xml together list exactly the indexable pages; robots.txt names both.
Forbidden text: no file in dist (HTML, public JSON, JS, XML, TXT) contains any of the operator's private terms (personal names,
locations, local-timezone markers). The list is kept outside the repo: env CW_PRIVATE_TERMS (regex alternatives joined by |) or the
git-ignored file atlas/site/.private-terms (one regex per line); the approved public contact address contact.general is exempt. Site-authored landing, About, legal and Atlas-method copy contains no EU mention or operator-location wording; third-party Atlas catalog records retain their own names and source URLs.
Landing: / exists (dist/index.html), canonical origin + '/', indexable, H1/motto/coming-soon line, primary button to /atlas/, logo marks,
cookie banner, own og:image page-home.png, share bar, Atlas count; site.product_url/home_url point to it.
About Commonworld: /about/ exists (canonical origin + '/about/', indexable, H1 "About Commonworld", motto, AboutPage + Organization
JSON-LD named Commonworld with url and no address, own og:image page-cw-about.png, in the root /sitemap.xml, share bar, live Atlas count,
links to /atlas/, /atlas/about/, /privacy/, /terms/, the GitHub issues and privacy@; says the platform is live (no "coming soon"),
parts not built yet marked planned, no "sign up"
style wording); every page's sidebar has an "About" link to /about/ right under the Commonworld item (above Directions) and the footer
links "About Commonworld" + "How the Atlas works"; /atlas/about/ opens with a line linking /about/.
Growth guard: the sitemap URL set may only grow against atlas/data/sitemap-urls.txt (a removed URL fails unless atlas/data/redirects.json
maps it to a published page, emitted as a 301 in _redirects); every slug of the committed snapshot must still exist.
`--update-baseline` adds new URLs to the baseline (never removes any).
Screenshots (homepage previews from the orphan branch atlas-screens): every record with `preview` has its 1200x750 WebP
(<= 256 KB) and 600x250 top-band thumbnail (<= 25 KB) in dist, matching dist/atlas/screens/manifest.json (no drift, no orphans,
preview null <=> no image); every image of the fetched branch manifest that belongs to a published card is published (none dropped);
card pages carry exactly one figure.entry-shot right after the header and the sponsored slot, before the facts (alt, width,
height, lazy, dated caption; closed = "Last captured"; placeholder without an image); grid cards start with the band thumbnail
(alt="", 600x250, lazy, own slug) or the placeholder; _headers caches /atlas/screens/*. CW_SCREENS_REQUIRED=1 (CI) fails a build without previews.
Link safety: every slug in atlas/data/removed.json has a noindex stub page ("This entry was removed from the Atlas after a safety check.",
no outbound link, not in the sitemap; the growth guard accepts it in place of the old page), is absent from snapshot/platforms/earn/search
index, has no per-entry JSON, badge or screenshot, and no built file names its host. /atlas/safety.json (daily trust engine
report) is valid, in the Dataset distribution and /atlas/llms.txt; every exported record carries link_safety {status, checked_at}.
Decision log: /atlas/decisions/ (+ index.md twin, /atlas/decisions.json) lists every decision of removed.json, newest first,
hosts as defanged plain text, evidence links rel nofollow noopener. Markdown twins: every index.md is linked from its HTML page.
Public stats: /stats/ (+ /stats/index.md, /stats.json) from atlas/data/stats.json: every metric has source, period and as_of; value null
exactly when status is coming/none_yet; people, agents and search are separate sections; Atlas counts equal the snapshot; footer + sidebar + llms.txt link it.
Trust decisions (atlas/tools/trust_check.py): every removed entry has a remove decision and every decision names an actor from
atlas/data/trust-roles.json, a date, a reason and an https evidence link; a restored host must be clean in the latest safety report.
Refreshed numbers: the text of every claim the weekly refresh manages agrees with its number and quote (refresh_note_checks).
Also: native ad cards sit after every 12th card, the tag shelf exists with its expander, every card links to its page.
"""
import fnmatch, gzip, html, json, os, re, struct, sys, xml.etree.ElementTree as ET
from urllib.parse import quote, unquote
from html.parser import HTMLParser
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, 'dist')
CW_SUBTITLE = 'Where humans and agents meet, experiment, build, play, and create together.'  # fixed brand subtitle, verbatim (drift test)
ORIGIN = json.load(open(os.path.join(HERE, 'site-config.json')))['site']['origin'].rstrip('/')
X_HANDLE, X_URL = '@commonworldone', 'https://x.com/commonworldone'  # official X account: twitter:site on every page, footer, sameAs
REPO_URL, GITHUB_ORG_URL = 'https://github.com/commonworld-one/commonworld', 'https://github.com/commonworld-one'
OFFICIAL_URLS = {X_URL, REPO_URL}  # own accounts: linked with rel="me noopener" (no nofollow)
MAX = 150 * 1024          # raw HTML per page
PAGE_SIZE = 50            # cards per list page (D4); build.py and api_v1.py use the same value (api_v1.PAGE_SIZE, checked below)
MAX_GZ = 60 * 1024        # what actually goes over the wire, every page
MAX_OG = 100 * 1024       # per OG image (target < 80 KB)
SHARE_ON = json.load(open(os.path.join(HERE, 'site-config.json'))).get('share', {}).get('enabled', True)


class P(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title, self.in_title, self.meta, self.links, self.ids, self.ld, self._ld, self.canon, self.lang, self.anchors = '', False, {}, [], set(), [], None, None, None, []
        self.shares, self.share_bars, self._in_share = [], [], 0

    def handle_starttag(self, tag, a):
        a = dict(a)
        if 'id' in a:
            self.ids.add(a['id'])
        if tag == 'html':
            self.lang = a.get('lang')
        if 'cw-share' in (a.get('class') or '').split():
            self.share_bars.append((a.get('data-share-url'), a.get('data-share-text')))
        if a.get('data-share'):
            self.shares.append((a['data-share'], a.get('href'), a.get('aria-label')))
        if tag == 'title':
            self.in_title = True
        if tag == 'meta':
            k = a.get('name') or a.get('property')
            if k:
                self.meta[k] = a.get('content')
        if tag == 'link' and a.get('rel') == 'canonical':
            self.canon = a.get('href')
        for attr in ('href', 'src'):
            if attr in a and tag in ('a', 'link', 'script', 'img', 'form'):
                self.links.append((tag, a[attr], a.get('rel', '')))
        if tag == 'form' and a.get('action'):
            self.links.append(('form', a['action'], ''))
        if tag == 'script' and a.get('type') == 'application/ld+json':
            self._ld = ''

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False
        if tag == 'script' and self._ld is not None:
            self.ld.append(self._ld)
            self._ld = None

    def handle_data(self, d):
        if self.in_title:
            self.title += d
        if self._ld is not None:
            self._ld += d


def url_of(rel):
    rel = '/' + rel.replace(os.sep, '/')
    return rel[:-len('index.html')] if rel.endswith('/index.html') else rel


CFG0 = json.load(open(os.path.join(HERE, 'site-config.json')))
PRIV_URL = CFG0['site'].get('privacy_url') or '/privacy/'
TERMS_URL = CFG0['site'].get('terms_url') or '/terms/'
OLD_LEGAL = {'/atlas/privacy/': PRIV_URL, '/atlas/terms/': TERMS_URL}   # redirect stubs
def _private_terms():
    raw = os.environ.get('CW_PRIVATE_TERMS', '')
    fp = os.path.join(HERE, '.private-terms')
    if not raw and os.path.exists(fp):
        raw = '|'.join(l.strip() for l in open(fp, encoding='utf-8') if l.strip() and not l.startswith('#'))
    if not raw:
        print('warning: no private terms (CW_PRIVATE_TERMS / .private-terms); forbidden-text check skipped', file=sys.stderr)
        return re.compile(r'(?!x)x')
    return re.compile(raw, re.I)


FORBIDDEN_ANY = _private_terms()
FORBIDDEN_SITE_TEXT = re.compile(r'\w+ \(EU\)|\bbased in\b|\bEU-based\b|European Union', re.I)
FORBIDDEN_COMMONWORLD_COPY = re.compile(r'\bEU\b', re.I)


# --- growth guard: published URLs and slugs may only grow (pages are never deleted; moves need an explicit 301)
DATA_DIR = os.path.normpath(os.path.join(HERE, '..', 'data'))
BASELINE = os.path.join(DATA_DIR, 'sitemap-urls.txt')
REDIRECTS = os.path.join(DATA_DIR, 'redirects.json')


REMOVED = os.path.join(DATA_DIR, 'removed.json')
REMOVED_LINE = 'This entry was removed from the Atlas after a safety check.'
EVIDENCE_HOSTS = ('transparencyreport.google.com',)  # third-party checkers allowed as decision evidence links
DECISION_FILES = ('atlas/decisions/index.html', 'atlas/decisions/index.md', 'atlas/decisions.json')  # the public decision log


def load_removed():
    """atlas/data/removed.json (link-safety removals, atlas/CURATION.md#link-safety) -> list of {slug, host, ...}."""
    if not os.path.exists(REMOVED):
        return []
    return list(json.load(open(REMOVED)).get('removed') or [])


def removed_host_hit(txt, rel, rem, decisions):
    """The first mention of a removed host in one built file, or None. One precise exception: the decision log files
    (DECISION_FILES) may carry the exact evidence URL of a recorded decision when it points to a third-party checker
    (EVIDENCE_HOSTS, e.g. the Google transparency report), whose query names the domain it checked. Only those exact URLs,
    only in those files; every other mention of a removed host, in any file, still counts."""
    hs = [r['host'] for r in rem if r.get('host')]
    if not hs:
        return None
    host_re = re.compile(r'(?<![\w.-])(?:[\w-]+\.)*(?:' + '|'.join(re.escape(h) for h in hs) + r')(?![\w-])', re.I)
    if rel in DECISION_FILES:
        ev = {d['evidence'] for d in decisions if str(d.get('evidence') or '').startswith(tuple(f'https://{h}/' for h in EVIDENCE_HOSTS))}
        for u in sorted({v for u in ev for v in (u, html.escape(u, quote=True), json.dumps(u)[1:-1])}, key=len, reverse=True):
            txt = txt.replace(u, '')
    m = host_re.search(txt)
    return m.group(0) if m else None


def removed_checks(parsed, pages):
    """Link safety: every removed slug has a neutral noindex stub (no outbound link, not in the sitemap), is absent from
    every listing and data file, and no built file names its host (no link, no clickable URL)."""
    fails = []
    rem = load_removed()
    if not rem:
        return fails
    slugs = {r['slug'] for r in rem}
    for r in rem:
        u = f"/atlas/platforms/{r['slug']}/"
        if u not in parsed:
            fails.append(f'{u}: removed entry has no stub page (slugs are permanent)'); continue
        p, h = parsed[u], open(pages[u], encoding='utf-8').read()
        if 'noindex' not in (p.meta.get('robots') or ''): fails.append(f'{u}: removed-entry stub is not noindex')
        if REMOVED_LINE not in h: fails.append(f'{u}: stub lacks {REMOVED_LINE!r}')
        ext = [href for tag, href, rel in p.links if tag == 'a' and href.startswith(('http://', 'https://', '//')) and not href.startswith(ORIGIN)
               and href not in OFFICIAL_URLS and not href.startswith(REPO_URL)]
        if ext: fails.append(f'{u}: removed-entry stub has outbound links {ext[:3]}')
    for fn in ('atlas/data/snapshot.json', 'atlas/platforms.json', 'atlas/earn.json', 'atlas/data/search-index.json'):
        raw = open(os.path.join(DIST, fn), encoding='utf-8').read()
        hit = sorted(s_ for s_ in slugs if f'"{s_}"' in raw or f'/platforms/{s_}' in raw)
        if hit: fails.append(f'{fn}: still lists removed entries {hit}')
    for s_ in slugs:
        for f_ in (f'atlas/platforms/{s_}.json', f'api/v1/atlas/platforms/{s_}.json', f'atlas/badge/{s_}.svg', f'atlas/screens/{s_}.webp'):
            if os.path.exists(os.path.join(DIST, f_)): fails.append(f'{f_}: published for a removed entry')
    if any(r.get('host') for r in rem):
        decs = (json.load(open(REMOVED)).get('decisions') or []) if os.path.exists(REMOVED) else []
        for root, _, files in os.walk(DIST):
            for f in files:
                if f.endswith(('.html', '.json', '.xml', '.txt', '.js', '.md')) or f in ('_headers', '_redirects'):
                    fp = os.path.join(root, f)
                    rel = os.path.relpath(fp, DIST).replace(os.sep, '/')
                    m = removed_host_hit(open(fp, encoding='utf-8', errors='replace').read(), rel, rem, decs)
                    if m: fails.append(f'{rel}: names removed host {m!r}')
    print(f'link safety: {len(rem)} removed entr{"y" if len(rem) == 1 else "ies"} (stub pages, no outbound links, host absent from dist)')
    return fails


def safety_report_checks(parsed):
    """/atlas/safety.json exists (source = the trust engine with Google Safe Browsing among its sources, every host with a per-source
    answer {name, verdict, checked_at, evidence_url} that agrees with its status (any flag = flagged), an appeal line, run_at, summary counts that match its hosts, ISO UTC checked_at), is in the
    /atlas/ Dataset distribution and /atlas/llms.txt, and every record of platforms.json / snapshot.json carries link_safety {status, checked_at}."""
    fails = []
    fp = os.path.join(DIST, 'atlas', 'safety.json')
    if not os.path.isfile(fp):
        return ['missing /atlas/safety.json (link safety report)']
    d = json.load(open(fp, encoding='utf-8'))
    st = {'clean', 'flagged', 'no_data'}
    utc = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
    if d.get('source') != 'Commonworld trust engine': fails.append('safety.json: source is not the Commonworld trust engine')
    src_ids = [x.get('id') for x in d.get('sources') or []]
    if 'google_safe_browsing' not in src_ids: fails.append(f'safety.json: sources {src_ids} lack google_safe_browsing')
    if '7 days' not in str(d.get('appeal') or ''): fails.append('safety.json: appeal line (reply within 7 days) missing')
    if not utc.match(str(d.get('run_at') or '')): fails.append(f"safety.json: run_at {d.get('run_at')!r} is not ISO 8601 UTC")
    hosts, sm = d.get('hosts') or {}, d.get('summary') or {}
    for h, r in hosts.items():
        if r.get('status') not in st: fails.append(f'safety.json: {h} status {r.get("status")!r}')
        if r.get('checked_at') is not None and not utc.match(str(r['checked_at'])): fails.append(f'safety.json: {h} checked_at not ISO 8601 UTC')
        ss = r.get('sources') or []
        if src_ids and sorted(x.get('name') for x in ss) != sorted(src_ids): fails.append(f'safety.json: {h} lacks an answer from every source'); continue
        if any(x.get('verdict') not in st or not str(x.get('evidence_url') or '').startswith('https://') for x in ss):
            fails.append(f'safety.json: {h} has a source answer without verdict or https evidence_url')
        comb = 'flagged' if any(x.get('verdict') == 'flagged' for x in ss) else 'clean' if any(x.get('verdict') == 'clean' for x in ss) else 'no_data'
        if ss and comb != r.get('status'): fails.append(f"safety.json: {h} status {r.get('status')} != combined source answers {comb}")
    want = {'hosts': len(hosts)} | {k: sum(1 for r in hosts.values() if r.get('status') == k) for k in st}
    if any(sm.get(k) != v for k, v in want.items()): fails.append(f'safety.json: summary {sm} != {want}')
    for fn in ('atlas/platforms.json', 'atlas/data/snapshot.json'):
        for r in json.load(open(os.path.join(DIST, fn), encoding='utf-8'))['platforms']:
            ls = r.get('link_safety')
            if not isinstance(ls, dict) or ls.get('status') not in st or 'checked_at' not in ls:
                fails.append(f"{fn}: {r.get('id') or r.get('slug')} lacks link_safety {{status, checked_at}}"); break
    idx = next((x for x in (json.loads(b) for b in parsed['/atlas/'].ld) if x.get('@type') == 'Dataset'), {})
    if ORIGIN + '/atlas/safety.json' not in [x.get('contentUrl') for x in idx.get('distribution') or []]:
        fails.append('/atlas/: Dataset distribution lacks safety.json')
    if ORIGIN + '/atlas/safety.json' not in open(os.path.join(DIST, 'atlas', 'llms.txt'), encoding='utf-8').read():
        fails.append('/atlas/llms.txt does not link safety.json')
    if '<h2 id="link-safety">Link safety</h2>' not in open(os.path.join(DIST, 'atlas', 'about', 'index.html'), encoding='utf-8').read():
        fails.append('/atlas/about/ lacks the Link safety section')
    print(f"link safety report: {len(hosts)} hosts ({want['clean']} clean, {want['flagged']} flagged, {want['no_data']} no data), run_at {d.get('run_at')}")
    return fails


def load_redirects():
    """atlas/data/redirects.json: {"redirects": {"/old/path/": "/new/path/"}} -> dict (paths, emitted by build.py into _redirects as 301s)."""
    if not os.path.exists(REDIRECTS):
        return {}
    return {k: v for k, v in (json.load(open(REDIRECTS)).get('redirects') or {}).items()}


def _git_snapshot_slugs():
    """Slugs of every committed snapshot-verified-*.json at HEAD (and HEAD^1 on a merge commit, i.e. the PR base)."""
    import subprocess
    slugs, revs = set(), ['HEAD']
    try:
        par = subprocess.run(['git', 'rev-list', '--parents', '-n', '1', 'HEAD'], cwd=HERE, capture_output=True, text=True, check=True).stdout.split()
        if len(par) > 2:
            revs.append('HEAD^1')
        for rev in revs:
            names = subprocess.run(['git', 'ls-tree', '--name-only', rev, 'atlas/data/'], cwd=os.path.join(HERE, '..', '..'),
                                   capture_output=True, text=True, check=True).stdout.split()
            for n in names:
                if re.search(r'snapshot-verified-.*\.json$', n):
                    raw = subprocess.run(['git', 'show', f'{rev}:{n}'], cwd=os.path.join(HERE, '..', '..'), capture_output=True, text=True, check=True).stdout
                    slugs |= {c['slug'] for c in json.loads(raw).get('platforms', [])}
    except Exception as ex:  # not a git checkout: the sitemap baseline still guards every platform page
        print(f'note: previous-snapshot slug check skipped ({ex.__class__.__name__})', file=sys.stderr)
    return slugs


def growth_guard(locs, update=False):
    fails = []
    red = load_redirects()
    redfile = open(os.path.join(DIST, '_redirects')).read() if os.path.exists(os.path.join(DIST, '_redirects')) else ''
    for old, new in red.items():
        if f'{old} {new} 301' not in redfile: fails.append(f'_redirects lacks 301 {old} -> {new} from atlas/data/redirects.json')
        if ORIGIN + new not in locs: fails.append(f'redirect target {new} (for {old}) is not a published page')
    base = {l.strip() for l in open(BASELINE) if l.strip() and not l.startswith('#')} if os.path.exists(BASELINE) else set()
    if not base:
        fails.append(f'missing URL baseline {os.path.relpath(BASELINE, HERE)} (run check.py --update-baseline once)')
    stubs = {f"/atlas/platforms/{r['slug']}/" for r in load_removed()}  # link-safety removals keep a noindex stub instead
    stubs = {x for x in stubs if os.path.isfile(os.path.join(DIST, x.lstrip('/'), 'index.html'))}
    # a paged list URL that no longer exists because its list got shorter answers 302 (temporary: it may come back) to the
    # new last page (build.py paged_redirects, VANISHED_PAGE_STATUS)
    paged_moved = {l.split()[0] for l in redfile.splitlines() if len(l.split()) == 3 and l.split()[2] == str(VANISHED_PAGE_STATUS) and PAGED_HTML_RE.match(l.split()[0])}
    removed = sorted(u for u in base - locs if u[len(ORIGIN):] not in red and u[len(ORIGIN):] not in stubs and u[len(ORIGIN):] not in paged_moved)
    if removed:
        fails.append(f'{len(removed)} published URL(s) disappeared from the sitemap (pages are never removed; add a 301 in atlas/data/redirects.json if moved): {removed[:10]}')
    cur = {c['slug'] for c in json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']}
    gone = sorted(s for s in _git_snapshot_slugs() - cur if f'/atlas/platforms/{s}/' not in red and f'/atlas/platforms/{s}/' not in stubs)
    if gone:
        fails.append(f'slug(s) of the previous committed snapshot missing now: {gone[:10]}')
    added = len(locs - base)
    print(f'growth guard: baseline {len(base)} URLs, now {len(locs)} (+{added}, removed {len(removed)}), redirects {len(red)}')
    if update and not fails and added:
        with open(BASELINE, 'w') as f:
            f.write('# Published URL baseline for check.py: the sitemap may only grow (removals need atlas/data/redirects.json).\n')
            f.write(''.join(u + '\n' for u in sorted(base | locs)))
        print(f'baseline updated: {len(base | locs)} URLs')
    return fails


PAGED_RECORD = os.path.join(DATA_DIR, 'paged-lists.json')
VANISHED_PAGE_STATUS = 302  # same as build.py: a vanished list page may come back, so its redirect is temporary (owner decision 2026-10-24)
VANISHED_PAGE_CACHE = 'no-store'  # same as build.py: that 302 is never stored, so a page that comes back is not shadowed
HEADERS_MAX_RULES = 100  # Cloudflare Static Assets / Pages limit for _headers


TYPED_404_RE = re.compile(r'^(?:api/404\.html|atlas/(?:.+/)?page/404\.html)$')


def typed_404_checks():
    """Atlas paging findings (2026-10-25): a missing JSON page answers a JSON 404 body and a missing Markdown twin of a list page
    a Markdown 404, not the HTML 404 page. Static Assets serves the nearest 404.html, so: /api/404.html is the JSON error body
    (api_v1.not_found_doc), every paged list has <list>/page/404.html with api_v1.NOT_FOUND_MD, and _headers types them by the
    requested path (/api/*.json JSON; the list-page */index.md rules Markdown); no other 404.html below the root."""
    sys.path.insert(0, HERE)
    import api_v1
    fails = []
    fp = os.path.join(DIST, 'api', '404.html')
    try:
        doc = json.load(open(fp, encoding='utf-8'))
        if doc != api_v1.not_found_doc(ORIGIN): fails.append(f'/api/404.html is not api_v1.not_found_doc: {doc}')
    except (OSError, ValueError) as ex:
        fails.append(f'/api/404.html missing or not JSON: {ex}')
    ai = json.load(open(os.path.join(DIST, 'api', 'v1', 'atlas', 'index.json'), encoding='utf-8'))
    lists = ['/atlas/', '/atlas/platforms/'] + [f"/atlas/categories/{c['id']}/" for c in ai['categories']]
    want = {f'{first.lstrip("/")}page/404.html' for first in lists} | {'api/404.html'}
    for rel in sorted(want - {'api/404.html'}):
        p = os.path.join(DIST, rel)
        if not os.path.isfile(p) or open(p, encoding='utf-8').read() != api_v1.NOT_FOUND_MD: fails.append(f'/{rel}: Markdown 404 missing or not api_v1.NOT_FOUND_MD')
    found = {os.path.relpath(os.path.join(r, f), DIST).replace(os.sep, '/') for r, _, fs in os.walk(DIST) for f in fs if f == '404.html'} - {'404.html'}
    if found - want: fails.append(f'unexpected 404.html files (they would answer misses below them): {sorted(found - want)}')
    hdr = open(os.path.join(DIST, '_headers'), encoding='utf-8').read()
    for rule in ('/api/*.json\n  Content-Type: application/json; charset=utf-8\n', '/atlas/page/*/index.md\n  Access-Control-Allow-Origin: *\n  Content-Type: text/markdown; charset=utf-8\n',
                 '/atlas/platforms/*/index.md\n  Access-Control-Allow-Origin: *\n  Content-Type: text/markdown; charset=utf-8\n',
                 '/atlas/categories/*/index.md\n  Access-Control-Allow-Origin: *\n  Content-Type: text/markdown; charset=utf-8\n'):
        if rule not in hdr: fails.append(f'_headers lacks {rule.splitlines()[0]} with its content type (typed 404s)')
    print(f'typed 404s: /api/404.html (JSON) + {len(want) - 1} Markdown list-page 404s')
    return fails


def paged_record_checks(update=False):
    """Q8 (owner decision 2026-10-24): a page number that ever existed never 404s. atlas/data/paged-lists.json records the
    highest page ever built per list (whole Atlas, A-Z, each category); it must cover every list as built now (else run
    check.py --update-baseline, which raises it and never lowers it) and every paged URL of the sitemap baseline. Every page
    past a list's last page, up to that record, answers 302 (temporary, owner decision 2026-10-24 22:19 EEST: the page may
    come back) to the last page in _redirects for /page/N/, /page/N, /page/N/index.md and its JSON page; nothing above the
    record is redirected (it never existed: 404); no vanished page is a 301; and no page built now has a redirect rule (a page
    that came back is a normal 200 page; Cloudflare applies _redirects before files)."""
    sys.path.insert(0, HERE)
    import api_v1
    fails = []
    ai = json.load(open(os.path.join(DIST, 'api', 'v1', 'atlas', 'index.json'), encoding='utf-8'))
    now = {'/atlas/': (None, ai['counts']['pages']), '/atlas/platforms/': (api_v1.AZ_LIST, ai['counts']['pages'])}
    now |= {f"/atlas/categories/{c['id']}/": (c['id'], c['pages']) for c in ai['categories']}
    doc = json.load(open(PAGED_RECORD, encoding='utf-8')) if os.path.exists(PAGED_RECORD) else {'lists': {}}
    rec = {k: int(v) for k, v in (doc.get('lists') or {}).items()}
    low = {f: m for f, (_, m) in now.items() if rec.get(f, 0) < m}
    if low and update:
        rec |= low
        doc['lists'] = dict(sorted(rec.items()))
        with open(PAGED_RECORD, 'w', encoding='utf-8') as fh:
            fh.write(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
        print(f'paged-lists record raised: {low}')
    elif low:
        fails.append(f'atlas/data/paged-lists.json is below the pages built now {low} (run check.py --update-baseline)')
    base = {l.strip() for l in open(BASELINE) if l.strip() and not l.startswith('#')} if os.path.exists(BASELINE) else set()
    for u in base:
        m = PAGED_HTML_RE.match(u[len(ORIGIN):]) if u.startswith(ORIGIN) else None
        if m and rec.get(m.group(1), 0) < int(m.group(2)): fails.append(f'paged-lists.json: {m.group(1)} records {rec.get(m.group(1), 0)} pages but {u} was published')
    red = open(os.path.join(DIST, '_redirects')).read().splitlines() if os.path.exists(os.path.join(DIST, '_redirects')) else []
    lines = set(red)
    n_red = 0
    for first, top in rec.items():
        k, last = now.get(first, (first[len('/atlas/categories/'):].rstrip('/') if first.startswith('/atlas/categories/') else None, 0))
        to = html_list_path(first, last) if first in now else '/atlas/'
        to_json = '/api/v1' + (api_v1.page_json(last, k) if first in now else api_v1.page_json(1))
        for n in range(max(last, 1) + 1, top + 1):
            s = VANISHED_PAGE_STATUS
            for want in (f'{first}page/{n}/ {to} {s}', f'{first}page/{n} {to} {s}', f'{first}page/{n}/index.md {to}index.md {s}',
                         f'/api/v1{api_v1.page_json(n, k)} {to_json} {s}'):
                n_red += 1
                if want not in lines: fails.append(f'_redirects lacks {want} (page {n} of {first} existed before)')
                if want[:-3] + '301' in lines: fails.append(f'_redirects has a permanent 301 for a vanished page (must be {s}, it may come back): {want[:-4]}')
        for l in red:
            m = re.match(re.escape(first) + r'page/([0-9]+)[/ ]', l)
            if m and int(m.group(1)) > max(top, 1): fails.append(f'_redirects redirects a page that never existed: {l}')
    hdr = ''
    if os.path.exists(os.path.join(DIST, '_headers')):
        with open(os.path.join(DIST, '_headers'), encoding='utf-8') as fh:
            hdr = fh.read()
    rules = {}
    cur = None
    for l in hdr.splitlines():
        if l.strip() and not l.startswith((' ', '\t')) and not l.startswith('#'):
            cur = l.strip(); rules.setdefault(cur, [])
        elif cur and l.strip():
            rules[cur].append(l.strip())
    if len(rules) > HEADERS_MAX_RULES: fails.append(f'_headers has {len(rules)} rules (Cloudflare allows {HEADERS_MAX_RULES})')
    for l in red:  # the static 302s (Markdown twin, JSON page) must not be cached: a page that comes back must not be shadowed
        p = l.split()
        if len(p) == 3 and p[2] == str(VANISHED_PAGE_STATUS) and p[0].endswith(('/index.md', '.json')) and f'Cache-Control: {VANISHED_PAGE_CACHE}' not in rules.get(p[0], []):
            fails.append(f'_headers lacks "Cache-Control: {VANISHED_PAGE_CACHE}" for the temporary redirect {p[0]}')
    for l in red:  # a page that is built now (came back, or never left) must not be redirected
        p = l.split()
        if len(p) == 3 and (PAGED_HTML_RE.match(p[0].replace('index.md', '')) or (p[0].startswith('/api/v1/atlas/') and '/page/' in p[0])) and not re.search(r'/page/1/?$|/page/1\.json$', p[0]):
            src = p[0] if not p[0].startswith('/api/v1/') else p[0][len('/api/v1'):]
            fs = os.path.join(DIST, 'api', 'v1', src.lstrip('/')) if p[0].startswith('/api/v1/') else os.path.join(DIST, p[0].lstrip('/'))
            if os.path.isfile(fs) or os.path.isfile(os.path.join(fs, 'index.html')):
                fails.append(f'_redirects redirects a page that is built (it came back and must answer 200): {l}')
    print(f'paged record: {len(rec)} lists, {n_red} redirect lines for vanished pages')
    return fails


SVG_NS = '{http://www.w3.org/2000/svg}'


def badge_checks(parsed, pages, locs):
    """Status badges: both SVGs per card (valid XML, <title>, no script/links/external refs), the card page block,
    /atlas/badge/ page in sitemap + llms.txt, per-entry JSON badge URLs, _headers rule."""
    fails = []
    snap = json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']
    slugs = {c['slug'] for c in snap}
    bdir = os.path.join(DIST, 'atlas', 'badge')
    clash = sorted(s for s in slugs if s + '-dark' in slugs)
    if clash: fails.append(f'badge file name clash (<slug>-dark is another slug): {clash}')
    n_ok = 0
    for c in snap:
        slug = c['slug']
        for fn in (f'{slug}.svg', f'{slug}-dark.svg'):
            fp = os.path.join(bdir, fn)
            if not os.path.isfile(fp):
                fails.append(f'missing badge /atlas/badge/{fn}'); continue
            raw = open(fp, encoding='utf-8').read()
            try:
                root = ET.fromstring(raw)
            except ET.ParseError as ex:
                fails.append(f'badge {fn}: invalid XML ({ex})'); continue
            if root.tag != SVG_NS + 'svg': fails.append(f'badge {fn}: root is {root.tag}')
            t = root.find(SVG_NS + 'title')
            if t is None or not (t.text or '').startswith('Commonworld Atlas: '): fails.append(f'badge {fn}: no <title>')
            if root.get('role') != 'img' or not root.get('aria-label'): fails.append(f'badge {fn}: no role=img/aria-label')
            want = {'closed': 'Closed · history'}.get(c.get('status'))
            if want and t is not None and not (t.text or '').endswith(want): fails.append(f'badge {fn}: closed card shows {t.text!r}')
            if c.get('status') == 'live' and t is not None and not re.search(r': (Verified · \d{4}-\d{2}-\d{2}|Listed)$', t.text or ''):
                fails.append(f'badge {fn}: live card shows {t.text!r}')
            bad = [el.tag for el in root.iter() if el.tag.split('}')[-1] in ('script', 'foreignObject', 'image', 'use', 'a', 'style', 'iframe')]
            if bad: fails.append(f'badge {fn}: forbidden elements {bad}')
            for el in root.iter():
                for k, v in el.attrib.items():
                    if k.split('}')[-1] == 'href' or k.lower().startswith('on') or re.search(r'url\((?!#)|https?:|//|javascript:', v):
                        fails.append(f'badge {fn}: external/active attribute {k}={v[:60]!r}')
            if re.search(r'<script|@import|https?://(?!www\.w3\.org/2000/svg")', raw, re.I): fails.append(f'badge {fn}: script or external reference')
            if len(raw) > 4096: fails.append(f'badge {fn}: {len(raw)} bytes > 4 KB')
            n_ok += 1
        u = f'/atlas/platforms/{slug}/'
        if u in pages:
            h = open(pages[u], encoding='utf-8').read()
            for need in ('id="badge"', '>Add this badge to your site<', 'Free. Never sold. Updates itself with every weekly check.',
                         f'src="/atlas/badge/{slug}.svg"', f'src="/atlas/badge/{slug}-dark.svg"',
                         f'&lt;a href=&quot;{ORIGIN}/atlas/platforms/{slug}/&quot;&gt;&lt;img src=&quot;{ORIGIN}/atlas/badge/{slug}.svg&quot; alt=&quot;Commonworld Atlas: ',
                         f']({ORIGIN}/atlas/badge/{slug}.svg)]({ORIGIN}/atlas/platforms/{slug}/)', 'href="/atlas/badge/"'):
                if need not in h: fails.append(f'{u}: badge block lacks {need[:70]!r}')
        else:
            fails.append(f'card page missing for badge {slug}')
        jp = os.path.join(DIST, 'atlas', 'platforms', f'{slug}.json')
        if os.path.isfile(jp):
            j = json.load(open(jp, encoding='utf-8'))
            if j.get('badge_svg') != f'{ORIGIN}/atlas/badge/{slug}.svg' or j.get('badge_svg_dark') != f'{ORIGIN}/atlas/badge/{slug}-dark.svg' \
                    or j.get('badge_page') != f'{ORIGIN}/atlas/badge/':
                fails.append(f'{slug}.json: badge_svg/badge_svg_dark/badge_page wrong or missing')
    extra = sorted(f for f in os.listdir(bdir) if f.endswith('.svg') and f[:-4].removesuffix('-dark') not in slugs) if os.path.isdir(bdir) else []
    if extra: fails.append(f'badge files without a card: {extra[:5]}')
    if '/atlas/badge/' not in parsed: fails.append('missing /atlas/badge/ page')
    else:
        bh = open(pages['/atlas/badge/'], encoding='utf-8').read()
        for need in ('<h1>Commonworld Atlas badges</h1>', 'No tracking', 'Verified · date',
                     '>Listed<', 'Closed · history', '-dark.svg', 'href="/atlas/about/#corrections"', 'the-spawn'):
            if need not in bh: fails.append(f'/atlas/badge/: lacks {need!r}')
    if ORIGIN + '/atlas/badge/' not in locs: fails.append('/atlas/badge/ not in sitemap')
    for f_ in ('llms.txt', 'llms-full.txt'):
        if ORIGIN + '/atlas/badge/' not in open(os.path.join(DIST, f_), encoding='utf-8').read(): fails.append(f'/{f_}: no /atlas/badge/ link')
    if 'href="/atlas/badge/"' not in open(pages['/atlas/about/'], encoding='utf-8').read(): fails.append('/atlas/about/ does not link /atlas/badge/')
    hd = open(os.path.join(DIST, '_headers')).read()
    if '/atlas/badge/*.svg\n  Cache-Control: public, max-age=3600\n  Access-Control-Allow-Origin: *\n  Content-Type: image/svg+xml' not in hd:
        fails.append('_headers lacks the /atlas/badge/*.svg rule')
    print(f'badges: {n_ok} SVG files checked for {len(snap)} cards')
    return fails


REFRESH_TOOL = 'atlas/refresh.py'


PAGED_JSON_RE = re.compile(r'^/atlas/(?:categories/([a-z0-9-]+)/)?page/([1-9][0-9]*)\.json$')  # under /api/v1 (open question Q6: location)
PAGED_HTML_RE = re.compile(r'^(/atlas/(?:categories/[a-z0-9-]+/|platforms/)?)page/([1-9][0-9]*)/$')
AZ_JSON_RE = re.compile(r'^/atlas/platforms/page/([1-9][0-9]*)\.json$')  # the A-Z list /atlas/platforms/ (under /api/v1)
AZ_LETTERS = ['#'] + [chr(c) for c in range(ord('A'), ord('Z') + 1)]


def az_letter(name):
    import unicodedata
    ch = unicodedata.normalize('NFKD', (name or ' ').strip()[:1] or ' ')[:1].upper()
    return ch if 'A' <= ch <= 'Z' else '#'


def is_card_url(u):
    """/atlas/platforms/<slug>/ (a card page), not the A-Z list /atlas/platforms/ or its pages /atlas/platforms/page/N/."""
    return bool(re.fullmatch(r'/atlas/platforms/[a-z0-9][a-z0-9-]*/', u)) and u != '/atlas/platforms/page/'


def html_list_path(first, n):
    return first if n == 1 else f'{first}page/{n}/'


def paged_json_checks(docs, legacy_list, cats):
    """JSON list pages (D3): for the whole list and each category, pages 1..M exist with no gap and nothing after M;
    each has at most PAGE_SIZE records equal to the records of platforms.json, correct page/pages/total/count/has_more/
    next/prev/first, its HTML url and Markdown twin; walking every page covers every id exactly once; one snapshot_id
    for the whole build (also in atlas/index.json paging and in search-index.json)."""
    sys.path.insert(0, HERE)
    import api_v1
    fails, A = [], ORIGIN + '/api/v1'
    rec = {r['id']: r for r in legacy_list['platforms']}
    order_all = [r['id'] for r in legacy_list['platforms']]
    ai = docs.get('/atlas/index.json') or {}
    snaps = set()
    for k in [None] + cats:
        got = sorted(((int(m.group(2)), p) for p, m in ((p, PAGED_JSON_RE.match(p)) for p in docs) if m and m.group(1) == k), key=lambda x: x[0])
        where = 'all' if k is None else k
        if not got: fails.append(f'paged json {where}: no pages'); continue
        nums = [n for n, _ in got]
        if nums != list(range(1, len(nums) + 1)): fails.append(f'paged json {where}: page numbers {nums[:12]} not 1..{len(nums)}')
        m = len(nums)
        want_ids = order_all if k is None else [r['id'] for r in legacy_list['platforms'] if r['category'] == k]
        want_m = max(1, -(-len(want_ids) // PAGE_SIZE))
        if m != want_m: fails.append(f'paged json {where}: {m} pages, expected {want_m} for {len(want_ids)} entries')
        want_pages = (ai.get('counts') or {}).get('pages') if k is None else next((c.get('pages') for c in ai.get('categories', []) if c['id'] == k), None)
        if want_pages != m: fails.append(f'paged json {where}: atlas/index.json says {want_pages} pages, files {m}')
        walked = []
        first_html = '/atlas/' if k is None else f'/atlas/categories/{k}/'
        for n, p in got:
            d = docs[p]
            items = d.get('platforms') or []
            walked += [r.get('id') for r in items]
            snaps.add(d.get('snapshot_id'))
            exp = {'page': n, 'per_page': PAGE_SIZE, 'pages': m, 'total': len(want_ids), 'count': len(items), 'has_more': n < m,
                   'next': A + api_v1.page_json(n + 1, k) if n < m else None, 'prev': A + api_v1.page_json(n - 1, k) if n > 1 else None,
                   'first': A + api_v1.page_json(1, k), 'url': ORIGIN + html_list_path(first_html, n), 'md_url': ORIGIN + html_list_path(first_html, n) + 'index.md'}
            if k is not None: exp |= {'category': k}
            bad = {f: (d.get(f), v) for f, v in exp.items() if d.get(f) != v}
            if bad: fails.append(f'paged json {p}: {bad}')
            if not 0 < len(items) <= PAGE_SIZE: fails.append(f'paged json {p}: {len(items)} records (allowed 1..{PAGE_SIZE})')
            if not os.path.isfile(os.path.join(DIST, html_list_path(first_html, n).lstrip('/'), 'index.md')): fails.append(f'paged json {p}: md_url missing in dist')
            for r in items:
                if rec.get(r.get('id')) != r: fails.append(f'paged json {p}: record {r.get("id")} differs from platforms.json'); break
        if k is None and walked != order_all: fails.append('paged json all: walking pages 1..M does not give platforms.json in order')
        if sorted(walked) != sorted(want_ids) or len(set(walked)) != len(walked):
            fails.append(f'paged json {where}: walk does not cover every id exactly once ({len(walked)} walked, {len(want_ids)} expected)')
        if A[len(ORIGIN):] + api_v1.page_json(m + 1, k) in docs: fails.append(f'paged json {where}: page {m + 1} exists past the last page')
    si = json.load(open(os.path.join(DIST, 'atlas', 'data', 'search-index.json'), encoding='utf-8'))  # the index or its manifest
    snaps |= {(ai.get('paging') or {}).get('snapshot_id'), si.get('snapshot_id')}
    if len(snaps) != 1 or not re.fullmatch(r'[0-9a-f]{16}', str(next(iter(snaps)))):
        fails.append(f'paged json: snapshot_id differs between pages / atlas/index.json / search-index.json: {sorted(map(str, snaps))[:4]}')
    if (ai.get('paging') or {}).get('page_size') != PAGE_SIZE: fails.append('atlas/index.json: paging.page_size != PAGE_SIZE')
    print(f"paged json: {sum(1 for p in docs if PAGED_JSON_RE.match(p))} list pages (whole list + {len(cats)} categories), {PAGE_SIZE} per page, snapshot_id {next(iter(snaps))}")
    return fails


SEARCH_GZ_BUDGET = 60 * 1024  # owner decision 2026-10-24: every search-index file under 60 KB gzipped (build.py shards past it)


def load_search_index():
    """The catalog search index as one document (rows joined from the shards when it is sharded), plus budget failures:
    every file of it (the index or manifest and each shard) at most SEARCH_GZ_BUDGET gzipped; shards in order, one
    snapshot_id, counts right."""
    fails = []
    p = os.path.join(DIST, 'atlas', 'data', 'search-index.json')
    files = [p]
    si = json.load(open(p, encoding='utf-8'))
    if si.get('shards'):
        rows = []
        for sh in si['shards']:
            fp = os.path.join(DIST, sh['path'].lstrip('/'))
            files.append(fp)
            if not os.path.isfile(fp): fails.append(f'search index shard {sh["path"]} missing'); continue
            d = json.load(open(fp, encoding='utf-8'))
            if d.get('snapshot_id') != si.get('snapshot_id') or d.get('count') != len(d.get('cards') or []) or sh.get('count') != d.get('count'):
                fails.append(f'search index shard {sh["path"]}: snapshot_id or count wrong')
            rows += d.get('cards') or []
        si = si | {'cards': rows}
    for fp in files:
        gz = len(gzip.compress(open(fp, 'rb').read(), 6))
        if gz > SEARCH_GZ_BUDGET: fails.append(f'{os.path.relpath(fp, DIST)}: {gz} bytes gzipped > {SEARCH_GZ_BUDGET // 1024} KB search-index budget')
    print(f"search index: {len(si.get('cards', []))} rows in {len(files)} file(s), largest {max(len(gzip.compress(open(f, 'rb').read(), 6)) for f in files if os.path.isfile(f))} bytes gzipped (budget {SEARCH_GZ_BUDGET})")
    return si, fails


def paged_list_checks(parsed, pages, locs):
    """HTML list pages (D1, D3, D4): /atlas/ and every category page 1, then /page/N/ up to the last page and nothing
    after it; each page shows at most PAGE_SIZE cards, exactly its slice of the list in order (so every card is
    reachable by plain links); head <link rel=prev/next> and the pager's <a rel=prev/next> point to the neighbours;
    titles of pages 2.. say "page N of M"; each page is in the sitemap, self-canonical (main loop), under the size caps,
    links its Markdown twin and its JSON page; /page/1/ is never built and answers 301 to the list; filters stay
    out of the sitemap; the catalog search index covers the whole Atlas."""
    fails, n_pages = [], 0
    snap = json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']
    by_name = sorted(snap, key=lambda c: c['name'].lower())
    lists = {'/atlas/': [c['slug'] for c in by_name]}
    for c in sorted(snap, key=lambda c: (c['status'] != 'live', c['name'].lower())):
        lists.setdefault(f"/atlas/categories/{c['category']}/", []).append(c['slug'])
    red = open(os.path.join(DIST, '_redirects')).read() if os.path.exists(os.path.join(DIST, '_redirects')) else ''
    card_re = re.compile(r'<article class="cw-card(?: is-closed)?"[^>]*data-slug="([a-z0-9-]+)"')
    plain_card_re = re.compile(r'<article class="cw-card(?: is-closed)?"[^>]*>.*?<h3><a href="/atlas/platforms/([a-z0-9-]+)/">', re.S)
    reached = set()
    for first, slugs in lists.items():
        m = max(1, -(-len(slugs) // PAGE_SIZE))
        if f'{first}page/1/ {first} 301' not in red: fails.append(f'_redirects lacks {first}page/1/ -> {first} 301')
        if f'{first}page/1/index.md {first}index.md 301' not in red: fails.append(f'_redirects lacks {first}page/1/index.md -> {first}index.md 301')
        if os.path.exists(os.path.join(DIST, first.lstrip('/'), 'page', '1')): fails.append(f'{first}page/1/ is built (page 1 is {first})')
        if os.path.exists(os.path.join(DIST, first.lstrip('/'), 'page', str(m + 1))): fails.append(f'{first}page/{m + 1}/ is built past the last page')
        for n in range(1, m + 1):
            u = html_list_path(first, n)
            if u not in pages: fails.append(f'{u}: list page missing'); continue
            n_pages += 1
            h = open(pages[u], encoding='utf-8').read()
            grid = h[h.find('<main'):h.find('</main>')]
            shown = card_re.findall(grid) if first == '/atlas/' and n == 1 else plain_card_re.findall(grid)
            want = slugs[(n - 1) * PAGE_SIZE:n * PAGE_SIZE]
            if len(shown) > PAGE_SIZE: fails.append(f'{u}: {len(shown)} cards > {PAGE_SIZE}')
            if shown != want: fails.append(f'{u}: cards {shown[:3]}… are not slice {n} of the list ({want[:3]}…)')
            reached |= set(shown)
            pp = parsed.get(u)
            if not pp: continue
            heads = {r: hr for t, hr, r in pp.links if t == 'link' and r in ('prev', 'next')}
            anchors = {r: hr for t, hr, r in pp.links if t == 'a' and r in ('prev', 'next')}
            want_rel = {**({'prev': html_list_path(first, n - 1)} if n > 1 else {}), **({'next': html_list_path(first, n + 1)} if n < m else {})}
            if heads != want_rel: fails.append(f'{u}: <link rel=prev/next> {heads} != {want_rel}')
            if anchors != want_rel: fails.append(f'{u}: pager <a rel=prev/next> {anchors} != {want_rel}')
            if m > 1 and f'Page {n} of {m}' not in h: fails.append(f'{u}: pager lacks "Page {n} of {m}"')
            if n > 1 and f'page {n} of {m}' not in pp.title: fails.append(f'{u}: title lacks "page {n} of {m}": {pp.title!r}')
            if n > 1 and f'page {n} of {m}' not in (pp.meta.get('description') or '').lower(): fails.append(f'{u}: description lacks "page {n} of {m}"')
            if ORIGIN + u not in locs: fails.append(f'{u}: not in the sitemap')
            if 'noindex' in (pp.meta.get('robots') or ''): fails.append(f'{u}: list page is noindex (D1: paged pages are indexable)')
            alts = [(hr, r) for t, hr, r in pp.links if t == 'link' and r == 'alternate']
            cat = None if first == '/atlas/' else first.rstrip('/').rsplit('/', 1)[1]
            want_json = '/api/v1' + (f'/atlas/page/{n}.json' if cat is None else f'/atlas/categories/{cat}/page/{n}.json')
            if (want_json, 'alternate') not in alts: fails.append(f'{u}: no <link rel=alternate> to its JSON page {want_json}')
            if (u + 'index.md', 'alternate') not in alts: fails.append(f'{u}: no <link rel=alternate> to its Markdown twin {u}index.md')
            if n > 1:
                lds = [json.loads(x) for x in pp.ld]
                cp = next((x for x in lds if x.get('@type') == 'CollectionPage'), None)
                pos = [li.get('position') for li in ((cp or {}).get('mainEntity') or {}).get('itemListElement', [])]
                if pos != list(range((n - 1) * PAGE_SIZE + 1, (n - 1) * PAGE_SIZE + len(want) + 1)):
                    fails.append(f'{u}: CollectionPage ItemList positions {pos[:3]}… do not continue the list')
    if reached != {c['slug'] for c in snap}:
        fails.append(f'cards reachable through list pages: {len(reached)} of {len(snap)} (missing {sorted({c["slug"] for c in snap} - reached)[:5]})')
    for u in pages:
        mm = PAGED_HTML_RE.match(u)
        if mm and mm.group(1) not in lists and mm.group(1) != '/atlas/platforms/': fails.append(f'{u}: paged page of an unknown list')
    if any(re.search(r'[?&](q|tag|status|type|feature|category|sort)=', l) for l in locs): fails.append('sitemap lists a filter / search URL (D1: noindex, not in the sitemap)')
    si, si_fails = load_search_index()
    fails += si_fails
    if [r[0] for r in si.get('cards', [])] != lists['/atlas/']: fails.append('search-index.json: cards are not the whole Atlas in list order')
    if si.get('total') != len(snap) or si.get('page_size') != PAGE_SIZE: fails.append('search-index.json: total / page_size wrong')
    idx = open(pages['/atlas/'], encoding='utf-8').read()
    # a card rendered from its index row (atlas.js renderCard mirrors build.card_from_row) is the same card as on page 1
    sys.path.insert(0, HERE)
    import build
    head = {k: si.get(k) for k in ('card_base', 'tag_href', 'thumb', 'cat_labels', 'reach_text', 'tag_limit')}
    grid = idx[idx.find('id="grid"'):]
    for r in si.get('cards', [])[:PAGE_SIZE]:
        if len(r) != len(build.SEARCH_FIELDS): fails.append(f'search-index.json: row {r[:1]} has {len(r)} fields, expected {len(build.SEARCH_FIELDS)}'); break
        if build.card_from_row(head, r) not in grid: fails.append(f'search-index.json: the row of {r[0]} does not render the card shown on /atlas/'); break
    if f'data-total="{len(snap)}"' not in idx: fails.append('/atlas/: catalog lacks data-total (counters come from the search index)')
    print(f'paged lists: {n_pages} HTML list pages in {len(lists)} lists, at most {PAGE_SIZE} cards each, {len(reached)} cards reachable by plain links')
    return fails


def az_list_checks(parsed, pages, locs):
    """The A-Z list /atlas/platforms/ (paged since #107, like the other lists): page 1 is /atlas/platforms/, then
    /atlas/platforms/page/N/ up to the last page and nothing after it; each page is a table of at most PAGE_SIZE rows, exactly
    its slice of the list (every entry reachable once by plain links); rel prev/next in head and pager; "page N of M" in title
    and description; self-canonical, indexable, in the sitemap; Markdown twin and JSON page linked; ItemList positions continue
    across pages; the A-Z jump bar on every page links each letter to the page (and row) where that letter starts, letters with
    no entry are not links; /page/1/ answers 301; the JSON pages /api/v1/atlas/platforms/page/N.json walk platforms.json once,
    in order, with has_more / next / prev / total / count / url and the build's snapshot_id; atlas/index.json links them."""
    fails, first, A = [], '/atlas/platforms/', ORIGIN + '/api/v1'
    snap = json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']
    order = sorted(snap, key=lambda c: c['name'].lower())
    slugs = [c['slug'] for c in order]
    m = max(1, -(-len(slugs) // PAGE_SIZE))
    starts = {}
    for i, c in enumerate(order):
        starts.setdefault(az_letter(c['name']), (i // PAGE_SIZE + 1, c['slug']))
    red = open(os.path.join(DIST, '_redirects')).read() if os.path.exists(os.path.join(DIST, '_redirects')) else ''
    if f'{first}page/1/ {first} 301' not in red: fails.append(f'_redirects lacks {first}page/1/ -> {first} 301')
    if f'{first}page/1/index.md {first}index.md 301' not in red: fails.append(f'_redirects lacks {first}page/1/index.md -> {first}index.md 301')
    for n_bad in (1, m + 1):
        if os.path.exists(os.path.join(DIST, 'atlas', 'platforms', 'page', str(n_bad))): fails.append(f'{first}page/{n_bad}/ is built')
    row_re = re.compile(r'<tr(?: id="(az-[0-9a-z])")?><td><a href="/atlas/platforms/([a-z0-9-]+)/">')
    bar_re = re.compile(r'<nav class="cw-azbar"[^>]*><ol>(.*?)</ol></nav>', re.S)
    reached = []
    for n in range(1, m + 1):
        u = html_list_path(first, n)
        if u not in pages: fails.append(f'{u}: A-Z list page missing'); continue
        h = open(pages[u], encoding='utf-8').read()
        main_ = h[h.find('<main'):h.find('</main>')]
        rows = row_re.findall(main_)
        shown = [sl for _, sl in rows]
        want = slugs[(n - 1) * PAGE_SIZE:n * PAGE_SIZE]
        if shown != want: fails.append(f'{u}: rows {shown[:3]}… are not slice {n} of the A-Z list ({want[:3]}…)')
        reached += shown
        want_ids = {('az-0' if l == '#' else 'az-' + l.lower()): sl for l, (pn, sl) in starts.items() if pn == n}
        got_ids = {i: sl for i, sl in rows if i}
        if got_ids != want_ids: fails.append(f'{u}: letter anchors {sorted(got_ids)} != {sorted(want_ids)}')
        if m > 1:
            bar = bar_re.search(main_)
            if not bar: fails.append(f'{u}: no A-Z jump bar')
            else:
                links = dict((t, hr) for hr, t in re.findall(r'<a href="([^"]+)"[^>]*>([^<]+)</a>', bar.group(1)))
                want_links = {('#' if l == '#' else l): f"{html_list_path(first, pn)}#{'az-0' if l == '#' else 'az-' + l.lower()}" for l, (pn, _) in starts.items()}
                if links != want_links:
                    diff = sorted(l for l in set(links) | set(want_links) if links.get(l) != want_links.get(l))
                    fails.append(f'{u}: A-Z jump bar letters {diff[:5]} link {[links.get(l) for l in diff[:5]]}, expected {[want_links.get(l) for l in diff[:5]]}')
                plain = re.findall(r'<span aria-hidden="true">([^<]+)</span>', bar.group(1))
                if sorted(plain + list(links)) != sorted(AZ_LETTERS): fails.append(f'{u}: A-Z jump bar does not show every letter once')
        pp = parsed.get(u)
        if not pp: continue
        heads = {r: hr for t, hr, r in pp.links if t == 'link' and r in ('prev', 'next')}
        anchors = {r: hr for t, hr, r in pp.links if t == 'a' and r in ('prev', 'next')}
        want_rel = {**({'prev': html_list_path(first, n - 1)} if n > 1 else {}), **({'next': html_list_path(first, n + 1)} if n < m else {})}
        if heads != want_rel: fails.append(f'{u}: <link rel=prev/next> {heads} != {want_rel}')
        if anchors != want_rel: fails.append(f'{u}: pager <a rel=prev/next> {anchors} != {want_rel}')
        if m > 1 and f'page {n} of {m}' not in pp.title: fails.append(f'{u}: title lacks "page {n} of {m}": {pp.title!r}')
        if m > 1 and f'page {n} of {m}' not in (pp.meta.get('description') or '').lower(): fails.append(f'{u}: description lacks "page {n} of {m}"')
        if pp.canon != ORIGIN + u: fails.append(f'{u}: canonical {pp.canon} is not self')
        if 'noindex' in (pp.meta.get('robots') or ''): fails.append(f'{u}: A-Z list page is noindex')
        if ORIGIN + u not in locs: fails.append(f'{u}: not in the sitemap')
        alts = [(hr, r) for t, hr, r in pp.links if t == 'link' and r == 'alternate']
        if (f'/api/v1/atlas/platforms/page/{n}.json', 'alternate') not in alts: fails.append(f'{u}: no <link rel=alternate> to its JSON page')
        if (u + 'index.md', 'alternate') not in alts: fails.append(f'{u}: no <link rel=alternate> to its Markdown twin')
        lds = [json.loads(x) for x in pp.ld]
        cp = next((x for x in lds if x.get('@type') == 'CollectionPage'), None)
        pos = [li.get('position') for li in ((cp or {}).get('mainEntity') or {}).get('itemListElement', [])]
        if pos != list(range((n - 1) * PAGE_SIZE + 1, (n - 1) * PAGE_SIZE + len(want) + 1)):
            fails.append(f'{u}: ItemList positions {pos[:3]}… do not continue the list')
        md = os.path.join(DIST, u.lstrip('/'), 'index.md')
        if not os.path.isfile(md) or any(f'/atlas/platforms/{sl}/)' not in open(md, encoding='utf-8').read() for sl in want):
            fails.append(f'{u}: Markdown twin missing or lacks its rows')
    if reached != slugs: fails.append(f'A-Z list: {len(reached)} rows over {m} pages, expected every entry once in order ({len(slugs)})')
    # JSON pages
    legacy = json.load(open(os.path.join(DIST, 'api', 'v1', 'atlas', 'platforms.json'), encoding='utf-8'))
    rec = {r['id']: r for r in legacy['platforms']}
    ai = json.load(open(os.path.join(DIST, 'api', 'v1', 'atlas', 'index.json'), encoding='utf-8'))
    sid = (ai.get('paging') or {}).get('snapshot_id')
    walked, url, n = [], (ai.get('paging') or {}).get('az_first'), 0
    if url != A + '/atlas/platforms/page/1.json': fails.append(f'atlas/index.json paging.az_first {url!r}')
    if (ai.get('links') or {}).get('az_page') != A + '/atlas/platforms/page/{page}.json': fails.append('atlas/index.json links.az_page wrong')
    while url and n <= m:
        n += 1
        fp = os.path.join(DIST, url[len(ORIGIN):].lstrip('/'))
        if not os.path.isfile(fp): fails.append(f'A-Z json: {url} missing'); break
        d = json.load(open(fp, encoding='utf-8'))
        items = d.get('platforms') or []
        exp = {'page': n, 'per_page': PAGE_SIZE, 'pages': m, 'total': len(slugs), 'count': len(items), 'has_more': n < m, 'snapshot_id': sid,
               'next': f'{A}/atlas/platforms/page/{n + 1}.json' if n < m else None, 'prev': f'{A}/atlas/platforms/page/{n - 1}.json' if n > 1 else None,
               'first': f'{A}/atlas/platforms/page/1.json', 'url': ORIGIN + html_list_path(first, n), 'md_url': ORIGIN + html_list_path(first, n) + 'index.md',
               'full_list': f'{A}/atlas/platforms.json'}
        bad = {f: (d.get(f), v) for f, v in exp.items() if d.get(f) != v}
        if bad: fails.append(f'A-Z json page {n}: {bad}')
        if any(rec.get(r.get('id')) != r for r in items): fails.append(f'A-Z json page {n}: a record differs from platforms.json')
        walked += [r.get('id') for r in items]
        url = d.get('next') if d.get('has_more') else None
    if walked != slugs: fails.append(f'A-Z json: walking next gives {len(walked)} ids, not platforms.json once in order')
    if os.path.exists(os.path.join(DIST, 'api', 'v1', 'atlas', 'platforms', 'page', f'{m + 1}.json')): fails.append(f'A-Z json: page {m + 1} exists past the last page')
    if os.path.isfile(os.path.join(DIST, 'atlas', 'platforms', 'page', 'index.html')):
        fails.append('/atlas/platforms/page/ exists: the slug "page" is reserved for the A-Z list pages')
    print(f'A-Z list: {m} pages, {len(reached)} rows reachable by plain links, {len(starts)} letters in the jump bar, JSON walk {len(walked)} ids')
    return fails


def api_checks(parsed, locs):
    """Static API v1 (/api/v1/): every JSON file in dist parses; every path promised by openapi.json exists; every API data
    document validates against its JSON Schema and equals its legacy /atlas/*.json twin (+ schema_version); counts agree
    across old and new endpoints; CORS/content-type headers; docs page /atlas/api/ is linked from footer, About, llms files, README, sitemap."""
    sys.path.insert(0, HERE)
    import api_v1
    fails = []
    V = os.path.join(DIST, 'api', 'v1')
    if not os.path.isdir(V):
        return ['api: dist/api/v1 missing']
    docs = {}
    for root, _, files in os.walk(DIST):
        for fn in files:
            if fn.endswith('.json'):
                fp = os.path.join(root, fn)
                try:
                    obj = json.load(open(fp, encoding='utf-8'))
                except Exception as ex:
                    fails.append(f'invalid JSON {os.path.relpath(fp, DIST)}: {ex}'); continue
                rel = '/' + os.path.relpath(fp, DIST).replace(os.sep, '/')
                if rel.startswith('/api/v1/'):
                    docs[rel[len('/api/v1'):]] = obj
    spec = docs.get('/openapi.json') or {}
    if not str(spec.get('openapi', '')).startswith('3.1'): fails.append('api: openapi.json is not OpenAPI 3.1')
    if spec.get('info', {}).get('version') != api_v1.SCHEMA_VERSION: fails.append('api: openapi info.version != schema_version')
    legacy_list = json.load(open(os.path.join(DIST, 'atlas', 'platforms.json')))
    ids = [r['id'] for r in legacy_list['platforms']]
    cats = [r['id'] for r in (docs.get('/atlas/index.json') or {}).get('categories', [])]
    pages_of = {None: ((docs.get('/atlas/index.json') or {}).get('counts') or {}).get('pages', 1)}
    pages_of |= {c['id']: c.get('pages', 1) for c in (docs.get('/atlas/index.json') or {}).get('categories', [])}
    for p in api_v1.expand_paths(spec, ids, cats, pages_of) if spec else []:
        if p not in docs: fails.append(f'api: openapi path {p} not in dist')
    for p, op in (spec.get('paths') or {}).items():
        for code, r in op['get']['responses'].items():
            ref = (((r.get('content') or {}).get('application/json') or {}).get('schema') or {}).get('$ref')
            if ref and ref.lstrip('./').replace('schemas/', '/schemas/', 1) not in docs and '/' + ref.lstrip('./') not in docs:
                fails.append(f'api: {p} {code} references missing schema {ref}')
    reg = {k[len('/schemas/'):]: v for k, v in docs.items() if k.startswith('/schemas/')}
    for name, sch in reg.items():
        if sch.get('$schema') != 'https://json-schema.org/draft/2020-12/schema': fails.append(f'api: {name} not JSON Schema 2020-12')
        if sch.get('$id') != f"{ORIGIN}/api/v1/schemas/{name}": fails.append(f'api: {name} $id wrong')
    std = None  # standard jsonschema (CI installs requirements-ci.txt); otherwise the built-in api_v1.validate
    try:
        sys.path.insert(0, os.path.join(HERE, 'tools'))
        import validate_jsonschema as _vj
        std = _vj.make_validators(reg)
        _std_validate = lambda v, name, o: _vj.errors_for(v[name], o)
    except ImportError:
        pass
    except Exception as ex:
        fails.append(f'api: schemas rejected by jsonschema: {ex}')
    n_valid = 0
    for p, obj in docs.items():
        if not obj or not isinstance(obj, dict) or 'schema' not in obj or p.startswith('/schemas/'):
            continue
        sch = obj['schema'].rsplit('/', 1)[-1]
        if sch not in reg:
            fails.append(f'api: {p} names unknown schema {obj["schema"]}'); continue
        if obj.get('schema_version') != api_v1.SCHEMA_VERSION: fails.append(f'api: {p} schema_version {obj.get("schema_version")}')
        errs = _std_validate(std, sch, obj) if std else api_v1.validate(obj, reg[sch], reg, sch, limit=5)
        n_valid += 1
        if errs: fails.append(f'api: {p} fails {sch}: {errs[:3]}')
        if PAGED_JSON_RE.match(p) or AZ_JSON_RE.match(p):
            continue  # paged lists are new in /api/v1 (1.8.0) and have no legacy /atlas/*.json twin; paged_json_checks covers them
        twin = os.path.join(DIST, p.lstrip('/'))
        if not os.path.isfile(twin):
            fails.append(f'api: {p} has no legacy twin'); continue
        old = json.load(open(twin, encoding='utf-8'))
        if {k: v for k, v in obj.items() if k not in ('schema_version', 'schema')} != old:
            fails.append(f'api: {p} drifted from legacy {p}')
    want = {'/atlas/platforms.json', '/atlas/earn.json'} | {f'/atlas/platforms/{i}.json' for i in ids} | {f'/atlas/categories/{k}.json' for k in cats}
    missing = [p for p in want if p not in docs]
    if missing: fails.append(f'api: data documents missing: {sorted(missing)[:5]}')
    n_paged = sum(1 for p in docs if PAGED_JSON_RE.match(p) or AZ_JSON_RE.match(p))
    if n_valid != len(want) + n_paged: fails.append(f'api: validated {n_valid} data documents, expected {len(want)} + {n_paged} list pages')
    if api_v1.PAGE_SIZE != PAGE_SIZE: fails.append(f'api_v1.PAGE_SIZE {api_v1.PAGE_SIZE} != check.py PAGE_SIZE {PAGE_SIZE}')
    fails += paged_json_checks(docs, legacy_list, cats)
    # counts equal across old and new endpoints
    ai, root = docs.get('/atlas/index.json') or {}, docs.get('/index.json') or {}
    n = len(ids)
    new_list = docs.get('/atlas/platforms.json') or {}
    snap_n = len(json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms'])
    counts = {'legacy platforms.json count': legacy_list['count'], 'api platforms.json count': new_list.get('count'), 'api platforms.json items': len(new_list.get('platforms', [])),
              'api atlas/index counts.platforms': (ai.get('counts') or {}).get('platforms'), 'api index modules.atlas.count': ((root.get('modules') or {}).get('atlas') or {}).get('count'),
              'sum of api categories': sum(c['count'] for c in ai.get('categories', [])), 'snapshot.json': snap_n,
              'legacy per-entry files': len([f for f in os.listdir(os.path.join(DIST, 'atlas', 'platforms')) if f.endswith('.json')]),
              'api per-entry files': len([f for f in os.listdir(os.path.join(V, 'atlas', 'platforms')) if f.endswith('.json')])}
    bad = {k: v for k, v in counts.items() if v != n}
    if bad: fails.append(f'api: counts differ from {n}: {bad}')
    for k in cats:
        c_old = json.load(open(os.path.join(DIST, 'atlas', 'categories', f'{k}.json')))['count']
        c_idx = next(c['count'] for c in ai['categories'] if c['id'] == k)
        if not c_old == c_idx == (docs.get(f'/atlas/categories/{k}.json') or {}).get('count'): fails.append(f'api: category {k} counts differ')
    if (ai.get('counts') or {}).get('earn_rows') != (docs.get('/atlas/earn.json') or {}).get('count'): fails.append('api: earn row counts differ')
    if root.get('schema_version') != api_v1.SCHEMA_VERSION or root.get('version') != 'v1': fails.append('api: index.json version/schema_version')
    if not api_v1.pattern_ok(api_v1.UTC_PATTERN, str(root.get('generated_at'))): fails.append('api: index.json generated_at not ISO UTC')
    # generated_at = the newest data in the build (schema_version 1.9.0): the later of source_snapshot_at and newest_observation,
    # the same value in every data file (ISO strings of one format compare in time order)
    gens = set()
    gen_paths = ['/index.json', '/atlas/index.json', '/atlas/platforms.json', '/atlas/earn.json', '/atlas/page/1.json', '/atlas/platforms/page/1.json']
    gen_paths += [f'/atlas/categories/{k}.json' for k in cats[:1]] + [f'/atlas/platforms/{i}.json' for i in ids[:1]]
    for path in gen_paths:
        d = docs.get(path) or {}
        g, src = d.get('generated_at'), d.get('source_snapshot_at')
        if not (api_v1.pattern_ok(api_v1.UTC_PATTERN, str(g)) and api_v1.pattern_ok(api_v1.UTC_PATTERN, str(src))):
            fails.append(f'api: {path} generated_at / source_snapshot_at not ISO 8601 UTC ({g!r}, {src!r})'); continue
        if g < src: fails.append(f'api: {path} generated_at {g} is earlier than source_snapshot_at {src}')
        newest = d.get('newest_observation') or (docs.get('/atlas/index.json') or {}).get('newest_observation')
        if newest and g != max(src, newest): fails.append(f'api: {path} generated_at {g} != later of source_snapshot_at {src} and newest_observation {newest}')
        gens.add(g)
    if len(gens) > 1: fails.append(f'api: generated_at differs between data files: {sorted(gens)}')
    for k in ('openapi', 'docs', 'llms_txt', 'license', 'github_mirror', 'changelog'):
        if not (root.get('links') or {}).get(k): fails.append(f'api: index.json links.{k} missing')
    if not os.path.isfile(os.path.join(V, 'CHANGELOG.md')): fails.append('api: CHANGELOG.md missing')
    # the static API serves the Atlas only: its root says so and points to the live platform API (/v1, OpenAPI, MCP)
    if root.get('name') != 'Commonworld Atlas API': fails.append('api: index.json name must be "Commonworld Atlas API" (the platform API is /v1)')
    for need in ('/v1/', ORIGIN + '/openapi.json', ORIGIN + '/mcp'):
        if need not in str(root.get('description')): fails.append(f'api: index.json description lacks {need}')
    # headers
    hd = open(os.path.join(DIST, '_headers')).read()
    if not re.search(r'^/api/\*\n  Access-Control-Allow-Origin: \*$', hd, re.M): fails.append('_headers: /api/* lacks CORS *')
    # no forced Content-Type on /api/v1/*.json: Cloudflare serves .json as application/json by itself, and a forced header would
    # also label the HTML 404 page of a wrong ID as JSON
    if re.search(r'^/api/v1/\*\.json$', hd, re.M): fails.append('_headers: do not force Content-Type on /api/v1/*.json (404 pages are HTML)')
    # docs page + links to it
    D = '/atlas/api/'
    if D not in parsed: fails.append('api: docs page /atlas/api/ missing')
    if ORIGIN + D not in locs: fails.append('api: /atlas/api/ not in sitemap')
    for u, p in parsed.items():
        if u != '/404.html' and D not in [h for t, h, r in p.links]: fails.append(f'{u}: footer lacks link to {D}'); break
    if '/api/v1/index.json' not in [h for t, h, r in parsed.get('/atlas/about/', P()).links]: fails.append('/atlas/about/: no link to /api/v1/')
    for f in ('llms.txt', 'llms-full.txt'):
        if ORIGIN + D not in open(os.path.join(DIST, f), encoding='utf-8').read(): fails.append(f'{f}: no link to {D}')
    readme = os.path.normpath(os.path.join(HERE, '..', '..', 'README.md'))
    if os.path.exists(readme) and ORIGIN + D not in open(readme, encoding='utf-8').read(): fails.append(f'README.md: no link to {D}')
    print(f'api: {len(docs)} JSON files under /api/v1, {n_valid} data documents schema-valid ({"jsonschema" if std else "built-in validator"}) and equal to their legacy twins, '
          f'{len(api_v1.expand_paths(spec, ids, cats, pages_of)) if spec else 0} OpenAPI paths resolved')
    return fails


MAX_SHOT, MAX_THUMB = 256 * 1024, 25 * 1024
SHOT_WH, THUMB_WH = (1200, 750), (600, 250)


def webp_size(b):
    """(width, height) of a WebP file without Pillow (VP8, VP8L, VP8X), or None."""
    if len(b) < 30 or b[:4] != b'RIFF' or b[8:12] != b'WEBP':
        return None
    ch = b[12:16]
    if ch == b'VP8 ' and b[23:26] == b'\x9d\x01\x2a':
        w, h = struct.unpack('<HH', b[26:30])
        return w & 0x3fff, h & 0x3fff
    if ch == b'VP8L' and b[20] == 0x2f:
        v = int.from_bytes(b[21:25], 'little')
        return (v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1
    if ch == b'VP8X':
        return int.from_bytes(b[24:27], 'little') + 1, int.from_bytes(b[27:30], 'little') + 1
    return None


def screens_checks(pages):
    fails = []
    sdir = os.path.join(DIST, 'atlas', 'screens')
    mpath = os.path.join(sdir, 'manifest.json')
    man = json.load(open(mpath))['screens'] if os.path.exists(mpath) else {}
    recs = {r['id']: r for r in json.load(open(os.path.join(DIST, 'atlas', 'platforms.json')))['platforms']}
    utc = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$')
    with_prev = {k for k, r in recs.items() if r.get('preview')}
    if 'preview' not in next(iter(recs.values()), {}):
        fails.append('platforms.json: records lack the preview field')
    if os.environ.get('CW_SCREENS_REQUIRED') == '1' and not with_prev:
        fails.append('screens: CW_SCREENS_REQUIRED=1 but no card has a preview (branch atlas-screens not fetched?)')
    if set(man) != with_prev:
        fails.append(f'screens: manifest vs preview drift: no preview {sorted(set(man) - with_prev)[:5]}, no manifest record {sorted(with_prev - set(man))[:5]}')
    files = {f[:-5] for f in os.listdir(sdir) if f.endswith('.webp')} if os.path.isdir(sdir) else set()
    tfiles = {f[:-5] for f in os.listdir(os.path.join(sdir, 't')) if f.endswith('.webp')} if os.path.isdir(os.path.join(sdir, 't')) else set()
    if files - set(man): fails.append(f'screens: orphan image(s) without manifest record: {sorted(files - set(man))[:5]}')
    if tfiles - set(man): fails.append(f'screens: orphan thumbnail(s): {sorted(tfiles - set(man))[:5]}')
    if set(man) - set(recs): fails.append(f'screens: manifest slug(s) that are not published cards: {sorted(set(man) - set(recs))[:5]}')
    thumbs_on = bool(tfiles)
    for k in sorted(with_prev):
        p, m = recs[k]['preview'], man.get(k) or {}
        if p.get('path') != f'/atlas/screens/{k}.webp' or p.get('url') != ORIGIN + p.get('path', ''):
            fails.append(f'{k}: preview path/url {p.get("path")} {p.get("url")}')
        if not utc.match(str(p.get('captured_at'))): fails.append(f'{k}: preview.captured_at not ISO UTC')
        if not str(p.get('source_url', '')).startswith('https://'): fails.append(f'{k}: preview.source_url not https')
        if (p.get('captured_at'), p.get('source_url')) != (m.get('captured_at'), m.get('source_url')): fails.append(f'{k}: preview differs from screens manifest')
        if (p.get('width'), p.get('height')) != SHOT_WH: fails.append(f'{k}: preview size {p.get("width")}x{p.get("height")}')
        if 'not covered' not in str(p.get('rights')): fails.append(f'{k}: preview.rights missing')
        fp = os.path.join(sdir, f'{k}.webp')
        if not os.path.exists(fp):
            fails.append(f'{k}: screenshot file missing in dist'); continue
        b = open(fp, 'rb').read()
        if webp_size(b) != SHOT_WH: fails.append(f'{k}: screenshot is not a {SHOT_WH[0]}x{SHOT_WH[1]} WebP ({webp_size(b)})')
        if len(b) > MAX_SHOT: fails.append(f'{k}: screenshot {len(b)} bytes > {MAX_SHOT // 1024} KB')
        if m.get('bytes') != len(b): fails.append(f'{k}: screenshot bytes differ from manifest')
        if thumbs_on:
            tp = os.path.join(sdir, 't', f'{k}.webp')
            if not os.path.exists(tp):
                fails.append(f'{k}: thumbnail missing'); continue
            tb = open(tp, 'rb').read()
            if webp_size(tb) != THUMB_WH: fails.append(f'{k}: thumbnail is not {THUMB_WH[0]}x{THUMB_WH[1]} ({webp_size(tb)})')
            if len(tb) > MAX_THUMB: fails.append(f'{k}: thumbnail {len(tb)} bytes > {MAX_THUMB // 1024} KB')
            if p.get('thumb_url') != f'{ORIGIN}/atlas/screens/t/{k}.webp': fails.append(f'{k}: preview.thumb_url {p.get("thumb_url")}')
    # nothing dropped: every image of the fetched branch that belongs to a published card is published
    src_dir = os.environ.get('CW_SCREENS_DIR') or os.path.join(HERE, '.screens-cache', 'branch')
    if os.path.exists(os.path.join(src_dir, 'manifest.json')) and os.environ.get('CW_SCREENS', '').lower() not in ('0', 'off', 'no', 'false'):
        branch = set((json.load(open(os.path.join(src_dir, 'manifest.json'))).get('screens') or {}))
        dropped = sorted((branch & set(recs)) - with_prev)
        if dropped: fails.append(f'screens: {len(dropped)} image(s) on the branch not published (bad file/hash?): {dropped[:5]}')
    # card pages
    for k, r in recs.items():
        u = f'/atlas/platforms/{k}/'
        if u not in pages: continue
        h = open(pages[u], encoding='utf-8').read()
        figs = re.findall(r'<figure class="entry-shot[^"]*">.*?</figure>', h, re.S)
        if len(figs) != 1:
            fails.append(f'{u}: {len(figs)} figure.entry-shot'); continue
        f = figs[0]
        hd = h.find('</header>', h.find('<header class="entry-head"'))
        fi, fa = h.find('<figure class="entry-shot'), h.find('<dl class="facts">')
        ad = h.find('data-ad-slot="atlas-platform-top"')
        if not (hd < fi < fa) or (ad != -1 and not (hd < ad < fi)):
            fails.append(f'{u}: order must be header, sponsored slot, screenshot, facts')
        between = re.sub(r'<aside class="cw-ad[^>]*data-ad-slot="atlas-platform-top".*?</aside>', '', h[hd + len('</header>'):fi], flags=re.S)
        if between.strip(): fails.append(f'{u}: unexpected content between header and screenshot')
        if r.get('preview'):
            im = re.search(r'<img ([^>]*)>', f)
            a = dict(re.findall(r'(\w[\w-]*)="([^"]*)"', im.group(1))) if im else {}
            if a.get('src') != f'/atlas/screens/{k}.webp' or not a.get('alt') or a.get('width') != '1200' or a.get('height') != '750' or a.get('loading') != 'lazy':
                fails.append(f'{u}: screenshot <img> attributes {a}')
            if not re.search(r'captured <time datetime=', f, re.I): fails.append(f'{u}: screenshot caption lacks "captured <time>"')
            if r['status'] == 'closed' and 'Last captured' not in f: fails.append(f'{u}: closed card caption lacks "Last captured"')
            if 'not part of the CC BY data' not in f: fails.append(f'{u}: screenshot caption lacks the rights line')
        elif 'is-empty' not in f or '<img' in f:
            fails.append(f'{u}: card without preview must show the placeholder')
    # grids: index, category pages, closed page, "More in" blocks
    nthumb = 0
    for u, fp in pages.items():
        if not u.startswith('/atlas/'): continue
        h = open(fp, encoding='utf-8').read()
        for m in re.finditer(r'<article class="cw-card(?! cw-adcard)[^"]*"[^>]*>(.*?)<div class="cw-meta">.*?<h3><a href="/atlas/platforms/([a-z0-9-]+)/"', h, re.S):
            lead, slug = m.group(1), m.group(2)
            if recs.get(slug, {}).get('preview'):
                a = dict(re.findall(r'(\w[\w-]*)="([^"]*)"', lead))
                want = f'/atlas/screens/t/{slug}.webp' if thumbs_on else f'/atlas/screens/{slug}.webp'
                wh = ('600', '250') if thumbs_on else ('1200', '750')
                if not lead.startswith('<img ') or a.get('src') != want or a.get('alt') != '' or (a.get('width'), a.get('height')) != wh or a.get('loading') != 'lazy':
                    fails.append(f'{u}: grid card {slug} thumbnail markup {lead[:120]!r}'); continue
                nthumb += 1
            elif lead != '<i class="ph" aria-hidden="true"></i>':
                fails.append(f'{u}: grid card {slug} without preview lacks the placeholder')
    hd = open(os.path.join(DIST, '_headers')).read()
    if '/atlas/screens/*\n  Cache-Control: public, max-age=86400' not in hd: fails.append('_headers lacks the /atlas/screens/* cache block')
    print(f'screens: {len(with_prev)} of {len(recs)} cards with preview, {len(files)} images, {len(tfiles)} thumbnails, {nthumb} grid thumbnails checked')
    return fails


def csp_checks(pages):
    """Strict CSP (no 'unsafe-inline'): every inline <script>/<style> on every page has its sha256 in the CSP,
    no style="" / on*="" attributes or javascript: URLs, the Pages nonce middleware matches the CSP, the Function
    only runs for HTML (_routes.json), and Permissions-Policy leaves picture-in-picture alone (Cloudflare's
    challenge script probes it)."""
    import base64, hashlib
    fails = []
    hd = open(os.path.join(DIST, '_headers'), encoding='utf-8').read()
    blk = hd[hd.find('\n/*\n') + 1:] if '\n/*\n' in hd else ''
    m = re.search(r'^  Content-Security-Policy: (.+)$', blk, re.M)
    if not m:
        return ['_headers: /* block has no Content-Security-Policy']
    csp = {d.split(' ')[0]: d.split(' ')[1:] for d in m.group(1).split('; ')}
    for k in ('script-src', 'style-src'):
        if k not in csp: fails.append(f'CSP lacks {k}')
    for k, v in csp.items():
        for bad in ("'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", '*'):
            if bad in v: fails.append(f'CSP {k} allows {bad}')
    if "'self'" not in csp.get('script-src', []): fails.append("CSP script-src lacks 'self' (Cloudflare /cdn-cgi/ scripts)")
    for k, want in (('object-src', "'none'"), ('base-uri', "'self'"), ('script-src-attr', "'none'"), ('style-src-attr', "'none'")):
        if csp.get(k) != [want]: fails.append(f'CSP {k} should be {want}')
    pp = re.search(r'^  Permissions-Policy: (.+)$', blk, re.M)
    if pp and 'picture-in-picture' in pp.group(1): fails.append('Permissions-Policy names picture-in-picture (Cloudflare challenge script logs an error)')
    sh = lambda t: "'sha256-" + base64.b64encode(hashlib.sha256(t.encode('utf-8')).digest()).decode() + "'"
    script_re = re.compile(r'<script\b(?![^>]*\bsrc=)(?![^>]*\btype="application/(?:ld\+)?json")[^>]*>(.*?)</script>', re.S)
    used = set()
    every = {os.path.relpath(os.path.join(r, f), DIST): os.path.join(r, f) for r, _, fs in os.walk(DIST) for f in fs if f.endswith('.html')}
    for u, fp in sorted(every.items()):  # every HTML file, stubs included
        h = open(fp, encoding='utf-8').read()
        for mm in script_re.finditer(h):
            hs = sh(mm.group(1)); used.add(hs)
            if hs not in csp.get('script-src', []): fails.append(f'{u}: inline script {hs} not allowed by the CSP hash list')
        for mm in re.finditer(r'<style\b[^>]*>(.*?)</style>', h, re.S):
            if sh(mm.group(1)) not in csp.get('style-src', []): fails.append(f'{u}: inline <style> without a CSP hash')
        tags = re.findall(r'<[a-zA-Z][^>]*>', h)
        if any(re.search(r'\sstyle\s*=', t) for t in tags): fails.append(f'{u}: style="" attribute (blocked by style-src-attr)')
        if any(re.search(r'\son[a-z]+\s*=', t) for t in tags): fails.append(f'{u}: inline event handler (blocked by script-src-attr)')
        if re.search(r'(?:href|src|action)\s*=\s*"\s*javascript:', h, re.I): fails.append(f'{u}: javascript: URL')
    stale = [x for x in csp.get('script-src', []) if x.startswith("'sha256-") and x not in used]
    if stale: fails.append(f'CSP script-src carries {len(stale)} hash(es) no page uses')
    for f in ('cw-components.js',):
        if re.search(r'style=\\?["\']', open(os.path.join(HERE, 'components', f)).read()): fails.append(f'{f} builds markup with style=""')
    if re.search(r'style=\\?["\']', open(os.path.join(HERE, 'static', 'atlas.js')).read()): fails.append('atlas.js builds markup with style=""')
    mw = os.path.join(HERE, '..', '..', 'functions', '_middleware.js')
    if not os.path.exists(mw):
        fails.append('functions/_middleware.js missing (per-request nonce for Cloudflare-injected scripts)')
    else:
        mk = re.search(r'const MARK = "([^"]+)"', open(mw, encoding='utf-8').read())
        if not mk or mk.group(1) not in m.group(1): fails.append('functions/_middleware.js MARK does not match the CSP script-src')
    try:
        rt = json.load(open(os.path.join(DIST, '_routes.json')))
        rules = rt.get('include', []) + rt.get('exclude', [])
        if rt.get('version') != 1 or len(rules) > 100 or any(len(r) > 100 or not r.startswith('/') for r in rules): fails.append('_routes.json: invalid (version 1, <=100 rules, each <=100 chars)')
        for x in ('/atlas/assets/*', '/atlas/og/*', '/atlas/screens/*', '/api/*', '/cdn-cgi/*'):
            if x not in rt.get('exclude', []): fails.append(f'_routes.json does not exclude {x} (assets must not invoke the Function)')
    except (OSError, ValueError) as ex:
        fails.append(f'_routes.json: {ex}')
    hosts = ' '.join(x for x in csp.get('script-src', []) if not x.startswith("'sha256"))
    print(f'csp: {len(used)} inline script hash(es), {len(every)} pages scanned, script-src {hosts}' + ('' if not fails else f' ({len(fails)} problems)'))
    return fails


def a11y_checks(pages):
    """Lighthouse follow-ups (static part; the browser part is in tools/smoke_test.py): counters are not faded with opacity
    (contrast >= 4.5:1), footer links have 24x24 tap targets, the landing logo image has >= 2x the pixels it is shown at."""
    fails = []
    css = open(os.path.join(DIST, 'atlas', 'assets', 'atlas.css'), encoding='utf-8').read()
    for sel in ('.cw-tabs span, .pill span', '.link-pill small'):
        m = re.search(re.escape(sel) + r'\s*\{([^}]*)\}', css)
        if not m: fails.append(f'css: rule {sel} missing')
        elif re.search(r'opacity\s*:\s*0?\.\d', m.group(1)): fails.append(f'css: {sel} faded with opacity (counter contrast < 4.5:1)')
    m = re.search(r'\.cw-foot-links > a, \.cw-foot-links > \.cw-linkbtn\s*\{([^}]*)\}', css)
    if not m or 'min-height:24px' not in m.group(1) or 'min-width:24px' not in m.group(1): fails.append('css: footer links lack 24x24 tap targets')
    if '/' in pages:
        h = open(pages['/'], encoding='utf-8').read()
        imgs = re.findall(r'<img class="cw-mark-[ld] landing-mark" src="([^"]+)"[^>]*width="(\d+)"', h)
        if len(imgs) != 2: fails.append('/: landing logo images not found')
        for src, w in imgs:
            fp = os.path.join(DIST, src.split('?')[0].lstrip('/'))
            if not os.path.isfile(fp): fails.append(f'/: landing logo {src} missing'); continue
            if fp.endswith('.svg'):
                if not open(fp, encoding='utf-8').read().lstrip().startswith('<svg'): fails.append(f'/: landing logo {src} is not an SVG')
                continue
            pw = struct.unpack('>I', open(fp, 'rb').read(24)[16:20])[0]
            if pw < 2 * int(w): fails.append(f'/: landing logo {src} is {pw}px for {w} CSS px (needs >= 2x)')
    return fails


def closure_checks(pages):
    """Closure wording matches atlas/refresh.py: two routes (human review / automated weekly check), auto-closed cards labelled."""
    fails = []
    ch = open(pages['/atlas/closed/'], encoding='utf-8').read()
    for need in ('Human review:', 'Automated weekly check:', '2 consecutive weekly checks', 'reopen automatically if the site answers again',
                 'never reopened automatically', 'A single failed page load is never treated as proof.'):
        if need not in ch: fails.append(f'/atlas/closed/: lacks {need!r}')
    ab = open(pages['/atlas/about/'], encoding='utf-8').read()
    for need in ('id="closures"', 'Automated weekly check', 'Human review', 'A single failed page load is never treated as proof'):
        if need not in ab: fails.append(f'/atlas/about/: closure section lacks {need!r}')
    if 'a failed page load alone is never treated as proof' in ch: fails.append('/atlas/closed/: old one-route closure wording')
    for c in json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']:
        hist = c.get('status_history') or []
        auto = c.get('status') == 'closed' and hist and hist[-1].get('to') == 'closed' and hist[-1].get('by') == REFRESH_TOOL
        h = open(pages[f"/atlas/platforms/{c['slug']}/"], encoding='utf-8').read()
        if auto and '<b>Closed by automated check since' not in h: fails.append(f"{c['slug']}: auto-closed card lacks 'Closed by automated check since'")
        if not auto and 'Closed by automated check' in h and c.get('status') == 'closed': fails.append(f"{c['slug']}: human-closed card labelled automated")
        if auto and f"Closed by automated check since" not in ch: fails.append(f"/atlas/closed/: {c['slug']} lacks the automated-check note")
    return fails


def _share_expectations():
    """Expected share text per entry page, by badge status (verified / listed / closed), and the live count for the index."""
    snap = json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']
    exp = {}
    for c in snap:
        if c.get('status') == 'closed':
            t = f"{c['name']} (closed) — history on Commonworld Atlas"
        elif c.get('verdict') == 'include_verified':
            t = f"{c['name']} — verified on Commonworld Atlas"
        else:
            t = f"{c['name']} on Commonworld Atlas"
        exp[f"/atlas/platforms/{c['slug']}/"] = t
    return sum(1 for c in snap if c.get('status') == 'live'), exp


def iter_ld_nodes(x):
    """Every JSON-LD object in a block, nested ones included (lists and @graph walked)."""
    if isinstance(x, dict):
        yield x
        for v in x.values(): yield from iter_ld_nodes(v)
    elif isinstance(x, list):
        for v in x: yield from iter_ld_nodes(v)


def dataset_haspart_fails(u, blocks):
    """Contract (Google Dataset docs, GSC issue 2026-10-18): Dataset.hasPart / isPartOf take only a URL or a Dataset; a Dataset
    value must stand alone (name, description of 50..5000 chars). Anything else (ItemList, WebPage, DataDownload...) fails."""
    fails = []
    for b in blocks:
        for n in iter_ld_nodes(b):
            if n.get('@type') != 'Dataset' and 'Dataset' not in (n.get('@type') if isinstance(n.get('@type'), list) else []): continue
            for field in ('hasPart', 'isPartOf'):
                if field not in n: continue
                vals = n[field] if isinstance(n[field], list) else [n[field]]
                for v in vals:
                    if isinstance(v, str) and v.startswith(('https://', 'http://')): continue
                    if not isinstance(v, dict) or v.get('@type') != 'Dataset':
                        t = v.get('@type') if isinstance(v, dict) else type(v).__name__
                        fails.append(f'{u}: Dataset.{field} item is {t!r}, Google allows only Dataset or URL'); continue
                    if not v.get('name') or not (50 <= len(v.get('description') or '') <= 5000):
                        fails.append(f"{u}: Dataset.{field} sub-dataset {v.get('name')!r} lacks name or a 50..5000 char description")
    return fails


def dataset_haspart_checks(parsed):
    fails = []
    for u, p in parsed.items():
        fails += dataset_haspart_fails(u, [json.loads(b) for b in p.ld])
    return fails


def dataset_checks(parsed):
    """schema.org Dataset JSON-LD on /atlas/ and each category page (Google Dataset Search): name, description, url, license,
    creator; every DataDownload contentUrl exists in dist. /atlas/llms.txt exists and links the root llms.txt."""
    fails = []
    snap = json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))
    targets = ['/atlas/'] + [u for u in parsed if re.fullmatch(r'/atlas/categories/[a-z0-9-]+/', u)]
    for u in targets:
        ds = [x for x in (json.loads(b) for b in parsed[u].ld) if x.get('@type') == 'Dataset']
        if len(ds) != 1: fails.append(f'{u}: expected 1 Dataset JSON-LD, found {len(ds)}'); continue
        d = ds[0]
        for k in ('name', 'description', 'url', 'license', 'creator', 'distribution', 'dateModified'):
            if not d.get(k): fails.append(f'{u}: Dataset lacks {k}')
        if d.get('url') != ORIGIN + u: fails.append(f"{u}: Dataset url {d.get('url')}")
        if d.get('isAccessibleForFree') is not True: fails.append(f'{u}: Dataset isAccessibleForFree != true')
        for dl in d.get('distribution') or []:
            cu = dl.get('contentUrl') or ''
            if not cu.startswith(ORIGIN + '/') or not os.path.isfile(os.path.join(DIST, cu[len(ORIGIN) + 1:])):
                fails.append(f'{u}: Dataset download missing in dist: {cu}')
            if dl.get('encodingFormat') not in ('application/json', 'text/plain'): fails.append(f'{u}: odd encodingFormat {dl.get("encodingFormat")}')
    idx = next((x for x in (json.loads(b) for b in parsed['/atlas/'].ld) if x.get('@type') == 'Dataset'), {})
    if f"{len(snap['platforms'])} entries" not in idx.get('description', ''): fails.append('/atlas/: Dataset description lacks the live entry count')
    fp = os.path.join(DIST, 'atlas', 'llms.txt')
    if not os.path.isfile(fp): fails.append('missing /atlas/llms.txt')
    else:
        t = open(fp, encoding='utf-8').read()
        for need in (ORIGIN + '/llms.txt', ORIGIN + '/atlas/platforms.json', f"{len(snap['platforms'])} entries"):
            if need not in t: fails.append(f'/atlas/llms.txt lacks {need!r}')
        for path in re.findall(re.escape(ORIGIN) + r'(/atlas/categories/[a-z0-9-]+\.json)', t):
            if not os.path.isfile(os.path.join(DIST, path.lstrip('/'))): fails.append(f'/atlas/llms.txt: broken {path}')
    root_llms = open(os.path.join(DIST, 'llms.txt'), encoding='utf-8').read()
    if ORIGIN + '/atlas/llms.txt' not in root_llms: fails.append('/llms.txt does not link /atlas/llms.txt')
    # the Atlas part of /llms.txt describes Commonworld as it is now: the platform is live next to the Atlas
    if 'Today it is the Atlas' in root_llms: fails.append('/llms.txt still says Commonworld is only the Atlas')
    for need in ('paths under /v1/', ORIGIN + '/openapi.json', ORIGIN + '/mcp', 'OAuth'):
        if need not in root_llms: fails.append(f'/llms.txt (Atlas part) lacks {need!r}')
    return fails


def markdown_twin_checks(pages):
    """Markdown twins (site-wide standard: HTML stays canonical, a page may also publish <path>/index.md): every index.md in dist
    sits next to an index.html that announces it with <link rel="alternate" type="text/markdown">, every such link resolves, the
    twin starts with a '# ' heading and names its canonical URL, and _headers serves it as text/markdown."""
    fails, n = [], 0
    hdr = open(os.path.join(DIST, '_headers'), encoding='utf-8').read() if os.path.exists(os.path.join(DIST, '_headers')) else ''
    alt_re = re.compile(r'<link rel="alternate" type="text/markdown" href="([^"]+)"')
    # _headers rules (exact paths or Cloudflare splats like /atlas/platforms/*/index.md) that serve Markdown with open CORS
    md_rules = re.findall(r'^(\S+)\n  Access-Control-Allow-Origin: \*\n  Content-Type: text/markdown; charset=utf-8$', hdr, re.M)
    for u, fp in pages.items():
        for href in alt_re.findall(open(fp, encoding='utf-8').read()):
            if not href.startswith('/') or not os.path.isfile(os.path.join(DIST, href.lstrip('/'))):
                fails.append(f'{u}: Markdown alternate {href} does not exist')
    for root, _, files in os.walk(DIST):
        if 'index.md' not in files:
            continue
        rel = os.path.relpath(os.path.join(root, 'index.md'), DIST).replace(os.sep, '/')
        n += 1
        u = '/' + rel[:-len('index.md')]
        if u not in pages: fails.append(f'/{rel}: Markdown twin without an HTML page at {u}'); continue
        if f'<link rel="alternate" type="text/markdown" href="/{rel}"' not in open(pages[u], encoding='utf-8').read():
            fails.append(f'{u}: does not link its Markdown twin /{rel}')
        md = open(os.path.join(root, 'index.md'), encoding='utf-8').read()
        if not md.startswith('# '): fails.append(f'/{rel}: does not start with a # heading')
        if ORIGIN + u not in md: fails.append(f'/{rel}: does not name its canonical page {ORIGIN + u}')
        if not any(fnmatch.fnmatchcase('/' + rel, pat) for pat in md_rules):
            fails.append(f'_headers: /{rel} is not served as text/markdown')
    print(f'markdown twins: {n} index.md file(s), each linked from its HTML page')
    return fails, n


STATS_SRC = os.path.join(DATA_DIR, 'stats.json')
STATS_STATUSES = {'ok', 'coming', 'none_yet'}
CITIZEN_METRICS = ('citizens_total', 'citizens_humans', 'citizens_agents', 'citizens_active_7d', 'citizens_posts')
V1_LAUNCHED = True  # Commonworld v1 is live in production since 2026-10-20; citizen rows may carry real numbers (staging test citizens are never shown)
DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')


def stats_checks(parsed, pages, locs):
    """Public stats: atlas/data/stats.json (input, edited by hand for now; its _about must not claim an automatic job) and dist /stats.json (published) give every metric an id,
    label, source.name, period and as_of date (input: as_of may be null only for 'derive' metrics, filled at build); status is ok /
    coming / none_yet, value is null exactly when status is not ok (no estimates); /stats/ shows one row per metric with its as_of,
    names the source and period, links stats.json + index.md, is in the root sitemap, linked from every footer and sidebar and from
    /llms.txt; the derived Atlas counts equal the published snapshot."""
    fails = []
    # honest provenance (2026-10-22): the values are edited by hand, there is no automatic weekly job yet
    about = str(json.load(open(os.path.join(HERE, '..', 'data', 'stats.json'), encoding='utf-8')).get('_about') or '')
    if 'by hand' not in about or 'no automatic weekly job yet' not in about:
        fails.append('stats.json _about must say the values are updated by hand and that there is no automatic weekly job yet')
    if re.search(r'\bA weekly job edits\b', about):
        fails.append('stats.json _about claims a weekly job; the values are updated by hand')
    def metrics_of(doc, where):
        out = []
        for s in doc.get('sections') or []:
            if not s.get('id') or not s.get('title'): fails.append(f'{where}: section without id/title')
            for m in s.get('metrics') or []:
                out.append((s, m))
            wk = s.get('weekly')
            if wk is not None:
                if not (wk.get('source') or {}).get('name') or not DATE_RE.fullmatch(str(wk.get('as_of') or '')):
                    fails.append(f'{where}: section {s.get("id")} weekly table lacks source or as_of')
        return out
    def check_metric(m, where, derived_ok):
        mid = m.get('id') or '?'
        for k in ('id', 'label', 'unit'):
            if not m.get(k): fails.append(f'{where}: metric {mid} lacks {k}')
        if not (m.get('source') or {}).get('name'): fails.append(f'{where}: metric {mid} lacks source.name')
        if not (m.get('period') or {}).get('label') and not (m.get('period') or {}).get('from'): fails.append(f'{where}: metric {mid} lacks period')
        st = m.get('status')
        if st not in STATS_STATUSES: fails.append(f'{where}: metric {mid} status {st!r}')
        if m.get('derive') and derived_ok:
            return
        if not DATE_RE.fullmatch(str(m.get('as_of') or '')): fails.append(f'{where}: metric {mid} lacks as_of (YYYY-MM-DD)')
        if (m.get('value') is None) != (st != 'ok'): fails.append(f'{where}: metric {mid} value {m.get("value")!r} does not match status {st!r}')
    if not os.path.isfile(STATS_SRC):
        return [f'missing {STATS_SRC}']
    src = json.load(open(STATS_SRC, encoding='utf-8'))
    if not DATE_RE.fullmatch(str(src.get('updated_at') or '')): fails.append('atlas/data/stats.json: updated_at not YYYY-MM-DD')
    for _, m in metrics_of(src, 'atlas/data/stats.json'):
        check_metric(m, 'atlas/data/stats.json', True)
    fp = os.path.join(DIST, 'stats.json')
    if not os.path.isfile(fp):
        return fails + ['missing /stats.json']
    pub = json.load(open(fp, encoding='utf-8'))
    pm = metrics_of(pub, '/stats.json')
    ids = [m.get('id') for _, m in pm]
    if len(ids) != len(set(ids)): fails.append('/stats.json: duplicate metric ids')
    for _, m in pm:
        if 'derive' in m: fails.append(f'/stats.json: metric {m.get("id")} still has derive')
        check_metric(m, '/stats.json', False)
    kinds = {s.get('kind') for s, _ in pm}
    for need in ('citizens', 'humans', 'agents', 'search'):
        if need not in kinds: fails.append(f'/stats.json: no separate {need} section')
    # Citizens (main product, Commonworld v1) come first; humans and agents are separate rows, never a web-traffic metric.
    secs = pub.get('sections') or []
    if secs and secs[0].get('kind') != 'citizens': fails.append('/stats.json: the Citizens section must come first')
    cit = {m.get('id'): m for s, m in pm if s.get('kind') == 'citizens'}
    for need in CITIZEN_METRICS:
        if need not in cit: fails.append(f'/stats.json: Citizens section lacks {need}')
    for mid, m in cit.items():
        if mid not in CITIZEN_METRICS: fails.append(f'/stats.json: unexpected metric {mid} in Citizens')
        if not V1_LAUNCHED and (m.get('status') != 'coming' or m.get('value') is not None):
            fails.append(f'/stats.json: {mid} must be coming with no value until the v1 launch (no staging numbers)')
    snap = json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']
    want = {'atlas_cards': len(snap), 'atlas_live': sum(1 for c in snap if c.get('status') == 'live'),
            'atlas_closed': sum(1 for c in snap if c.get('status') == 'closed')}
    vals = {m.get('id'): m.get('value') for _, m in pm}
    for k, v in want.items():
        if k in vals and vals[k] != v: fails.append(f'/stats.json: {k}={vals[k]} != snapshot {v}')
    u = '/stats/'
    if u not in parsed:
        return fails + ['missing /stats/ page']
    h = open(pages[u], encoding='utf-8').read()
    if ORIGIN + u not in locs: fails.append('/stats/ not in the sitemap')
    ad = re.search(r'<aside class="cw-ad cw-ad-banner" data-ad-slot="cw-stats-top" aria-label="Sponsored"><span class="cw-ad-label">Sponsored</span>', h)
    hero_end = h.find('</section>', h.find('class="cw-hero'))
    slot = (CFG0.get('ad_slots') or {}).get('cw-stats-top') or {}
    if slot.get('enabled') and (slot.get('placeholder') or slot.get('creative')) and not ad: fails.append('/stats/: lacks the sponsored slot cw-stats-top')
    elif not ad: pass
    elif not (0 <= hero_end < ad.start() < h.find('class="stats-sec"')): fails.append('/stats/: sponsored slot not between the header and the first section')
    first = re.search(r'<section class="stats-sec" aria-labelledby="s-([a-z_]+)"', h)
    if not first or first.group(1) != 'citizens': fails.append('/stats/: the Citizens section must come first')
    for need in ('<h1>Commonworld in numbers</h1>', 'A shared world for humans and agents', 'href="/stats.json"', 'href="/stats/index.md"',
                 '<link rel="alternate" type="text/markdown" href="/stats/index.md"', '"Dataset"'):
        if need not in h: fails.append(f'/stats/: lacks {need!r}')
    for s, m in pm:
        row = re.search(rf'<tr id="{re.escape(m["id"])}">(.*?)</tr>', h, re.S)
        if not row: fails.append(f'/stats/: no row for {m["id"]}'); continue
        r = row.group(1)
        if f'datetime="{m["as_of"]}"' not in r: fails.append(f'/stats/: row {m["id"]} lacks as_of')
        if html.escape(m['source']['name']) not in r: fails.append(f'/stats/: row {m["id"]} lacks its source')
    side_re = re.compile(r'<aside class="cw-side".*?</aside>', re.S)
    for pu, pf in pages.items():
        t = open(pf, encoding='utf-8').read()
        if 'href="/stats/">Stats</a>' not in t[t.find('<footer class="cw-foot"'):]: fails.append(f'{pu}: footer lacks Stats link')
        sm = side_re.search(t)
        if not sm or 'href="/stats/"' not in sm.group(0): fails.append(f'{pu}: sidebar lacks Stats link')
    llms = open(os.path.join(DIST, 'llms.txt'), encoding='utf-8').read()
    for need in (ORIGIN + '/stats/', ORIGIN + '/stats.json', ORIGIN + '/stats/index.md'):
        if need not in llms: fails.append(f'/llms.txt lacks {need}')
    n_ok = sum(1 for _, m in pm if m.get('value') is not None)
    print(f'stats: {len(pm)} metrics ({n_ok} with a value, {len(pm) - n_ok} coming / nothing yet), every one with source + period + as_of')
    return fails


def decisions_checks(parsed, pages, locs):
    """Link safety decision log: /atlas/decisions/ (indexable, in the sitemap, linked from /atlas/about/), its Markdown twin and
    /atlas/decisions.json list every decision in atlas/data/removed.json (date, action, slug, actor, evidence) newest first and match
    trust-roles.json; hosts are plain defanged text, never a link; evidence links are https with rel nofollow noopener; decisions.json
    is in the /atlas/ Dataset distribution and both llms.txt files."""
    fails = []
    decs = (json.load(open(REMOVED)) if os.path.exists(REMOVED) else {}).get('decisions') or []
    roles = json.load(open(os.path.join(DATA_DIR, 'trust-roles.json')))
    u = '/atlas/decisions/'
    if u not in parsed:
        return [f'missing {u} (link safety decision log)']
    p, h = parsed[u], open(pages[u], encoding='utf-8').read()
    if 'noindex' in (p.meta.get('robots') or ''): fails.append(f'{u}: must be indexable')
    if ORIGIN + u not in locs: fails.append(f'{u}: not in the sitemap')
    mdp = os.path.join(DIST, 'atlas', 'decisions', 'index.md')
    md = open(mdp, encoding='utf-8').read() if os.path.isfile(mdp) else ''
    if not md: fails.append('missing /atlas/decisions/index.md (Markdown twin)')
    jp = os.path.join(DIST, 'atlas', 'decisions.json')
    try:
        dj = json.load(open(jp, encoding='utf-8'))
    except Exception as ex:
        dj = {}; fails.append(f'/atlas/decisions.json: missing or invalid ({ex})')
    rows = [d for _, d in sorted(enumerate(decs), key=lambda x: (x[1].get('on') or '', x[0]), reverse=True)]
    hosts = {d.get('host') for d in decs if d.get('host')}
    for d in rows:
        dh = (d.get('host') or '').replace('.', '[.]')
        for where, txt in (('page', h), ('index.md', md)):
            for need in (d.get('slug'), d.get('on'), d.get('by'), dh, d.get('evidence')):
                if need and html.escape(need, quote=True) not in txt and need not in txt:
                    fails.append(f"decision log {where}: lacks {need!r} of {d.get('action')} {d.get('slug')}")
    trs = re.findall(r'<tr><td><time datetime="(\d{4}-\d{2}-\d{2})"', h)
    if len(trs) != len(rows): fails.append(f'{u}: {len(trs)} table rows != {len(rows)} decisions in removed.json')
    if trs != sorted(trs, reverse=True): fails.append(f'{u}: decisions are not newest first')
    want = [{'on': d.get('on'), 'action': d.get('action'), 'slug': d.get('slug'), 'by': d.get('by'), 'evidence': d.get('evidence')} for d in rows]
    got = [{k: r.get(k) for k in ('on', 'action', 'slug', 'by', 'evidence')} for r in dj.get('decisions') or []]
    if got != want: fails.append('/atlas/decisions.json: decisions differ from atlas/data/removed.json')
    if dj.get('count') != len(decs): fails.append(f"/atlas/decisions.json: count {dj.get('count')} != {len(decs)}")
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(dj.get('generated_at') or '')): fails.append('/atlas/decisions.json: generated_at not ISO 8601 UTC')
    if [a.get('id') for a in (dj.get('trust_roles') or {}).get('actors') or []] != [a.get('id') for a in roles.get('actors') or []]:
        fails.append('/atlas/decisions.json: trust_roles actors differ from atlas/data/trust-roles.json')
    if not ((dj.get('link_safety') or {}).get('rule')): fails.append('/atlas/decisions.json: lacks link_safety.rule')
    for tag, href, rel in p.links:
        if tag != 'a' or not href.startswith(('http://', 'https://', '//')):
            continue
        if any(re.search(r'(?:^|//|\.)' + re.escape(x) + r'(?:[:/]|$)', href.split('?')[0], re.I) for x in hosts):
            fails.append(f'{u}: links to a decision host {href}')
        if href in [d.get('evidence') for d in decs] and not ({'nofollow', 'noopener'} <= set(rel.split())):
            fails.append(f'{u}: evidence link {href} lacks rel="nofollow noopener"')
    if 'href="/atlas/decisions/"' not in open(pages['/atlas/about/'], encoding='utf-8').read(): fails.append('/atlas/about/ does not link /atlas/decisions/')
    # SEO and a11y, same bar as the other Atlas pages
    if p.canon != ORIGIN + u: fails.append(f'{u}: canonical {p.canon}')
    if not p.title.strip() or 'decision log' not in p.title.lower(): fails.append(f'{u}: title {p.title!r}')
    if not (p.meta.get('description') or '').strip(): fails.append(f'{u}: no meta description')
    if '/atlas/og/page-decisions.png' not in (p.meta.get('og:image') or '') and '/atlas/assets/og-atlas.png' not in (p.meta.get('og:image') or ''):
        fails.append(f"{u}: og:image {p.meta.get('og:image')}")
    if p.meta.get('twitter:card') != 'summary_large_image': fails.append(f'{u}: twitter:card')
    lds = [json.loads(b) for b in p.ld]
    if not any(x.get('@type') == 'BreadcrumbList' for x in lds): fails.append(f'{u}: no BreadcrumbList JSON-LD')
    cp = next((x for x in lds if x.get('@type') == 'CollectionPage'), {})
    ds = cp.get('mainEntity') or {}
    if ds.get('@type') != 'Dataset': fails.append(f'{u}: CollectionPage.mainEntity is not a Dataset')
    for k in ('name', 'description', 'url', 'license', 'creator', 'distribution'):
        if not ds.get(k): fails.append(f'{u}: Dataset lacks {k}')
    fmts = sorted(x.get('encodingFormat') for x in ds.get('distribution') or [])
    if fmts != ['application/json', 'text/markdown']: fails.append(f'{u}: Dataset distribution formats {fmts}')
    for x in ds.get('distribution') or []:
        cu = x.get('contentUrl') or ''
        if not cu.startswith(ORIGIN + '/') or not os.path.isfile(os.path.join(DIST, cu[len(ORIGIN) + 1:])): fails.append(f'{u}: Dataset download missing {cu}')
    want_size = f'{len(decs)} decision' + ('' if len(decs) == 1 else 's')
    if ds.get('size') != want_size: fails.append(f"{u}: Dataset size {ds.get('size')!r} != {want_size!r}")
    if any(hh and hh in json.dumps(lds) for hh in hosts): fails.append(f'{u}: JSON-LD names a decision host')
    sm = open(os.path.join(DIST, 'atlas', 'sitemap.xml'), encoding='utf-8').read()
    m = re.search(r'<loc>' + re.escape(ORIGIN + u) + r'</loc><lastmod>([\d-]+)</lastmod>', sm)
    if not m: fails.append(f'{u}: no sitemap entry with lastmod')
    elif rows and m.group(1) != rows[0].get('on'): fails.append(f"{u}: sitemap lastmod {m.group(1)} != newest decision {rows[0].get('on')}")
    if '<main id="main">' not in h: fails.append(f'{u}: no <main> landmark')
    if '<table class="list decisions" aria-labelledby="log">' not in h or '<h2 id="log">' not in h: fails.append(f'{u}: table lacks its accessible name')
    if h.count('<th scope="col">') < 7: fails.append(f'{u}: table headers lack scope="col"')
    linked_from = [x for x, q in parsed.items() if x != u and any(t == 'a' and hr == u for t, hr, _ in q.links)]
    if len(linked_from) < 10: fails.append(f'{u}: linked from only {len(linked_from)} pages (footer link expected)')
    idx = next((x for x in (json.loads(b) for b in parsed['/atlas/'].ld) if x.get('@type') == 'Dataset'), {})
    if ORIGIN + '/atlas/decisions.json' not in [x.get('contentUrl') for x in idx.get('distribution') or []]:
        fails.append('/atlas/: Dataset distribution lacks decisions.json')
    for t in ('llms.txt', os.path.join('atlas', 'llms.txt')):
        if ORIGIN + '/atlas/decisions/' not in open(os.path.join(DIST, t), encoding='utf-8').read(): fails.append(f'/{t} does not link the decision log')
    print(f'decision log: {len(decs)} decision(s) on {u}, index.md and decisions.json, {len(roles.get("actors") or [])} actors')
    return fails


def events_checks():
    """Atlas events log (atlas/data/events.jsonl, atlas/site/events.py): every line has exactly date, slug, type, reason, source
    (YYYY-MM-DD, an existing entry ID or removed stub, added|closed|reopened|corrected|relabelled, a one-line reason <= 300 chars,
    an https source), dates never go backwards (append-only), no duplicates; every curated amendment in the snapshot from the
    log's start date has its events, and so does every dated record in the cards v2 curation files (cards_v2.curation_event_gaps); /atlas/events.json (newest first, same events, count) and /atlas/events.md (every event)
    are published, linked from /atlas/about/, /llms.txt and /atlas/llms.txt, served as JSON/Markdown and kept off the Function."""
    import events as ev_
    fails = []
    try:
        evs = ev_.load()
    except ValueError as ex:
        return [str(ex)]
    if not evs: fails.append('atlas/data/events.jsonl: empty or missing')
    pub = {c['slug'] for c in json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms']}
    rem = {r.get('slug') for r in ((json.load(open(REMOVED)) if os.path.exists(REMOVED) else {}).get('removed') or [])}
    fails += ev_.validate(evs, pub | rem)
    snap_f = os.path.normpath(os.path.join(DATA_DIR, 'snapshot-verified-2026-10-15.json'))
    fails += ev_.amendment_gaps(json.load(open(snap_f, encoding='utf-8')).get('amendments') or [], evs)
    import cards_v2 as cv2   # cards v2 curation files change cards outside the amendments: their records need events too
    fails += cv2.curation_event_gaps(cv2.load_evidence_overrides(), cv2.load_keys_books(), cv2.load_first_tasks(), evs, ev_.START)
    try:
        dj = json.load(open(os.path.join(DIST, 'atlas', 'events.json'), encoding='utf-8'))
    except (OSError, ValueError) as ex:
        return fails + [f'/atlas/events.json: missing or invalid ({ex})']
    if dj.get('events') != ev_.newest_first(evs): fails.append('/atlas/events.json: events differ from atlas/data/events.jsonl (newest first)')
    if dj.get('count') != len(evs): fails.append(f"/atlas/events.json: count {dj.get('count')} != {len(evs)}")
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(dj.get('generated_at') or '')): fails.append('/atlas/events.json: generated_at not ISO 8601 UTC')
    if dj.get('types') != list(ev_.TYPES): fails.append('/atlas/events.json: types list drifted')
    mdp = os.path.join(DIST, 'atlas', 'events.md')
    md = open(mdp, encoding='utf-8').read() if os.path.exists(mdp) else ''
    if not md: fails.append('missing /atlas/events.md')
    for e_ in evs:
        if f"`{e_['slug']}`" not in md or e_['source'] not in md: fails.append(f"/atlas/events.md lacks the {e_['date']} {e_['type']} event of {e_['slug']}")
    ab = os.path.join(DIST, 'atlas', 'about', 'index.html')
    if os.path.exists(ab) and f'href="{ev_.MD_PATH}"' not in open(ab, encoding='utf-8').read(): fails.append('/atlas/about/ does not link the events log')
    for t in ('llms.txt', 'atlas/llms.txt'):
        fp_ = os.path.join(DIST, t)
        if os.path.exists(fp_) and ORIGIN + ev_.JSON_PATH not in open(fp_, encoding='utf-8').read(): fails.append(f'/{t} does not mention the events log')
    hd = open(os.path.join(DIST, '_headers'), encoding='utf-8').read() if os.path.exists(os.path.join(DIST, '_headers')) else ''
    for path_, ct in ((ev_.JSON_PATH, 'application/json'), (ev_.MD_PATH, 'text/markdown')):
        if f'{path_}\n  Access-Control-Allow-Origin: *\n  Content-Type: {ct}; charset=utf-8' not in hd: fails.append(f'_headers: {path_} lacks CORS + {ct}')
    try:
        if ev_.MD_PATH not in json.load(open(os.path.join(DIST, '_routes.json'))).get('exclude', []): fails.append(f'_routes.json does not exclude {ev_.MD_PATH}')
    except (OSError, ValueError):
        pass
    print(f'events log: {len(evs)} event(s), newest {evs[-1]["date"] if evs else "-"}, published as events.json + events.md')
    return fails


def refresh_note_checks():
    """Refreshed claims keep their words in step with their number: for every claim carrying a refresh_id (a number the
    weekly refresh re-observes), atlas/refresh.py note_drift() must find nothing (statement = its template re-rendered
    from value + quote, or, without a template, no number in the statement other than the value or one in the quote).
    The numbers mappings in atlas/refresh-sources.json pass mapping_problems() (template fields are quoted, verify links
    are https on the source's own domain), and every claim `verify` is {url: https://..., note}."""
    sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..')))
    import refresh
    fails = []
    srcs = json.load(open(os.path.join(HERE, '..', 'refresh-sources.json'), encoding='utf-8')).get('sources', {})
    maps = {}
    for slug, v in srcs.items():
        for m in v.get('numbers', []):
            fails += [f'refresh-sources.json: {p_}' for p_ in refresh.mapping_problems(m)]
            maps[m['id']] = (slug, m)
    snap = json.load(open(refresh.default_snapshot(), encoding='utf-8'))
    for e in snap.get('platforms', []):
        for c in e.get('claims', []):
            v = c.get('verify')
            if v is not None and (not isinstance(v, dict) or not str(v.get('url', '')).startswith('https://') or not (v.get('note') or '').strip()):
                fails.append(f'{e["slug"]}: claim verify must be {{url: https://..., note}}')
            rid = c.get('refresh_id')
            if not rid:
                continue
            slug, m = maps.get(rid, (None, None))
            if m is not None and slug != e['slug']:
                fails.append(f'{e["slug"]}: claim refresh_id {rid} belongs to {slug}')
                continue
            drift = refresh.note_drift(c, m)
            if drift:
                fails.append(f'{e["slug"]} [{rid}]: {drift}')
    return fails


def replications_checks(pages):
    """Replication counts (atlas/site/replications.py): atlas/data/replications.json is valid; every per-entry JSON carries
    `replications` exactly as published from that file (null without a record); platforms.json agrees; the card page shows the
    Replications block and its Markdown twin the '## Replications' section exactly when there is a record, with the same counts."""
    import replications as repl
    fails = []
    pdir = os.path.join(DIST, 'atlas', 'platforms')
    recs = {fn[:-5]: json.load(open(os.path.join(pdir, fn), encoding='utf-8')) for fn in sorted(os.listdir(pdir)) if fn.endswith('.json')}
    cards = repl.load()
    fails += repl.validate(cards, set(recs))
    for slug, r in recs.items():
        w = f'replications: {slug}'
        want = repl.published(cards, slug)
        if 'replications' not in r: fails.append(f'{w}: entry JSON lacks the replications field'); continue
        if r['replications'] != want: fails.append(f'{w}: entry JSON replications differs from atlas/data/replications.json')
        u = f'/atlas/platforms/{slug}/'
        h = open(pages[u], encoding='utf-8').read() if u in pages else ''
        mdp = os.path.join(DIST, 'atlas', 'platforms', slug, 'index.md')
        md = open(mdp, encoding='utf-8').read() if os.path.exists(mdp) else ''
        if ('id="h-repl"' in h) != bool(want): fails.append(f'{w}: card page Replications block out of step with the record')
        if ('## Replications' in md) != bool(want): fails.append(f'{w}: Markdown twin Replications section out of step')
        if want:
            line = repl.sentence(want)
            if html.escape(line) not in h: fails.append(f'{w}: card page counts differ from the record')
            if line not in md or want['commit'] not in md: fails.append(f'{w}: Markdown twin counts or commit differ from the record')
            for k in ('source_url', 'method_url', 'validate_run_url'):
                if html.escape(want[k]) not in h or want[k] not in md: fails.append(f'{w}: {k} missing from the card page or its Markdown twin')
    pl = json.load(open(os.path.join(DIST, 'atlas', 'platforms.json'), encoding='utf-8'))
    for r in pl.get('platforms') or []:
        if r.get('replications') != (recs.get(r['id']) or {}).get('replications'): fails.append(f'replications: platforms.json {r["id"]} differs from its entry file')
    print(f'replications: {sum(1 for r in recs.values() if r.get("replications"))} card(s) with replication counts')
    return fails


def reachability_checks(pages):
    """Reachability notes (atlas/site/reachability.py): atlas/data/reachability.json is valid and only names live cards; every per-entry JSON
    carries `reachability` exactly as published from that file (null without a record); platforms.json agrees; the card page shows the
    Reachability block and the stale / challenge-walled chip, and its Markdown twin the '## Reachability' section, exactly when there is a record."""
    import reachability as reach
    fails = []
    pdir = os.path.join(DIST, 'atlas', 'platforms')
    recs = {fn[:-5]: json.load(open(os.path.join(pdir, fn), encoding='utf-8')) for fn in sorted(os.listdir(pdir)) if fn.endswith('.json')}
    cards = reach.load()
    fails += reach.validate(cards, {s for s, r in recs.items() if r.get('status') == 'live'}, set(recs))
    for slug, r in recs.items():
        w = f'reachability: {slug}'
        want = reach.published(cards, slug) if r.get('status') == 'live' else None
        if 'reachability' not in r: fails.append(f'{w}: entry JSON lacks the reachability field'); continue
        if r['reachability'] != want: fails.append(f'{w}: entry JSON reachability differs from atlas/data/reachability.json')
        u = f'/atlas/platforms/{slug}/'
        h = open(pages[u], encoding='utf-8').read() if u in pages else ''
        mdp = os.path.join(DIST, 'atlas', 'platforms', slug, 'index.md')
        md = open(mdp, encoding='utf-8').read() if os.path.exists(mdp) else ''
        if ('id="h-reach"' in h) != bool(want): fails.append(f'{w}: card page Reachability block out of step with the record')
        if ('## Reachability' in md) != bool(want): fails.append(f'{w}: Markdown twin Reachability section out of step')
        if want:
            if f'chip reach {want["state"]}' not in h: fails.append(f'{w}: card page lacks the {want["label"]} chip')
            if html.escape(reach.sentence(want)) not in h or reach.sentence(want) not in md: fails.append(f'{w}: state line differs from the record')
            for x in want['reads']:
                if x['url'] not in md or x['observed_at'] not in md: fails.append(f'{w}: a read is missing from the Markdown twin')
    pl = json.load(open(os.path.join(DIST, 'atlas', 'platforms.json'), encoding='utf-8'))
    for r in pl.get('platforms') or []:
        if r.get('reachability') != (recs.get(r['id']) or {}).get('reachability'): fails.append(f'reachability: platforms.json {r["id"]} differs from its entry file')
    n = {s: sum(1 for r in recs.values() if (r.get('reachability') or {}).get('state') == s) for s in reach.STATES}
    print(f'reachability: {n["stale"]} stale, {n["challenge_walled"]} challenge-walled card(s)')
    return fails


def cards_v2_checks(pages):
    """Cards v2 (atlas/site/cards_v2.py, atlas/CURATION.md#cards-v2): the curated keys-and-books and first-task files are valid against
    the published claims; every per-entry JSON carries evidence_level / keys_and_books / first_task exactly as the rules compute them
    from its own claims (no drift), and every money/activity claim carries its evidence_level; platforms.json agrees; every card page
    and its Markdown twin show the ladder and the keys-and-books block, the first-task block exactly when there is a task, and the
    site-authored v2 wording is positive (no negative words)."""
    import cards_v2 as cv2
    fails = []
    pdir = os.path.join(DIST, 'atlas', 'platforms')
    recs = {}
    for fn in sorted(os.listdir(pdir)):
        if fn.endswith('.json'):
            recs[fn[:-5]] = json.load(open(os.path.join(pdir, fn), encoding='utf-8'))
    curated, tasks, evo = cv2.load_keys_books(), cv2.load_first_tasks(), cv2.load_evidence_overrides()
    fails += cv2.validate_keys_books(curated, recs)
    fails += cv2.validate_evidence_overrides(evo, recs)
    fails += cv2.validate_first_tasks(tasks, set(recs))
    for lv, (lid, label, desc) in cv2.LEVELS.items():
        for w in cv2.negative_hits(label + ' ' + desc): fails.append(f'cards v2: ladder level {lv} wording uses {w!r}')
    for f, (title, vals) in cv2.KB_FIELDS.items():
        for w in cv2.negative_hits(title + ' ' + ' '.join(vals.values())): fails.append(f'cards v2: keys-and-books {f} wording uses {w!r}')
    levels = Counter()
    for slug, r in recs.items():
        w = f'cards v2: {slug}'
        claims = r.get('claims') or []
        ov = cv2.card_overrides(r, evo)
        ev = cv2.card_evidence(r, evo)
        if r.get('evidence_level') != ev: fails.append(f'{w}: evidence_level {r.get("evidence_level")} != rule {ev}')
        levels[ev['level']] += 1
        for i, x in enumerate(claims):
            lv = cv2.claim_level(x, ov)
            if x.get('evidence_level') != lv: fails.append(f'{w}: claim {i} evidence_level {x.get("evidence_level")} != rule {lv}')
            if x.get('evidence_note') != cv2.claim_note(x, ov): fails.append(f'{w}: claim {i} evidence_note differs from evidence-levels.json')
        if r.get('keys_and_books') != cv2.keys_and_books(r, curated, evo): fails.append(f'{w}: keys_and_books differs from the rule')
        if r.get('first_task') != cv2.first_task(r, tasks): fails.append(f'{w}: first_task differs from first-tasks.json')
        for it in (r.get('keys_and_books') or {}).values():
            if it.get('state') == 'recorded' and not str(it.get('source_url') or '').startswith('http'): fails.append(f'{w}: recorded keys/books value without a source')
        u = f'/atlas/platforms/{slug}/'
        if u not in pages: fails.append(f'{w}: no card page'); continue
        h = open(pages[u], encoding='utf-8').read()
        m = re.search(r'<section class="cw-panel v2-panel".*?</section>', h, re.S)
        if not m: fails.append(f'{w}: card page lacks the evidence / keys-and-books panel'); continue
        panel = re.sub(r'<a [^>]*>Source:[^<]*</a>', '', m.group(0))
        for word in cv2.negative_hits(html.unescape(re.sub(r'<[^>]+>', ' ', panel))): fails.append(f'{w}: v2 panel uses negative wording {word!r}')
        if ('id="h-task"' in h) != bool(r.get('first_task')): fails.append(f'{w}: first-task block shown {"without" if r.get("first_task") else "with no"} task')
        mdp = os.path.join(DIST, 'atlas', 'platforms', slug, 'index.md')
        md = open(mdp, encoding='utf-8').read() if os.path.exists(mdp) else ''
        if not md: fails.append(f'{w}: Markdown twin missing'); continue
        for need in ('## Evidence ladder', '## Keys and books', '## Verified facts'):
            if need not in md: fails.append(f'{w}: Markdown twin lacks {need!r}')
        if ('## First task' in md) != bool(r.get('first_task')): fails.append(f'{w}: Markdown twin first task out of step')
        for x in claims:
            if x.get('evidence_note') and (html.escape(x['evidence_note']) not in h or x['evidence_note'] not in md):
                fails.append(f'{w}: curator evidence note missing from the card page or its Markdown twin')
        if r.get('md_url') != ORIGIN + u + 'index.md': fails.append(f'{w}: md_url {r.get("md_url")}')
    pl = json.load(open(os.path.join(DIST, 'atlas', 'platforms.json'), encoding='utf-8'))
    for r in pl.get('platforms') or []:
        one = recs.get(r['id']) or {}
        for k in ('evidence_level', 'keys_and_books', 'first_task', 'md_url'):
            if r.get(k) != one.get(k): fails.append(f'cards v2: platforms.json {r["id"]}.{k} differs from its entry file')
    kb_n = sum(1 for r in recs.values() if any(i.get('state') == 'recorded' for i in (r.get('keys_and_books') or {}).values()))
    print(f'cards v2: evidence levels {dict(sorted(((k or 0), v) for k, v in levels.items()))} (0 = not recorded yet), '
          f'{kb_n} cards with keys/books filled, {sum(1 for r in recs.values() if r.get("first_task"))} first task(s)')
    return fails


def main():
    global SHARE_LIVE, SHARE_ENTRY
    SHARE_LIVE, SHARE_ENTRY = _share_expectations()
    fails, pages, parsed = [], {}, {}
    for root, _, files in os.walk(DIST):
        for f in files:
            if f.endswith('.html'):
                rel = os.path.relpath(os.path.join(root, f), DIST)
                if TYPED_404_RE.match(rel.replace(os.sep, '/')):
                    continue  # typed 404 bodies (JSON / Markdown, typed_404_checks), not pages
                pages[url_of(rel)] = os.path.join(root, f)
    for u, fp in pages.items():
        size = os.path.getsize(fp)
        lim = MAX  # every page, list pages included (the A-Z list is paged too since #107; no special cap)
        if size > lim:
            fails.append(f'{u}: {size} bytes > {lim // 1024} KB')
        gz = len(gzip.compress(open(fp, 'rb').read()))
        if gz > MAX_GZ:
            fails.append(f'{u}: {gz} bytes gzipped > {MAX_GZ // 1024} KB')
        p = P(); p.feed(open(fp, encoding='utf-8').read()); parsed[u] = p
    titles, descs = Counter(), Counter()
    og_seen, og_sizes = {}, []
    jsonld_blocks = 0
    for u, new in OLD_LEGAL.items():
        if u == new:
            continue
        if u not in parsed:
            fails.append(f'missing redirect stub {u}'); continue
        p = parsed[u]; h = open(pages[u], encoding='utf-8').read()
        if 'noindex' not in (p.meta.get('robots') or ''): fails.append(f'{u}: stub not noindex')
        if p.canon != ORIGIN + new: fails.append(f'{u}: stub canonical {p.canon} != {ORIGIN + new}')
        if f'http-equiv="refresh" content="0; url={new}"' not in h: fails.append(f'{u}: stub lacks meta refresh to {new}')
    red = open(os.path.join(DIST, '_redirects')).read() if os.path.exists(os.path.join(DIST, '_redirects')) else ''
    for u, new in OLD_LEGAL.items():
        if u != new and (f'{u} {new} 301' not in red or f'{u.rstrip("/")} {new} 301' not in red):
            fails.append(f'_redirects lacks 301 for {u}')
    for u in OLD_LEGAL:
        parsed.pop(u, None); pages.pop(u, None)
    fails += removed_checks(parsed, pages)
    sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
    import trust_check  # who may remove/restore and the decision record (atlas/data/trust-roles.json, removed.json `decisions`)
    tf = trust_check.main(); fails += tf
    print(f"trust decisions: {len((json.load(open(REMOVED)) if os.path.exists(REMOVED) else {}).get('decisions') or [])} recorded, actors from trust-roles.json" + ('' if not tf else f' ({len(tf)} problems)'))
    for r in load_removed():  # noindex stubs: outside the indexable-page rules and the sitemap
        parsed.pop(f"/atlas/platforms/{r['slug']}/", None); pages.pop(f"/atlas/platforms/{r['slug']}/", None)
    for root, _, files in os.walk(DIST):
        for f in files:
            if f.endswith(('.html', '.json', '.xml', '.txt', '.js', '.css', '.svg', '.md')) or f in ('_headers', '_redirects'):
                fp = os.path.join(root, f)
                txt = open(fp, encoding='utf-8', errors='replace').read()
                m = FORBIDDEN_ANY.search(txt.replace(CFG0['contact']['general'], ''))
                if m: fails.append(f'forbidden text {m.group(0)!r} in {os.path.relpath(fp, DIST)}: …{txt[max(0, m.start() - 40):m.end() + 40]}…')
    for u in [PRIV_URL, TERMS_URL, '/atlas/about/', '/atlas/decisions/', '/atlas/', '/404.html', '/', '/about/', '/stats/']:
        if u in pages:
            txt = open(pages[u], encoding='utf-8').read()
            copy = re.sub(r'<script.*?</script>|<style.*?</style>', '', txt, flags=re.S)
            m = FORBIDDEN_SITE_TEXT.search(copy)
            if m: fails.append(f'{u}: operator location wording {m.group(0)!r}')
            if u in (PRIV_URL, TERMS_URL, '/', '/about/', '/atlas/about/', '/atlas/decisions/', '/stats/'):
                m = FORBIDDEN_COMMONWORLD_COPY.search(copy)
                if m: fails.append(f'{u}: Commonworld-authored copy mentions {m.group(0)!r}')
    for u, p in parsed.items():
        is404 = u == '/404.html'
        if p.lang != 'en': fails.append(f'{u}: lang={p.lang}')
        if not p.title.strip(): fails.append(f'{u}: no title')
        if not p.meta.get('description'): fails.append(f'{u}: no meta description')
        rob = p.meta.get('robots', '')
        if is404:
            if 'noindex' not in rob: fails.append('404 not noindex')
        else:
            if not rob.startswith('index,follow'): fails.append(f'{u}: robots={rob}')
            if p.canon != ORIGIN + u: fails.append(f'{u}: canonical {p.canon}')
            for k in ('og:title', 'og:description', 'og:image', 'og:url', 'twitter:card'):
                if not p.meta.get(k): fails.append(f'{u}: missing {k}')
            titles[p.title] += 1; descs[p.meta.get('description')] += 1
            # --- Open Graph image: unique per page, exists, 1200x630 PNG, small
            img = p.meta.get('og:image') or ''
            if p.meta.get('twitter:site') != X_HANDLE: fails.append(f'{u}: twitter:site={p.meta.get("twitter:site")} != {X_HANDLE}')
            if p.meta.get('twitter:card') != 'summary_large_image': fails.append(f'{u}: twitter:card={p.meta.get("twitter:card")}')
            if p.meta.get('twitter:image') != img: fails.append(f'{u}: twitter:image != og:image')
            if (p.meta.get('og:image:width'), p.meta.get('og:image:height')) != ('1200', '630'): fails.append(f'{u}: og:image width/height')
            if not p.meta.get('og:image:alt'): fails.append(f'{u}: no og:image:alt')
            if not img.startswith(ORIGIN + '/atlas/og/'):
                fails.append(f'{u}: og:image not a per-page image: {img}')
            else:
                if img in og_seen: fails.append(f'{u}: og:image shared with {og_seen[img]}')
                og_seen[img] = u
                fp = os.path.join(DIST, img[len(ORIGIN):].split('?')[0].lstrip('/'))
                if not os.path.isfile(fp):
                    fails.append(f'{u}: og:image missing on disk {fp}')
                else:
                    head = open(fp, 'rb').read(24)
                    if head[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', head[16:24]) != (1200, 630):
                        fails.append(f'{u}: og:image is not a 1200x630 PNG')
                    sz = os.path.getsize(fp); og_sizes.append(sz)
                    if sz > MAX_OG: fails.append(f'{u}: og:image {sz} bytes > {MAX_OG // 1024} KB')
            # --- share bar: links carry the canonical URL
            need_share = SHARE_ON and (is_card_url(u) or u in ('/atlas/', '/', '/about/'))
            if need_share and not p.share_bars: fails.append(f'{u}: no share bar')
            for burl, btext in p.share_bars:
                if burl != p.canon: fails.append(f'{u}: share bar url {burl} != canonical')
                want_txt = {'/': 'Commonworld — A shared world for humans and agents',
                            '/about/': 'About Commonworld — A shared world for humans and agents',
                            '/atlas/': f'Atlas of Agent Platforms: {SHARE_LIVE} places where AI agents work and get paid',
                            '/atlas/earn/': 'Where AI agents get paid — Commonworld Atlas'}.get(u) or SHARE_ENTRY.get(u)
                if not btext or btext != want_txt: fails.append(f'{u}: share text {btext!r} != {want_txt!r}')
            enc = quote(p.canon or '', safe='')
            for kind, href, label in p.shares:
                if not label: fails.append(f'{u}: share button {kind} without aria-label')
                if href is None:
                    if kind not in ('copy', 'native'): fails.append(f'{u}: share {kind} without href')
                elif enc not in href and p.canon not in unquote(href):
                    fails.append(f'{u}: share link {kind} lacks canonical URL')
            types = []
            for block in p.ld:
                try:
                    obj = json.loads(block); jsonld_blocks += 1; types.append(obj.get('@type'))
                except Exception as ex:
                    fails.append(f'{u}: JSON-LD parse error {ex}')
            if 'BreadcrumbList' not in types: fails.append(f'{u}: no BreadcrumbList')
        for tag, href, rel in p.links:
            if href.startswith(('http://', 'https://')):
                if href.startswith(ORIGIN) or tag != 'a':
                    continue
                if href in OFFICIAL_URLS and 'me' in rel.split():
                    if 'noopener' not in rel.split(): fails.append(f'{u}: official link without noopener: {href}')
                    continue
                need = {'sponsored', 'nofollow'} if 'sponsored' in rel else {'nofollow', 'noopener'}
                if not need <= set(rel.split()): fails.append(f'{u}: external link without rel {need}: {href}')
                continue
            if href.startswith(('mailto:', 'data:')) or href.startswith('#') and href[1:] in p.ids:
                continue
            if href.startswith('#'):
                fails.append(f'{u}: missing anchor {href}'); continue
            path, _, frag = href.split('?', 1)[0].partition('#')
            if not path.startswith('/'):
                fails.append(f'{u}: relative link {href}'); continue
            fs = os.path.join(DIST, path.lstrip('/'))
            if path.endswith('/'):
                fs = os.path.join(fs, 'index.html')
            elif os.path.isdir(fs):
                fails.append(f'{u}: link without trailing slash {href}'); continue
            if path == '/' and not os.path.exists(fs):
                continue  # Commonworld home: owned by the main site, placeholder for now
            if not os.path.isfile(fs):
                fails.append(f'{u}: broken link {href}'); continue
            if frag and path in parsed and frag not in parsed[path].ids:
                fails.append(f'{u}: broken fragment {href}')
    idx = open(pages['/atlas/'], encoding='utf-8').read()
    grid = idx[idx.index('id="grid"'):idx.index('id="f-empty"')]
    seq = re.findall(r'<article class="cw-card[^"]*"( data-ad-card)?', grid)
    ads = [i for i, s in enumerate(seq) if s]
    want_ads = [12 * k + (k - 1) for k in range(1, len([s for s in seq if not s]) // 12 + 1)]
    if ads != want_ads: fails.append(f'native ad positions {ads[:5]} != {want_ads[:5]}')
    if 'class="cw-tagcloud"' not in idx or 'cw-tags-more' not in idx: fails.append('tag shelf missing on index')
    if 'Click tags, statuses or tabs to narrow the list. Tags combine with AND.' not in idx: fails.append('tag hint line missing')
    for k in ('cw-menu', 'cw-theme', 'aria-label="Commonworld home"'):
        if k not in idx: fails.append(f'index missing {k}')
    # --- legal pages, footer links, cross-product navigation
    CFG = json.load(open(os.path.join(HERE, 'site-config.json')))
    product = CFG['site'].get('product_url') or '/'
    if (CFG.get('legal') or {}).get('operator') != 'Commonworld':
        fails.append('site-config legal.operator must be Commonworld')
    for lp in (PRIV_URL, TERMS_URL):
        if lp not in parsed:
            fails.append(f'missing legal page {lp}'); continue
        lpp = parsed[lp]
        if not any('"WebPage"' in blk for blk in lpp.ld): fails.append(f'{lp}: no WebPage JSON-LD')
        txt = open(pages[lp], encoding='utf-8').read()
        if 'is run by <b>Commonworld</b>' not in txt:
            fails.append(f'{lp}: operator is not identified as Commonworld')
        if 'Last updated' not in txt: fails.append(f'{lp}: no Last updated')
        has_draft = 'This policy is a draft' in txt or 'legal-draft' in txt
        if CFG.get('legal_draft') and not has_draft: fails.append(f'{lp}: draft note missing')
        if not CFG.get('legal_draft') and has_draft: fails.append(f'{lp}: draft note present but legal_draft is false (final text)')
        if 'noindex' in (lpp.meta.get('robots') or ''): fails.append(f'{lp}: legal page is noindex')
        if 'Applies to Commonworld and all its sections, including the Atlas.' not in txt: fails.append(f'{lp}: scope line missing')
        if 'id="planned">Not available yet</h2>' not in txt: fails.append(f'{lp}: "Not available yet" section missing')
        if 'id="recovery"' not in txt or 'id="links-check"' not in txt: fails.append(f'{lp}: account recovery / link check section missing')
        if 'No accounts' in txt or 'no accounts' in txt or 'None of these exist yet' in txt: fails.append(f'{lp}: still has the pre-launch "no accounts" text')
        want_h1 = '<h1>Commonworld Privacy Policy</h1>' if lp == PRIV_URL else '<h1>Commonworld Terms of Use</h1>'
        if want_h1 not in txt: fails.append(f'{lp}: lacks {want_h1}')
        if lp == PRIV_URL:
            for need in (CFG['contact']['privacy'], 'data protection authority in your country of residence', 'Data Privacy Framework', 'cw-consent', 'cw-theme', 'cw-ann-dismissed', '_ga',
                         'Cloudflare, Inc.', 'Zoho', 'Standard Contractual Clauses', 'Art. 6(1)(a)', 'Art. 6(1)(f)', 'withdraw it at any time', 'Share buttons',
                         '__Host-cw_session', '<code>__Host-cw_oauth</code></td>', 'Commonworld sets only two cookies itself', 'POST /v1/me/apps/{id}/revoke', 'Google Safe Browsing', 'MetaMask eth-phishing-detect', 'ScamSniffer scam-database', 'CERT Polska Warning List',
                         'FxTwitter', 'recovery code', 'id="ai-bots"', '400 days', '90 days', '30 days'):
                if need not in txt: fails.append(f'privacy page lacks {need!r}')
            if 'is the only cookie Commonworld sets itself' in txt: fails.append('privacy page still says cw_session is the only cookie (there are two: __Host-cw_session and __Host-cw_oauth)')
    for u, p in parsed.items():
        for tag, href, rel in p.links:
            if tag in ('script', 'img') and re.match(r'(https?:)?//', href or ''):
                fails.append(f'{u}: third-party {tag} {href} (Privacy Policy says no third-party scripts/images before consent)')
            if tag == 'link' and re.match(r'(https?:)?//', href or '') and rel not in ('canonical', 'alternate'):
                fails.append(f'{u}: third-party <link rel={rel}> {href}')
    side_re = re.compile(r'<aside class="cw-side".*?</aside>', re.S)
    for u, fp in pages.items():
        h = open(fp, encoding='utf-8').read()
        foot = h[h.find('<footer class="cw-foot"'):]
        if f'href="{PRIV_URL}">Privacy<' not in foot or f'href="{TERMS_URL}">Terms<' not in foot:
            fails.append(f'{u}: footer lacks Privacy/Terms links')
        for url_, lab_ in ((X_URL, 'X'), (REPO_URL, 'GitHub')):
            if not re.search(rf'<a class="cw-foot-official" href="{re.escape(url_)}" rel="me noopener"><svg[^>]*>.*?</svg><span>{lab_}</span></a>', foot):
                fails.append(f'{u}: footer lacks official {lab_} link (icon + label, rel="me noopener")')
        m = side_re.search(h)
        side = m.group(0) if m else ''
        xi, di = side.find('data-xnav="Commonworld"'), side.find('>Directions<')
        if xi < 0 or di < 0 or xi > di: fails.append(f'{u}: sidebar Commonworld item not above Directions')
        elif f'href="{product}" data-xnav="Commonworld"' not in side: fails.append(f'{u}: sidebar Commonworld href != product_url')
        ai = side.find('<nav class="cw-nav cw-xsub" aria-label="About Commonworld"><a href="/about/"')
        if ai < 0 or not (xi < ai < di): fails.append(f'{u}: sidebar "About" (/about/) not right under the Commonworld item')
        if '>How the Atlas works<' not in side or 'About &amp; method' in side: fails.append(f'{u}: sidebar Atlas link is not "How the Atlas works"')
        if 'href="/about/">About Commonworld</a>' not in foot or 'href="/atlas/about/">How the Atlas works</a>' not in foot:
            fails.append(f'{u}: footer lacks About Commonworld / How the Atlas works links')
        if f'class="cw-iconbtn cw-product" href="{product}" aria-label="Commonworld home"' not in h:
            fails.append(f'{u}: home icon href != product_url {product}')
        if 'class="cw-consent"' in h and f'href="{PRIV_URL}">Privacy</a></p>' not in h:
            fails.append(f'{u}: cookie banner does not link to {PRIV_URL}')
    # --- Commonworld landing (/)
    if '/' not in parsed:
        fails.append('missing landing page / (dist/index.html)')
    else:
        lp_, lh = parsed['/'], open(pages['/'], encoding='utf-8').read()
        if lp_.canon != ORIGIN + '/': fails.append(f'/: canonical {lp_.canon} != {ORIGIN}/')
        if 'noindex' in (lp_.meta.get('robots') or ''): fails.append('/: landing is noindex')
        for need in ('<h1 id="landing-title">Commonworld</h1>', 'A shared world for humans and agents', 'The platform is live at commonworld.one;',
                     'class="cw-btn cw-btn-primary landing-cta" href="/atlas/"', 'cw-mark-light.svg', 'cw-mark-dark.svg', 'class="cw-consent"', 'Official channels:', f'href="{X_URL}" rel="me noopener"',
                     '<a aria-current="page" href="' + (CFG['site'].get('product_url') or '/') + '" data-xnav="Commonworld"', '"WebSite"'):
            if need not in lh: fails.append(f'/: landing lacks {need!r}')
        if (lp_.meta.get('og:image') or '').split('?')[0] != ORIGIN + '/atlas/og/page-home.png': fails.append('/: og:image is not its own page-home.png')
        if str(len(json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms'])) not in lh: fails.append('/: Atlas entry count missing')
        if CFG['site'].get('product_url', '/').rstrip('/') not in ('', ORIGIN): fails.append('site.product_url does not point to the landing')
        if (CFG['site'].get('home_url') or '/') != '/': fails.append('site.home_url != /')
        if f'"@type":"Organization","name":"Commonworld","url":"{ORIGIN}/","sameAs":["{X_URL}","{GITHUB_ORG_URL}"]' not in lh:
            fails.append('/: no Organization JSON-LD with sameAs [X, GitHub]')
    # --- brand drift test: the fixed subtitle (Michael, 2026-10-15, reconfirmed 2026-10-18) appears verbatim, right under the motto
    for where_, fp_ in (('/ (landing)', os.path.join(DIST, 'index.html')), ('/about/', os.path.join(DIST, 'about', 'index.html')),
                        ('/llms.txt', os.path.join(DIST, 'llms.txt')), ('README.md', os.path.join(HERE, '..', '..', 'README.md'))):
        if not os.path.exists(fp_): fails.append(f'brand subtitle: {where_} missing ({fp_})'); continue
        if CW_SUBTITLE not in open(fp_, encoding='utf-8').read(): fails.append(f'brand subtitle: {where_} lacks the verbatim subtitle {CW_SUBTITLE!r}')
    if CFG['site'].get('subtitle') != CW_SUBTITLE: fails.append('site-config.json site.subtitle drifted from the fixed brand subtitle')
    for f_ in ('llms.txt', 'llms-full.txt'):
        fp_ = os.path.join(DIST, f_)
        if os.path.exists(fp_) and f'Official channels: site {ORIGIN}/ · X {X_URL} ({X_HANDLE}) · GitHub {REPO_URL}' not in open(fp_, encoding='utf-8').read():
            fails.append(f'/{f_}: lacks the Official channels line')
    # --- About Commonworld (/about/)
    if '/about/' not in parsed:
        fails.append('missing /about/ (About Commonworld)')
    else:
        ap_, ah = parsed['/about/'], open(pages['/about/'], encoding='utf-8').read()
        main_ = ah[ah.find('<main'):ah.find('</main>')]
        if ap_.canon != ORIGIN + '/about/': fails.append(f'/about/: canonical {ap_.canon}')
        if 'noindex' in (ap_.meta.get('robots') or ''): fails.append('/about/: noindex')
        if (ap_.meta.get('og:image') or '').split('?')[0] != ORIGIN + '/atlas/og/page-cw-about.png': fails.append('/about/: og:image is not page-cw-about.png')
        n_snap = len(json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))['platforms'])
        for need in ('<h1>About Commonworld</h1>', 'A shared world for humans and agents', 'live side by side as citizens', 'work you can verify speaks louder than a CV',
                     'The Commonworld platform is live at', 'citizen accounts', 'MCP server', 'commonworld.one/mcp', '(planned)',
                     '<i>Sponsored</i>', 'sources and dates', 'Corrections welcome', 'Privacy-light by default',
                     'href="/atlas/"', 'href="/atlas/about/"', f'href="{PRIV_URL}"', f'href="{TERMS_URL}"', 'href="https://github.com/commonworld-one/commonworld/issues"',
                     f"mailto:{CFG0['contact']['general']}", f'{n_snap:,}', 'aria-current="page">About</a>'):
            if need not in ah: fails.append(f'/about/: lacks {need!r}')
        for bad in re.findall(r'sign up|signup|join now|log in|register now|available now|download the app', main_, re.I):
            fails.append(f'/about/: claims a feature that does not exist yet ({bad!r})')
        if re.search(r'coming soon|not launched|not yet live', main_, re.I):
            fails.append('/about/: still says the platform is not live (it is live since 2026-10-20)')
    # accounts exist since v1: the pre-launch "no accounts" wording must not come back on any About page or in TRUST.md
    for pg_ in ('/about/', '/atlas/about/'):
        if pg_ in pages and re.search(r'\bno accounts\b', open(pages[pg_], encoding='utf-8').read(), re.I):
            fails.append(f'{pg_}: still has the pre-launch "no accounts" text')
    _trust = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'TRUST.md')
    if os.path.exists(_trust) and re.search(r'planned, with writing from the app|\bno accounts\b', open(_trust, encoding='utf-8').read(), re.I):
        fails.append('TRUST.md: link checks in posts are live in v1, but the text still says planned / no accounts')
        lds = [json.loads(x) for x in ap_.ld]
        abt = next((x for x in lds if x.get('@type') == 'AboutPage'), None)
        if not abt: fails.append('/about/: no AboutPage JSON-LD')
        else:
            org = abt.get('mainEntity') or {}
            if org.get('@type') != 'Organization' or org.get('name') != 'Commonworld' or org.get('url') != ORIGIN + '/':
                fails.append(f'/about/: Organization JSON-LD {org}')
            if org.get('sameAs') != [X_URL, GITHUB_ORG_URL]: fails.append(f'/about/: Organization sameAs {org.get("sameAs")}')
            if re.search(r'address|founder|employee|"person"', json.dumps(abt), re.I): fails.append('/about/: JSON-LD carries address/person data')
        if ah.count('class="cw-share') < 1: fails.append('/about/: no share bar')
    atl_about = open(pages['/atlas/about/'], encoding='utf-8').read()
    xr = atl_about.find('class="about-xref"')
    if xr < 0 or 'href="/about/">Read about Commonworld</a>' not in atl_about[xr:xr + 400] or xr > atl_about.find('<h1>'):
        fails.append('/atlas/about/: no top line linking /about/')
    about = atl_about
    for need in ('<h1>How the Atlas works</h1>', 'open, source-checked catalog', 'downloadable JSON', 'coordinating agent', 'written protocol',
                 'not confirmed; they are labelled as such', 'We plan to re-check the whole catalog weekly', '15 Oct 2026 census'):
        if need not in about: fails.append(f'about page lacks {need!r}')
    for bad in ('disagreements go to a human', 'Outbound source links are marked nofollow', 'open JSON', '2026-10-15 census'):
        if bad in about: fails.append(f'about page still has {bad!r}')
    if CFG['contact']['general'] not in about: fails.append('about page lacks contact.general')
    _pv = open(pages[PRIV_URL], encoding='utf-8').read()
    if CFG['contact']['general'] != CFG['contact']['privacy'] and CFG['contact']['general'] in _pv: fails.append('privacy page shows contact.general; privacy page must use contact.privacy only')
    # share bar sits in the platform header (entry-head), once
    for u, p in parsed.items():
        if is_card_url(u) and SHARE_ON:
            h = open(pages[u], encoding='utf-8').read()
            head = h[h.find('<header class="entry-head"'):h.find('</header>', h.find('<header class="entry-head"'))]
            if 'cw-share cw-share-head' not in head: fails.append(f'{u}: share bar not in header')
            if len(p.share_bars) != 1: fails.append(f'{u}: {len(p.share_bars)} share bars')
    fails += [f'duplicate title x{n}: {t}' for t, n in titles.items() if n > 1]
    fails += [f'duplicate description x{n}: {d[:60]}' for d, n in descs.items() if n > 1]
    sm_path = os.path.join(DIST, 'atlas', 'sitemap.xml')
    sm_root = os.path.join(DIST, 'sitemap.xml')
    locs = {el.text for el in ET.parse(sm_path).getroot().iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')}
    root_locs = {el.text for el in ET.parse(sm_root).getroot().iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')} if os.path.exists(sm_root) else set()
    if any(not l.startswith(ORIGIN + '/atlas/') for l in locs): fails.append('atlas sitemap lists URLs outside /atlas/')
    for old in OLD_LEGAL:
        if ORIGIN + old in locs | root_locs: fails.append(f'sitemap still lists old {old}')
    locs |= root_locs
    want = {ORIGIN + u for u in parsed if u != '/404.html'}
    if locs != want:
        fails.append(f'sitemap mismatch: missing {sorted(want - locs)[:5]} extra {sorted(locs - want)[:5]}')
    nolm = sum(1 for el in ET.parse(sm_path).getroot() if el.find('{http://www.sitemaps.org/schemas/sitemap/0.9}lastmod') is None)
    robots = open(os.path.join(DIST, 'robots.txt')).read()
    if f'Sitemap: {ORIGIN}/atlas/sitemap.xml' not in robots: fails.append('robots.txt lacks sitemap')
    if f'Sitemap: {ORIGIN}/sitemap.xml' not in robots: fails.append('robots.txt lacks the site-level sitemap')
    fails += growth_guard(locs, update='--update-baseline' in sys.argv)
    fails += paged_record_checks(update='--update-baseline' in sys.argv)
    fails += typed_404_checks()
    try:
        json.load(open(os.path.join(DIST, 'atlas', 'data', 'snapshot.json')))
    except Exception as ex:
        fails.append(f'snapshot.json: {ex}')
    # machine-readable files: timestamps are ISO 8601 UTC, money-flow items carry a basis
    for root, _, files in [w for d in ('atlas', 'api') for w in os.walk(os.path.join(DIST, d))]:
        for fn in files:
            if fn.endswith('.json'):
                raw = open(os.path.join(root, fn), encoding='utf-8').read()
                if re.search(r'"(observed_at|verified_at|last_checked|generated_at)":\s*"(?!\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z")[^"]', raw):
                    fails.append(f'{fn}: timestamp not ISO 8601 UTC')
    for r in json.load(open(os.path.join(DIST, 'atlas', 'platforms.json')))['platforms']:
        if any('basis' not in f for f in r.get('money_flow') or []):
            fails.append(f"platforms.json {r['id']}: money_flow item without basis")
    fails += dataset_checks(parsed)
    fails += dataset_haspart_checks(parsed)
    fails += safety_report_checks(parsed)
    fails += decisions_checks(parsed, pages, locs)
    fails += events_checks()
    fails += refresh_note_checks()
    fails += markdown_twin_checks(pages)[0]
    fails += cards_v2_checks(pages)
    fails += replications_checks(pages)
    fails += reachability_checks(pages)
    fails += stats_checks(parsed, pages, locs)
    fails += badge_checks(parsed, pages, locs)
    fails += api_checks(parsed, locs)
    fails += paged_list_checks(parsed, pages, locs)
    fails += az_list_checks(parsed, pages, locs)
    fails += a11y_checks(pages)
    fails += csp_checks(pages)
    fails += closure_checks(pages)
    fails += screens_checks(pages)
    biggest = max(pages, key=lambda u: os.path.getsize(pages[u]))
    print(f'pages: {len(pages)} html ({len(want)} indexable + 404); JSON-LD blocks parsed: {jsonld_blocks}; '
          f'internal links checked: {sum(len(p.links) for p in parsed.values())}; sitemap URLs: {len(locs)} ({nolm} without lastmod); '
          f'largest page: {biggest} {os.path.getsize(pages[biggest]) // 1024} KB ({len(gzip.compress(open(pages[biggest], "rb").read())) // 1024} KB gzipped); '
          f'native ad cards on index: {len(ads)}; OG images: {len(og_sizes)} unique, '
          f'max {max(og_sizes, default=0) // 1024} KB, avg {sum(og_sizes) // max(len(og_sizes), 1) // 1024} KB, total {sum(og_sizes) // 1024} KB; '
          f'share buttons: {sum(len(p.shares) for p in parsed.values())} on {sum(1 for p in parsed.values() if p.share_bars)} pages')
    if fails:
        print(f'FAIL ({len(fails)}):'); [print('  -', f) for f in fails[:80]]
        sys.exit(1)
    print('ALL CHECKS PASSED')


if __name__ == '__main__':
    main()
