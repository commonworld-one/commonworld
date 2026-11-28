#!/usr/bin/env python3
"""Check the production Wrangler config of the released commit, read as DATA, before the credential job uses it.

The production deploy job holds Cloudflare credentials, so it must not run what platform/wrangler.toml can carry
(a build command, custom rules, arbitrary sections). The released commit is already on main and reviewed; this check
only makes the config fail closed on anything it has not been written for. A new key needs a change of this file in
the same reviewed pull request. It does NOT rewrite the config: Wrangler reads the same file the dry run read.

usage: check-production-config.py WRANGLER.toml
"""
import re
import sys

try:
    import tomllib
except ImportError:  # local runs on Python < 3.11
    import tomli as tomllib

TOP = {'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'ratelimits', 'assets', 'vars',
       'triggers', 'limits', 'observability', 'd1_databases', 'r2_buckets', 'env'}
PROD = {'name', 'workers_dev', 'routes', 'ratelimits', 'vars', 'assets', 'triggers', 'limits', 'observability',
        'd1_databases', 'r2_buckets'}
ASSET_KEYS = {'directory', 'binding', 'not_found_handling', 'html_handling', 'run_worker_first'}
WORKER = 'commonworld-api'
DATABASE = 'commonworld-prod'
DATABASE_ID = 'f61f88d5-f888-4b9f-8b1a-8f20a81d2ce5'   # the production database; a release cannot point the binding elsewhere
BUCKET = 'commonworld-backups'
ROUTES = {'commonworld.one', 'www.commonworld.one'}     # custom domains of the production Worker
RL_NAMESPACE = re.compile(r'^73\d\d$')                    # production rate-limit namespaces (staging 72xx, local 71xx)
PATTERN = re.compile(r'^[\x21-\x7e]{1,200}$')
MIG_DIR = re.compile(r'^[A-Za-z0-9_\-]{1,60}$')


class Bad(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Bad(msg)


def only(d, allowed, where):
    extra = sorted(set(d) - set(allowed))
    need(not extra, f'{where}: key(s) not allowed: {extra}')


def check(cfg):
    need(isinstance(cfg, dict), 'config is not a table')
    only(cfg, TOP, 'top level')
    env = cfg.get('env')
    need(isinstance(env, dict) and isinstance(env.get('production'), dict), 'no [env.production]')
    only(env, {'staging', 'production'}, 'env')
    prod = env['production']
    only(prod, PROD, 'env.production')
    need(prod.get('name') == WORKER, f'env.production.name must be {WORKER}')
    need(prod.get('workers_dev') is False, 'env.production.workers_dev must be false')
    for r in prod.get('routes', []):
        need(isinstance(r, dict) and set(r) <= {'pattern', 'custom_domain'}, 'env.production.routes: only pattern and custom_domain')
        need(isinstance(r.get('pattern'), str) and PATTERN.match(r['pattern']), 'env.production.routes: bad pattern')
        need(r['pattern'] in ROUTES and r.get('custom_domain') is True, 'env.production.routes: only the production custom domains')
    assets = prod.get('assets') or {}
    only(assets, ASSET_KEYS, 'env.production.assets')
    need(assets.get('directory') == './.atlas-dist', 'env.production.assets.directory must be ./.atlas-dist')
    dbs = prod.get('d1_databases') or []
    need(len(dbs) == 1 and isinstance(dbs[0], dict), 'env.production needs exactly one D1 database')
    only(dbs[0], {'binding', 'database_name', 'database_id', 'migrations_dir'}, 'env.production.d1_databases')
    need(dbs[0].get('database_name') == DATABASE, f'D1 database must be {DATABASE}')
    need(dbs[0].get('binding') == 'DB' and dbs[0].get('database_id') == DATABASE_ID, 'D1 binding must be DB on the production database id')
    need(MIG_DIR.match(str(dbs[0].get('migrations_dir', 'migrations'))), 'migrations_dir must be a plain folder name')
    for b in prod.get('r2_buckets') or []:
        only(b, {'binding', 'bucket_name'}, 'env.production.r2_buckets')
        need(b.get('bucket_name') == BUCKET, f'R2 bucket must be {BUCKET}')
    for r in prod.get('ratelimits') or []:
        only(r, {'name', 'namespace_id', 'simple'}, 'env.production.ratelimits')
        need(RL_NAMESPACE.match(str(r.get('namespace_id', ''))), 'env.production.ratelimits: namespace_id outside the production range')
    only(prod.get('observability') or {}, {'enabled', 'logs'}, 'env.production.observability')
    only(prod.get('limits') or {}, {'cpu_ms'}, 'env.production.limits')
    only(prod.get('triggers') or {}, {'crons'}, 'env.production.triggers')
    for k, v in (prod.get('vars') or {}).items():
        need(isinstance(v, str), f'env.production.vars.{k} must be a string')


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    try:
        with open(argv[1], 'rb') as fh:
            check(tomllib.load(fh))
    except Bad as e:
        print(f'::error::production config refused: {e}')
        return 1
    except (OSError, ValueError) as e:
        print(f'::error::production config unreadable: {e}')
        return 1
    print('production config: allowed keys only')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
