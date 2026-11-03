"""Commonworld design-system components (Python 3 stdlib only).

Shared by Atlas now and meant to be reused by the whole Commonworld product. Each function returns an HTML
string; styles live in cw-components.css and behaviour in cw-components.js (framework-free). The visual system
is the Commonworld catalog draft (research/atlas/catalog_en.html). Nothing here knows about Atlas data: callers
pass plain lists/tuples.

Page frame
  boot_script(cfg)                 inline <head>: theme + announcement state before paint, Consent Mode v2 defaults
  announcement_bar(cfg)            thin dismissible bar above everything (config-driven, remembered per id)
  sidebar(cfg, base, groups, bottom='')   logo + motto, titled nav groups, bottom slot (e.g. an ad); drawer on mobile
  top_row(search_html, cfg)        search on the left; menu (mobile), home and theme icon buttons on the right
  footer(left, links_html)         small footer row
  consent_banner(cfg), cookie_settings_button()
Blocks
  stats_strip(tiles)               tiles: (value, label, attrs, dot_class|None, clickable)
  catbar(segments) / legend(items) proportional colored bar + "Name N (M live)" legend
  hero(kicker, title, lead_html, box_html='', small=False)
  info_box(dot, strong, muted, text_html)
  tabs(items)                      pill tabs: (label, count, attrs, active)
  tag_shelf(tags, total, shelf_id) clipped row of tag chips with counts + "all tags (N) ↓" expander
  card(...) / ad_card(cfg, name)   catalog card (optional thumb= HTML first) and the native sponsored card in the same style
  ad_slot(cfg, name, cls='')       named ad slot: creative, neutral placeholder or nothing; size reserved
  share_bar(cfg, url, text)        share buttons: X, LinkedIn, Telegram, Reddit, Facebook, Email, Copy link, native Web Share
Icons/buttons
  theme_toggle(), home_link(cfg), product_icon(href, label, icon), menu_button()
Cross-product navigation
  cross_nav_item(href, label, icon_html)   sidebar item above the first group (to the sibling product)
  mark_icon(base)                          small CW logo mark (light/dark) for that item
"""
import html
import re
import json
from urllib.parse import quote

e = lambda s: html.escape('' if s is None else str(s), quote=True)


def _svg(paths, cls='cw-i'):
    return (f'<svg class="{cls}" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">{paths}</svg>')


ICON_SUN = _svg('<circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>'
                '<path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" '
                'stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', 'cw-i cw-i-sun')
ICON_MOON = _svg('<path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z" fill="none" stroke="currentColor" '
                 'stroke-width="1.8" stroke-linejoin="round"/>', 'cw-i cw-i-moon')
ICON_HOME = _svg('<path d="M3.5 11 12 4l8.5 7M6 9.5V20h4.5v-5.5h3V20H18V9.5" fill="none" stroke="currentColor" '
                 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>')
ICON_GLOBE = _svg('<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.8"/>'
                  '<path d="M3.6 12h16.8M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6S9.6 5.8 12 3.4z" '
                  'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>')
ICON_SIDEBAR = _svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/>'
                   '<path d="M9.5 4.5v15" stroke="currentColor" stroke-width="1.8"/>')
ICON_MENU = _svg('<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>')
ICON_CLOSE = ('<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
              '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>')


def attrs(d):
    return ''.join(f' {k}="{e(v)}"' if v is not True else f' {k}' for k, v in (d or {}).items() if v not in (None, False))


# ------------------------------------------------------------------ page frame
def _ann(cfg):
    a = cfg.get('announcement') or {}
    return a if a.get('enabled') and a.get('text') and a.get('id') else None


def boot_script(cfg):
    """Runs before first paint. Kept tiny; inlined in every page's <head>. Light theme is the default."""
    a = _ann(cfg)
    ga = (cfg.get('site') or {}).get('ga4_measurement_id') or ''
    default = (cfg.get('site') or {}).get('default_theme') or 'light'
    js = ("(function(){var d=document.documentElement,s;try{s=localStorage}catch(x){s=null}"
          f"var t=s&&s.getItem('cw-theme');if(t!=='light'&&t!=='dark'){{t={json.dumps(default)}}}"
          "d.setAttribute('data-theme',t);"
          "if(s&&s.getItem('cw-side')==='off')d.classList.add('cw-side-off');"
          + (f"if(s&&s.getItem('cw-ann-dismissed')==={json.dumps(a['id'])})d.classList.add('cw-ann-off');" if a else "")
          + "})();")
    if ga:
        js += ("window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}"
               "gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',"
               "analytics_storage:'denied',functionality_storage:'denied',personalization_storage:'denied',security_storage:'granted'});"
               f"window.CW_GA={json.dumps(ga)};")
    return f'<script>{js}</script>'


def announcement_bar(cfg):
    a = _ann(cfg)
    if not a:
        return ''
    link = a.get('link') or {}
    href = link.get('href')
    rel = ' rel="nofollow noopener"' if href and href.startswith('http') else ''
    lk = f' <a href="{e(href)}"{rel}>{e(link.get("label") or "Learn more")}</a>' if href else ''
    return (f'<div class="cw-announce" role="region" aria-label="Announcement" data-ann-id="{e(a["id"])}">'
            f'<p>{e(a["text"])}{lk}</p>'
            f'<button type="button" class="cw-announce-x" aria-label="Dismiss announcement">{ICON_CLOSE}</button></div>')


# Cache-busting for the logo images (assets are cached for 7 days): build.py sets MARK_V to a hash of static/*.svg|png.
MARK_V = ''


def _mv():
    return f'?v={MARK_V}' if MARK_V else ''


def sidebar(cfg, base, groups, bottom='', top=''):
    """groups: [(title, [(href, label, count|None, active, extra_attrs_dict)])].
    top: HTML placed under the logo, above the first group title (e.g. cross_nav_item(...) to another product)."""
    s = cfg.get('site') or {}
    motto = e(s.get('motto') or '')
    if ' for ' in motto:
        motto = motto.replace(' for ', '<br>for ', 1)
    out = [f'<aside class="cw-side" id="cw-side" aria-label="Site navigation"><div class="cw-side-in">'
           f'<a class="cw-brand" href="{e(base)}/"><img class="cw-mark cw-mark-l" src="{e(base)}/assets/cw-mark-light.svg{_mv()}" alt="" width="46" height="46">'
           f'<img class="cw-mark cw-mark-d" src="{e(base)}/assets/cw-mark-dark.svg{_mv()}" alt="" width="46" height="46">'
           f'<span><strong>{e(s.get("name") or "Commonworld")}</strong><small>{motto}</small></span></a>']
    if top:
        out.append(top)
    for title, items in groups:
        links = []
        for href, label, count, active, extra in items:
            cur = ' class="active" aria-current="page"' if active == 'page' else (' class="active"' if active else '')
            cnt = f'<span>{count}</span>' if count is not None else ''
            links.append(f'<a href="{e(href)}"{cur}{attrs(extra)}>{e(label)}{cnt}</a>')
        out.append(f'<div class="cw-nav-title">{e(title)}</div><nav class="cw-nav" aria-label="{e(title)}">{"".join(links)}</nav>')
    if bottom:
        out.append(f'<div class="cw-side-note">{bottom}</div>')
    out.append('</div></aside><div class="cw-scrim" data-drawer-close hidden></div>')
    return ''.join(out)


def theme_toggle():
    return f'<button type="button" class="cw-iconbtn cw-theme" aria-label="Switch to dark theme" title="Toggle theme">{ICON_MOON}{ICON_SUN}</button>'


# ------------------------------------------------------------------ cross-product navigation
# Two reusable pieces link the Commonworld products to each other (see README "Cross-product navigation"):
#   cross_nav_item(...)  a sidebar item at the top of the left menu (Atlas: "Commonworld"; main product: "Atlas")
#   product_icon(...)    a round icon button in the top-right row (Atlas: house -> main product; main product: globe -> Atlas)
def cross_nav_item(href, label, icon_html, title=None, cls='cw-xnav'):
    """One prominent link to a sibling product, rendered as its own small nav above the sidebar groups.
    icon_html: e.g. two <img> marks (light/dark) or an inline SVG such as ICON_GLOBE."""
    return (f'<nav class="cw-nav {e(cls)}" aria-label="{e(title or label)}">'
            f'<a href="{e(href)}" data-xnav="{e(label)}"><span class="cw-xnav-in">{icon_html}<b>{e(label)}</b></span>'
            f'<span class="cw-xnav-go" aria-hidden="true">↗</span></a></nav>')


def mark_icon(base, size=18):
    """The Commonworld logo mark as a small icon (light + dark variants, swapped by theme CSS)."""
    return (f'<img class="cw-mark-l" src="{e(base)}/assets/cw-mark-light.svg{_mv()}" alt="" width="{size}" height="{size}">'
            f'<img class="cw-mark-d" src="{e(base)}/assets/cw-mark-dark.svg{_mv()}" alt="" width="{size}" height="{size}">')


def product_icon(href, label, icon='home'):
    """Top-right icon button to a sibling product. icon: 'home' (house) or 'globe'."""
    svg = {'home': ICON_HOME, 'globe': ICON_GLOBE}.get(icon, ICON_HOME)
    return f'<a class="cw-iconbtn cw-product" href="{e(href)}" aria-label="{e(label)}" title="{e(label)}">{svg}</a>'


RAISE_URL = 'https://raise.commonworld.one'


def raise_link(base):
    """Round top-right button to Muse RAISE with Forge's avatar (assets/raise-forge.png, 96 px, served locally), placed
    right after the product button (house on the Atlas, globe on the main product) in every top_row()."""
    return (f'<a class="cw-iconbtn cw-raise" href="{RAISE_URL}" rel="noopener" aria-label="Muse RAISE" title="Muse RAISE">'
            f'<img src="{e(base)}/assets/raise-forge.png{_mv()}" alt="" width="32" height="32" decoding="async"></a>')


def home_link(cfg):
    """Atlas: house icon to the main Commonworld product (site.product_url)."""
    s = cfg.get('site') or {}
    href = s.get('product_url') or s.get('home_url') or '/'
    return product_icon(href, f'{s.get("product_name") or "Commonworld"} home', 'home')


def menu_button():
    return f'<button type="button" class="cw-iconbtn cw-menu" aria-label="Open menu" aria-controls="cw-side" aria-expanded="false" title="Menu">{ICON_MENU}</button>'


def side_toggle():
    """Desktop only (>900px): hides / shows the left sidebar so the content uses the full width. The choice is kept in
    localStorage 'cw-side' and applied by boot_script before first paint (no layout shift); cw-components.js syncs the label."""
    return (f'<button type="button" class="cw-iconbtn cw-sidetoggle" aria-controls="cw-side" aria-expanded="true" '
            f'aria-label="Hide sidebar" title="Hide sidebar">{ICON_SIDEBAR}</button>')


def search_form(action, placeholder, live=False, value=''):
    return (f'<form class="cw-search-wrap" role="search" action="{e(action)}" method="get"{" data-live-search" if live else ""}>'
            f'<label class="sr" for="q">Search</label>'
            f'<input class="cw-search" id="q" name="q" type="search" placeholder="{e(placeholder)}" autocomplete="off" value="{e(value)}">'
            f'<button class="cw-search-clear" type="button" aria-label="Clear search" hidden>×</button></form>')


def top_row(search_html, cfg, product_html=None):
    """product_html: override the top-right product button (default home_link(cfg); the main product passes
    product_icon(atlas_url, 'Commonworld Atlas', 'globe')). The Muse RAISE circle (raise_link) always follows it."""
    base = ((cfg.get('site') or {}).get('base_path') or '/atlas').rstrip('/')
    return f'<header class="cw-top">{menu_button()}{side_toggle()}{search_html}<span class="spacer"></span>{home_link(cfg) if product_html is None else product_html}{raise_link(base)}{theme_toggle()}</header>'


def footer(left, links_html, official=()):
    """official: [(label, url, icon_key)] shown side by side with icons (rel="me": the project's own accounts)."""
    off = ''.join(f'<a class="cw-foot-official" href="{e(u)}" rel="me noopener">{OFFICIAL_ICONS.get(k, "")}<span>{e(t)}</span></a>' for t, u, k in official)
    off = f'<span class="cw-foot-officials" aria-label="Official channels">{off}</span>' if off else ''
    return f'<footer class="cw-foot"><span>{left}</span><span class="cw-foot-links">{links_html}{off}</span></footer>'


def consent_banner(cfg):
    site = cfg.get('site') or {}
    if not site.get('ga4_measurement_id'):
        return ''
    priv = site.get('privacy_url') or (site.get('base_path', '') + '/privacy/')
    return ('<div class="cw-consent" role="dialog" aria-live="polite" aria-label="Cookie consent" hidden>'
            '<p><b>Cookies.</b> We use Google Analytics cookies to count visits, only if you allow it. '
            f'<a href="{e(priv)}">Privacy</a></p>'
            '<div class="cw-consent-actions"><button type="button" class="cw-btn" data-consent="denied">Reject</button>'
            '<button type="button" class="cw-btn cw-btn-primary" data-consent="granted">Accept</button></div></div>')


def cookie_settings_button():
    return '<button type="button" class="cw-linkbtn" data-cookie-settings>Cookie settings</button>'


# ------------------------------------------------------------------ share
def _si(paths, fill=False):
    style = 'fill="currentColor"' if fill else 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
    return f'<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" {style}>{paths}</svg>'


SHARE_ICONS = {
    'x': _si('<path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.59-6.63 7.59H.47l8.6-9.83L0 1.15h7.59l5.24 6.93zm-1.29 19.5h2.04L6.49 3.24H4.3z"/>', True),
    'linkedin': _si('<rect x="3" y="3" width="18" height="18" rx="3.5"/><path d="M8 10.5V16.5M8 7.6v.1M11.5 16.5v-6m0 2.6c0-1.7 1-2.8 2.4-2.8s2.1 1 2.1 2.8v3.4"/>'),
    'telegram': _si('<path d="M21.2 3.6 2.9 10.8c-.8.3-.8 1.4 0 1.7l4.6 1.6 1.8 5.6c.2.7 1.1.9 1.6.4l2.6-2.5 4.6 3.4c.6.4 1.4.1 1.6-.6l3-15.6c.2-.8-.6-1.5-1.5-1.2z"/><path d="m7.5 14.1 9.6-6.3-6.9 7.4"/>'),
    'reddit': _si('<ellipse cx="12" cy="14.2" rx="8" ry="5.6"/><circle cx="18.6" cy="4.8" r="1.6"/><path d="m12 8.6 1.4-4.9 3.6.9"/><path d="M9 16.6c1.8 1.2 4.2 1.2 6 0"/><circle cx="9" cy="13.3" r=".9" fill="currentColor"/><circle cx="15" cy="13.3" r=".9" fill="currentColor"/>'),
    'facebook': _si('<path d="M14 22v-8h2.7l.4-3.2H14V8.8c0-.9.3-1.6 1.6-1.6h1.7V4.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.4-4 4.1v2.4H8.2V14h2.7v8z"/>', True),
    'email': _si('<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7 8 6 8-6"/>'),
    'copy': _si('<path d="M10 13.5a4.5 4.5 0 0 0 6.8.5l2.9-2.9a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.6"/><path d="M14 10.5a4.5 4.5 0 0 0-6.8-.5l-2.9 2.9a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/>'),
    'native': _si('<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
}
SHARE_NETWORKS = ['x', 'linkedin', 'telegram', 'reddit', 'facebook', 'email', 'copy']
SHARE_NAMES = {'x': 'X', 'linkedin': 'LinkedIn', 'telegram': 'Telegram', 'reddit': 'Reddit', 'facebook': 'Facebook',
               'email': 'email', 'copy': 'Copy link', 'native': 'Share…'}


def share_url(network, url, text):
    """Plain share-intent URL (no SDKs, no tracking). None for buttons that are not links (copy, native)."""
    u, t = quote(url, safe=''), quote(text, safe='')
    return {
        'x': f'https://x.com/intent/tweet?text={t}&url={u}',
        'linkedin': f'https://www.linkedin.com/sharing/share-offsite/?url={u}',
        'telegram': f'https://t.me/share/url?url={u}&text={t}',
        'reddit': f'https://www.reddit.com/submit?url={u}&title={t}',
        'facebook': f'https://www.facebook.com/sharer/sharer.php?u={u}',
        'email': f'mailto:?subject={t}&body={quote(text + chr(10) + chr(10) + url, safe="")}',
    }.get(network)


def share_bar(cfg, url, text, label=None, cls=''):
    """Share buttons for one page. url = the page's canonical URL; text = share text (e.g. "X — verified on ...").
    Config (site-config.json "share"): enabled, networks (subset/order of SHARE_NETWORKS), native (Web Share API button,
    shown by JS only where navigator.share exists on touch devices), label. Behaviour in cw-components.js: copy link with
    a live "Copied" status, native share, and a GA4 'share' event (method = network) only when analytics consent is granted."""
    sc = cfg.get('share') or {}
    if not sc.get('enabled', True):
        return ''
    nets = [n for n in sc.get('networks', SHARE_NETWORKS) if n in SHARE_ICONS and n != 'native']
    lab = label or sc.get('label') or 'Share'
    items = []
    if sc.get('native', True):
        items.append(f'<button type="button" class="cw-share-btn cw-share-native" data-share="native" aria-label="Share this page" hidden>'
                     f'{SHARE_ICONS["native"]}<span>Share</span></button>')
    for n in nets:
        if n == 'copy':
            items.append(f'<button type="button" class="cw-share-btn" data-share="copy" aria-label="Copy link to this page" title="Copy link">'
                         f'{SHARE_ICONS["copy"]}<span class="cw-share-txt">Copy link</span></button>')
            continue
        href = share_url(n, url, text)
        name = 'Share by email' if n == 'email' else f'Share on {SHARE_NAMES[n]}'
        ext = '' if n == 'email' else ' target="_blank" rel="nofollow noopener noreferrer"'
        items.append(f'<a class="cw-share-btn" data-share="{n}" href="{e(href)}"{ext} aria-label="{e(name)}" title="{e(name)}">{SHARE_ICONS[n]}</a>')
    return (f'<div class="cw-share{" " + cls if cls else ""}" role="group" aria-label="{e(lab)} this page" data-share-url="{e(url)}" data-share-text="{e(text)}">'
            f'<span class="cw-share-label">{e(lab)}</span>{"".join(items)}'
            f'<span class="cw-share-status sr" role="status" aria-live="polite"></span></div>')


# ------------------------------------------------------------------ blocks
def stats_strip(tiles, label='Summary'):
    """tiles: [(value, label, attrs_dict, dot_class|None, clickable)]."""
    out = []
    for value, lab, at, dot, click in tiles:
        d = f'<i class="dot {e(dot)}"></i>' if dot else ''
        tag = 'button' if click else 'div'
        extra = ' type="button" aria-pressed="false"' if click else ''
        out.append(f'<{tag} class="cw-stat"{extra}{attrs(at)}><b>{d}{e(value)}</b><span>{e(lab)}</span></{tag}>')
    return f'<section class="cw-stats" aria-label="{e(label)}">{"".join(out)}</section>'


def catbar(segments):
    """segments: [(n, color_class, title)]. No style="" (strict CSP): widths come from .fx-N classes (flex_classes),
    colors from the category classes (color_classes)."""
    return '<div class="cw-catbar" aria-hidden="true">' + ''.join(
        f'<i class="fx-{int(n)} {e(c)}" title="{e(t)}"></i>' for n, c, t in segments if n) + '</div>'


def flex_classes(ns):
    """CSS for catbar segment widths: [96, 10] -> '.fx-96{flex:96}.fx-10{flex:10}' (only the values the build uses)."""
    return ''.join(f'.fx-{int(n)}{{flex:{int(n)}}}' for n in sorted({int(n) for n in ns if n}))


def ad_slot_classes(cfg):
    """CSS for ad slot sizes (one rule per configured slot) so the markup needs no style="" attribute."""
    out = []
    for name, s in sorted((cfg.get('ad_slots') or {}).items()):
        if re.fullmatch(r'[a-z0-9-]+', name) and s:
            w, h = (s.get('size') or [728, 90])[:2]
            out.append(f'.cw-ad[data-ad-slot="{name}"]{{--ad-w:{int(w)}px;--ad-h:{int(h)}px}}')
    return ''.join(out)


def legend(items, tag='button'):
    """items: [(label, n, live, color_class, attrs_dict)] -> 'Social & forums 90 (85 live)'."""
    out = []
    for lab, n, live, color, at in items:
        extra = ' type="button" aria-pressed="false"' if tag == 'button' else ''
        out.append(f'<{tag}{extra}{attrs(at)}><i class="{e(color)}"></i>{e(lab)} <b>{n}</b> <span title="live">({live} live)</span></{tag}>')
    return '<div class="cw-legend">' + ''.join(out) + '</div>'


def info_box(dot, strong, muted, text_html):
    return (f'<div class="cw-identity"><div class="row"><i class="dot {e(dot)}"></i><strong>{e(strong)}</strong>'
            f'<span class="spacer muted">{e(muted)}</span></div><p>{text_html}</p></div>')


def hero(kicker, title, lead_html, box_html='', small=False, kicker_href=None):
    k = (f'<a class="kicker" href="{e(kicker_href)}">{e(kicker)}</a>' if kicker_href else f'<div class="kicker">{e(kicker)}</div>')
    return (f'<section class="cw-hero{" cw-hero-sm" if small else ""}"><div>{k}<h1>{e(title)}</h1>{lead_html}</div>{box_html}</section>')


def tabs(items, label='Categories', tag='button'):
    """items: [(label, count, attrs_dict, active)]"""
    out = []
    for lab, n, at, active in items:
        if tag == 'button':
            extra = f' type="button" aria-pressed="{"true" if active else "false"}"'
        else:
            extra = ' aria-current="page"' if active else ''
        out.append(f'<{tag}{extra}{attrs(at)}>{e(lab)}<span>{n}</span></{tag}>')
    return f'<div class="cw-tabs" role="group" aria-label="{e(label)}">{"".join(out)}</div>'


def tag_shelf(tags, shelf_id='tagcloud', href=None):
    """The 'козырек': clipped row of '#tag N' chips; '.open' expands it. tags: [(tag, count)]."""
    chips = ''.join(f'<button type="button" class="link-pill" data-tag="{e(t)}" aria-pressed="false">#{e(t)}<small>{n}</small></button>' for t, n in tags)
    return (f'<div class="cw-tagcloud" id="{e(shelf_id)}" role="group" aria-label="Tags">{chips}'
            f'<button class="text-btn cw-tags-more" type="button" aria-expanded="false" aria-controls="{e(shelf_id)}">all tags ({len(tags)}) ↓</button></div>')


def tag_chips(tags, href_for, limit=6):
    shown = ''.join(f'<a class="link-pill" href="{e(href_for(t))}" data-tag="{e(t)}">#{e(t)}</a>' for t in tags[:limit])
    more = f'<span class="more">+{len(tags) - limit}</span>' if len(tags) > limit else ''
    return f'<div class="card-tags">{shown}{more}</div>' if tags else ''


def card(*, href, name, cat_label, cat_color,  # cat_color: a CSS class such as 'k-social' (see color_classes)
         status_chip, desc, keynum='', tags_html='', preview='', closed=False, data=None, thumb=''):
    # thumb: optional HTML rendered first inside the card (e.g. a screenshot band <img>, or a placeholder)
    return (f'<article class="cw-card{" is-closed" if closed else ""}"{attrs(data)}>{thumb}'
            f'<div class="cw-meta"><span class="catchip"><i class="{e(cat_color)}"></i>{e(cat_label)}</span>{status_chip}</div>'
            f'<h3><a href="{e(href)}">{e(name)}</a></h3><p>{e(desc)}</p>{keynum}{tags_html}'
            + (f'<div class="preview">{preview}</div>' if preview else '') + '</article>')


def color_classes(pairs, prefix='k-'):
    """CSS for category color swatches: [(key, '#hex')] -> '.k-key{background:#hex}' rules (keeps markup small)."""
    return ''.join(f'.{prefix}{k}{{background:{c}}}' for k, c in pairs)


def ad_card(cfg, name):
    """Native sponsored card in the catalog card style. '' when the slot is disabled or empty without placeholder."""
    s = (cfg.get('ad_slots') or {}).get(name)
    if not s or not s.get('enabled'):
        return ''
    c = s.get('creative') or {}
    site = cfg.get('site') or {}
    if c.get('href'):
        href, title, text = c['href'], c.get('title') or 'Sponsor', c.get('text') or ''
    elif s.get('placeholder'):
        href = site.get('advertise_url') or (site.get('base_path', '') + '/about/#advertise')
        title, text = 'Your project here', 'A clearly marked sponsored card in the catalog. Sponsorship never changes what a card says or its order.'
    else:
        return ''
    ext = href.startswith('http')
    rel = 'sponsored nofollow noopener' if ext else 'sponsored nofollow'
    target = ' target="_blank"' if ext else ''
    return (f'<article class="cw-card cw-adcard" data-ad-card="{e(name)}" aria-label="Sponsored">'
            f'<div class="cw-meta"><span class="cw-ad-tag">Sponsored</span><span class="chip type">Ad</span></div>'
            f'<h3><a href="{e(href)}" rel="{rel}"{target}>{e(title)}</a></h3>'
            f'<p>{e(text)}</p></article>')


def ad_slot(cfg, name, cls=''):
    """Returns '' when the slot is missing, disabled, or empty without placeholder."""
    s = (cfg.get('ad_slots') or {}).get(name)
    if not s or not s.get('enabled'):
        return ''
    w, h = (s.get('size') or [728, 90])[:2]
    c = s.get('creative')
    if c and c.get('href'):
        img = (f'<img src="{e(c["image"])}" alt="{e(c.get("alt") or c.get("title") or "")}" width="{int(w)}" height="{int(h)}" loading="lazy" decoding="async">'
               if c.get('image') else
               f'<span class="cw-ad-copy"><b>{e(c.get("title"))}</b> <span>{e(c.get("text"))}</span></span>')
        inner = f'<a class="cw-ad-link" href="{e(c["href"])}" rel="sponsored nofollow noopener" target="_blank">{img}</a>'
    elif s.get('placeholder'):
        adv = (cfg.get('site') or {}).get('advertise_url') or ((cfg.get('site') or {}).get('base_path', '') + '/about/#advertise')
        inner = f'<a class="cw-ad-empty" href="{e(adv)}" rel="sponsored nofollow">Your ad here</a>'
    else:
        return ''
    c2 = f' {cls}' if cls else ''
    return (f'<aside class="cw-ad{c2}" data-ad-slot="{e(name)}" aria-label="Sponsored">'
            f'<span class="cw-ad-label">Sponsored</span>{inner}</aside>')


# Icons for the project's own official accounts (footer). X reuses the share icon.
OFFICIAL_ICONS = {
    'x': SHARE_ICONS['x'],
    'github': _si('<path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.3-.5-1.5.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>', True),
}
