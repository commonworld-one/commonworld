#!/usr/bin/env node
// Cross-platform runner for local sample-data seed (Issue #151).
// Works portably across Windows (cmd.exe / PowerShell), macOS, and Linux without shell-specific mkdir or python3 assumptions.
// 1. Detects an available Python 3.10+ interpreter (checks $PYTHON, then python3/python, or python/py -3/python3 on Windows).
// 2. Safely creates .local directory via fs.mkdirSync(..., { recursive: true }).
// 3. Runs scripts/seed_from_mockups.py, validating exit status before touching .local/seed.sql.
// 4. Executes wrangler d1 execute commonworld-dev --local --file .local/seed.sql.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformDir = path.resolve(__dirname, '..');
const localDir = path.join(platformDir, '.local');
const seedSqlPath = path.join(localDir, 'seed.sql');
const generatorScript = path.join(platformDir, 'scripts', 'seed_from_mockups.py');

// Python is spawned WITHOUT a shell on every platform: python.exe and py.exe are real executables, and with
// `shell: true` Node joins the arguments unquoted, so cmd.exe would split the `-c` program and read `>=` as a
// redirect (every candidate would fail the version check). No shell also keeps a $PYTHON path with spaces intact.
// Each candidate is [command, ...leading args]; `py -3` asks the Windows launcher for a Python 3.
const VERSION_CHECK = 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)';

function findPython() {
  const isWindows = process.platform === 'win32';
  const candidates = [
    ...(process.env.PYTHON ? [[process.env.PYTHON]] : []),
    ...(isWindows ? [['python'], ['py', '-3'], ['python3']] : [['python3'], ['python']])
  ];

  for (const [cmd, ...args] of candidates) {
    const check = spawnSync(cmd, [...args, '-c', VERSION_CHECK], { stdio: 'ignore' });
    if (!check.error && check.status === 0) {
      return { cmd, args };
    }
  }
  return null;
}

const python = findPython();
if (!python) {
  console.error('Error: No Python 3.10+ interpreter found (tried $PYTHON, python3, python, py -3).');
  console.error('Please ensure Python 3 is installed and added to PATH, or specify its location via the PYTHON environment variable.');
  process.exit(1);
}
const pythonLabel = [python.cmd, ...python.args].join(' ');

// Generate the SQL content. Paths are relative to platform/ (the cwd), exactly as in the old npm script.
// PYTHONIOENCODING=utf-8: the SQL contains non-ASCII text, and Python on Windows would otherwise encode a piped
// stdout in the ANSI code page. stdout is kept as raw bytes and written unchanged.
console.log(`[seed:local] Generating seed SQL using ${pythonLabel}...`);
const genResult = spawnSync(python.cmd, [...python.args, 'scripts/seed_from_mockups.py'], {
  cwd: platformDir,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024
});

if (genResult.error || genResult.status !== 0) {
  const why = genResult.error ? genResult.error.message : genResult.signal ? `signal ${genResult.signal}` : `exit code ${genResult.status}`;
  console.error(`[seed:local] Python generator failed (${why}); .local/seed.sql was not written.`);
  process.exit(genResult.status || 1);
}

// Write the output file only after successful generation
mkdirSync(localDir, { recursive: true });
writeFileSync(seedSqlPath, genResult.stdout);
console.log(`[seed:local] Written ${genResult.stdout.length} bytes to ${path.relative(platformDir, seedSqlPath)}`);

// Execute Wrangler: the project's own devDependency (pinned in package-lock.json), run through Node itself, so no
// shell and no wrangler.cmd / npx.cmd are involved on Windows. Without `npm ci`, fall back to a wrangler on PATH,
// as the old `npm run seed:local` did. Never `npx --yes wrangler`: that would download an unpinned version.
const wranglerArgs = ['d1', 'execute', 'commonworld-dev', '--local', '--file', '.local/seed.sql'];

function localWranglerBin() {
  try {
    const pkgPath = createRequire(path.join(platformDir, 'package.json')).resolve('wrangler/package.json');
    const bin = JSON.parse(readFileSync(pkgPath, 'utf-8')).bin;
    const rel = typeof bin === 'string' ? bin : bin && bin.wrangler;
    return rel ? path.join(path.dirname(pkgPath), rel) : null;
  } catch {
    return null;
  }
}

console.log('[seed:local] Executing SQL via Wrangler D1...');
const localBin = localWranglerBin();
const wranglerResult = localBin
  ? spawnSync(process.execPath, [localBin, ...wranglerArgs], { cwd: platformDir, stdio: 'inherit' })
  // fixed arguments only (no user input), so the Windows shell needed for wrangler.cmd is safe here
  : spawnSync('wrangler', wranglerArgs, { cwd: platformDir, stdio: 'inherit', shell: process.platform === 'win32' });

if (wranglerResult.error || wranglerResult.status !== 0) {
  const why = wranglerResult.error
    ? (wranglerResult.error.code === 'ENOENT' ? 'wrangler not found; run `npm ci` in platform/' : wranglerResult.error.message)
    : wranglerResult.signal ? `signal ${wranglerResult.signal}` : `exit code ${wranglerResult.status}`;
  console.error(`[seed:local] wrangler d1 execute failed (${why}).`);
  process.exit(wranglerResult.status || 1);
}
