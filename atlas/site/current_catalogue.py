"""Explicit accepted status migration; never modify retained source input."""
import copy,json
from pathlib import Path

def apply_closures(data, directory):
    data = copy.deepcopy(data)
    path = Path(directory) / 'closures.json'
    if not path.exists(): return data
    decision = json.loads(path.read_text())
    ids = set(decision['ids'])
    for c in data['platforms']:
        if c['slug'] not in ids: continue
        c['status'] = 'closed'
        if c['slug'] == 'agent-knowledge-network': c['name'] = 'Agent Knowledge Network'
        own = decision.get('overrides', {}).get(c['slug'], {})
        event = {'to':'closed','reason':own.get('reason', decision['reason']),'by':'human'}
        if own.get('recorded_on'): event['on'] = own['recorded_on']
        elif decision.get('recorded_on'): event['on'] = decision['recorded_on']
        elif decision.get('recorded_at'): event['at'] = decision.get('at_by_id',{}).get(c['slug'], decision['recorded_at'])
        c.setdefault('status_history', []).append(event)
    return data

def add_new(data, directory):
    path=Path(directory)/'additions.json'
    if not path.exists(): return data
    data=copy.deepcopy(data)
    rows=json.loads(path.read_text())['platforms']
    known={c['slug'] for c in data['platforms']}
    if any(c['slug'] in known for c in rows): raise ValueError('duplicate permanent ID in additions')
    data['platforms'].extend(rows)
    return data

def project_snapshot(data, directory, *, include_additions=True):
    """Resolve membership before status, without changing retained inputs.

    A closure can name a card introduced by additions. Every full-catalogue
    consumer must use this order; isolated batches can exclude additions while
    still honoring closure decisions for their supplied IDs.
    """
    if include_additions:
        data = add_new(data, directory)
    return apply_closures(data, directory)


def new_overviews(doc, directory):
    path=Path(directory)/'additional-overviews.json'
    if not path.exists(): return doc
    doc=copy.deepcopy(doc)
    for slug,row in json.loads(path.read_text())['cards'].items():
        if slug in doc['cards']: raise ValueError('additional overview overwrites reviewed original')
        doc['cards'][slug]=row
    revisions=Path(directory)/'current-revisions.json'
    if revisions.exists():
        for slug,row in json.loads(revisions.read_text())['cards'].items():
            if slug not in doc['cards']: raise ValueError('current revision has unknown permanent ID')
            doc['cards'][slug]=row
    return doc

def additional_shots(shots, directory):
    path=Path(directory)/'additional-captures/manifest.json'
    shots=dict(shots)
    if path.exists():
        for slug,row in json.loads(path.read_text())['screens'].items():
            if slug in shots and not row.get('replaces_original'): raise ValueError('additional capture overwrites original without explicit revision')
            if slug in shots and row.get('replaces_original') and not (Path(directory)/'current-revisions.json').exists(): raise ValueError('capture revision lacks overview revision')
            row=dict(row);row['_source_file']=str(path.parent/row['file'])
            import hashlib
            if hashlib.sha256(Path(row['_source_file']).read_bytes()).hexdigest()!=row['sha256']: raise ValueError('additional capture hash mismatch')
            shots[slug]=row
    return shots
