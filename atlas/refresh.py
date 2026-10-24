#!/usr/bin/env python3
"""Weekly Atlas refresh (Python 3.12, standard library only).

    python3 atlas/refresh.py --dry-run                 # check everything, write nothing, print the summary
    python3 atlas/refresh.py --summary /tmp/pr.md      # apply changes to the snapshot + state, write a PR summary

What it does, per entry of the Atlas snapshot (atlas/data/snapshot-verified-*.json):
  1. Reachability: GET the primary URL (canonical_url, or check_url from atlas/refresh-sources.json), follow redirects,
     timeout 15 s, polite User-Agent, up to 3 attempts. If all attempts fail, a second method is tried (http<->https /
     www toggle) before the week counts as failed. 401/403/405/406/429/451/503 count as reachable-but-blocked
     (JS/Cloudflare shells are never evidence of death, atlas/PROTOCOL.md).
  2. Death rule (no false deaths), state in atlas/data/refresh-state.json:
       1st failed week  -> suspected_down (state only, nothing published)
       2nd consecutive  -> status closed / include_closed_history, with a direct_observation claim + status_history record
       recovered        -> suspected cleared; an entry closed BY THIS SCRIPT that answers again is revived (live + history).
     Entries closed by humans are never revived automatically (a re-registered/parked domain answers 200 too); a
     responding closed entry is only listed in the summary. Pages and slugs are never removed.
  3. Domain moved: final URL on another registrable domain than canonical_url -> flagged for human review, nothing changed.
  4. Numbers: only the explicit mappings in atlas/refresh-sources.json. A changed value is a re-observation (new value
     with observed_at in UTC, the previous value appended to claim.history); past records are never rewritten.
  5. Replication counts: for entries with a `replications` source in atlas/refresh-sources.json, the register's files are
     read at the newest commit on main whose validator workflow push run succeeded, counted the way that validator counts
     (atlas/site/replications.py), and written to atlas/data/replications.json with the pinned commit. A record changes only
     when a count changes; the previous record moves into its history.
       python3 atlas/refresh.py --replications-only      # step 5 alone (no reachability, no numbers)
No change at all -> the snapshot and state files are left byte-identical (so the workflow opens no PR).
Exit code 0 always unless the script itself breaks; findings go to the summary.
"""
import argparse, concurrent.futures as cf, copy, glob, http.client, ipaddress, json, os, re, socket, ssl, string, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
UA = 'CommonworldAtlasBot/1.0 (+https://commonworld.one/atlas/about/)'
TIMEOUT = 15
ATTEMPTS = 3
BACKOFF = (2, 5)
BLOCKED = {401, 403, 405, 406, 429, 451, 503, 999}
TOOL = 'atlas/refresh.py'
# hosting suffixes where the first label below them is the "registrable" owner (no PSL in stdlib)
MULTI_SUFFIX = {'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.kr', 'com.br', 'com.cn', 'co.in',
                'co.nz', 'com.mx', 'com.tr', 'co.za', 'com.sg', 'com.hk', 'github.io', 'gitlab.io', 'vercel.app', 'netlify.app',
                'pages.dev', 'workers.dev', 'up.railway.app', 'railway.app', 'onrender.com', 'herokuapp.com', 'fly.dev',
                'replit.app', 'repl.co', 'chatgpt.site', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'hf.space',
                'streamlit.app', 'vercel.sh', 'deno.dev', 'surge.sh', 'glitch.me', 'notion.site', 'substack.com',
                'medium.com', 'blogspot.com', 'wordpress.com', 'framer.website', 'framer.app', 'webflow.io', 'carrd.co'}


def now_iso():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def reg_domain(url):
    host = (urllib.parse.urlsplit(url).hostname or '').lower().rstrip('.')
    if host.startswith('www.'):
        host = host[4:]
    parts = host.split('.')
    for n in (3, 2):
        if len(parts) > n and '.'.join(parts[-n:]) in MULTI_SUFFIX:
            return '.'.join(parts[-(n + 1):])
    return '.'.join(parts[-2:]) if len(parts) >= 2 else host


def default_snapshot():
    files = sorted(glob.glob(os.path.join(DATA, 'snapshot-verified-*.json')))
    if not files:
        raise SystemExit('no atlas/data/snapshot-verified-*.json')
    return files[-1]


# ------------------------------------------------------------------ HTTP
_CTX = ssl.create_default_context()
MAX_JSON_BYTES = 1_000_000      # one JSON response; bounds json.loads object expansion
MAX_AGG_BYTES = 25_000_000      # all pages of one paginated read together
MAX_AGG_ITEMS = 100_000         # rows processed across one aggregate read
MAX_AGG_PAGES = 50
MAX_OFFSET = 999_999_999_999
MAX_REDIRECTS = 5
_REDIRECT_CODES = {301, 302, 303, 307, 308}
_AZURE_WIRESERVER = ipaddress.ip_address('168.63.129.16')
_NAT64_WELL_KNOWN = ipaddress.ip_network('64:ff9b::/96')
_NAT64_LOCAL = ipaddress.ip_network('64:ff9b:1::/48')


def _is_public_ipv4(addr):
    return addr.is_global and addr != _AZURE_WIRESERVER


def _is_public_ip(value):
    """Reject special platform endpoints and IPv6 forms that can carry private IPv4 destinations."""
    try:
        addr = ipaddress.ip_address(str(value).split('%')[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv4Address):
        return _is_public_ipv4(addr)
    if isinstance(addr, ipaddress.IPv6Address):
        if addr in _NAT64_LOCAL:
            return False
        if addr in _NAT64_WELL_KNOWN:
            return _is_public_ipv4(ipaddress.IPv4Address(int(addr) & 0xffffffff))
        if addr.ipv4_mapped is not None:
            return _is_public_ipv4(addr.ipv4_mapped)
        if addr.sixtofour is not None:
            return _is_public_ipv4(addr.sixtofour)
        if addr.teredo is not None:
            return all(_is_public_ipv4(part) for part in addr.teredo)
        # IPv4-compatible IPv6 addresses are not routed globally, but may be interpreted by local stacks.
        if int(addr) >> 32 == 0:
            return _is_public_ipv4(ipaddress.IPv4Address(int(addr) & 0xffffffff))
    return addr.is_global


def _public_addresses(host, port):
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    if not infos:
        raise OSError('refused: hostname has no addresses')
    # Fail closed on mixed DNS answers; otherwise a later resolver choice could select a private address.
    for info in infos:
        if not _is_public_ip(info[4][0]):
            raise OSError('refused: hostname resolved to a non-public address')
    return infos


def public_url(url):
    """True only for credential-free HTTP(S) URLs with entirely public DNS answers.
    Connection handlers repeat validation on the exact addresses they connect to, preventing DNS rebinding."""
    try:
        sp = urllib.parse.urlsplit(url)
        if sp.scheme not in ('http', 'https') or not sp.hostname or sp.username is not None or sp.password is not None:
            return False
        port = sp.port if sp.port is not None else (443 if sp.scheme == 'https' else 80)
        if port == 0:
            return False
        _public_addresses(sp.hostname, port)
        return True
    except (OSError, ValueError, UnicodeError):
        return False


def _connect_public(host, port, timeout, source_address):
    infos = _public_addresses(host, port)
    errors = []
    for family, socktype, proto, _canonname, sockaddr in infos:
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            # Connect to the exact address returned by the validated lookup; never resolve the hostname again here.
            sock.connect(sockaddr)
            return sock
        except OSError as ex:
            errors.append(ex)
            sock.close()
    if errors:
        raise errors[-1]
    raise OSError('no usable public addresses')


class _PublicConnectionMixin:
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = self._create_public_connection

    def _create_public_connection(self, address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
        return _connect_public(address[0], address[1], timeout, source_address)


class _PublicHTTPConnection(_PublicConnectionMixin, http.client.HTTPConnection):
    pass


class _PublicHTTPSConnection(_PublicConnectionMixin, http.client.HTTPSConnection):
    pass


class _PublicHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_PublicHTTPConnection, req)


class _PublicHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_PublicHTTPSConnection, req, context=self._context)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect(), _PublicHTTPHandler(),
                                      _PublicHTTPSHandler(context=_CTX))


def fetch(url, want_body=False, limit=65536, body_limit=MAX_JSON_BYTES):
    """One GET. Returns dict(status, final_url, error, body)."""
    if not public_url(url):
        return {'status': None, 'final_url': url, 'error': 'refused: not a public credential-free http(s) address', 'body': None}
    current = url
    redirects = 0
    while True:
        req = urllib.request.Request(current, headers={'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
                                                       'Accept-Language': 'en'})
        try:
            try:
                response = _OPENER.open(req, timeout=TIMEOUT)
            except urllib.error.HTTPError as ex:
                if ex.code not in _REDIRECT_CODES:
                    ex.close()
                    return {'status': ex.code, 'final_url': ex.geturl() or current, 'error': f'HTTP {ex.code}', 'body': None}
                response = ex

            if response.status in _REDIRECT_CODES:
                location = response.headers.get('Location') or response.headers.get('URI')
                response.close()  # Do not read an untrusted redirect response body.
                if not location:
                    return {'status': response.status, 'final_url': response.geturl() or current, 'error': None, 'body': None}
                if redirects >= MAX_REDIRECTS:
                    return {'status': None, 'final_url': current, 'error': 'refused: too many redirects', 'body': None}
                # Match urllib's handling of non-ASCII and spaces while resolving relative and protocol-relative targets.
                location = urllib.parse.quote(location, encoding='iso-8859-1', safe=string.punctuation)
                next_url = urllib.parse.urljoin(current, location)
                if not public_url(next_url):
                    return {'status': None, 'final_url': current, 'error': 'refused: redirect target is not public http(s)', 'body': None}
                current = next_url
                redirects += 1
                continue

            with response as r:
                if want_body:
                    body_limit = max(0, min(MAX_JSON_BYTES, body_limit))
                    body = r.read(body_limit + 1)
                    if len(body) > body_limit:
                        return {'status': r.status, 'final_url': r.geturl(), 'error': f'response larger than {body_limit} bytes', 'body': None}
                else:
                    body = r.read(limit)
                return {'status': r.status, 'final_url': r.geturl() or current, 'error': None, 'body': body if want_body else None}
        except (urllib.error.URLError, socket.timeout, TimeoutError, ssl.SSLError, ConnectionError, OSError, ValueError) as ex:
            reason = getattr(ex, 'reason', ex)
            message = str(reason)[:160]
            if isinstance(reason, OSError) and 'refused:' in message.lower():
                message = message.lower()
            return {'status': None, 'final_url': current, 'error': f'{type(reason).__name__}: {message}', 'body': None}


def classify(res):
    s = res['status']
    if s is None:
        return 'fail'
    if s < 400:
        return 'ok'
    if s in BLOCKED:
        return 'blocked'
    return 'fail'


def alt_urls(url):
    sp = urllib.parse.urlsplit(url)
    host = sp.hostname or ''
    out = []
    other_host = host[4:] if host.startswith('www.') else 'www.' + host
    out.append(sp._replace(netloc=other_host).geturl())
    out.append(sp._replace(scheme='http' if sp.scheme == 'https' else 'https').geturl())
    return out


def check(url, extra=(), sleep=time.sleep):
    """Up to ATTEMPTS GETs of url; if all fail, one try per alternate method (www/scheme toggle, then `extra` URLs:
    the pages that served the entry's supported site_reachable observations). Returns a result dict."""
    tries = []
    for i in range(ATTEMPTS):
        r = fetch(url)
        r['cls'] = classify(r)
        tries.append(r)
        if r['cls'] != 'fail':
            return {'cls': r['cls'], 'status': r['status'], 'final_url': r['final_url'], 'error': r['error'],
                    'attempts': i + 1, 'methods': [f'GET {url} -> {r["status"] or r["error"]}'], 'via': url}
        if i < ATTEMPTS - 1:
            sleep(BACKOFF[min(i, len(BACKOFF) - 1)])
    methods = [f'GET {url} x{ATTEMPTS} -> {tries[-1]["status"] or tries[-1]["error"]}']
    alts = list(dict.fromkeys(alt_urls(url) + [x for x in extra if x and x != url]))
    for a in alts:
        r = fetch(a)
        r['cls'] = classify(r)
        methods.append(f'GET {a} -> {r["status"] or r["error"]}')
        if r['cls'] != 'fail':
            return {'cls': r['cls'], 'status': r['status'], 'final_url': r['final_url'], 'error': r['error'],
                    'attempts': ATTEMPTS + 1, 'methods': methods, 'via': a}
    last = tries[-1]
    return {'cls': 'fail', 'status': last['status'], 'final_url': last['final_url'], 'error': last['error'],
            'attempts': ATTEMPTS + len(alts), 'methods': methods, 'via': url}


# ------------------------------------------------------------------ numbers
def dig(obj, path):
    for k in path.split('.'):
        if isinstance(obj, dict) and k in obj:
            obj = obj[k]
        else:
            return None
    return obj


def as_number(v):
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str) and re.fullmatch(r'-?\d+(\.\d+)?', v.strip()):
        f = float(v)
        return int(f) if f.is_integer() and '.' not in v else round(f, 6)
    return None


def _bounded_offset(value):
    """Return a short decimal pagination offset, or None for untrusted/unbounded values."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value) if 0 <= value <= MAX_OFFSET else None
    if isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,11})', value):
        return value
    return None


def get_json(url, with_size=False, max_bytes=None):
    last, out = None, None
    body_limit = MAX_JSON_BYTES if max_bytes is None else min(MAX_JSON_BYTES, max_bytes)
    for i in range(ATTEMPTS):
        r = fetch(url, want_body=True, body_limit=body_limit)
        if r['status'] == 200 and r['body'] is not None:
            try:
                out = (json.loads(r['body'].decode('utf-8', 'replace')), None, len(r['body']))
            except (ValueError, RecursionError) as ex:
                out = (None, f'not JSON: {ex}', 0)
            break
        last = r['error'] or f'HTTP {r["status"]}'
        if r['error'] and ('refused' in r['error'] or 'larger than' in r['error']):
            break  # not transient: do not retry
        if i < ATTEMPTS - 1:
            time.sleep(BACKOFF[min(i, len(BACKOFF) - 1)])
    if out is None:
        out = (None, last, 0)
    return out if with_size else out[:2]


def read_mapping(m, fields_out=None):
    """-> (value, quote, methods, error). fields_out (dict) receives the quote/statement fields of a path mapping."""
    if m.get('agg'):
        ag = m['agg']
        url, pages, methods, total_bytes, total_items, selected_items, total_value = m['url'], 0, [], 0, 0, 0, 0
        seen_urls = {url}
        while True:
            doc, err, size = get_json(url, with_size=True, max_bytes=MAX_AGG_BYTES - total_bytes)
            if err:
                return None, None, methods, f'{url}: {err}'
            total_bytes += size
            if total_bytes > MAX_AGG_BYTES:
                return None, None, methods, f'paginated read larger than {MAX_AGG_BYTES} bytes'
            lst = dig(doc, ag['list'])
            if not isinstance(lst, list):
                return None, None, methods, f'{url}: no list at {ag["list"]}'
            if total_items + len(lst) > MAX_AGG_ITEMS:
                return None, None, methods, f'aggregate contains more than {MAX_AGG_ITEMS} items'
            pages += 1
            methods.append(f'GET {url}')
            nxt = doc.get('nextOffset') if isinstance(doc, dict) else None
            has_more = doc.get('hasMore') if isinstance(doc, dict) else False
            flag = ag.get('fail_if_more')
            if flag and m.get('paginate') != 'offset' and isinstance(doc, dict) and dig(doc, flag) is not False:
                # a single-page read whose own completeness flag is missing or not false would be a silent undercount
                return None, None, methods + [f'GET {url}'], f'{url}: list is not complete ({flag} is {json.dumps(dig(doc, flag))})'
            next_url = None
            if m.get('paginate') == 'offset' and has_more:
                if pages >= MAX_AGG_PAGES:
                    return None, None, methods, f'paginated read exceeds {MAX_AGG_PAGES} pages'
                offset = _bounded_offset(nxt)
                if offset is None:
                    return None, None, methods, 'invalid or oversized pagination offset'
                sp = urllib.parse.urlsplit(m['url'])
                q = dict(urllib.parse.parse_qsl(sp.query))
                q['offset'] = offset
                next_url = sp._replace(query=urllib.parse.urlencode(q)).geturl()
                if next_url in seen_urls:
                    return None, None, methods, 'pagination repeated a previously requested URL'
                seen_urls.add(next_url)
            for row in lst:
                matched = True
                for key, want in (ag.get('where') or {}).items():
                    value = dig(row, key)
                    if want == '*':
                        if value in (None, '', [], {}):
                            matched = False
                            break
                    elif value != want:
                        matched = False
                        break
                total_items += 1
                if matched:
                    selected_items += 1
                    if ag['op'] != 'count':
                        number = as_number(dig(row, ag['field']))
                        if number is None:
                            return None, None, methods, f'non-numeric {ag["field"]} in list'
                        total_value += number
            if lst:
                del row
            del doc, lst
            if next_url is not None:
                url = next_url
                continue
            break

        if ag['op'] == 'count':
            val = selected_items
        else:
            dec = ag.get('decimals')
            if dec:
                # atomic token units (e.g. USDC, 6 decimals): exact integer sum first, then one division
                if not isinstance(total_value, int):
                    return None, None, methods, f'decimals set but {ag["field"]} values are not whole atomic units'
                q_, r_ = divmod(total_value, 10 ** dec)
                val = q_ if r_ == 0 else round(total_value / 10 ** dec, dec)
            else:
                val = int(total_value) if float(total_value).is_integer() else round(total_value, 6)
        where = ', '.join(f'{k}={v}' for k, v in (ag.get('where') or {}).items())
        scale = f' / 10^{ag["decimals"]}' if ag['op'] == 'sum' and ag.get('decimals') else ''
        quote = f'{total_items} items read; {selected_items} with {where}' + (f'; sum {ag["field"]}{scale} = {val}' if ag['op'] == 'sum' else '')
        methods.append(f'{ag["op"]} over {ag["list"]}' + (f' of {ag["field"]}{scale}' if ag['op'] == 'sum' else '') + (f' where {where}' if where else '')
                       + (f'; {ag["fail_if_more"]} false (complete list)' if ag.get('fail_if_more') else ''))
        return val, quote, methods, None
    doc, err = get_json(m['url'])
    if err:
        return None, None, [f'GET {m["url"]}'], f'{m["url"]}: {err}'
    val = as_number(dig(doc, m['path']))
    if val is None:
        return None, None, [f'GET {m["url"]}'], f'no number at {m["path"]}'
    qf = m.get('quote_fields') or [m['path']]
    if fields_out is not None:
        for f in set(qf) | set(statement_fields(m.get('statement'))):
            fields_out[f] = as_number(dig(doc, f))
    q = ','.join(f'"{quote_key(f, qf)}":{json.dumps(dig(doc, f))}' for f in qf)
    return val, q[:QUOTE_MAX], [f'GET {m["url"]}', f'read {m["path"]}'], None


# ------------------------------------------------------------------ claim statements (the text next to the number)
# A mapping's `statement` is a template: {value} is the mapped number, {a.b.c} is any other number from the same JSON
# document (it must be listed in quote_fields, so the claim's quote carries it and check.py can re-render the text).
# The statement is regenerated from the same fetch on every refresh, so the words beside a number never keep old figures.
QUOTE_MAX = 200
_PLACEHOLDER = re.compile(r'\{([A-Za-z0-9_.]+)\}')
_NUM = re.compile(r'(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?![\d.]*[A-Za-z])')


def quote_key(field, fields):
    """Key used for one field in a claim quote: its last path segment, or the full path when two fields share it."""
    last = field.split('.')[-1]
    return field if sum(1 for f in fields if f.split('.')[-1] == last) > 1 else last


def statement_fields(template):
    return [f for f in _PLACEHOLDER.findall(template or '') if f != 'value']


def render_statement(template, value, fields):
    """-> (text, missing_fields). fields: {dot.path: number}."""
    missing = []

    def sub(mt):
        k = mt.group(1)
        v = value if k == 'value' else (fields or {}).get(k)
        if v is None:
            missing.append(k)
            return mt.group(0)
        return fmt_value(v)
    text = _PLACEHOLDER.sub(sub, template or '')
    return (text or None), missing


def fields_from_quote(quote, quote_fields):
    """Inverse of the quote built by read_mapping: {dot.path: number} for every quote field found in the quote."""
    out = {}
    for f in quote_fields or []:
        mt = re.search(r'"' + re.escape(quote_key(f, quote_fields)) + r'"\s*:\s*("?)(-?[\d.]+(?:[eE][-+]?\d+)?)\1', quote or '')
        if mt:
            out[f] = as_number(mt.group(2))
    return out


def numbers_in(text):
    out = []
    for t in _NUM.findall(text or ''):
        n = as_number(t.replace(',', ''))
        if n is not None:
            out.append(n)
    return out


def _same(a, b):
    return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(a)), abs(float(b)))


def note_drift(claim, mapping):
    """Why a refreshed claim's statement disagrees with its own number and quote, or None.
    With a template: the statement must equal the template re-rendered from claim.value and the numbers in claim.quote.
    Without one: every number in the statement (not counting window tokens like 7d or 24h) must be claim.value or a number
    in claim.quote, and a statement that has numbers must contain claim.value."""
    st, val = claim.get('statement') or '', claim.get('value')
    tpl = (mapping or {}).get('statement')
    if tpl:
        fields = fields_from_quote(claim.get('quote'), [f for f in (mapping.get('quote_fields') or [mapping.get('path')]) if f])
        want, missing = render_statement(tpl, val, fields)
        if missing:
            return f'statement template needs {missing} but the quote does not carry them'
        if want != st:
            return f'statement {st!r} != {want!r} (template re-rendered from value + quote)'
        return None
    nums = numbers_in(st)
    if not nums or val is None:
        return None
    allowed = [val] + numbers_in(claim.get('quote'))
    stray = [n for n in nums if not any(_same(n, a) for a in allowed)]
    if stray:
        return f'statement numbers {stray} are neither the value {val} nor in the quote (stale note?)'
    if not any(_same(n, val) for n in nums):
        return f'statement does not mention the value {val}'
    return None


def mapping_problems(m):
    """Config lint for one numbers mapping."""
    probs = []
    qf = m.get('quote_fields') or [m.get('path')]
    for f in statement_fields(m.get('statement')):
        if m.get('agg'):
            probs.append(f'{m["id"]}: aggregate mappings only support {{value}} in statement, not {{{f}}}')
        elif f not in qf:
            probs.append(f'{m["id"]}: statement field {{{f}}} is not in quote_fields')
    ag = m.get('agg') or {}
    if 'decimals' in ag:
        d = ag['decimals']
        if ag.get('op') != 'sum' or isinstance(d, bool) or not isinstance(d, int) or not 0 < d <= 18:
            probs.append(f'{m["id"]}: agg.decimals must be an integer 1-18 on a sum')
    if ag.get('fail_if_more') is not None and (not isinstance(ag['fail_if_more'], str) or m.get('paginate')):
        probs.append(f'{m["id"]}: agg.fail_if_more must be a field name, and only on a single-page read (no paginate)')
    v = m.get('verify')
    if v is not None:
        if not isinstance(v, dict) or not str(v.get('url', '')).startswith('https://') or not (v.get('note') or '').strip():
            probs.append(f'{m["id"]}: verify must be {{url: https://..., note: ...}}')
        elif reg_domain(v['url']) != reg_domain(m['url']):
            probs.append(f'{m["id"]}: verify url is on another domain than the mapping url')
    return probs


def fmt_value(v):
    if isinstance(v, int):
        return f'{v:,}'
    return f'{v:,.6f}'.rstrip('0').rstrip('.')


def apply_number(entry, m, val, quote, methods, ts, fields=None):
    """Mutates entry. Returns ('new'|'changed'|'note'|'same', old_value).
    'note': the number is unchanged but the statement beside it (rendered from the same fetch) changed, e.g. a 7-day
    count inside a lifetime claim; it is a re-observation too, so the old statement goes into history."""
    claims = entry.setdefault('claims', [])
    c = next((x for x in claims if x.get('refresh_id') == m['id']), None)
    if c is None and m.get('match'):
        mt = m['match']
        c = next((x for x in claims if x.get('source_url') == mt.get('source_url') and x.get('unit') == mt.get('unit')
                  and x.get('kind') == m['kind'] and x.get('basis') == m['basis']), None)
    statement, missing = render_statement(m.get('statement'), val, fields)
    if missing:
        statement = None   # never publish a half-filled template; check.py then flags the stale note for a human
    if c is None:
        claim = {'kind': m['kind'], 'statement': statement or f'{fmt_value(val)} {m["unit"]}', 'value': val, 'unit': m['unit'],
                 'window': m.get('window'), 'basis': m['basis'], 'source_url': m['url'], 'quote': quote, 'observed_at': ts,
                 'methods': methods, 'outcome': 'supported', 'refresh_id': m['id']}
        if m.get('verify'):
            claim['verify'] = dict(m['verify'])
        claims.append(claim)
        return 'new', None
    if m.get('verify') and c.get('verify') != m['verify']:
        c['verify'] = dict(m['verify'])
    if c.get('value') == val and (not statement or c.get('statement') == statement):
        return 'same', val
    what = 'changed' if c.get('value') != val else 'note'
    old = {k: c.get(k) for k in ('value', 'unit', 'window', 'statement', 'quote', 'source_url', 'observed_at', 'basis', 'outcome')}
    old['superseded_at'] = ts
    old['reason'] = 'weekly automated re-observation (atlas/refresh.py)' + ('' if what == 'changed' else ': statement regenerated from the same fetch')
    c.setdefault('history', []).append(old)
    c.update({'value': val, 'quote': quote, 'observed_at': ts, 'methods': methods, 'outcome': 'supported', 'refresh_id': m['id']})
    if statement:
        c['statement'] = statement
    if m.get('window') and not c.get('window'):
        c['window'] = m['window']
    return what, old['value']


# ------------------------------------------------------------------ replication counts (atlas/site/replications.py)
GITHUB_API = 'https://api.github.com'
GITHUB_RAW = 'https://raw.githubusercontent.com'
MAX_REPL_FILES = 500


def _repl_module():
    sys.path.insert(0, os.path.join(HERE, 'site'))
    import replications
    return replications


def _get_text(url):
    last = None
    for i in range(ATTEMPTS):
        r = fetch(url, want_body=True)
        if r['status'] == 200 and r['body'] is not None:
            return r['body'].decode('utf-8'), None
        last = r['error'] or f'HTTP {r["status"]}'
        if r['error'] and ('refused' in r['error'] or 'larger than' in r['error']):
            break
        if i < ATTEMPTS - 1:
            time.sleep(BACKOFF[min(i, len(BACKOFF) - 1)])
    return None, f'{url}: {last}'


def read_replications(cfg, workers=8):
    """-> (counts+provenance dict, methods, error). cfg: {format, repo, workflow, branch} from atlas/refresh-sources.json.
    Pins the newest commit on `branch` whose `workflow` push run succeeded, lists entries/ and replications/ at that commit
    through the GitHub contents API, reads every file (and scripts/validate.ts) from raw.githubusercontent.com at the same
    sha, and counts with atlas/site/replications.py. Any surprise is an error and nothing is counted."""
    R = _repl_module()
    repo, wf, branch = cfg.get('repo', ''), cfg.get('workflow', ''), cfg.get('branch', 'main')
    if cfg.get('format') not in R.FORMATS or not R.REPO_RE.fullmatch(repo) or not re.fullmatch(r'[A-Za-z0-9._-]{1,100}\.ya?ml', wf) \
            or not re.fullmatch(r'[A-Za-z0-9._/-]{1,100}', branch):
        return None, [], 'bad replications config'
    q = urllib.parse.urlencode({'branch': branch, 'event': 'push', 'status': 'success', 'per_page': 1})
    runs_url = f'{GITHUB_API}/repos/{repo}/actions/workflows/{wf}/runs?{q}'
    methods = [f'GET {runs_url}']
    doc, err = get_json(runs_url)
    if err:
        return None, methods, f'{runs_url}: {err}'
    run = ((doc or {}).get('workflow_runs') or [None])[0] if isinstance(doc, dict) else None
    sha = (run or {}).get('head_sha') if isinstance(run, dict) else None
    run_url = (run or {}).get('html_url') if isinstance(run, dict) else None
    if not isinstance(sha, str) or not R.SHA_RE.fullmatch(sha):
        return None, methods, f'no successful {wf} push run on {branch}'
    if not isinstance(run_url, str) or not re.fullmatch(rf'https://github\.com/{re.escape(repo)}/actions/runs/[0-9]{{1,20}}', run_url):
        return None, methods, 'unexpected run html_url'
    names = {}
    for d, pat in (('entries', R.ENTRY_FILE), ('replications', R.ROW_FILE)):
        u = f'{GITHUB_API}/repos/{repo}/contents/{d}?ref={sha}'
        methods.append(f'GET {u}')
        lst, err = get_json(u)
        if err or not isinstance(lst, list):
            return None, methods, f'{u}: {err or "not a directory listing"}'
        files = [x.get('name') for x in lst if isinstance(x, dict) and x.get('type') == 'file']
        if any(not isinstance(n, str) or not pat.fullmatch(n) for n in files):
            return None, methods, f'{d}/ holds a file name the validator rejects'
        names[d] = sorted(files)
    paths = [f'{d}/{n}' for d in ('entries', 'replications') for n in names[d]] + ['scripts/validate.ts']
    if len(paths) > MAX_REPL_FILES:
        return None, methods, f'more than {MAX_REPL_FILES} files'
    with cf.ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        got = dict(zip(paths, ex.map(lambda p: _get_text(f'{GITHUB_RAW}/{repo}/{sha}/{p}'), paths)))
    bad = [e for _t, e in got.values() if e]
    if bad:
        return None, methods, bad[0]
    methods.append(f'GET {GITHUB_RAW}/{repo}/{sha}/<{len(paths)} files: entries/*.md, replications/*.jsonl, scripts/validate.ts>')
    try:
        counts = R.count_agent_errata({p.split('/', 1)[1]: got[p][0] for p in paths if p.startswith('entries/')},
                                      {p.split('/', 1)[1]: got[p][0] for p in paths if p.startswith('replications/')},
                                      got['scripts/validate.ts'][0])
    except R.FormatError as ex:
        return None, methods, f'format: {ex}'
    methods.append('counted as scripts/validate.ts counts (atlas/site/replications.py count_agent_errata)')
    return counts | {'format': cfg['format'], 'repo': repo, 'commit': sha,
                     'source_url': f'https://github.com/{repo}/tree/{sha}/replications',
                     'method_url': f'https://github.com/{repo}/blob/{sha}/scripts/validate.ts',
                     'validate_run_url': run_url}, methods, None


def apply_replications(cards, slug, got, ts):
    """Mutates cards ({slug: record}). Returns ('new'|'changed'|'same', old_counts). Only a count change is a new record;
    the previous record goes into history (oldest first) and is never rewritten."""
    R = _repl_module()
    cur = cards.get(slug)
    new_counts = {k: got[k] for k in R.COUNT_KEYS}
    if cur and {k: cur.get(k) for k in R.COUNT_KEYS} == new_counts:
        return 'same', new_counts
    rec = {k: got[k] for k in R.RECORD_KEYS if k != 'observed_at'} | {'observed_at': ts}
    if cur:
        rec['history'] = list(cur.get('history') or []) + [{k: cur[k] for k in R.RECORD_KEYS if k in cur}]
        cards[slug] = rec
        return 'changed', {k: cur.get(k) for k in R.COUNT_KEYS}
    cards[slug] = rec
    return 'new', None


def run_replications(entries, sources, results, rep, ts, path, dry_run, workers=8):
    """Step 5 for every live entry with a replications source. Returns True when the data file changed (and was written unless dry_run)."""
    R = _repl_module()
    raw = None
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            raw = f.read()
    doc = json.loads(raw) if raw else {'_help': 'Replication counts per card; written by atlas/refresh.py, rules in atlas/site/replications.py.', 'cards': {}}
    cards = doc.setdefault('cards', {})
    changed = False
    for e in entries:
        cfg = (sources.get(e['slug']) or {}).get('replications')
        if not cfg or e['status'] != 'live' or (results.get(e['slug']) or {}).get('cls') == 'fail':
            continue
        got, methods, err = read_replications(cfg, workers)
        if err:
            rep['replication_errors'].append({'slug': e['slug'], 'error': err})
            continue
        what, old = apply_replications(cards, e['slug'], got, ts)
        rep['replications'].append({'slug': e['slug'], 'action': what, 'old': old, 'new': {k: got[k] for k in R.COUNT_KEYS},
                                    'commit': got['commit'], 'source': got['source_url'], 'methods': methods})
        changed |= what != 'same'
    if changed and not dry_run:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(dump(doc))
    return changed


# ------------------------------------------------------------------ main
def closed_by_refresh(e):
    hist = e.get('status_history') or []
    return bool(hist) and hist[-1].get('to') == 'closed' and hist[-1].get('by') == TOOL


def load_json(p, default):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, indent=1) + '\n'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true', help='check everything, write nothing')
    ap.add_argument('--snapshot', default=None)
    ap.add_argument('--sources', default=os.path.join(HERE, 'refresh-sources.json'))
    ap.add_argument('--state', default=os.path.join(DATA, 'refresh-state.json'))
    ap.add_argument('--state-from', default=None, help='start from this state (e.g. the open refresh PR) if it is newer than --state')
    ap.add_argument('--summary', default=None, help='write the markdown PR summary here')
    ap.add_argument('--report', default=None, help='write the full JSON report here')
    ap.add_argument('--only', default=None, help='comma-separated slugs (testing)')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--replications', default=os.path.join(DATA, 'replications.json'), help='replication counts file (step 5)')
    ap.add_argument('--replications-only', action='store_true', help='run step 5 only: no reachability check, no numbers, no state change')
    a = ap.parse_args()

    snap_path = a.snapshot or default_snapshot()
    snap_raw = open(snap_path, encoding='utf-8').read()
    snap = json.loads(snap_raw)
    sources = load_json(a.sources, {}).get('sources', {})
    state_raw = open(a.state, encoding='utf-8').read() if os.path.exists(a.state) else None
    state = json.loads(state_raw) if state_raw else {'version': 1, 'entries': {}, 'moved': {}}
    if a.state_from and os.path.exists(a.state_from):
        alt = load_json(a.state_from, None)
        if alt and (alt.get('updated_at') or '') > (state.get('updated_at') or ''):
            print(f'starting from newer state {a.state_from} ({alt.get("updated_at")})')
            state = alt
    state.setdefault('entries', {}); state.setdefault('moved', {})
    state_before = copy.deepcopy(state)
    ts = now_iso()
    today = ts[:10]

    entries = snap['platforms']
    if a.only:
        keep = set(a.only.split(','))
        entries = [e for e in entries if e['slug'] in keep]

    if a.replications_only:
        rep = {'run_at': ts, 'dry_run': a.dry_run, 'replications_only': True, 'replications': [], 'replication_errors': [], 'notes': []}
        ch = run_replications(entries, sources, {}, rep, ts, a.replications, a.dry_run, a.workers)
        rep['replications_changed'] = ch
        md = replications_md(rep)
        if a.summary:
            with open(a.summary, 'w', encoding='utf-8') as f:
                f.write(md)
        if a.report:
            with open(a.report, 'w', encoding='utf-8') as f:
                json.dump(rep, f, ensure_ascii=False, indent=1)
        print(md)
        print(f'changes: replications={ch} dry_run={a.dry_run}')
        return

    def job(e):
        url = (sources.get(e['slug']) or {}).get('check_url') or e.get('canonical_url')
        if not url:
            return e['slug'], {'cls': 'no_url', 'methods': [], 'via': None, 'status': None, 'final_url': None, 'error': 'no URL'}
        extra = [x.get('source_url') for x in e.get('claims', []) if x.get('kind') == 'site_reachable' and x.get('outcome') == 'supported'
                 and (x.get('source_url') or '').startswith('http') and reg_domain(x['source_url']) == reg_domain(url)]
        return e['slug'], check(url, extra)

    t0 = time.time()
    results = {}
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        for slug, r in ex.map(job, entries):
            results[slug] = r
    print(f'checked {len(results)} entries in {time.time() - t0:.0f}s', file=sys.stderr)

    rep = {'run_at': ts, 'dry_run': a.dry_run, 'counts': {}, 'died': [], 'suspected': [], 'recovered': [], 'revived': [],
           'moved': [], 'closed_responding': [], 'numbers': [], 'number_errors': [], 'note_drift': [], 'notes': [],
           'replications': [], 'replication_errors': []}
    from collections import Counter
    rep['counts'] = dict(Counter(r['cls'] for r in results.values()))
    rep['counts_by_status'] = {st: dict(Counter(results[e['slug']]['cls'] for e in entries if e['status'] == st)) for st in ('live', 'closed')}
    changed_slugs = set()

    for e in entries:
        slug, r = e['slug'], results[e['slug']]
        st = state['entries'].get(slug)
        if e['status'] == 'live':
            if r['cls'] == 'fail':
                st = st or {'failed_weeks': 0, 'first_failed_at': ts}
                st['failed_weeks'] += 1
                st['last_error'] = r['error']
                state['entries'][slug] = st
                if st['failed_weeks'] >= 2:
                    rep['died'].append({'slug': slug, 'url': r['via'], 'error': r['error'], 'first_failed_at': st['first_failed_at']})
                    claim = {'kind': 'site_reachable',
                             'statement': f'Automated weekly check could not reach the site in {st["failed_weeks"]} consecutive weeks '
                                          f'({ATTEMPTS} attempts each week plus alternate URLs); last error: {r["error"]}.',
                             'value': None, 'unit': None, 'window': None, 'basis': 'direct_observation', 'source_url': r['via'],
                             'quote': (r['error'] or '')[:200], 'observed_at': ts, 'methods': r['methods'], 'outcome': 'contradicted',
                             'refresh': {'by': TOOL, 'rule': 'closed after 2 consecutive failed weekly checks', 'first_failed_at': st['first_failed_at']}}
                    e['claims'].insert(0, claim)
                    e.setdefault('status_history', []).append({'at': ts, 'from': 'live', 'to': 'closed', 'by': TOOL,
                                                               'reason': f'unreachable in {st["failed_weeks"]} consecutive weekly checks since {st["first_failed_at"][:10]}'})
                    e['status'], e['verdict'] = 'closed', 'include_closed_history'
                    st['closed_at'] = ts
                    changed_slugs.add(slug)
                else:
                    rep['suspected'].append({'slug': slug, 'url': r['via'], 'error': r['error'], 'methods': r['methods']})
            else:
                if st and st.get('failed_weeks'):
                    rep['recovered'].append({'slug': slug, 'was_failed_weeks': st['failed_weeks']})
                    state['entries'].pop(slug, None)
        elif e['status'] == 'closed':
            if r['cls'] == 'ok' and closed_by_refresh(e):
                rep['revived'].append({'slug': slug, 'url': r['via'], 'status': r['status']})
                e['claims'].insert(0, {'kind': 'site_reachable', 'statement': f'Automated weekly check: the site answers again (HTTP {r["status"]}).',
                                       'value': None, 'unit': None, 'window': None, 'basis': 'direct_observation', 'source_url': r['via'],
                                       'quote': f'HTTP {r["status"]} final URL {r["final_url"]}', 'observed_at': ts, 'methods': r['methods'],
                                       'outcome': 'supported', 'refresh': {'by': TOOL, 'rule': 'revived: entry closed by refresh answers again'}})
                e['status_history'].append({'at': ts, 'from': 'closed', 'to': 'live', 'by': TOOL, 'reason': f'site answers again (HTTP {r["status"]})'})
                e['status'], e['verdict'] = 'live', 'include_verified'
                state['entries'].pop(slug, None)
                changed_slugs.add(slug)
            elif r['cls'] == 'ok':
                rep['closed_responding'].append({'slug': slug, 'status': r['status'], 'final_url': r['final_url']})
        # domain moved (only flag; never change data). Closed entries are skipped: their old domains often point elsewhere.
        if e['status'] == 'live' and r.get('final_url') and r['cls'] in ('ok', 'blocked') and e.get('canonical_url'):
            want, got = reg_domain(e['canonical_url']), reg_domain(r['final_url'])
            if want != got:
                prev = state['moved'].get(slug)
                if prev != got:
                    rep['moved'].append({'slug': slug, 'canonical': e['canonical_url'], 'final_url': r['final_url'], 'previous': prev,
                                         'status': e['status']})
                    state['moved'][slug] = got
            elif slug in state['moved']:
                state['moved'].pop(slug)

    # numbers
    for e in entries:
        if e['status'] != 'live' or results[e['slug']]['cls'] == 'fail':
            continue
        for m in (sources.get(e['slug']) or {}).get('numbers', []):
            fields = {}
            val, quote, methods, err = read_mapping(m, fields)
            if err:
                rep['number_errors'].append({'slug': e['slug'], 'id': m['id'], 'error': err})
                continue
            before = json.dumps(e.get('claims'), sort_keys=True)
            what, old = apply_number(e, m, val, quote, methods, ts, fields)
            c = next((x for x in e.get('claims', []) if x.get('refresh_id') == m['id']), None)
            drift = note_drift(c, m) if c and c.get('value') == val else None
            if drift:
                rep['note_drift'].append({'slug': e['slug'], 'id': m['id'], 'problem': drift})
                rep['notes'].append(f'{e["slug"]}: the text beside {m["id"]} no longer matches its number ({drift}); '
                                    f'give the mapping a statement template in atlas/refresh-sources.json or fix the claim by hand.')
            if what == 'same' and json.dumps(e.get('claims'), sort_keys=True) != before:
                changed_slugs.add(e['slug'])   # e.g. a verify link added from the mapping
            if what != 'same':
                changed_slugs.add(e['slug'])
                rep['numbers'].append({'slug': e['slug'], 'id': m['id'], 'kind': m['kind'], 'basis': m['basis'], 'unit': m['unit'],
                                       'old': old, 'new': val, 'action': what, 'source': m['url']})
                if m.get('on_change_note'):
                    rep['notes'].append(f'{e["slug"]}: {m["on_change_note"]}')

    repl_changed = run_replications(entries, sources, results, rep, ts, a.replications, a.dry_run, a.workers)
    rep['replications_changed'] = repl_changed
    data_changed = bool(changed_slugs)
    if data_changed:
        snap['generated_at'] = ts
        snap.setdefault('amendments', []).append({
            'date': today, 'tag': f'refresh-{today}', 'by': TOOL,
            'rule': 'weekly automated refresh: reachability (2 failed weeks -> closed history), explicit numeric mappings from atlas/refresh-sources.json',
            'died': [d['slug'] for d in rep['died']], 'revived': [d['slug'] for d in rep['revived']],
            'number_updates': [f'{n["slug"]}:{n["id"]}' for n in rep['numbers']]})
    state_changed = state != state_before
    if state_changed:
        state['updated_at'] = ts
    rep['data_changed'], rep['state_changed'] = data_changed, state_changed
    rep['changed_slugs'] = sorted(changed_slugs)
    if not data_changed and not state_changed and not repl_changed:
        rep['notes'].append('No data or state change: no PR needed.')

    md = summary_md(rep, snap_path)
    if not a.dry_run:
        if data_changed:
            with open(snap_path, 'w', encoding='utf-8') as f:
                f.write(dump(snap))
            # public events log (atlas/data/events.jsonl): closures and revivals by this script are card events;
            # number updates are not (check.py events_checks requires these lines for every died/revived slug)
            sys.path.insert(0, os.path.join(HERE, 'site'))
            import events as atlas_events
            ev_file = os.path.join(os.path.dirname(os.path.abspath(snap_path)), 'events.jsonl')  # next to the snapshot
            https = lambda u: u if str(u).startswith('https://') else 'https://' + str(u).split('://', 1)[-1]
            for d in rep['died']:
                atlas_events.append(ev_file, today, d['slug'], 'closed',
                                    'Automated weekly check: site unreachable in 2 consecutive weekly checks', https(d['url']))
            for d in rep['revived']:
                atlas_events.append(ev_file, today, d['slug'], 'reopened',
                                    'Automated weekly check: site answers again after an automated closure', https(d['url']))
        if state_changed:
            with open(a.state, 'w', encoding='utf-8') as f:
                f.write(dump(state))
    if a.summary:
        with open(a.summary, 'w', encoding='utf-8') as f:
            f.write(md)
    if a.report:
        with open(a.report, 'w', encoding='utf-8') as f:
            json.dump(rep | {'results': results}, f, ensure_ascii=False, indent=1)
    print(md)
    print(f'changes: data={data_changed} state={state_changed} replications={repl_changed} dry_run={a.dry_run}')


def summary_md(rep, snap_path):
    L = [f'## Atlas weekly refresh {rep["run_at"][:10]}', '',
         f'Run at {rep["run_at"]} (UTC) by `atlas/refresh.py`. Rules: [atlas/PROTOCOL.md](https://github.com/commonworld-one/commonworld/blob/main/atlas/PROTOCOL.md); '
         'a failed week = 3 failed attempts + alternate URLs; 1st failed week = suspected (not published), 2nd = closed history. '
         'Pages and slugs are never removed. **Review before merging; never auto-merged.**', '',
         '| | count |', '|---|---:|']
    c = rep['counts']
    L += [f'| checked | {sum(c.values())} |', f'| reachable (2xx/3xx) | {c.get("ok", 0)} |', f'| blocked / needs browser (401/403/429/503…) | {c.get("blocked", 0)} |',
          f'| failed this week | {c.get("fail", 0)} |',
          f'| **died** (2nd failed week → closed history) | {len(rep["died"])} |', f'| suspected down (1st failed week) | {len(rep["suspected"])} |',
          f'| recovered from suspected | {len(rep["recovered"])} |', f'| **revived** (closed by refresh → live) | {len(rep["revived"])} |',
          f'| domain moved (needs human review) | {len(rep["moved"])} |', f'| number changes | {len(rep["numbers"])} |',
          f'| statements out of step with their number (needs a human) | {len(rep.get("note_drift", []))} |',
          f'| replication count changes | {sum(1 for r in rep.get("replications", []) if r["action"] != "same")} |', '']

    def table(title, rows, cols):
        if not rows:
            return
        L.append(f'### {title}'); L.append('')
        L.append('| ' + ' | '.join(h for h, _ in cols) + ' |'); L.append('|' + '---|' * len(cols))
        for r in rows:
            L.append('| ' + ' | '.join(str(f(r)).replace('|', '\\|').replace('\n', ' ') for _, f in cols) + ' |')
        L.append('')
    pg = lambda s: f'[{s}](https://commonworld.one/atlas/platforms/{s}/)'
    table('Died (status → closed history; page and URL kept)', rep['died'], [('entry', lambda r: pg(r['slug'])), ('url', lambda r: r['url']), ('first failed', lambda r: r['first_failed_at'][:10]), ('last error', lambda r: r['error'])])
    table('Suspected down (first failed week; nothing published)', rep['suspected'], [('entry', lambda r: pg(r['slug'])), ('url', lambda r: r['url']), ('error', lambda r: r['error'])])
    table('Revived', rep['revived'], [('entry', lambda r: pg(r['slug'])), ('url', lambda r: r['url']), ('HTTP', lambda r: r['status'])])
    table('Recovered (was suspected)', rep['recovered'], [('entry', lambda r: pg(r['slug'])), ('failed weeks before', lambda r: r['was_failed_weeks'])])
    table('Redirects to another domain (flag only, data unchanged)', rep['moved'], [('entry', lambda r: pg(r['slug'])), ('status', lambda r: r['status']), ('canonical', lambda r: r['canonical']), ('now ends at', lambda r: r['final_url']), ('previously seen', lambda r: r['previous'] or '—')])
    table('Number changes (re-observations; old value kept in claim history)', rep['numbers'], [('entry', lambda r: pg(r['slug'])), ('claim', lambda r: r['id']), ('basis', lambda r: r['basis']), ('change', lambda r: r['action']), ('old', lambda r: '—' if r['old'] is None else fmt_value(r['old'])), ('new', lambda r: fmt_value(r['new'])), ('unit', lambda r: r['unit']), ('source', lambda r: r['source'])])
    L.append(replications_md(rep, heading=False))
    if rep['notes']:
        L.append('### Needs a human'); L.append(''); L += [f'- {n}' for n in rep['notes']]; L.append('')
    if rep['closed_responding']:
        L.append('<details><summary>Closed entries (closed by a human) that answer HTTP 2xx/3xx — not revived automatically</summary>'); L.append('')
        L += [f'- {pg(r["slug"])}: HTTP {r["status"]} → {r["final_url"]}' for r in rep['closed_responding']]; L += ['', '</details>', '']
    if rep['number_errors']:
        L.append('<details><summary>Number sources that could not be read (no change made)</summary>'); L.append('')
        L += [f'- {r["slug"]} `{r["id"]}`: {r["error"]}' for r in rep['number_errors']]; L += ['', '</details>', '']
    return '\n'.join(L) + '\n'


def replications_md(rep, heading=True):
    """Markdown for step 5 (replication counts): a table of changed records and the reads that failed."""
    L = [f'## Atlas replication counts {rep["run_at"][:10]}', ''] if heading else []
    fmt = lambda c: '—' if not c else f'{c["rows"]} rows, {c["entries"]} entries, {c["entries_replicated"]} replicated by {c["independent_agents"]} independent agents'
    rows = [r for r in rep.get('replications', []) if r['action'] != 'same']
    if rows:
        L += ['### Replication counts (old record kept in history)', '', '| entry | change | old | new | commit | source |', '|---|---|---|---|---|---|']
        L += [f'| [{r["slug"]}](https://commonworld.one/atlas/platforms/{r["slug"]}/) | {r["action"]} | {fmt(r["old"])} | {fmt(r["new"])} | `{r["commit"][:12]}` | {r["source"]} |' for r in rows]
        L.append('')
    same = [r for r in rep.get('replications', []) if r['action'] == 'same']
    if same:
        L += [f'Replication counts unchanged: {", ".join(r["slug"] + " (" + fmt(r["new"]) + ")" for r in same)}.', '']
    if rep.get('replication_errors'):
        L += ['<details><summary>Replication sources that could not be read (no change made)</summary>', '']
        L += [f'- {r["slug"]}: {r["error"]}' for r in rep['replication_errors']] + ['', '</details>', '']
    return '\n'.join(L) + ('\n' if heading else '')


if __name__ == '__main__':
    main()
