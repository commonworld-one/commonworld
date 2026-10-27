"""platform/scripts/seed-local.mjs (npm run seed:local, #151): runs the seed generator and wrangler without a shell.

The script runs from a temporary copy of platform/ with a stub generator and a stub wrangler devDependency, so the
test needs neither the mockups nor a real local D1."""
import json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'platform' / 'scripts' / 'seed-local.mjs'
SQL = "INSERT INTO posts (title) VALUES ('caf\u00e9 \u2026 \u65e5\u672c');\n"

GENERATOR = """import os, sys
if os.environ.get('STUB_GEN_EXIT'):
    sys.stderr.write('generator broke\\n')
    sys.exit(int(os.environ['STUB_GEN_EXIT']))
sys.stdout.write(%r)
""" % SQL

WRANGLER = """const fs = require('node:fs');
fs.writeFileSync(process.env.STUB_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  sql: fs.readFileSync('.local/seed.sql', 'utf-8') }));
process.exit(Number(process.env.STUB_WRANGLER_EXIT || 0));
"""


@unittest.skipUnless(shutil.which('node'), 'node not installed')
class SeedLocal(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='seed local '))   # a space in the path on purpose
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.platform = self.tmp / 'platform'
        (self.platform / 'scripts').mkdir(parents=True)
        shutil.copy(SCRIPT, self.platform / 'scripts' / 'seed-local.mjs')
        (self.platform / 'scripts' / 'seed_from_mockups.py').write_text(GENERATOR, encoding='utf-8')
        (self.platform / 'package.json').write_text('{"name": "stub", "private": true, "type": "module"}')
        wr = self.platform / 'node_modules' / 'wrangler'
        (wr / 'bin').mkdir(parents=True)
        (wr / 'package.json').write_text(json.dumps({'name': 'wrangler', 'bin': {'wrangler': './bin/wrangler.js'}}))
        (wr / 'bin' / 'wrangler.js').write_text(WRANGLER)
        self.record = self.tmp / 'record.json'

    def run_seed(self, **env):
        e = dict(os.environ, PYTHON=sys.executable, STUB_RECORD=str(self.record))
        e.update(env)
        return subprocess.run(['node', str(self.platform / 'scripts' / 'seed-local.mjs')], env=e, cwd=self.tmp,
                              capture_output=True, text=True, encoding='utf-8', timeout=60)

    def test_writes_sql_bytes_and_runs_wrangler_like_the_old_npm_script(self):
        r = self.run_seed()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.platform / '.local' / 'seed.sql').read_bytes(), SQL.encode('utf-8'))
        rec = json.loads(self.record.read_text(encoding='utf-8'))
        self.assertEqual(rec['argv'], ['d1', 'execute', 'commonworld-dev', '--local', '--file', '.local/seed.sql'])
        self.assertEqual(Path(rec['cwd']).resolve(), self.platform.resolve())
        self.assertEqual(rec['sql'], SQL)

    def test_generator_failure_writes_nothing_and_keeps_the_exit_code(self):
        r = self.run_seed(STUB_GEN_EXIT='3')
        self.assertEqual(r.returncode, 3)
        self.assertIn('generator broke', r.stderr)
        self.assertFalse((self.platform / '.local' / 'seed.sql').exists())
        self.assertFalse(self.record.exists())

    def test_wrangler_failure_keeps_the_exit_code(self):
        r = self.run_seed(STUB_WRANGLER_EXIT='5')
        self.assertEqual(r.returncode, 5)
        self.assertTrue(self.record.exists())

    @unittest.skipIf(sys.platform == 'win32', 'symlinks')
    def test_python_path_with_spaces(self):
        d = self.tmp / 'my python'
        d.mkdir()
        os.symlink(sys.executable, d / 'python')
        r = self.run_seed(PYTHON=str(d / 'python'))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(str(d / 'python'), r.stdout)

    @unittest.skipIf(sys.platform == 'win32', 'shell stub')
    @unittest.skipUnless(shutil.which('python3'), 'no python3 on PATH')
    def test_too_old_python_is_skipped(self):
        old = self.tmp / 'old-python'
        old.write_text('#!/bin/sh\nexit 1\n')   # fails the 3.10+ check like an old interpreter would
        old.chmod(0o755)
        r = self.run_seed(PYTHON=str(old))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('using python3', r.stdout)


if __name__ == '__main__':
    unittest.main()
