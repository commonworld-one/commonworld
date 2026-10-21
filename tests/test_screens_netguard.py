"""atlas/tools/screens.py network guard (capture rule 7): the weekly capture browser must never reach private, loopback,
link-local, carrier-grade NAT or cloud metadata addresses, also not through a redirect from a public page.

The proxy tests run without a browser (a fake resolver stands in for DNS). The last test drives real Chromium through
the guard when Playwright and its browser are installed (CI installs both) and is skipped otherwise."""
import asyncio
import importlib.util
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('atlas_tools_screens_guard', ROOT / 'atlas' / 'tools' / 'screens.py')
screens = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(screens)

CHROMIUM = os.environ.get('CHROMIUM_PATH') or None   # same variable as screens.py --chromium
PUBLIC_IP = '93.184.216.34'   # stands for "some public address"; tests never connect to it


class IpDenied(unittest.TestCase):
    def test_blocked_ranges(self):
        for ip in ('127.0.0.1', '127.9.9.9', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
                   '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0', '168.63.129.16',
                   '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%eth0',
                   '::ffff:127.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2002:7f00:1::1',
                   '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', 'not-an-ip'):
            self.assertTrue(screens.ip_denied(ip), ip)

    def test_public_addresses_pass(self):
        for ip in (PUBLIC_IP, '1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111',
                   '::ffff:8.8.8.8'):
            self.assertFalse(screens.ip_denied(ip), ip)


def fake_dns(table):
    def resolve(host, port):
        if host not in table:
            raise OSError('NXDOMAIN')
        return table[host]
    return resolve


class Resolve(unittest.TestCase):
    def run_resolve(self, guard, host):
        return asyncio.run(guard.resolve(host, 443))

    def test_public_host_resolves(self):
        g = screens.NetGuard(resolver=fake_dns({'example.org': [PUBLIC_IP]}))
        self.assertEqual(self.run_resolve(g, 'example.org'), [PUBLIC_IP])
        self.assertEqual(self.run_resolve(g, 'EXAMPLE.org.'), [PUBLIC_IP])

    def test_any_private_answer_denies_the_host(self):
        # DNS rebinding style answer: one public and one internal address -> refused, not "pick the good one"
        g = screens.NetGuard(resolver=fake_dns({'mixed.test': [PUBLIC_IP, '10.1.2.3'],
                                                'localhost': ['127.0.0.1', '::1'],
                                                'meta.test': ['169.254.169.254']}))
        for h in ('mixed.test', 'localhost', 'meta.test'):
            with self.assertRaises(screens.Denied):
                self.run_resolve(g, h)

    def test_unresolvable_host_is_denied(self):
        g = screens.NetGuard(resolver=fake_dns({}))
        with self.assertRaises(screens.Denied):
            self.run_resolve(g, 'nowhere.test')
        with self.assertRaises(screens.Denied):
            self.run_resolve(g, '')

    def test_ip_literal_without_resolver(self):
        g = screens.NetGuard()
        with self.assertRaises(screens.Denied):
            self.run_resolve(g, '127.0.0.1')
        with self.assertRaises(screens.Denied):
            self.run_resolve(g, '[::1]')


class Upstream(BaseHTTPRequestHandler):
    """Plays the 'public site' behind the guard (reached through a patched _open, never by its loopback address)."""
    seen = []

    def do_GET(self):
        Upstream.seen.append((self.requestline, dict(self.headers)))
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', f'http://127.0.0.1:{self.server.server_address[1]}/secret')   # this very server
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        body = b'<html><head><title>public</title></head><body>public page</body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass   # a browser or test closing early is not a failure here


class LocalUpstreamGuard(screens.NetGuard):
    """Guard whose 'public' hosts are served by a local test server; every check still runs on the real addresses."""

    def __init__(self, port, table):
        super().__init__(resolver=fake_dns(table))
        self.test_port = port

    async def _open(self, host, port, addrs, tunnel=True):
        return await asyncio.open_connection('127.0.0.1', self.test_port)


class ProxyProtocol(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = QuietServer(('127.0.0.1', 0), Upstream)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def exchange(self, raw, table=None):
        async def go():
            g = await LocalUpstreamGuard(self.port, table or {'public.test': [PUBLIC_IP]}).start()
            try:
                r, w = await asyncio.open_connection('127.0.0.1', g.port)
                w.write(raw)
                await w.drain()
                data = await asyncio.wait_for(r.read(), 10)   # every reply ends with the connection closed
                w.close()
                return data, g.denied
            finally:
                await g.close()
        return asyncio.run(go())

    def test_connect_to_loopback_literal_is_refused(self):
        data, denied = self.exchange(b'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n')
        self.assertTrue(data.startswith(b'HTTP/1.1 403'), data)
        self.assertEqual(denied[0]['host'], '127.0.0.1')

    def test_connect_to_metadata_and_ipv6_loopback_is_refused(self):
        for target in (b'169.254.169.254:80', b'[::1]:443', b'[fe80::1]:443'):
            data, _ = self.exchange(b'CONNECT ' + target + b' HTTP/1.1\r\n\r\n')
            self.assertTrue(data.startswith(b'HTTP/1.1 403'), (target, data))

    def test_name_resolving_to_private_is_refused(self):
        data, denied = self.exchange(b'GET http://internal.test/ HTTP/1.1\r\nHost: internal.test\r\n\r\n',
                                     {'internal.test': ['10.0.0.7']})
        self.assertTrue(data.startswith(b'HTTP/1.1 403'), data)
        self.assertIn('10.0.0.7', denied[0]['reason'])

    def test_plain_http_is_forwarded_in_origin_form_with_connection_close(self):
        Upstream.seen.clear()
        data, denied = self.exchange(b'GET http://public.test/page?x=1 HTTP/1.1\r\nHost: public.test\r\n'
                                     b'Proxy-Connection: keep-alive\r\nProxy-Authorization: Basic eDp5\r\n\r\n')
        self.assertTrue(data.startswith(b'HTTP/1.0 200') or data.startswith(b'HTTP/1.1 200'), data)
        self.assertEqual(denied, [])
        line, headers = Upstream.seen[-1]
        self.assertEqual(line, 'GET /page?x=1 HTTP/1.1')
        lower = {k.lower(): v for k, v in headers.items()}
        self.assertNotIn('proxy-connection', lower)
        self.assertNotIn('proxy-authorization', lower)
        self.assertEqual(lower.get('connection'), 'close')

    def test_connect_to_public_host_is_tunnelled(self):
        Upstream.seen.clear()
        data, denied = self.exchange(b'CONNECT public.test:443 HTTP/1.1\r\n\r\nGET /tunnel HTTP/1.1\r\nHost: public.test\r\n\r\n')
        self.assertTrue(data.startswith(b'HTTP/1.1 200 Connection established'), data)
        self.assertEqual(denied, [])

    def test_non_http_absolute_form_and_garbage_are_refused(self):
        for raw in (b'GET ftp://public.test/ HTTP/1.1\r\n\r\n', b'GARBAGE\r\n\r\n'):
            data, _ = self.exchange(raw)
            self.assertTrue(data.startswith(b'HTTP/1.1 400'), (raw, data))


def _have_browser():
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            p.chromium.launch(executable_path=CHROMIUM).close()
        return True
    except Exception:
        return False


@unittest.skipUnless(_have_browser(), 'Playwright Chromium not installed (CI installs it)')
class BrowserThroughGuard(unittest.TestCase):
    """Real Chromium: a public page that redirects to 127.0.0.1 must not be followed, and a direct loopback URL is not
    reached either (Chromium is told to proxy loopback too)."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = QuietServer(('127.0.0.1', 0), Upstream)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def test_redirect_and_direct_loopback_are_blocked(self):
        from playwright.async_api import async_playwright

        async def go():
            g = await LocalUpstreamGuard(self.port, {'public.test': [PUBLIC_IP], 'localhost': ['127.0.0.1', '::1']}).start()
            out = {}
            try:
                async with async_playwright() as p:
                    b = await p.chromium.launch(executable_path=CHROMIUM, proxy=g.browser_proxy(),
                                                args=['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'])
                    page = await b.new_page()
                    resp = await page.goto('http://public.test/', timeout=15000)
                    out['public'] = (resp.status, await page.title())
                    for name, url in (('redirect', 'http://public.test/redirect'),
                                      ('direct', f'http://127.0.0.1:{self.port}/'),
                                      ('localhost', f'http://localhost:{self.port}/')):
                        Upstream.seen.clear()
                        try:
                            r = await page.goto(url, timeout=15000)
                            out[name] = ('loaded', r.status if r else None, page.url)
                        except Exception as ex:
                            out[name] = ('error', str(ex).split('\n')[0])
                        out[name + '_hits'] = [s[0] for s in Upstream.seen]
                    await b.close()
            finally:
                await g.close()
            return out, g.denied

        out, denied = asyncio.run(go())
        hits = lambda k: [h for h in out[k + '_hits'] if 'favicon' not in h]
        # plain HTTP: Chromium shows the guard's 403 as the page; HTTPS (CONNECT) would fail the navigation instead
        refused = lambda k: out[k][0] == 'error' or out[k][1] == 403
        self.assertEqual(out['public'], (200, 'public'))
        for k in ('redirect', 'direct', 'localhost'):
            self.assertTrue(refused(k), out)
        # the redirect response itself is fetched; its 127.0.0.1 target (this test server's /secret) never is
        self.assertEqual(hits('redirect'), ['GET /redirect HTTP/1.1'])
        self.assertTrue(any('loopback' in d['reason'] or 'blocked address' in d['reason'] for d in denied), denied)
        self.assertEqual(hits('direct'), [])      # loopback never reached the local server, by any path
        self.assertEqual(hits('localhost'), [])
        refused_hosts = {d['host'] for d in denied if 'blocked address' in d['reason']}
        self.assertIn('127.0.0.1', refused_hosts)
        self.assertIn('localhost', refused_hosts)

if __name__ == '__main__':
    unittest.main()
