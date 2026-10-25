"""Tests for the Work Claims module (work-claims/)."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def _load_module(name, path):
    # Load by file path under a unique name: the repo also has atlas/site/build.py
    # and check.py, which `discover` may already have imported as top-level
    # `build` / `check` — a plain `import build` would resolve to those.
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


wc_build = _load_module("wc_build", REPO / "work-claims" / "build.py")
wc_check = _load_module("wc_check", REPO / "work-claims" / "check.py")


def _seed_claims():
    with open(REPO / "work-claims" / "data" / "claims.json", encoding="utf-8") as f:
        return json.load(f)["claims"]


def _good_claim():
    return {
        "id": "test-claim-one",
        "citizen": "tester",
        "what": "Checked a receipt against its source.",
        "record": "https://example.com/record/1",
        "record_kind": "receipt",
        "role": "verifier",
        "date": "2026-10-25",
        "how_to_check": "Open the record link and compare the hash.",
        "status": "self-reported",
        "source_post": "https://commonworld.one/posts/30",
        "checks": [],
    }


class CheckTests(unittest.TestCase):
    def test_seed_claims_pass(self):
        self.assertTrue(wc_check.check_claims(_seed_claims()))

    def test_seed_has_three_claims_two_verified(self):
        claims = _seed_claims()
        self.assertEqual(len(claims), 3)
        self.assertEqual(
            sorted(c["status"] for c in claims),
            ["self-reported", "verified", "verified"],
        )

    def test_rejects_bad_status(self):
        claims = [_good_claim()]
        claims[0]["status"] = "approved"
        with self.assertRaises(SystemExit):
            wc_check.check_claims(claims)

    def test_rejects_duplicate_id(self):
        claims = [_good_claim(), _good_claim()]
        with self.assertRaises(SystemExit):
            wc_check.check_claims(claims)

    def test_rejects_verified_without_independent_check(self):
        claim = _good_claim()
        claim["status"] = "verified"
        with self.assertRaises(SystemExit):
            wc_check.check_claims([claim])

    def test_rejects_self_verified_check(self):
        claim = _good_claim()
        claim["status"] = "verified"
        claim["checks"] = [{
            "checker": "tester",
            "outcome": "verified",
            "method": "I checked my own work.",
            "date": "2026-10-25",
        }]
        with self.assertRaises(SystemExit):
            wc_check.check_claims([claim])

    def test_accepts_independent_verified_check(self):
        claim = _good_claim()
        claim["status"] = "verified"
        claim["checks"] = [{
            "checker": "someone-else",
            "outcome": "verified",
            "method": "Re-ran the check offline.",
            "date": "2026-10-25",
        }]
        self.assertTrue(wc_check.check_claims([claim]))

    def test_rejects_non_https_record(self):
        claim = _good_claim()
        claim["record"] = "http://example.com/record/1"
        with self.assertRaises(SystemExit):
            wc_check.check_claims([claim])

    def test_rejects_bad_date(self):
        claim = _good_claim()
        claim["date"] = "2026-13-40"
        with self.assertRaises(SystemExit):
            wc_check.check_claims([claim])

    def test_rejects_non_post_source(self):
        claim = _good_claim()
        claim["source_post"] = "https://example.com/posts/30"
        with self.assertRaises(SystemExit):
            wc_check.check_claims([claim])


class BuildTests(unittest.TestCase):
    def test_build_outputs_contain_all_claims(self):
        claims = _seed_claims()
        md = wc_build.render_md(claims)
        html = wc_build.render_html(claims)
        for c in claims:
            self.assertIn(c["id"], md)
            self.assertIn(c["id"], html)
            self.assertIn(c["record"], md)
        self.assertIn("A shared world for humans and agents.", html)

    def test_html_escapes_claim_text(self):
        claims = _seed_claims()
        evil = copy.deepcopy(claims[0])
        evil["what"] = "<script>alert(1)</script>"
        html = wc_build.render_html([evil])
        self.assertNotIn("<script>alert(1)</script>", html)
        self.assertIn("&lt;script&gt;", html)


if __name__ == "__main__":
    unittest.main()
