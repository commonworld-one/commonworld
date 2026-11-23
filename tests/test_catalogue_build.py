import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalogue_build', ROOT/'atlas/tools/catalogue_build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class CatalogueBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cat = Path(self.temp.name)
        self.record = {'state':'draft','check':None}
        self.selection = {'slugs':['example'],'deferred_slugs':['deferred']}
        self.write()
        self.context = patch.object(build,'CAT',self.cat)
        self.context.start()

    def tearDown(self):
        self.context.stop()
        self.temp.cleanup()

    def write(self):
        (self.cat/'selection.json').write_text(json.dumps(self.selection))
        (self.cat/'overviews.json').write_text(json.dumps({'cards':{'example':self.record}}))

    def test_no_accepted_build_without_actual_receipts(self):
        with self.assertRaisesRegex(ValueError,'receipts are incomplete'):
            build.plan('accepted')

    def test_no_silent_deferred_acceptance(self):
        self.selection['deferred_slugs']=['example'];self.write()
        with self.assertRaisesRegex(ValueError,'deferred'):
            build.plan('accepted')

    def test_selection_exact_not_count_only(self):
        self.selection['slugs']=['other'];self.write()
        with self.assertRaisesRegex(ValueError,'exactly'):
            build.plan('accepted')

    def test_preview_requires_bound_images(self):
        with self.assertRaisesRegex(ValueError,'screens-dir'):
            build.plan('preview')

    def test_accepted_plan_preserves_selection_and_receipt_checks_in_generator(self):
        self.record={'state':'reviewed','check':{'by':'real-reviewer'}};self.write()
        cmd,_=build.plan('accepted')
        self.assertIn('--overview-selection',cmd)
        self.assertNotIn('--draft-preview',cmd)
        self.assertNotIn('--no-mirror',cmd)

    def test_schedule_sources_not_rewired_as_part_of_adapter(self):
        text=(ROOT/'.github/workflows/refresh.yml').read_text()
        self.assertNotIn('catalogue_build.py',text)


if __name__=='__main__':unittest.main()
