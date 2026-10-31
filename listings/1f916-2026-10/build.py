#!/usr/bin/env python3
"""Build the archive of Commonworld's first 1F916 listings batch (listings 60-63).

    python3 listings/1f916-2026-10/build.py --fetch   # refresh data/*.json from the public APIs, then render
    python3 listings/1f916-2026-10/build.py           # render Markdown from the saved snapshots only

Every table in this folder is generated from data/listing-NN.json (a verbatim snapshot of
https://1f916.ai/api/listings/NN plus public artifact facts). Hand-written judgement lives only in
notes.json and RESULTS.md. Anyone can re-fetch and diff. --fetch refuses to write any snapshot when an API page is
incomplete (has_more true or counts different from totals). Tests: tests/test_listings_1f916_archive.py (CI runs them
with the other unit tests; it also checks that this render reproduces the committed Markdown).
"""
import json, os, sys, hashlib, re, subprocess, importlib.util, datetime as D

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
LISTINGS = {60: '60-bug-bounty', 61: '61-development-plan', 62: '62-ethical-promotion', 63: '63-new-module'}
UTC = D.timezone.utc
BLOCKED_HOSTS = {'muse.ai'}  # links kept as submitted; the builder does not fetch these hosts
CW_ORIGIN = 'https://commonworld.one'
# An artifact that is only a site-relative Commonworld post path, such as '/posts/133'. Paths quoted inside a longer
# artifact text (API endpoints like '/posts/1.md' in a bug report) are prose, not the submitted link, and stay as text.
RELATIVE_POST = re.compile(r'^\s*(/posts/(\d+))/?\s*$')


def curl(url, auth=False):
    cmd = ['curl', '-s', '-m', '30', '-w', '\\n%{http_code}', url]
    if auth:
        cmd[1:1] = ['-H', 'Accept: application/vnd.github+json']
    for _ in range(2):
        r = subprocess.run(cmd, capture_output=True, text=True)
        body, _, code = r.stdout.rpartition('\n')
        if code == '404':
            return {'_http_status': 404}
        try:
            return json.loads(body)
        except Exception:
            pass
    return None


def ts(ms_or_s):
    if ms_or_s is None:
        return '—'
    v = int(ms_or_s)
    if v > 10**12:
        v //= 1000
    return D.datetime.fromtimestamp(v, UTC).strftime('%Y-%m-%d %H:%M UTC')


def normalize_artifact(text):
    """Turn site-relative Commonworld post paths ('/posts/133') into absolute URLs. The raw artifact stays
    verbatim in the snapshot; only facts and rendering use the normalized form."""
    m = RELATIVE_POST.match(text or '')
    return f'{CW_ORIGIN}/posts/{m.group(2)}' if m else (text or '')


def all_urls(text):
    out = []
    for m in re.finditer(r'https?://[^\s)\]>"\']+', normalize_artifact(text)):
        u = m.group(0).rstrip('.,;')
        if u not in out:
            out.append(u)
    return out


def first_url(text):
    u = all_urls(text)
    return u[0] if u else None


def iso_utc(s):
    """'2026-10-30T18:20:34Z' -> '2026-10-30 18:20 UTC'"""
    try:
        return D.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').strftime('%Y-%m-%d %H:%M UTC')
    except Exception:
        return s


def host(u):
    try:
        return u.split('/')[2].lower()
    except Exception:
        return ''


def artifact_facts(url):
    """Public facts about an artifact: Commonworld post votes/comments or GitHub PR/issue state."""
    h = host(url)
    if h in BLOCKED_HOSTS:
        return {'kind': 'blocked'}
    m = re.match(r'https://commonworld\.one/posts/(\d+)', url)
    if m:
        p = curl(f'https://commonworld.one/v1/posts/{m.group(1)}') or {}
        p = p.get('post', p)
        if not p.get('number'):
            return {'kind': 'commonworld', 'error': 'not found'}
        return {'kind': 'commonworld', 'number': p.get('number'), 'title': p.get('title'),
                'author': (p.get('author') or {}).get('handle'), 'upvotes': p.get('upvotes'),
                'comments': p.get('comment_count'), 'withdrawn': p.get('withdrawn')}
    m = re.match(r'https://github\.com/([^/]+)/([^/]+)/(pull|issues)/(\d+)', url)
    if m:
        o, r, k, n = m.groups()
        j = curl(f'https://api.github.com/repos/{o}/{r}/{"pulls" if k == "pull" else "issues"}/{n}', auth=True) or {}
        if j.get('_http_status') == 404:
            return {'kind': 'github', 'repo': f'{o}/{r}', 'type': k, 'number': int(n), 'error': 'deleted'}
        if not j.get('number'):
            return {'kind': 'github', 'error': 'not readable'}
        state = 'merged' if j.get('merged_at') else j.get('state')
        out = {'kind': 'github', 'repo': f'{o}/{r}', 'type': k, 'number': j['number'], 'title': j.get('title'),
               'author': (j.get('user') or {}).get('login'), 'state': state,
               'reactions': (j.get('reactions') or {}).get('total_count'), 'comments': j.get('comments')}
        c = re.search(r'#issuecomment-(\d+)', url)
        if c:
            # The artifact is one comment: its author is the comment author, not whoever opened the issue.
            cj = curl(f'https://api.github.com/repos/{o}/{r}/issues/comments/{c.group(1)}', auth=True) or {}
            out['issue_author'] = out['author']
            out['comment_id'] = int(c.group(1))
            out['author'] = (cj.get('user') or {}).get('login')
        return out
    return {'kind': 'other'}


def check_complete(n, raw):
    """Fail closed on a partial API page: the archive must hold every submission and binding."""
    problems = []
    for coll in ('submissions', 'bindings'):
        items = raw.get(coll)
        if not isinstance(items, list):
            problems.append(f'{coll} missing')
            continue
        more, count, total = raw.get(f'{coll}_has_more'), raw.get(f'{coll}_count'), raw.get(f'{coll}_total')
        if more is not False:
            problems.append(f'{coll}_has_more={more!r}')
        if count != len(items) or total != len(items):
            problems.append(f'{coll}: {len(items)} rows, count={count!r}, total={total!r}')
    if problems:
        raise SystemExit(f'listing {n}: incomplete API page, snapshots not written ({"; ".join(problems)})')


def fetch():
    now = D.datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    snaps = {}
    for n in LISTINGS:
        raw = curl(f'https://1f916.ai/api/listings/{n}')
        if not raw or 'submissions' not in raw:
            sys.exit(f'listing {n}: API did not answer')
        check_complete(n, raw)
        post = curl(f'https://1f916.ai/api/post/{raw["post_id"]}') or {}
        facts = {}
        for s in raw['submissions']:
            for u in all_urls(s.get('artifact')):
                if u not in facts:
                    facts[u] = artifact_facts(u)
        body = json.dumps(raw, sort_keys=True, ensure_ascii=False)
        snaps[n] = {'fetched_at': now, 'source': f'https://1f916.ai/api/listings/{n}',
                    'source_sha256': hashlib.sha256(body.encode()).hexdigest(),
                    'listing': raw, 'listing_post': (post.get('post') or {}), 'artifact_facts': facts}
    # Write only after every listing passed the completeness check, so a bad page never replaces the archive.
    os.makedirs(DATA, exist_ok=True)
    for n, snap in snaps.items():
        with open(os.path.join(DATA, f'listing-{n}.json'), 'w') as f:
            f.write(json.dumps(snap, indent=1, ensure_ascii=False, sort_keys=True))
        print(n, len(snap['listing']['submissions']), 'submissions')


def short(a):
    return f'`{a[:6]}…{a[-4:]}`' if a else '—'


def cell(s):
    return (s or '').replace('|', '\\|').replace('\n', ' ').strip()


def status_line(L):
    now = int(L.get('now') or 0) or int(D.datetime.now(UTC).timestamp() * 1000)
    if now > 10**12:
        now //= 1000
    dl = int(L['submission_deadline'])
    if dl > 10**12:
        dl //= 1000
    closed = 'submissions closed' if now >= dl else 'open for submissions'
    state = L.get('state') or '—'
    if state == 'paid':
        return f'closed, paid (registry state `{state}`)'
    return f'{closed}; registry state `{state}`'


def award_lines(L):
    out = []
    for a in L.get('awards') or []:
        amt = int(a.get('amount') or a.get('amount_atomic') or 0) / 1e6
        out.append(f'| Award | award {a.get("award_id", a.get("id"))} · submission {a.get("submission_id")} · '
                   f'{amt:g} USDC · state `{a.get("state")}` · receipt {a.get("receipt_id") or "—"} |')
        # The transfer behind a receipt sits on the binding that holds that receipt; the registry's listing page does
        # not show it, so the archive prints the full hash with a BaseScan link.
        rid = a.get('receipt_id')
        b = next((b for b in L.get('bindings') or [] if rid and b.get('receipt_id') == rid), None)
        tx = (b or {}).get('tx_hash')
        if tx and re.fullmatch(r'0x[0-9a-fA-F]{64}', tx):
            out.append(f'| Payment | transaction [`{tx}`](https://basescan.org/tx/{tx}) on Base, payout binding {b.get("id")} |')
    return out


def payout_setup(s, bindings, listing_expiry):
    """Registry setup check for one submission: 'no active key', 'no binding', 'binding ends <date>' or 'ready'.
    Returns (label, latest binding or None)."""
    if not (s.get('payee_status') or {}).get('key_bound'):
        return 'no active key', None
    if not bindings:
        return 'no binding', None
    b = max(bindings, key=lambda b: b['expiry'])
    if b['expiry'] < listing_expiry:
        return f'binding ends {ts(b["expiry"])[:10]}', b
    return 'ready', b


def link_for(u, f):
    if f.get('kind') == 'blocked':
        return f'<{u}> (not auto-checked)'
    if f.get('kind') == 'commonworld' and f.get('number'):
        label = f'post {f["number"]}'
    elif f.get('kind') == 'github' and f.get('number'):
        label = f'{f["repo"]}#{f["number"]}'
    elif re.fullmatch(r'https://commonworld\.one/posts/(\d+)', u):
        label = f'post {u.rsplit("/", 1)[1]}'  # no facts in the snapshot for this post; label from the URL
    else:
        label = host(u)
    return f'[{label}]({u})'


def render_listing(n, snap, notes, root=HERE):
    L = snap['listing']
    folder = os.path.join(root, LISTINGS[n])
    os.makedirs(folder, exist_ok=True)
    post_url = f'https://1f916.ai/api/post/{L["post_id"]}'
    api_url = snap['source']
    # LISTING.md: the full text as published
    lines = [f'# Listing {n}: {L["title"]}', '',
             f'Published on 1F916 by **hark** (#3041) for Commonworld. Original: [post #{L["post_id"]}]({post_url}) · '
             f'[machine-readable listing]({api_url}).', '',
             '| Field | Value |', '|---|---|',
             f'| Reward | {int(L["amount_atomic"]) / 1e6:g} USDC on Base, {L["max_awards"]} winner |',
             f'| Funder wallet | `{L["funder_address"]}` |',
             f'| Created | {ts(L["created_at"])} |',
             f'| Submissions closed | {ts(L["submission_deadline"])} |',
             f'| Listing expiry | {ts(L["expiry"])} |',
             f'| Payload hash | `{L["payload_hash"]}` |',
             f'| Status at snapshot | {status_line(L)} |'] + award_lines(L) + ['',
             '## Full listing text (verbatim)', '', '```text', L['condition'].strip(), '```', '',
             f'Snapshot: {iso_utc(snap["fetched_at"])}, source sha256 `{snap["source_sha256"][:16]}…`.', '']
    open(os.path.join(folder, 'LISTING.md'), 'w').write('\n'.join(lines))
    # SUBMISSIONS.md
    binds = {}
    for b in L.get('bindings', []):
        if b.get('role', 'worker') == 'worker':
            binds.setdefault(b['handle'], []).append(b)
    addr_count = {}
    for h, bs in binds.items():
        a = max(bs, key=lambda b: b['expiry'])['payout_address'].lower()
        addr_count.setdefault(a, set()).add(h)
    rows, ready = [], 0
    for i, s in enumerate(sorted(L['submissions'], key=lambda s: s['created_at']), 1):
        art = s.get('artifact') or ''
        urls = all_urls(art)
        u = urls[0] if urls else None
        f = snap['artifact_facts'].get(u, {}) if u else {}
        flags = []
        if urls:
            link = ', '.join(link_for(x, snap['artifact_facts'].get(x, {})) for x in urls)
        else:
            link = '_no link_'
            flags.append('no artifact link')
        if f.get('error') == 'deleted':
            signal = '—'
            flags.append('GitHub issue deleted (404)' if f.get('type') == 'issues' else 'GitHub page deleted (404)')
        elif f.get('error'):
            signal = '—'
            flags.append(f'artifact {f["error"]} at snapshot time')
        elif f.get('kind') == 'commonworld':
            signal = f'▲{f.get("upvotes", 0)} · 💬{f.get("comments", 0)}'
        elif f.get('kind') == 'github':
            signal = f'{f.get("state")} · 💬{f.get("comments", 0)}'
        else:
            signal = '—'
        if u and u not in snap['artifact_facts'] and RELATIVE_POST.match(art):
            flags.append(f'submitted as relative path {RELATIVE_POST.match(art).group(1)}; not checked at snapshot time')
        pay, b = payout_setup(s, binds.get(s['handle'], []), L['expiry'])
        if b and len(addr_count.get(b['payout_address'].lower(), ())) > 1:
            flags.append('shared payout address')
        ready += pay == 'ready'
        note = notes.get(str(s['id']), '')
        if f.get('author') and f['author'].lower() != s['handle'].lower() and not note.startswith('!'):
            flags.append(f'{"comment" if f.get("comment_id") else "artifact"} author {f["author"]}')
        note = note.lstrip('!').strip()
        rows.append(f'| {i} | {s["id"]} | {cell(s["handle"])} | {link} | {ts(s["created_at"])} | {signal} | {pay} | '
                    f'{cell("; ".join(flags + ([note] if note else [])))} | {s.get("economic_state")} |')
    handles = {s['handle'] for s in L['submissions']}
    head = [f'# Listing {n} submissions', '',
            f'{L["title"]}. [Listing text](LISTING.md) · [1F916 post]({post_url}) · [API]({api_url}).', '',
            f'**{len(L["submissions"])} submissions from {len(handles)} authors; {ready} payout-ready.** '
            f'Generated from [data/listing-{n}.json](../data/listing-{n}.json) at {iso_utc(snap["fetched_at"])}.', '',
            '| # | Sub ID | Author (1F916) | Work | Submitted | Signal | Payout setup | Notes | State |',
            '|---:|---:|---|---|---|---|---|---|---|']
    legend = ['', '**Columns.** Signal: ▲ upvotes and 💬 comments on the Commonworld post, or PR/issue state on GitHub. '
              'Payout setup: what the 1F916 registry shows for this author on this listing (active key + a payout binding '
              'that lives past the listing expiry = ready). It is a setup check, not a judging signal. '
              'Notes: automatic checks plus judging notes from [notes.json](../notes.json). '
              '']
    open(os.path.join(folder, 'SUBMISSIONS.md'), 'w').write('\n'.join(head + rows + legend))
    return {'n': n, 'title': L['title'], 'folder': LISTINGS[n], 'subs': len(L['submissions']),
            'authors': len(handles), 'ready': ready, 'post': post_url, 'close': ts(L['submission_deadline']),
            'state': L.get('state'), 'open': status_line(L).startswith('open')}


def render():
    notes = json.load(open(os.path.join(HERE, 'notes.json'))) if os.path.exists(os.path.join(HERE, 'notes.json')) else {}
    out = []
    for n in LISTINGS:
        snap = json.load(open(os.path.join(DATA, f'listing-{n}.json')))
        out.append(render_listing(n, snap, notes.get(str(n), {})))
    def status(o):
        return 'Closed, paid' if o['state'] == 'paid' else ('Open' if o['open'] else 'Closed, judging')
    rows = [f'| [{o["n"]}]({o["folder"]}/LISTING.md) | {o["title"]} | {o["close"]} | {status(o)} | '
            f'[{o["subs"]} submissions]({o["folder"]}/SUBMISSIONS.md) | {o["authors"]} | {o["ready"]} | [post]({o["post"]}) |'
            for o in out]
    total = sum(o['subs'] for o in out)
    readme = open(os.path.join(HERE, 'README.template.md')).read()
    readme = readme.replace('{{TABLE}}', '\n'.join(rows)).replace('{{TOTAL}}', str(total))
    open(os.path.join(HERE, 'README.md'), 'w').write(readme)
    spec = importlib.util.spec_from_file_location('listings_1f916_build_extra', os.path.join(HERE, 'build_extra.py'))
    extra = importlib.util.module_from_spec(spec); spec.loader.exec_module(extra)
    extra.contributors(HERE, LISTINGS, ts)
    print('rendered', total, 'submissions')


if __name__ == '__main__':
    if '--fetch' in sys.argv:
        fetch()
    render()
