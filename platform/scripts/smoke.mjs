#!/usr/bin/env node
/**
 * Route smoke list runner: every entry of platform/smoke/routes.json against one base URL, read-only (GET/HEAD).
 *
 *   node platform/scripts/smoke.mjs https://staging.commonworld.one
 *   node platform/scripts/smoke.mjs https://commonworld.one --environment production --retries 0
 *   cd platform && npm run smoke -- http://localhost:8787 --environment development
 *
 * Options: --list <file> (default platform/smoke/routes.json), --environment <name> (expected /health environment;
 * default from the host: commonworld.one = production, staging.commonworld.one = staging), --retries <n> (extra tries
 * per failing check, default 2), --delay <ms> (between tries, default 10000), --only <id,id>, --validate (check the
 * list, no requests). Prints PASS / FAIL / SKIP per entry; exit 0 = all passed, 1 = a check failed, 2 = bad usage or
 * an invalid list. In GitHub Actions each failure is also an ::error annotation and the result goes to the job summary.
 * Node 22, no dependencies. See docs/DEPLOY.md, "Route smoke list after every deploy".
 */
import fs from 'node:fs';
import path from 'node:path';
import { discover, environmentFor, runEntry, validateList } from '../smoke/lib.mjs';

const usage = 'usage: smoke.mjs <BASE_URL> [--list file] [--environment name] [--retries n] [--delay ms] [--only id,id] | smoke.mjs --validate [--list file]';
const args = process.argv.slice(2);
const opt = { list: path.join(import.meta.dirname, '..', 'smoke', 'routes.json'), retries: 2, delay: 10_000 };
let base; let validateOnly = false; let only = null; let environment;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const val = () => { const v = args[++i]; if (v === undefined) { console.error(`${a} needs a value\n${usage}`); process.exit(2); } return v; };
  if (a === '--list') opt.list = val();
  else if (a === '--environment') environment = val();
  else if (a === '--retries') opt.retries = Number(val());
  else if (a === '--delay') opt.delay = Number(val());
  else if (a === '--only') only = new Set(val().split(','));
  else if (a === '--validate') validateOnly = true;
  else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
  else if (!a.startsWith('-') && base === undefined) base = a;
  else { console.error(`unknown argument ${a}\n${usage}`); process.exit(2); }
}
if (!Number.isInteger(opt.retries) || opt.retries < 0 || !Number.isFinite(opt.delay) || opt.delay < 0) { console.error(`--retries and --delay must be non-negative numbers\n${usage}`); process.exit(2); }

let list;
try { list = JSON.parse(fs.readFileSync(opt.list, 'utf8')); } catch (err) { console.error(`cannot read ${opt.list}: ${err.message}`); process.exit(2); }
const errors = validateList(list);
if (errors.length) { for (const e of errors) console.error(`invalid smoke list: ${e}`); process.exit(2); }
if (validateOnly) { console.log(`smoke list ok: ${list.checks.length} entries (${opt.list})`); process.exit(0); }

if (!base) { console.error(usage); process.exit(2); }
let baseUrl;
try { baseUrl = new URL(base); } catch { console.error(`not a URL: ${base}`); process.exit(2); }
if (!/^https?:$/.test(baseUrl.protocol) || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) { console.error(`BASE_URL must be an http(s) origin without path or query, got ${base}`); process.exit(2); }

const gha = process.env.GITHUB_ACTIONS === 'true';
const vars = { base: baseUrl.origin, environment: environment ?? environmentFor(baseUrl.origin) };
const ua = 'commonworld-smoke/1 (+https://github.com/commonworld-one/commonworld/blob/main/docs/DEPLOY.md)';
const runOpts = { retries: opt.retries, delayMs: opt.delay, userAgent: ua, signal: () => AbortSignal.timeout(15_000) };

const checks = list.checks.filter((e) => !only || only.has(e.id));
if (only && checks.length !== only.size) { console.error(`--only names unknown ids: ${[...only].filter((id) => !checks.some((e) => e.id === id)).join(', ')}`); process.exit(2); }
console.log(`smoke ${vars.base} (environment ${vars.environment ?? 'not set'}), ${checks.length} entries from ${path.relative(process.cwd(), opt.list) || opt.list}`);
if (checks.some((e) => !e.skip && /\{post\}/.test(JSON.stringify(e)))) {
  await discover(vars, fetch, runOpts);
  console.log(vars.post !== undefined ? `post for {post}: ${vars.post} (newest public post)` : `post discovery failed: ${vars.discoveryError}`);
}

const results = [];
for (const entry of checks) {
  const r = await runEntry(entry, vars, fetch, runOpts);
  results.push({ entry, ...r });
  console.log(r.line);
  if (gha && r.result === 'FAIL') console.log(`::error title=Route smoke ${entry.id} (${entry.added_by})::${r.line.replace(/\r?\n/g, ' ')}`);
}
const count = (k) => results.filter((r) => r.result === k).length;
const summary = `${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped (${vars.base})`;
console.log(summary);
if (gha && process.env.GITHUB_STEP_SUMMARY) {
  const esc = (s) => s.replace(/\|/g, '\\|');
  const rows = results.map((r) => `| ${r.result} | \`${esc(r.entry.id)}\` | ${r.entry.added_by} | ${esc(r.line.replace(/^\w+ \S+ /, ''))} |`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## Route smoke list: ${summary}`, '', '| Result | Check | Added by | Detail |', '|---|---|---|---|', ...rows, ''].join('\n'));
}
process.exit(count('FAIL') ? 1 : 0);
