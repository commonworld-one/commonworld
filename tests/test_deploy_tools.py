"""Tests for .github/deploy-tools (trusted helpers of the staging deploy): config allowlist, artifact reader, term scan."""
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python < 3.11
    import tomli as tomllib

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.github' / 'deploy-tools'


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLS / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CFG = load_module('make_staging_config', 'make-staging-config.py')
EXT = load_module('safe_extract', 'safe-extract.py')
TRUSTED = tomllib.loads((ROOT / 'platform' / 'wrangler.toml').read_text(encoding='utf-8'))
SHA = 'a' * 40


class Config(unittest.TestCase):
    def build(self, mutate=None):
        ref = copy.deepcopy(TRUSTED)
        if mutate:
            mutate(ref)
        return CFG.build(ref, TRUSTED)

    def refused(self, mutate, needle=''):
        with self.assertRaises(CFG.Bad) as cm:
            self.build(mutate)
        self.assertIn(needle, str(cm.exception))

    def test_main_config_is_accepted_and_equals_env_staging(self):
        out = self.build()
        env = TRUSTED['env']['staging']
        for k, v in env.items():
            self.assertEqual(out[k], v, k)
        self.assertEqual(out['compatibility_date'], TRUSTED['compatibility_date'])
        self.assertEqual(set(out) - set(env), {'compatibility_date'})

    def test_build_hook_and_unknown_sections_are_refused(self):
        self.refused(lambda c: c.update(build={'command': 'touch /tmp/x'}), 'top level')
        self.refused(lambda c: c['env']['staging'].update(build={'command': 'x'}), 'env.staging')
        self.refused(lambda c: c['env']['staging'].update(kv_namespaces=[{'binding': 'K', 'id': '1'}]), 'not allowed')
        self.refused(lambda c: c['env']['staging'].update(services=[{'binding': 'S', 'service': 'commonworld-api'}]), 'not allowed')
        self.refused(lambda c: c['env']['staging'].update(durable_objects={}), 'not allowed')
        self.refused(lambda c: c['env']['staging'].update(rules=[]), 'not allowed')
        self.refused(lambda c: c['env'].update(other={}), 'env:')

    def test_identity_is_fixed_to_the_trusted_config(self):
        self.refused(lambda c: c['env']['staging'].update(name='commonworld-api'), 'name')
        self.refused(lambda c: c['env']['staging']['d1_databases'][0].update(database_id='0' * 8 + '-0000-0000-0000-000000000000'), 'trusted')
        self.refused(lambda c: c['env']['staging']['d1_databases'][0].update(database_name='commonworld-prod'), '')
        self.refused(lambda c: c['env']['staging']['d1_databases'].append({'binding': 'X', 'database_name': 'commonworld-prod', 'database_id': 'x'}), '')
        self.refused(lambda c: c['env']['staging']['r2_buckets'][0].update(bucket_name='commonworld-backups'), '')
        self.refused(lambda c: c['env']['staging'].update(routes=[{'pattern': 'commonworld.one', 'custom_domain': True}]), 'routes')
        self.refused(lambda c: c['env']['staging'].update(workers_dev=True), 'workers_dev')

    def test_free_settings_are_validated(self):
        ok = self.build(lambda c: c['env']['staging']['vars'].update(NEW_FLAG='1'))
        self.assertEqual(ok['vars']['NEW_FLAG'], '1')
        self.refused(lambda c: c['env']['staging']['vars'].update(ENVIRONMENT='production'), 'ENVIRONMENT')
        self.refused(lambda c: c['env']['staging']['vars'].update(BACKUPS_BUCKET='commonworld-backups'), 'BACKUPS_BUCKET')
        self.refused(lambda c: c['env']['staging']['vars'].update(OBJ={'a': 1}), 'vars')
        self.refused(lambda c: c['env']['staging']['ratelimits'].append({'name': 'RL_X', 'namespace_id': '7100', 'simple': {'limit': 1, 'period': 60}}), 'namespace_id')
        self.refused(lambda c: c['env']['staging']['assets'].update(directory='../x'), 'assets.directory')
        self.refused(lambda c: c['env']['staging']['assets'].update(extra=1), 'assets')
        self.refused(lambda c: c['env']['staging']['triggers'].update(queues=[]), 'triggers')
        self.refused(lambda c: c['env']['staging']['triggers'].update(crons=['; rm -rf /']), 'crons')

    def test_cli_writes_the_file_and_reports_refusals(self):
        with tempfile.TemporaryDirectory() as td:
            ref = Path(td, 'ref.toml')
            ref.write_text((ROOT / 'platform' / 'wrangler.toml').read_text(encoding='utf-8'), encoding='utf-8')
            out = Path(td, 'wrangler.json')
            self.assertEqual(CFG.main(['--ref-config', str(ref), '--trusted-config', str(ROOT / 'platform' / 'wrangler.toml'), '--out', str(out)]), 0)
            self.assertEqual(json.loads(out.read_text())['name'], 'commonworld-api-staging')
            ref.write_text('[build]\ncommand = "x"\n', encoding='utf-8')
            self.assertEqual(CFG.main(['--ref-config', str(ref), '--trusted-config', str(ROOT / 'platform' / 'wrangler.toml'), '--out', str(Path(td, 'o2.json'))]), 1)
            ref.write_text('not toml [', encoding='utf-8')
            self.assertEqual(CFG.main(['--ref-config', str(ref), '--trusted-config', str(ROOT / 'platform' / 'wrangler.toml'), '--out', str(Path(td, 'o3.json'))]), 1)


def make_tar(path, extra=None, skip=(), sha=SHA):
    files = {
        'bundle/index.js': b'export default {}',
        'assets/atlas/index.html': b'<html></html>',
        'assets/_headers': b'/*\n',
        'migrations/0001_init.sql': b'CREATE TABLE t(x);',
        'meta/sha.txt': sha.encode() + b'\n',
        'meta/contact.txt': b'hello@example.org\n',
        'meta/ref-config.toml': b'name = "x"\n',
    }
    with tarfile.open(path, 'w') as tf:
        for name, data in files.items():
            if name in skip:
                continue
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))
        for ti, data in (extra or []):
            tf.addfile(ti, io.BytesIO(data) if data is not None else None)


class Extract(unittest.TestCase):
    def run_extract(self, **kw):
        td = tempfile.mkdtemp()
        tar = os.path.join(td, 'a.tar')
        make_tar(tar, **kw)
        return EXT.extract(tar, os.path.join(td, 'out')), td

    def refused(self, needle, **kw):
        with self.assertRaises(EXT.Bad) as cm:
            self.run_extract(**kw)
        self.assertIn(needle, str(cm.exception))

    def test_good_archive(self):
        (sha, files, _), td = self.run_extract()
        self.assertEqual((sha, files), (SHA, 7))
        self.assertTrue(os.path.isfile(os.path.join(td, 'out', 'bundle', 'index.js')))

    def test_links_devices_and_odd_paths_are_refused(self):
        sym = tarfile.TarInfo('assets/link'); sym.type = tarfile.SYMTYPE; sym.linkname = '/etc/passwd'
        self.refused('not a plain file', extra=[(sym, None)])
        hard = tarfile.TarInfo('assets/hard'); hard.type = tarfile.LNKTYPE; hard.linkname = 'bundle/index.js'
        self.refused('not a plain file', extra=[(hard, None)])
        dev = tarfile.TarInfo('assets/dev'); dev.type = tarfile.CHRTYPE
        self.refused('not a plain file', extra=[(dev, None)])
        for bad in ('../evil', '/abs/evil', 'assets/../../evil', 'assets//x', 'other/x', 'assets/a\\b'):
            ti = tarfile.TarInfo(bad); ti.size = 1
            self.refused('', extra=[(ti, b'x')])

    def test_names_and_layout_are_checked(self):
        ti = tarfile.TarInfo('migrations/evil.sh'); ti.size = 1
        self.refused('migration file name', extra=[(ti, b'x')])
        ti = tarfile.TarInfo('meta/extra'); ti.size = 1
        self.refused('meta file', extra=[(ti, b'x')])
        self.refused('missing', skip=('bundle/index.js',))
        self.refused('full commit sha', sha='abc')

    def test_existing_target_is_not_overwritten(self):
        dup = tarfile.TarInfo('bundle/index.js'); dup.size = 1
        with self.assertRaises((EXT.Bad, FileExistsError)):
            self.run_extract(extra=[(dup, b'x')])


class Scan(unittest.TestCase):
    def scan(self, files, terms, contact='hello@example.org', require=False):
        td = tempfile.mkdtemp()
        for name, text in files.items():
            p = Path(td, 'assets', name); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text, encoding='utf-8')
        Path(td, 'contact.txt').write_text(contact, encoding='utf-8')
        env = dict(os.environ)
        env.pop('CW_PRIVATE_TERMS', None)
        if terms is not None:
            env['CW_PRIVATE_TERMS'] = terms
        args = [sys.executable, str(TOOLS / 'scan-private-terms.py'), str(Path(td, 'assets')), str(Path(td, 'contact.txt'))] + (['--require'] if require else [])
        return subprocess.run(args, env=env, capture_output=True, text=True)

    def test_hit_fails_and_does_not_print_the_match(self):
        r = self.scan({'atlas/a.html': 'x SecretWord y'}, 'secretword|other')
        self.assertEqual(r.returncode, 1)
        self.assertIn('atlas/a.html', r.stdout)
        self.assertNotIn('ecretWord', r.stdout + r.stderr)

    def test_clean_passes_and_covers_headers_files(self):
        self.assertEqual(self.scan({'atlas/a.html': 'fine', 'b.png': 'secretword'}, 'secretword').returncode, 0)
        self.assertEqual(self.scan({'_headers': 'secretword'}, 'secretword').returncode, 1)

    def test_contact_address_is_ignored_but_only_that_string(self):
        self.assertEqual(self.scan({'a.html': 'mail hello@example.org'}, 'example').returncode, 0)
        self.assertEqual(self.scan({'a.html': 'other@example.org'}, 'example').returncode, 1)
        self.assertEqual(self.scan({'a.html': 'x'}, 'x', contact='not an email; x').returncode, 1)

    def test_missing_secret_warns_or_fails_with_require(self):
        r = self.scan({'a.html': 'x'}, None)
        self.assertEqual((r.returncode, 'skipped' in r.stdout), (0, True))
        self.assertEqual(self.scan({'a.html': 'x'}, None, require=True).returncode, 1)
        self.assertEqual(self.scan({'a.html': 'x'}, '(').returncode, 1)


class PinnedWrangler(unittest.TestCase):
    def test_pinned_wrangler_is_exact_and_same_major_as_platform(self):
        pin = json.loads((TOOLS / 'package.json').read_text())['dependencies']['wrangler']
        self.assertRegex(pin, r'^\d+\.\d+\.\d+$')   # exact: bumps come through Dependabot, reviewed
        lock = json.loads((TOOLS / 'package-lock.json').read_text())
        self.assertEqual(lock['packages']['node_modules/wrangler']['version'], pin)
        plat = json.loads((ROOT / 'platform' / 'package-lock.json').read_text())['packages']['node_modules/wrangler']['version']
        self.assertEqual(pin.split('.')[0], plat.split('.')[0])


class StagingWorkflow(unittest.TestCase):
    """Text-level structure of deploy-staging.yml: no runner holds Cloudflare credentials together with the ref's code."""
    text = (ROOT / '.github' / 'workflows' / 'deploy-staging.yml').read_text(encoding='utf-8')

    def jobs(self):
        body = self.text.split('\njobs:\n', 1)[1]
        parts = __import__('re').split(r'\n  ([a-z0-9-]+):\n', '\n' + body)
        return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}

    def test_token_jobs_never_run_ref_code(self):
        jobs = self.jobs()
        holders = [n for n, b in jobs.items() if '${{ secrets.CLOUDFLARE_' in b]
        self.assertEqual(sorted(holders), ['deploy', 'migrate'])
        for n in holders:
            b = jobs[n]
            self.assertNotIn('inputs.ref', b.replace('REF: ${{ inputs.ref }}', ''), n)   # only as a plain env value (message text)
            for needle in ('npm ci --no-audit', 'npm test', 'npx ', 'platform/scripts/', 'pip install', 'path: trusted'):
                if needle == 'path: trusted':
                    self.assertIn(needle, b, n)
                else:
                    self.assertNotIn(needle, b, n)
            self.assertIn('--ignore-scripts', b, n)
            self.assertIn('ref: ${{ github.sha }}', b, n)

    def test_ref_code_jobs_have_no_secrets_or_environment(self):
        jobs = self.jobs()
        for n in ('resolve', 'build', 'verify', 'e2e'):
            self.assertNotIn('${{ secrets.', jobs[n], n)
            self.assertNotIn('\n    environment:', jobs[n], n)
        self.assertIn('${{ secrets.CW_PRIVATE_TERMS }}', jobs['private-scan'])
        self.assertNotIn('inputs.ref', jobs['private-scan'].replace('ref: ${{ github.sha }}', ''))

    def test_gate_job_names_and_artifact_are_kept(self):
        self.assertEqual(self.text.count('name: Deploy to staging\n'), 1)
        self.assertEqual(self.text.count('name: E2E against staging (read-only)\n'), 1)
        jobs = self.jobs()
        self.assertIn('needs: [resolve, deploy]', jobs['verify'])
        self.assertIn('name: staging-deployed-${{ needs.resolve.outputs.sha }}', jobs['verify'])
        self.assertIn('needs: verify', jobs['e2e'])

    def test_no_expression_inside_shell_bodies(self):
        import re
        for n, b in self.jobs().items():
            lines = b.split('\n')
            for k, line in enumerate(lines):
                m = re.match(r'^( +)run: (.*)$', line)
                if not m:
                    continue
                ind = len(m.group(1))
                body = [m.group(2)] if m.group(2).strip() not in ('|', '>', '') else []
                for nxt in lines[k + 1:]:
                    if nxt.strip() and len(nxt) - len(nxt.lstrip()) <= ind:
                        break
                    body.append(nxt)
                self.assertNotIn('${{', '\n'.join(body), f'{n}: expression inside a shell body')


class StagingJobGraph(unittest.TestCase):
    """Runs the job conditions of deploy-staging.yml against a model of GitHub's skip rules.

    A job with no status function in its `if` gets an implicit success(), which is false when ANY job upstream, directly or
    not, was skipped or failed. Jobs with `!cancelled()` or similar skip that check and decide from `needs.*.result`.
    """
    ORDER = ['resolve', 'build', 'private-scan', 'migrate', 'deploy', 'verify', 'e2e']

    @classmethod
    def graph(cls):
        import re
        text = StagingWorkflow.text
        jobs = StagingWorkflow().jobs()
        g = {}
        for n in cls.ORDER:
            b = jobs[n]
            m = re.search(r'\n    needs: (\[[^\]]*\]|[a-z-]+)\n', '\n' + b)
            needs = [x.strip() for x in m.group(1).strip('[]').split(',')] if m else []
            c = re.search(r'\n    if: (.*)\n', '\n' + b)
            cond = c.group(1).strip() if c else None
            if cond and cond.startswith('${{'):
                cond = cond[3:-2].strip()
            g[n] = (needs, cond)
        return g

    @classmethod
    def simulate(cls, apply_migrations, failing=None, cancelled=False):
        g = cls.graph()
        res = {}

        def ancestors(n):
            out = set()
            for d in g[n][0]:
                out |= {d} | ancestors(d)
            return out

        for n in cls.ORDER:
            needs, cond = g[n]
            has_status = bool(cond) and any(f in cond for f in ('cancelled()', 'always()', 'failure()', 'success()'))
            implicit = (not has_status) and not cancelled and all(res[a] == 'success' for a in ancestors(n))
            if cond is None:
                run = implicit
            else:
                py = cond.replace('&&', ' and ').replace('||', ' or ')
                py = py.replace('!cancelled()', '(not CANCELLED)')
                import re
                py = re.sub(r"needs\.([a-z-]+)\.result", lambda m: "NEEDS['%s']" % m.group(1), py)
                py = py.replace("github.ref == 'refs/heads/main'", 'True').replace('inputs.apply_migrations', 'APPLY')
                self_ok = eval(py, {'NEEDS': {d: res[d] for d in needs}, 'CANCELLED': cancelled, 'APPLY': apply_migrations})
                run = bool(self_ok) and (has_status or implicit)
            res[n] = ('failure' if n == failing else 'success') if run else 'skipped'
        return res

    def test_good_runs_reach_the_gate_jobs_with_and_without_migrations(self):
        for apply in (False, True):
            r = self.simulate(apply)
            self.assertEqual(r['verify'], 'success', apply)
            self.assertEqual(r['e2e'], 'success', apply)
            self.assertEqual(r['migrate'], 'success' if apply else 'skipped')

    def test_gate_jobs_only_succeed_when_everything_before_them_did(self):
        for apply in (False, True):
            for failing in [None] + self.ORDER:
                if failing == 'migrate' and not apply:
                    continue
                r = self.simulate(apply, failing)
                required = ['resolve', 'build', 'private-scan', 'deploy'] + (['migrate'] if apply else [])
                good = failing is None or failing not in required
                self.assertEqual(r['verify'] == 'success', good and failing != 'verify', (apply, failing, r))
                self.assertEqual(r['e2e'] == 'success', good and failing not in ('verify', 'e2e'), (apply, failing, r))
                if failing in required:
                    self.assertEqual((r['verify'], r['e2e']), ('skipped', 'skipped'), (apply, failing, r))

    def test_cancelled_run_deploys_and_verifies_nothing(self):
        for apply in (False, True):
            r = self.simulate(apply, None, cancelled=True)
            self.assertEqual((r['deploy'], r['verify'], r['e2e']), ('skipped', 'skipped', 'skipped'), apply)

    def test_old_default_condition_would_have_skipped_the_gate(self):
        """The failure this model exists for: with no explicit condition, a skipped migrate skips verify and e2e."""
        cls = self.__class__
        saved = cls.graph
        try:
            def broken():
                g = saved.__func__(cls)
                g['verify'] = (g['verify'][0], None)
                g['e2e'] = (g['e2e'][0], None)
                return g
            cls.graph = classmethod(lambda c: broken())
            r = cls.simulate(False)
            self.assertEqual((r['deploy'], r['verify'], r['e2e']), ('success', 'skipped', 'skipped'))
        finally:
            cls.graph = saved

    def test_conditions_only_read_direct_needs(self):
        import re
        g = self.graph()
        for n, (needs, cond) in g.items():
            for dep in re.findall(r'needs\.([a-z-]+)\.result', cond or ''):
                self.assertIn(dep, needs, f'{n} reads needs.{dep} but does not list it')


if __name__ == '__main__':
    unittest.main()
