"""build.py/check.py inline <script>/<style> patterns must match upper case tags (CodeQL py/bad-tag-filter)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'atlas', 'site'))
import build  # noqa: E402
import check  # noqa: E402


class InlineTagRegexes(unittest.TestCase):
    def test_build_inline_script_matches_upper_case(self):
        m = build.INLINE_SCRIPT_RE.search('<SCRIPT>alert(1)</SCRIPT>')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), 'alert(1)')

    def test_build_inline_script_still_skips_src_and_json(self):
        self.assertIsNone(build.INLINE_SCRIPT_RE.search('<script src="/assets/site.js"></script>'))
        self.assertIsNone(build.INLINE_SCRIPT_RE.search('<script type="application/ld+json">{}</script>'))

    def test_build_inline_style_matches_upper_case(self):
        m = build.INLINE_STYLE_RE.search('<STYLE>body{}</STYLE>')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), 'body{}')

    def test_check_strip_removes_upper_case_tags(self):
        copy = check.SCRIPT_STYLE_STRIP_RE.sub('', '<SCRIPT>x</SCRIPT><p>ok</p><STYLE>y</STYLE>')
        self.assertEqual(copy, '<p>ok</p>')

    def test_check_csp_script_matches_upper_case(self):
        m = check.CSP_INLINE_SCRIPT_RE.search('<SCRIPT>alert(1)</SCRIPT>')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), 'alert(1)')

    def test_check_csp_script_still_skips_src_and_json(self):
        self.assertIsNone(check.CSP_INLINE_SCRIPT_RE.search('<script src="/assets/site.js"></script>'))
        self.assertIsNone(check.CSP_INLINE_SCRIPT_RE.search('<script type="application/ld+json">{}</script>'))


if __name__ == '__main__':
    unittest.main()
