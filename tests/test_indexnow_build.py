"""Sitemap build routing and fail-closed catalogue compatibility, no network."""
import importlib.util,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('indexnow_build',ROOT/'atlas/tools/indexnow_build.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)

class IndexNowBuild(unittest.TestCase):
    def test_real_catalogue_uses_accepted_original_sources_and_no_mirror(self):
        cmd,env,mode=b.plan(ROOT,Path(tempfile.gettempdir())/'synthetic-indexnow-output')
        self.assertEqual(mode,'catalogue');self.assertIn('--overviews',cmd)
        self.assertIn('--overview-selection',cmd);self.assertIn('--no-mirror',cmd)
        self.assertNotIn('CW_SCREENS',env);self.assertEqual(env['CW_SCREENS_REQUIRED'],'1')
    def test_missing_exact_source_package_fails_before_build(self):
        with self.assertRaises(OSError):b.plan(ROOT,Path(tempfile.gettempdir())/'synthetic-out','/not-an-exact-capture-package')
    def test_old_revision_legacy_no_mirror(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);(p/'atlas/site').mkdir(parents=True);(p/'atlas/site/build.py').write_text('--no-mirror')
            cmd,env,mode=b.plan(p,p.parent/'synthetic-out')
            self.assertEqual(mode,'legacy');self.assertIn('--no-mirror',cmd)
    def test_historical_builder_before_no_mirror_option(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);(p/'atlas/site').mkdir(parents=True);(p/'atlas/site/build.py').write_text('old builder')
            cmd,_,mode=b.plan(p,p.parent/'synthetic-out')
            self.assertEqual(mode,'legacy');self.assertNotIn('--no-mirror',cmd)
    def test_partial_catalogue_no_silent_legacy_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);(p/'atlas/catalogue').mkdir(parents=True)
            with self.assertRaisesRegex(ValueError,'lacks accepted adapter'):b.plan(p,p.parent/'synthetic-out')
    def test_missing_catalogue_inputs_do_not_fall_back(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);(p/'atlas/tools').mkdir(parents=True)
            (p/'atlas/tools/catalogue_build.py').write_text((ROOT/'atlas/tools/catalogue_build.py').read_text())
            with self.assertRaises(OSError):b.plan(p,p.parent/'synthetic-out')
    def test_no_output_over_source(self):
        with self.assertRaisesRegex(ValueError,'outside'):b.plan(ROOT,ROOT/'atlas/site/dist')
    def test_catalogue_cannot_disable_required_images_through_inherited_environment(self):
        with patch.dict(os.environ,{'CW_SCREENS_REQUIRED':'0','CW_SCREENS':'off','CW_SCREENS_DIR':'/missing'}):
            _,env,_=b.plan(ROOT,Path(tempfile.gettempdir())/'synthetic-indexnow-output')
        self.assertEqual(env['CW_SCREENS_REQUIRED'],'1');self.assertNotIn('CW_SCREENS',env);self.assertNotIn('CW_SCREENS_DIR',env)
    def test_workflow_routes_new_old_and_discards_partial_failed_old(self):
        t=(ROOT/'.github/workflows/indexnow.yml').read_text()
        self.assertEqual(t.count('indexnow_build.py'),2)
        self.assertNotIn('python atlas/site/build.py',t)
        self.assertIn('rm -rf "$RUNNER_TEMP/old"',t)
        self.assertIn('python "$RUNNER_TEMP/cur/atlas/tools/indexnow.py"',t)

if __name__=='__main__':unittest.main()
