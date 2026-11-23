"""One local handoff for overview text, screenshot pixels and their evidence.

No git write, network, remote dispatch or release. This packages the exact image
bytes under review, so another reviewer need not recreate screenshot branches,
copy arbitrary images by hand or guess which image revision matches the text.
"""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

import overviews


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, obj):
    Path(path).write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')


def make(source, snapshot, screens_dir, out, slugs=None):
    source,snapshot,screens_dir,out=map(Path,(source,snapshot,screens_dir,out))
    if out.exists():
        raise ValueError('refusing to overwrite a previous handoff bundle')
    doc=json.loads(source.read_text());snap=json.loads(snapshot.read_text())
    problems=overviews.problems(doc,snap['platforms'])
    if problems:raise ValueError('; '.join(problems[:6]))
    wanted=set(slugs or doc['cards'])
    if not wanted or not wanted<=set(doc['cards']):
        raise ValueError('bundle slugs must be existing overview IDs')
    for slug in wanted:
        if not overviews.SLUG.fullmatch(slug):raise ValueError('invalid permanent ID')
    raw=json.loads((screens_dir/'manifest.json').read_text())
    manifest={};missing=[]
    out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent,prefix='.overview-bundle-') as temp:
        stage=Path(temp);images=stage/'screens';images.mkdir()
        for slug in sorted(wanted):
            r=(raw.get('screens') or {}).get(slug)
            if not r:
                missing.append(slug);continue
            image=screens_dir/(slug+'.webp')
            if image.is_symlink() or not image.is_file() or r.get('file')!=slug+'.webp' or file_hash(image)!=r.get('sha256'):
                raise ValueError(slug+': image bytes do not match the manifest')
            # Decode and check real pixels dimensions, not a claimed manifest size.
            from PIL import Image
            with Image.open(image) as im:
                if im.format!='WEBP' or im.size!=(1200,750):raise ValueError(slug+': image format/size mismatch')
                im.verify()
            if not overviews.utc(r.get('captured_at')) or not overviews.source_url(r.get('source_url')):
                raise ValueError(slug+': invalid screenshot source/date')
            shutil.copyfile(image,images/(slug+'.webp'));manifest[slug]=copy.deepcopy(r)
        partial=copy.deepcopy(doc);partial['cards']={s:partial['cards'][s] for s in sorted(wanted)}
        write(stage/'overviews.json',partial)
        write(stage/'snapshot.json',snap)
        write(images/'manifest.json',{'screens':manifest})
        report={'format':'commonworld-atlas-local-overview-bundle/1','base_sha':doc.get('base_sha'),
            'slugs':sorted(wanted),'overview_revisions':{s:overviews.digest(doc['cards'][s]) for s in sorted(wanted)},
            'screenshots':len(manifest),'missing_screenshots':missing,
            'ready_for_publication':False,'review_state':{s:doc['cards'][s]['state'] for s in sorted(wanted)},
            'note':'Packaging is not content review, a new visit, screenshot approval, a clean live safety check or release authorization.'}
        write(stage/'bundle.json',report)
        (stage/'README.md').write_text('''# Local overview handoff bundle

This directory contains the exact overview source, legacy snapshot and image
pixels for one review batch. It does not publish or change a remote branch.
Run the local bundle verifier before using it. Use the same code baseline and
candidate patch as the accompanying implementation review package.

Offline validation:
  python atlas/tools/overviews.py verify-bundle --file PATH/TO/BUNDLE

Offline preview after verification (from repository root):
  CW_SCREENS_DIR=PATH/TO/BUNDLE/screens python atlas/site/build.py \\
    --data PATH/TO/BUNDLE/snapshot.json --overviews PATH/TO/BUNDLE/overviews.json \\
    --draft-preview --no-mirror --local --out atlas/site/dist
  python atlas/site/serve.py

Review content and actual pixels. Packaging never creates a check receipt or
marks a draft accepted. Missing images block acceptance, not honest preparation.
Do not deploy a draft preview. Current external release steps still require
separate permission and a concrete cutover to the new source.
''')
        files={p.relative_to(stage).as_posix():file_hash(p) for p in sorted(stage.rglob('*')) if p.is_file()}
        write(stage/'checksums.json',files)
        # The final path appears only when the complete bundle is written.
        stage.rename(out)
        # TemporaryDirectory cleanup is safe after its old path has moved.
    return report


def verify(directory):
    root=Path(directory).resolve();bad=[]
    if not root.is_dir():return ['bundle directory missing']
    sums=json.loads((root/'checksums.json').read_text())
    actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual!=set(sums)|{'checksums.json'}:bad.append('bundle file inventory differs')
    for rel,digest in sums.items():
        path=root/rel
        if Path(rel).is_absolute() or '..' in Path(rel).parts or path.is_symlink() or root not in path.resolve().parents:
            bad.append('unsafe bundle path');continue
        if not path.is_file() or file_hash(path)!=digest:bad.append('checksum mismatch: '+rel)
    if bad:return bad
    doc=json.loads((root/'overviews.json').read_text());snap=json.loads((root/'snapshot.json').read_text())
    report=json.loads((root/'bundle.json').read_text());shots=json.loads((root/'screens/manifest.json').read_text())['screens']
    bad+=overviews.problems(doc,snap['platforms'],shots,complete=False)
    if sorted(doc['cards'])!=report.get('slugs'):bad.append('overview IDs differ from bundle')
    for slug,r in doc['cards'].items():
        if overviews.digest(r)!=report.get('overview_revisions',{}).get(slug):bad.append(slug+': overview revision mismatch')
    for slug,r in shots.items():
        if not overviews.SLUG.fullmatch(slug) or r.get('file')!=slug+'.webp':
            bad.append('invalid screen ID');continue
        image=root/'screens'/(slug+'.webp')
        if not image.is_file() or file_hash(image)!=r.get('sha256'):bad.append(slug+': screen mismatch')
    return bad
