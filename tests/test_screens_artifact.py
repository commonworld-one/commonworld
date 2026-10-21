"""atlas/tools/screens_artifact.py: the publish job of screens.yml refuses a bad screens-publish artifact before it
copies or pushes anything (null / malformed manifest entries, unreferenced or missing images, wrong hashes, unknown
slugs, stored entries changed or removed without an image)."""
import contextlib, copy, hashlib, importlib.util, io, json, os, shutil, struct, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location('screens_artifact', ROOT / 'atlas' / 'tools' / 'screens_artifact.py')
sa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sa)
DATA = ROOT / 'atlas' / 'data'


FIXTURES = ROOT / 'tests' / 'fixtures' / 'webp'        # real encoder output (Pillow/libwebp), 1200x750


def riff(*chunks):
    """RIFF/WEBP file from (fourcc, payload) chunks, odd payloads zero-padded, sizes consistent."""
    body = b'WEBP'
    for cc, data in chunks:
        body += cc + struct.pack('<I', len(data)) + data + b'\0' * (len(data) & 1)
    return b'RIFF' + struct.pack('<I', len(body)) + body


def vp8(w=1200, h=750, filler=b'\x00' * 16):
    """Minimal structurally valid lossy key frame: frame tag (key, v0, shown, partition size), 9d 01 2a, w, h."""
    tag = (1 << 4) | (len(filler) << 5)
    return tag.to_bytes(3, 'little') + b'\x9d\x01\x2a' + struct.pack('<HH', w, h) + filler


def webp(tag):
    return riff((b'VP8 ', vp8(filler=tag.encode() * 8)))


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
        self.assertProblem('gamma.webp is not a valid WebP image')

    def put(self, b):
        """gamma.webp := b, with a manifest record matching its sha256 and size (only the structure is left to fail)."""
        (self.art / 'screens' / 'gamma.webp').write_bytes(b)
        self.manifest['screens']['gamma'] = record('gamma', b)
        self.save()

    def test_bare_12_byte_header_fails(self):
        # Codex HOLD P1: RIFF\0\0\0\0WEBP with a matching sha256 and size passed the old signature-only check
        self.put(b'RIFF\x00\x00\x00\x00WEBP')
        self.assertProblem('gamma.webp is not a valid WebP image (no RIFF....WEBP header)')
        self.put(b'RIFF\x04\x00\x00\x00WEBP')
        self.assertProblem('gamma.webp is not a valid WebP image')
        self.put(riff())
        self.assertProblem('gamma.webp is not a valid WebP image')

    def test_wrong_riff_size_fails(self):
        good = webp('gamma')
        for size in (0, len(good) - 9, len(good) - 7, len(good), 0xffffffff):
            self.put(good[:4] + struct.pack('<I', size) + good[8:])
            self.assertProblem('is not file length - 8')

    def test_trailing_garbage_fails(self):
        good = webp('gamma')
        self.put(good + b'<script>')                      # RIFF size left as is
        self.assertProblem('is not file length - 8')
        bad = good + b'\0' * 8                            # RIFF size covers it: stray bytes / bogus chunk
        self.put(bad[:4] + struct.pack('<I', len(bad) - 8) + bad[8:])
        self.assertProblem('gamma.webp is not a valid WebP image')
        bad = good + b'JUNK' + struct.pack('<I', 4) + b'evil'
        self.put(bad[:4] + struct.pack('<I', len(bad) - 8) + bad[8:])
        self.assertProblem('simple VP8 file has extra chunks')

    def test_truncated_chunk_fails(self):
        good = webp('gamma')
        cut = good[:-6]
        self.put(cut[:4] + struct.pack('<I', len(cut) - 8) + cut[8:])
        self.assertProblem('runs past the end')
        self.put(riff((b'VP8 ', vp8()))[:24])
        self.assertProblem('gamma.webp is not a valid WebP image')
        huge = good[:16] + struct.pack('<I', 0x7fffffff) + good[20:]
        self.put(huge)
        self.assertProblem('runs past the end')

    def test_bad_vp8_fails(self):
        cases = ((riff((b'VP8 ', b'\x10\x00\x00\x9d\x01\x2a')), 'VP8 chunk too short'),
                 (riff((b'VP8 ', b'\x01' + vp8()[1:])), 'not a key frame'),
                 (riff((b'VP8 ', vp8()[:3] + b'\x00\x00\x00' + vp8()[6:])), 'start code missing'),
                 (riff((b'VP8 ', vp8(w=0))), 'zero dimension'),
                 (riff((b'VP8 ', vp8(h=0))), 'zero dimension'),
                 (riff((b'VP8 ', vp8()[:3] + b'\xff' * 7 + vp8()[10:])), 'start code missing'),
                 (riff((b'VP8 ', ((1 << 4) | (999 << 5)).to_bytes(3, 'little') + vp8()[3:])), 'first partition'),
                 (riff((b'ICCP', b'xx')), 'first chunk is ICCP'),
                 (riff((b'vp8 ', vp8())), 'bad chunk id'))
        for b, needle in cases:
            self.put(b)
            self.assertProblem(needle)

    def test_bad_vp8l_fails(self):
        def vp8l(sig=0x2f, w=1200, h=750, version=0):
            return riff((b'VP8L', bytes([sig]) + struct.pack('<I', (w - 1) | (h - 1) << 14 | version << 29) + b'\0' * 4))
        self.put(vp8l())
        self.assertEqual(self.problems(), [])
        for b, needle in ((vp8l(sig=0x2e), 'signature byte'), (vp8l(version=1), 'VP8L bad version'),
                          (riff((b'VP8L', b'\x2f\x00')), 'VP8L chunk too short'),
                          (vp8l(w=1201), 'is 1201x750, manifest says 1200x750')):
            self.put(b)
            self.assertProblem(needle)

    def test_bad_vp8x_fails(self):
        def x(flags=0, w=1200, h=750):
            return b'VP8X', bytes([flags, 0, 0, 0]) + (w - 1).to_bytes(3, 'little') + (h - 1).to_bytes(3, 'little')
        self.put(riff(x(), (b'VP8 ', vp8())))
        self.assertEqual(self.problems(), [])
        cases = ((riff(x()), 'VP8X file has 0 image chunks'),
                 (riff(x(), (b'VP8 ', vp8()), (b'VP8 ', vp8())), 'VP8X file has 2 image chunks'),
                 (riff(x(), (b'VP8 ', vp8(w=1000))), 'is not the VP8X canvas'),
                 (riff(x(w=20000), (b'VP8 ', vp8())), 'over 4096 per side'),
                 (riff(x(flags=0x80), (b'VP8 ', vp8())), 'reserved bits'),
                 (riff((b'VP8X', b'\0' * 9), (b'VP8 ', vp8())), 'not 10'),
                 (riff(x(), (b'JUNK', b'x'), (b'VP8 ', vp8())), 'unexpected chunks JUNK'),
                 (riff(x(), (b'VP8 ', vp8()), (b'ALPH', b'a')), 'ALPH chunk'),
                 (riff(x(flags=0x02), (b'VP8 ', vp8())), 'animated VP8X needs'),
                 (riff(x(flags=0x02), (b'ANIM', b'\0' * 6)), 'animated VP8X needs'),
                 (riff(x(), (b'ANIM', b'\0' * 6), (b'VP8 ', vp8())), 'still VP8X file has ANIM'))
        for b, needle in cases:
            self.put(b)
            self.assertProblem(needle)
        frame = b'\0' * 6 + (1199).to_bytes(3, 'little') + (749).to_bytes(3, 'little') + b'\0' * 4
        sub = b'VP8 ' + struct.pack('<I', len(vp8())) + vp8()
        self.put(riff(x(flags=0x02), (b'ANIM', b'\0' * 6), (b'ANMF', frame + sub)))
        self.assertEqual(self.problems(), [])
        self.put(riff(x(flags=0x02), (b'ANIM', b'\0' * 6), (b'ANMF', frame)))
        self.assertProblem('ANMF frame too short')
        self.put(riff(x(flags=0x02), (b'ANIM', b'\0' * 6), (b'ANMF', frame + sub[:-4])))
        self.assertProblem('runs past the end')
        big = b'\0' * 6 + (1299).to_bytes(3, 'little') + (749).to_bytes(3, 'little') + b'\0' * 4
        self.put(riff(x(flags=0x02), (b'ANIM', b'\0' * 6), (b'ANMF', big + sub)))
        self.assertProblem('outside the canvas')

    def test_oversize_fails(self):
        self.put(riff((b'VP8 ', vp8() + b'\0' * sa.MAX_BYTES)))
        self.assertProblem(f'is over {sa.MAX_BYTES} bytes')
        self.put(riff((b'VP8 ', vp8(w=5000, h=750))))
        self.assertProblem('over 4096 per side')

    def test_real_webp_files_pass(self):
        files = sorted(FIXTURES.glob('*.webp'))
        self.assertEqual([f.name for f in files], ['alpha-1200x750.webp', 'anim-1200x750.webp',
                                                    'lossless-1200x750.webp', 'lossy-1200x750.webp'])
        for f in files:
            with self.subTest(f.name):
                self.assertEqual(sa.webp_problem(f.read_bytes()), ((1200, 750), None))
                self.put(f.read_bytes())
                self.assertEqual(self.problems(), [])
        b = (FIXTURES / 'lossy-1200x750.webp').read_bytes()
        for n in (12, 20, 30, len(b) // 2, len(b) - 1):   # any truncation of a real file fails
            with self.subTest(cut=n):
                self.put(b[:n])
                self.assertProblem('gamma.webp is not a valid WebP image')

    def test_real_atlas_screens(self):
        """The real atlas-screens images, when a checkout is at $CW_ATLAS_SCREENS (atlas/screens of the branch)."""
        d = os.environ.get('CW_ATLAS_SCREENS')
        if not d:
            self.skipTest('CW_ATLAS_SCREENS not set')
        man = json.loads(Path(d, 'manifest.json').read_text())['screens']
        self.assertGreater(len(man), 100)
        for slug, r in man.items():
            self.assertEqual(sa.webp_problem(Path(d, f'{slug}.webp').read_bytes()), ((r['width'], r['height']), None),
                             slug)

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
