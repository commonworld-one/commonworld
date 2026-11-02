"""Unit tests verifying the integrity and references of the Fix Bounty research document (issue #263)."""
import os
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESEARCH_DOC = ROOT / "listings" / "RESEARCH-FIX-BOUNTY.md"
CASE_DOC = ROOT / "listings" / "1f916-2026-10" / "CASE.md"


class TestFixListingResearch(unittest.TestCase):
    def test_research_document_exists_and_populated(self):
        self.assertTrue(RESEARCH_DOC.exists(), "listings/RESEARCH-FIX-BOUNTY.md must exist")
        content = RESEARCH_DOC.read_text(encoding="utf-8")
        self.assertGreater(len(content), 1000, "Research document should contain substantive analysis")

    def test_required_sections_present(self):
        content = RESEARCH_DOC.read_text(encoding="utf-8")
        required_headers = [
            "Context & Motivation",
            "Core Architecture of a Dedicated Fix Listing",
            "Anti-Collision & Work Claim Protocol",
            "Symbiosis Between Finders and Fixers",
            "Quality Gate & Acceptance Criteria",
            "Point Scoring Models",
            "Next Steps & Implementation Roadmap",
        ]
        for header in required_headers:
            self.assertIn(header, content, f"Header '{header}' must be present in research doc")

    def test_issue_263_and_listing_references(self):
        content = RESEARCH_DOC.read_text(encoding="utf-8")
        self.assertIn("263", content, "Must reference issue #263")
        self.assertIn("Listing 60", content, "Must reference Listing 60")
        self.assertIn("TTL", content, "Must specify a Time-To-Live lease mechanism for anti-collision")

    def test_case_study_links_research_document(self):
        self.assertTrue(CASE_DOC.exists(), "listings/1f916-2026-10/CASE.md must exist")
        case_content = CASE_DOC.read_text(encoding="utf-8")
        self.assertIn("RESEARCH-FIX-BOUNTY.md", case_content, "CASE.md must link to RESEARCH-FIX-BOUNTY.md")

    def test_relative_links_resolve(self):
        content = RESEARCH_DOC.read_text(encoding="utf-8")
        # Match markdown links [text](path)
        links = re.findall(r"\[.*?\]\((?!http|#)(.*?)\)", content)
        doc_dir = RESEARCH_DOC.parent
        for link in links:
            # Strip anchors if present
            clean_link = link.split("#")[0]
            if clean_link:
                target_path = (doc_dir / clean_link).resolve()
                self.assertTrue(
                    target_path.exists(),
                    f"Relative link '{link}' points to non-existent path '{target_path}'"
                )


if __name__ == "__main__":
    unittest.main()
