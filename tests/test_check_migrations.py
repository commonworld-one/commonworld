"""scripts/check-migrations.py: the expand -> deploy -> contract gate run before production D1 migrations."""
import contextlib, hashlib, importlib.util, io, os, subprocess, tempfile, unittest

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
FIX = os.path.join(ROOT, 'tests', 'fixtures', 'migrations')
_spec = importlib.util.spec_from_file_location('check_migrations', os.path.join(ROOT, 'scripts', 'check-migrations.py'))
cm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cm)
SHA = 'a' * 40
# real output of wrangler 4.151.1 `d1 migrations list --local --env production` (captured, ANSI codes kept)
REAL_PENDING_3 = os.path.join(FIX, 'wrangler-4.151.1-pending-3.txt')   # 0001..0003 pending
REAL_PENDING_2 = os.path.join(FIX, 'wrangler-4.151.1-pending-2.txt')   # 0004, 0005 pending
REAL_NONE = os.path.join(FIX, 'wrangler-4.151.1-none.txt')
GARBAGE = os.path.join(FIX, 'wrangler-garbage.txt')                     # synthetic auth error line
# Independent pins of the grandfathered historical migrations (scripts/check-migrations.py BASELINE). Written out here
# on purpose and never imported from the scanner: changing a historical file needs a change of the SQL, the scanner's
# sha256 AND findings, these literals and the history anchor below, all in one reviewed PR.
EXPECTED_BASELINE_SHA256 = {
    '0008_section_groups.sql': 'adad2dd1470cf6927049005b292204240f5697b819a87f97aef91b2552859589',
    '0009_free_tags.sql': '34c3339da21b904ef65d7e571a9bfe1e87c9ef52c0817c044b7d06ff071d0aae',
    '0018_ai_bot_verified.sql': 'f75d1fa9febecfb099bd1733b6e8882746b93e7749b28da5de8c292167d10c68',
}
EXPECTED_BASELINE_FINDINGS = {   # count of each finding the scanner must list for each file, and the shape of the rest
    '0008_section_groups.sql': {'row-write: UPDATE': 19},
    '0009_free_tags.sql': {'destructive: DROP TABLE': 1, 'destructive: ALTER TABLE ... RENAME': 1},
    '0018_ai_bot_verified.sql': {'destructive: DROP TABLE': 1, 'destructive: ALTER TABLE ... RENAME': 1},
}
EXPECTED_BASELINE_DESTRUCTIVE = {   # every destructive statement allowed in a baseline file, in full
    '0009_free_tags.sql': ['DROP TABLE tags', 'ALTER TABLE tags_new RENAME TO tags'],
    '0018_ai_bot_verified.sql': ['DROP TABLE ai_bot_visits', 'ALTER TABLE ai_bot_visits_v2 RENAME TO ai_bot_visits'],
}
# History anchor: the commit that added the three files (platform/ import). When it is in the clone, each file must
# equal its content there byte for byte. A shallow clone without it skips, unless CW_REQUIRE_MIGRATION_ANCHOR=1 (CI
# fetches the commit and sets it), which turns the skip into a failure.
BASELINE_ANCHOR_COMMIT = '6803510fad7d186c59d7e922259876f1892edca0'
SEQ_FILES = ['0001_init.sql', '0002_expand.sql', '0003_index.sql', '0004_more.sql', '0005_more.sql']


def run(*args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cm.main(list(args))
    return code, out.getvalue()


def rules(sql):
    return [r for r, _ in cm.findings(sql)]


def read(path):
    with open(path, encoding='utf-8') as fh:
        return fh.read()


class Findings(unittest.TestCase):
    def test_safe_file_has_no_findings(self):
        self.assertEqual(cm.findings(read(os.path.join(FIX, 'safe', '0002_expand.sql'))), [])
        self.assertEqual(cm.findings(read(os.path.join(FIX, 'safe', '0001_init.sql'))), [])

    def test_every_destructive_kind_is_found(self):
        self.assertEqual(rules(read(os.path.join(FIX, 'destructive', '0002_contract.sql'))), [
            'destructive: DROP TABLE', 'destructive: ALTER TABLE ... DROP', 'destructive: ALTER TABLE ... RENAME',
            'destructive: ALTER TABLE ... RENAME', 'row-write: DELETE', 'row-write: UPDATE'])

    def test_comments_and_strings_are_ignored(self):
        self.assertEqual(cm.findings("-- DROP TABLE x;\n/* DELETE FROM x; */ SELECT 'UPDATE x SET a=1; DROP TABLE y';"), [])
        self.assertEqual(cm.findings("INSERT INTO x (a) VALUES ('it''s; DELETE FROM x');"), [])

    def test_every_update_and_delete_is_row_write_whatever_the_where(self):
        """Owner decision 2026-10-20: no WHERE heuristics; every UPDATE / DELETE needs a human."""
        for sql in ('DELETE FROM x;', 'DELETE FROM x WHERE id = 1;', 'DELETE FROM x WHERE id = 1 RETURNING id;',
                    "DELETE FROM users WHERE length('a') = 1;", 'DELETE FROM x WHERE 1;', 'DELETE FROM x LIMIT 5;',
                    "DELETE FROM t WHERE abs(-1) = 1;", "DELETE FROM t WHERE 'a' = 'a';",
                    'DELETE FROM accounts RETURNING (SELECT 1 WHERE 1);'):
            self.assertEqual(rules(sql), ['row-write: DELETE'], sql)
        for sql in ('UPDATE x SET a = 1;', 'UPDATE x SET a = 1 WHERE id = 5;', 'UPDATE OR IGNORE x SET a = 1;',
                    'UPDATE OR REPLACE x SET a = 1 WHERE id = 2;', "UPDATE accounts SET status=(SELECT 'frozen' WHERE 1);",
                    'UPDATE x SET a = 1 FROM (SELECT id FROM y WHERE y.k = 2) AS s;',
                    "update t set a = 1 where coalesce(1, a) = 1;"):
            self.assertEqual(rules(sql), ['row-write: UPDATE'], sql)

    def test_overwriting_inserts_are_row_write(self):
        self.assertEqual(rules('INSERT INTO x (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2;'),
                         ['row-write: INSERT ... ON CONFLICT DO UPDATE (upsert)'])
        self.assertEqual(rules('INSERT INTO x (a) SELECT a FROM y WHERE true ON CONFLICT DO UPDATE SET a = excluded.a;'),
                         ['row-write: INSERT ... ON CONFLICT DO UPDATE (upsert)'])
        self.assertEqual(rules('INSERT OR REPLACE INTO t VALUES (1);'), ['row-write: INSERT OR REPLACE'])
        self.assertEqual(rules('REPLACE INTO t VALUES (1);'), ['row-write: REPLACE INTO'])
        self.assertEqual(cm.findings('INSERT INTO x (a) VALUES (1) ON CONFLICT (a) DO NOTHING;'), [])
        self.assertEqual(cm.findings('INSERT OR IGNORE INTO t VALUES (1);'), [])
        self.assertEqual(cm.findings("INSERT INTO t (a) VALUES (replace('a', 'b', 'c'));"), [])

    def test_cte(self):
        self.assertEqual(rules('WITH x AS (SELECT id FROM b WHERE 1) DELETE FROM a;'), ['row-write: DELETE'])
        self.assertEqual(rules('WITH RECURSIVE x(n) AS (SELECT 1) UPDATE a SET v = 1;'), ['row-write: UPDATE'])
        self.assertEqual(rules('WITH x AS (SELECT id FROM b) DELETE FROM a WHERE id IN (SELECT id FROM x);'),
                         ['row-write: DELETE'])
        self.assertEqual(rules('WITH x AS (SELECT 1) INSERT INTO a SELECT * FROM x ON CONFLICT DO UPDATE SET v = 1;'),
                         ['row-write: INSERT ... ON CONFLICT DO UPDATE (upsert)'])
        self.assertEqual(cm.findings('WITH x AS (SELECT 1) SELECT * FROM x;'), [])

    def test_foreign_key_actions_and_trigger_events_are_not_row_writes(self):
        self.assertEqual(cm.findings('CREATE TABLE c (id INT, p INT REFERENCES p(id) ON DELETE CASCADE ON UPDATE SET NULL);'
                                     'CREATE TRIGGER tr AFTER UPDATE OF a ON t BEGIN SELECT 1; END;'
                                     'CREATE TRIGGER tr2 BEFORE DELETE ON t BEGIN INSERT INTO log VALUES (old.id); END;'), [])

    def test_review_required(self):
        self.assertEqual(rules('DROP INDEX IF EXISTS users_email;'), ['review-required: DROP INDEX'])
        self.assertEqual(rules('DROP TRIGGER t;'), ['review-required: DROP TRIGGER'])
        self.assertEqual(rules('DROP VIEW v;'), ['review-required: DROP VIEW'])

    def test_unknown_or_unreadable_fails_closed(self):
        for sql in ('VACUUM;', 'ATTACH DATABASE x AS y;', 'PRAGMA writable_schema = 1;', "SELECT 'open;",
                    'SELECT (1;', '/* open', 'CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1;',
                    'ALTER TABLE t SOMETHING;', 'DROP SCHEMA x;'):
            r = rules(sql)
            self.assertTrue(r and r[0].startswith('unknown: '), (sql, r))

    def test_known_safe_statements(self):
        self.assertEqual(cm.findings('PRAGMA foreign_keys = ON; PRAGMA defer_foreign_keys = true; BEGIN; COMMIT;'
                                     'CREATE UNIQUE INDEX IF NOT EXISTS i ON t (a); CREATE VIEW v AS SELECT 1;'
                                     'CREATE VIRTUAL TABLE f USING fts5(a); ANALYZE;'), [])

    def test_trigger_body_is_checked(self):
        self.assertEqual(rules('CREATE TRIGGER t AFTER INSERT ON a BEGIN DELETE FROM b; END;'),
                         ['row-write: DELETE (in trigger body)'])
        self.assertEqual(rules('CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN '
                               'UPDATE c SET n = CASE WHEN new.k THEN 1 ELSE 2 END WHERE id = new.id; END;'),
                         ['row-write: UPDATE (in trigger body)'])
        self.assertEqual(rules('CREATE TRIGGER t AFTER INSERT ON a BEGIN REPLACE INTO b VALUES (new.id); '
                               'INSERT INTO c VALUES (new.id) ON CONFLICT DO UPDATE SET n = n + 1; END;'),
                         ['row-write: REPLACE INTO (in trigger body)',
                          'row-write: INSERT ... ON CONFLICT DO UPDATE (upsert) (in trigger body)'])
        self.assertEqual(cm.findings('CREATE TRIGGER t AFTER INSERT ON a BEGIN '
                                     'INSERT INTO log (x) VALUES (CASE WHEN new.k THEN 1 ELSE 2 END); END;'), [])

    def test_add_column_is_not_destructive(self):
        self.assertEqual(cm.findings('ALTER TABLE x ADD COLUMN y TEXT;'), [])
        self.assertEqual(cm.findings("ALTER TABLE x ADD COLUMN y TEXT NOT NULL DEFAULT '';"
                                     'ALTER TABLE x ADD y INTEGER NOT NULL DEFAULT 0 CHECK (y IS NOT NULL);'
                                     'ALTER TABLE x ADD COLUMN y INT NOT NULL DEFAULT -1;'
                                     'ALTER TABLE x ADD COLUMN y INT NOT NULL DEFAULT (2);'
                                     'ALTER TABLE x ADD COLUMN y TEXT CHECK (y NOT NULL);'
                                     'ALTER TABLE x ADD COLUMN g INT GENERATED ALWAYS AS (a + 1) VIRTUAL NOT NULL;'
                                     'ALTER TABLE main.x ADD COLUMN y TEXT DEFAULT NULL;'), [])

    def test_add_column_that_sqlite_refuses_is_flagged(self):
        nn = 'review-required: ADD COLUMN ... NOT NULL without a non-NULL DEFAULT (SQLite rejects it on a table that has rows)'
        for sql in ('ALTER TABLE x ADD COLUMN y TEXT NOT NULL;', 'ALTER TABLE x ADD y TEXT NOT NULL DEFAULT NULL;',
                    'alter table main.x add column y text constraint c not null;',
                    'ALTER TABLE x ADD COLUMN y TEXT NOT NULL DEFAULT (NULL);'):
            self.assertEqual(rules(sql), [nn], sql)
        self.assertTrue(rules('ALTER TABLE x ADD COLUMN y INTEGER PRIMARY KEY;')[0].startswith('review-required: ADD COLUMN ... PRIMARY KEY'))
        self.assertTrue(rules('ALTER TABLE x ADD COLUMN y TEXT UNIQUE;')[0].startswith('review-required: ADD COLUMN ... UNIQUE'))
        self.assertTrue(rules('ALTER TABLE x ADD COLUMN g INT AS (a + 1) STORED;')[0].startswith('review-required: ADD COLUMN ... STORED'))
        self.assertTrue(rules('ALTER TABLE x ADD COLUMN t TEXT DEFAULT CURRENT_TIMESTAMP;')[0].startswith(
            'review-required: ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP'))
        for d in ('(CURRENT_TIMESTAMP)', '(CURRENT_TIME)', '(CURRENT_DATE)', '((current_timestamp))',
                  "(datetime('now'))", '(random())', "(strftime('%s', 'now'))", '(1 + 1)'):
            r = rules(f'ALTER TABLE users ADD COLUMN created TEXT NOT NULL DEFAULT {d};')
            self.assertEqual(len(r), 1, (d, r))
            self.assertTrue(r[0].startswith('review-required: ADD COLUMN ... DEFAULT ('), (d, r))

    def test_add_column_rules_match_sqlite(self):
        """Every flagged definition really fails in SQLite on a table with a row; every passing one really works."""
        import sqlite3
        for col, flagged in (('y TEXT NOT NULL', True), ('y TEXT NOT NULL DEFAULT NULL', True),
                             ('y INTEGER PRIMARY KEY', True), ('y TEXT UNIQUE', True),
                             ('g INT AS (a + 1) STORED', True), ('t TEXT DEFAULT CURRENT_TIMESTAMP', True),
                             ('created TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)', True),
                             ('d TEXT DEFAULT (CURRENT_DATE)', True), ('d TEXT DEFAULT (CURRENT_TIME)', True),
                             ("d TEXT DEFAULT (datetime('now'))", True), ('d INT DEFAULT (random())', True),
                             ('d INT DEFAULT (1 + 1)', True),
                             ('y INT NOT NULL DEFAULT (2)', False), ("y TEXT DEFAULT ('x')", False),
                             ('y INT DEFAULT (-3)', False), ('y TEXT DEFAULT (NULL)', False),
                             ("y TEXT NOT NULL DEFAULT ''", False), ('y INT NOT NULL DEFAULT -1', False),
                             ('y TEXT', False)):
            sql = f'ALTER TABLE x ADD COLUMN {col};'
            self.assertEqual(bool(rules(sql)), flagged, sql)
            db = sqlite3.connect(':memory:')
            db.execute('CREATE TABLE x (a INT)'); db.execute('INSERT INTO x VALUES (1)')
            try:
                db.execute(sql); ok = True
            except sqlite3.OperationalError:
                ok = False
            self.assertEqual(ok, not flagged, sql)


class Pending(unittest.TestCase):
    def test_real_listing_all_pending(self):
        self.assertEqual(cm.pending_files(SEQ_FILES[:3], read(REAL_PENDING_3)), SEQ_FILES[:3])

    def test_real_listing_suffix(self):
        self.assertEqual(cm.pending_files(SEQ_FILES, read(REAL_PENDING_2)), ['0004_more.sql', '0005_more.sql'])

    def test_real_no_migrations_to_apply(self):
        self.assertEqual(cm.pending_files(SEQ_FILES, read(REAL_NONE)), [])

    def test_listed_name_missing_locally_fails(self):
        with self.assertRaisesRegex(cm.PendingError, 'not in the local directory'):
            cm.pending_files(SEQ_FILES[:4], read(REAL_PENDING_2))

    def test_not_a_suffix_fails(self):
        # 0004/0005 pending but a newer local 0006 is not: order broken
        with self.assertRaisesRegex(cm.PendingError, 'not the newest'):
            cm.pending_files(SEQ_FILES + ['0006_new.sql'], read(REAL_PENDING_2))
        # gap: 0002 applied-looking hole
        with self.assertRaisesRegex(cm.PendingError, 'not the newest'):
            cm.pending_files(SEQ_FILES[:3], read(REAL_PENDING_3).replace('0002_expand.sql', '0003_index.sql', 1)
                             .replace('│ 0003_index.sql  │', '│ 0002_expand.sql │'))

    def test_duplicate_fails(self):
        txt = read(REAL_PENDING_2).replace('0004_more.sql', '0005_more.sql')
        with self.assertRaisesRegex(cm.PendingError, 'twice'):
            cm.pending_files(SEQ_FILES, txt)

    def test_unknown_output_fails(self):
        for txt in (read(GARBAGE), '', 'something else entirely\n'):
            with self.assertRaises(cm.PendingError):
                cm.pending_files(SEQ_FILES, txt)

    def test_both_markers_fail(self):
        with self.assertRaises(cm.PendingError):
            cm.pending_files(SEQ_FILES, read(REAL_PENDING_2) + '\n✅ No migrations to apply!\n')

    def test_migration_name_outside_the_table_fails(self):
        with self.assertRaisesRegex(cm.PendingError, 'outside the table'):
            cm.pending_files(SEQ_FILES, read(REAL_NONE) + '\nalso 0005_more.sql\n')
        with self.assertRaisesRegex(cm.PendingError, 'outside the table'):
            cm.pending_files(SEQ_FILES, read(REAL_PENDING_2) + '0003_index.sql\n')

    def test_unreadable_table_row_fails(self):
        txt = read(REAL_PENDING_2).replace('│ 0004_more.sql │', '│ 0004 more.sql │')
        with self.assertRaises(cm.PendingError):
            cm.pending_files(SEQ_FILES, txt)
        txt = read(REAL_PENDING_2).replace('│ 0004_more.sql │', '  0004_more.sql  ')
        with self.assertRaises(cm.PendingError):
            cm.pending_files(SEQ_FILES, txt)

    def test_unclosed_or_empty_table_fails(self):
        txt = read(REAL_PENDING_2)
        with self.assertRaises(cm.PendingError):
            cm.pending_files(SEQ_FILES, txt[:txt.index('└')])
        head = txt[:txt.index('├')] + '└───────────────┘\n'
        with self.assertRaises(cm.PendingError):
            cm.pending_files(SEQ_FILES, head)

    def test_error_line_fails_even_with_a_table(self):
        with self.assertRaisesRegex(cm.PendingError, 'error'):
            cm.pending_files(SEQ_FILES, '✘ [ERROR] boom\n' + read(REAL_PENDING_2))

    def test_name_must_match_whole(self):
        txt = read(REAL_PENDING_2).replace('0004_more.sql', '10004_more.sql').replace('├───────────────┤', '├────────────────┤')
        with self.assertRaises(cm.PendingError):
            cm.pending_files(SEQ_FILES, txt)


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        for f in SEQ_FILES[:4]:
            self.write(f, 'CREATE TABLE IF NOT EXISTS t (id INTEGER);\n')
        self.write('0005_more.sql', 'DROP TABLE t;\n')

    def write(self, name, text):
        with open(os.path.join(self.d, name), 'w', encoding='utf-8') as fh:
            fh.write(text)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pending_destructive_fails(self):
        code, out = run('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA)
        self.assertEqual(code, 1)
        self.assertIn('::error file=', out)
        self.assertIn('0005_more.sql::destructive: DROP TABLE', out)

    def test_review_required_also_needs_the_override(self):
        self.write('0005_more.sql', 'DROP INDEX i;\n')
        self.assertEqual(run('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA)[0], 1)
        self.assertEqual(run('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA, '--allow', SHA)[0], 0)

    def test_override_with_the_same_sha_passes(self):
        code, out = run('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA, '--allow', SHA)
        self.assertEqual(code, 0)
        self.assertIn('::warning file=', out)

    def test_override_with_another_value_still_fails(self):
        for allow in ('yes', 'b' * 40, SHA.upper(), SHA[:12]):
            code, _ = run('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA, '--allow', allow)
            self.assertEqual(code, 1, allow)

    def test_row_write_needs_owner_marker_and_override(self):
        bad = "DELETE FROM users WHERE length('a') = 1;\n"
        args = ('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA)
        self.write('0005_more.sql', bad)
        code, out = run(*args)
        self.assertEqual(code, 1)
        self.assertIn('0005_more.sql::row-write: DELETE', out)
        code, out = run(*args, '--allow', SHA)                       # override alone is not enough
        self.assertEqual(code, 1)
        self.assertIn('reviewed-by-owner', out)
        self.write('0005_more.sql', '-- reviewed-by-owner: #19\n' + bad)
        self.assertEqual(run(*args)[0], 1)                           # marker alone is not enough
        code, out = run(*args, '--allow', SHA)                       # marker AND override
        self.assertEqual(code, 0)
        self.assertIn('::warning file=', out)

    def test_owner_marker_must_be_a_header_line(self):
        for text in ('DELETE FROM t;\n-- reviewed-by-owner: #19\n',           # after the first statement
                     '/* -- reviewed-by-owner: #19 */\nDELETE FROM t;\n',      # inside a block comment
                     '-- reviewed-by-owner: yes\nDELETE FROM t;\n',            # no PR number
                     '-- reviewed-by-owner: #0\nDELETE FROM t;\n',
                     '-- reviewed-by-owner: #19 trust me\nDELETE FROM t;\n',
                     "SELECT '\n-- reviewed-by-owner: #19\n';\nDELETE FROM t;\n"):
            self.assertIsNone(cm.owner_marker(text), text)
        self.assertEqual(cm.owner_marker('-- backfill\n\n--reviewed-by-owner:42\nUPDATE t SET a = 1;\n'), 42)
        self.assertEqual(cm.owner_marker('  -- reviewed-by-owner: #7  \nDELETE FROM t;'), 7)

    def test_marked_fixture_passes_only_with_override(self):
        d = os.path.join(FIX, 'rowwrite')
        self.assertEqual(run('--dir', d, '--all')[0], 1)
        self.assertEqual(run('--dir', d, '--all', '--sha', SHA, '--allow', SHA)[0], 0)

    def test_nothing_pending_passes(self):
        code, out = run('--dir', self.d, '--pending-from', REAL_NONE, '--sha', SHA)
        self.assertEqual(code, 0)
        self.assertIn('pending migrations: none', out)

    def test_unreadable_listing_fails_closed(self):
        self.assertEqual(run('--dir', self.d, '--pending-from', GARBAGE, '--sha', SHA)[0], 2)
        self.assertEqual(run('--dir', self.d, '--pending-from', os.path.join(FIX, 'does-not-exist.txt'))[0], 2)
        # listing names a file that is not here
        os.remove(os.path.join(self.d, '0005_more.sql'))
        self.assertEqual(run('--dir', self.d, '--pending-from', REAL_PENDING_2, '--sha', SHA)[0], 2)

    def test_missing_dir_fails(self):
        self.assertEqual(run('--dir', os.path.join(FIX, 'nope'), '--all')[0], 2)

    def test_all_safe_passes_and_warn_only_never_fails(self):
        self.assertEqual(run('--dir', os.path.join(FIX, 'safe'), '--all')[0], 0)
        self.assertEqual(run('--dir', os.path.join(FIX, 'sequence'), '--all')[0], 0)
        d = os.path.join(FIX, 'destructive')
        self.assertEqual(run('--dir', d, '--all')[0], 1)
        self.assertEqual(run('--dir', d, '--all', '--warn-only')[0], 0)


REPO_MIGRATIONS = os.path.join(ROOT, 'platform', 'migrations')


def box_listing(names):
    """Same layout as the captured wrangler 4.151.1 output (fixtures), for any list of pending names."""
    w = max(len(n) for n in names + ['Name']) + 2
    rule = lambda a, b: a + '─' * w + b
    rows = [rule('┌', '┐'), '│ ' + 'Name'.ljust(w - 1) + '│']
    for n in names:
        rows += [rule('├', '┤'), '│ ' + n.ljust(w - 1) + '│']
    rows.append(rule('└', '┘'))
    return '\n'.join([' ⛅️ wrangler 4.151.1', 'Resource location: remote', '', 'Migrations to be applied:'] + rows) + '\n'


class Baseline(unittest.TestCase):
    """Historical migrations applied before the gate existed (BASELINE, pinned by sha256) do not block a rebuild from an
    empty database; everything else, every new migration and any edited baseline file, keeps the full rule."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def copy_repo(self):
        for f in sorted(os.listdir(REPO_MIGRATIONS)):
            if f.endswith('.sql'):
                with open(os.path.join(REPO_MIGRATIONS, f), 'rb') as a, open(os.path.join(self.d, f), 'wb') as b:
                    b.write(a.read())
        return sorted(f for f in os.listdir(self.d) if f.endswith('.sql'))

    def listing_file(self, names):
        p = os.path.join(self.d, 'pending.txt')
        with open(p, 'w', encoding='utf-8') as fh:
            fh.write(box_listing(names))
        return p

    def repo_text(self, name):
        with open(os.path.join(REPO_MIGRATIONS, name), encoding='utf-8', newline='') as fh:
            return fh.read()

    def test_baseline_is_closed(self):
        # adding, removing or re-pinning an entry is a reviewed decision: change the literals above with it
        self.assertEqual(sorted(cm.BASELINE), sorted(EXPECTED_BASELINE_SHA256))
        self.assertEqual({n: e['sha256'] for n, e in cm.BASELINE.items()}, EXPECTED_BASELINE_SHA256)
        for name, entry in cm.BASELINE.items():
            self.assertEqual(sorted(entry), ['findings', 'sha256'], name)

    def test_baseline_findings_match_the_test_literals(self):
        for name, entry in cm.BASELINE.items():
            counts = {}
            for f in entry['findings']:
                rule = f.split(' | ', 1)[0]
                counts[rule] = counts.get(rule, 0) + 1
            self.assertEqual(counts, EXPECTED_BASELINE_FINDINGS[name], name)
            destructive = [f.split(' | ', 1)[1] for f in entry['findings'] if f.startswith(cm.DESTRUCTIVE + ':')]
            self.assertEqual(destructive, EXPECTED_BASELINE_DESTRUCTIVE.get(name, []), name)
        for f in cm.BASELINE['0008_section_groups.sql']['findings']:   # only single-row backfills of sections
            self.assertRegex(f, r"^row-write: UPDATE \| UPDATE sections SET group_slug = '[a-z-]+' , position = [0-9]+ "
                                r"WHERE slug = '[a-z-]+'$")

    def test_baseline_pins_match_the_repo_files(self):
        for name, sha in EXPECTED_BASELINE_SHA256.items():
            text = self.repo_text(name)
            # independent of cm.content_sha: plain sha256 of the file bytes (the files are stored with LF)
            with open(os.path.join(REPO_MIGRATIONS, name), 'rb') as fh:
                raw = fh.read()
            self.assertNotIn(b'\r', raw, name)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), sha, f'{name} changed: historical migrations must not be edited')
            self.assertEqual(cm.baseline_status(name, text), 'ok', name)
            self.assertTrue(cm.findings(text), f'{name} has no findings any more: drop it from BASELINE')

    def test_baseline_files_equal_the_anchor_commit(self):
        have = subprocess.run(['git', 'cat-file', '-e', BASELINE_ANCHOR_COMMIT + '^{commit}'], cwd=ROOT,
                              capture_output=True).returncode == 0
        if not have:
            if os.environ.get('CW_REQUIRE_MIGRATION_ANCHOR') == '1':
                self.fail(f'anchor commit {BASELINE_ANCHOR_COMMIT} not in the clone (CW_REQUIRE_MIGRATION_ANCHOR=1)')
            self.skipTest(f'anchor commit {BASELINE_ANCHOR_COMMIT} not in this clone (shallow); '
                          f'git fetch --depth=1 origin {BASELINE_ANCHOR_COMMIT} to run it')
        for name, sha in EXPECTED_BASELINE_SHA256.items():
            blob = subprocess.run(['git', 'show', f'{BASELINE_ANCHOR_COMMIT}:platform/migrations/{name}'], cwd=ROOT,
                                  capture_output=True, check=True).stdout
            self.assertEqual(hashlib.sha256(blob).hexdigest(), sha, f'{name} at the anchor commit')
            with open(os.path.join(REPO_MIGRATIONS, name), 'rb') as fh:
                self.assertEqual(fh.read(), blob, f'{name} differs from its content at {BASELINE_ANCHOR_COMMIT}')

    def test_repinned_baseline_with_new_destructive_statement_still_blocks(self):
        # the attack from review: append DROP TABLE posts to 0008 and re-pin its sha256 in BASELINE -> must not pass
        files = self.copy_repo()
        p = os.path.join(self.d, '0008_section_groups.sql')
        with open(p, 'a', encoding='utf-8', newline='') as fh:
            fh.write('DROP TABLE posts;\n')
        with open(p, encoding='utf-8', newline='') as fh:
            edited = fh.read()
        entry = cm.BASELINE['0008_section_groups.sql']
        saved = dict(entry)
        try:
            entry['sha256'] = cm.content_sha(edited)          # re-pinned in the scanner
            self.assertEqual(cm.baseline_status('0008_section_groups.sql', edited), 'findings')
            code, out = run('--dir', self.d, '--pending-from', self.listing_file(files), '--sha', SHA)
            self.assertEqual(code, 1, out)
            self.assertIn('baseline findings differ', out)
            self.assertIn('0008_section_groups.sql::destructive: DROP TABLE: DROP TABLE posts', out)
            self.assertIn('0008_section_groups.sql::row-write: UPDATE', out)
            # even the release override cannot pass it: the row-write UPDATEs have no owner marker
            self.assertEqual(run('--dir', self.d, '--pending-from', self.listing_file(files), '--sha', SHA,
                                 '--allow', SHA)[0], 1)
            # and the test-side pins catch the re-pin itself
            self.assertNotEqual({n: e['sha256'] for n, e in cm.BASELINE.items()}, EXPECTED_BASELINE_SHA256)
        finally:
            entry.clear(); entry.update(saved)

    def test_repinned_baseline_with_widened_update_still_blocks(self):
        # same statement kind, different statement: an UPDATE without WHERE replacing a pinned one
        files = self.copy_repo()
        p = os.path.join(self.d, '0008_section_groups.sql')
        text = self.repo_text('0008_section_groups.sql')
        target = "WHERE slug = 'needs-a-topic'"
        self.assertIn(target, text)
        edited = text.replace(target, '', 1)
        with open(p, 'w', encoding='utf-8', newline='') as fh:
            fh.write(edited)
        entry = cm.BASELINE['0008_section_groups.sql']
        saved = dict(entry)
        try:
            entry['sha256'] = cm.content_sha(edited)
            self.assertEqual(cm.baseline_status('0008_section_groups.sql', edited), 'findings')
            self.assertEqual(run('--dir', self.d, '--pending-from', self.listing_file(files), '--sha', SHA)[0], 1)
        finally:
            entry.clear(); entry.update(saved)

    def test_findings_list_must_match_exactly(self):
        text = self.repo_text('0009_free_tags.sql')
        entry = cm.BASELINE['0009_free_tags.sql']
        saved = dict(entry)
        try:
            entry['findings'] = tuple(entry['findings'])[:1]   # a finding dropped from the list
            self.assertEqual(cm.baseline_status('0009_free_tags.sql', text), 'findings')
            entry['findings'] = tuple(saved['findings']) + ('destructive: DROP TABLE | DROP TABLE posts',)
            self.assertEqual(cm.baseline_status('0009_free_tags.sql', text), 'findings')
        finally:
            entry.clear(); entry.update(saved)
        self.assertEqual(cm.baseline_status('0009_free_tags.sql', text), 'ok')
        self.assertIsNone(cm.baseline_status('0001_init.sql', text))

    def test_every_other_repo_migration_passes_without_baseline(self):
        for f in sorted(os.listdir(REPO_MIGRATIONS)):
            if f.endswith('.sql') and f not in cm.BASELINE:
                with open(os.path.join(REPO_MIGRATIONS, f), encoding='utf-8') as fh:
                    self.assertEqual(cm.findings(fh.read()), [], f)

    def test_rebuild_from_empty_db_passes_without_override(self):
        files = self.copy_repo()
        code, out = run('--dir', self.d, '--pending-from', self.listing_file(files), '--sha', SHA)
        self.assertEqual(code, 0, out)
        self.assertNotIn('::error', out)
        self.assertEqual(out.count('::notice file='), 3)
        self.assertEqual(run('--dir', REPO_MIGRATIONS, '--all')[0], 0)

    def test_new_row_write_migration_still_blocks_on_empty_db(self):
        files = self.copy_repo()
        new = '0099_backfill.sql'
        with open(os.path.join(self.d, new), 'w', encoding='utf-8') as fh:
            fh.write("UPDATE sections SET position = 1 WHERE slug = 'general';\n")
        listing = self.listing_file(files + [new])
        code, out = run('--dir', self.d, '--pending-from', listing, '--sha', SHA)
        self.assertEqual(code, 1)
        self.assertIn(new + '::row-write: UPDATE', out)
        self.assertEqual(run('--dir', self.d, '--pending-from', listing, '--sha', SHA, '--allow', SHA)[0], 1)  # no marker

    def test_new_destructive_migration_still_needs_the_override(self):
        files = self.copy_repo()
        new = '0099_contract.sql'
        with open(os.path.join(self.d, new), 'w', encoding='utf-8') as fh:
            fh.write('DROP TABLE tags;\n')
        listing = self.listing_file(files + [new])
        self.assertEqual(run('--dir', self.d, '--pending-from', listing, '--sha', SHA)[0], 1)
        self.assertEqual(run('--dir', self.d, '--pending-from', listing, '--sha', SHA, '--allow', SHA)[0], 0)

    def test_edited_baseline_file_loses_the_baseline(self):
        files = self.copy_repo()
        p = os.path.join(self.d, '0009_free_tags.sql')
        with open(p, 'a', encoding='utf-8') as fh:
            fh.write('-- edited\n')
        code, out = run('--dir', self.d, '--pending-from', self.listing_file(files), '--sha', SHA)
        self.assertEqual(code, 1)
        self.assertIn('baseline file changed', out)
        self.assertIn('0009_free_tags.sql::destructive: DROP TABLE', out)

    def test_same_name_other_content_is_not_baselined(self):
        self.assertFalse(cm.baselined('0008_section_groups.sql', 'UPDATE sections SET position = 1;\n'))
        self.assertFalse(cm.baselined('0021_new.sql', ''))

    def test_crlf_checkout_keeps_the_baseline(self):
        with open(os.path.join(REPO_MIGRATIONS, '0018_ai_bot_verified.sql'), encoding='utf-8', newline='') as fh:
            text = fh.read()
        self.assertTrue(cm.baselined('0018_ai_bot_verified.sql', text.replace('\n', '\r\n')))


if __name__ == '__main__':
    unittest.main()
