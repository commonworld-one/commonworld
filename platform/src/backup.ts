/**
 * Daily D1 backup + weekly restore check, inside Cloudflare (Cron Triggers + R2). Replaces the GitHub Actions draft
 * (ops/d1-backup.yml, retired 2026-10-19). Runbook: docs/ops/BACKUP-RESTORE.md.
 *
 *   BACKUP_CRON        03:00 UTC daily  runBackup(): every D1 table (schema from sqlite_master + all rows, paged) as one
 *                                       SQL file, gzipped, to R2 `<env>/d1/YYYY-MM-DDTHHMMSSZ.sql.gz` + `...manifest.json`
 *                                       (one name per run; older `YYYY-MM-DD.*` objects stay readable)
 *                                       (row count per table, sqlite_sequence counters, last migration, sha256 of the
 *                                       artifact and of the plain SQL). Same manifest format as scripts/d1-backup.sh, so
 *                                       scripts/d1-restore.sh restores a Worker backup unchanged.
 *   RESTORE_CHECK_CRON Mon 04:30 UTC    runRestoreCheck(): newest backup -> sha256 (gz + SQL) -> full parse of every
 *                                       statement (each INSERT decoded to its values, column count checked) -> table
 *                                       list, row counts, sqlite_sequence vs manifest -> age <= 36 h. Result to
 *                                       `<env>/checks/YYYY-MM-DD.json` + one log line (console.error on FAIL).
 *   GET  /v1/admin/backups              admin: newest backups + the newest check + healthy flag.
 *   POST /v1/admin/backups/run          admin: run one job now ({"job": "backup" | "restore-check"}).
 *
 * One R2 bucket per environment (binding BACKUPS; owner decision 2026-10-20), so the staging Worker physically cannot read
 * or overwrite production backups: production -> `commonworld-backups`, staging -> `commonworld-backups-staging`, local
 * (tests, wrangler dev) -> `commonworld-backups-local` (simulated). Keys stay prefixed per environment (prod/, staging/,
 * local/) as defence in depth, and backupTarget() refuses to touch the bucket when ENVIRONMENT, BACKUPS_BUCKET (the
 * bucket name, a wrangler.toml var next to the binding) and the key prefix do not match BACKUP_TARGETS (fail closed).
 * Retention is each bucket's lifecycle rule (objects deleted after 35 days).
 * Never logs row contents: logs carry keys, counts, sizes and hashes only.
 *
 * Dump format (valid SQLite, loadable by `sqlite3` / python executescript): marker comments `-- cw:<kind> <name>` start
 * each block; schema blocks hold one statement each (may span lines), `-- cw:data <table>` and `-- cw:seq` blocks hold
 * one single-line INSERT per row (control characters are written as `'..'||char(10)||'..'`, so a row never spans lines);
 * `-- cw:end <total rows>` closes the file (a truncated file has no end marker).
 */
import type { Env } from './env';

export const BACKUP_CRON = '0 3 * * *';
export const RESTORE_CHECK_CRON = '30 4 * * 1';
export const BACKUP_FORMAT = 'commonworld-d1-backup/1';
/** Rows per SELECT page. The first page of every table is read in one D1 batch (one transaction = one consistent snapshot). */
export const PAGE_ROWS = 5000;
/** A newest backup older than this fails the restore check (the daily job stopped). */
export const MAX_BACKUP_AGE_HOURS = 36;
/** The Monday check runs weekly; one missed run plus a day of slack before status turns unhealthy. */
export const MAX_CHECK_AGE_DAYS = 8;
/** A backup or restore-check timestamp may run ahead of `now` by at most this much (clock skew); later = unhealthy. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SKIP_PREFIXES = ['sqlite_', '_cf_'];
/** Written into every manifest next to the per-table paging facts. States what the dump does and does not guarantee. */
export const CONSISTENCY_NOTE =
  'Tables of at most page_rows rows and sqlite_sequence are read in one D1 batch (one transaction). A larger table is read in several '
  + 'calls at different moments, by key, not by row offset: rows that are not inserted, updated, deleted or re-keyed during the dump appear '
  + 'exactly once, but this is NOT a point-in-time snapshot. Rows changed during the dump may show an older or newer value, and rows '
  + 'inserted or deleted during it may be present or absent. count_after is a count taken after the last page; a difference from rows '
  + 'proves the table changed during the dump, equality does not prove it did not (updates are not counted).';

type Value = null | number | string | bigint | boolean | ArrayBuffer | Uint8Array | number[];
type Row = Record<string, unknown>;

export interface DumpCounts {
  tables: Record<string, number>;
  sqlite_sequence: Record<string, number>;
  last_migration: { id: number; name: string } | null;
  table_count: number;
  total_rows: number;
}
export type PagingMode = 'keyset' | 'offset';
/** How one multi-page table was read. `offset` is the old behaviour, kept only as a flagged fallback. */
export interface PagingInfo {
  mode: PagingMode;
  /** 'rowid' or the primary key columns used for ordering and for the page cursor; null = no usable order (unordered) */
  key: 'rowid' | string[] | null;
  pages: number;
  rows: number;
  /** COUNT(*) taken after the last page; null when it could not be read */
  count_after: number | null;
  /** count_after differs from rows: the table changed while it was being dumped */
  changed_during_dump: boolean;
  fallback_reason?: string;
}
export interface Dump extends DumpCounts { sql: string; paging: Record<string, PagingInfo>; single_batch_tables: number }

export interface Manifest extends DumpCounts {
  format: string;
  created_utc: string;
  db: string | null;
  env: string | null;
  /** worker-cron (the Worker: cron or admin run) or whoever else wrote it with the same code */
  source: string;
  sql_sha256: string;
  sql_bytes: number;
  duration_ms: number;
  /** Absent in manifests written before 2026-11-21. */
  consistency?: { page_rows: number; single_batch_tables: number; paged_tables: Record<string, PagingInfo>; note: string };
  artifact: { file: string; key: string; bytes: number; sha256: string; gzip: boolean; encrypted: false; age_recipient: null };
}

export interface CheckResult {
  ok: boolean;
  checked_at: string;
  backup_key: string | null;
  backup_created_utc: string | null;
  age_hours: number | null;
  table_count: number | null;
  total_rows: number | null;
  problems: string[];
  /** Informational, never a failure: e.g. tables that changed while the backup was being read. */
  notes?: string[];
}

// ---------- environment ----------

/** R2 key prefix per environment: production -> prod, staging -> staging, anything else -> local. */
export function envPrefix(env: Pick<Env, 'ENVIRONMENT'>): string {
  if (env.ENVIRONMENT === 'production') return 'prod';
  if (env.ENVIRONMENT === 'staging') return 'staging';
  return 'local';
}
const DB_NAMES: Record<string, string> = { prod: 'commonworld-prod', staging: 'commonworld-staging', local: 'commonworld-dev' };

/**
 * The only allowed (bucket, key prefix) pair per environment. wrangler.toml binds BACKUPS to exactly this bucket in each
 * environment and sets BACKUPS_BUCKET to the same name (test/backup-target.test.ts checks both against this table).
 */
export const BACKUP_TARGETS = {
  production: { bucket: 'commonworld-backups', prefix: 'prod' },
  staging: { bucket: 'commonworld-backups-staging', prefix: 'staging' },
  local: { bucket: 'commonworld-backups-local', prefix: 'local' },
} as const;
export const PRODUCTION_BACKUP_BUCKET = BACKUP_TARGETS.production.bucket;

export class BackupTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'BackupTargetError'; }
}

/**
 * Problems with one (environment, bucket name, key prefix) triple; empty = allowed. ENVIRONMENT must be exactly
 * production, staging or local; an unset or unknown value is refused. Only production may use the production bucket or
 * the prod/ prefix.
 */
export function backupTargetProblems(environment: string | undefined, bucketName: string | undefined, prefix: string): string[] {
  if (environment !== 'production' && environment !== 'staging' && environment !== 'local') {
    return [`ENVIRONMENT ${environment === undefined ? '(unset)' : JSON.stringify(environment)} is not one of production, staging, local`];
  }
  const name = environment;
  const want = BACKUP_TARGETS[name];
  const problems: string[] = [];
  if (!bucketName) problems.push('BACKUPS_BUCKET is not set');
  else if (bucketName !== want.bucket) problems.push(`bucket ${bucketName} is not the ${name} backup bucket ${want.bucket}`);
  if (prefix !== want.prefix) problems.push(`key prefix ${prefix}/ is not the ${name} prefix ${want.prefix}/`);
  if (name !== 'production' && (bucketName === PRODUCTION_BACKUP_BUCKET || prefix === BACKUP_TARGETS.production.prefix)) {
    problems.push(`environment ${environment ?? '(unset)'} must never touch the production backups`);
  }
  return problems;
}

/**
 * The bucket + key prefix this Worker may use, or a BackupTargetError (and one console.error line) when ENVIRONMENT,
 * BACKUPS_BUCKET and the prefix do not match BACKUP_TARGETS. Every job calls this before its first R2 call, so a
 * mismatched configuration reads and writes nothing (fail closed). `prefix` defaults to envPrefix(env).
 */
export function backupTarget(env: Env, prefix: string = envPrefix(env)): { r2: R2Bucket; bucket: string; prefix: string } {
  const problems = backupTargetProblems(env.ENVIRONMENT, env.BACKUPS_BUCKET, prefix);
  if (problems.length) {
    const message = `backup target mismatch (env=${env.ENVIRONMENT ?? '(unset)'} bucket=${env.BACKUPS_BUCKET ?? '(unset)'} prefix=${prefix}/): ${problems.join('; ')}`;
    console.error(`d1 backup REFUSED ${message}`);
    throw new BackupTargetError(message);
  }
  if (!env.BACKUPS) throw new Error('BACKUPS R2 binding missing (wrangler.toml r2_buckets)');
  return { r2: env.BACKUPS, bucket: env.BACKUPS_BUCKET!, prefix };
}

// ---------- SQL text ----------

export const qi = (name: string) => '"' + name.replace(/"/g, '""') + '"';

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** A string as a single-line SQLite expression: control characters become char(n) joined with ||. */
function sqlString(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x08\x0a-\x1f]/.test(s)) return "'" + s.replace(/'/g, "''") + "'";
  const parts: string[] = [];
  let buf = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 && code !== 0x09) {
      if (buf) parts.push("'" + buf.replace(/'/g, "''") + "'");
      buf = '';
      parts.push(`char(${code})`);
    } else buf += ch;
  }
  if (buf) parts.push("'" + buf.replace(/'/g, "''") + "'");
  return parts.join('||');
}

export function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NULL';
    if (!Number.isFinite(v)) return v > 0 ? '9e999' : '-9e999';
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (typeof v === 'string') return sqlString(v);
  if (v instanceof ArrayBuffer) return `X'${hex(new Uint8Array(v))}'`;
  if (ArrayBuffer.isView(v)) return `X'${hex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))}'`;
  if (Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return `X'${hex(Uint8Array.from(v as number[]))}'`;
  throw new Error(`unsupported value type ${typeof v}`);
}

const skip = (name: string) => SKIP_PREFIXES.some((p) => name.startsWith(p));
const RID = '__cw_rowid';
const withoutRowid = (sql: string) => /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(sql);

// ---------- dump ----------

interface MasterRow { type: string; name: string; tbl_name: string; sql: string }

/**
 * Reads every user table (schema + rows) of `db`. Read-only. Pages of PAGE_ROWS; at current size every table fits in
 * the first page, and all first pages are one D1 batch, i.e. one transaction: a consistent snapshot.
 */
export async function dumpDatabase(db: D1Database, opts: { pageRows?: number; createdUtc?: string; envName?: string } = {}): Promise<Dump> {
  const pageRows = opts.pageRows ?? PAGE_ROWS;
  const master = (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all<MasterRow>()).results;
  const tables = master.filter((m) => m.type === 'table' && !skip(m.name));
  const others = master.filter((m) => m.type !== 'table' && !skip(m.name) && !skip(m.tbl_name));
  const hasSeq = master.some((m) => m.type === 'table' && m.name === 'sqlite_sequence');

  const rows = new Map<string, Row[]>(tables.map((t) => [t.name, []]));
  let seq: { name: string; seq: number }[] = [];

  // Page order per table. rowid tables: rowid. WITHOUT ROWID tables: the primary key columns (PRAGMA table_info, pk order).
  // A table with no usable key order (no primary key, or a column called rowid) is still read, by OFFSET, and flagged.
  interface Plan { keyCols: string[] | 'rowid' | null; reason?: string; orderBy: string }
  const plans = new Map<string, Plan>();
  for (const t of tables) {
    const info = (await db.prepare(`PRAGMA table_info(${qi(t.name)})`).all<{ name: string; pk: number }>()).results;
    if (!withoutRowid(t.sql)) {
      const clash = info.some((c) => c.name.toLowerCase() === 'rowid');
      plans.set(t.name, clash ? { keyCols: null, reason: 'a column is named rowid', orderBy: ' ORDER BY rowid' } : { keyCols: 'rowid', orderBy: ' ORDER BY rowid' });
    } else {
      const pk = info.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name);
      plans.set(t.name, pk.length ? { keyCols: pk, orderBy: ` ORDER BY ${pk.map(qi).join(',')}` } : { keyCols: null, reason: 'no primary key found', orderBy: '' });
    }
  }
  const pageCount = new Map<string, number>(tables.map((t) => [t.name, 0]));
  const offsetFallback = new Map<string, string>();
  const keyOf = (name: string, row: Row): Value[] | null => {
    const plan = plans.get(name)!;
    const cols = plan.keyCols;
    if (cols === null) return null;
    const vals = cols === 'rowid' ? [row[RID]] : cols.map((c) => row[c]);
    // only strings and exactly representable numbers survive a bind round trip unchanged
    return vals.every((v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)))) ? (vals as Value[]) : null;
  };
  const lastKey = new Map<string, Value[]>();
  let pending = tables.map((t) => t.name);
  let first = true;
  while (pending.length) {
    const stmts = pending.map((name) => {
      const plan = plans.get(name)!;
      if (first) return db.prepare(`SELECT *${plan.keyCols === 'rowid' ? `, rowid AS ${RID}` : ''} FROM ${qi(name)}${plan.orderBy} LIMIT ?`).bind(pageRows);
      if (offsetFallback.has(name) || plan.keyCols === null) {
        return db.prepare(`SELECT * FROM ${qi(name)}${plan.orderBy} LIMIT ? OFFSET ?`).bind(pageRows, rows.get(name)!.length);
      }
      const k = lastKey.get(name)!;
      if (plan.keyCols === 'rowid') return db.prepare(`SELECT *, rowid AS ${RID} FROM ${qi(name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).bind(k[0], pageRows);
      const cols = `(${plan.keyCols.map(qi).join(',')})`;
      return db.prepare(`SELECT * FROM ${qi(name)} WHERE ${cols} > (${plan.keyCols.map(() => '?').join(',')})${plan.orderBy} LIMIT ?`).bind(...k, pageRows);
    });
    if (first && hasSeq) stmts.push(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name'));
    const results = await db.batch<Row>(stmts);
    if (first && hasSeq) seq = (results.pop()!.results as unknown as { name: string; seq: number }[]);
    const next: string[] = [];
    pending.forEach((name, i) => {
      const page = results[i].results;
      pageCount.set(name, pageCount.get(name)! + 1);
      const plan = plans.get(name)!;
      if (page.length === pageRows && plan.keyCols !== null && !offsetFallback.has(name)) {
        const cursor = keyOf(name, page[page.length - 1]);
        if (cursor) lastKey.set(name, cursor);
        else offsetFallback.set(name, 'a key value cannot be used as a cursor');
      }
      if (plan.keyCols === 'rowid') for (const r of page) delete r[RID];
      rows.get(name)!.push(...page);
      if (page.length === pageRows) next.push(name);
    });
    pending = next;
    first = false;
  }

  // Tables that needed more than one read: count them again after the last page (informational, see CONSISTENCY_NOTE).
  const multi = tables.map((t) => t.name).filter((n) => pageCount.get(n)! > 1);
  const after = new Map<string, number | null>();
  if (multi.length) {
    try {
      const res = await db.batch<{ n: number }>(multi.map((n) => db.prepare(`SELECT count(*) AS n FROM ${qi(n)}`)));
      multi.forEach((n, i) => after.set(n, Number(res[i].results[0]?.n)));
    } catch { multi.forEach((n) => after.set(n, null)); }
  }
  const paging: Record<string, PagingInfo> = {};
  for (const n of multi) {
    const plan = plans.get(n)!;
    const reason = offsetFallback.get(n) ?? plan.reason;
    const count = after.get(n) ?? null;
    paging[n] = {
      mode: reason ? 'offset' : 'keyset', key: reason ? null : plan.keyCols, pages: pageCount.get(n)!, rows: rows.get(n)!.length,
      count_after: count, changed_during_dump: count !== null && count !== rows.get(n)!.length,
      ...(reason ? { fallback_reason: reason } : {}),
    };
  }

  const out: string[] = [];
  out.push(`-- Commonworld D1 backup, format ${BACKUP_FORMAT}${opts.envName ? `, env ${opts.envName}` : ''}${opts.createdUtc ? `, created ${opts.createdUtc}` : ''}`);
  out.push('-- Restore only into a new, empty database: scripts/d1-restore.sh <this file> <target> (docs/ops/BACKUP-RESTORE.md).');
  out.push('PRAGMA defer_foreign_keys = true;');
  for (const t of tables) out.push(`-- cw:table ${t.name}`, t.sql.replace(/;?\s*$/, ';'));
  const counts: Record<string, number> = {};
  let total = 0;
  for (const t of tables) {
    const list = rows.get(t.name)!;
    counts[t.name] = list.length;
    total += list.length;
    out.push(`-- cw:data ${t.name} ${list.length}`);
    for (const row of list) {
      const cols = Object.keys(row);
      out.push(`INSERT INTO ${qi(t.name)} (${cols.map(qi).join(',')}) VALUES(${cols.map((c) => sqlValue(row[c])).join(',')});`);
    }
  }
  const seqMap: Record<string, number> = {};
  if (hasSeq) {
    out.push(`-- cw:seq ${seq.length}`, 'DELETE FROM sqlite_sequence;');
    for (const s of seq) {
      seqMap[s.name] = Number(s.seq);
      out.push(`INSERT INTO "sqlite_sequence" ("name","seq") VALUES(${sqlValue(s.name)},${sqlValue(Number(s.seq))});`);
    }
  }
  for (const o of others) out.push(`-- cw:${o.type} ${o.name}`, o.sql.replace(/;?\s*$/, ';'));
  out.push(`-- cw:end ${total}`);

  let last: DumpCounts['last_migration'] = null;
  const mig = rows.get('d1_migrations');
  if (mig?.length) {
    const top = mig.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    last = { id: Number(top.id), name: String(top.name) };
  }
  return { sql: out.join('\n') + '\n', tables: counts, sqlite_sequence: seqMap, last_migration: last, table_count: tables.length, total_rows: total, paging, single_batch_tables: tables.length - multi.length };
}

// ---------- parse (restore check) ----------

export interface ParsedDump {
  format: string | null;
  schema: { type: string; name: string; sql: string }[];
  /** table -> decoded rows (column names + values) */
  data: Map<string, { columns: string[]; values: Value[] }[]>;
  declared: Record<string, number>;
  sqlite_sequence: Record<string, number>;
  end_total: number | null;
  problems: string[];
}

/** Decodes one VALUES(...) tuple written by sqlValue(). Returns null when it is not exactly that grammar. */
function parseTuple(s: string, at: number): { values: Value[]; end: number } | null {
  const values: Value[] = [];
  let i = at;
  const strLit = (): string | null => {
    if (s[i] !== "'") return null;
    let out = '';
    i++;
    for (;;) {
      const j = s.indexOf("'", i);
      if (j < 0) return null;
      out += s.slice(i, j);
      if (s[j + 1] === "'") { out += "'"; i = j + 2; } else { i = j + 1; return out; }
    }
  };
  for (;;) {
    let v: Value;
    if (s.startsWith('NULL', i)) { v = null; i += 4; }
    else if (s[i] === 'X' && s[i + 1] === "'") {
      const j = s.indexOf("'", i + 2);
      if (j < 0) return null;
      const h = s.slice(i + 2, j);
      if (h.length % 2 || /[^0-9a-f]/.test(h)) return null;
      v = Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
      i = j + 1;
    } else if (s[i] === "'" || s.startsWith('char(', i)) {
      let str = '';
      for (;;) {
        if (s[i] === "'") { const lit = strLit(); if (lit === null) return null; str += lit; }
        else if (s.startsWith('char(', i)) {
          const m = /^char\((\d{1,3})\)/.exec(s.slice(i, i + 10));
          if (!m) return null;
          str += String.fromCharCode(Number(m[1]));
          i += m[0].length;
        } else return null;
        if (s.startsWith('||', i)) i += 2; else break;
      }
      v = str;
    } else {
      const m = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i, i + 40));
      if (!m) return null;
      v = Number(m[0]);
      i += m[0].length;
    }
    values.push(v);
    if (s[i] === ',') { i++; continue; }
    if (s[i] === ')') return { values, end: i + 1 };
    return null;
  }
}

const INSERT_RE = /^INSERT INTO ((?:"[^"]*(?:""[^"]*)*")) \(([^)]*)\) VALUES\(/;
const unq = (q: string) => q.slice(1, -1).replace(/""/g, '"');

/** Parses a dump written by dumpDatabase(). Every row statement is decoded; anything unexpected becomes a problem. */
export function parseDump(sql: string): ParsedDump {
  const p: ParsedDump = { format: null, schema: [], data: new Map(), declared: {}, sqlite_sequence: {}, end_total: null, problems: [] };
  const lines = sql.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const fm = /format (\S+?),?(?:\s|$)/.exec(lines[0] ?? '');
  p.format = fm ? fm[1] : null;
  let kind = '';
  let name = '';
  let buf: string[] = [];
  const flush = () => {
    if (kind && kind !== 'data' && kind !== 'seq' && kind !== 'end') p.schema.push({ type: kind, name, sql: buf.join('\n') });
    buf = [];
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const marker = /^-- cw:(\w+) ?(.*)$/.exec(line);
    if (marker) {
      flush();
      kind = marker[1];
      const rest = marker[2];
      if (kind === 'data') {
        const m = /^(.*) (\d+)$/.exec(rest);
        if (!m) { p.problems.push(`bad data marker at line ${n + 1}`); name = rest; continue; }
        name = m[1];
        p.declared[name] = Number(m[2]);
        if (!p.data.has(name)) p.data.set(name, []);
      } else if (kind === 'end') {
        p.end_total = Number(rest);
        if (n !== lines.length - 1) p.problems.push('content after the end marker');
      } else name = rest;
      continue;
    }
    if (!kind) continue; // header comments + PRAGMA
    if (kind === 'data' || kind === 'seq') {
      if (kind === 'seq' && line === 'DELETE FROM sqlite_sequence;') continue;
      const m = INSERT_RE.exec(line);
      const table = m ? unq(m[1]) : null;
      const tuple = m ? parseTuple(line, m[0].length) : null;
      if (!m || !tuple || line.slice(tuple.end) !== ';') { p.problems.push(`unparsable row statement at line ${n + 1}`); continue; }
      const columns = m[2].split(',').map((c) => unq(c.trim()));
      if (columns.length !== tuple.values.length) { p.problems.push(`column/value count mismatch at line ${n + 1}`); continue; }
      if (kind === 'seq') {
        if (table !== 'sqlite_sequence') { p.problems.push(`unexpected statement in sqlite_sequence block at line ${n + 1}`); continue; }
        p.sqlite_sequence[String(tuple.values[0])] = Number(tuple.values[1]);
      } else {
        if (table !== name) { p.problems.push(`row for ${table} inside the ${name} block at line ${n + 1}`); continue; }
        p.data.get(name)!.push({ columns, values: tuple.values });
      }
    } else buf.push(line);
  }
  flush();
  if (p.end_total === null) p.problems.push('no end marker (truncated file)');
  return p;
}

/** Compares a parsed dump with its manifest. Returns the list of problems (empty = PASS). */
export function compareWithManifest(parsed: ParsedDump, manifest: Pick<Manifest, 'tables' | 'sqlite_sequence' | 'total_rows' | 'format'>): string[] {
  const problems = [...parsed.problems];
  if (parsed.format !== manifest.format) problems.push(`format ${parsed.format} != manifest ${manifest.format}`);
  const schemaTables = parsed.schema.filter((s) => s.type === 'table').map((s) => s.name).sort();
  const want = Object.keys(manifest.tables).sort();
  const missing = want.filter((t) => !schemaTables.includes(t));
  const extra = schemaTables.filter((t) => !want.includes(t));
  if (missing.length) problems.push(`tables missing from the dump: ${missing.join(', ')}`);
  if (extra.length) problems.push(`tables not in the manifest: ${extra.join(', ')}`);
  let total = 0;
  for (const t of want) {
    const got = parsed.data.get(t)?.length ?? 0;
    total += got;
    if (got !== manifest.tables[t]) problems.push(`${t}: manifest ${manifest.tables[t]} rows, dump ${got}`);
    if (parsed.declared[t] !== undefined && parsed.declared[t] !== got) problems.push(`${t}: block declares ${parsed.declared[t]} rows, holds ${got}`);
  }
  if (total !== manifest.total_rows) problems.push(`total rows: manifest ${manifest.total_rows}, dump ${total}`);
  if (parsed.end_total !== null && parsed.end_total !== total) problems.push(`end marker says ${parsed.end_total} rows, dump holds ${total}`);
  const seqKeys = new Set([...Object.keys(manifest.sqlite_sequence), ...Object.keys(parsed.sqlite_sequence)]);
  for (const k of seqKeys) if (manifest.sqlite_sequence[k] !== parsed.sqlite_sequence[k]) problems.push(`sqlite_sequence ${k}: manifest ${manifest.sqlite_sequence[k]}, dump ${parsed.sqlite_sequence[k]}`);
  return problems;
}

// ---------- bytes ----------

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}
export async function gzip(data: Uint8Array): Promise<ArrayBuffer> {
  return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
export async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Run name: `2026-11-21T030010Z`. One per run, so a second run on the same day never replaces the cron copy. */
const runStamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
/** Object name without its extension: sorts old `YYYY-MM-DD` before new `YYYY-MM-DDTHHMMSSZ` before `...Z-2` (plain key order would put `-2.` before `.`). */
const stem = (key: string) => key.replace(/\.(sql\.gz|manifest\.json)$/, '');
const byStem = (a: string, b: string) => (stem(a) < stem(b) ? -1 : stem(a) > stem(b) ? 1 : 0);

// ---------- jobs ----------

export interface BackupResult { key: string; manifest_key: string; bytes: number; sql_bytes: number; sha256: string; table_count: number; total_rows: number; duration_ms: number }

export async function runBackup(env: Env, now: number = Date.now(), source = 'worker-cron', keyPrefix?: string): Promise<BackupResult> {
  const t0 = Date.now();
  const { r2, prefix } = backupTarget(env, keyPrefix);
  const created = isoSeconds(now);
  const dump = await dumpDatabase(env.DB, { createdUtc: created, envName: prefix });
  const plain = new TextEncoder().encode(dump.sql);
  const gz = await gzip(plain);
  const [sqlSha, gzSha] = await Promise.all([sha256Hex(plain), sha256Hex(gz)]);
  let name = runStamp(now);
  for (let n = 2; n < 100 && ((await r2.head(`${prefix}/d1/${name}.sql.gz`)) || (await r2.head(`${prefix}/d1/${name}.manifest.json`))); n++) name = `${runStamp(now)}-${n}`;
  const file = `${name}.sql.gz`;
  const key = `${prefix}/d1/${file}`;
  const manifestKey = `${prefix}/d1/${name}.manifest.json`;
  const manifest: Manifest = {
    format: BACKUP_FORMAT, created_utc: created, db: DB_NAMES[prefix] ?? null, env: prefix, source,
    last_migration: dump.last_migration, table_count: dump.table_count, total_rows: dump.total_rows, tables: dump.tables,
    sqlite_sequence: dump.sqlite_sequence, sql_sha256: sqlSha, sql_bytes: plain.byteLength, duration_ms: 0,
    consistency: { page_rows: PAGE_ROWS, single_batch_tables: dump.single_batch_tables, paged_tables: dump.paging, note: CONSISTENCY_NOTE },
    artifact: { file, key, bytes: gz.byteLength, sha256: gzSha, gzip: true, encrypted: false, age_recipient: null },
  };
  await r2.put(key, gz, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { sha256: gzSha, created_utc: created, total_rows: String(dump.total_rows), table_count: String(dump.table_count) },
  });
  manifest.duration_ms = Date.now() - t0;
  await r2.put(manifestKey, JSON.stringify(manifest, null, 2) + '\n', { httpMetadata: { contentType: 'application/json' } });
  return { key, manifest_key: manifestKey, bytes: gz.byteLength, sql_bytes: plain.byteLength, sha256: gzSha, table_count: dump.table_count, total_rows: dump.total_rows, duration_ms: manifest.duration_ms };
}

async function listAll(r2: R2Bucket, prefix: string, include?: ('customMetadata' | 'httpMetadata')[]): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await r2.list({ prefix, cursor, include });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export async function runRestoreCheck(env: Env, now: number = Date.now(), keyPrefix?: string): Promise<CheckResult & { check_key: string }> {
  const { r2, prefix } = backupTarget(env, keyPrefix);
  const result: CheckResult = { ok: false, checked_at: isoSeconds(now), backup_key: null, backup_created_utc: null, age_hours: null, table_count: null, total_rows: null, problems: [] };
  try {
    const manifests = (await listAll(r2, `${prefix}/d1/`)).map((o) => o.key).filter((k) => k.endsWith('.manifest.json')).sort(byStem);
    const latest = manifests[manifests.length - 1];
    if (!latest) throw new Error(`no backup found under ${prefix}/d1/`);
    const mObj = await r2.get(latest);
    if (!mObj) throw new Error(`manifest ${latest} vanished`);
    const manifest = await mObj.json<Manifest>();
    const artifactKey = manifest?.artifact?.key;
    if (typeof artifactKey !== 'string' || !artifactKey.startsWith(`${prefix}/d1/`) || artifactKey.includes('..')) {
      throw new Error(`manifest ${latest} points outside ${prefix}/d1/ (artifact key ${JSON.stringify(artifactKey)})`);
    }
    result.backup_key = manifest.artifact.key;
    result.backup_created_utc = manifest.created_utc;
    result.table_count = manifest.table_count;
    result.total_rows = manifest.total_rows;
    result.age_hours = Math.round(((now - Date.parse(manifest.created_utc)) / 3_600_000) * 10) / 10;
    if (!(result.age_hours <= MAX_BACKUP_AGE_HOURS)) result.problems.push(`newest backup is ${result.age_hours} h old (limit ${MAX_BACKUP_AGE_HOURS} h)`);
    const aObj = await r2.get(manifest.artifact.key);
    if (!aObj) throw new Error(`artifact ${manifest.artifact.key} missing`);
    const gz = await aObj.arrayBuffer();
    if (gz.byteLength !== manifest.artifact.bytes) result.problems.push(`artifact size ${gz.byteLength} != manifest ${manifest.artifact.bytes}`);
    if ((await sha256Hex(gz)) !== manifest.artifact.sha256) throw new Error('artifact sha256 does not match the manifest');
    const plain = await gunzip(gz);
    if ((await sha256Hex(plain)) !== manifest.sql_sha256) throw new Error('decompressed SQL sha256 does not match the manifest');
    result.problems.push(...compareWithManifest(parseDump(new TextDecoder().decode(plain)), manifest));
    const changed = Object.entries(manifest.consistency?.paged_tables ?? {}).filter(([, v]) => v?.changed_during_dump).map(([k]) => k);
    if (changed.length) result.notes = [`tables that changed while this backup was read (not a point-in-time snapshot): ${changed.join(', ')}`];
  } catch (error) {
    result.problems.push(error instanceof Error ? error.message : String(error));
  }
  result.ok = result.problems.length === 0;
  const checkKey = `${prefix}/checks/${day(now)}.json`;
  await r2.put(checkKey, JSON.stringify(result, null, 2) + '\n', { httpMetadata: { contentType: 'application/json' } });
  return { ...result, check_key: checkKey };
}

/** One log line per job: console.log on success, console.error on failure (Workers Logs keep both). Counts only. */
export function logBackup(r: BackupResult): void {
  console.log(`d1 backup OK ${r.key} ${r.bytes} B gz (${r.sql_bytes} B sql), ${r.table_count} tables, ${r.total_rows} rows, ${r.duration_ms} ms, sha256 ${r.sha256}`);
}
export function logCheck(r: CheckResult & { check_key: string }): void {
  const line = `d1 restore check ${r.ok ? 'PASS' : 'FAIL'} backup=${r.backup_key ?? 'none'} age_h=${r.age_hours ?? 'n/a'} tables=${r.table_count ?? 'n/a'} rows=${r.total_rows ?? 'n/a'} result=${r.check_key}${r.ok ? '' : ` problems: ${r.problems.join('; ')}`}`;
  if (r.ok) console.log(line); else console.error(line);
}

// ---------- status (admin) ----------

export interface BackupStatus {
  environment: string;
  bucket: string;
  healthy: boolean;
  problems: string[];
  backups: { key: string; bytes: number; uploaded: string; created_utc: string | null; total_rows: number | null; table_count: number | null; sha256: string | null }[];
  latest_check: CheckResult | null;
}

export async function backupStatus(env: Env, now: number = Date.now(), limit = 14): Promise<BackupStatus> {
  const { r2, bucket, prefix } = backupTarget(env);
  const objects = (await listAll(r2, `${prefix}/d1/`, ['customMetadata'])).filter((o) => o.key.endsWith('.sql.gz')).sort((a, b) => byStem(b.key, a.key));
  const backups = objects.slice(0, limit).map((o) => ({
    key: o.key, bytes: o.size, uploaded: o.uploaded.toISOString(),
    created_utc: o.customMetadata?.created_utc ?? null,
    total_rows: o.customMetadata?.total_rows ? Number(o.customMetadata.total_rows) : null,
    table_count: o.customMetadata?.table_count ? Number(o.customMetadata.table_count) : null,
    sha256: o.customMetadata?.sha256 ?? null,
  }));
  const checks = (await listAll(r2, `${prefix}/checks/`)).map((o) => o.key).sort();
  let latestCheck: CheckResult | null = null;
  if (checks.length) {
    const obj = await r2.get(checks[checks.length - 1]);
    latestCheck = obj ? await obj.json<CheckResult>() : null;
  }
  const problems: string[] = [];
  const newest = backups[0];
  const newestAt = newest ? Date.parse(newest.created_utc ?? newest.uploaded) : NaN;
  if (!newest) problems.push('no backup yet');
  else if (!(newestAt - now <= MAX_CLOCK_SKEW_MS)) problems.push('newest backup has a future or invalid timestamp');
  else if (now - newestAt > MAX_BACKUP_AGE_HOURS * 3_600_000) problems.push(`newest backup older than ${MAX_BACKUP_AGE_HOURS} h`);
  if (!latestCheck) problems.push('no restore check yet');
  else if (!latestCheck.ok) problems.push('latest restore check FAILED');
  else {
    const checkedAt = Date.parse(latestCheck.checked_at);
    if (!(checkedAt - now <= MAX_CLOCK_SKEW_MS)) problems.push('latest restore check has a future or invalid timestamp');
    else if (!(now - checkedAt <= MAX_CHECK_AGE_DAYS * 86_400_000)) problems.push(`latest restore check older than ${MAX_CHECK_AGE_DAYS} days`);
  }
  return { environment: prefix, bucket, healthy: problems.length === 0, problems, backups, latest_check: latestCheck };
}
