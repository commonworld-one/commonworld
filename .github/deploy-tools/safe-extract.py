#!/usr/bin/env python3
"""Unpack the build artifact of the staging deploy as DATA, refusing anything but plain files.

The artifact comes from a job that ran code of the dispatched ref, so a trusted job must not extract it with a plain
`tar -x`. This reader writes regular files only: no symlinks, hard links, devices, absolute or `..` paths, no entry
outside the four expected top-level folders, no odd file names, with count and size caps. File modes are not applied.
Layout: bundle/ (Worker bundle), assets/ (static assets), migrations/ (D1 *.sql), meta/ (sha.txt, contact.txt, ref-config.toml).

usage: safe-extract.py ARCHIVE.tar DEST
"""
import os
import re
import sys
import tarfile

TOP = ('bundle', 'assets', 'migrations', 'meta')
MAX_FILES = 120000
MAX_BYTES = 2 * 1024 ** 3
MAX_FILE = 100 * 1024 ** 2
NAME = re.compile(r'^[^\x00-\x1f\x7f/\\]{1,255}$')   # any visible name: asset file names are not ours to restrict
MIGRATION = re.compile(r'^\d{4}_[a-z0-9_\-]{1,100}\.sql$')
META = {'sha.txt', 'contact.txt', 'ref-config.toml'}


class Bad(Exception):
    pass


def check_member(m):
    p = m.name
    if p.startswith('./'):
        p = p[2:]
    if not p or p.startswith('/') or '\\' in p or '\x00' in p:
        raise Bad(f'bad path {m.name!r}')
    parts = p.rstrip('/').split('/')
    if any(x in ('', '.', '..') for x in parts) or not all(NAME.match(x) for x in parts):
        raise Bad(f'bad path {m.name!r}')
    if parts[0] not in TOP:
        raise Bad(f'unexpected top-level entry {parts[0]!r}')
    if m.isdir():
        return parts, True
    if not m.isreg():
        raise Bad(f'not a plain file: {m.name!r} (type {m.type!r})')
    if m.size > MAX_FILE:
        raise Bad(f'file too large: {m.name!r}')
    if parts[0] == 'migrations' and not (len(parts) == 2 and MIGRATION.match(parts[1])):
        raise Bad(f'bad migration file name {m.name!r}')
    if parts[0] == 'meta' and not (len(parts) == 2 and parts[1] in META):
        raise Bad(f'unexpected meta file {m.name!r}')
    return parts, False


def extract(archive, dest):
    os.makedirs(dest, exist_ok=False)
    root = os.path.realpath(dest)
    files = total = 0
    with tarfile.open(archive, 'r:') as tf:
        for m in tf:
            parts, is_dir = check_member(m)
            target = os.path.join(root, *parts)
            if os.path.commonpath([root, os.path.realpath(target)]) != root:
                raise Bad(f'path leaves the destination: {m.name!r}')
            if is_dir:
                os.makedirs(target, exist_ok=True)
                continue
            files += 1
            total += m.size
            if files > MAX_FILES or total > MAX_BYTES:
                raise Bad('archive too large')
            os.makedirs(os.path.dirname(target), exist_ok=True)
            src = tf.extractfile(m)
            with open(target, 'xb') as out:  # 'x': never follow or overwrite an existing entry
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
    with open(os.path.join(root, 'meta', 'sha.txt'), encoding='utf-8') as fh:
        sha = fh.read().strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise Bad('meta/sha.txt is not a full commit sha')
    for need in ('bundle/index.js', 'assets/atlas/index.html', 'assets/_headers', 'meta/ref-config.toml'):
        if not os.path.isfile(os.path.join(root, need)):
            raise Bad(f'missing {need}')
    for d, _, fs in os.walk(root):  # belt and braces: nothing but regular files and folders on disk
        for f in fs:
            if not os.path.isfile(os.path.join(d, f)) or os.path.islink(os.path.join(d, f)):
                raise Bad(f'not a plain file after extraction: {f}')
    return sha, files, total


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    try:
        sha, files, total = extract(argv[1], argv[2])
    except (Bad, tarfile.TarError, OSError) as e:
        print(f'::error::artifact refused: {e}')
        return 1
    print(f'extracted {files} files, {total} bytes, sha {sha}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
