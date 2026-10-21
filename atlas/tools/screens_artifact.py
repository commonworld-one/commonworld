#!/usr/bin/env python3
"""Check the screens-publish artifact before the publish job of .github/workflows/screens.yml opens a PR.

The capture job (atlas/tools/screens.py, a browser on third-party sites, read-only token) uploads:

    screens.md                    the run summary (PR body)
    screens/manifest.json         the whole manifest after the run: {"screens": {slug: record, ...}, note, format, updated_at}
    screens/<slug>.webp           only the images added or replaced in this run

The publish job holds a write token and must not trust any of it. Everything below fails closed, before anything is
copied or pushed; every problem is reported (not only the first):

  layout     only screens.md, screens/manifest.json and screens/<slug>.webp; regular files only, no dot files, no
             symlinks, no subdirectories. manifest.json and screens.md are mandatory.
  manifest   a JSON object; top-level keys only screens / note / format / updated_at; `screens` a non-empty object.
             Each entry: slug matches SLUG; the value is an object with exactly the record fields of screens.py (shot_url
             optional), each of the right type: file == "<slug>.webp", sha256 64-hex, dhash 16-hex, website / source_url
             / shot_url https URLs, http_status an int 100..599 (not a bool) or null (screens.py stores None when
             page.goto() timed out but the page still rendered and passed its checks: no response, no status),
             title a string, captured_at YYYY-MM-DDTHH:MM:SSZ, width 1200, height 750, bytes a positive int.
  images     every <slug>.webp in the artifact is at most MAX_BYTES (stat before opening, bounded read), is a
             structurally valid WebP (webp_problem below, stdlib: RIFF size, chunk walk, VP8 / VP8L / VP8X headers,
             ALPH placement and the VP8X alpha flag, no trailing bytes), then really decodes (decode_problem below:
             Pillow / libwebp, every frame, pixel count bounded) to the manifest's 1200x750, is referenced by the
             manifest, and its sha256 and size equal the manifest record.
  decoder    the structural parser is the first gate and needs only the stdlib; the decode needs Pillow. Without Pillow
             the decode is skipped with a warning, unless CW_WEBP_DECODE_REQUIRED=1 (set in CI and in the publish job):
             then a missing Pillow is a problem, never a silent skip.
  cards      (--data) every slug whose image is in the artifact is a live Atlas card of the newest
             snapshot-verified-*.json, and its `website` equals the card's canonical_url (what the capture shot).
  base       (--base, the atlas/screens directory of the atlas-screens checkout the PR goes to) no slug of the stored
             manifest disappears; every entry whose image is NOT in the artifact is unchanged from the stored entry, and
             its stored <slug>.webp exists with that sha256 (stat size check against MAX_BYTES first, then a streamed,
             bounded sha256). Without --base every manifest entry needs its image in the artifact.
  summary    screens.md is at most MAX_SUMMARY_BYTES (1 MiB; real summaries are a few KB) and valid UTF-8. The PR body
             gets only summary_excerpt(): the first PR_SUMMARY_BYTES (60 000) bytes, cut on a character boundary with a
             note when cut, so it stays under GitHub's 65 536-character PR body limit (--summary-out writes it).
  reads      every file this reads (manifests, images, stored images, screens.md) is size-checked by stat before it is
             opened and read with a hard cap (MAX_BYTES, MAX_SUMMARY_BYTES for screens.md); anything larger fails closed.

atlas/site/screens.py (the build-side reader) skips bad records one by one; this check stops a bad artifact before it
reaches atlas-screens at all, e.g. {"screens": {"dealwork-ai": null}}, which would crash the reader.

Usage: screens_artifact.py --artifact DIR [--base DIR] [--data DIR] [--summary-out FILE]
       exit 0 ok, 1 problems found, 2 usage; FILE (the bounded PR body excerpt of screens.md) is written only when ok
"""
import argparse, glob, hashlib, io, json, os, re, stat, struct, sys, warnings

SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,80}')          # same as atlas/site/screens.py
WEBP_NAME = re.compile(r'([a-z0-9][a-z0-9-]{0,80})\.webp')
HEX64 = re.compile(r'[0-9a-f]{64}')
HEX16 = re.compile(r'[0-9a-f]{16}')
ISO_UTC = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z')
SHOT_W, SHOT_H = 1200, 750
TOP_KEYS = {'screens', 'note', 'format', 'updated_at'}
REQUIRED = {'file', 'sha256', 'dhash', 'website', 'source_url', 'http_status', 'title', 'captured_at', 'width',
            'height', 'bytes'}
OPTIONAL = {'shot_url'}
MAX_BYTES = 8 * 1024 * 1024        # real screens are 5..210 KB
MAX_SUMMARY_BYTES = 1024 * 1024    # screens.md; real summaries are a few KB (GitHub's step summary limit is 1 MiB too)
PR_SUMMARY_BYTES = 60_000          # of screens.md in the PR body (GitHub caps a PR body at 65 536 characters)
MAX_DIM = 4096                     # per side; real screens are 1200x750 (the WebP format allows up to 16383 / 2^24)
MAX_PIXELS = MAX_DIM * MAX_DIM     # Pillow's Image.MAX_IMAGE_PIXELS while decoding (DecompressionBombWarning = error)
MAX_FRAMES = 100                   # animated WebP frames decoded at most (real screens are stills)
CHUNK = 1 << 16                    # streamed sha256 read size
DECODE_ENV = 'CW_WEBP_DECODE_REQUIRED'
ALPHA_FLAG, ANIM_FLAG = 0x10, 0x02  # VP8X flags byte: Rsv Rsv I L E X A R (RFC 9649 2.7)
FOURCC = re.compile(rb'[A-Z0-9 ]{4}')
VP8X_CHUNKS = {b'ICCP', b'ANIM', b'ANMF', b'ALPH', b'VP8 ', b'VP8L', b'EXIF', b'XMP '}


def _chunks(b, start, end, where):
    """Walk RIFF chunks in b[start:end] -> ([(fourcc, payload_start, size)], problem or None). Every chunk must fit,
    odd sizes carry one zero pad byte, and the chunks must end exactly at `end`."""
    out, off = [], start
    while off < end:
        if end - off < 8:
            return out, f'{where}: {end - off} stray bytes after the last chunk'
        cc, size = b[off:off + 4], struct.unpack_from('<I', b, off + 4)[0]
        if not FOURCC.fullmatch(cc):
            return out, f'{where}: bad chunk id {cc!r} at offset {off}'
        stop = off + 8 + size
        if stop + (size & 1) > end:
            return out, f'{where}: chunk {cc.decode()} at offset {off} ({size} bytes) runs past the end'
        if size & 1 and b[stop] != 0:
            return out, f'{where}: chunk {cc.decode()} pad byte is not zero'
        out.append((cc, off + 8, size))
        off = stop + (size & 1)
    return out, None


def _vp8(b, o, n):
    """Lossy bitstream header (RFC 6386 9.1) -> ((w, h), None) or (None, problem)."""
    if n < 10:
        return None, f'VP8 chunk too short ({n} bytes)'
    tag = b[o] | b[o + 1] << 8 | b[o + 2] << 16
    if tag & 1:
        return None, 'VP8 frame is not a key frame'
    if (tag >> 1) & 7 > 3:
        return None, 'VP8 bad version'
    if not (tag >> 4) & 1:
        return None, 'VP8 frame is not shown'
    if (tag >> 5) > n - 10:
        return None, 'VP8 first partition runs past the chunk'
    if b[o + 3:o + 6] != b'\x9d\x01\x2a':
        return None, 'VP8 key frame start code missing'
    w, h = struct.unpack_from('<HH', b, o + 6)
    w, h = w & 0x3fff, h & 0x3fff
    if not w or not h:
        return None, f'VP8 zero dimension {w}x{h}'
    return (w, h), None


def _vp8l(b, o, n):
    """Lossless bitstream header -> ((w, h), None) or (None, problem)."""
    if n < 5:
        return None, f'VP8L chunk too short ({n} bytes)'
    if b[o] != 0x2f:
        return None, 'VP8L signature byte is not 0x2f'
    v = struct.unpack_from('<I', b, o + 1)[0]
    if v >> 29:
        return None, 'VP8L bad version'
    return ((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1), None


def _vp8l_alpha(b, o):
    """alpha_is_used bit of a VP8L header (bit 28 of the 32 bits after the 0x2f signature, RFC 9649 3.2)."""
    return bool(struct.unpack_from('<I', b, o + 1)[0] >> 28 & 1)


def _alpha_problem(b, chunks, where):
    """ALPH rules for one still image or one ANMF frame, chunks = [(fourcc, off, size)] holding exactly one VP8 / VP8L
    -> (has_alpha, problem or None). ALPH may appear only once, only with a lossy 'VP8 ' bitstream (never with VP8L) and
    immediately before the 'VP8 ' chunk (RFC 9649 2.7.1.2 / 2.7.3: VP8X, ALPH, VP8). The image has alpha when it has an
    ALPH chunk or is a VP8L with alpha_is_used = 1."""
    ids = [c for c, _, _ in chunks]
    img = next(c for c in chunks if c[0] in (b'VP8 ', b'VP8L'))
    if b'ALPH' in ids:
        if ids.count(b'ALPH') != 1:
            return True, f'{where}: more than one ALPH chunk'
        if img[0] != b'VP8 ':
            return True, f'{where}: ALPH chunk only goes with a lossy VP8 image, not VP8L'
        i = ids.index(b'ALPH')
        if i + 1 >= len(ids) or ids[i + 1] != b'VP8 ':
            return True, f'{where}: ALPH chunk must come immediately before the VP8 chunk'
        return True, None
    return img[0] == b'VP8L' and _vp8l_alpha(b, img[1]), None


def _alpha_flag_problem(flags, has_alpha):
    """VP8X alpha flag (L) against the image: set iff some frame has alpha (ALPH, or VP8L alpha_is_used = 1). RFC 9649
    defines L as 'set if any of the frames contain transparency information' and alpha_is_used as a hint that SHOULD
    be 1 exactly when some alpha value is not 255; libwebp writes both consistently, so a mismatch either way is refused."""
    if has_alpha and not flags & ALPHA_FLAG:
        return 'VP8X alpha flag is not set but the image has alpha (ALPH chunk or VP8L alpha_is_used)'
    if flags & ALPHA_FLAG and not has_alpha:
        return 'VP8X alpha flag is set but there is no alpha (no ALPH chunk, no VP8L with alpha_is_used)'
    return None


def _image(b, cc, o, n):
    return _vp8(b, o, n) if cc == b'VP8 ' else _vp8l(b, o, n)


def webp_problem(b):
    """-> ((width, height), None) for a structurally valid WebP, or (None, problem). Stdlib only, no decoding: the
    RIFF size equals the file length - 8 (nothing after it, nothing missing), every chunk fits, and the first chunk is
    VP8 (key frame start code 9d 01 2a, non-zero size) or VP8L (signature 0x2f) alone, or VP8X (canvas size, flags)
    followed by the image: one VP8/VP8L whose size equals the canvas, or ANIM + ANMF frames each holding one. ALPH
    only once, only with VP8 (never VP8L) and immediately before the 'VP8 ' chunk; the VP8X alpha flag set exactly when
    the image has alpha. Sides are capped at MAX_DIM. This does not decode: decode_problem does."""
    if len(b) > MAX_BYTES:
        return None, f'{len(b)} bytes, over {MAX_BYTES}'
    if len(b) < 20 or b[:4] != b'RIFF' or b[8:12] != b'WEBP':
        return None, 'no RIFF....WEBP header'
    riff = struct.unpack_from('<I', b, 4)[0]
    if riff != len(b) - 8:
        return None, f'RIFF size {riff} is not file length - 8 ({len(b) - 8})'
    if riff & 1:
        return None, f'RIFF size {riff} is odd'
    chunks, prob = _chunks(b, 12, len(b), 'RIFF')
    if prob:
        return None, prob
    if not chunks:
        return None, 'no chunks'
    cc, o, n = chunks[0]
    if cc in (b'VP8 ', b'VP8L'):
        if len(chunks) != 1:
            return None, f'simple {cc.decode().strip()} file has extra chunks'
        dims, prob = _image(b, cc, o, n)
    elif cc == b'VP8X':
        dims, prob = _vp8x(b, chunks)
    else:
        return None, f'first chunk is {cc.decode()}, not VP8 / VP8L / VP8X'
    if prob:
        return None, prob
    if dims[0] > MAX_DIM or dims[1] > MAX_DIM:
        return None, f'{dims[0]}x{dims[1]} is over {MAX_DIM} per side'
    return dims, None


def _vp8x(b, chunks):
    _, o, n = chunks[0]
    if n != 10:
        return None, f'VP8X chunk is {n} bytes, not 10'
    flags = b[o]
    if flags & 0xc1 or b[o + 1:o + 4] != b'\0\0\0':
        return None, 'VP8X reserved bits set'
    w = (b[o + 4] | b[o + 5] << 8 | b[o + 6] << 16) + 1
    h = (b[o + 7] | b[o + 8] << 8 | b[o + 9] << 16) + 1
    if w > MAX_DIM or h > MAX_DIM:
        return None, f'VP8X canvas {w}x{h} is over {MAX_DIM} per side'
    rest = chunks[1:]
    ids = [c for c, _, _ in rest]
    unknown = sorted({c.decode() for c in ids} - {c.decode() for c in VP8X_CHUNKS})
    if unknown:
        return None, f'VP8X file has unexpected chunks {", ".join(unknown)}'
    if flags & ANIM_FLAG:
        if ids.count(b'ANIM') != 1 or b'ANMF' not in ids or b'VP8 ' in ids or b'VP8L' in ids or b'ALPH' in ids:
            return None, 'animated VP8X needs one ANIM, ANMF frames and no top-level image chunk'
        any_alpha = False
        for cc, fo, fn in rest:
            if cc == b'ANIM' and fn != 6:
                return None, f'ANIM chunk is {fn} bytes, not 6'
            if cc != b'ANMF':
                continue
            if fn < 16 + 8:
                return None, 'ANMF frame too short'
            fx, fy = (b[fo] | b[fo + 1] << 8 | b[fo + 2] << 16) * 2, (b[fo + 3] | b[fo + 4] << 8 | b[fo + 5] << 16) * 2
            fw = (b[fo + 6] | b[fo + 7] << 8 | b[fo + 8] << 16) + 1
            fh = (b[fo + 9] | b[fo + 10] << 8 | b[fo + 11] << 16) + 1
            if fx + fw > w or fy + fh > h:
                return None, 'ANMF frame lies outside the canvas'
            sub, prob = _chunks(b, fo + 16, fo + fn, 'ANMF')
            if prob:
                return None, prob
            imgs = [s for s in sub if s[0] in (b'VP8 ', b'VP8L')]
            if len(imgs) != 1 or any(s[0] not in (b'VP8 ', b'VP8L', b'ALPH') for s in sub):
                return None, 'ANMF frame needs exactly one VP8 / VP8L image (ALPH optional)'
            alpha, prob = _alpha_problem(b, sub, 'ANMF')
            if prob:
                return None, prob
            any_alpha = any_alpha or alpha
            dims, prob = _image(b, *imgs[0])
            if prob:
                return None, prob
            if dims != (fw, fh):
                return None, f'ANMF image {dims[0]}x{dims[1]} is not the frame size {fw}x{fh}'
        prob = _alpha_flag_problem(flags, any_alpha)
        return (None, prob) if prob else ((w, h), None)
    if b'ANIM' in ids or b'ANMF' in ids:
        return None, 'still VP8X file has ANIM / ANMF chunks'
    imgs = [c for c in rest if c[0] in (b'VP8 ', b'VP8L')]
    if len(imgs) != 1:
        return None, f'VP8X file has {len(imgs)} image chunks, not 1'
    alpha, prob = _alpha_problem(b, rest, 'VP8X')
    if prob:
        return None, prob
    prob = _alpha_flag_problem(flags, alpha)
    if prob:
        return None, prob
    dims, prob = _image(b, *imgs[0])
    if prob:
        return None, prob
    if dims != (w, h):
        return None, f'image {dims[0]}x{dims[1]} is not the VP8X canvas {w}x{h}'
    return (w, h), None


def read_capped(path, cap=MAX_BYTES):
    """-> the bytes of the regular file at path. Its size is checked by stat before it is opened and the read stops at
    cap + 1 bytes, so a file over cap (or one that grows after the stat) raises ValueError without being read whole."""
    st = os.stat(path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError('not a regular file')
    if st.st_size > cap:
        raise ValueError(f'{st.st_size} bytes, over {cap}')
    with open(path, 'rb') as fh:
        b = fh.read(cap + 1)
    if len(b) > cap:
        raise ValueError(f'over {cap} bytes')
    return b


def sha256_capped(path, cap=MAX_BYTES):
    """-> (sha256 hex, size) of the regular file at path, streamed in CHUNK reads; same stat check and hard cap as
    read_capped (ValueError over cap)."""
    st = os.stat(path)
    if not stat.S_ISREG(st.st_mode):
        raise ValueError('not a regular file')
    if st.st_size > cap:
        raise ValueError(f'{st.st_size} bytes, over {cap}')
    h, n = hashlib.sha256(), 0
    with open(path, 'rb') as fh:
        while True:
            part = fh.read(min(CHUNK, cap + 1 - n))
            if not part:
                break
            n += len(part)
            if n > cap:
                raise ValueError(f'over {cap} bytes')
            h.update(part)
    return h.hexdigest(), n


def _pillow():
    """PIL.Image, or None when Pillow is not installed."""
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def decode_required():
    return os.environ.get(DECODE_ENV, '').strip() not in ('', '0')


def decoder_problem():
    """-> a problem when the decoder is required ($CW_WEBP_DECODE_REQUIRED=1) but Pillow is missing, else None."""
    if _pillow() is None and decode_required():
        return f'decoder: Pillow is not installed but {DECODE_ENV}=1 (the WebP decode check cannot be skipped here)'
    return None


def decode_problem(b, want=(SHOT_W, SHOT_H)):
    """Really decode WebP bytes with Pillow (libwebp): -> None when every frame decodes and the image is want = (w, h),
    else the problem. Only WEBP is tried (formats=), Image.MAX_IMAGE_PIXELS is MAX_PIXELS while decoding and a
    DecompressionBombWarning is an error, at most MAX_FRAMES frames. Without Pillow this returns None (skipped); the
    caller reports decoder_problem() once when the decode is required. Run it after webp_problem, never instead."""
    Image = _pillow()
    if Image is None:
        return None
    old = Image.MAX_IMAGE_PIXELS
    try:
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(b), formats=['WEBP']) as im:
                if im.size != tuple(want):
                    return f'decodes to {im.size[0]}x{im.size[1]}, manifest says {want[0]}x{want[1]}'
                frames = getattr(im, 'n_frames', 1)
                if frames > MAX_FRAMES:
                    return f'{frames} frames, over {MAX_FRAMES}'
                for i in range(frames):
                    im.seek(i)
                    im.load()
                if im.size != tuple(want):
                    return f'decodes to {im.size[0]}x{im.size[1]}, manifest says {want[0]}x{want[1]}'
    except Exception as ex:                 # anything Pillow / libwebp raises means: not a decodable image
        return f'does not decode: {type(ex).__name__}: {ex}'[:200]
    finally:
        Image.MAX_IMAGE_PIXELS = old
    return None


def _https(v):
    return isinstance(v, str) and v.startswith('https://') and len(v) > len('https://') and not any(c.isspace() for c in v)


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def record_problems(slug, r):
    """-> [str] for one manifest entry."""
    if not isinstance(slug, str) or not SLUG.fullmatch(slug):
        return [f'manifest: bad slug {slug!r}']
    if not isinstance(r, dict):
        return [f'manifest: {slug}: entry is {type(r).__name__}, not an object']
    out = []
    keys = set(r)
    if REQUIRED - keys:
        out.append(f'manifest: {slug}: missing fields {", ".join(sorted(REQUIRED - keys))}')
    if keys - REQUIRED - OPTIONAL:
        out.append(f'manifest: {slug}: unexpected fields {", ".join(sorted(keys - REQUIRED - OPTIONAL))}')
    checks = {
        'file': lambda v: v == f'{slug}.webp',
        'sha256': lambda v: isinstance(v, str) and HEX64.fullmatch(v),
        'dhash': lambda v: isinstance(v, str) and HEX16.fullmatch(v),
        'website': _https,
        'source_url': _https,
        'shot_url': _https,
        'http_status': lambda v: v is None or (_int(v) and 100 <= v <= 599),   # None: goto() timed out (screens.py)
        'title': lambda v: isinstance(v, str),
        'captured_at': lambda v: isinstance(v, str) and ISO_UTC.fullmatch(v),
        'width': lambda v: _int(v) and v == SHOT_W,
        'height': lambda v: _int(v) and v == SHOT_H,
        'bytes': lambda v: _int(v) and v > 0,
    }
    for k, ok in checks.items():
        if k in r and not ok(r[k]):
            out.append(f'manifest: {slug}: bad {k} {r[k]!r}'[:300])
    return out


def live_cards(data_dir):
    """{slug: canonical_url} of the live cards in the newest snapshot-verified-*.json (as atlas/tools/screens.py)."""
    snaps = sorted(glob.glob(os.path.join(data_dir, 'snapshot-verified-*.json')))
    if not snaps:
        raise ValueError(f'no snapshot-verified-*.json in {data_dir}')
    with open(snaps[-1], encoding='utf-8') as fh:
        platforms = json.load(fh)['platforms']
    return {p['slug']: p['canonical_url'] for p in platforms
            if p.get('status') == 'live' and str(p.get('canonical_url') or '').startswith('https://')}


def _load_json(path, label, out):
    try:
        return json.loads(read_capped(path).decode('utf-8'))
    except (OSError, UnicodeDecodeError, ValueError) as ex:
        out.append(f'{label}: cannot read ({ex})')
        return None


def summary_problems(path):
    """-> [problem] for screens.md: a regular file of at most MAX_SUMMARY_BYTES (stat before opening, bounded read)
    holding valid UTF-8."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return []                       # reported by the layout check
        read_capped(path, MAX_SUMMARY_BYTES).decode('utf-8')
    except (OSError, ValueError) as ex:    # UnicodeDecodeError is a ValueError
        return [f'summary: screens.md cannot be read ({ex})'[:300]]
    return []


def summary_excerpt(path, cap=PR_SUMMARY_BYTES):
    """-> the text of screens.md for the PR body: at most `cap` bytes of it (bounded read, never the whole file), cut on
    a UTF-8 character boundary, plus a one-line note when it was cut. Call it after check() passed."""
    with open(path, 'rb') as fh:
        b = fh.read(cap + 1)
    if len(b) <= cap:
        return b.decode('utf-8')
    return (b[:cap].decode('utf-8', errors='ignore') +
            f'\n\n_(summary cut at {cap} bytes; the full summary is in the capture job summary of this run)_\n')


def check(artifact, base=None, cards=None):
    """-> [problem] for the artifact directory; empty = ok. `base`: stored atlas/screens directory or None;
    `cards`: {slug: canonical_url} of live cards or None."""
    out = []
    if not os.path.isdir(artifact):
        return [f'artifact directory {artifact} not found']
    # layout
    top = sorted(os.listdir(artifact))
    for name in top:
        p = os.path.join(artifact, name)
        st = os.lstat(p)
        if name == 'screens.md' and stat.S_ISREG(st.st_mode):
            continue
        if name == 'screens' and stat.S_ISDIR(st.st_mode):
            continue
        out.append(f'layout: unexpected {name!r} at the top of the artifact')
    if 'screens.md' not in top:
        out.append('layout: screens.md missing')
    else:
        out += summary_problems(os.path.join(artifact, 'screens.md'))
    sdir = os.path.join(artifact, 'screens')
    if not os.path.isdir(sdir) or os.path.islink(sdir):
        out.append('layout: screens/ missing')
        return out
    images = {}
    for name in sorted(os.listdir(sdir)):
        p = os.path.join(sdir, name)
        st = os.lstat(p)
        if not stat.S_ISREG(st.st_mode):
            out.append(f'layout: screens/{name} is not a regular file'); continue
        if name == 'manifest.json':
            continue
        m = WEBP_NAME.fullmatch(name)
        if not m:
            out.append(f'layout: unexpected file screens/{name}'); continue
        images[m.group(1)] = p
    mpath = os.path.join(sdir, 'manifest.json')
    if not os.path.isfile(mpath) or os.path.islink(mpath):
        out.append('manifest: screens/manifest.json missing (mandatory)')
        return out
    # manifest
    man = _load_json(mpath, 'manifest', out)
    if man is None:
        return out
    if not isinstance(man, dict):
        return out + [f'manifest: top level is {type(man).__name__}, not an object']
    if set(man) - TOP_KEYS:
        out.append(f'manifest: unexpected top-level keys {", ".join(sorted(map(str, set(man) - TOP_KEYS)))}')
    for k in ('note', 'format', 'updated_at'):
        if k in man and not isinstance(man[k], str):
            out.append(f'manifest: {k} is not a string')
    if 'updated_at' in man and isinstance(man['updated_at'], str) and not ISO_UTC.fullmatch(man['updated_at']):
        out.append(f'manifest: bad updated_at {man["updated_at"]!r}')
    screens = man.get('screens')
    if not isinstance(screens, dict) or not screens:
        return out + ['manifest: "screens" is not a non-empty object']
    good = {}
    dprob = decoder_problem()
    if dprob:
        out.append(dprob)
    for slug, r in screens.items():
        probs = record_problems(slug, r)
        out += probs
        if not probs:
            good[slug] = r
    # images in the artifact
    for slug, p in images.items():
        if os.lstat(p).st_size > MAX_BYTES:
            out.append(f'images: screens/{slug}.webp is over {MAX_BYTES} bytes'); continue
        try:
            b = read_capped(p)
        except (OSError, ValueError) as ex:
            out.append(f'images: screens/{slug}.webp cannot be read ({ex})'); continue
        dims, prob = webp_problem(b)
        if prob:
            out.append(f'images: screens/{slug}.webp is not a valid WebP image ({prob})'[:300])
        elif not dprob:
            r = good.get(slug)
            want = (r['width'], r['height']) if r else (SHOT_W, SHOT_H)
            prob = decode_problem(b, want)
            if prob:
                out.append(f'images: screens/{slug}.webp is not a decodable WebP image ({prob})'[:300])
        if slug not in screens:
            out.append(f'images: screens/{slug}.webp is not referenced by the manifest'); continue
        r = good.get(slug)
        if r is None:
            continue
        if hashlib.sha256(b).hexdigest() != r['sha256']:
            out.append(f'images: screens/{slug}.webp sha256 differs from the manifest')
        if len(b) != r['bytes']:
            out.append(f'images: screens/{slug}.webp is {len(b)} bytes, manifest says {r["bytes"]}')
        if dims and dims != (r['width'], r['height']):
            out.append(f'images: screens/{slug}.webp is {dims[0]}x{dims[1]}, manifest says {r["width"]}x{r["height"]}')
        if cards is not None:
            if slug not in cards:
                out.append(f'cards: {slug} is not a live Atlas card')
            elif r['website'] != cards[slug]:
                out.append(f'cards: {slug}: website {r["website"]!r} is not the card\'s canonical_url {cards[slug]!r}')
    # entries without an image in this artifact
    stored = None
    if base is not None:
        bpath = os.path.join(base, 'manifest.json')
        if os.path.exists(bpath):
            stored = _load_json(bpath, 'base manifest', out)
            stored = (stored or {}).get('screens') if isinstance(stored, dict) else None
            if not isinstance(stored, dict):
                out.append('base manifest: "screens" is not an object')
                stored = {}
        else:
            stored = {}
        for slug in sorted(set(stored) - set(screens)):
            out.append(f'base: {slug} is in the stored manifest but missing from the new one (slugs are never removed)')
    for slug in screens:
        if slug in images:
            continue
        if stored is None:
            out.append(f'images: screens/{slug}.webp referenced by the manifest is not in the artifact')
            continue
        if slug not in stored:
            out.append(f'base: {slug} is new in the manifest but its image is not in the artifact')
            continue
        if screens[slug] != stored[slug]:
            out.append(f'base: {slug} changed in the manifest but its image is not in the artifact')
            continue
        fp = os.path.join(base, f'{slug}.webp')
        if slug not in good:
            continue
        if not os.path.isfile(fp) or os.path.islink(fp):
            out.append(f'base: stored {slug}.webp missing or its sha256 differs from the manifest'); continue
        try:
            digest, _ = sha256_capped(fp)
        except (OSError, ValueError) as ex:
            out.append(f'base: stored {slug}.webp cannot be read ({ex})'); continue
        if digest != good[slug]['sha256']:
            out.append(f'base: stored {slug}.webp missing or its sha256 differs from the manifest')
    return out


def stored_problems(d):
    """-> [problem] for a stored atlas/screens directory (the atlas-screens commit pinned in atlas/screens.lock): its
    manifest.json (bounded read) is valid and every entry's <slug>.webp is a regular file within MAX_BYTES, structurally
    valid, decodes to the manifest's width x height, and has the manifest's sha256 and size. CI runs it on every pinned
    image (tests.test_screens_artifact.Artifact.test_real_atlas_screens, CW_WEBP_DECODE_REQUIRED=1)."""
    out = []
    man = _load_json(os.path.join(d, 'manifest.json'), 'stored manifest', out)
    if man is None:
        return out
    screens = man.get('screens') if isinstance(man, dict) else None
    if not isinstance(screens, dict) or not screens:
        return out + ['stored manifest: "screens" is not a non-empty object']
    dprob = decoder_problem()
    if dprob:
        out.append(dprob)
    for slug, r in screens.items():
        probs = record_problems(slug, r)
        if probs:
            out += probs; continue
        p = os.path.join(d, f'{slug}.webp')
        if os.path.islink(p):
            out.append(f'stored: {slug}.webp is a symlink'); continue
        try:
            b = read_capped(p)
        except (OSError, ValueError) as ex:
            out.append(f'stored: {slug}.webp cannot be read ({ex})'); continue
        dims, prob = webp_problem(b)
        if prob:
            out.append(f'stored: {slug}.webp is not a valid WebP image ({prob})'[:300]); continue
        if dims != (r['width'], r['height']):
            out.append(f'stored: {slug}.webp is {dims[0]}x{dims[1]}, manifest says {r["width"]}x{r["height"]}')
        if not dprob:
            prob = decode_problem(b, (r['width'], r['height']))
            if prob:
                out.append(f'stored: {slug}.webp is not a decodable WebP image ({prob})'[:300])
        if hashlib.sha256(b).hexdigest() != r['sha256'] or len(b) != r['bytes']:
            out.append(f'stored: {slug}.webp sha256 or size differs from the manifest')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--artifact', required=True, help='downloaded screens-publish artifact (holds screens.md, screens/)')
    ap.add_argument('--base', help='atlas/screens directory of the atlas-screens checkout the PR targets')
    ap.add_argument('--data', help='atlas/data directory of main (live cards from the newest snapshot-verified-*.json)')
    ap.add_argument('--summary-out', help='write the bounded PR body excerpt of screens.md here (only when the check passes)')
    a = ap.parse_args(argv)
    cards = None
    if a.data:
        try:
            cards = live_cards(a.data)
        except (OSError, ValueError, KeyError, TypeError) as ex:
            print(f'::error::cannot read the live cards: {ex}'); return 2
    if a.base and not os.path.isdir(a.base):
        print(f'::error::base directory {a.base} not found'); return 2
    if _pillow() is None and not decode_required():
        print(f'::warning::Pillow is not installed: WebP images are checked structurally only, not decoded '
              f'(set {DECODE_ENV}=1 to make this an error)')
    problems = check(a.artifact, a.base, cards)
    for p in problems:
        print(f'::error::screens artifact: {p}')
    if problems:
        print(f'{len(problems)} problem(s): nothing is published')
        return 1
    if a.summary_out:
        with open(a.summary_out, 'w', encoding='utf-8') as fh:
            fh.write(summary_excerpt(os.path.join(a.artifact, 'screens.md')))
    print('screens artifact ok')
    return 0


if __name__ == '__main__':
    sys.exit(main())
