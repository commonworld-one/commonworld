"""Simple dated Atlas overviews. No network, claim refresh, billing or publication.

This is the new editorial source. The old snapshot remains an immutable migration
input and an API v1 compatibility archive, not an editing form for this source.
"""
import copy
import hashlib
import html
import ipaddress
import math
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

VERSION = 'commonworld-atlas-overviews/1'
STATES = {'draft', 'held', 'reviewed'}
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,80}')


def utc(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
        return None
    try:
        return datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def source_url(value):
    if not isinstance(value, str) or any(ord(c) < 33 for c in value):
        return False
    try:
        u = urlsplit(value)
        if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password:
            return False
        host = u.hostname.lower().rstrip('.')
        if '.' not in host or host.endswith(('.local', '.internal', '.localhost')):
            return False
        try:
            if not ipaddress.ip_address(host).is_global:
                return False
        except ValueError:
            pass
        return True
    except ValueError:
        return False


def digest(record):
    """Review binds to the actual overview, source links, visit, screenshot and trials.

    Workflow state/history and editor notes are not publication content.
    """
    return hashlib.sha256(json.dumps({k: record.get(k) for k in
        ('text', 'visited_at', 'sources', 'screenshot', 'trials', 'prepared_by')},
        sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def public(record):
    """No audit notes, reviewer identifiers, private correspondence or history payload."""
    out = {k: copy.deepcopy(record.get(k)) for k in ('state', 'text', 'visited_at', 'sources')}
    out['revision'] = digest(record)
    if record.get('trials'):
        out['trials'] = [{k: copy.deepcopy(t[k]) for k in ('performed_at', 'service', 'action', 'result', 'access', 'proof_url') if k in t} |
            {'cost': ({'amount': t['cost']['amount'], 'currency': t['cost']['currency']} if t.get('cost') else None)} for t in record['trials']]
    return out


def problems(doc, cards, shots=None, publishable=False, now=None, complete=True):
    """Validate drafts honestly; a release additionally requires reviewed content.

    A different reviewer identifier is necessary, not evidence of independence.
    The human review process must establish the latter and inspect actual pixels.
    """
    bad = []
    now = now or datetime.now(timezone.utc)
    if doc.get('format') != VERSION or not isinstance(doc.get('cards'), dict):
        return ['invalid overview document format']
    known = {c['slug']: c for c in cards}
    records = doc['cards']
    extra = set(records) - set(known)
    if extra:
        bad.append('unrecognised overview slugs: ' + ', '.join(sorted(extra)))
    missing = {s for s, c in known.items() if c.get('status') == 'live'} - set(records)
    if missing and complete:
        bad.append(f'{len(missing)} active cards have no overview draft')
    for slug, r in records.items():
        prefix = slug + ': '
        if not SLUG.fullmatch(slug) or not isinstance(r, dict):
            bad.append(prefix + 'invalid record'); continue
        if r.get('state') not in STATES:
            bad.append(prefix + 'invalid state')
        if not isinstance(r.get('text'), str) or not r['text'].strip():
            bad.append(prefix + 'overview text is required')
        urls = r.get('sources')
        if not isinstance(urls, list) or not urls or not all(source_url(u) for u in urls):
            bad.append(prefix + 'public HTTP(S) source URLs required')
        visit = utc(r.get('visited_at'))
        if r.get('visited_at') is not None and not visit:
            bad.append(prefix + 'invalid visit time (UTC required)')
        if visit and visit > now:
            bad.append(prefix + 'visit cannot be in the future')
        if not isinstance(r.get('sources'), list):
            continue
        if not isinstance(r.get('trials', []), list):
            bad.append(prefix + 'trials must be a list'); continue
        for t in r.get('trials', []):
            if not isinstance(t, dict):
                bad.append(prefix + 'invalid actual trial'); continue
            if not all(t.get(k) for k in ('performed_at', 'service', 'action', 'result', 'access')) or not utc(t.get('performed_at')):
                bad.append(prefix + 'trial requires actual date, service, action, access and result')
            if utc(t.get('performed_at')) and utc(t['performed_at']) > now:
                bad.append(prefix + 'trial cannot be in the future')
            if not source_url(t.get('proof_url')):
                bad.append(prefix + 'trial requires a public evidence URL')
            cost = t.get('cost')
            if cost is not None and (not isinstance(cost, dict) or
                not isinstance(cost.get('amount'), (int, float)) or isinstance(cost.get('amount'), bool) or
                cost['amount'] < 0 or not math.isfinite(cost['amount']) or not cost.get('currency')):
                bad.append(prefix + 'actual cost is null or a nonnegative amount with currency')
        if publishable and r.get('state') != 'reviewed':
            bad.append(prefix + 'not reviewed for release')
        if r.get('state') != 'reviewed':
            continue
        if not visit:
            bad.append(prefix + 'reviewed overview needs an actual whole-card visit')
        if not r.get('prepared_by'):
            bad.append(prefix + 'preparer missing')
        receipt = r.get('check') or {}
        if not receipt.get('by') or receipt.get('by') == r.get('prepared_by'):
            bad.append(prefix + 'separate final-content reviewer missing')
        if receipt.get('revision') != digest(r):
            bad.append(prefix + 'review receipt is stale or absent')
        checked = utc(receipt.get('checked_at'))
        if not checked or checked > now or (visit and checked < visit):
            bad.append(prefix + 'invalid final check date')
        shot = r.get('screenshot') or {}
        actual = (shots or {}).get(slug) or {}
        if not actual or shot.get('sha256') != actual.get('sha256') or not shot.get('sha256'):
            bad.append(prefix + 'reviewed screenshot is missing or differs from the pinned image')
        if shot.get('source_url') != actual.get('source_url') or not source_url(shot.get('source_url')):
            bad.append(prefix + 'screenshot source URL differs from manifest')
        if shot.get('captured_at') != actual.get('captured_at') or not utc(shot.get('captured_at')):
            bad.append(prefix + 'screenshot capture time differs from manifest')
        if not shot.get('pixels_checked') or not shot.get('matches_overview'):
            bad.append(prefix + 'clean screenshot and correspondence review missing')
    return bad


def attach(site, doc, allow_drafts=False, expected=None):
    bad = problems(doc, site.cards, site.shots, publishable=not allow_drafts, complete=False)
    if bad:
        raise ValueError('; '.join(bad[:8]) + (f'; {len(bad)} total' if len(bad) > 8 else ''))
    if not allow_drafts:
        if expected is None or set(expected) != set(doc['cards']):
            raise ValueError('accepted build requires an explicit batch selection matching the overview IDs exactly')
        hosts = (site.safety or {}).get('hosts', {})
        for slug, r in doc['cards'].items():
            c = next(c for c in site.cards if c['slug'] == slug)
            urls = list(r['sources']) + [c.get('canonical_url')] + [t.get('proof_url') for t in r.get('trials', [])]
            for u in filter(None, urls):
                host = urlsplit(u).hostname.lower().removeprefix('www.').rstrip('.')
                if (hosts.get(host) or {}).get('status') != 'clean':
                    raise ValueError(slug + ': source domain lacks a clean safety result: ' + host)
    site.catalogue_mode = True
    site.overviews = doc['cards']
    site.overview_preview = allow_drafts
    for c in site.cards:
        if c['slug'] in site.overviews:
            c['_overview'] = site.overviews[c['slug']]


def draft_notice(record):
    if record.get('state') == 'reviewed':
        return ''
    detail = ('A source visit is recorded; separate final-content and screenshot review is still pending.'
              if record.get('visited_at') else
              'No whole-card visit is recorded for this draft; it is not an accepted current overview.')
    return '<p class="overview-draft" role="note"><b>Draft, not ready for publication.</b> ' + detail + '</p>'


def relationship_disclosure(c):
    """Current relationship only; full historical disclosure stays in source data."""
    return c.get('disclosure_current', c.get('disclosure', ''))


def share_text(c):
    """Source-neutral payload, independent of legacy claims/status/badges."""
    return c['name'] + ' on Commonworld Atlas'


def render_html(site, c, b):
    """One source for human HTML and Markdown. Callbacks keep site chrome central."""
    r = c['_overview']
    e, link = html.escape, b.ext_link
    crumbs, crumb_ld = b.breadcrumbs(site, [('Atlas', site.base + '/'),
        (b.CAT_LABEL[c['category']], site.base + '/categories/' + c['category'] + '/'), (c['name'], c['_url'])])
    pending = r['state'] != 'reviewed'
    note = draft_notice(r)
    date = b.time_tag(b.parse_time(r.get('visited_at'))) if r.get('visited_at') else 'Not yet recorded for this overview'
    source_links = ''.join('<li>' + link(u, e(u)) + '</li>' for u in r['sources'])
    trials = ''
    if r.get('trials'):
        trials = '<section class="cw-panel"><div class="cw-panel-body"><h2>What we tried</h2>'
        for t in r['trials']:
            cost = t.get('cost')
            cost_text = str(cost['amount']) + ' ' + cost['currency'] if cost else 'not recorded'
            trials += (f'<h3>{e(t["service"])}</h3><p>{e(t["action"])}</p><p>{e(t["result"])}</p>'
                       f'<p class="muted">{e(t["performed_at"])} · {e(t["access"])} · Actual cost: {e(cost_text)} · '
                       + link(t['proof_url'], 'Evidence') + '</p>')
        trials += '</div></section>'
    disclosure = '<p class="disclosure-box">' + e(relationship_disclosure(c)) + '</p>' if relationship_disclosure(c) else ''
    website = c.get('canonical_url')
    visit = link(website, 'Visit ' + e(b.domain(website)) + ' ↗', 'cw-btn cw-btn-primary') if website else ''
    compat = site.base + '/platforms/' + c['slug'] + '.json'
    share = b.cw.share_bar(site.cfg, site.abs(c['_url']), share_text(c), cls='cw-share-head')
    body = f'''{crumbs}<article class="entry simple-overview">
<header class="entry-head"><div class="cw-meta"><a class="catchip" href="{site.base}/categories/{c['category']}/">{e(b.CAT_LABEL[c['category']])}</a></div>
<h1>{e(c['name'])}</h1>{note}<p class="overview-date">Visit for this overview: {date}</p>
<p class="cw-lead">{e(r['text'])}</p>{disclosure}<div class="entry-actions"><p class="actions">{visit}</p>{share}</div></header>
{b.cw.ad_slot(site.cfg, 'atlas-platform-top', 'cw-ad-banner')}
{b.shot_figure(site, c)}{trials}
<section class="cw-panel"><div class="cw-panel-body"><h2>Sources</h2><ul>{source_links}</ul></div></section>
</article>'''
    body = body.replace("</a>. '\n", '</a>.\n')
    date_obj = b.parse_time(r.get('visited_at'))
    ld = [crumb_ld, {'@context': 'https://schema.org', '@type': 'WebPage', 'name': c['name'],
          'url': site.abs(c['_url']), 'description': r['text'],
          **({'lastReviewed': r['visited_at']} if not pending and r.get('visited_at') else {})}]
    return b.page(site, path=c['_url'], title=b.fit_title(c['name'] + ' | Commonworld Atlas'),
        description=b.trim(r['text'], 160), body=body, active='in:' + c['category'],
        ld=ld, lastmod=date_obj, noindex=pending,
        alt_json=site.abs(compat), alt_md=c['_url'] + 'index.md',
        og=b.og_generic(site, c['slug'], c['name'], r['text'],
            [('Dated overview', 'olive')], kicker=b.CAT_LABEL[c['category']].upper(),
            alt=c['name'] + ': dated overview in Commonworld Atlas',
            foot=('Overview visit ' + b.fmt_date(date_obj)) if date_obj else 'Overview date not established'))


def render_md(site, c):
    r = c['_overview']
    lines = ['# ' + c['name'], '', 'Canonical page: ' + site.abs(c['_url']), '',
        'Draft, not ready for publication.' if r['state'] != 'reviewed' else 'Dated overview', '',
        'Visit for this overview: ' + (r.get('visited_at') or 'Not yet recorded for this overview'), '', r['text'], '',
        '## Sources', ''] + ['- ' + u for u in r['sources']]
    if relationship_disclosure(c):
        lines += ['', relationship_disclosure(c)]
    shot = site.shots.get(c['slug'])
    if shot:
        lines += ['', 'Screenshot captured: ' + shot['captured_at'],
                  'Screenshot: ' + site.abs(site.base + '/screens/' + c['slug'] + '.webp')]
    else:
        lines += ['', 'Screenshot missing. Publication is blocked.']
    if r.get('trials'):
        lines += ['', '## What we tried', '']
        for t in r['trials']:
            cost = t.get('cost')
            lines += [t['service'] + ': ' + t['action'], t['result'],
                t['performed_at'] + ' · ' + t['access'] + ' · Actual cost: ' +
                (str(cost['amount']) + ' ' + cost['currency'] if cost else 'not recorded'), t['proof_url'], '']
    lines += ['', 'Data licence: ' + (site.cfg.get('data_licence') or 'see the site') + '.']
    return '\n'.join(lines) + '\n'
