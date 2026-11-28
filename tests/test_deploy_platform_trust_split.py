"""Structure of .github/workflows/deploy-platform.yml (text only, no YAML library): the production deploy is split like staging.
build (released code, no secrets) -> private-scan (CW_PRIVATE_TERMS, trusted code) -> deploy (the ONE job with the Cloudflare
token and the environment approval, trusted code only) -> verify (no secrets). Also the production config check."""
import importlib.util
import re
import unittest
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python < 3.11
    import tomli as tomllib

ROOT = Path(__file__).resolve().parents[1]
WF = (ROOT / '.github/workflows/deploy-platform.yml').read_text(encoding='utf-8')
TOOLS = ROOT / '.github' / 'deploy-tools'


def jobs():
    body = WF[WF.index('\njobs:\n') + 7:]
    out = {}
    for p in re.split(r'(?m)^(?=  [a-z-]+:\n)', body):
        m = re.match(r'  ([a-z-]+):\n', p)
        if m:
            out[m.group(1)] = p
    return out


J = jobs()


def code(text):
    """the text without comment-only lines"""
    return '\n'.join(l for l in text.splitlines() if not l.lstrip().startswith('#'))


class Split(unittest.TestCase):
    def test_jobs_and_order(self):
        self.assertEqual(list(J), ['gate', 'build', 'private-scan', 'deploy', 'verify'])
        self.assertIn('needs: [gate, build, private-scan]', J['deploy'])
        self.assertIn('needs: [gate, build, deploy]', J['verify'])

    def test_build_has_no_secrets_and_no_environment(self):
        b = code(J['build'])
        self.assertNotIn('secrets.', b)
        self.assertNotIn('environment:', b)
        self.assertNotIn('CW_PRIVATE_TERMS', b)
        self.assertNotIn('CLOUDFLARE', b)

    def test_only_private_scan_reads_the_private_terms(self):
        for name, text in J.items():
            self.assertEqual('secrets.CW_PRIVATE_TERMS' in code(text), name == 'private-scan', name)
        self.assertIn('--require', J['private-scan'])

    def test_only_deploy_has_cloudflare_secrets_and_the_environment(self):
        for name, text in J.items():
            c = code(text)
            self.assertEqual('secrets.CLOUDFLARE' in c, name == 'deploy', name)
            self.assertEqual(re.search(r'(?m)^    environment:', c) is not None, name == 'deploy', name)
        self.assertIn('name: production', J['deploy'])

    def test_verify_and_private_scan_have_no_cloudflare_or_release_code_with_secrets(self):
        self.assertNotIn('secrets.', code(J['verify']))
        ps = code(J['private-scan'])  # the scan job checks out only the pinned workflow sha, never the release
        self.assertEqual(ps.count('actions/checkout@'), 1)
        self.assertIn('ref: ${{ github.sha }}\n          path: trusted', ps)

    def test_deploy_runs_trusted_code_only(self):
        d = code(J['deploy'])
        # the only checkout is the pinned workflow sha under trusted/, never the released commit
        self.assertEqual(d.count('actions/checkout@'), 1)
        self.assertIn('ref: ${{ github.sha }}\n          path: trusted', d)
        self.assertNotIn('ref: ${{ inputs.sha }}', d)
        # no npx, no install of the release, no pip, no code from the release folder tree, wrangler only from the pinned install
        self.assertEqual([l for l in d.splitlines() if 'npx ' in l and 'echo' not in l and not l.lstrip().startswith('`')], [])  # only the printed rollback hint
        self.assertNotIn('npm test', d)
        self.assertNotIn('pip install', d)
        self.assertNotIn('platform/scripts', d)
        self.assertEqual(d.count('npm ci --ignore-scripts'), 1)
        self.assertNotIn('npm ci --no-audit', d)
        self.assertIn('trusted/.github/deploy-tools/node_modules/wrangler/bin/wrangler.js', d)
        self.assertIn('trusted/scripts/check-migrations.py', d)
        self.assertIn('prepare-production.sh', d)

    def test_order_of_the_privileged_steps_is_kept(self):
        names = re.findall(r'(?m)^      - name: (.*)$', J['deploy'])
        want = ['Production version before this deploy', 'Migration gate', 'Time Travel bookmark', 'Apply database migrations', 'Deploy the Worker']
        idx = [next(i for i, n in enumerate(names) if n.startswith(w)) for w in want]
        self.assertEqual(idx, sorted(idx), names)
        self.assertLess(idx[0], idx[1])
        self.assertTrue(names[-1].startswith('Deploy the Worker'), names)

    def test_gate_override_and_rollback_text_are_kept(self):
        d = J['deploy']
        for s in ('check-migrations.py', '--allow "$ALLOW_DESTRUCTIVE"', 'wrangler rollback', 'time-travel restore', 'code: 10007'):
            self.assertIn(s, d)

    def test_every_action_is_pinned_to_a_sha(self):
        for line in re.findall(r'(?m)^\s*(?:- )?uses: (\S+)', WF):
            self.assertRegex(line, r'@[0-9a-f]{40}$')

    def test_empty_migrations_and_artifact_retention(self):
        b = code(J['build'])
        self.assertNotIn('cp platform/migrations/*.sql', b)  # a glob that matches nothing would fail the pack
        self.assertIn("find platform/migrations -maxdepth 1 -type f -name '*.sql'", b)
        self.assertIn('retention-days: 3', b)
        self.assertNotIn('ALLOW_DESTRUCTIVE', b)  # only the credential job reads the override
        self.assertIn("-name '*.sql' -print -quit", J['deploy'])  # no migration files: notice, nothing to check

    def test_deploy_step_uses_the_prebuilt_bundle(self):
        self.assertIn('deploy bundle/index.js --no-bundle --config wrangler.toml --env production', J['deploy'])


def load_check():
    spec = importlib.util.spec_from_file_location('check_production_config', TOOLS / 'check-production-config.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


CHK = load_check()
CFG = tomllib.loads((ROOT / 'platform' / 'wrangler.toml').read_text(encoding='utf-8'))


class ProductionConfig(unittest.TestCase):
    def refused(self, mutate, part):
        import copy
        c = copy.deepcopy(CFG)
        mutate(c)
        with self.assertRaises(CHK.Bad) as cm:
            CHK.check(c)
        self.assertIn(part, str(cm.exception))

    def test_current_config_passes(self):
        CHK.check(CFG)

    def test_build_command_and_unknown_keys_are_refused(self):
        self.refused(lambda c: c.update(build={'command': 'x'}), 'top level')
        self.refused(lambda c: c['env']['production'].update(build={'command': 'x'}), 'env.production')
        self.refused(lambda c: c['env']['production'].update(rules=[{'type': 'Text'}]), 'env.production')
        self.refused(lambda c: c['env']['production'].update(services=[{'binding': 'X'}]), 'env.production')
        self.refused(lambda c: c['env'].update(other={}), 'env')

    def test_identity_is_fixed(self):
        self.refused(lambda c: c['env']['production'].update(name='other'), 'name')
        self.refused(lambda c: c['env']['production']['d1_databases'][0].update(database_name='commonworld-staging'), 'D1 database')
        self.refused(lambda c: c['env']['production']['d1_databases'][0].update(migrations_dir='../x'), 'migrations_dir')
        self.refused(lambda c: c['env']['production']['assets'].update(directory='./other'), 'directory')
        self.refused(lambda c: c['env']['production'].update(workers_dev=True), 'workers_dev')

    def test_bindings_and_routes_are_pinned(self):
        self.refused(lambda c: c['env']['production']['d1_databases'][0].update(database_id='0' * 8 + CFG['env']['production']['d1_databases'][0]['database_id'][8:]), 'database id')
        self.refused(lambda c: c['env']['production']['r2_buckets'][0].update(bucket_name='other'), 'R2 bucket')
        self.refused(lambda c: c['env']['production']['routes'].append({'pattern': 'example.org', 'custom_domain': True}), 'custom domains')
        self.refused(lambda c: c['env']['production']['routes'].append({'pattern': 'x.commonworld.one/*'}), 'custom domains')
        self.refused(lambda c: c['env']['production']['ratelimits'][0].update(namespace_id='7200'), 'namespace_id')


if __name__ == '__main__':
    unittest.main()
