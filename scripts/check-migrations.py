#!/usr/bin/env python3
"""Gate for D1 migrations before a production deploy (expand -> deploy -> contract, see docs/DEPLOY.md).

A migration runs BEFORE the new Worker is live, so while it runs (and after a Worker rollback) the database is used by
the OLD code. Every pending migration must therefore be backward compatible: add tables, add nullable/defaulted
columns, add indexes, backfill rows. Removing or renaming something the old code still reads ships in a later release,
after the code no longer uses it.

The SQL is read by a small tokenizer (comments dropped, '...' strings, "..."/`...`/[...] identifiers, parenthesis
depth, statements split on top-level ';', CREATE TRIGGER ... BEGIN ... END kept whole). Every statement is classified:

  destructive      DROP TABLE, ALTER TABLE ... DROP (COLUMN), ALTER TABLE ... RENAME (table or column)
  row-write        anything that changes or removes existing rows: every UPDATE and DELETE (whatever the WHERE),
                   REPLACE INTO, INSERT OR REPLACE, INSERT ... ON CONFLICT DO UPDATE (upsert); also inside WITH ...
                   and inside trigger bodies. No attempt is made to judge a WHERE: a human reviews every one
  review-required  DROP INDEX, DROP TRIGGER, DROP VIEW,
                   ALTER TABLE ... ADD of a column SQLite refuses at apply time: NOT NULL without a non-NULL DEFAULT,
                   PRIMARY KEY, UNIQUE, a STORED generated column, a DEFAULT that is not constant (CURRENT_TIME/DATE/
                   TIMESTAMP, also in parentheses, or any expression SQLite itself refuses as an ADD COLUMN default)
  unknown          anything the tokenizer cannot read or a statement kind not on the known-safe list (fail closed)

Known safe: CREATE TABLE / INDEX / VIEW / TRIGGER / VIRTUAL TABLE, ALTER TABLE ... ADD (other column definitions), INSERT (plain, OR IGNORE /
ABORT / FAIL / ROLLBACK, ON CONFLICT DO NOTHING), SELECT, VALUES, BEGIN / COMMIT / END / SAVEPOINT / RELEASE, ANALYZE,
REINDEX, PRAGMA foreign_keys / defer_foreign_keys / optimize. Every finding of any class blocks the deploy unless the
override is given. It is a safety net, not a SQL engine: a reviewer still reads every migration.

Pending = the output of
    npx wrangler d1 migrations list <db> --remote --env production
read strictly (format verified with wrangler 4.151.1, fixtures tests/fixtures/migrations/wrangler-4.151.1-*.txt):
either exactly "No migrations to apply!" or exactly one "Migrations to be applied:" box table with a "Name" header.
It fails when: both or neither marker is there, an error line is printed, a table line cannot be read, a listed name
is not a local file or is listed twice, any "*.sql" name appears outside the table, or the pending names are not a
suffix of the sorted local migration files (in that order).

Override: --allow must equal --sha (the release sha typed a second time, workflow input allow_destructive_migration),
then findings are printed as warnings and the gate passes. A row-write migration needs, in addition, a
`-- reviewed-by-owner: #<PR>` line in its header (comment lines before the first statement), written by the owner in
the reviewed PR (CODEOWNERS). Without that line the gate fails even with the override; the line alone (no override)
fails too. The deploy itself also waits for the production environment approval.

Baseline (grandfathered history): BASELINE below names historical migrations that were already applied to staging
and production before this gate existed and that cannot pass it (0008 backfills rows without an owner marker, 0009 and
0018 rebuild a table). Each entry is pinned by the sha256 of the file (CRLF read as LF). A pending baseline file whose
content still matches is reported as a notice and does not block, so rebuilding a database from empty (every
migration pending, docs/DEPLOY.md "Rebuild from an empty database") passes with the override left empty. Each entry
also lists every finding of the file written out in full; a file is grandfathered only when its sha256 AND its findings
match, so an edited file with a re-pinned sha256 that adds a statement (DROP TABLE posts) still gets the full rule. A
baseline file whose content changed is checked like any other file, and every file not in BASELINE (every new
migration) gets the full rule. The list is closed: tests/test_check_migrations.py pins names, sha256 and findings again
as independent literals and compares each file with its content at the commit that added it.

Usage:
    check-migrations.py --dir platform/migrations --pending-from wrangler-list.txt [--sha SHA --allow SHA]
    check-migrations.py --dir platform/migrations --all          # scan every file (CI, report only with --warn-only)
Exit codes: 0 ok, 1 findings without override (or a row-write file without the owner marker), 2 usage / unreadable input / pending list not understood.
"""
import argparse, hashlib, os, re, sqlite3, sys

SHA40 = re.compile(r'[0-9a-f]{40}')

DESTRUCTIVE, REVIEW, UNKNOWN, ROW_WRITE = 'destructive', 'review-required', 'unknown', 'row-write'

# Owner-review marker for a migration that changes existing rows: a whole comment line in the file's header (the
# comments before the first SQL statement), e.g. `-- reviewed-by-owner: #42` (number of the PR the owner reviewed).
OWNER_MARKER = re.compile(r'--[ \t]*reviewed-by-owner:[ \t]*#?([1-9][0-9]*)[ \t]*')


# Historical migrations, applied before the gate existed (see "Baseline" above). Never add a new migration here: a new
# migration that needs a finding passes with the owner marker and the one-release override instead.
# Each entry pins the file twice: 'sha256' of its content, and 'findings', every finding of the file written out in
# full ('<class>: <rule> | <statement>', in file order). A file is grandfathered only when both match, so editing a
# historical file and re-pinning its sha256 is not enough: any new statement with a finding (DROP TABLE posts, a wider
# UPDATE) is not in 'findings' and keeps the full rule. tests/test_check_migrations.py pins both again as independent
# literals, plus the content of each file at the commit that added it.
BASELINE = {
    '0008_section_groups.sql': {   # row-write: backfill of sections.group_slug / position
        'sha256': 'adad2dd1470cf6927049005b292204240f5697b819a87f97aef91b2552859589',
        'findings': (
            "row-write: UPDATE | UPDATE sections SET group_slug = 'agents-ai' , position = 110 WHERE slug = 'agents-identity'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'agents-ai' , position = 120 WHERE slug = 'ai-models-systems'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'building' , position = 210 WHERE slug = 'protocol'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'building' , position = 220 WHERE slug = 'infrastructure-tools'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'building' , position = 230 WHERE slug = 'products-applications'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'building' , position = 240 WHERE slug = 'design-experience'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'knowledge' , position = 310 WHERE slug = 'research-experiments'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'knowledge' , position = 320 WHERE slug = 'science-discovery'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'knowledge' , position = 330 WHERE slug = 'education-learning'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'knowledge' , position = 340 WHERE slug = 'collective-memory'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'work-economy' , position = 410 WHERE slug = 'work-organizations'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'work-economy' , position = 420 WHERE slug = 'payments-digital-economy'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'work-economy' , position = 430 WHERE slug = 'funding-grants'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'world' , position = 510 WHERE slug = 'society-governance'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'world' , position = 520 WHERE slug = 'robotics-embodied-ai'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'culture-life' , position = 610 WHERE slug = 'creative-work-media'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'commonworld' , position = 710 WHERE slug = 'building-together'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'service' , position = 810 WHERE slug = 'general'",
            "row-write: UPDATE | UPDATE sections SET group_slug = 'service' , position = 820 WHERE slug = 'needs-a-topic'",
        ),
    },
    '0009_free_tags.sql': {   # rebuild of tags
        'sha256': '34c3339da21b904ef65d7e571a9bfe1e87c9ef52c0817c044b7d06ff071d0aae',
        'findings': (
            'destructive: DROP TABLE | DROP TABLE tags',
            'destructive: ALTER TABLE ... RENAME | ALTER TABLE tags_new RENAME TO tags',
        ),
    },
    '0018_ai_bot_verified.sql': {   # rebuild of ai_bot_visits
        'sha256': 'f75d1fa9febecfb099bd1733b6e8882746b93e7749b28da5de8c292167d10c68',
        'findings': (
            'destructive: DROP TABLE | DROP TABLE ai_bot_visits',
            'destructive: ALTER TABLE ... RENAME | ALTER TABLE ai_bot_visits_v2 RENAME TO ai_bot_visits',
        ),
    },
}


def content_sha(text):
    return hashlib.sha256(text.replace('\r\n', '\n').encode('utf-8')).hexdigest()


def baseline_findings(text):
    """Every finding of a file in the BASELINE 'findings' form: '<class>: <rule> | <full statement>', in file order."""
    return tuple(f'{rule} | {st}' for rule, st in findings(text, limit=None))


def baseline_status(name, text):
    """-> None (not a BASELINE file), 'ok' (grandfathered), 'sha256' (content differs from the pin) or 'findings'
    (content matches the sha256 pin but the findings are not exactly the written-out list)."""
    entry = BASELINE.get(name)
    if entry is None:
        return None
    if content_sha(text) != entry['sha256']:
        return 'sha256'
    if baseline_findings(text) != tuple(entry['findings']):
        return 'findings'
    return 'ok'


def baselined(name, text):
    """True when `name` is a BASELINE file, its content is exactly the pinned one and its findings are exactly the
    written-out list."""
    return baseline_status(name, text) == 'ok'


class SqlError(Exception):
    pass


# ---------------------------------------------------------------- tokenizer

class Tok:
    __slots__ = ('kind', 'text', 'depth')

    def __init__(self, kind, text, depth=0):
        self.kind, self.text, self.depth = kind, text, depth

    @property
    def up(self):
        return self.text.upper() if self.kind == 'word' else None

    def __repr__(self):
        return f'{self.kind}:{self.text}@{self.depth}'


_WORD = re.compile(r'[A-Za-z_\x80-\U0010ffff][\w$\x80-\U0010ffff]*')
_NUM = re.compile(r'(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)')
_OPS = ('<<', '>>', '<=', '>=', '==', '!=', '<>', '||', '->>', '->')


def tokenize(text):
    """-> [Tok]; kinds: word, ident (quoted identifier, text without quotes), string, blob, number, param, op, ';'.
    Raises SqlError on an unterminated string / identifier / comment or unbalanced parentheses."""
    toks, i, n, depth = [], 0, len(text), 0
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j < 0 else j + 1
        elif text.startswith('/*', i):
            j = text.find('*/', i + 2)
            if j < 0:
                raise SqlError('unterminated /* comment')
            i = j + 2
        elif c in '\'"`' or (c in 'xX' and i + 1 < n and text[i + 1] == "'"):
            blob = c in 'xX'
            q = "'" if blob else c
            j, buf = i + (2 if blob else 1), []
            while True:
                if j >= n:
                    raise SqlError(f'unterminated {q} quote')
                if text[j] == q:
                    if j + 1 < n and text[j + 1] == q:
                        buf.append(q); j += 2; continue
                    break
                buf.append(text[j]); j += 1
            kind = 'blob' if blob else ('string' if q == "'" else 'ident')
            toks.append(Tok(kind, ''.join(buf), depth))
            i = j + 1
        elif c == '[':
            j = text.find(']', i + 1)
            if j < 0:
                raise SqlError('unterminated [ identifier')
            toks.append(Tok('ident', text[i + 1:j], depth))
            i = j + 1
        elif c == '(':
            toks.append(Tok('op', '(', depth)); depth += 1; i += 1
        elif c == ')':
            depth -= 1
            if depth < 0:
                raise SqlError('unbalanced )')
            toks.append(Tok('op', ')', depth)); i += 1
        elif c == ';':
            if depth:
                raise SqlError('; inside parentheses')
            toks.append(Tok(';', ';', 0)); i += 1
        elif c.isdigit() or (c == '.' and i + 1 < n and text[i + 1].isdigit()):
            m = _NUM.match(text, i)
            toks.append(Tok('number', m.group(), depth)); i = m.end()
        elif c in '?:@$':
            m = re.compile(r'[?:@$][\w]*').match(text, i)
            toks.append(Tok('param', m.group(), depth)); i = m.end()
        elif _WORD.match(text, i):
            m = _WORD.match(text, i)
            toks.append(Tok('word', m.group(), depth)); i = m.end()
        else:
            op = next((o for o in _OPS if text.startswith(o, i)), c)
            if op not in _OPS and op not in '=<>!+-*/%&|~,.':
                raise SqlError(f'unexpected character {op!r}')
            toks.append(Tok('op', op, depth)); i += len(op)
    if depth:
        raise SqlError('unbalanced (')
    return toks


def split_statements(toks):
    """Split on top-level ';'. A CREATE [TEMP] TRIGGER statement runs to its END (CASE ... END counted)."""
    out, cur, in_trigger, began, case = [], [], False, False, 0
    for t in toks:
        if t.kind == ';' and not (in_trigger and began):
            if cur:
                out.append(cur)
            cur, in_trigger, began, case = [], False, False, 0
            continue
        cur.append(t)
        if len(cur) <= 3 and t.up == 'TRIGGER' and cur[0].up == 'CREATE':
            in_trigger = True
        elif in_trigger and t.up == 'BEGIN' and not began:
            began = True
        elif in_trigger and began and t.up == 'CASE':
            case += 1
        elif in_trigger and began and t.up == 'END':
            if case:
                case -= 1
            else:
                began = False  # the next top-level ';' ends the statement
    if in_trigger and began:
        raise SqlError('CREATE TRIGGER without END')
    if cur:
        out.append(cur)
    return out


def show(toks, limit=200):
    parts = []
    for t in toks:
        if t.kind == 'string':
            parts.append("'" + t.text.replace("'", "''") + "'")
        elif t.kind == 'ident':
            parts.append('"' + t.text.replace('"', '""') + '"')
        elif t.kind == 'blob':
            parts.append("X'" + t.text + "'")
        else:
            parts.append(t.text)
    return ' '.join(parts)[:limit] if limit else ' '.join(parts)


# ---------------------------------------------------------------- statement classification

_SAFE_PRAGMAS = {'foreign_keys', 'defer_foreign_keys', 'optimize'}


def _skip_with(toks):
    """Index of the main verb after WITH [RECURSIVE] name AS (...), ...; None when not found."""
    for k in range(1, len(toks)):
        t = toks[k]
        if t.depth == 0 and t.up in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'VALUES') \
                and toks[k - 1].kind == 'op' and toks[k - 1].text == ')':
            return k
    return None


def classify(st):
    """-> [(class, rule)] for one statement's tokens (empty = known safe)."""
    w = [t.up for t in st[:6]] + [None] * 6
    first = w[0]
    k = 0
    if first == 'WITH':
        k = _skip_with(st)
        if k is None:
            return [(UNKNOWN, 'WITH without a readable main statement')]
        first = st[k].up
        w = [t.up for t in st[k:k + 6]] + [None] * 6
    if first == 'UPDATE':
        return [(ROW_WRITE, 'UPDATE')]
    if first == 'DELETE':
        return [(ROW_WRITE, 'DELETE')]
    if first == 'REPLACE':
        return [(ROW_WRITE, 'REPLACE INTO')]
    if first == 'INSERT':
        if w[1] == 'OR' and w[2] == 'REPLACE':
            return [(ROW_WRITE, 'INSERT OR REPLACE')]
        if w[1] == 'OR' and w[2] not in ('IGNORE', 'ABORT', 'FAIL', 'ROLLBACK'):
            return [(UNKNOWN, 'INSERT OR ' + str(w[2]))]
        body = st[k:]
        if any(a.up == 'DO' and b.up == 'UPDATE' for a, b in zip(body, body[1:])):
            return [(ROW_WRITE, 'INSERT ... ON CONFLICT DO UPDATE (upsert)')]
        return []
    if first in ('SELECT', 'VALUES'):
        return []
    if k:
        return [(UNKNOWN, 'WITH ... ' + str(first))]
    if first == 'DROP':
        what = w[1]
        if what == 'TABLE':
            return [(DESTRUCTIVE, 'DROP TABLE')]
        if what in ('INDEX', 'TRIGGER', 'VIEW'):
            return [(REVIEW, f'DROP {what}')]
        return [(UNKNOWN, f'DROP {what}')]
    if first == 'ALTER' and w[1] == 'TABLE':
        # ALTER TABLE [schema.]name <action>
        j = 2
        if j + 2 < len(st) and st[j + 1].text == '.':
            j += 2
        action = st[j + 1].up if j + 1 < len(st) else None
        if action == 'DROP':
            return [(DESTRUCTIVE, 'ALTER TABLE ... DROP')]
        if action == 'RENAME':
            return [(DESTRUCTIVE, 'ALTER TABLE ... RENAME')]
        if action == 'ADD':
            return _add_column(st[j + 2:])
        return [(UNKNOWN, f'ALTER TABLE ... {action}')]
    if first == 'CREATE':
        rest = [x for x in w[1:] if x not in ('TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL')]
        kind = rest[0] if rest else None
        if kind == 'TRIGGER':
            return _trigger_body(st)
        if kind in ('TABLE', 'INDEX', 'VIEW'):
            return []
        return [(UNKNOWN, f'CREATE {kind}')]
    if first in ('BEGIN', 'COMMIT', 'END', 'SAVEPOINT', 'RELEASE', 'ANALYZE', 'REINDEX'):
        return []
    if first == 'PRAGMA':
        name = st[1].text.lower() if len(st) > 1 else ''
        if len(st) > 3 and st[2].text == '.':
            name = st[3].text.lower()
        if name in _SAFE_PRAGMAS:
            return []
        return [(UNKNOWN, f'PRAGMA {name}')]
    return [(UNKNOWN, f'unknown statement {first or st[0].text}')]


_CONSTRAINT_START = {'CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES',
                     'GENERATED', 'AS'}


def _add_column(toks):
    """ALTER TABLE ... ADD [COLUMN] <column-def>: SQLite refuses some column definitions only when the statement runs
    (some only on a table that already has rows), which would stop `wrangler d1 migrations apply` half way through
    the pending list. Those are flagged review-required so the gate stops them before anything is applied."""
    if toks and toks[0].up == 'COLUMN':
        toks = toks[1:]
    top = [t for t in toks[1:] if t.depth == 0]   # constraints of the column; (...) contents are not constraints
    ups = [t.up for t in top] + [None]
    generated = 'GENERATED' in ups or 'AS' in ups
    res, default = [], None
    for i, u in enumerate(ups[:-1]):
        if u == 'PRIMARY' and ups[i + 1] == 'KEY':
            res.append((REVIEW, 'ADD COLUMN ... PRIMARY KEY (SQLite cannot add a PRIMARY KEY column)'))
        elif u == 'UNIQUE':
            res.append((REVIEW, 'ADD COLUMN ... UNIQUE (SQLite cannot add a UNIQUE column)'))
        elif u == 'STORED' and generated:
            res.append((REVIEW, 'ADD COLUMN ... STORED (SQLite cannot add a STORED generated column)'))
        elif u == 'DEFAULT' and i + 1 < len(top):
            nxt = top[i + 1]
            expr = _default_expr(toks, toks.index(nxt))
            if [t.up for t in expr if not (t.kind == 'op' and t.text in '()')] == ['NULL']:
                default = 'null'
            else:
                default = 'value'
            current = [t.up for t in expr if t.up in ('CURRENT_TIME', 'CURRENT_DATE', 'CURRENT_TIMESTAMP')]
            if current:
                res.append((REVIEW, f'ADD COLUMN ... DEFAULT {show(expr)} (SQLite needs a constant default here)'))
            elif not _constant_default(expr):
                res.append((REVIEW, f'ADD COLUMN ... DEFAULT {show(expr)} (SQLite refuses a non-constant default here)'))
    not_null = any(u == 'NOT' and ups[i + 1] == 'NULL' for i, u in enumerate(ups[:-1]))
    if not_null and not generated and default in (None, 'null'):
        res.append((REVIEW, 'ADD COLUMN ... NOT NULL without a non-NULL DEFAULT '
                            '(SQLite rejects it on a table that has rows)'))
    return res


def _default_expr(toks, k):
    """Tokens of the DEFAULT value starting at toks[k]: a whole (...) group, a signed literal, or one token."""
    t = toks[k]
    if t.kind == 'op' and t.text == '(':
        end = next(j for j in range(k + 1, len(toks)) if toks[j].kind == 'op' and toks[j].text == ')'
                   and toks[j].depth == t.depth)
        return toks[k:end + 1]
    if t.kind == 'op' and t.text in '+-' and k + 1 < len(toks):
        return toks[k:k + 2]
    return toks[k:k + 1]


def _constant_default(expr):
    """Ask SQLite itself: ALTER TABLE ... ADD COLUMN with this DEFAULT on a table with a row. Anything SQLite refuses
    (non-constant default, or SQL it cannot read) -> False, so the gate stops it before D1 apply does."""
    try:
        con = sqlite3.connect(':memory:')
        try:
            con.execute('CREATE TABLE probe (a INT)')
            con.execute('INSERT INTO probe VALUES (1)')
            con.execute('ALTER TABLE probe ADD COLUMN c DEFAULT ' + show(expr, None))
        finally:
            con.close()
        return True
    except sqlite3.Error:
        return False


def _trigger_body(st):
    b = next((k for k, t in enumerate(st) if t.up == 'BEGIN' and t.depth == 0), None)
    if b is None or st[-1].up != 'END':
        return [(UNKNOWN, 'CREATE TRIGGER without BEGIN ... END')]
    body = st[b + 1:-1]
    res = []
    for inner in split_statements(body + [Tok(';', ';', 0)]):
        for cls, rule in classify(inner):
            res.append((cls, rule + ' (in trigger body)'))
    return res


def findings(text, limit=200):
    """-> [(rule, statement)] for one migration file's SQL; rule is '<class>: <what>'; statement cut to `limit` chars
    (None = whole statement)."""
    try:
        sts = split_statements(tokenize(text))
    except SqlError as ex:
        return [(f'{UNKNOWN}: cannot read the SQL ({ex})', text.strip()[:limit] if limit else text.strip())]
    res = []
    for st in sts:
        for cls, rule in classify(st):
            res.append((f'{cls}: {rule}', show(st, limit)))
    return res


def owner_marker(text):
    """PR number from a `-- reviewed-by-owner: #N` line in the file header (comment/blank lines before the first
    statement), else None. A marker further down, inside a block comment or inside SQL does not count."""
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if not s.startswith('--'):
            return None
        m = OWNER_MARKER.fullmatch(s)
        if m:
            return int(m.group(1))
    return None


# ---------------------------------------------------------------- wrangler output

class PendingError(Exception):
    pass


ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]')
SQL_NAME = re.compile(r'[\w.-]+\.sql\b', re.I)
NO_PENDING = 'No migrations to apply!'
TABLE_HEAD = 'Migrations to be applied:'
BOX_RULE = re.compile(r'^[┌├└─┬┼┴┐┤┘\s]+$')


def parse_listing(listing):
    """Names wrangler lists as pending, in order. Raises PendingError when the output is not exactly understood."""
    lines = [ANSI.sub('', ln).rstrip() for ln in listing.splitlines()]
    if any(re.match(r'\s*(✘|X)\s*\[ERROR\]', ln) for ln in lines):
        raise PendingError('wrangler printed an error')
    none_at = [i for i, ln in enumerate(lines) if ln.strip().lstrip('✅').strip() == NO_PENDING]
    head_at = [i for i, ln in enumerate(lines) if ln.strip() == TABLE_HEAD]
    if len(none_at) + len(head_at) != 1:
        raise PendingError('expected exactly one of "No migrations to apply!" or "Migrations to be applied:"')
    names, table = [], set()
    if head_at:
        i = head_at[0] + 1
        if i >= len(lines) or not lines[i].strip().startswith('┌'):
            raise PendingError('no table after "Migrations to be applied:"')
        header = False
        while i < len(lines):
            ln = lines[i].strip()
            table.add(i)
            if BOX_RULE.match(ln) and ln:
                if ln.startswith('└'):
                    break
            elif ln.startswith('│') and ln.endswith('│'):
                cells = [c.strip() for c in ln[1:-1].split('│')]
                if not header:
                    if cells[0] != 'Name':
                        raise PendingError(f'unexpected table header {ln!r}')
                    header = True
                else:
                    if not re.fullmatch(r'[\w.-]+\.sql', cells[0]):
                        raise PendingError(f'cannot read table row {ln!r}')
                    names.append(cells[0])
            else:
                raise PendingError(f'cannot read table line {ln!r}')
            i += 1
        else:
            raise PendingError('table not closed')
        if not header or not names:
            raise PendingError('table without migration rows')
    stray = [ln for i, ln in enumerate(lines) if i not in table and SQL_NAME.search(ln)]
    if stray:
        raise PendingError(f'migration name outside the table: {stray[0].strip()!r}')
    return names


def pending_files(files, listing):
    """Validated pending list against the local files (sorted). Raises PendingError."""
    names = parse_listing(listing)
    if len(set(names)) != len(names):
        raise PendingError('a migration is listed twice')
    missing = [n for n in names if n not in files]
    if missing:
        raise PendingError(f'listed migration not in the local directory: {missing[0]}')
    if names and names != files[len(files) - len(names):]:
        raise PendingError('pending migrations are not the newest local files in order '
                           f'(pending {", ".join(names)}; local {", ".join(files)})')
    return names


# ---------------------------------------------------------------- CLI

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dir', required=True, help='migrations directory (wrangler migrations_dir)')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--pending-from', help='file with the output of `wrangler d1 migrations list --remote`')
    g.add_argument('--all', action='store_true', help='scan every migration file')
    ap.add_argument('--sha', default='', help='release sha')
    ap.add_argument('--allow', default='', help='override: must equal --sha exactly')
    ap.add_argument('--warn-only', action='store_true', help='report findings as warnings, never fail on them')
    a = ap.parse_args(argv)

    if not os.path.isdir(a.dir):
        print(f'::error::migrations directory {a.dir} not found'); return 2
    files = sorted(f for f in os.listdir(a.dir) if f.endswith('.sql'))
    if a.all:
        pending = files
    else:
        try:
            with open(a.pending_from, encoding='utf-8', errors='replace') as fh:
                listing = fh.read()
        except OSError as ex:
            print(f'::error::cannot read {a.pending_from}: {ex}'); return 2
        try:
            pending = pending_files(files, listing)
        except PendingError as ex:
            print(f'::error::could not tell which migrations are pending: {ex}')
            return 2
    print(f'pending migrations: {", ".join(pending) if pending else "none"}')

    hits, unmarked = [], []
    for f in pending:
        try:
            with open(os.path.join(a.dir, f), encoding='utf-8', newline='') as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as ex:
            print(f'::error::cannot read {a.dir}/{f}: {ex}'); return 2
        found = findings(text)
        status = baseline_status(f, text)
        if found and status == 'ok':
            print(f'::notice file={a.dir}/{f}::baseline: historical migration (sha256 and findings pinned in BASELINE), '
                  f'{len(found)} finding(s) not blocking: ' + '; '.join(sorted({r for r, _ in found})))
            continue
        if status == 'sha256':
            print(f'::warning file={a.dir}/{f}::baseline file changed (sha256 differs from BASELINE): checked like a '
                  'new migration. Historical migrations must not be edited; add a new migration instead.')
        elif status == 'findings':
            print(f'::warning file={a.dir}/{f}::baseline findings differ (the file has findings that are not written out '
                  'in BASELINE): checked like a new migration. Historical migrations must not be edited.')
        for rule, st in found:
            hits.append((f, rule, st))
        if any(rule.startswith(ROW_WRITE + ':') for rule, _ in found) and owner_marker(text) is None:
            unmarked.append(f)
    if not hits:
        print('no destructive or review-required SQL in pending migrations' + (' (outside the baseline)' if any(f in BASELINE for f in pending) else '')); return 0

    override = bool(a.allow) and SHA40.fullmatch(a.sha or '') is not None and a.allow == a.sha
    level = 'warning' if ((override and not unmarked) or a.warn_only) else 'error'
    for f, rule, st in hits:
        print(f'::{level} file={a.dir}/{f}::{rule}: {st}')
    for f in unmarked:
        print(f'::{level} file={a.dir}/{f}::row-write: changes existing rows (UPDATE / DELETE / REPLACE / upsert) '
              'and has no "-- reviewed-by-owner: #<PR>" line in its header; the release override alone cannot pass it')
    if a.warn_only:
        return 0
    if unmarked:
        print('::error::migration blocked: a migration that changes existing rows needs the owner\'s review marker in '
              'the file AND the release override (docs/DEPLOY.md, Database migrations).')
        return 1
    if override:
        print('migration findings allowed for this release: allow_destructive_migration equals the release sha')
        return 0
    print('::error::migration blocked (destructive, review-required or unreadable SQL). Ship destructive changes in '
          'a later release, after the running Worker no longer uses what they remove (docs/DEPLOY.md). To override '
          'for this one release, type the release sha again in allow_destructive_migration.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
