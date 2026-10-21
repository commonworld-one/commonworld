#!/usr/bin/env python3
"""Check the screens-publish artifact before the publish job of .github/workflows/screens.yml opens a PR (stdlib only).

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
             / shot_url https URLs, http_status an int 100..599 (not a bool), title a string, captured_at
             YYYY-MM-DDTHH:MM:SSZ, width 1200, height 750, bytes a positive int.
  images     every <slug>.webp in the artifact is a WebP (RIFF....WEBP), is referenced by the manifest, and its sha256 and
             size equal the manifest record.
  cards      (--data) every slug whose image is in the artifact is a live Atlas card of the newest
             snapshot-verified-*.json, and its `website` equals the card's canonical_url (what the capture shot).
  base       (--base, the atlas/screens directory of the atlas-screens checkout the PR goes to) no slug of the stored
             manifest disappears; every entry whose image is NOT in the artifact is unchanged from the stored entry, and
             its stored <slug>.webp exists with that sha256. Without --base every manifest entry needs its image in
             the artifact.

atlas/site/screens.py (the build-side reader) skips bad records one by one; this check stops a bad artifact before it
reaches atlas-screens at all, e.g. {"screens": {"dealwork-ai": null}}, which would crash the reader.

Usage: screens_artifact.py --artifact DIR [--base DIR] [--data DIR]     exit 0 ok, 1 problems found, 2 usage
"""
import argparse, glob, hashlib, json, os, re, stat, sys

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
        'http_status': lambda v: _int(v) and 100 <= v <= 599,
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
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, UnicodeDecodeError, ValueError) as ex:
        out.append(f'{label}: cannot read ({ex})')
        return None


def _sha(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


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
    for slug, r in screens.items():
        probs = record_problems(slug, r)
        out += probs
        if not probs:
            good[slug] = r
    # images in the artifact
    for slug, p in images.items():
        with open(p, 'rb') as fh:
            b = fh.read()
        if b[:4] != b'RIFF' or b[8:12] != b'WEBP':
            out.append(f'images: screens/{slug}.webp is not a WebP image')
        if slug not in screens:
            out.append(f'images: screens/{slug}.webp is not referenced by the manifest'); continue
        r = good.get(slug)
        if r is None:
            continue
        if hashlib.sha256(b).hexdigest() != r['sha256']:
            out.append(f'images: screens/{slug}.webp sha256 differs from the manifest')
        if len(b) != r['bytes']:
            out.append(f'images: screens/{slug}.webp is {len(b)} bytes, manifest says {r["bytes"]}')
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
        if slug in good and (not os.path.isfile(fp) or os.path.islink(fp) or _sha(fp) != good[slug]['sha256']):
            out.append(f'base: stored {slug}.webp missing or its sha256 differs from the manifest')
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--artifact', required=True, help='downloaded screens-publish artifact (holds screens.md, screens/)')
    ap.add_argument('--base', help='atlas/screens directory of the atlas-screens checkout the PR targets')
    ap.add_argument('--data', help='atlas/data directory of main (live cards from the newest snapshot-verified-*.json)')
    a = ap.parse_args(argv)
    cards = None
    if a.data:
        try:
            cards = live_cards(a.data)
        except (OSError, ValueError, KeyError, TypeError) as ex:
            print(f'::error::cannot read the live cards: {ex}'); return 2
    if a.base and not os.path.isdir(a.base):
        print(f'::error::base directory {a.base} not found'); return 2
    problems = check(a.artifact, a.base, cards)
    for p in problems:
        print(f'::error::screens artifact: {p}')
    if problems:
        print(f'{len(problems)} problem(s): nothing is published')
        return 1
    print('screens artifact ok')
    return 0


if __name__ == '__main__':
    sys.exit(main())
