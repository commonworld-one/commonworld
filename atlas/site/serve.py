#!/usr/bin/env python3
"""Local preview server for the built Atlas (stdlib only). Mimics the live static serving (Workers Static Assets in the platform Worker, same rules as the legacy Cloudflare Pages build):
clean directory URLs, /atlas/x -> 301 /atlas/x/, real 404 status with /404.html, / serves the Commonworld landing (dist/index.html),
301s from dist/_redirects for paths that have no file (e.g. /atlas/page/1/ -> /atlas/), and X-Robots-Tag: noindex on Atlas
HTML pages opened with a filter or search query string (as the platform Worker sends).
Sends the site-wide security headers from dist/_headers (the `/*` block: CSP, Permissions-Policy, ...) so a local
browser runs under the same strict CSP as production (minus HSTS and upgrade-insecure-requests, which need https).

    python3 atlas/site/serve.py            # http://localhost:8080/atlas/
    python3 atlas/site/serve.py 9000       # another port
"""
import gzip, http.server, io, os, sys

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')


def site_headers():
    """Headers of the `/*` block in dist/_headers, adapted for plain http on localhost."""
    try:
        txt = open(os.path.join(DIST, '_headers'), encoding='utf-8').read()
    except OSError:
        return []
    out, cur = [], None
    for line in txt.splitlines():
        if line and not line[0].isspace():
            cur = line.strip()
        elif cur == '/*' and ':' in line:
            k, v = (x.strip() for x in line.split(':', 1))
            if k.lower() == 'strict-transport-security':
                continue
            if k.lower() == 'content-security-policy':
                v = '; '.join(d for d in v.split('; ') if d.strip() != 'upgrade-insecure-requests')
            out.append((k, v))
    return out


GZ_EXT = ('.html', '.css', '.js', '.json', '.svg', '.xml', '.txt', '.md')
FILTER_PARAMS = ('q', 'category', 'status', 'type', 'feature', 'tag', 'sort')  # same list as platform/src/atlas-assets.ts ATLAS_FILTER_PARAMS


def redirects():
    """{path: target} from the 301 lines of dist/_redirects."""
    try:
        lines = open(os.path.join(DIST, '_redirects'), encoding='utf-8').read().splitlines()
    except OSError:
        return {}
    return {p[0]: p[1] for p in (l.split() for l in lines) if len(p) == 3 and p[2] == '301'}


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIST, **k)

    def send_head(self):
        path = self.path.split('?', 1)[0].split('#', 1)[0]
        fs = self.translate_path(path)
        self._noindex = False
        if not os.path.exists(fs) and path in redirects():
            return self._redirect(redirects()[path], 301)
        query = self.path[len(path):].lstrip('?')
        if query and any(kv.split('=', 1)[0] in FILTER_PARAMS for kv in query.split('&')):
            self._noindex = True
        if os.path.isdir(fs) and not path.endswith('/'):
            q = self.path[len(path):]
            return self._redirect(path + '/' + q, 301)
        if os.path.isdir(fs):
            fs = os.path.join(fs, 'index.html')
        if os.path.isfile(fs) and fs.endswith(GZ_EXT) and 'gzip' in (self.headers.get('Accept-Encoding') or ''):
            body = gzip.compress(open(fs, 'rb').read(), 6)  # like Cloudflare: text is sent compressed (Lighthouse measures this)
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(fs))
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Vary', 'Accept-Encoding')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        if not os.path.isfile(fs):
            body = open(os.path.join(DIST, '404.html'), 'rb').read()
            self.send_response(404)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body) if self.command != 'HEAD' else None
            return None
        return super().send_head()

    def _redirect(self, loc, code):
        self.send_response(code)
        self.send_header('Location', loc)
        self.send_header('Content-Length', '0')
        self.end_headers()
        return None

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        if getattr(self, '_noindex', False):
            self.send_header('X-Robots-Tag', 'noindex')
        for k, v in site_headers():
            self.send_header(k, v)
        super().end_headers()


H.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                    '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.md': 'text/markdown; charset=utf-8'}


if __name__ == '__main__':
    if not os.path.isdir(DIST):
        sys.exit('dist/ not found: run  python3 atlas/site/build.py  first')
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    http.server.SimpleHTTPRequestHandler.extensions_map.update({'.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml'})
    print(f'Preview: http://localhost:{port}/ (landing)  http://localhost:{port}/atlas/ (Atlas)   (Ctrl+C to stop)')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
