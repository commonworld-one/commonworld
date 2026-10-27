"""Execute the actual advisory shell consumer; no GitHub/Actions/network."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "tests/fixtures/external-links"
SCRIPT = ROOT / "scripts/summarize-external-links.sh"

class AdvisoryContract(unittest.TestCase):
    def run_advisory(self, report=None, exit_code="2", python=None, missing=False, annotations=None, filename="raw.md"):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            tmp = Path(tmp)
            raw = BASE / "report.md"
            if report is not None:
                raw = tmp / filename
                raw.write_text(report)
            if missing:
                raw = tmp / "missing.md"
            before = raw.read_bytes() if raw.exists() else None
            summary = tmp / "summary.md"
            annotation_path = ROOT / "lychee-api-endpoints.json"
            if annotations is not None:
                annotation_path = tmp / "annotations.json"
                annotation_path.write_text(json.dumps(annotations))
            env = dict(os.environ)
            if python is not None:
                env["PYTHON_BIN"] = python
            proc = subprocess.run(["bash", str(SCRIPT), str(raw), exit_code, str(summary),
                                   str(BASE / "snapshot.json"), str(annotation_path)],
                                  text=True, capture_output=True, env=env, cwd=tmp)
            self.assertEqual(raw.read_bytes() if raw.exists() else None, before)
            self.assertFalse((tmp / "SHOULD_NOT_EXIST").exists())
            return proc, summary.read_text() if summary.exists() else ""

    def test_real_report_is_advisory_with_raw_exit_and_unresolved_findings(self):
        r, summary = self.run_advisory()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Raw Lychee exit: 2", summary)
        self.assertIn("does not mean the link check passed", summary)
        self.assertIn("Remaining errors: 5", summary)
        self.assertIn("Remaining timeouts: 1", summary)
        self.assertIn("Annotated API responses: 2", summary)
        self.assertIn("alive, payment required", summary)
        self.assertIn("alive, method not allowed", summary)
        self.assertNotIn("All links pass", summary)

    def test_bad_count_and_unknown_report_format_fall_back_visibly(self):
        report = (BASE / "report.md").read_text()
        for bad in [report.replace("| 7 |", "| 6 |"), report + "\nNew report syntax\n"]:
            with self.subTest(bad=bad[-30:]):
                r, summary = self.run_advisory(report=bad, exit_code="7")
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("UNCLASSIFIED", summary)
                self.assertIn("Raw Lychee exit: 7", summary)
                self.assertIn("original Lychee report", summary)
                self.assertNotIn("Remaining errors: 0", summary)

    def test_missing_report_and_python_fall_back_without_affecting_raw_exit(self):
        for opts in [{"missing": True}, {"python": "/definitely/no/python"}]:
            with self.subTest(opts=opts):
                r, summary = self.run_advisory(**opts)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("UNCLASSIFIED", summary)
                self.assertIn("Raw Lychee exit: 2", summary)

    def test_empty_and_non_numeric_exit_are_unknown_not_success(self):
        for code in ["", "bogus", "0"]:
            with self.subTest(code=code):
                r, summary = self.run_advisory(exit_code=code)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertIn("Raw Lychee exit: " + (code if code == "0" else "UNKNOWN"), summary)
                self.assertIn("Remaining errors: 5", summary)
                self.assertIn("does not mean the link check passed", summary)

    def test_unknown_annotation_schema_is_visible_unclassified(self):
        r, summary = self.run_advisory(annotations={"version": 999, "endpoints": []})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("UNCLASSIFIED", summary)
        self.assertIn("Raw Lychee exit: 2", summary)

    def test_report_text_and_quoted_filename_cannot_execute_commands(self):
        report = (BASE / "report.md").read_text()
        for content in [report, report + "\n$(touch SHOULD_NOT_EXIST)\n"]:
            r, summary = self.run_advisory(report=content, filename="raw; touch SHOULD_NOT_EXIST; #.md")
            self.assertEqual(r.returncode, 0, r.stderr)
            if content != report:
                self.assertIn("UNCLASSIFIED", summary)

    def test_actual_workflow_run_block_consumes_expected_paths_and_environment(self):
        workflow = (ROOT / ".github/workflows/quality.yml").read_text()
        block = workflow.split("      - name: Explain annotated API responses (advisory)\n", 1)[1].split("      - name: Report\n", 1)[0]
        command = "\n".join(line[10:] for line in block.split("        run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            tmp = Path(tmp)
            (tmp / "scripts").symlink_to(ROOT / "scripts", target_is_directory=True)
            data = tmp / "atlas/data"
            data.mkdir(parents=True)
            (data / "snapshot-verified-2026-10-15.json").symlink_to(BASE / "snapshot.json")
            (tmp / "lychee-api-endpoints.json").symlink_to(ROOT / "lychee-api-endpoints.json")
            summary = tmp / "summary.md"
            env = dict(os.environ, RAW_REPORT=str(BASE / "report.md"), RAW_LYCHEE_EXIT="5", GITHUB_STEP_SUMMARY=str(summary))
            r = subprocess.run(["bash", "-c", command], cwd=tmp, env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            result = summary.read_text()
            self.assertIn("Raw Lychee exit: 5", result)
            self.assertIn("Remaining errors: 5", result)
            self.assertIn("Remaining timeouts: 1", result)

    def test_real_cli_with_temporary_raw_input_preserves_bytes_and_exit_contract(self):
        report = (BASE / "report.md").read_bytes()
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            path = Path(tmp) / "raw.md"
            path.write_bytes(report)
            for suffix, expected in [(b"", 0), (b"\nUnknown format\n", 2)]:
                path.write_bytes(report + suffix)
                before = path.read_bytes()
                r = subprocess.run(["python3", "-B", str(ROOT / "scripts/classify-external-links.py"),
                                    "--report", str(path), "--snapshot", str(BASE / "snapshot.json"),
                                    "--annotations", str(ROOT / "lychee-api-endpoints.json")],
                                   text=True, capture_output=True)
                self.assertEqual(r.returncode, expected)
                self.assertEqual(path.read_bytes(), before)
                if expected == 0:
                    self.assertEqual(json.loads(r.stdout)["status"], "needs_review")
                else:
                    self.assertEqual(r.stdout, "")



class RawSummaryAliases(unittest.TestCase):
    def test_alias_rejected_before_any_write_including_missing_python(self):
        for kind in ["same", "symlink", "hardlink", "relative", "parent", "missing-same", "dangling-symlink"]:
            for python in ["python3", "/no/such/python"]:
                with self.subTest(kind=kind, python=python), tempfile.TemporaryDirectory(dir=ROOT) as directory:
                    tmp = Path(directory)
                    raw = tmp / "raw.md"
                    original = b"raw-evidence-must-not-change\n"
                    if not kind.startswith("missing") and kind != "dangling-symlink":
                        raw.write_bytes(original)
                    summary = raw
                    if kind in ["symlink", "dangling-symlink"]:
                        summary = tmp / "summary.md"
                        summary.symlink_to(raw)
                    elif kind == "hardlink":
                        summary = tmp / "summary.md"
                        os.link(raw, summary)
                    elif kind == "relative":
                        summary = str(tmp) + "/./raw.md"
                    elif kind == "parent":
                        (tmp / "child").mkdir()
                        summary = str(tmp) + "/child/../raw.md"
                    before = raw.read_bytes() if raw.exists() else None
                    r = subprocess.run(["bash", str(SCRIPT), str(raw), "2", str(summary),
                                        str(BASE / "snapshot.json"), str(ROOT / "lychee-api-endpoints.json")],
                                       env=dict(os.environ, PYTHON_BIN=python), capture_output=True, text=True)
                    self.assertEqual(raw.read_bytes() if raw.exists() else None, before, "raw evidence changed")
                    self.assertEqual(r.returncode, 2)
                    self.assertIn("alias", r.stderr.lower())
                    self.assertEqual(r.stdout, "")

    def test_distinct_paths_keep_valid_and_missing_python_advisory_behavior(self):
        for python in ["python3", "/no/such/python"]:
            with self.subTest(python=python), tempfile.TemporaryDirectory(dir=ROOT) as directory:
                summary = Path(directory) / "summary.md"
                raw = BASE / "report.md"
                before = raw.read_bytes()
                r = subprocess.run(["bash", str(SCRIPT), str(raw), "17", str(summary),
                                    str(BASE / "snapshot.json"), str(ROOT / "lychee-api-endpoints.json")],
                                   env=dict(os.environ, PYTHON_BIN=python), capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(raw.read_bytes(), before)
                text = summary.read_text()
                self.assertIn("Raw Lychee exit: 17", text)
                self.assertIn("does not mean the link check passed", text)
                if python == "python3":
                    self.assertIn("Remaining errors: 5", text)
                    self.assertIn("Remaining timeouts: 1", text)
                else:
                    self.assertIn("UNCLASSIFIED", text)

if __name__ == "__main__":
    unittest.main()

