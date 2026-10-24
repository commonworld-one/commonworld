#!/usr/bin/env python3
"""Optional browser smoke test (needs Playwright + Chromium; a system Chromium works too: CHROMIUM=/path or
/usr/bin/chromium is picked up automatically).

Covers: HTTP 404 / trailing-slash redirect; light default theme + toggle + persistence (no flash: theme set
before paint); icon buttons (home, theme, menu); announcement dismissal per id; consent banner (gtag.js only
after Accept); instant search incl. claim statements; status / type / feature / tag / category filters combined
with AND and live counts; stats tiles and legend as filters; tag shelf expander; native sponsored cards after
every 12 visible cards (re-inserted on filter); sort; URL state; mobile drawer; platform page sponsored slot + screenshot order; screenshot previews decode;
legal pages + cross-product navigation (sidebar Commonworld item, home icon, footer links, banner link);
About Commonworld /about/ (H1, motto, live count, sidebar About under Commonworld, links to the Atlas method, banner, share,
theme, mobile; ABOUT_SHOT=path saves a desktop light screenshot); landing page / (H1, motto, CTA to /atlas/, stats, banner, share, theme, mobile; SHOTS_DIR=... saves screenshots);
share buttons (placement in the platform header card, canonical links, keyboard copy, GA4 'share' event only with consent, native Web Share on mobile).
Sidebar hide/show toggle (desktop): aria state, keyboard, persistence across reload, applied before atlas.js (no layout shift), mobile drawer unchanged, no horizontal scroll at 390/1280.

    python3 atlas/site/tools/smoke_test.py
"""
import os, sys, threading, http.server, urllib.request, urllib.error
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import serve  # noqa: E402
import json  # noqa: E402
_SNAP = json.load(open(os.path.join(HERE, '..', 'dist', 'atlas', 'data', 'snapshot.json')))['platforms']  # counts follow the built data
N_ALL, N_CLOSED = len(_SNAP), sum(1 for c in _SNAP if c.get('status') == 'closed')
N_PAY = sum(1 for c in _SNAP if c.get('category') == 'payments')
PAGE_SIZE = 50  # cards per list page (D4)
N_PAGE1, N_PAGES = min(PAGE_SIZE, N_ALL), max(1, -(-N_ALL // PAGE_SIZE))
# highest page ever built (atlas/data/paged-lists.json, owner decision Q8): pages up to it answer 301 to the last page when the
# list got shorter, so the 404 probe is the first number that never existed (Codex review of #107)
_EVER = max(N_PAGES, json.load(open(os.path.join(HERE, '..', '..', 'data', 'paged-lists.json')))['lists'].get('/atlas/', 0))
N_NEVER = _EVER + 1
PRODUCT = json.load(open(os.path.join(HERE, '..', 'site-config.json')))['site'].get('product_url') or '/'
from playwright.sync_api import sync_playwright  # noqa: E402

serve.H.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), serve.H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
B = f'http://127.0.0.1:{srv.server_address[1]}'
ok = True


def check(name, cond):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + name)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


op = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
for url, code in [('/atlas/nope/', 404), ('/atlas/about', 301), ('/atlas/about/', 200), ('/atlas/data/search-index.json', 200),
                  ('/privacy', 301), ('/privacy/', 200), ('/terms/', 200), ('/atlas/privacy/', 200), ('/atlas/terms/', 200), ('/sitemap.xml', 200), ('/', 200), ('/about/', 200), ('/about', 301),
                  ('/atlas/page/2/', 200), ('/atlas/page/1/', 301), ('/atlas/page/1', 301), (f'/atlas/page/{N_NEVER}/', 404), (f'/atlas/platforms/page/{N_NEVER}/', 404), ('/atlas/page/0/', 404),
                  ('/atlas/index.md', 200), ('/atlas/page/2/index.md', 200), ('/api/v1/atlas/page/1.json', 200), (f'/api/v1/atlas/page/{N_NEVER}.json', 404), (f'/api/v1/atlas/platforms/page/{N_NEVER}.json', 404),
                  ('/api/v1/index.json', 200), ('/api/v1/openapi.json', 200), ('/api/v1/atlas/platforms/bountybook.json', 200), ('/api/v1/atlas/platforms/nope.json', 404), ('/atlas/api/', 200)]:
    try:
        r = op.open(B + url); got = r.status
    except urllib.error.HTTPError as ex:
        got = ex.code
    check(f'HTTP {url} -> {code}', got == code)
_last = '/atlas/' if N_PAGES == 1 else f'/atlas/page/{N_PAGES}/'
for n in range(N_PAGES + 1, _EVER + 1):  # pages that existed before and are past the end now: 301 to the last page
    for url, to in [(f'/atlas/page/{n}/', _last), (f'/atlas/page/{n}/index.md', _last + 'index.md'), (f'/api/v1/atlas/page/{n}.json', f'/api/v1/atlas/page/{N_PAGES}.json')]:
        try:
            r = op.open(B + url); got, loc = r.status, r.headers.get('location')
        except urllib.error.HTTPError as ex:
            got, loc = ex.code, ex.headers.get('location')
        check(f'HTTP {url} (published before) -> 301 {to}', got == 301 and (loc or '').endswith(to))

VIS = "Array.from(document.querySelectorAll('#grid .cw-card[data-slug]')).filter(c=>!c.hidden).length"
ADS_OK = """(() => { const k = Array.from(document.querySelectorAll('#grid > .cw-card')).filter(c => !c.hidden);
  const vis = k.filter(c => c.dataset.slug).length, ads = k.filter(c => c.hasAttribute('data-ad-card'));
  const okPos = ads.every(a => { const i = k.indexOf(a); return (i + 1) % 13 === 0; });
  return [vis, ads.length, okPos && ads.length === Math.floor(vis / 12)]; })()"""


CSP_ERRORS = []  # every page of every context: console CSP violations + securitypolicyviolation events (serve.py sends the real CSP)
CSP_HOOK = ("document.addEventListener('securitypolicyviolation',function(e){console.error('CSP-VIOLATION '+e.violatedDirective+' '+(e.blockedURI||'inline')+' '+(e.sourceFile||'')+':'+(e.lineNumber||0))});")


def _watch(pg):
    pg.on('console', lambda m: CSP_ERRORS.append(f'{pg.url}: {m.text[:200]}')
          if m.type == 'error' and ('Content Security Policy' in m.text or 'CSP-VIOLATION' in m.text) else None)


def wait_js(pg, expr, timeout=10.0):
    """Poll a JS expression with page.evaluate (DevTools protocol, not page eval): page.wait_for_function compiles its
    predicate inside the page, which the strict CSP (no 'unsafe-eval') rightly refuses."""
    import time
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(expr):
            return True
        pg.wait_for_timeout(100)
    raise TimeoutError(f'wait_js timed out: {expr[:80]}')


def launch(p):
    exe = os.environ.get('CHROMIUM') or ('/usr/bin/chromium' if os.path.exists('/usr/bin/chromium') else None)
    br = p.chromium.launch(**({'executable_path': exe} if exe else {}))
    plain = br.new_context

    def new_context(*a, **k):
        ctx = plain(*a, **k)
        ctx.add_init_script(CSP_HOOK)
        ctx.on('page', _watch)
        return ctx
    br.new_context = new_context
    return br


with sync_playwright() as p:
    br = launch(p)
    ctx = br.new_context(color_scheme='dark', viewport={'width': 1440, 'height': 1000})
    ga = []
    ctx.route('**/www.googletagmanager.com/**', lambda route: (ga.append(route.request.url), route.fulfill(status=200, body='')))
    pg = ctx.new_page()
    pg.goto(B + '/atlas/')
    check('light theme is the default (even with OS dark)', pg.evaluate("document.documentElement.dataset.theme") == 'light')
    check(f'icon buttons: home links to product_url ({PRODUCT}), theme toggle, no census pill', pg.get_attribute('.cw-top a[aria-label="Commonworld home"]', 'href') == PRODUCT
          and pg.is_visible('.cw-theme') and not pg.is_visible('.cw-menu') and pg.locator('text=census').count() == 0)
    pg.click('.cw-theme'); pg.reload()
    check('theme persisted after reload (dark)', pg.evaluate("document.documentElement.dataset.theme") == 'dark')
    check('consent banner visible, no gtag before choice', pg.is_visible('.cw-consent') and not ga)
    check('consent banner links to the Privacy page', pg.get_attribute('.cw-consent a', 'href') == '/privacy/')
    check('sidebar: "Commonworld" item (CW logo) above Directions, links product_url', pg.evaluate(
        f"(() => {{ const x = document.querySelector('.cw-side .cw-xnav a'), t = Array.from(document.querySelectorAll('.cw-side .cw-nav-title')).find(n => n.textContent === 'Directions');"
        f" return !!x && !!t && x.getAttribute('href') === {PRODUCT!r} && x.textContent.includes('Commonworld') && !!x.querySelector('img')"
        f" && !!(x.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) && x.getBoundingClientRect().height > 0; }})()"))
    check('footer: Privacy and Terms links', pg.locator('.cw-foot a[href="/privacy/"]').count() == 1 and pg.locator('.cw-foot a[href="/terms/"]').count() == 1)
    pg.click('[data-consent="denied"]'); pg.reload()
    check('reject remembered, banner hidden, gtag never loaded', not pg.is_visible('.cw-consent') and not ga)
    pg.click('[data-cookie-settings]'); pg.click('[data-consent="granted"]'); pg.wait_for_timeout(300)
    check('accept loads gtag.js G-9QB65R36K6', any('gtag/js?id=G-9QB65R36K6' in u for u in ga))
    check('consent update granted in dataLayer', pg.evaluate("JSON.stringify(dataLayer).includes('\"analytics_storage\":\"granted\"')"))
    pg.click('.cw-announce-x'); pg.reload()
    check('announcement dismissed and remembered', not pg.is_visible('.cw-announce'))

    # catalog: /atlas/ is page 1 of the list (50 cards + pager); search, filters, sort and counters run on the whole Atlas
    v, a, good = pg.evaluate(ADS_OK)
    check(f'page 1 shows {v} cards (of {N_ALL}), {a} native ads after every 12', v == N_PAGE1 and good)
    check(f'pager shown on page 1 (page 1 of {N_PAGES})', N_PAGES == 1 or (pg.is_visible('#pager') and f'Page 1 of {N_PAGES}' in pg.inner_text('#pager')))
    check('index not fetched before the first interaction', pg.evaluate("document.getElementById('catalog').dataset.index") is None)
    check('hint line shown', 'Tags combine with AND.' in pg.inner_text('#active'))
    pg.fill('#q', 'termix')
    check('search index loaded on first use', wait_js(pg, "document.getElementById('catalog').dataset.index === 'loaded'"))
    pg.wait_for_timeout(250)
    n = pg.evaluate(VIS)
    check(f'search "termix" ({n})', 1 <= n <= 3)
    check('pager hidden while searching, page noindex', not pg.is_visible('#pager') and pg.get_attribute('meta[name="robots"]', 'content') == 'noindex,follow')
    pg.fill('#q', 'Lightning sats'); pg.wait_for_timeout(600)
    n = pg.evaluate(VIS)
    check(f'search reaches claim statements ("Lightning sats" -> {n})', n >= 1 and pg.evaluate("!document.querySelector('[data-slug=\"the-colony\"]').hidden"))
    pg.fill('#q', ''); pg.wait_for_timeout(250)
    check(f'empty search: back to page 1 ({pg.evaluate(VIS)} cards, pager, indexable)', pg.evaluate(VIS) == N_PAGE1 and (N_PAGES == 1 or pg.is_visible('#pager'))
          and pg.get_attribute('meta[name="robots"]', 'content').startswith('index,follow'))
    pg.click('[data-f-status="closed"]')
    n = pg.evaluate(VIS)
    check(f'status chip closed -> {N_CLOSED} ({n})', n == N_CLOSED)
    v, a, good = pg.evaluate(ADS_OK)
    check(f'native ad re-inserted after filter ({v} cards, {a} ads)', good and a == 1)
    check('list count updates', pg.inner_text('#list-count') == f'{N_CLOSED} of {N_ALL}')
    pg.click('#f-reset')
    pg.click('[data-filter="feat:money"]')
    nm = pg.evaluate(VIS)
    pg.click('[data-f-type="platform"]')
    nmt = pg.evaluate(VIS)
    check(f'stat tile "money flow" ({nm}) AND type platform ({nmt})', 0 < nmt <= nm < N_ALL)
    cnt = pg.inner_text('[data-f-status="live"] span')
    check(f'chip counts follow other filters (live={cnt})', int(cnt) <= nmt)
    pg.click('#f-reset')
    pg.click('.cw-legend [data-cat="payments"]')
    n = pg.evaluate(VIS)
    check(f'legend item filters category (payments={n})', n == N_PAY and pg.inner_text('#list-title') == 'Payments & x402')
    pg.click('#tagcloud [data-tag="x402"]')
    n2 = pg.evaluate(VIS)
    check(f'tag AND category ({n2})', 0 < n2 < 50)
    check('active filter chips shown', 'found' in pg.inner_text('#active') and '#x402' in pg.inner_text('#active'))
    check('URL keeps state', 'category=payments' in pg.url and 'tag=x402' in pg.url)
    pg.click('#f-reset')
    pg.click('#catalog-top [data-cat="wiki"]')
    N_WIKI = sum(1 for c in _SNAP if c.get('category') == 'wiki')
    check(f'category tab filters (wiki={N_WIKI})', pg.evaluate(VIS) == N_WIKI)
    pg.click('#f-reset')
    shelf_h = pg.evaluate("document.getElementById('tagcloud').clientHeight")
    pg.click('.cw-tags-more')
    open_h = pg.evaluate("document.getElementById('tagcloud').clientHeight")
    check(f'tag shelf expands ({shelf_h}px -> {open_h}px)', shelf_h <= 120 and open_h > shelf_h and 'collapse' in pg.inner_text('.cw-tags-more'))
    pg.select_option('#f-sort', 'claims')
    first = pg.evaluate("+document.querySelector('#grid .cw-card[data-slug]:not([hidden])').dataset.claims")
    mx = pg.evaluate("Math.max(...Array.from(document.querySelectorAll('#grid .cw-card[data-slug]')).map(c=>+c.dataset.claims))")
    check('sort by most claims', first == mx)
    pg.select_option('#f-sort', 'name'); pg.click('#f-reset')
    check(f'reset + default sort: page 1 again ({pg.evaluate(VIS)} cards)', pg.evaluate(VIS) == N_PAGE1 and pg.inner_text('#list-count').startswith('Showing 1–'))
    pg.goto(B + '/atlas/?status=closed&type=platform&q=x')
    wait_js(pg, "document.getElementById('catalog').dataset.index === 'loaded'"); pg.wait_for_timeout(200)
    check('state restored from URL', pg.evaluate(VIS) <= N_CLOSED and pg.input_value('#q') == 'x')

    # page 2 of the list: plain static page, its own 50 cards, prev/next links, self-canonical
    if N_PAGES > 1:
        pg.goto(B + '/atlas/page/2/')
        n2 = pg.locator('main .cw-grid .cw-card:not(.cw-adcard)').count()
        check(f'/atlas/page/2/: {n2} cards, canonical self, rel=prev to /atlas/', 0 < n2 <= PAGE_SIZE
              and pg.get_attribute('link[rel="canonical"]', 'href') == 'https://commonworld.one/atlas/page/2/'
              and pg.get_attribute('link[rel="prev"]', 'href') == '/atlas/' and pg.get_attribute('.cw-pager a[rel="prev"]', 'href') == '/atlas/')
        pg.click('.cw-pager a[rel="prev"]'); pg.wait_for_url('**/atlas/')
        check('pager "Previous" on page 2 opens /atlas/', pg.url.endswith('/atlas/'))

    # search index down (Codex review of #107, P2): no filtering of the page's own 50 cards, a clear notice, and a retry on the next interaction
    fc = br.new_context(viewport={'width': 1280, 'height': 900})
    fc.route('**/www.googletagmanager.com/**', lambda route: route.fulfill(status=200, body=''))
    fc.route('**/atlas/data/search-index.json*', lambda route: route.fulfill(status=503, body='down'))
    fp = fc.new_page(); fp.goto(B + '/atlas/')
    fp.evaluate("document.querySelector('[data-f-status=\"closed\"]').click()")  # JS click: the consent banner of a fresh context may cover the chip
    wait_js(fp, "document.getElementById('catalog').dataset.index === 'failed'"); fp.wait_for_timeout(200)
    check(f'index fails: page keeps its {N_PAGE1} cards, says so, no partial filter', fp.evaluate(VIS) == N_PAGE1
          and 'could not be loaded' in fp.inner_text('#active') and fp.locator('#active [role="alert"]').count() == 1)
    fc.unroute('**/atlas/data/search-index.json*')
    fp.evaluate("document.querySelector('[data-f-status=\"live\"]').click()")
    check('index fails: the next interaction loads it again', wait_js(fp, "document.getElementById('catalog').dataset.index === 'loaded'"))
    fc.close()

    # the A-Z list is paged too (#107): /atlas/platforms/page/N/ with a letter jump bar
    if N_PAGES > 1:
        pg.goto(B + '/atlas/platforms/page/2/')
        rows = pg.locator('main table.list tbody tr').count()
        check(f'/atlas/platforms/page/2/: {rows} rows, canonical self, rel=prev to /atlas/platforms/', 0 < rows <= PAGE_SIZE
              and pg.get_attribute('link[rel="canonical"]', 'href') == 'https://commonworld.one/atlas/platforms/page/2/'
              and pg.get_attribute('link[rel="prev"]', 'href') == '/atlas/platforms/')
        last = pg.locator('.cw-azbar a').last
        href = last.get_attribute('href')
        last.click(); pg.wait_for_load_state()
        anchor = href.split('#')[1]
        check(f'A-Z jump bar: last letter opens {href} and its row exists', pg.url.endswith(href) and pg.locator(f'tr#{anchor}').count() == 1)

    # share buttons (platform page): placement, links, copy via keyboard, GA4 'share' event only with consent, native share
    SHARE_EVT = "(m) => (window.dataLayer||[]).some(a => a && a[0]==='event' && a[1]==='share' && (!m || (a[2]||{}).method===m))"
    canon = 'https://commonworld.one/atlas/platforms/the-colony/'
    for consent in ('denied', 'granted'):
        sc = br.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['clipboard-read', 'clipboard-write'])
        sc.add_init_script(f"try{{localStorage.setItem('cw-consent','{consent}')}}catch(e){{}}")
        sc.route('**/www.googletagmanager.com/**', lambda route: route.fulfill(status=200, body=''))
        sc.route('https://x.com/**', lambda route: route.fulfill(status=200, body='ok'))
        sp = sc.new_page()
        sp.goto(B + '/atlas/platforms/the-colony/')
        if consent == 'denied':
            check('share bar: in the header card next to Visit, visible on landing, only one; sponsored slot still above facts', sp.evaluate(
                "(() => { const bars = document.querySelectorAll('.cw-share'), b = bars[0], h = document.querySelector('.entry-head'), f = document.getElementById('h-claims'), s = document.querySelector('[data-ad-slot=\"atlas-platform-top\"]');"
                " const r = b && b.getBoundingClientRect();"
                " return bars.length === 1 && h.contains(b) && !!h.querySelector('.entry-actions .visit') && r.bottom <= innerHeight && !!s"
                " && !!(s.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); })()"))
            nets = sp.evaluate("Array.from(document.querySelectorAll('.cw-share [data-share]')).filter(b => !b.hidden).map(b => b.dataset.share).join(',')")
            check(f'share: networks shown on desktop, native hidden ({nets})', nets == 'x,linkedin,telegram,reddit,facebook,email,copy')
            check('share: every link carries the canonical URL', sp.evaluate(
                f"Array.from(document.querySelectorAll('.cw-share a[data-share]')).every(a => decodeURIComponent(a.href).includes({canon!r}))"))
            check('share: buttons have aria-labels', sp.evaluate("Array.from(document.querySelectorAll('.cw-share [data-share]')).every(b => b.getAttribute('aria-label'))"))
        sp.focus('.cw-share [data-share="copy"]'); sp.keyboard.press('Enter'); sp.wait_for_timeout(200)
        clip = sp.evaluate('navigator.clipboard.readText()')
        check(f'share ({consent}): keyboard Enter on Copy link copies the canonical URL', clip == canon and 'Copied' in sp.inner_text('.cw-share [data-share="copy"]')
              and sp.inner_text('.cw-share-status') == 'Link copied')
        with sc.expect_page() as popup:
            sp.click('.cw-share [data-share="x"]')
        popup.value.close()
        if consent == 'denied':
            check('share (denied): no GA4 share event', not sp.evaluate(SHARE_EVT, None))
        else:
            check('share (granted): GA4 share events with method copy and x', sp.evaluate(SHARE_EVT, 'copy') and sp.evaluate(SHARE_EVT, 'x'))
        sc.close()
    mc = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    mc.add_init_script("navigator.share = (d) => { window.__shared = d; return Promise.resolve(); };"
                       "try{localStorage.setItem('cw-consent','denied')}catch(e){}")
    mp = mc.new_page()
    mp.goto(B + '/atlas/platforms/the-colony/')
    check('mobile: native Share button visible where navigator.share exists', mp.is_visible('.cw-share [data-share="native"]'))
    check('mobile: share row is in the header card', mp.evaluate("document.querySelector('.entry-head').contains(document.querySelector('.cw-share'))"))
    mp.tap('.cw-share [data-share="native"]'); mp.wait_for_timeout(200)
    check('mobile: native share gets canonical URL + text', mp.evaluate(f"window.__shared && window.__shared.url === {canon!r} && window.__shared.text === 'The Colony — verified on Commonworld Atlas'"))
    check('mobile: share bar fits (no horizontal overflow)', mp.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    mc.close()

    # mobile drawer + platform page
    m = br.new_context(viewport={'width': 390, 'height': 844}).new_page()
    m.goto(B + '/atlas/platforms/the-colony/')
    check('mobile: sidebar hidden, menu visible', not m.is_visible('.cw-side .cw-nav') and m.is_visible('.cw-menu'))
    m.click('.cw-menu'); m.wait_for_timeout(300)
    check('mobile: drawer opens', m.is_visible('.cw-side .cw-nav') and m.get_attribute('.cw-menu', 'aria-expanded') == 'true')
    m.keyboard.press('Escape'); m.wait_for_timeout(300)
    check('mobile: Escape closes drawer', m.get_attribute('.cw-menu', 'aria-expanded') == 'false')
    check('platform page: sponsored banner directly under the header, then the screenshot figure, then the facts', m.evaluate(
        "(() => { const s = document.querySelector('[data-ad-slot=\"atlas-platform-top\"]'), f = document.getElementById('h-claims'), h = document.querySelector('.entry-head'), d = document.querySelector('.entry > dl.facts');"
        " return !!s && s.classList.contains('cw-ad-banner') && s.querySelector('.cw-ad-label').textContent === 'Sponsored'"
        " && /sponsored/.test(s.querySelector('a').rel) && /nofollow/.test(s.querySelector('a').rel)"
        " && !!(h.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) && h.nextElementSibling === s && s.nextElementSibling.matches('figure.entry-shot') && s.nextElementSibling.nextElementSibling === d"
        " && !!(s.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); })()"))
    check('mobile: no horizontal overflow', m.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    if os.path.exists(os.path.join(HERE, '..', 'dist', 'atlas', 'screens', 'manifest.json')):  # previews published (branch atlas-screens fetched)
        m.goto(B + '/atlas/')
        th = m.locator('#grid .cw-card > img').first
        th.scroll_into_view_if_needed(); wait_js(m, "(() => { const i = document.querySelector('#grid .cw-card > img'); return !!(i && i.complete); })()")
        check('screens: first grid thumbnail decodes (600 px top band)', m.evaluate("document.querySelector('#grid .cw-card > img').naturalWidth") == 600)
        slug = m.evaluate("document.querySelector('#grid .cw-card > img').src.split('/').pop().replace('.webp','')")
        m.goto(B + f'/atlas/platforms/{slug}/')
        fig = m.locator('figure.entry-shot img'); fig.scroll_into_view_if_needed()
        wait_js(m, "document.querySelector('figure.entry-shot img').complete")
        check('screens: card page shows the full screenshot (1200 px)', m.evaluate("document.querySelector('figure.entry-shot img').naturalWidth") == 1200)
    m.goto(B + '/atlas/')
    check('mobile index: no horizontal overflow, 1 card column', m.evaluate(
        "document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length === 1"))
    t = br.new_context(viewport={'width': 820, 'height': 1180}).new_page()
    for u in ('/', '/about/', '/atlas/', '/atlas/platforms/the-colony/', '/atlas/categories/payments/', '/atlas/about/', '/atlas/closed/', '/atlas/api/', '/privacy/', '/terms/'):
        t.goto(B + u)
        check(f'tablet {u}: no horizontal overflow', t.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    lp = br.new_context().new_page()
    lp.goto(B + '/privacy/')
    check('site-wide privacy page: title + scope', lp.inner_text('h1') == 'Commonworld Privacy Policy'
          and 'Applies to Commonworld and all its sections, including the Atlas.' in lp.inner_text('main'))
    check('privacy page: final (no draft note, indexable)', lp.locator('.legal-draft').count() == 0 and 'is a draft' not in lp.inner_text('main')
          and 'noindex' not in (lp.get_attribute('meta[name="robots"]', 'content') or ''))
    lp.goto(B + '/terms/')
    check('site-wide terms page: title', lp.inner_text('h1') == 'Commonworld Terms of Use')
    check('terms page: final (no draft note, indexable)', lp.locator('.legal-draft').count() == 0 and 'is a draft' not in lp.inner_text('main')
          and 'noindex' not in (lp.get_attribute('meta[name="robots"]', 'content') or ''))
    lp.goto(B + '/atlas/privacy/'); lp.wait_for_url(lambda u: '/atlas/' not in u, timeout=5000)
    check('old /atlas/privacy/ stub forwards to /privacy/', lp.url.endswith('/privacy/') and '/atlas/' not in lp.url)
    lp.goto(B + '/atlas/terms/'); lp.wait_for_url(lambda u: '/atlas/' not in u, timeout=5000)
    check('old /atlas/terms/ stub forwards to /terms/', lp.url.endswith('/terms/') and '/atlas/' not in lp.url)
    # --- Commonworld landing (/)
    SHOTS = os.environ.get('SHOTS_DIR')
    lc = br.new_context(viewport={'width': 1440, 'height': 1000})
    lga = []
    lc.route('**/www.googletagmanager.com/**', lambda route: (lga.append(route.request.url), route.fulfill(status=200, body='')))
    hp = lc.new_page()
    hp.goto(B + '/')
    check('landing: H1, motto, platform-live line', hp.inner_text('h1') == 'Commonworld' and 'A shared world for humans and agents' in hp.inner_text('main')
          and 'The platform is live at commonworld.one;' in hp.inner_text('main'))
    check('landing: light default, logo mark visible', hp.evaluate("document.documentElement.dataset.theme") == 'light' and hp.is_visible('.cw-landing img.cw-mark-l'))
    check(f'landing: stats show the Atlas count ({N_ALL})', f'{N_ALL:,}' in hp.inner_text('.landing-stats'))
    check('landing: cookie banner shown, no gtag before choice', hp.is_visible('.cw-consent') and not lga)
    check('landing: footer Privacy/Terms, share bar with canonical URL', hp.locator('.cw-foot a[href="/privacy/"]').count() == 1
          and hp.locator('.cw-foot a[href="/terms/"]').count() == 1 and hp.get_attribute('.cw-share', 'data-share-url') == 'https://commonworld.one/')
    check('landing: sidebar Commonworld item is current, home icon present', hp.get_attribute('.cw-side .cw-xnav a', 'aria-current') == 'page'
          and hp.locator('.cw-top a[aria-label="Commonworld home"]').count() == 1)
    if SHOTS:
        hp.click('.cw-consent [data-consent="denied"]')
        hp.screenshot(path=os.path.join(SHOTS, 'landing-desktop-light.png'))
        hp.click('.cw-theme'); hp.wait_for_timeout(600); hp.screenshot(path=os.path.join(SHOTS, 'landing-desktop-dark.png')); hp.click('.cw-theme'); hp.wait_for_timeout(600)
    check('landing: theme toggle works', (hp.click('.cw-theme') or hp.evaluate("document.documentElement.dataset.theme")) == 'dark')
    hp.click('.cw-theme')
    hp.click('.landing-cta'); hp.wait_for_url('**/atlas/')
    check('landing: primary button opens the Atlas', hp.url.endswith('/atlas/') and 'Atlas of Agent Platforms' in hp.inner_text('h1'))
    mp = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    mp.goto(B + '/')
    check('landing mobile: no horizontal overflow, CTA visible', mp.evaluate("document.documentElement.scrollWidth <= innerWidth") and mp.is_visible('.landing-cta'))
    if SHOTS:
        mp.evaluate("document.querySelector('.cw-consent').hidden = true"); mp.screenshot(path=os.path.join(SHOTS, 'landing-mobile-light.png'), full_page=True)
    # --- About Commonworld (/about/)
    ac = br.new_context(viewport={'width': 1440, 'height': 1000})
    aga = []
    ac.route('**/www.googletagmanager.com/**', lambda route: (aga.append(route.request.url), route.fulfill(status=200, body='')))
    ap = ac.new_page()
    ap.goto(B + '/')
    ap.click('.cw-side .cw-xsub a'); ap.wait_for_url('**/about/')
    check('sidebar "About" under the Commonworld item opens /about/', ap.url.endswith('/about/') and '/atlas/' not in ap.url)
    main_txt = ap.inner_text('main')
    check('about: H1 + motto + citizens line', ap.inner_text('h1') == 'About Commonworld' and 'A shared world for humans and agents' in main_txt
          and 'live side by side as citizens' in main_txt)
    check(f'about: live Atlas count ({N_ALL}), platform marked live, missing parts marked planned', f'{N_ALL:,}' in ap.inner_text('.prose .cw-stats')
          and 'The Commonworld platform is live at' in main_txt and 'coming soon' not in main_txt and main_txt.count('(planned)') == 4)
    check('about: links to the Atlas and to How the Atlas works', ap.locator('main a[href="/atlas/"]').count() >= 1 and ap.locator('main a[href="/atlas/about/"]').count() >= 1)
    check('about: sidebar About is current, Commonworld item not current, Atlas link reads "How the Atlas works"',
          ap.get_attribute('.cw-side .cw-xsub a', 'aria-current') == 'page' and ap.get_attribute('.cw-side .cw-xnav a', 'aria-current') is None
          and ap.locator('.cw-side a[href="/atlas/about/"]', has_text='How the Atlas works').count() == 1)
    check('about: footer About Commonworld + How the Atlas works + Privacy/Terms', ap.locator('.cw-foot a[href="/about/"]').count() == 1
          and ap.locator('.cw-foot a[href="/atlas/about/"]').count() == 1 and ap.locator('.cw-foot a[href="/privacy/"]').count() == 1)
    check('about: light default, cookie banner, no gtag before choice', ap.evaluate("document.documentElement.dataset.theme") == 'light'
          and ap.is_visible('.cw-consent') and not aga)
    check('about: share bar with canonical URL', ap.get_attribute('.cw-share', 'data-share-url') == 'https://commonworld.one/about/')
    ap.click('.cw-consent [data-consent="denied"]')
    if os.environ.get('ABOUT_SHOT'):
        ap.screenshot(path=os.environ['ABOUT_SHOT'])
    if SHOTS:
        ap.screenshot(path=os.path.join(SHOTS, 'about-desktop-light.png'))
    ap.click('.cw-theme'); ap.wait_for_timeout(400)
    check('about: dark theme toggles', ap.evaluate("document.documentElement.dataset.theme") == 'dark')
    if SHOTS:
        ap.wait_for_timeout(300); ap.screenshot(path=os.path.join(SHOTS, 'about-desktop-dark.png'))
    ap.click('.cw-theme')
    ap.goto(B + '/atlas/about/')
    check('/atlas/about/: top line links to /about/', ap.locator('.about-xref a[href="/about/"]').count() == 1 and ap.inner_text('h1') == 'How the Atlas works')
    am = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page()
    am.goto(B + '/about/')
    check('about mobile: no horizontal overflow', am.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    # /atlas/earn/: Basis pills stay on one line, Window column shows no raw ISO timestamps (desktop 1280/1440, mobile 390)
    ONE_LINE = """Array.from(document.querySelectorAll('.list.earn .earn-basis .tag')).every(t => {
      const lh = parseFloat(getComputedStyle(t).lineHeight) || 14; return t.getClientRects().length === 1 && t.getBoundingClientRect().height < lh * 1.9; })"""
    for w, h, mob in ((1280, 900, False), (1440, 1000, False), (390, 844, True)):
        ec = br.new_context(viewport={'width': w, 'height': h}, **({'is_mobile': True, 'has_touch': True} if mob else {}))
        ep = ec.new_page(); ep.goto(B + '/atlas/earn/')
        n = ep.locator('.list.earn .earn-basis .tag').count()
        check(f'earn {w}px: {n} Basis pills, each on one line', n > 0 and ep.evaluate(ONE_LINE))
        check(f'earn {w}px: Window column has no raw ISO timestamps', not ep.evaluate(
            "Array.from(document.querySelectorAll('.list.earn .earn-win')).some(td => /\\dT\\d{2}:\\d{2}/.test(td.textContent))"))
        check(f'earn {w}px: page itself does not scroll sideways (table scrolls in its wrapper)', ep.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        if SHOTS:
            ep.locator('.list.earn').first.scroll_into_view_if_needed()
            ep.screenshot(path=os.path.join(SHOTS, f'earn-{w}.png'), full_page=False)
        ec.close()
    # Lighthouse follow-ups: counter contrast, footer tap targets, tag shelf has no cut-off tappable chips, landing logo resolution
    CONTRAST = """(sel) => { const px = c => (c.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = px(getComputedStyle(e).backgroundColor); if (c.length === 3 || c[3] > 0) return c.slice(0, 3); } return [255, 255, 255]; };
      let worst = 99; document.querySelectorAll(sel).forEach(el => { if (!el.getClientRects().length) return;
        let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
        const f = px(getComputedStyle(el).color), b = bgOf(el), a = (f.length > 3 ? f[3] : 1) * op;
        const mix = f.slice(0, 3).map((v, i) => a * v + (1 - a) * b[i]); const L1 = lum(mix), L2 = lum(b);
        worst = Math.min(worst, (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)); }); return worst; }"""
    TAGS_OK = """(() => { const el = document.getElementById('tagcloud'); el.scrollIntoView({block: 'center'});
      const r = el.getBoundingClientRect(), lim = r.top + el.clientTop + el.clientHeight + 0.5;
      const live = Array.from(el.querySelectorAll('[data-tag]')).filter(t => !t.hidden && !t.inert);
      const bad = live.filter(t => { const c = t.getBoundingClientRect(); if (c.bottom > lim) return true;
        const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2); return !(hit && t.contains(hit)); });
      return [live.length, el.querySelectorAll('[data-tag][inert]').length, bad.map(t => t.dataset.tag)]; })()"""
    FOOT_OK = "Array.from(document.querySelectorAll('.cw-foot-links > a, .cw-foot-links > .cw-linkbtn, .cw-foot-official')).filter(a => { const r = a.getBoundingClientRect(); return r.height < 24 || r.width < 24; }).map(a => a.textContent.trim())"
    for w, h, mob in ((1280, 900, False), (390, 844, True)):
        ac = br.new_context(viewport={'width': w, 'height': h}, **({'is_mobile': True, 'has_touch': True} if mob else {}))
        ac.add_init_script("try{localStorage.setItem('cw-consent','denied')}catch(e){}")
        apg = ac.new_page(); apg.goto(B + '/atlas/')
        for theme in ('light', 'dark'):
            apg.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
            c = apg.evaluate(CONTRAST, '.pill span, .cw-tabs span, #tagcloud .link-pill small')
            check(f'a11y {w}px {theme}: filter/tag counters contrast >= 4.5:1 (worst {c:.2f})', c >= 4.5)
        apg.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
        small = apg.evaluate(FOOT_OK)
        check(f'a11y {w}px: footer links/buttons are >= 24x24 px ({small or "all ok"})', not small)
        live, inert, bad = apg.evaluate(TAGS_OK)
        check(f'a11y {w}px: collapsed tag shelf: {live} tappable chips fully visible and hit-testable, {inert} cut-off chips inert ({bad or "ok"})', live > 0 and not bad)
        apg.click('.cw-tags-more')
        check(f'a11y {w}px: expanded tag shelf has no inert chips', apg.evaluate("document.querySelectorAll('#tagcloud [data-tag][inert]').length") == 0)
        apg.click('.cw-tags-more')
        apg.goto(B + '/')
        lg = apg.evaluate("Array.from(document.querySelectorAll('.landing-mark')).filter(i => i.getClientRects().length).map(i => [i.naturalWidth, i.clientWidth])")
        check(f'a11y {w}px: landing logo has >= 2x pixels ({lg})', lg and all(nw >= 2 * cw for nw, cw in lg))
        ac.close()

    # sidebar hide / show (desktop): toggle, aria state, persistence across reload, applied before atlas.js runs, mobile unchanged
    SIDE_VIS = "(() => { const s = document.getElementById('cw-side'); return !!s && s.getBoundingClientRect().width > 0 && getComputedStyle(s).display !== 'none'; })()"
    NO_HSCROLL = "document.documentElement.scrollWidth <= innerWidth"
    sc = br.new_context(viewport={'width': 1280, 'height': 900})
    sc.add_init_script("try{localStorage.setItem('cw-consent','denied')}catch(e){}")
    sp = sc.new_page()
    sp.goto(B + '/atlas/')
    tg = '.cw-top .cw-sidetoggle'
    w0 = sp.evaluate("document.getElementById('main').getBoundingClientRect().width")
    check('sidebar toggle (1280): visible, labelled "Hide sidebar", aria-expanded=true, aria-controls=cw-side, sidebar shown',
          sp.is_visible(tg) and sp.get_attribute(tg, 'aria-label') == 'Hide sidebar' and sp.get_attribute(tg, 'aria-expanded') == 'true'
          and sp.get_attribute(tg, 'aria-controls') == 'cw-side' and sp.evaluate(SIDE_VIS))
    sp.focus(tg); sp.keyboard.press('Enter'); sp.wait_for_timeout(150)
    w1 = sp.evaluate("document.getElementById('main').getBoundingClientRect().width")
    check(f'sidebar toggle: keyboard Enter hides the sidebar, content widens ({w0:.0f} -> {w1:.0f}px), label "Show sidebar"',
          not sp.evaluate(SIDE_VIS) and w1 > w0 + 150 and sp.get_attribute(tg, 'aria-expanded') == 'false'
          and sp.get_attribute(tg, 'aria-label') == 'Show sidebar' and sp.evaluate("document.activeElement.classList.contains('cw-sidetoggle')"))
    check('sidebar hidden (1280): no horizontal scroll', sp.evaluate(NO_HSCROLL))
    if SHOTS:
        sp.screenshot(path=os.path.join(SHOTS, 'sidebar-hidden-1280.png'))
    sp.reload()
    check('sidebar toggle: hidden state persists across reload', not sp.evaluate(SIDE_VIS) and sp.get_attribute(tg, 'aria-expanded') == 'false')
    sp.route('**/assets/atlas.js*', lambda route: route.abort())
    sp.goto(B + '/atlas/platforms/the-colony/')
    check('sidebar toggle: stored state applied without atlas.js (boot script, before first paint: no layout shift)', sp.evaluate("document.documentElement.classList.contains('cw-side-off')") and not sp.evaluate(SIDE_VIS))
    sp.unroute('**/assets/atlas.js*'); sp.goto(B + '/atlas/')
    sp.click(tg); sp.wait_for_timeout(150)
    check('sidebar toggle: click shows it again', sp.evaluate(SIDE_VIS) and sp.get_attribute(tg, 'aria-expanded') == 'true')
    sp.reload()
    check('sidebar toggle: shown state persists across reload', sp.evaluate(SIDE_VIS) and sp.evaluate("localStorage.getItem('cw-side')") is None)
    check('sidebar shown (1280): no horizontal scroll', sp.evaluate(NO_HSCROLL))
    sp.click(tg); sc.close()
    mc = br.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    mc.add_init_script("try{localStorage.setItem('cw-side','off');localStorage.setItem('cw-consent','denied')}catch(e){}")
    mp = mc.new_page(); mp.goto(B + '/atlas/')
    check('sidebar toggle (390): hidden on mobile, menu button and drawer unchanged even with stored "off"', not mp.is_visible(tg) and mp.is_visible('.cw-menu')
          and (mp.click('.cw-menu') or mp.wait_for_timeout(300) or mp.is_visible('.cw-side .cw-nav')))
    check('sidebar toggle (390): no horizontal scroll', mp.evaluate(NO_HSCROLL))
    mc.close()
    # strict CSP (no 'unsafe-inline'): nothing the smoke test touched may trip it
    check(f'CSP: no violations on any page visited ({len(CSP_ERRORS)}: {sorted(set(CSP_ERRORS))[:5]})', not CSP_ERRORS)
    br.close()
srv.shutdown()
print('SMOKE OK' if ok else 'SMOKE FAILED')
sys.exit(0 if ok else 1)
