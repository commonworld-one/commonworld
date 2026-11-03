"""Replication counts on a card (atlas/data/replications.json). Stdlib only.

Some Atlas entries are registers where review means replication: other agents run an entry's check on their own
stack and record the result. For those cards the Atlas shows how many replication rows the register holds, and how
many entries and distinct agents those rows cover, counted exactly the way the register's own validator counts them.

Today one format is supported:

  agent-errata   piiiico/agent-errata. entries/E###.md (YAML front matter with found_by) and replications/E###.jsonl
                 (one JSON row per run: entry, result, agent, ...). The counting rules are those of the repo's
                 scripts/validate.ts, which its validate.yml workflow runs on every push to main:
                   rows                replication rows in replications/*.jsonl (validate.ts: "N replication rows")
                   entries             entries in entries/ (validate.ts: "N entries")
                   independent_agents  distinct agents with a "reproduces" row on an entry they did not find, the repo's
                                       operator (validate.ts OPERATOR) excluded
                   entries_replicated  entries with at least one such independent reproduction (the README column
                                       "Independent reproductions" greater than 0)

atlas/refresh.py reads the files at the newest commit on main whose validate.yml push run succeeded (so the counts are
counts validate.ts accepted), pins that commit sha, and writes the record here. A record only changes when a count
changes; the previous record then moves into `history` (past records are never rewritten). A weekly re-read with the same
counts only sets `confirmed_at` (UTC, issue #273): observed_at, commit and sources stay those of the first observation. build.py publishes the
record as `replications` on the card JSON, the card page and its Markdown twin; check.py validates this file.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.normpath(os.path.join(HERE, '..', 'data', 'replications.json'))

FORMATS = ('agent-errata',)
COUNT_KEYS = ('rows', 'entries', 'entries_replicated', 'independent_agents')
RECORD_KEYS = COUNT_KEYS + ('format', 'repo', 'commit', 'source_url', 'method_url', 'validate_run_url', 'observed_at')
OPTIONAL_KEYS = ('history', 'confirmed_at')   # confirmed_at: newest weekly re-read with the same counts (issue #273), UTC
REPO_RE = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
UTC_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
ENTRY_FILE = re.compile(r'^E\d{3}\.md$')
ROW_FILE = re.compile(r'^E\d{3}\.jsonl$')
OPERATOR_RE = re.compile(r'^const OPERATOR = "([^"\\\n]+)";$', re.M)


class FormatError(ValueError):
    """The upstream files are not in the shape validate.ts accepts; nothing is counted."""


# ------------------------------------------------------------------ agent-errata format
def front_matter_value(text, key):
    """One top-level scalar from an entry's YAML front matter (`---` block at the top). Plain, single- or double-quoted
    single-line values only; anything else (missing block, missing key, block scalar, flow value) raises FormatError,
    so an unexpected shape is reported instead of miscounted."""
    m = re.match(r'^---\n([\s\S]*?)\n---\n', text)
    if not m:
        raise FormatError('missing front matter block')
    line = next((l for l in m.group(1).split('\n') if l.startswith(key + ':')), None)
    if line is None:
        raise FormatError(f'front matter has no {key}')
    v = line[len(key) + 1:].strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        v = v[1:-1]
    elif not v or v[0] in '|>[{&*!%@`#' or ' #' in v:
        raise FormatError(f'{key} is not a plain single-line value')
    return v


def operator_of(validate_ts):
    """The repo operator excluded from independent counts: `const OPERATOR = "...";` in scripts/validate.ts."""
    found = OPERATOR_RE.findall(validate_ts or '')
    if len(found) != 1:
        raise FormatError('scripts/validate.ts has no single `const OPERATOR = "...";` line')
    return found[0]


def parse_rows(name, text):
    """Rows of one replications/E###.jsonl file, the way validate.ts reads them (blank lines skipped, one JSON object per line)."""
    rows = []
    for i, line in enumerate(text.split('\n'), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError:
            raise FormatError(f'replications/{name}:{i} is not valid JSON')
        if not isinstance(row, dict) or not isinstance(row.get('agent'), str) or not isinstance(row.get('result'), str):
            raise FormatError(f'replications/{name}:{i} lacks a string agent or result')
        rows.append(row)
    return rows


def count_agent_errata(entry_texts, row_texts, validate_ts):
    """entry_texts: {'E001.md': text}, row_texts: {'E001.jsonl': text}, validate_ts: text of scripts/validate.ts.
    -> {rows, entries, entries_replicated, independent_agents}. Mirrors scripts/validate.ts (standing table + ok line)."""
    operator = operator_of(validate_ts)
    found_by = {}
    for name in sorted(entry_texts):
        if not ENTRY_FILE.fullmatch(name):
            raise FormatError(f'unexpected entry file {name}')
        found_by[name[:-3]] = front_matter_value(entry_texts[name], 'found_by')
    if not found_by:
        raise FormatError('no entries')
    rows_by_entry = {}
    for name in sorted(row_texts):
        if not ROW_FILE.fullmatch(name):
            raise FormatError(f'unexpected replications file {name}')
        eid = name[:-6]
        if eid not in found_by:
            raise FormatError(f'replications/{name} has no entry')
        rows_by_entry[eid] = parse_rows(name, row_texts[name])
    for eid in found_by:
        # validate.ts: every entry needs replications/<id>.jsonl with a replication-0 row that reproduces, by any agent
        # (usually the finder, or the curator/operator standing in): `!rows.some((r) => r.result === "reproduces")` is an error.
        if eid not in rows_by_entry:
            raise FormatError(f'entries/{eid}.md has no replications/{eid}.jsonl')
        if not any(r['result'] == 'reproduces' for r in rows_by_entry[eid]):
            raise FormatError(f'replications/{eid}.jsonl has no replication-0 row that reproduces')
    agents, replicated = set(), 0
    for eid, finder in found_by.items():
        # validate.ts: rows.filter(r => r.agent !== e.found_by && r.agent !== OPERATOR), then distinct agents with result "reproduces"
        indep = {r['agent'] for r in rows_by_entry[eid] if r['agent'] != finder and r['agent'] != operator and r['result'] == 'reproduces'}
        agents |= indep
        replicated += 1 if indep else 0
    return {'rows': sum(len(v) for v in rows_by_entry.values()), 'entries': len(found_by),
            'entries_replicated': replicated, 'independent_agents': len(agents)}


# ------------------------------------------------------------------ data file
def load(path=DATA_FILE):
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return (json.load(f) or {}).get('cards') or {}


def _https_github(url, repo, sha, tail):
    return url == f'https://github.com/{repo}/{tail}'.replace('{sha}', sha)


def record_problems(slug, r):
    """Strict shape of one stored record (same rules for the current record and each history item)."""
    w = f'replications: {slug}'
    if not isinstance(r, dict):
        return [f'{w}: record is not an object']
    p = []
    allowed = set(RECORD_KEYS) | set(OPTIONAL_KEYS)
    p += [f'{w}: unknown key {k!r}' for k in r if k not in allowed]
    p += [f'{w}: missing {k}' for k in RECORD_KEYS if k not in r]
    if p:
        return p
    for k in COUNT_KEYS:
        if not isinstance(r[k], int) or isinstance(r[k], bool) or r[k] < 0:
            p.append(f'{w}: {k} must be a non-negative integer')
    if not p:
        if r['entries_replicated'] > r['entries']:
            p.append(f'{w}: entries_replicated > entries')
        if r['independent_agents'] > r['rows'] or r['entries_replicated'] > r['rows']:
            p.append(f'{w}: more independent agents or replicated entries than rows')
        if (r['independent_agents'] == 0) != (r['entries_replicated'] == 0):
            p.append(f'{w}: independent_agents and entries_replicated must be both zero or both non-zero')
    if r['format'] not in FORMATS:
        p.append(f'{w}: unknown format {r["format"]!r}')
    repo, sha = str(r['repo']), str(r['commit'])
    if not REPO_RE.fullmatch(repo):
        p.append(f'{w}: repo must be owner/name')
    if not SHA_RE.fullmatch(sha):
        p.append(f'{w}: commit must be a full 40-character sha')
    if not p:
        if not _https_github(r['source_url'], repo, sha, 'tree/{sha}/replications'):
            p.append(f'{w}: source_url must be https://github.com/{repo}/tree/<commit>/replications')
        if not _https_github(r['method_url'], repo, sha, 'blob/{sha}/scripts/validate.ts'):
            p.append(f'{w}: method_url must be https://github.com/{repo}/blob/<commit>/scripts/validate.ts')
        if not re.fullmatch(rf'https://github\.com/{re.escape(repo)}/actions/runs/[0-9]{{1,20}}', str(r['validate_run_url'])):
            p.append(f'{w}: validate_run_url must be a run page of {repo}')
    if not UTC_RE.fullmatch(str(r['observed_at'])):
        p.append(f'{w}: observed_at must be YYYY-MM-DDTHH:MM:SSZ')
    if 'confirmed_at' in r:
        if not UTC_RE.fullmatch(str(r['confirmed_at'])):
            p.append(f'{w}: confirmed_at must be YYYY-MM-DDTHH:MM:SSZ')
        elif UTC_RE.fullmatch(str(r['observed_at'])) and r['confirmed_at'] < r['observed_at']:
            p.append(f'{w}: confirmed_at must not be earlier than observed_at')
    return p


def validate(cards, slugs):
    """-> list of problems for the whole file (cards: {slug: record}); slugs: the published card ids."""
    p = []
    for slug, r in sorted(cards.items()):
        if slug not in slugs:
            p.append(f'replications: {slug} is not a published card')
        p += record_problems(slug, r)
        hist = r.get('history', []) if isinstance(r, dict) else []
        if not isinstance(hist, list):
            p.append(f'replications: {slug} history must be a list')
            continue
        for i, h in enumerate(hist):
            if isinstance(h, dict) and 'history' in h:
                p.append(f'replications: {slug} history[{i}] must not nest history')
            p += [x.replace(f'replications: {slug}', f'replications: {slug} history[{i}]') for x in record_problems(slug, h)]
        stamps = [h.get('observed_at') for h in hist if isinstance(h, dict)] + [r.get('observed_at') if isinstance(r, dict) else None]
        if all(isinstance(s, str) for s in stamps) and stamps != sorted(stamps):
            p.append(f'replications: {slug} history must be oldest first and older than the current record')
    return p


def published(cards, slug):
    """The record as the API publishes it (`replications` on the card), or None. History stays in the data file.
    confirmed_at (since API 1.11.0) is the newest weekly re-read that found the same counts, or None."""
    r = cards.get(slug)
    if not r:
        return None
    return {k: r[k] for k in RECORD_KEYS} | {'confirmed_at': r.get('confirmed_at')}


def sentence(r):
    """One plain line with the counts, shared by the card page and its Markdown twin."""
    def n(v, one, many):
        return f'{v:,} {one if v == 1 else many}'
    return (f'{n(r["rows"], "replication row", "replication rows")} across {n(r["entries"], "entry", "entries")}; '
            f'{n(r["entries_replicated"], "entry", "entries")} independently reproduced by '
            f'{n(r["independent_agents"], "agent", "agents")} other than the finder and the repo operator.')
