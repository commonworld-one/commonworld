/**
 * D1 backup inside Cloudflare (src/backup.ts): dump -> restore roundtrip into an empty D1, manifest + R2 objects,
 * restore check PASS / FAIL cases, cron dispatch, admin endpoints, no row contents in logs.
 */
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  BACKUP_CRON, BACKUP_FORMAT, MAX_BACKUP_AGE_HOURS, RESTORE_CHECK_CRON, backupStatus, compareWithManifest, dumpDatabase, envPrefix,
  gunzip, parseDump, qi, runBackup, runRestoreCheck, sha256Hex, sqlValue, type Manifest,
} from '../src/backup';
import { CLEANUP_CRON } from '../src/retention';
import { api, makeAdmin, post, register, resetDb } from './helpers';

const E = env as any;
const NOW = Date.parse('2026-10-19T03:00:00Z');
const TRICKY = "Line one\nline two with 'quotes' and \"double\"\r\n\ttab, emoji 🦀, backslash \\n, semicolon;\n-- not a comment";

async function clearBucket(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await E.BACKUPS.list({ cursor });
    if (page.objects.length) await E.BACKUPS.delete(page.objects.map((o: R2Object) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function wipeScratch(db: D1Database): Promise<void> {
  const objs = (await db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{ type: string; name: string }>()).results;
  const stmts = [db.prepare('PRAGMA defer_foreign_keys = true')];
  for (const o of objs.filter((x) => x.type === 'view' || x.type === 'trigger')) stmts.push(db.prepare(`DROP ${o.type.toUpperCase()} IF EXISTS ${qi(o.name)}`));
  for (const o of objs.filter((x) => x.type === 'table')) stmts.push(db.prepare(`DROP TABLE IF EXISTS ${qi(o.name)}`));
  await db.batch(stmts);
}

/** Restores a dump into an empty D1 the way a reader of the file would: schema, decoded rows (bound), sqlite_sequence, indexes. */
async function restoreInto(db: D1Database, sql: string): Promise<void> {
  const parsed = parseDump(sql);
  expect(parsed.problems).toEqual([]);
  const stmts: D1PreparedStatement[] = [db.prepare('PRAGMA defer_foreign_keys = true')];
  for (const s of parsed.schema.filter((x) => x.type === 'table')) stmts.push(db.prepare(s.sql));
  for (const [table, rows] of parsed.data) {
    for (const r of rows) stmts.push(db.prepare(`INSERT INTO ${qi(table)} (${r.columns.map(qi).join(',')}) VALUES(${r.columns.map(() => '?').join(',')})`).bind(...(r.values as unknown[])));
  }
  if (Object.keys(parsed.sqlite_sequence).length) {
    stmts.push(db.prepare('DELETE FROM sqlite_sequence'));
    for (const [n, v] of Object.entries(parsed.sqlite_sequence)) stmts.push(db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').bind(n, v));
  }
  for (const s of parsed.schema.filter((x) => x.type !== 'table')) stmts.push(db.prepare(s.sql));
  await db.batch(stmts);
}

async function snapshot(db: D1Database): Promise<Record<string, unknown[]>> {
  const tables = (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string; sql: string }>()).results;
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t.name] = (await db.prepare(`SELECT * FROM ${qi(t.name)} ORDER BY 1, 2`).raw()) as unknown[];
  out.__schema = (await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND sql IS NOT NULL ORDER BY type, name").all()).results;
  return out;
}

async function seed(): Promise<void> {
  const a = await register('backup-src');
  const b = await register('backup-two', 'human');
  expect((await post(a.key, 'Tricky body', { body: TRICKY })).status).toBe(201);
  const p2 = await post(b.key, 'Second post');
  expect(p2.status).toBe(201);
  expect((await api(`/v1/posts/${p2.body.number}/comments`, { key: a.key, body: { body: `reply ${TRICKY}` } })).status).toBe(201);
  expect((await api(`/v1/posts/${p2.body.number}/upvote`, { key: a.key, method: 'POST' })).status).toBe(201);
}

beforeEach(async () => { await resetDb(); await clearBucket(); await wipeScratch(E.RESTORE_DB); });
afterEach(() => vi.restoreAllMocks());

describe('value encoding', () => {
  it('writes every value as one line of valid SQLite and parses it back exactly', async () => {
    const values = [null, 0, -7, 3.25, 1e21, Number.MAX_SAFE_INTEGER, '', "it's", TRICKY, '\u0000nul\u0007bell', 'ünïcødé 🦀', new Uint8Array([0, 1, 254, 255]), [222, 173]];
    const line = `INSERT INTO "t" (${values.map((_, i) => `"c${i}"`).join(',')}) VALUES(${values.map(sqlValue).join(',')});`;
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    const sql = `-- Commonworld D1 backup, format ${BACKUP_FORMAT}\n-- cw:table t\nCREATE TABLE t (x);\n-- cw:data t 1\n${line}\n-- cw:end 1\n`;
    const parsed = parseDump(sql);
    expect(parsed.problems).toEqual([]);
    const got = parsed.data.get('t')![0].values;
    expect(got.slice(0, 11)).toEqual(values.slice(0, 11));
    expect(Array.from(got[11] as Uint8Array)).toEqual([0, 1, 254, 255]);
    expect(Array.from(got[12] as Uint8Array)).toEqual([222, 173]);
    // SQLite itself reads the same values back
    const back = await E.RESTORE_DB.prepare(`SELECT ${values.slice(0, 11).map(sqlValue).join(',')}`).raw();
    expect(back[0]).toEqual(values.slice(0, 11));
  });

  it('flags a truncated file, a broken row and a count mismatch', () => {
    const ok = `-- Commonworld D1 backup, format ${BACKUP_FORMAT}\n-- cw:table t\nCREATE TABLE t (x);\n-- cw:data t 2\nINSERT INTO "t" ("x") VALUES(1);\nINSERT INTO "t" ("x") VALUES('a');\n-- cw:end 2\n`;
    expect(parseDump(ok).problems).toEqual([]);
    expect(parseDump(ok.replace('-- cw:end 2\n', '')).problems).toContain('no end marker (truncated file)');
    expect(parseDump(ok.replace("VALUES('a')", "VALUES('a)")).problems.join()).toMatch(/unparsable row statement at line 6/);
    expect(parseDump(ok.replace('("x") VALUES(1)', '("x") VALUES(1,2)')).problems.join()).toMatch(/column\/value count mismatch/);
    const m = { format: BACKUP_FORMAT, tables: { t: 3 }, sqlite_sequence: {}, total_rows: 3 };
    expect(compareWithManifest(parseDump(ok), m).join('; ')).toMatch(/t: manifest 3 rows, dump 2/);
  });
});

describe('dump -> restore roundtrip', () => {
  it('restores every table, row, schema object and sqlite_sequence counter into an empty D1', async () => {
    await seed();
    const dump = await dumpDatabase(E.DB, { createdUtc: '2026-10-19T03:00:00Z', envName: 'local' });
    expect(dump.table_count).toBeGreaterThan(25);
    expect(dump.tables.d1_migrations).toBeGreaterThan(0);
    expect(dump.last_migration).not.toBeNull();
    expect(dump.tables.posts).toBe(2);
    expect(dump.sql.split('\n').filter((l) => l.startsWith('INSERT INTO "posts"'))).toHaveLength(2);
    expect(Object.keys(dump.tables).some((t) => t.startsWith('_cf_') || t.startsWith('sqlite_'))).toBe(false);
    await restoreInto(E.RESTORE_DB, dump.sql);
    expect(await snapshot(E.RESTORE_DB)).toEqual(await snapshot(E.DB));
    // the restored DB is a working copy: the tricky body survived byte for byte
    expect((await E.RESTORE_DB.prepare("SELECT body FROM posts WHERE title = 'Tricky body'").first()).body).toBe(TRICKY);
  });

  it('paging gives the same file as one page', async () => {
    await seed();
    const one = await dumpDatabase(E.DB);
    const paged = await dumpDatabase(E.DB, { pageRows: 2 });
    expect(paged.sql).toBe(one.sql);
    expect(paged.tables).toEqual(one.tables);
  });
});

describe('runBackup -> R2 + manifest', () => {
  it('writes <env>/d1/YYYY-MM-DDTHHMMSSZ.sql.gz and a manifest with counts and both sha256', async () => {
    await seed();
    expect(envPrefix(E)).toBe('local');
    expect(envPrefix({ ENVIRONMENT: 'production' })).toBe('prod');
    expect(envPrefix({ ENVIRONMENT: 'staging' })).toBe('staging');
    const r = await runBackup(E, NOW);
    expect(r.key).toBe('local/d1/2026-10-19T030000Z.sql.gz');
    expect(r.manifest_key).toBe('local/d1/2026-10-19T030000Z.manifest.json');
    const gz = await (await E.BACKUPS.get(r.key)).arrayBuffer();
    const m: Manifest = await (await E.BACKUPS.get(r.manifest_key)).json();
    expect(m.format).toBe(BACKUP_FORMAT);
    expect(m.created_utc).toBe('2026-10-19T03:00:00Z');
    expect(m.env).toBe('local');
    expect(m.artifact).toMatchObject({ file: '2026-10-19T030000Z.sql.gz', key: r.key, bytes: gz.byteLength, gzip: true, encrypted: false });
    expect(m.artifact.sha256).toBe(await sha256Hex(gz));
    const plain = await gunzip(gz);
    expect(m.sql_sha256).toBe(await sha256Hex(plain));
    expect(m.sql_bytes).toBe(plain.byteLength);
    expect(m.tables.posts).toBe(2);
    expect(m.total_rows).toBe(Object.values(m.tables).reduce((a, b) => a + b, 0));
    const live = await E.DB.prepare('SELECT count(*) AS n FROM accounts').first();
    expect(m.tables.accounts).toBe(live.n);
    expect(m.sqlite_sequence).toEqual(Object.fromEntries((await E.DB.prepare('SELECT name, seq FROM sqlite_sequence').all()).results.map((x: any) => [x.name, x.seq])));
    expect(new TextDecoder().decode(plain)).toContain(`format ${BACKUP_FORMAT}, env local, created 2026-10-19T03:00:00Z`);
  });

  it('never logs row contents', async () => {
    await seed();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { logs.push(a.join(' ')); });
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron: BACKUP_CRON }), E, ctx);
    await waitOnExecutionContext(ctx);
    const ctx2 = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW + 3_600_000, cron: RESTORE_CHECK_CRON }), E, ctx2);
    await waitOnExecutionContext(ctx2);
    const all = logs.join('\n');
    expect(all).toMatch(/d1 backup OK local\/d1\/2026-10-19T030000Z\.sql\.gz/);
    expect(all).toMatch(/d1 restore check PASS/);
    for (const secret of ['Line one', 'backup-src', 'Tricky body', 'quotes']) expect(all).not.toContain(secret);
  });
});

describe('runRestoreCheck', () => {
  it('PASS on a fresh backup; result written to <env>/checks/', async () => {
    await seed();
    await runBackup(E, NOW);
    const r = await runRestoreCheck(E, NOW + 90 * 60_000);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.age_hours).toBe(1.5);
    expect(r.backup_key).toBe('local/d1/2026-10-19T030000Z.sql.gz');
    expect(r.check_key).toBe('local/checks/2026-10-19.json');
    expect(await (await E.BACKUPS.get(r.check_key)).json()).toMatchObject({ ok: true, backup_key: r.backup_key });
  });

  it('takes the newest backup', async () => {
    await runBackup(E, NOW - 2 * 86_400_000);
    await seed();
    await runBackup(E, NOW);
    const r = await runRestoreCheck(E, NOW + 60_000);
    expect(r.ok).toBe(true);
    expect(r.backup_key).toBe('local/d1/2026-10-19T030000Z.sql.gz');
  });

  it('FAIL: no backup, stale backup, corrupted artifact, manifest/dump mismatch', async () => {
    const none = await runRestoreCheck(E, NOW);
    expect(none.ok).toBe(false);
    expect(none.problems.join()).toMatch(/no backup found under local\/d1\//);

    await seed();
    const b = await runBackup(E, NOW);
    const stale = await runRestoreCheck(E, NOW + (MAX_BACKUP_AGE_HOURS + 4) * 3_600_000);
    expect(stale.ok).toBe(false);
    expect(stale.problems.join()).toMatch(/newest backup is 40 h old/);

    const m: Manifest = await (await E.BACKUPS.get(b.manifest_key)).json();
    await E.BACKUPS.put(b.manifest_key, JSON.stringify({ ...m, tables: { ...m.tables, posts: 3 }, total_rows: m.total_rows + 1 }));
    const counts = await runRestoreCheck(E, NOW + 60_000);
    expect(counts.ok).toBe(false);
    expect(counts.problems).toContain('posts: manifest 3 rows, dump 2');

    await E.BACKUPS.put(b.manifest_key, JSON.stringify(m));
    await E.BACKUPS.put(b.key, new Uint8Array([1, 2, 3]));
    const corrupt = await runRestoreCheck(E, NOW + 60_000);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.problems.join()).toMatch(/sha256 does not match/);
  });

  it('FAIL without reading: manifest whose artifact key points outside <env>/d1/', async () => {
    await seed();
    const b = await runBackup(E, NOW);
    const m: Manifest = await (await E.BACKUPS.get(b.manifest_key)).json();
    for (const key of ['prod/d1/2026-10-19.sql.gz', 'local/checks/x.sql.gz', 'local/d1/../../prod/d1/x.sql.gz', 42]) {
      await E.BACKUPS.put(b.manifest_key, JSON.stringify({ ...m, artifact: { ...m.artifact, key } }));
      const getSpy = vi.spyOn(E.BACKUPS, 'get');
      const r = await runRestoreCheck(E, NOW + 60_000);
      const gotKeys = getSpy.mock.calls.map((c) => c[0]);
      getSpy.mockRestore();
      expect(gotKeys).not.toContain(key); // the forbidden artifact is never loaded
      expect(gotKeys.every((k) => typeof k === 'string' && k.endsWith('.json'))).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.backup_key).toBeNull();
      expect(r.problems.join()).toMatch(/points outside local\/d1\//);
    }
  });
});

describe('cron dispatch', () => {
  async function fire(cron: string, at = NOW): Promise<void> {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: at, cron }), E, ctx);
    await waitOnExecutionContext(ctx);
  }
  const keys = async () => ((await E.BACKUPS.list()).objects as R2Object[]).map((o) => o.key).sort();

  it('03:00 UTC backs up, Sunday 04:30 UTC checks, the other crons do neither', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await fire(CLEANUP_CRON);
    expect(await keys()).toEqual([]);
    await fire(BACKUP_CRON);
    expect(await keys()).toEqual(['local/d1/2026-10-19T030000Z.manifest.json', 'local/d1/2026-10-19T030000Z.sql.gz']);
    await fire(RESTORE_CHECK_CRON, NOW + 90 * 60_000);
    expect(await keys()).toContain('local/checks/2026-10-19.json');
  });

  it('a failed check is a console.error line', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    await fire(RESTORE_CHECK_CRON);
    expect(errors.join('\n')).toMatch(/^d1 restore check FAIL backup=none .*no backup found/m);
  });
});

describe('GET /v1/admin/backups, POST /v1/admin/backups/run', () => {
  it('admin only', async () => {
    const citizen = await register();
    expect((await api('/v1/admin/backups')).status).toBe(401);
    expect((await api('/v1/admin/backups', { key: citizen.key })).status).toBe(403);
    expect((await api('/v1/admin/backups/run', { key: citizen.key, body: { job: 'backup' } })).status).toBe(403);
  });

  it('runs both jobs and reports healthy', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const admin = await makeAdmin();
    const before = await api('/v1/admin/backups', { key: admin.key });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ environment: 'local', healthy: false, backups: [], latest_check: null });
    expect(before.body.problems).toEqual(['no backup yet', 'no restore check yet']);
    expect((await api('/v1/admin/backups/run', { key: admin.key, body: { job: 'nope' } })).body.error.code).toBe('invalid_job');
    const run = await api('/v1/admin/backups/run', { key: admin.key, body: { job: 'backup' } });
    expect(run.status).toBe(200);
    expect(run.body.backup.key).toMatch(/^local\/d1\/\d{4}-\d{2}-\d{2}T\d{6}Z\.sql\.gz$/);
    const check = await api('/v1/admin/backups/run', { key: admin.key, body: { job: 'restore-check' } });
    expect(check.body).toMatchObject({ job: 'restore-check', ok: true, backup: null });
    const after = await api('/v1/admin/backups', { key: admin.key });
    expect(after.body.healthy).toBe(true);
    expect(after.body.backups[0]).toMatchObject({ key: run.body.backup.key, total_rows: run.body.backup.total_rows, sha256: run.body.backup.sha256 });
    expect(after.body.latest_check.ok).toBe(true);
    const status = await backupStatus(E, Date.now() + 48 * 3_600_000);
    expect(status.healthy).toBe(false);
    expect(status.problems).toEqual(['newest backup older than 36 h']);
    const noWeekly = await backupStatus(E, Date.now() + 9 * 86_400_000);
    expect(noWeekly.problems).toContain('latest restore check older than 8 days');
    // timestamps from the future (or a forged checked_at like 2099) never count as fresh
    const future = await backupStatus(E, Date.now() - 86_400_000);
    expect(future.healthy).toBe(false);
    expect(future.problems).toEqual(['newest backup has a future or invalid timestamp', 'latest restore check has a future or invalid timestamp']);
  });
});

describe('keyset paging and run names', () => {
  const seedMany = async (n: number) => {
    await E.DB.exec("CREATE TABLE IF NOT EXISTS kv_nr (a TEXT NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID");
    await E.DB.exec('DELETE FROM kv_nr');
    const stmts = [];
    for (let i = 0; i < n; i++) stmts.push(E.DB.prepare('INSERT INTO kv_nr (a, b, v) VALUES (?, ?, ?)').bind(`g${i % 3}`, i, `v${i}`));
    await E.DB.batch(stmts);
  };

  it('small pages give the same file as one page, with a WITHOUT ROWID composite key', async () => {
    await seed();
    await seedMany(23);
    const one = await dumpDatabase(E.DB, { pageRows: 100000 });
    const paged = await dumpDatabase(E.DB, { pageRows: 5 });
    expect(paged.sql).toBe(one.sql);
    expect(paged.paging.kv_nr).toMatchObject({ mode: 'keyset', key: ['a', 'b'], rows: 23, count_after: 23, changed_during_dump: false });
    expect(paged.paging.kv_nr.pages).toBe(5);
    expect(one.paging).toEqual({});
  });

  it('keyset queries never use OFFSET after the first page', async () => {
    await seedMany(12);
    const sqls: string[] = [];
    const orig = E.DB.prepare.bind(E.DB);
    const spy = vi.spyOn(E.DB, 'prepare').mockImplementation(((q: string) => { sqls.push(q); return orig(q); }) as any);
    await dumpDatabase(E.DB, { pageRows: 4 });
    spy.mockRestore();
    expect(sqls.some((q) => /OFFSET/.test(q))).toBe(false);
    expect(sqls.some((q) => /WHERE \("a","b"\) > \(\?,\?\)/.test(q))).toBe(true);
  });

  it('rows inserted during the dump are not duplicated; a changed count is flagged', async () => {
    await seedMany(12);
    const orig = E.DB.batch.bind(E.DB);
    let calls = 0;
    const spy = vi.spyOn(E.DB, 'batch').mockImplementation((async (stmts: any[]) => {
      if (++calls === 2) await E.DB.prepare("INSERT INTO kv_nr (a, b, v) VALUES ('g0', 1000, 'late')").run();
      return orig(stmts);
    }) as any);
    const d = await dumpDatabase(E.DB, { pageRows: 4 });
    spy.mockRestore();
    const ins = d.sql.split('\n').filter((l) => l.startsWith('INSERT INTO "kv_nr"'));
    expect(new Set(ins).size).toBe(ins.length);
    expect(d.paging.kv_nr.changed_during_dump).toBe(d.paging.kv_nr.rows !== 13);
    expect(d.paging.kv_nr.count_after).toBe(13);
  });

  it('every run gets its own name; a same-second rerun gets -2; old daily names stay readable and sort first', async () => {
    await seed();
    const a = await runBackup(E, NOW);
    const b = await runBackup(E, NOW);
    const c = await runBackup(E, NOW + 3_600_000);
    expect(a.key).toBe('local/d1/2026-10-19T030000Z.sql.gz');
    expect(b.key).toBe('local/d1/2026-10-19T030000Z-2.sql.gz');
    expect(c.key).toBe('local/d1/2026-10-19T040000Z.sql.gz');
    expect(await E.BACKUPS.head(a.key)).not.toBeNull();
    const m: Manifest = await (await E.BACKUPS.get(a.manifest_key)).json();
    expect(m.consistency?.note).toMatch(/NOT a point-in-time snapshot/);
    expect(m.consistency?.paged_tables).toEqual({});
    const r = await runRestoreCheck(E, NOW + 2 * 3_600_000);
    expect(r.backup_key).toBe(c.key);
  });

  it('a manifest and key in the old daily format (no consistency field) still pass the check and the status', async () => {
    await seed();
    const b = await runBackup(E, NOW);
    const m: Manifest = await (await E.BACKUPS.get(b.manifest_key)).json();
    const { consistency, ...old } = m as any;
    const oldKey = 'local/d1/2026-10-19.sql.gz';
    await E.BACKUPS.put(oldKey, await (await E.BACKUPS.get(b.key)).arrayBuffer());
    await E.BACKUPS.put('local/d1/2026-10-19.manifest.json', JSON.stringify({ ...old, artifact: { ...old.artifact, key: oldKey, file: '2026-10-19.sql.gz' } }));
    await E.BACKUPS.delete(b.key); await E.BACKUPS.delete(b.manifest_key);
    const r = await runRestoreCheck(E, NOW + 60_000);
    expect(r.problems).toEqual([]);
    expect(r.backup_key).toBe(oldKey);
    expect((await backupStatus(E, NOW + 60_000)).backups[0].key).toBe(oldKey);
  });

  it('parallel runs in the same second each get their own name and none overwrites another', async () => {
    await seed();
    const runs = await Promise.all(Array.from({ length: 12 }, () => runBackup(E, NOW)));
    const keys = runs.map((r) => r.key);
    expect(new Set(keys).size).toBe(12);
    expect(new Set(runs.map((r) => r.manifest_key)).size).toBe(12);
    for (const r of runs) {
      const m: Manifest = await (await E.BACKUPS.get(r.manifest_key)).json();
      expect(m.artifact.key).toBe(r.key);
      expect(m.artifact.sha256).toBe(r.sha256);
      expect(await sha256Hex(await (await E.BACKUPS.get(r.key)).arrayBuffer())).toBe(r.sha256);
    }
  });

  it('never overwrites an existing object: a taken name is skipped, and a full name space fails the run', async () => {
    await seed();
    await E.BACKUPS.put('local/d1/2026-10-19T030000Z.sql.gz', 'precious');
    const r = await runBackup(E, NOW);
    expect(r.key).toBe('local/d1/2026-10-19T030000Z-2.sql.gz');
    expect(await (await E.BACKUPS.get('local/d1/2026-10-19T030000Z.sql.gz')).text()).toBe('precious');
    await E.BACKUPS.put('local/d1/2026-10-19T030000Z-3.manifest.json', 'orphan manifest');
    const r2 = await runBackup(E, NOW);
    expect(r2.key).toBe('local/d1/2026-10-19T030000Z-4.sql.gz');
    expect(await E.BACKUPS.head('local/d1/2026-10-19T030000Z-3.sql.gz')).toBeNull(); // our dump was given back
    expect(await (await E.BACKUPS.get('local/d1/2026-10-19T030000Z-3.manifest.json')).text()).toBe('orphan manifest');
    for (let n = 2; n <= 50; n++) await E.BACKUPS.put(`local/d1/2026-10-19T030000Z-${n}.sql.gz`, 'x');
    await expect(runBackup(E, NOW)).rejects.toThrow(/no free backup name/);
  });

  it('12 same-second runs: status and restore check pick the newest by number (-12 after -2), over older daily and older stamps', async () => {
    await seed();
    await runBackup(E, NOW - 86_400_000);
    for (let i = 0; i < 12; i++) await runBackup(E, NOW);
    await E.BACKUPS.put('local/d1/2026-10-19.sql.gz', 'old daily', {});
    const status = await backupStatus(E, NOW + 60_000);
    expect(status.backups[0].key).toBe('local/d1/2026-10-19T030000Z-12.sql.gz');
    expect(status.backups.slice(0, 3).map((b) => b.key)).toEqual([
      'local/d1/2026-10-19T030000Z-12.sql.gz', 'local/d1/2026-10-19T030000Z-11.sql.gz', 'local/d1/2026-10-19T030000Z-10.sql.gz']);
    const r = await runRestoreCheck(E, NOW + 60_000);
    expect(r.ok).toBe(true);
    expect(r.backup_key).toBe('local/d1/2026-10-19T030000Z-12.sql.gz');
  });
});
