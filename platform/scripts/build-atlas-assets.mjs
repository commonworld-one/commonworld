#!/usr/bin/env node
/**
 * Puts the Atlas build into platform/.atlas-dist, the Static Assets directory of env.staging / env.production
 * (routing option A3, src/atlas-assets.ts). One `wrangler deploy` then ships v1 and the Atlas together.
 *
 *   node scripts/build-atlas-assets.mjs [--src <cw-public checkout>] [--dist <ready atlas/site/dist>] [--build]
 *
 *   --src    cw-public checkout (default: $CW_PUBLIC_DIR, else the repository root, the parent of platform/)
 *   --dist   an already built dist directory (CI: the artifact of cw-public's CI job); default <src>/atlas/site/dist
 *   --build  run `python3 atlas/tools/catalogue_build.py --mode accepted` and `python3 atlas/site/check.py` in <src> first
 *
 * What it changes in the copy (never in cw-public): adds .assetsignore (drops the Pages-only _routes.json) and one
 * host-scoped _headers rule that keeps staging.commonworld.one static files out of search engines (it does nothing
 * on commonworld.one). Then it checks the Static Assets limits and that the Atlas CSP is there for the nonce step.
 * Prints no secrets; reads none.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasAtlasCsp } from './atlas-csp-check.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const v1 = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const src = path.resolve(opt('--src') ?? process.env.CW_PUBLIC_DIR ?? path.join(v1, '..'));
const dist = path.resolve(opt('--dist') ?? path.join(src, 'atlas', 'site', 'dist'));
const out = path.join(v1, '.atlas-dist');
const fail = (msg) => { console.error(`atlas:build: ${msg}`); process.exit(1); };

if (args.includes('--build')) {
  if (!fs.existsSync(path.join(src, 'atlas', 'site', 'build.py'))) fail(`no cw-public checkout at ${src}`);
  execFileSync('python3', ['atlas/tools/catalogue_build.py', '--mode', 'accepted'], { cwd: src, stdio: 'inherit' });
  execFileSync('python3', ['atlas/site/check.py'], { cwd: src, stdio: 'inherit' });
}
// A draft preview is intentionally not a deployable artifact. Guard before the
// fresh copy, including explicit --dist calls, so a local handoff cannot be
// mistaken for staging/production assets.
if (fs.existsSync(path.join(dist, 'atlas/data/local-preview-marker.json'))) fail('refusing local draft preview assets; prepare an accepted release build');
if (!fs.existsSync(path.join(dist, 'atlas', 'index.html'))) fail(`no Atlas build at ${dist} (run with --build, or build cw-public first)`);

// fresh copy
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(dist, out, { recursive: true });

// Pages-only files are not assets
fs.writeFileSync(path.join(out, '.assetsignore'), ['_routes.json', '.assetsignore', ''].join('\n'));

// closed staging: static files carry noindex too (Worker-served pages get it from PAGES_NOINDEX)
const headersPath = path.join(out, '_headers');
if (!fs.existsSync(headersPath)) fail('the build has no _headers (Atlas CSP and security headers live there)');
let headers = fs.readFileSync(headersPath, 'utf8');
headers = headers.replace(/\s*$/, '\n') + 'https://staging.commonworld.one/*\n  X-Robots-Tag: noindex, nofollow\n';
fs.writeFileSync(headersPath, headers);

// checks: Static Assets limits (100 header rules, 2,000 chars per line; 2,000 static redirects; 20,000 files on Free /
// 100,000 on Paid; 25 MiB per file) and the CSP the nonce step needs
const rules = headers.split('\n').filter((l) => l && !/^\s/.test(l) && !l.startsWith('#'));
if (rules.length > 100) fail(`_headers has ${rules.length} rules (max 100)`);
const long = headers.split('\n').find((l) => l.length > 2000);
if (long) fail(`_headers line longer than 2000 characters: ${long.slice(0, 80)}…`);
if (!hasAtlasCsp(headers)) fail("_headers /* has no Content-Security-Policy with script-src 'self' (the nonce step needs it)");
const redirects = fs.existsSync(path.join(out, '_redirects')) ? fs.readFileSync(path.join(out, '_redirects'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length : 0;
if (redirects > 2000) fail(`_redirects has ${redirects} rules (max 2000 static)`);
let files = 0; let bytes = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const size = fs.statSync(p).size;
    if (size > 25 * 1024 * 1024) fail(`${path.relative(out, p)} is over 25 MiB`);
    files++; bytes += size;
  }
};
walk(out);
if (files > 20000) console.warn(`atlas:build: ${files} files (> 20,000: needs Workers Paid, max 100,000)`);
for (const need of ['atlas/index.html', '404.html', 'privacy/index.html', 'terms/index.html', 'about/index.html', 'llms.txt', 'llms-full.txt']) {
  if (!fs.existsSync(path.join(out, need))) fail(`the build has no ${need}`);
}

let commit = '';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim(); } catch { /* --dist from an artifact */ }
console.log(`atlas:build: ${files} files, ${(bytes / 1048576).toFixed(1)} MB, ${rules.length} header rules, ${redirects} redirects -> ${path.relative(v1, out)}${commit ? ` (cw-public ${commit})` : ''}`);
