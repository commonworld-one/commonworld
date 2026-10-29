"""Public #146 report excerpt and pinned card claims; no live requests."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/classify-external-links.py"
REPORT = (ROOT / "tests/fixtures/external-links/report.md").read_text()
CARDS = json.loads((ROOT / "tests/fixtures/external-links/snapshot.json").read_text())
ANNOTATIONS = {"version": 1, "endpoints": [
    {"card": "asterpay", "url": "https://x402.asterpay.io/v1/market/price/bitcoin", "accept": [402],
     "reason": "Explicit unpaid API GET in supported protocol claim; #167 requests endpoint-only classification."},
    {"card": "arkham", "url": "https://api.arkm.com/x402/intelligence/address", "accept": [405],
     "reason": "Explicit unpaid API POST in supported protocol claim; #167 identifies plain-GET 405."}
]}

class ClassifierContract(unittest.TestCase):
    def invoke(self, report=REPORT, annotations=None, cards=None):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            report_path = tmp / "raw.md"
            report_path.write_text(report)
            (tmp / "annotations.json").write_text(json.dumps(annotations if annotations is not None else ANNOTATIONS))
            (tmp / "cards.json").write_text(json.dumps(cards if cards is not None else CARDS))
            result = subprocess.run([sys.executable, str(SCRIPT), "--report", str(report_path),
                                     "--annotations", str(tmp / "annotations.json"),
                                     "--snapshot", str(tmp / "cards.json")], text=True, capture_output=True)
            self.assertEqual(report_path.read_text(), report, "Raw evidence must never be rewritten")
            return result

    def test_public_report_excerpt_moves_only_two_reviewed_endpoint_records(self):
        r = self.invoke()
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        self.assertEqual(d["raw_counts"]["Errors"], 7)
        self.assertEqual(d["remaining_errors"], 5)
        self.assertEqual(d["remaining_timeouts"], 1)
        self.assertEqual(d["status"], "needs_review")
        self.assertEqual(len(d["expected_api_responses"]), 2)
        self.assertEqual({x["url"] for x in d["expected_api_responses"]}, {
            "https://x402.asterpay.io/v1/market/price/bitcoin",
            "https://api.arkm.com/x402/intelligence/address"})
        for x in d["expected_api_responses"]:
            self.assertIn("alive", x["classification"])
            self.assertTrue(x["input"].endswith("/index.html"))
        remaining = "\n".join(x["line"] for x in d["remaining_findings"])
        self.assertIn("<https://agora.burmaster.com/>", remaining)
        self.assertIn("<https://www.reuters.com/business/", remaining)
        self.assertIn("[ERROR]", remaining)
        self.assertIn("[TIMEOUT]", remaining)
        self.assertIn("[404]", remaining)
        self.assertIn("[503]", remaining)
        original_findings = [line for line in REPORT.splitlines() if line.startswith("* [")]
        resulting_findings = [x["line"] for x in d["remaining_findings"] + d["expected_api_responses"]]
        self.assertCountEqual(resulting_findings, original_findings)

    def test_same_host_other_path_query_and_fragment_are_not_allowlisted(self):
        target = ANNOTATIONS["endpoints"][0]["url"]
        for other in [target + "?other=1", target + "/elsewhere", target + "#changed"]:
            with self.subTest(other=other):
                r = self.invoke(report=REPORT.replace("<" + target + ">", "<" + other + ">"))
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(json.loads(r.stdout)["remaining_errors"], 6)

    def test_unlisted_statuses_still_fail_for_annotated_url(self):
        for code in [401, 404, 500, 503]:
            with self.subTest(code=code):
                r = self.invoke(report=REPORT.replace("* [402] <" + ANNOTATIONS["endpoints"][0]["url"],
                                                    "* [" + str(code) + "] <" + ANNOTATIONS["endpoints"][0]["url"]))
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(json.loads(r.stdout)["remaining_errors"], 6)

    def test_no_annotations_keeps_all_original_failures(self):
        r = self.invoke(annotations={"version": 1, "endpoints": []})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["remaining_errors"], 7)

    def test_unknown_report_format_count_or_status_is_rejected(self):
        bad_reports = [
            REPORT.replace("| 7 |", "| 6 |"),
            REPORT.replace("| 7 |", "| 6 |").replace("| 🔍 Total | 8 |", "| 🔍 Total | 7 |"),
            REPORT.replace("## Errors per input", "## Findings"),
            REPORT.replace("* [402]", "* [NEWSTATUS]", 1),
            REPORT.replace("* [402]", "* [999]", 1),
            REPORT + "\nUnrecognized extra finding\n",
            REPORT.replace("| ❓ Unknown | 0 |", "| ❓ Unknown | 1 |"),
            REPORT.replace("### Errors in atlas/site/dist/atlas/earn/index.html", "### Unrecognized source"),
            REPORT.replace("| 🔍 Total | 8 |", "| 🔍 Total | 7 |"),
        ]
        for report in bad_reports:
            with self.subTest(report=report[:30]):
                self.assertNotEqual(report, REPORT)
                r = self.invoke(report=report)
                self.assertEqual(r.returncode, 2)
                self.assertEqual(r.stdout, "")
                self.assertIn("not classified", r.stderr)

    def test_annotation_validation_rejects_homepages_missing_claims_and_unknown_schema(self):
        cases = []
        for change in [{"card": "unknown"}, {"url": "https://asterpay.io"},
                       {"url": "https://asterpay.io/"}, {"url": "https://asterpay.io/?api=1"},
                       {"url": "https://x402.asterpay.io/unlisted"}, {"accept": [200]},
                       {"accept": [True]}, {"accept": []}, {"unknown": "ignored?"}]:
            a = copy.deepcopy(ANNOTATIONS)
            a["endpoints"][0].update(change)
            cases.append(a)
        a = copy.deepcopy(ANNOTATIONS); a["version"] = 2; cases.append(a)
        a = copy.deepcopy(ANNOTATIONS); a["endpoints"].append(a["endpoints"][0]); cases.append(a)
        a = copy.deepcopy(ANNOTATIONS); a["unknown"] = True; cases.append(a)
        for a in cases:
            with self.subTest(annotation=a):
                r = self.invoke(annotations=a)
                self.assertEqual(r.returncode, 2)
                self.assertEqual(r.stdout, "")
                self.assertIn("not classified", r.stderr)

    def test_unchecked_or_independent_claims_do_not_support_annotations(self):
        for field, value in [("outcome", "unchecked"), ("basis", "independent_source"), ("kind", "description")]:
            cards = copy.deepcopy(CARDS)
            for card in cards["platforms"]:
                for claim in card["claims"]:
                    if claim["source_url"] == ANNOTATIONS["endpoints"][0]["url"]:
                        claim[field] = value
            r = self.invoke(cards=cards)
            self.assertEqual(r.returncode, 2)
            self.assertEqual(r.stdout, "")

    def test_canonical_homepage_cannot_be_whitelisted_even_with_protocol_claim(self):
        cards = copy.deepcopy(CARDS)
        url = ANNOTATIONS["endpoints"][0]["url"]
        next(c for c in cards["platforms"] if c["slug"] == "asterpay")["canonical_url"] = url + "/"
        r = self.invoke(cards=cards)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stdout, "")



SPEC = importlib.util.spec_from_file_location("external_link_classifier", SCRIPT)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)

def fixture(url):
    return ({"platforms": [{"slug": "asterpay", "canonical_url": "https://asterpay.io",
                            "claims": [{"kind": "protocol", "source_url": url,
                                        "basis": "direct_observation", "outcome": "supported"}]}]},
            {"version": 1, "endpoints": [{"card": "asterpay", "url": url, "accept": [402],
                                        "reason": "Synthetic boundary fixture, not a live observation"}]})

class HomepageDotSegments(unittest.TestCase):
    def test_rejects_dot_segment_aliases_with_exact_supported_claim(self):
        for path in ["/./", "/api/../", "/%2e/", "/%2E/", "/api/%2e%2e/", "/api%2f..%2f"]:
            with self.subTest(path=path):
                snapshot, annotations = fixture("https://asterpay.io" + path)
                with self.assertRaisesRegex(ValueError, "dot.segment"):
                    module.validate_annotations(snapshot, annotations)

    def test_dot_segments_in_canonical_urls_also_fail_closed(self):
        snapshot, annotations = fixture("https://asterpay.io/v1/api")
        snapshot["platforms"][0]["canonical_url"] += "/./"
        with self.assertRaisesRegex(ValueError, "dot.segment"):
            module.validate_annotations(snapshot, annotations)

    def test_dots_within_segments_and_query_do_not_broaden_literal_matching(self):
        url = "https://asterpay.io/v1/data..json?next=/../"
        snapshot, annotations = fixture(url)
        selected = module.validate_annotations(snapshot, annotations)
        self.assertEqual(list(selected), [url])
        self.assertNotIn(url + "&other=1", selected)
        self.assertNotIn(url.replace("data..json", "other.json"), selected)

if __name__ == "__main__":
    unittest.main()

