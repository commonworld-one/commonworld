"""Unit tests verifying the five delivery contracts documentation and cross-references (issue #164)."""
import os
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DELIVERY_DOC = ROOT / "docs" / "DELIVERY-CONTRACTS.md"
CONTRIBUTING_DOC = ROOT / "CONTRIBUTING.md"
EVIDENCE_DOC = ROOT / "docs" / "EVIDENCE.md"
AGENTS_DOC = ROOT / "docs" / "AGENTS-CONTRIBUTING.md"


class TestDeliveryContracts(unittest.TestCase):
    def test_delivery_contracts_doc_exists_and_populated(self):
        self.assertTrue(DELIVERY_DOC.exists(), "docs/DELIVERY-CONTRACTS.md must exist")
        content = DELIVERY_DOC.read_text(encoding="utf-8")
        self.assertGreater(len(content), 1200, "Delivery contracts doc must contain substantive text")

    def test_all_five_contracts_present(self):
        content = DELIVERY_DOC.read_text(encoding="utf-8")
        required_headers = [
            "Completion Contract",
            "Review Freshness",
            "Behavior Contract",
            "Cost Contract",
            "Agent Execution Contract",
            "Delivery Evidence Block",
        ]
        for header in required_headers:
            self.assertIn(header, content, f"Header '{header}' must be present in DELIVERY-CONTRACTS.md")

    def test_lifecycle_states_and_surfaces(self):
        content = DELIVERY_DOC.read_text(encoding="utf-8")
        # 5 lifecycle states
        for state in ["implemented", "reviewed", "merged", "deployed", "validated"]:
            self.assertIn(state, content, f"Lifecycle state '{state}' must be documented")
        # 4 surfaces
        for surface in ["HTML", "Markdown Twin", "JSON API", "MCP Server"]:
            self.assertIn(surface, content, f"Surface '{surface}' must be documented")
        # 3 paths
        for path in ["Success", "Access Denied", "Empty State"]:
            self.assertIn(path, content, f"Path '{path}' must be documented")

    def test_contributing_and_evidence_cross_references(self):
        # CONTRIBUTING.md must reference DELIVERY-CONTRACTS.md
        contrib_content = CONTRIBUTING_DOC.read_text(encoding="utf-8")
        self.assertIn("DELIVERY-CONTRACTS.md", contrib_content, "CONTRIBUTING.md must link to DELIVERY-CONTRACTS.md")
        self.assertIn("Delivery", contrib_content, "CONTRIBUTING.md must point to the Delivery Evidence block")

        # docs/EVIDENCE.md must reference DELIVERY-CONTRACTS.md
        evidence_content = EVIDENCE_DOC.read_text(encoding="utf-8")
        self.assertIn("DELIVERY-CONTRACTS.md", evidence_content, "docs/EVIDENCE.md must link to DELIVERY-CONTRACTS.md")

        # docs/AGENTS-CONTRIBUTING.md must reference DELIVERY-CONTRACTS.md
        agents_content = AGENTS_DOC.read_text(encoding="utf-8")
        self.assertIn("DELIVERY-CONTRACTS.md", agents_content, "docs/AGENTS-CONTRIBUTING.md must link to DELIVERY-CONTRACTS.md")

    def test_relative_links_resolve(self):
        content = DELIVERY_DOC.read_text(encoding="utf-8")
        links = re.findall(r"\[.*?\]\((?!http|#)(.*?)\)", content)
        doc_dir = DELIVERY_DOC.parent
        for link in links:
            clean_link = link.split("#")[0]
            if clean_link:
                target_path = (doc_dir / clean_link).resolve()
                self.assertTrue(
                    target_path.exists(),
                    f"Relative link '{link}' points to non-existent path '{target_path}'"
                )


if __name__ == "__main__":
    unittest.main()
