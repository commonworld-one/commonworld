import copy,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'atlas/site'))
import check

class ArchiveGrowthGuard(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory();self.d=Path(self.t.name)
        self.row={'id':'old','status':'closed','archive':{'kind':'closed_history','external_links':'disabled','history':{'slug':'old','status':'closed'}}}
        self.locs={check.ORIGIN+'/atlas/platforms/old/'}
        for f in ['atlas/platforms/old/index.html','atlas/platforms/old/index.md']:
            p=self.d/f;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('retained history')
        self.save()
    def tearDown(self):self.t.cleanup()
    def save(self):
        (self.d/'atlas/closed.json').write_text(json.dumps({'platforms':[self.row]}))
        (self.d/'atlas/platforms/old.json').write_text(json.dumps(self.row))
    def kept(self,expected={'old'},locs=None):return check._preserved_archive_slugs(str(self.d),self.locs if locs is None else locs,expected)
    def test_decided_complete_archive_is_preserved(self):self.assertEqual(self.kept(),{'old'})
    def test_unapproved_archive_is_not_preservation(self):self.assertEqual(self.kept(set()),set())
    def test_genuine_page_loss_not_excused(self):
        for f in ['atlas/platforms/old/index.html','atlas/platforms/old/index.md','atlas/platforms/old.json']:
            with self.subTest(f=f):
                p=self.d/f;raw=p.read_bytes();p.unlink();self.assertEqual(self.kept(),set());p.write_bytes(raw)
    def test_missing_sitemap_or_history_not_excused(self):
        self.assertEqual(self.kept(locs=set()),set());self.row['archive']['history']={};self.save();self.assertEqual(self.kept(),set())
    def test_mismatched_detail_not_excused(self):
        (self.d/'atlas/platforms/old.json').write_text('{}');self.assertEqual(self.kept(),set())
    def test_previous_committed_slugs_all_preserved_in_actual_build(self):
        if not (ROOT/'atlas/site/dist/atlas/closed.json').exists():self.skipTest('built catalogue required')
        import xml.etree.ElementTree as ET
        locs={e.text for name in ['sitemap.xml','atlas/sitemap.xml'] for e in ET.parse(ROOT/'atlas/site/dist'/name).getroot().iter() if e.tag.endswith('}loc')}
        with patch.object(check,'_git_snapshot_slugs',return_value={'old-missing-record'}):
            self.assertTrue(any('old-missing-record' in f for f in check.growth_guard(locs)))
        ids={r['id'] for r in json.load(open(ROOT/'atlas/site/dist/atlas/closed.json'))['platforms']}
        with patch.object(check,'_git_snapshot_slugs',return_value=ids):
            self.assertFalse(check.growth_guard(locs))
