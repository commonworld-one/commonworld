"""Bounded source-attempt presentation, separate from accepted dated overviews."""
from datetime import date, datetime, timezone
import html
import re
import overviews

CHIP = '<span class="chip limited">Could not verify</span>'
NOTE = 'This records a limited source check, not a completed overview or a permanent-closure decision.'


def attach(site, doc):
    if doc.get('format') != 'commonworld-atlas-limitations/1' or not isinstance(doc.get('cards'), dict):
        raise ValueError('invalid limitations source')
    known = {c['slug']: c for c in site.cards}
    records = doc['cards']
    for slug, r in records.items():
        if slug not in known or slug in getattr(site, 'overviews', {}):
            raise ValueError('limitation ID unknown or overlaps accepted overview: ' + slug)
        if r.get('state') != 'could_not_verify' or not r.get('text'):
            raise ValueError('invalid bounded limitation: ' + slug)
        day = r.get('attempted_on', '')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) or date.fromisoformat(day) > datetime.now(timezone.utc).date():
            raise ValueError('invalid attempt date: ' + slug)
        if not r.get('sources') or not all(overviews.source_url(u) for u in r['sources']):
            raise ValueError('checked source addresses required: ' + slug)
        known[slug]['_limitation'] = r
    site.limitations = records


def render_html(site, c, b):
    r = c['_limitation']
    e = html.escape
    crumbs, crumb_ld = b.breadcrumbs(site, [('Atlas', site.base + '/'),
        (b.CAT_LABEL[c['category']], site.base + '/categories/' + c['category'] + '/'), (c['name'], c['_url'])])
    links = ''.join('<li>' + b.ext_link(u, e(u)) + '</li>' for u in r['sources'])
    share = b.cw.share_bar(site.cfg, site.abs(c['_url']), overviews.share_text(c), cls='cw-share-head')
    body = f'''{crumbs}<article class="entry simple-overview limited-entry">
<header class="entry-head"><div class="cw-meta"><a class="catchip" href="{site.base}/categories/{c['category']}/">{e(b.CAT_LABEL[c['category']])}</a>{CHIP}</div>
<h1>{e(c['name'])}</h1><p class="overview-date">Source check attempted: <time datetime="{r['attempted_on']}">{r['attempted_on']}</time></p>
<p class="cw-lead">{e(r['text'])}</p><p class="muted">{NOTE}</p>
<div class="entry-actions">{share}</div></header>
<section class="cw-panel"><div class="cw-panel-body"><h2>Addresses checked</h2><ul>{links}</ul></div></section>
</article>'''
    ld = [crumb_ld, {'@context': 'https://schema.org', '@type': 'WebPage', 'name': c['name'],
        'url': site.abs(c['_url']), 'description': r['text']}]
    return b.page(site, path=c['_url'], title=b.fit_title(c['name'] + ' | Commonworld Atlas'),
        description=b.trim(c['name'] + ': ' + r['text'], 160), body=body, active='in:' + c['category'], ld=ld,
        alt_json=site.abs(site.base + '/platforms/' + c['slug'] + '.json'), alt_md=c['_url'] + 'index.md',
        og=b.og_generic(site, c['slug'], c['name'], r['text'], [('Could not verify', 'olive')],
            kicker=b.CAT_LABEL[c['category']].upper(), foot='Source check attempted ' + r['attempted_on'],
            alt=c['name'] + ': source check could not confirm current overview'))


def render_md(site, c):
    r = c['_limitation']
    return '\n'.join(['# ' + c['name'], '', 'Canonical page: ' + site.abs(c['_url']), '',
        'Could not verify', '', 'Source check attempted: ' + r['attempted_on'], '', r['text'], '', NOTE,
        '', '## Addresses checked', ''] + ['- ' + u for u in r['sources']] + [''])
