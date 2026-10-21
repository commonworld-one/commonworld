"""atlas/tools/screens_artifact.py: the publish job of screens.yml refuses a bad screens-publish artifact before it
copies or pushes anything (null / malformed manifest entries, unreferenced or missing images, wrong hashes, unknown
slugs, stored entries changed or removed without an image)."""
import contextlib, copy, hashlib, importlib.util, io, json, os, shutil, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('screens_artifact', ROOT / 'atlas' / 'tools' / 'screens_artifact.py')
sa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sa)
DATA = ROOT / 'atlas' / 'data'


def webp(tag):
    body = b'WEBPVP8 ' + tag.encode() * 8
    return b'RIFF' + len(body).to_bytes(4, 'little') + body


def record(slug, b, website=None):
    return {'file': f'{slug}.webp', 'sha256': hashlib.sha256(b).hexdigest(), 'dhash': '00ff00ff00ff00ff',
            'website': website or f'https://{slug}.example', 'source_url': f'https://{slug}.example/',
            'http_status': 200, 'title': slug, 'captured_at': '2026-10-18T04:10:00Z', 'width': 1200, 'height': 750,
            'bytes': len(b)}


class Artifact(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.art = self.root / 'publish'
        self.base = self.root / 'base'
        (self.art / 'screens').mkdir(parents=True)
        self.base.mkdir()
        (self.art / 'screens.md').write_text('summary\n')
        # stored: alpha, beta. This run replaced beta and added gamma.
        self.imgs = {s: webp(s) for s in ('alpha', 'beta', 'gamma')}
        self.new_beta = webp('beta2')
        stored = {'alpha': record('alpha', self.imgs['alpha']), 'beta': record('beta', self.imgs['beta'])}
        self.write_json(self.base / 'manifest.json', {'screens': stored})
        for s in ('alpha', 'beta'):
            (self.base / f'{s}.webp').write_bytes(self.imgs[s])
        self.manifest = {'note': 'n', 'format': 'f', 'updated_at': '2026-10-18T04:20:00Z',
                         'screens': {'alpha': copy.deepcopy(stored['alpha']), 'beta': record('beta', self.new_beta),
                                     'gamma': record('gamma', self.imgs['gamma'])}}
        (self.art / 'screens' / 'beta.webp').write_bytes(self.new_beta)
        (self.art / 'screens' / 'gamma.webp').write_bytes(self.imgs['gamma'])
        self.save()
        self.cards = {'alpha': 'https://alpha.example', 'beta': 'https://beta.example', 'gamma': 'https://gamma.example'}

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def write_json(p, obj):
        Path(p).write_text(json.dumps(obj))

    def save(self):
        self.write_json(self.art / 'screens' / 'manifest.json', self.manifest)

    def problems(self, base=True, cards=True):
        return sa.check(str(self.art), str(self.base) if base else None, self.cards if cards else None)

    def assertProblem(self, needle, **kw):
        probs = self.problems(**kw)
        self.assertTrue(any(needle in p for p in probs), f'{needle!r} not in {probs}')

    def test_good_artifact_passes(self):
        self.assertEqual(self.problems(), [])

    def test_null_entry_fails(self):
        # the case from review: {"screens": {"dealwork-ai": null}} passed the old inline check, then crashed the reader
        self.manifest['screens']['dealwork-ai'] = None
        self.save()
        self.assertProblem('dealwork-ai: entry is NoneType, not an object')
        self.write_json(self.art / 'screens' / 'manifest.json', {'screens': {'dealwork-ai': None}})
        for f in ('beta.webp', 'gamma.webp'):
            (self.art / 'screens' / f).unlink()
        probs = sa.check(str(self.art), None, None)
        self.assertIn('manifest: dealwork-ai: entry is NoneType, not an object', probs)

    def test_non_object_entries_fail(self):
        for bad in ([], 'x', 1, True):
            self.manifest['screens']['gamma'] = bad
            self.save()
            self.assertProblem('gamma: entry is')

    def test_manifest_is_mandatory(self):
        (self.art / 'screens' / 'manifest.json').unlink()
        self.assertProblem('manifest.json missing')

    def test_manifest_shape(self):
        for bad, needle in (([], 'top level is list'), ({'screens': {}}, 'non-empty object'),
                            ({'screens': []}, 'non-empty object'), ({'screens': None}, 'non-empty object'),
                            ({'screens': self.manifest['screens'], 'x': 1}, 'unexpected top-level keys x'),
                            ({'screens': self.manifest['screens'], 'updated_at': 5}, 'updated_at is not a string')):
            self.write_json(self.art / 'screens' / 'manifest.json', bad)
            self.assertProblem(needle)
        (self.art / 'screens' / 'manifest.json').write_text('{not json')
        self.assertProblem('manifest: cannot read')

    def test_bad_fields_fail(self):
        cases = {'file': 'other.webp', 'sha256': 'abc', 'dhash': 'zz', 'website': 'http://gamma.example',
                 'source_url': 'javascript:alert(1)', 'http_status': True, 'title': None,
                 'captured_at': '2026-10-18 04:10', 'width': 1280, 'height': '750', 'bytes': 0}
        for field, value in cases.items():
            m = copy.deepcopy(self.manifest)
            m['screens']['gamma'][field] = value
            self.write_json(self.art / 'screens' / 'manifest.json', m)
            self.assertProblem(f'gamma: bad {field}')
        m = copy.deepcopy(self.manifest)
        m['screens']['gamma']['shot_url'] = 'file:///etc/passwd'
        self.write_json(self.art / 'screens' / 'manifest.json', m)
        self.assertProblem('gamma: bad shot_url')

    def test_missing_and_unexpected_fields_fail(self):
        del self.manifest['screens']['gamma']['sha256']
        self.manifest['screens']['gamma']['evil'] = 1
        self.save()
        self.assertProblem('gamma: missing fields sha256')
        self.assertProblem('gamma: unexpected fields evil')

    def test_optional_shot_url_passes(self):
        self.manifest['screens']['gamma']['shot_url'] = 'https://gamma.example/start'
        self.save()
        self.assertEqual(self.problems(), [])

    def test_bad_slug_fails(self):
        self.manifest['screens']['Bad_Slug'] = self.manifest['screens'].pop('gamma')
        self.save()
        self.assertProblem("bad slug 'Bad_Slug'")

    def test_unreferenced_webp_fails(self):
        (self.art / 'screens' / 'delta.webp').write_bytes(webp('delta'))
        self.assertProblem('delta.webp is not referenced by the manifest')

    def test_referenced_webp_missing_fails(self):
        (self.art / 'screens' / 'gamma.webp').unlink()
        self.assertProblem('gamma is new in the manifest but its image is not in the artifact')
        self.assertProblem('gamma.webp referenced by the manifest is not in the artifact', base=False)

    def test_without_base_every_entry_needs_its_image(self):
        self.assertProblem('alpha.webp referenced by the manifest is not in the artifact', base=False)

    def test_sha_and_size_mismatch_fail(self):
        (self.art / 'screens' / 'gamma.webp').write_bytes(webp('other'))
        self.assertProblem('gamma.webp sha256 differs')
        (self.art / 'screens' / 'gamma.webp').write_bytes(self.imgs['gamma'] + b'x')
        self.assertProblem('gamma.webp is')

    def test_not_webp_fails(self):
        b = b'<svg onload=alert(1)>'
        (self.art / 'screens' / 'gamma.webp').write_bytes(b)
        self.manifest['screens']['gamma'] = record('gamma', b)
        self.save()
        self.assertProblem('gamma.webp is not a WebP image')

    def test_layout(self):
        (self.art / 'screens' / 'notes.txt').write_text('x')
        self.assertProblem('unexpected file screens/notes.txt')
        (self.art / 'screens' / 'notes.txt').unlink()
        (self.art / 'screens' / '.hidden.webp').write_bytes(webp('h'))
        self.assertProblem('unexpected file screens/.hidden.webp')
        (self.art / 'screens' / '.hidden.webp').unlink()
        (self.art / 'screens' / 'sub').mkdir()
        self.assertProblem('screens/sub is not a regular file')
        (self.art / 'screens' / 'sub').rmdir()
        (self.art / 'extra').write_text('x')
        self.assertProblem("unexpected 'extra'")
        (self.art / 'extra').unlink()
        (self.art / 'screens.md').unlink()
        self.assertProblem('screens.md missing')

    def test_symlink_fails(self):
        (self.art / 'screens' / 'gamma.webp').unlink()
        os.symlink(self.base / 'alpha.webp', self.art / 'screens' / 'gamma.webp')
        self.assertProblem('screens/gamma.webp is not a regular file')

    def test_unknown_or_closed_card_fails(self):
        del self.cards['gamma']
        self.assertProblem('cards: gamma is not a live Atlas card')

    def test_website_must_be_canonical_url(self):
        self.cards['gamma'] = 'https://gamma.example.org'
        self.assertProblem("website 'https://gamma.example' is not the card's canonical_url")

    def test_stored_entry_changed_without_image_fails(self):
        self.manifest['screens']['alpha']['title'] = 'changed'
        self.save()
        self.assertProblem('alpha changed in the manifest but its image is not in the artifact')

    def test_stored_slug_removed_fails(self):
        del self.manifest['screens']['alpha']
        self.save()
        self.assertProblem('alpha is in the stored manifest but missing from the new one')

    def test_stored_image_missing_fails(self):
        (self.base / 'alpha.webp').unlink()
        self.assertProblem('stored alpha.webp missing')

    def test_real_live_cards(self):
        cards = sa.live_cards(str(DATA))
        self.assertGreater(len(cards), 100)
        self.assertTrue(all(sa.SLUG.fullmatch(s) and u.startswith('https://') for s, u in cards.items()))

    def test_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.base)]), 0)
        self.manifest['screens']['dealwork-ai'] = None
        self.save()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.base), '--data', str(DATA)]), 1)
        self.assertIn('::error::screens artifact: manifest: dealwork-ai: entry is NoneType', out.getvalue())
        self.assertIn('cards: gamma is not a live Atlas card', out.getvalue())   # synthetic slugs are not Atlas cards
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.root / 'nope')]), 2)


if __name__ == '__main__':
    unittest.main()
