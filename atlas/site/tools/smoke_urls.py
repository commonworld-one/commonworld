"""Pure exact URL assertions for browser smoke tests, never substring trust checks."""
from urllib.parse import urlsplit, parse_qs


def exact_https_url(value, expected):
    try:
        a, b = urlsplit(value), urlsplit(expected)
        if any(c.isspace() for c in value) or chr(92) in value:
            return False
        return (a.scheme == b.scheme == 'https' and a.hostname == b.hostname
                and a.username is None and a.password is None
                and a.port in (None, 443) and b.port in (None, 443)
                and (a.path or '/') == (b.path or '/') and a.query == b.query and a.fragment == b.fragment)
    except (ValueError, TypeError, AttributeError):
        return False


def caption_source_matches(text, expected, current=False):
    # The visible caption has one address in a fixed template, not an arbitrary text URL search.
    if current:
        prefix, marker, suffix = text.partition(' · ')
    else:
        prefix, marker, suffix = text.partition(' from ')
    address, end, rights = suffix.partition('. Screenshot © ')
    return (bool(marker) and bool(end) and (prefix == 'Homepage' if current else prefix.startswith('Homepage as captured '))
            and rights == 'the site owner, not part of the CC BY data.'
            and exact_https_url(address, expected))


def share_target_matches(href, network, canonical):
    endpoints = {'x': ('x.com','/intent/tweet','url'),
                 'linkedin': ('www.linkedin.com','/sharing/share-offsite/','url'),
                 'telegram': ('t.me','/share/url','url'),
                 'reddit': ('www.reddit.com','/submit','url'),
                 'facebook': ('www.facebook.com','/sharer/sharer.php','u')}
    try:
        u = urlsplit(href)
        if network == 'email':
            if u.scheme != 'mailto' or u.path or u.netloc or u.fragment:
                return False
            body = parse_qs(u.query, keep_blank_values=True).get('body', [])
            return len(body) == 1 and body[0].splitlines()[-1:] == [canonical]
        host, path, param = endpoints[network]
        if not exact_https_url(u._replace(query='', fragment='').geturl(), 'https://' + host + path) or u.fragment:
            return False
        values = parse_qs(u.query, keep_blank_values=True).get(param, [])
        return len(values) == 1 and exact_https_url(values[0], canonical)
    except (ValueError, TypeError, KeyError, AttributeError):
        return False
