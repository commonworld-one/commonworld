"""atlas/tools/screens_artifact.py: the publish job of screens.yml refuses a bad screens-publish artifact before it
copies or pushes anything (null / malformed manifest entries, unreferenced or missing images, wrong hashes, unknown
slugs, stored entries changed or removed without an image, images that do not really decode, unbounded reads).

The images that must pass are real, decodable WebP files: the fixtures (Pillow/libwebp output) and solid-colour
lossless files built by vp8l_solid below. The decode tests need Pillow; without it they skip locally and fail when
CW_WEBP_DECODE_REQUIRED=1 (CI)."""
import contextlib, copy, hashlib, importlib.util, io, json, os, shutil, struct, sys, tempfile, unittest, unittest.mock
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


def vp8l_solid(argb=0xff336699, w=1200, h=750, alpha_used=None):
    """A real, decodable lossless bitstream (stdlib): one colour, no transforms, no colour cache, no meta prefix codes,
    five simple prefix codes with one symbol each (green, red, blue, alpha, distance), so every pixel takes 0 bits."""
    a, r, g, b = argb >> 24 & 255, argb >> 16 & 255, argb >> 8 & 255, argb & 255
    if alpha_used is None:
        alpha_used = a != 255
    fields = [(w - 1, 14), (h - 1, 14), (int(alpha_used), 1), (0, 3), (0, 1), (0, 1), (0, 1)]
    for sym in (g, r, b, a):
        fields += [(1, 1), (0, 1), (1, 1), (sym, 8)]        # simple code, 1 symbol, 8-bit symbol
    fields += [(1, 1), (0, 1), (0, 1), (0, 1)]              # distance: simple code, 1 symbol, 1-bit symbol 0
    acc = n = 0
    for v, k in fields:
        acc |= v << n
        n += k
    return b'\x2f' + acc.to_bytes((n + 7) // 8, 'little')


def chunk(cc, data):
    return cc + struct.pack('<I', len(data)) + data + b'\0' * (len(data) & 1)


def webp(tag):
    """A real 1200x750 lossless WebP whose colour (and so sha256) depends on tag."""
    rgb = int.from_bytes(hashlib.sha256(tag.encode()).digest()[:3], 'big')
    return riff((b'VP8L', vp8l_solid(0xff000000 | rgb)))


def x(flags=0, w=1200, h=750):
    """VP8X chunk."""
    return b'VP8X', bytes([flags, 0, 0, 0]) + (w - 1).to_bytes(3, 'little') + (h - 1).to_bytes(3, 'little')


FRAME = b'\0' * 6 + (1199).to_bytes(3, 'little') + (749).to_bytes(3, 'little') + b'\0' * 4   # ANMF 1200x750 at 0,0


def anim(*frames, flags=0x02):
    return riff(x(flags=flags), (b'ANIM', b'\0' * 6), *((b'ANMF', FRAME + f) for f in frames))


def need_decoder(test):
    """Skip a decode test when Pillow is missing locally; fail it when the decode is required (CI)."""
    if sa._pillow() is None:
        if sa.decode_required():
            test.fail(f'Pillow is not installed but {sa.DECODE_ENV}=1')
        test.skipTest('Pillow not installed (decode not required here)')


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
        self.assertProblem('simple VP8L file has extra chunks')

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
        self.put(riff((b'VP8L', vp8l_solid())))
        self.assertEqual(self.problems(), [])
        for b, needle in ((vp8l(sig=0x2e), 'signature byte'), (vp8l(version=1), 'VP8L bad version'),
                          (riff((b'VP8L', b'\x2f\x00')), 'VP8L chunk too short'),
                          (vp8l(w=1201), 'is 1201x750, manifest says 1200x750')):
            self.put(b)
            self.assertProblem(needle)

    def test_header_only_images_fail_the_decode(self):
        # Codex HOLD P2-1: a valid VP8L header + 4 zero bytes (or a VP8 frame header + zero partition) passes the
        # structural parser with the right size; only a real decode shows there is no image in it
        need_decoder(self)
        def vp8l_header(w=1200, h=750):
            return b'\x2f' + struct.pack('<I', (w - 1) | (h - 1) << 14) + b'\0' * 4
        for name, b in (('VP8L header + 4 zero bytes', riff((b'VP8L', vp8l_header()))),
                        ('VP8 header + zero partition', riff((b'VP8 ', vp8()))),
                        ('VP8 header + text partition', riff((b'VP8 ', vp8(filler=b'gammagam' * 8)))),
                        ('VP8X + VP8L header only', riff(x(), (b'VP8L', vp8l_header()))),
                        ('VP8X + VP8 header only', riff(x(), (b'VP8 ', vp8()))),
                        ('animated, VP8L header only', anim(chunk(b'VP8L', vp8l_header())))):
            with self.subTest(name):
                self.assertEqual(sa.webp_problem(b), ((1200, 750), None))       # the structure alone is fine
                self.assertIsNotNone(sa.decode_problem(b))
                self.put(b)
                self.assertProblem('gamma.webp is not a decodable WebP image (does not decode')

    def test_decoded_size_must_be_the_manifest_size(self):
        need_decoder(self)
        small = riff((b'VP8L', vp8l_solid(w=600, h=375)))
        self.assertEqual(sa.decode_problem(small), 'decodes to 600x375, manifest says 1200x750')
        self.assertIsNone(sa.decode_problem(small, (600, 375)))
        self.put(small)
        self.assertProblem('decodes to 600x375, manifest says 1200x750')

    def test_decoder_required(self):
        real = sa._pillow
        sa._pillow = lambda: None
        try:
            with unittest.mock.patch.dict(os.environ, {sa.DECODE_ENV: '1'}):
                self.assertProblem('decoder: Pillow is not installed but CW_WEBP_DECODE_REQUIRED=1')
                self.put(riff((b'VP8L', b'\x2f' + struct.pack('<I', 1199 | 749 << 14) + b'\0' * 4)))
                self.assertProblem('decoder: Pillow is not installed')
            with unittest.mock.patch.dict(os.environ, {sa.DECODE_ENV: ''}):
                self.assertEqual(self.problems(), [])                 # local run without Pillow: structure only...
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.base)]), 0)
                self.assertIn('::warning::Pillow is not installed', out.getvalue())   # ...and it says so
        finally:
            sa._pillow = real

    def test_alph_rules(self):
        alph = b'\0' + b'\0' * 9
        lossy = (FIXTURES / 'alpha-1200x750.webp')
        cases = (
            (riff(x(0x10), (b'ALPH', alph), (b'EXIF', b'exif'), (b'VP8 ', vp8())), 'immediately before the VP8 chunk'),
            (riff(x(0x10), (b'VP8 ', vp8()), (b'ALPH', alph)), 'immediately before the VP8 chunk'),
            (riff(x(0x10), (b'ALPH', alph), (b'ALPH', alph), (b'VP8 ', vp8())), 'more than one ALPH chunk'),
            (riff(x(0x10), (b'ALPH', alph), (b'VP8L', vp8l_solid(0x80336699))), 'only goes with a lossy VP8'),
            (riff(x(0), (b'ALPH', alph), (b'VP8 ', vp8())), 'alpha flag is not set but the image has alpha'),
            (riff(x(0x10), (b'VP8 ', vp8())), 'alpha flag is set but there is no alpha'),
            (riff(x(0x10), (b'VP8L', vp8l_solid())), 'alpha flag is set but there is no alpha'),
            (riff(x(0), (b'VP8L', vp8l_solid(0x80336699))), 'alpha flag is not set but the image has alpha'),
            (anim(chunk(b'ALPH', alph) + chunk(b'VP8L', vp8l_solid()), flags=0x12), 'only goes with a lossy VP8'),
            (anim(chunk(b'VP8 ', vp8()) + chunk(b'ALPH', alph), flags=0x12), 'immediately before the VP8 chunk'),
            (anim(chunk(b'VP8L', vp8l_solid(0x80336699))), 'alpha flag is not set but the image has alpha'),
            (anim(chunk(b'VP8L', vp8l_solid()), flags=0x12), 'alpha flag is set but there is no alpha'),
        )
        for b, needle in cases:
            with self.subTest(needle):
                self.put(b)
                self.assertProblem(needle)
        b = lossy.read_bytes()                                 # real lossy + alpha: VP8X(L) ALPH VP8
        self.assertEqual(sa.webp_problem(b), ((1200, 750), None))
        i = b.index(b'VP8 ')                                   # same file with an EXIF chunk between ALPH and VP8
        moved = b[:i] + chunk(b'EXIF', b'exif') + b[i:]
        moved = moved[:4] + struct.pack('<I', len(moved) - 8) + moved[8:]
        self.assertIn('immediately before the VP8 chunk', sa.webp_problem(moved)[1])
        flagless = b[:20] + bytes([b[20] & ~0x10]) + b[21:]   # alpha flag cleared
        self.assertIn('alpha flag is not set', sa.webp_problem(flagless)[1])
        need_decoder(self)
        for b in (riff(x(0x10), (b'VP8L', vp8l_solid(0x80336699))), anim(chunk(b'VP8L', vp8l_solid(0x80336699)), flags=0x12),
                  riff((b'VP8L', vp8l_solid(0x80336699)))):  # VP8L alpha: VP8X with the flag, animated, simple file
            self.put(b)
            self.assertEqual(self.problems(), [])

    def test_bad_vp8x_fails(self):
        self.put(riff(x(), (b'VP8L', vp8l_solid())))
        self.assertEqual(self.problems(), [])
        cases = ((riff(x()), 'VP8X file has 0 image chunks'),
                 (riff(x(), (b'VP8 ', vp8()), (b'VP8 ', vp8())), 'VP8X file has 2 image chunks'),
                 (riff(x(), (b'VP8 ', vp8(w=1000))), 'is not the VP8X canvas'),
                 (riff(x(w=20000), (b'VP8 ', vp8())), 'over 4096 per side'),
                 (riff(x(flags=0x80), (b'VP8 ', vp8())), 'reserved bits'),
                 (riff((b'VP8X', b'\0' * 9), (b'VP8 ', vp8())), 'not 10'),
                 (riff(x(), (b'JUNK', b'x'), (b'VP8 ', vp8())), 'unexpected chunks JUNK'),
                 (riff(x(0x10), (b'VP8 ', vp8()), (b'ALPH', b'a')), 'ALPH chunk'),
                 (riff(x(flags=0x02), (b'VP8 ', vp8())), 'animated VP8X needs'),
                 (riff(x(flags=0x02), (b'ANIM', b'\0' * 6)), 'animated VP8X needs'),
                 (riff(x(), (b'ANIM', b'\0' * 6), (b'VP8 ', vp8())), 'still VP8X file has ANIM'))
        for b, needle in cases:
            self.put(b)
            self.assertProblem(needle)
        frame = FRAME
        sub = chunk(b'VP8 ', vp8())
        self.put(anim(chunk(b'VP8L', vp8l_solid()), chunk(b'VP8L', vp8l_solid(0xff112233))))
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
                b = sa.read_capped(f)
                self.assertEqual(sa.webp_problem(b), ((1200, 750), None))
                if sa._pillow() is not None:
                    self.assertIsNone(sa.decode_problem(b))
                self.put(b)
                self.assertEqual(self.problems(), [])
        b = sa.read_capped(FIXTURES / 'lossy-1200x750.webp')
        for n in (12, 20, 30, len(b) // 2, len(b) - 1):   # any truncation of a real file fails
            with self.subTest(cut=n):
                self.put(b[:n])
                self.assertProblem('gamma.webp is not a valid WebP image')

    def test_real_atlas_screens(self):
        """The real atlas-screens images, when a checkout is at $CW_ATLAS_SCREENS (atlas/screens of the branch)."""
        d = os.environ.get('CW_ATLAS_SCREENS')
        if not d:
            self.skipTest('CW_ATLAS_SCREENS not set')
        need_decoder(self)                                  # CI sets CW_WEBP_DECODE_REQUIRED=1: no Pillow = failure
        man = json.loads(sa.read_capped(Path(d, 'manifest.json')).decode())['screens']   # bounded, like every read
        self.assertGreater(len(man), 100)
        self.assertEqual(sa.stored_problems(d), [])         # each image: bounded read, structure, decode, sha256, size
        print(f'\npinned screens: {len(man)} images read (bounded), parsed and decoded at '
              f'{sorted({(r["width"], r["height"]) for r in man.values()})}', file=sys.stderr)

    def stored_dir(self):
        d = self.root / 'stored'
        d.mkdir()
        imgs = {s: webp(s) for s in ('alpha', 'beta')}
        for s, b in imgs.items():
            (d / f'{s}.webp').write_bytes(b)
        self.write_json(d / 'manifest.json', {'screens': {s: record(s, b) for s, b in imgs.items()}})
        return d

    def test_stored_problems(self):
        d = self.stored_dir()
        self.assertEqual(sa.stored_problems(str(d)), [])
        (d / 'beta.webp').write_bytes(webp('other'))
        self.assertIn('stored: beta.webp sha256 or size differs from the manifest', sa.stored_problems(str(d)))
        (d / 'beta.webp').unlink()
        self.assertTrue(any(p.startswith('stored: beta.webp cannot be read') for p in sa.stored_problems(str(d))))

    def test_stored_header_only_image_fails_the_decode(self):
        need_decoder(self)
        d = self.stored_dir()
        b = riff((b'VP8L', b'\x2f' + struct.pack('<I', 1199 | 749 << 14) + b'\0' * 4))
        (d / 'beta.webp').write_bytes(b)
        man = json.loads((d / 'manifest.json').read_text())
        man['screens']['beta'] = record('beta', b)
        self.write_json(d / 'manifest.json', man)
        self.assertTrue(any('stored: beta.webp is not a decodable WebP image (does not decode' in p
                            for p in sa.stored_problems(str(d))), sa.stored_problems(str(d)))

    def test_oversized_pinned_file_fails_unread(self):
        # Codex HOLD P2-2: no read_bytes() of a pinned file before the size check; sparse files, nothing is written
        d = self.stored_dir()
        with open(d / 'beta.webp', 'r+b') as fh:
            fh.truncate(sa.MAX_BYTES + 1)
        with unittest.mock.patch('builtins.open', side_effect=AssertionError('opened an oversized file')) as op:
            with self.assertRaisesRegex(ValueError, f'over {sa.MAX_BYTES}'):
                sa.read_capped(d / 'beta.webp')
            with self.assertRaisesRegex(ValueError, f'over {sa.MAX_BYTES}'):
                sa.sha256_capped(d / 'beta.webp')
            op.assert_not_called()
        self.assertIn(f'stored: beta.webp cannot be read ({sa.MAX_BYTES + 1} bytes, over {sa.MAX_BYTES})',
                      sa.stored_problems(str(d)))
        with open(d / 'manifest.json', 'r+b') as fh:
            fh.truncate(sa.MAX_BYTES + 1)
        probs = sa.stored_problems(str(d))
        self.assertEqual(len(probs), 1)
        self.assertIn('stored manifest: cannot read', probs[0])

    def test_capped_reads(self):
        p = self.root / 'f'
        p.write_bytes(b'x' * 100)
        self.assertEqual(sa.read_capped(p, cap=100), b'x' * 100)
        self.assertEqual(sa.sha256_capped(p, cap=100), (hashlib.sha256(b'x' * 100).hexdigest(), 100))
        for fn in (sa.read_capped, sa.sha256_capped):
            with self.assertRaisesRegex(ValueError, 'over 99'):
                fn(p, cap=99)
            with self.assertRaisesRegex(ValueError, 'not a regular file'):
                fn(self.root, cap=99)
        big = self.root / 'big'                              # streamed: a file a bit over CHUNK hashes in pieces
        big.write_bytes(os.urandom(sa.CHUNK * 3 + 7))
        self.assertEqual(sa.sha256_capped(big), (hashlib.sha256(big.read_bytes()).hexdigest(), sa.CHUNK * 3 + 7))

    def test_oversized_base_file_fails(self):
        with open(self.base / 'alpha.webp', 'r+b') as fh:   # sparse: stat says MAX_BYTES + 1
            fh.truncate(sa.MAX_BYTES + 1)
        self.assertProblem(f'base: stored alpha.webp cannot be read ({sa.MAX_BYTES + 1} bytes, over {sa.MAX_BYTES})')
        with open(self.base / 'manifest.json', 'r+b') as fh:
            fh.truncate(sa.MAX_BYTES + 1)
        self.assertProblem('base manifest: cannot read')

    def test_oversized_artifact_manifest_fails(self):
        with open(self.art / 'screens' / 'manifest.json', 'r+b') as fh:
            fh.truncate(sa.MAX_BYTES + 1)
        self.assertProblem(f'manifest: cannot read ({sa.MAX_BYTES + 1} bytes, over {sa.MAX_BYTES})')

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


    # http_status: None is what screens.py stores when page.goto() timed out but the page rendered (review finding)
    def test_http_status_none_passes(self):
        self.manifest['screens']['gamma']['http_status'] = None
        self.save()
        self.assertEqual(self.problems(), [])
        for bad in (True, False, 99, 600, '200', 200.0, [], {}):
            self.manifest['screens']['gamma']['http_status'] = bad
            self.save()
            self.assertProblem('gamma: bad http_status')

    def test_goto_timeout_capture_passes_the_check(self):
        """The real capture path: shoot() with page.goto() raising a Playwright timeout, the page rendering anyway, the
        manifest entry built by screens.manifest_record() (http_status None), then the publish check accepts it."""
        need_decoder(self)
        import asyncio
        from PIL import Image
        spec = importlib.util.spec_from_file_location('atlas_tools_screens', ROOT / 'atlas' / 'tools' / 'screens.py')
        screens = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(screens)
        im = Image.new('RGB', (screens.VIEW_W, screens.VIEW_H))
        im.putdata([((x * 7) % 256, (y * 5) % 256, (x + y) % 256) for y in range(screens.VIEW_H) for x in range(screens.VIEW_W)])
        buf = io.BytesIO()
        im.save(buf, 'PNG')
        png = buf.getvalue()

        class Loc:
            async def count(self):
                return 0

        class Keyboard:
            async def press(self, key):
                pass

        class Page:
            url = 'https://gamma.example/'
            main_frame = None
            frames = []
            keyboard = Keyboard()

            def __init__(self):
                self.main_frame = self

            async def goto(self, url, **kw):
                raise Exception(f'Timeout {screens.NAV_MS}ms exceeded.')   # what Playwright's TimeoutError says

            async def wait_for_load_state(self, *a, **kw):
                pass

            async def wait_for_timeout(self, ms):
                pass

            def get_by_role(self, *a, **kw):
                return Loc()

            def get_by_text(self, *a, **kw):
                return Loc()

            def locator(self, *a, **kw):
                return Loc()

            async def add_style_tag(self, **kw):
                pass

            async def evaluate(self, js):
                if js == screens.PLACEHOLDER_JS:
                    return {'share': 0.0, 'loading_only': False}
                if 'innerText' in js:
                    return 'Gamma is a platform for agents. ' * 20
                return None

            async def title(self):
                return 'Gamma'

            async def screenshot(self, **kw):
                return png

        class Ctx:
            async def route(self, *a):
                pass

            async def new_page(self):
                return Page()

            async def close(self):
                pass

        class Browser:
            async def new_context(self, **kw):
                return Ctx()

        rec, data, img = asyncio.run(screens.shoot(Browser(), 'https://gamma.example', {}))
        self.assertTrue(rec.get('ok'), rec)
        self.assertIsNone(rec['http_status'])
        self.assertIn('load event timed out', rec['note'])
        rec.update(dhash=screens.dhash(img), sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
        entry = screens.manifest_record('gamma', rec, 'https://gamma.example')
        self.assertIsNone(entry['http_status'])
        self.manifest['screens']['gamma'] = entry
        self.save()
        (self.art / 'screens' / 'gamma.webp').write_bytes(data)
        self.assertEqual(self.problems(), [])

    # screens.md: bounded (stat + capped read), UTF-8, and only a bounded excerpt reaches the PR body (review finding)
    def test_oversized_summary_fails(self):
        with open(self.art / 'screens.md', 'r+b') as fh:   # sparse: stat says MAX_SUMMARY_BYTES + 1
            fh.truncate(sa.MAX_SUMMARY_BYTES + 1)
        self.assertProblem(f'summary: screens.md cannot be read ({sa.MAX_SUMMARY_BYTES + 1} bytes, over {sa.MAX_SUMMARY_BYTES})')
        (self.art / 'screens.md').write_bytes(b'x' * sa.MAX_SUMMARY_BYTES)
        self.assertEqual(self.problems(), [])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.base),
                                      '--summary-out', str(self.root / 'body.md')]), 0)
        self.assertLess(len((self.root / 'body.md').read_text(encoding='utf-8')), 65_536)

    def test_summary_not_utf8_fails(self):
        (self.art / 'screens.md').write_bytes(b'## ok\n\xff\xfe')
        self.assertProblem('summary: screens.md cannot be read')

    def test_summary_excerpt(self):
        p = self.root / 'screens.md'
        p.write_text('short ü\n', encoding='utf-8')
        self.assertEqual(sa.summary_excerpt(p), 'short ü\n')
        p.write_bytes(b'a' * 9 + 'ü'.encode() + b'tail')       # the cut at 10 bytes falls inside the two-byte ü
        out = sa.summary_excerpt(p, cap=10)
        self.assertTrue(out.startswith('a' * 9 + '\n\n_(summary cut at 10 bytes'), out)
        p.write_bytes(b'b' * sa.PR_SUMMARY_BYTES)
        self.assertEqual(sa.summary_excerpt(p), 'b' * sa.PR_SUMMARY_BYTES)
        real_open = open
        reads = []

        class Spy:                                            # never reads more than cap + 1 bytes
            def __init__(self, fh):
                self.fh = fh

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.fh.close()

            def read(self, n=-1):
                reads.append(n)
                return self.fh.read(n)
        p.write_bytes(b'c' * (sa.PR_SUMMARY_BYTES * 3))
        with unittest.mock.patch('builtins.open', lambda *a, **k: Spy(real_open(*a, **k))):
            out = sa.summary_excerpt(p)
        self.assertEqual(reads, [sa.PR_SUMMARY_BYTES + 1])
        self.assertTrue(out.startswith('c' * sa.PR_SUMMARY_BYTES + '\n\n_(summary cut'))
        self.assertLess(len(out), 65_536)

    def test_summary_out_only_when_ok(self):
        out = self.root / 'body.md'
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.base), '--summary-out', str(out)]), 0)
        self.assertEqual(out.read_text(encoding='utf-8'), 'summary\n')
        out.unlink()
        self.manifest['screens']['dealwork-ai'] = None
        self.save()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sa.main(['--artifact', str(self.art), '--base', str(self.base), '--summary-out', str(out)]), 1)
        self.assertFalse(out.exists())

if __name__ == '__main__':
    unittest.main()
