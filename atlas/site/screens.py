"""Atlas homepage screenshots (stdlib; Pillow optional, for thumbnails).

The images do not live on main. They sit on the orphan branch `atlas-screens` of the same repo:

    atlas/screens/<slug>.webp      1200x750 WebP, one viewport of the card's homepage
    atlas/screens/manifest.json    {"screens": {slug: {file, sha256, dhash, website, source_url, http_status, title,
                                                       captured_at, width, height, bytes[, shot_url][, confirmed_at]}}}
                                   confirmed_at (issue #273): the newest weekly capture that showed no visible change; the
                                   stored image and captured_at stay as they were

build.py calls load() once. Where the screenshots come from, first hit wins:
  1. env CW_SCREENS=off                  -> no previews (placeholders everywhere)
  2. env CW_SCREENS_DIR=/path            -> a directory holding manifest.json + <slug>.webp (local work)
  3. git: the commit pinned in atlas/screens.lock (one line, the full 40-hex sha of an atlas-screens commit; fetched by
     sha when it is not already present, --depth=1 in shallow clones), then `git archive` of atlas/screens/ into
     atlas/site/.screens-cache/branch/ (gitignored)
  4. the public tarball https://codeload.github.com/<repo>/tar.gz/<that sha> (Cloudflare Pages clones only the branch
     it builds, and may have no usable `origin` remote)
  5. nothing found -> no previews; the build still succeeds. env CW_SCREENS_REQUIRED=1 (set in CI) turns this into an error.

Which commit: env CW_SCREENS_SHA=<40-hex> overrides the lock; CW_SCREENS_SHA=head follows the moving branch head
(local work on new screenshots only). Without a lock file the branch head is used, as before. A lock that is not a
full lowercase sha stops the build. The weekly screens PR (screens.yml) goes to atlas-screens; after it is merged,
a PR on main bumps atlas/screens.lock to the new atlas-screens commit, so every image change is reviewed twice and
every build (CI, deploy) uses exactly the reviewed images.

Thumbnails for the catalog grids are the TOP BAND of the screenshot (12:5, 600x250), made with Pillow and cached by
sha256 under atlas/site/.screens-cache/thumbs/. Without Pillow the grids use the full image (same band via CSS).
"""
import hashlib, io, json, os, re, shutil, subprocess, sys, tarfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
CACHE = os.path.join(HERE, '.screens-cache')
BRANCH = 'atlas-screens'
BRANCH_PATH = 'atlas/screens'
TARBALL_BASE = 'https://codeload.github.com/commonworld-one/commonworld/tar.gz/'
TARBALL = TARBALL_BASE + 'refs/heads/' + BRANCH
LOCK = os.path.join(REPO_ROOT, 'atlas', 'screens.lock')
SHA40 = re.compile(r'[0-9a-f]{40}')
SHOT_W, SHOT_H = 1200, 750
THUMB_W, THUMB_H = 600, 250          # top band, aspect 12:5
THUMB_VERSION = 'b1'                 # bump to re-render every cached thumbnail
THUMB_MAX = 24 * 1024                # check.py allows 25 KB
RIGHTS = 'Screenshot of a third-party website; not covered by the Atlas CC BY 4.0 data licence.'
SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,80}')


def _log(msg):
    print(f'screens: {msg}', file=sys.stderr)


def _git(*args, timeout=90):
    return subprocess.run(['git', *args], cwd=REPO_ROOT, capture_output=True, timeout=timeout)


def pinned_sha():
    """-> the atlas-screens commit to build from (40-hex), or None to follow the branch head."""
    env = os.environ.get('CW_SCREENS_SHA', '').strip()
    if env.lower() == 'head':
        return None
    if env:
        if not SHA40.fullmatch(env):
            raise SystemExit(f'CW_SCREENS_SHA must be a full 40-character lowercase sha or "head", got {env!r}')
        return env
    if not os.path.exists(LOCK):
        return None
    with open(LOCK, encoding='utf-8') as f:
        lines = [ln.strip() for ln in f.read().splitlines() if ln.strip()]
    if len(lines) != 1 or not SHA40.fullmatch(lines[0]):
        raise SystemExit('atlas/screens.lock must hold exactly one line: the full 40-character lowercase sha of an atlas-screens commit')
    return lines[0]


def _from_git(dest, sha=None):
    try:
        if _git('rev-parse', '--git-dir', timeout=10).returncode != 0:
            return None
        # --depth=1 only in clones that are already shallow (CI, Cloudflare Pages): it would turn a full clone shallow
        shallow = _git('rev-parse', '--is-shallow-repository', timeout=10).stdout.strip() == b'true'
        depth = ['--depth=1'] if shallow else []
        if sha:  # pinned: exactly this commit, never the moving branch head
            if _git('cat-file', '-e', f'{sha}^{{commit}}', timeout=10).returncode != 0:
                f = _git('fetch', '--quiet', *depth, '--no-tags', 'origin', sha)
                if f.returncode != 0:
                    _log(f'git fetch origin {sha} failed ({f.stderr.decode(errors="replace").strip()[:160]})')
                    return None
            a = _git('archive', '--format=tar', sha, BRANCH_PATH)
            if a.returncode != 0:
                _log(f'git archive {sha} {BRANCH_PATH} failed')
                return None
            _extract(tarfile.open(fileobj=io.BytesIO(a.stdout)), dest, strip=0)
            return f'git {sha} (pinned)'
        f = _git('fetch', '--quiet', *depth, '--no-tags', 'origin', f'+refs/heads/{BRANCH}:refs/remotes/origin/{BRANCH}')
        if f.returncode != 0:
            _log(f'git fetch origin {BRANCH} failed ({f.stderr.decode(errors="replace").strip()[:160]}); trying a local ref')
        for ref in (f'refs/remotes/origin/{BRANCH}', f'refs/heads/{BRANCH}'):
            if _git('rev-parse', '--verify', '--quiet', ref, timeout=10).returncode == 0:
                a = _git('archive', '--format=tar', ref, BRANCH_PATH)
                if a.returncode == 0:
                    sha = _git('rev-parse', '--short', ref, timeout=10).stdout.decode().strip()
                    _extract(tarfile.open(fileobj=io.BytesIO(a.stdout)), dest, strip=0)
                    return f'git {ref} @ {sha}'
    except (OSError, subprocess.SubprocessError) as ex:
        _log(f'git not usable ({ex.__class__.__name__})')
    return None


def _from_tarball(dest, sha=None):
    url = TARBALL_BASE + sha if sha else TARBALL
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'CommonworldAtlasBuild/1.0 (+https://commonworld.one/atlas/about/)'})
        with urllib.request.urlopen(req, timeout=90) as r:
            data = r.read()
        _extract(tarfile.open(fileobj=io.BytesIO(data), mode='r:gz'), dest, strip=1)
        return 'tarball ' + url
    except Exception as ex:  # offline, rate-limited, branch missing: build without previews
        _log(f'tarball download failed ({ex.__class__.__name__}: {str(ex)[:120]})')
        return None


def _extract(tf, dest, strip):
    """Copy only atlas/screens/<file> members (no links, no paths outside dest) into dest/."""
    os.makedirs(dest, exist_ok=True)
    for m in tf.getmembers():
        parts = m.name.split('/')[strip:]
        if not m.isfile() or len(parts) != 3 or '/'.join(parts[:2]) != BRANCH_PATH:
            continue
        name = parts[2]
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*\.webp|manifest\.json', name):
            continue
        with tf.extractfile(m) as src, open(os.path.join(dest, name), 'wb') as dst:
            shutil.copyfileobj(src, dst)


def load():
    """-> (directory, {slug: record}, source description). ({}, None) records when no screenshots are available."""
    if os.environ.get('CW_SCREENS', '').lower() in ('0', 'off', 'no', 'false'):
        shutil.rmtree(os.path.join(CACHE, 'branch'), ignore_errors=True)  # check.py compares against this copy
        return None, {}, 'disabled (CW_SCREENS=off)'
    d, src = os.environ.get('CW_SCREENS_DIR'), None
    if d:
        src = f'CW_SCREENS_DIR {d}'
    else:
        d = os.path.join(CACHE, 'branch')
        if os.path.isdir(d):
            shutil.rmtree(d)
        sha = pinned_sha()
        src = _from_git(d, sha) or _from_tarball(d, sha)
    mf = os.path.join(d, 'manifest.json') if d else None
    if not src or not os.path.exists(mf):
        return None, {}, 'not available'
    raw = json.load(open(mf, encoding='utf-8'))
    recs = {}
    for slug, r in (raw.get('screens') or {}).items():
        fp = os.path.join(d, f'{slug}.webp')
        if not SLUG.fullmatch(slug) or r.get('file') != f'{slug}.webp' or not os.path.exists(fp):
            _log(f'skip {slug!r}: file missing or bad name'); continue
        b = open(fp, 'rb').read()
        if hashlib.sha256(b).hexdigest() != r.get('sha256'):
            _log(f'skip {slug}: sha256 mismatch'); continue
        if b[:4] != b'RIFF' or b[8:12] != b'WEBP' or (r.get('width'), r.get('height')) != (SHOT_W, SHOT_H):
            _log(f'skip {slug}: not a {SHOT_W}x{SHOT_H} WebP'); continue
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(r.get('captured_at'))):
            _log(f'skip {slug}: captured_at is not ISO 8601 UTC'); continue
        if not str(r.get('source_url') or '').startswith('https://'):
            _log(f'skip {slug}: source_url not https'); continue
        ca = r.get('confirmed_at')
        if ca is not None and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(ca)) or str(ca) < r['captured_at']):
            _log(f'{slug}: confirmed_at {ca!r} ignored (not ISO 8601 UTC, or earlier than captured_at)')
            r = {k: v for k, v in r.items() if k != 'confirmed_at'}
        recs[slug] = r
    return d, recs, src


def thumb(src_path, sha):
    """Top-band thumbnail bytes (cached), or None without Pillow."""
    try:
        from PIL import Image
    except ImportError:
        return None
    tdir = os.path.join(CACHE, 'thumbs')
    cp = os.path.join(tdir, f'{sha}-{THUMB_VERSION}.webp')
    if not os.path.exists(cp):
        os.makedirs(tdir, exist_ok=True)
        im = Image.open(src_path).convert('RGB')
        band = im.crop((0, 0, im.width, round(im.width * THUMB_H / THUMB_W)))
        band = band.resize((THUMB_W, THUMB_H), Image.LANCZOS)
        for q in (62, 50, 40, 30, 20, 10):  # busy pages (pixel murals, canvases) need a lower quality to fit THUMB_MAX
            buf = io.BytesIO()
            band.save(buf, 'WEBP', quality=q, method=6)
            if buf.tell() <= THUMB_MAX:
                break
        with open(cp + '.tmp', 'wb') as f:
            f.write(buf.getvalue())
        os.replace(cp + '.tmp', cp)
    return open(cp, 'rb').read()
