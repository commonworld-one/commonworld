"""Catalogue safety projections. Source records and review bindings stay immutable."""


def active_document(doc, gone):
    """Suppress only explicit safety-removed IDs, never other unknown IDs."""
    out = dict(doc)
    out['cards'] = {s: r for s, r in doc.get('cards', {}).items() if s not in gone}
    return out


def current_links(record):
    """Public current fields only, not internal history or review correspondence."""
    fields = ('text', 'sources', 'trials', 'screenshot')
    shot_fields = ('source_url',)
    out = {k: record[k] for k in fields if k in record}
    if isinstance(out.get('trials'), list):
        out['trials'] = [{k: t[k] for k in ('performed_at', 'service', 'action', 'result', 'access', 'proof_url', 'cost') if k in t} for t in out['trials']]
    if isinstance(out.get('screenshot'), dict):
        out['screenshot'] = {k: out['screenshot'][k] for k in shot_fields if k in out['screenshot']}
    return out


def verify_source_package(catalogue, directory, removed):
    """Prove exact preserved captures when safety suppression publishes zero previews.

    No fetch, no bypass for an empty/unavailable package. Every selected source
    image is still required even when its entry is removed from output.
    """
    import hashlib
    import json
    import re
    from pathlib import Path
    if not directory:
        raise ValueError('source capture package unavailable')
    cat, folder = Path(catalogue), Path(directory)
    manifest = folder / 'manifest.json'
    binding = json.loads((cat / 'image-binding.json').read_text())
    if hashlib.sha256(manifest.read_bytes()).hexdigest() != binding['manifest_sha256']:
        raise ValueError('exact source capture manifest binding mismatch')
    rows = json.loads(manifest.read_text())['screens']
    records = json.loads((cat / 'overviews.json').read_text())['cards']
    selected = json.loads((cat / 'selection.json').read_text())['slugs']
    if not selected or len(selected) != len(set(selected)) or set(selected) != set(records) or not set(selected) <= set(removed):
        raise ValueError('zero published previews require explicit removal of every selected overview')
    for slug in selected:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,80}', slug):
            raise ValueError('invalid source image ID')
        row, ref = rows[slug], records[slug]['screenshot']
        if row.get('file') != slug + '.webp':
            raise ValueError('invalid source image file')
        image = (folder / (slug + '.webp')).read_bytes()
        if hashlib.sha256(image).hexdigest() != row.get('sha256'):
            raise ValueError('missing or changed exact source image: ' + slug)
        if (image[:4] != b'RIFF' or image[8:12] != b'WEBP'
                or (row.get('width'), row.get('height')) != (1200, 750)):
            raise ValueError('invalid source WebP: ' + slug)
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', str(row.get('captured_at'))) or not str(row.get('source_url', '')).startswith('https://'):
            raise ValueError('invalid source capture metadata: ' + slug)
        if any(ref.get(k) != row.get(k) for k in ('sha256', 'source_url', 'captured_at')):
            raise ValueError('source image metadata differs: ' + slug)
    return True
