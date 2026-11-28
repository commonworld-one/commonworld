#!/usr/bin/env python3
"""Build the Wrangler config for the staging deploy from DATA only.

The staging deploy job holds Cloudflare credentials, so it must not trust platform/wrangler.toml of the dispatched
ref as a program: Wrangler config can carry a build command and arbitrary bindings. This script reads the ref's
wrangler.toml as data, compares it with the wrangler.toml of the trusted checkout (main at the pinned workflow sha),
and writes a flat wrangler.json that only contains keys on an explicit allowlist. Anything else fails closed.

Fixed to the trusted copy (a ref cannot change them): Worker name, route, D1 database (name and id, binding name),
R2 bucket (name and binding name), workers_dev. Free to change on a ref (so a branch can still try new settings on
staging): plain string vars (except ENVIRONMENT and BACKUPS_BUCKET), rate-limit bindings in the staging namespace range,
cron triggers, the CPU limit, observability flags and the static assets options (directory fixed).

usage: make-staging-config.py --ref-config REF/platform/wrangler.toml --trusted-config MAIN/platform/wrangler.toml --out wrangler.json
"""
import argparse
import json
import re
import sys

try:
    import tomllib
except ImportError:  # local runs on Python < 3.11
    import tomli as tomllib

ENV = 'staging'
WORKER = 'commonworld-api-staging'
DATABASE = 'commonworld-staging'
ROUTE = 'staging.commonworld.one'
PINNED_VARS = {'ENVIRONMENT': 'staging'}
ENV_KEYS = {'name', 'workers_dev', 'routes', 'ratelimits', 'vars', 'assets', 'triggers', 'limits', 'observability',
            'd1_databases', 'r2_buckets'}
TOP_INHERITED = {'compatibility_date', 'compatibility_flags'}
ASSET_KEYS = {'directory', 'binding', 'not_found_handling', 'html_handling', 'run_worker_first'}
ASSET_ENUMS = {'not_found_handling': {'404-page', 'single-page-application', 'none'},
               'html_handling': {'auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'}}
VAR_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,63}$')
CRON = re.compile(r'^[0-9*/,\-A-Za-z ]{5,40}$')
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
PATTERN = re.compile(r'^[\x21-\x7e]{1,200}$')


class Bad(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Bad(msg)


def load(path):
    with open(path, 'rb') as fh:
        return tomllib.load(fh)


def only(d, allowed, where):
    extra = sorted(set(d) - set(allowed))
    need(not extra, f'{where}: key(s) not allowed: {extra}')


def build(ref, trusted):
    need(isinstance(ref, dict) and isinstance(trusted, dict), 'config is not a table')
    only(ref, {'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'ratelimits', 'assets', 'vars',
               'triggers', 'observability', 'd1_databases', 'r2_buckets', 'env'}, 'top level')
    need('build' not in ref and 'rules' not in ref, 'top level: no build or rules section is accepted')
    env = (ref.get('env') or {}).get(ENV)
    tenv = (trusted.get('env') or {}).get(ENV)
    need(isinstance(env, dict) and isinstance(tenv, dict), f'env.{ENV} missing')
    only(ref.get('env') or {}, {ENV, 'production'}, 'env')
    only(env, ENV_KEYS, f'env.{ENV}')
    out = {}
    # identity, fixed to the trusted copy
    need(env.get('name') == WORKER and tenv.get('name') == WORKER, f'env.{ENV}.name must be {WORKER}')
    out['name'] = WORKER
    need(env.get('workers_dev') is False, 'workers_dev must be false')
    out['workers_dev'] = False
    need(env.get('routes') == tenv.get('routes') == [{'pattern': ROUTE, 'custom_domain': True}],
         f'routes must be exactly the custom domain {ROUTE}')
    out['routes'] = env['routes']
    need(env.get('d1_databases') == tenv.get('d1_databases'), 'd1_databases differ from the trusted config')
    d1 = env['d1_databases']
    need(isinstance(d1, list) and len(d1) == 1 and d1[0].get('database_name') == DATABASE
         and set(d1[0]) <= {'binding', 'database_name', 'database_id', 'migrations_dir'}
         and d1[0].get('migrations_dir', 'migrations') == 'migrations', 'd1_databases must be the staging database only')
    out['d1_databases'] = d1
    need(env.get('r2_buckets') == tenv.get('r2_buckets'), 'r2_buckets differ from the trusted config')
    r2 = env['r2_buckets']
    need(isinstance(r2, list) and len(r2) == 1 and set(r2[0]) == {'binding', 'bucket_name'}
         and r2[0]['bucket_name'].endswith('-staging'), 'r2_buckets must be the staging bucket only')
    out['r2_buckets'] = r2
    # inherited from the top level
    for k in TOP_INHERITED:
        if k in ref:
            out[k] = ref[k]
    need(DATE.match(str(out.get('compatibility_date', ''))), 'compatibility_date missing or malformed')
    if 'compatibility_flags' in out:
        need(isinstance(out['compatibility_flags'], list) and all(isinstance(x, str) and VAR_NAME.match(x.replace('-', '_').replace('.', '_')) for x in out['compatibility_flags']), 'compatibility_flags malformed')
    # free settings
    vars_ = env.get('vars') or {}
    need(isinstance(vars_, dict) and all(isinstance(k, str) and VAR_NAME.match(k) and isinstance(v, str) and len(v) <= 500 for k, v in vars_.items()),
         'vars must be plain strings')
    for k, v in PINNED_VARS.items():
        need(vars_.get(k) == v, f'var {k} must be {v!r}')
    need(vars_.get('BACKUPS_BUCKET') == r2[0]['bucket_name'], 'var BACKUPS_BUCKET must be the staging bucket')
    out['vars'] = vars_
    rl = env.get('ratelimits') or []
    need(isinstance(rl, list), 'ratelimits must be a list')
    for r in rl:
        only(r, {'name', 'namespace_id', 'simple'}, 'ratelimits entry')
        need(isinstance(r.get('name'), str) and VAR_NAME.match(r['name']), 'ratelimit name malformed')
        need(isinstance(r.get('namespace_id'), str) and re.fullmatch(r'72\d\d', r['namespace_id']), 'ratelimit namespace_id must be in the staging range 7200-7299')
        s = r.get('simple')
        need(isinstance(s, dict) and set(s) == {'limit', 'period'} and isinstance(s['limit'], int) and s['period'] in (10, 60), 'ratelimit simple malformed')
    out['ratelimits'] = rl
    a = env.get('assets')
    need(isinstance(a, dict), 'assets missing')
    only(a, ASSET_KEYS, 'assets')
    need(a.get('directory') == './.atlas-dist' and a.get('binding') == 'ASSETS', "assets.directory must be './.atlas-dist' and binding ASSETS")
    for k, allowed in ASSET_ENUMS.items():
        need(k not in a or a[k] in allowed, f'assets.{k} not allowed')
    rwf = a.get('run_worker_first', [])
    need(isinstance(rwf, list) and len(rwf) <= 200 and all(isinstance(x, str) and PATTERN.match(x) for x in rwf), 'run_worker_first malformed')
    out['assets'] = a
    t = env.get('triggers') or {}
    only(t, {'crons'}, 'triggers')
    need(isinstance(t.get('crons', []), list) and len(t.get('crons', [])) <= 10 and all(isinstance(c, str) and CRON.match(c) for c in t.get('crons', [])), 'crons malformed')
    out['triggers'] = t
    lim = env.get('limits')
    if lim is not None:
        only(lim, {'cpu_ms'}, 'limits')
        need(isinstance(lim.get('cpu_ms'), int) and 1 <= lim['cpu_ms'] <= 300000, 'limits.cpu_ms malformed')
        out['limits'] = lim
    ob = env.get('observability')
    if ob is not None:
        only(ob, {'enabled', 'logs'}, 'observability')
        need(isinstance(ob.get('enabled'), bool), 'observability.enabled must be a boolean')
        lg = ob.get('logs') or {}
        only(lg, {'invocation_logs', 'enabled'}, 'observability.logs')
        need(all(isinstance(v, bool) for v in lg.values()), 'observability.logs flags must be booleans')
        out['observability'] = ob
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref-config', required=True)
    ap.add_argument('--trusted-config', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args(argv)
    try:
        cfg = build(load(a.ref_config), load(a.trusted_config))
    except Bad as e:
        print(f'::error::staging config refused: {e}')
        return 1
    except (tomllib.TOMLDecodeError, OSError, UnicodeDecodeError) as e:
        print(f'::error::staging config unreadable: {type(e).__name__}')
        return 1
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(cfg, fh, indent=2, sort_keys=True)
        fh.write('\n')
    print(f'wrote {a.out}: name={cfg["name"]} d1={[d["database_name"] for d in cfg["d1_databases"]]} routes={[r["pattern"] for r in cfg["routes"]]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
