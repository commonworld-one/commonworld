"""serve.py: the nearest-404.html walk-up must stay inside dist/ for attacker-controlled paths (CodeQL py/path-injection)."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'atlas', 'site'))
import serve  # noqa: E402


class NotFoundBody(unittest.TestCase):
    def setUp(self):
        self._dist = serve.DIST
        self.root = tempfile.TemporaryDirectory()
        self.dist = os.path.join(self.root.name, 'dist')
        serve.DIST = self.dist
        os.makedirs(os.path.join(self.dist, 'atlas', 'pulse'))
        with open(os.path.join(self.dist, '404.html'), 'w') as fh:
            fh.write('site 404')
        with open(os.path.join(self.dist, 'atlas', '404.html'), 'w') as fh:
            fh.write('atlas 404')
        # a 404.html OUTSIDE dist, as a sibling: no path walk may ever reach it
        self.outside = os.path.join(self.root.name, 'escape')
        os.makedirs(self.outside)
        with open(os.path.join(self.outside, '404.html'), 'w') as fh:
            fh.write('escaped')

    def tearDown(self):
        serve.DIST = self._dist
        self.root.cleanup()

    def test_walks_up_to_nearest_404(self):
        ctype, body = serve.not_found_body('/atlas/pulse/page/99/data.json')
        self.assertEqual(ctype, 'application/json; charset=utf-8')
        self.assertEqual(body, b'atlas 404')

    def test_dotdot_path_cannot_escape_dist(self):
        ctype, body = serve.not_found_body('/../escape/../escape/secret.json')
        self.assertEqual(body, b'site 404', 'traversal must resolve to the dist 404, never outside DIST')

    def test_percent_encoded_dots_stay_literal_and_contained(self):
        # the path here is not unquoted: %2e%2e must stay a literal directory name, never a traversal
        ctype, body = serve.not_found_body('/%2e%2e/%2e%2e/secret.json')
        self.assertEqual(body, b'site 404')

    def test_backslash_parts_cannot_escape(self):
        # backslash is a separator on Windows: '..\..\' must not turn into a traversal on any platform
        ctype, body = serve.not_found_body('/..\\..\\escape\\secret.json')
        self.assertEqual(body, b'site 404')

    @unittest.skipUnless(hasattr(os, 'symlink'), 'no symlink support')
    def test_symlink_inside_dist_cannot_escape(self):
        try:
            os.symlink(self.outside, os.path.join(self.dist, 'link'))
        except (OSError, NotImplementedError):
            self.skipTest('cannot create symlinks here')
        ctype, body = serve.not_found_body('/link/secret.json')
        self.assertEqual(body, b'site 404', 'a symlink out of dist must fall back to the dist 404')

    def test_html_still_uses_site_404(self):
        ctype, body = serve.not_found_body('/atlas/no-such-page/')
        self.assertEqual(ctype, 'text/html; charset=utf-8')
        self.assertEqual(body, b'site 404')


if __name__ == '__main__':
    unittest.main()
