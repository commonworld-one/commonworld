"""One current earning selection for HTML, card markers and agent data. No money figures."""
import hashlib
import html
import json

LEAD = 'Explore work, services, tools, prizes, tips and other earning-related projects described in current Atlas overviews.'
CAUTION = 'Inclusion is not proof of payment, open work or eligibility. Some entries are tools, indexes, token models or projects whose payment terms remain unclear. Read each dated overview for conditions and risks.'
FORMAT = 'commonworld-atlas-earning-opportunities/1'


def attach(site, path):
    with open(path) as fh:
        doc = json.load(fh)
    if doc.get('format') != 'commonworld-atlas-earning-selection/1':
        raise ValueError('invalid earning selection format')
    known = {c['slug']: c for c in site.cards}
    site.earning_rows = []
    for slug, row in doc['cards'].items():
        # A safety removal may remove a formerly selected record. Never reintroduce it.
        if slug not in known:
            continue
        c = known[slug]
        current = c.get('_overview')
        if not current:
            raise ValueError(slug + ': earning selection requires a current overview')
        bound = {k: current.get(k) for k in ('text', 'visited_at', 'sources')}
        digest = hashlib.sha256(json.dumps(bound, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        if row.get('overview_sha256') != digest or not row.get('description', '').strip():
            raise ValueError(slug + ': stale or missing earning explanation; review against current overview')
        c['_earning'] = {'description': row['description'], 'visited_at': current['visited_at'], 'sources': current['sources']}
        site.earning_rows.append(c)
    site.earning_rows.sort(key=lambda c: (c['name'].casefold(), c['slug']))


def public_marker(site, c):
    r = c.get('_earning')
    return {'included': True, 'url': site.abs(site.base + '/earn/')} if r else None


def record(site, c):
    return {'id': c['slug'], 'name': c['name'], 'url': site.abs(c['_url']),
            'json_url': site.abs(site.base + '/platforms/' + c['slug'] + '.json'),
            'category': c['category'], **c['_earning']}


def marker_html(site, c):
    r = c.get('_earning')
    if not r:
        return ''
    return ('<div class="cw-panel earning-marker" data-earning-opportunity="true"><div class="cw-panel-body">'
            '<h2><a href="' + site.base + '/earn/">Where agents get paid</a></h2><p>' + html.escape(r['description']) +
            '</p><p class="muted">Included in the broad earning-related list, not a payment or eligibility guarantee.</p></div></div>')


def render(site, b):
    e = html.escape
    rows = site.earning_rows
    crumbs, crumb_ld = b.breadcrumbs(site, [('Atlas', site.base + '/'), ('Where agents get paid', site.base + '/earn/')])
    box = b.cw.info_box('live', str(len(rows)) + ' Atlas cards', 'From current overviews',
                        'One list, not a separate money database. Different earning routes, with conditions and uncertainties kept visible.')
    body = crumbs + b.cw.hero('Atlas · earning opportunities', 'Where agents get paid', '<p>' + LEAD + '</p><p>' + CAUTION + '</p>', box, small=True, kicker_href=site.base + '/')
    body += b.cw.share_bar(site.cfg, site.abs(site.base + '/earn/'), 'Where AI agents get paid | Commonworld Atlas', cls='cw-share-earn')
    body += '<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Explore opportunities</h2><span class="muted">' + str(len(rows)) + ' cards</span></div><div class="cw-panel-body"><p class="sec-desc">Ordered by project name, not by income. Open a card for the full dated overview.</p><div class="table-wrap"><table class="list earn earning-current"><thead><tr><th scope="col">Project</th><th scope="col">How agents can get paid</th><th scope="col">Visit</th><th scope="col">Source</th></tr></thead><tbody>'
    for c in rows:
        r = c['_earning']
        sources = b.ext_link(r['sources'][0], 'Project source ↗')
        if len(r['sources']) > 1:
            sources += '<br><a class="muted" href="' + c['_url'] + '#earning-sources">All ' + str(len(r['sources'])) + ' sources in card</a>'
        body += ('<tr data-earning-id="' + e(c['slug']) + '"><td><a class="earning-project" href="' + c['_url'] + '">' + e(c['name']) + '</a><br><a class="catchip" href="' + site.base + '/categories/' + c['category'] + '/"><i class="k-' + c['category'] + '"></i>' + e(b.CAT_SHORT[c['category']]) + '</a></td><td><p>' + e(r['description']) + '</p></td><td class="earning-visit">' + b.time_tag(b.parse_time(r['visited_at'])) + '</td><td>' + sources + '</td></tr>')
    body += '</tbody></table></div></div></section><p class="sec-desc">The visit dates belong to the source overviews, not to a payment test. No income ranking, currency conversion or total earnings are calculated. <a href="' + site.base + '/earn.json">Read the same list as JSON</a>.</p>'
    latest = max((b.parse_time(c['_earning']['visited_at']) for c in rows), default=None)
    ld = [crumb_ld, {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': 'Where agents get paid', 'url': site.abs(site.base + '/earn/'), 'description': LEAD + ' ' + CAUTION, 'mainEntity': b.item_list_ld(site, rows, 'Where agents get paid')}]
    return b.page(site, path=site.base + '/earn/', title='Where agents get paid | Commonworld Atlas', description=LEAD,
                  body=body, active='earn', ld=ld, lastmod=latest,
                  og=b.og_generic(site, 'page-earn', 'Where agents get paid', 'Earning-related projects from dated source overviews. Not verified payouts.', [(str(len(rows)) + ' Atlas cards', 'olive')], kicker='EARNING OPPORTUNITIES'))


def write_json(site, write, b):
    rows = [record(site, c) for c in site.earning_rows]
    out = {'format': FORMAT, 'name': 'Commonworld Atlas: Where agents get paid', 'url': site.abs(site.base + '/earn/'),
           'generated_at': b.iso(site.generated), 'source_snapshot_at': b.iso(site.source_generated), 'licence': site.cfg.get('data_licence') or 'not yet specified',
           'fields_note': CAUTION + ' Alphabetical order. Dates and sources come from the same current overviews as the HTML cards. This format replaces the former numeric money-row contract; no historical money rows are included.',
           'count': len(rows), 'rows': rows}
    write(site.base + '/earn.json', json.dumps(out, ensure_ascii=False, indent=1) + '\n')
    site.api_docs.append(('/atlas/earn.json', out, 'earn.schema.json', True))
