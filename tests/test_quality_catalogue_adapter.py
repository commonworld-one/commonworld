from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class QualityCatalogueAdapterTests(unittest.TestCase):
    def test_quality_uses_accepted_catalogue(self):
        text = (ROOT / '.github/workflows/quality.yml').read_text()
        self.assertIn('run: python atlas/tools/catalogue_build.py --mode accepted', text)
        self.assertNotIn('run: python atlas/site/build.py', text)
        self.assertIn("CW_SCREENS_REQUIRED: '1'", text)
        self.assertIn('refs/heads/atlas-screens', text)

    def test_quality_gates_not_removed(self):
        text = (ROOT / '.github/workflows/quality.yml').read_text()
        for gate in ['links-internal:', 'links-worker-posts:', 'links-external:', 'lighthouse:', '--offline', 'fail: true', '@lhci/cli@0.15.1']:
            self.assertIn(gate, text)
