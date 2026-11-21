"""build.py/check.py inline <script>/<style> handling uses a real HTML parser, not regexes
(CodeQL py/bad-tag-filter). Covers the bypass forms the rule cites: mixed case tags,
tabs/quotes in attributes, end tags like '</script >', and the original semantics:
skip src= scripts and JSON data blocks, keep raw body bytes for CSP sha256 hashing."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'atlas', 'site'))
import build  # noqa: E402
import check  # noqa: E402


class InlineScriptBodies(unittest.TestCase):
    def test_build_and_check_agree_on_simple_body(self):
        h = '<script>alert(1)</script>'
        self.assertEqual(build.inline_script_bodies(h), ['alert(1)'])
        self.assertEqual(check.inline_script_bodies(h), ['alert(1)'])

    def test_matches_upper_and_mixed_case(self):
        for h in ('<SCRIPT>alert(1)</SCRIPT>', '<ScRiPt>alert(2)</sCrIpT>'):
            self.assertEqual(len(build.inline_script_bodies(h)), 1)
            self.assertEqual(len(check.inline_script_bodies(h)), 1)

    def test_body_bytes_preserved_for_csp_hash(self):
        h = '<script>\n  x()\n</script>'
        self.assertEqual(build.inline_script_bodies(h), ['\n  x()\n'])

    def test_skips_src_and_json_blocks(self):
        for h in ('<script src="/assets/site.js"></script>',
                  "<script\tsrc='foo'></script>",
                  '<script SRC="/a.js"></script>',
                  '<script type="application/ld+json">{}</script>',
                  "<script type='application/json'>{}</script>"):
            self.assertEqual(build.inline_script_bodies(h), [])
            self.assertEqual(check.inline_script_bodies(h), [])
        # a src= script still must not leak into stripping leftovers either
        self.assertEqual(check.strip_script_style('<p>a</p><script src="/a.js"></script><p>b</p>'), '<p>a</p><p>b</p>')

    def test_end_tag_variants_browsers_accept(self):
        for end in ('</script >', '</script\t\n>', '</SCRIPT >'):
            h = f'<script>alert(1){end}<p>after</p>'
            self.assertEqual(build.inline_script_bodies(h), ['alert(1)'], end)

    def test_self_closing_script_is_still_a_script_to_browsers(self):
        # browsers ignore the slash in '<script/>' and run the body (HTML raw-text element)
        self.assertEqual(build.inline_script_bodies('<script/>alert(1)</script>'), ['alert(1)'])
        self.assertEqual(check.strip_script_style('<p>a</p><script/>x()</script><p>b</p>'), '<p>a</p><p>b</p>')

    def test_end_tag_with_junk_before_gt(self):
        # browsers accept '</script foo>' as a script end tag (HTML end-tag-with-attributes)
        h = '<script>alert(1)</script foo><p>after</p>'
        self.assertEqual(build.inline_script_bodies(h), ['alert(1)'])

    def test_unterminated_script_is_loud_not_silent(self):
        # EOF inside a script: the body is never collectable, so the scanner must say so
        s = check.scan_inline_tags('<p>x</p><script>alert(1)')
        self.assertEqual(s.scripts, [])
        self.assertEqual(s.unterminated, ('script', 8))
        # strip removes the rest of the file, matching browser raw-text parsing
        self.assertEqual(check.strip_script_style('<p>x</p><script>alert(1)'), '<p>x</p>')

    def test_multiple_scripts_in_one_page(self):
        h = '<script>a()</script><p>x</p><script>b()</script>'
        self.assertEqual(build.inline_script_bodies(h), ['a()', 'b()'])

    def test_commented_out_script_is_not_inline(self):
        h = '<!-- <script>alert(1)</script> --><p>ok</p>'
        self.assertEqual(build.inline_script_bodies(h), [])


class InlineStyleBodies(unittest.TestCase):
    def test_style_body_upper_case(self):
        self.assertEqual(build.inline_style_bodies('<STYLE>body{}</STYLE>'), ['body{}'])
        self.assertEqual(check.inline_style_bodies('<style>p{color:red}</style>'), ['p{color:red}'])

    def test_style_end_tag_with_space(self):
        self.assertEqual(build.inline_style_bodies('<style>a{}</style >'), ['a{}'])


class StripScriptStyle(unittest.TestCase):
    def test_removes_upper_case_tags(self):
        copy = check.strip_script_style('<SCRIPT>x</SCRIPT><p>ok</p><STYLE>y</STYLE>')
        self.assertEqual(copy, '<p>ok</p>')

    def test_keeps_prose_and_removes_multiline(self):
        h = '<h1>Title</h1>\n<script>\nlong()\ncall()\n</script >\n<p>Text</p>'
        self.assertEqual(check.strip_script_style(h), '<h1>Title</h1>\n\n<p>Text</p>')


if __name__ == '__main__':
    unittest.main()
