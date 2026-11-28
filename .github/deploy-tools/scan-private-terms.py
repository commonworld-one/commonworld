#!/usr/bin/env python3
"""Forbidden-text scan of the Atlas build for the staging deploy, run in a trusted job (no code of the ref runs here).

Same rule as atlas/site/check.py: the regex in env CW_PRIVATE_TERMS (case-insensitive) is searched in every
.html .json .xml .txt .js .css .svg .md file and in _headers and _redirects of the built assets, after removing the
site's general contact address. Unlike check.py it never prints the matched text, only the file path and a count.
Without the secret it warns and passes, as the staging build always did; --require turns that into a failure.

usage: scan-private-terms.py ASSETS_DIR CONTACT_FILE [--require]
"""
import os
import re
import sys

EXT = ('.html', '.json', '.xml', '.txt', '.js', '.css', '.svg', '.md')
NAMES = ('_headers', '_redirects')
EMAIL = re.compile(r'^[^\s@<>"]{1,64}@[A-Za-z0-9.\-]{1,100}$')


def main(argv):
    args = [a for a in argv[1:] if a != '--require']
    require = '--require' in argv
    if len(args) != 2:
        print(__doc__)
        return 2
    root, contact_file = args
    raw = os.environ.get('CW_PRIVATE_TERMS', '')
    if not raw:
        if require:
            print('::error::secret CW_PRIVATE_TERMS not set: the forbidden-text check cannot be skipped here')
            return 1
        print('::warning::CW_PRIVATE_TERMS not set: forbidden-text check skipped for this staging build')
        return 0
    try:
        rx = re.compile(raw, re.I)
    except re.error:
        print('::error::CW_PRIVATE_TERMS is not a valid regular expression')
        return 1
    contact = open(contact_file, encoding='utf-8').read().strip()
    if contact and not EMAIL.match(contact):
        print('::error::contact address in the artifact is not an email address')
        return 1
    hits = scanned = 0
    for d, _, fs in os.walk(root):
        for f in sorted(fs):
            if f.endswith(EXT) or f in NAMES:
                fp = os.path.join(d, f)
                scanned += 1
                txt = open(fp, encoding='utf-8', errors='replace').read()
                if contact:
                    txt = txt.replace(contact, '')
                n = len(rx.findall(txt))
                if n:
                    hits += 1
                    print(f'::error::forbidden text in {os.path.relpath(fp, root)} ({n} match(es), text not printed)')
    print(f'scanned {scanned} files, {hits} with forbidden text')
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
