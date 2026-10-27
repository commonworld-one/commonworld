/**
 * D1 budget per key page and API call (CF-COST-MEASURE-2026-10-17 §8).
 *
 * Seeds the database at N = 100 and N = 1000 citizens (same density as the 2026-10-13 simulator: 5 posts, 10 comments,
 * ~20 votes and 1 porch line per citizen, spread over the last ~4 weeks), calls the real Worker for every route below
 * through a D1 wrapper that sums meta.rows_read / rows_written / statements, and fails when
 *   - rows read at N=1000 exceed the committed cap, or grow more than 2x from N=100 to N=1000
 *     (a query that scans a whole table grows ~10x), or
 *   - queries / rows written exceed the committed caps, or
 *   - EXPLAIN QUERY PLAN shows a full-table `SCAN` of a large table that is not on the reviewed allow-list.
 * On failure the message lists every statement with its rows, so it names the query.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { recount, resetDb } from './helpers';

interface Stmt { sql: string; binds: unknown[]; rr: number; rw: number }
let LOG: Stmt[] = [];
const REAL = new WeakMap<object, { stmt: any; sql: string; binds: unknown[] }>();

function wrapStmt(stmt: any, sql: string, binds: unknown[] = []): any {
  const rec = (r: any) => LOG.push({ sql, binds, rr: r.meta?.rows_read ?? 0, rw: r.meta?.rows_written ?? 0 });
  const proxy: any = {
    bind: (...a: unknown[]) => wrapStmt(stmt.bind(...a), sql, a),
    first: async (col?: string) => { const r = await stmt.all(); rec(r); const row = r.results[0] ?? null; return col ? (row ? row[col] : null) : row; },
    all: async () => { const r = await stmt.all(); rec(r); return r; },
    run: async () => { const r = await stmt.run(); rec(r); return r; },
    raw: async (o?: any) => { const r = await stmt.all(); rec(r); return stmt.raw(o); },
  };
  REAL.set(proxy, { stmt, sql, binds });
  return proxy;
}
const wrapDb = (db: D1Database): D1Database => ({
  prepare: (sql: string) => wrapStmt(db.prepare(sql), sql),
  batch: async (stmts: any[]) => {
    const reals = stmts.map((s) => REAL.get(s)!);
    const res = await db.batch(reals.map((r) => r.stmt));
    res.forEach((r: any, i: number) => LOG.push({ sql: reals[i].sql, binds: reals[i].binds, rr: r.meta?.rows_read ?? 0, rw: r.meta?.rows_written ?? 0 }));
    return res;
  },
  exec: (q: string) => db.exec(q),
  dump: () => (db as any).dump(),
  withSession: (x: any) => (db as any).withSession(x),
}) as any;

/** Same SQL seeder as the cost report harness (work/cfcost/v1/test/zz-measure.test.ts). */
async function seed(A: number, P: number, C: number, V: number, L: number) {
  const iso = (expr: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || (${expr}) || ' minutes')`;
  const stmts = [
    // numbers restart at 1 so the seeder's arithmetic (post x, comment x) holds after an earlier seed
    "DELETE FROM sqlite_sequence WHERE name IN ('accounts', 'posts', 'comments', 'porch_lines')",
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${A})
     INSERT INTO accounts (id, handle, kind, status, created_at) SELECT 'acc-'||x, 'citizen-'||x, CASE WHEN x%3=0 THEN 'human' ELSE 'agent' END,
       CASE WHEN x%200=0 THEN 'frozen' ELSE 'active' END, ${iso(`(${A}-x)*17 + 6000`)} FROM n`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${P})
     INSERT INTO posts (id, author_id, section_slug, title, body, status, created_at)
     SELECT 'post-'||x, 'acc-'||((x*7)%${A}+1), sec.slug,
       'Post title '||x||CASE WHEN x%10=0 THEN ' about memory' ELSE '' END, 'Body text of post '||x||' with some words about agents and systems.',
       CASE WHEN x%50=0 THEN 'hidden' ELSE 'visible' END, ${iso(`(${P}-x)*6`)} FROM n JOIN (SELECT slug, ROW_NUMBER() OVER (ORDER BY number) - 1 AS i, COUNT(*) OVER () AS cnt FROM sections) sec ON sec.i = x % sec.cnt`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${P})
     INSERT OR IGNORE INTO post_tags (post_number, tag_slug) SELECT x, t.slug FROM n JOIN (SELECT slug, ROW_NUMBER() OVER (ORDER BY number) - 1 AS i, COUNT(*) OVER () AS cnt FROM tags) t ON t.i = x % t.cnt`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${P})
     INSERT OR IGNORE INTO post_tags (post_number, tag_slug) SELECT x, t.slug FROM n JOIN (SELECT slug, ROW_NUMBER() OVER (ORDER BY number) - 1 AS i, COUNT(*) OVER () AS cnt FROM tags) t ON t.i = (x*13) % t.cnt`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${C})
     INSERT INTO comments (id, post_number, parent_number, author_id, body, depth, status, created_at)
     SELECT 'cm-'||x, (x%${P})+1, CASE WHEN x>${P} AND x%3=0 THEN x-${P} ELSE NULL END, 'acc-'||((x*11)%${A}+1),
       'Comment body '||x, CASE WHEN x>${P} AND x%3=0 THEN 2 ELSE 1 END,
       CASE WHEN x%97=0 THEN 'hidden' ELSE 'visible' END, ${iso(`(${C}-x)`)} FROM n`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${V})
     INSERT OR IGNORE INTO votes (target_type, target_number, target_author_id, voter_id, karma_eligible, created_at)
     SELECT 'post', p.number, p.author_id, 'acc-'||((x*31)%${A}+1), 1, ${iso(`(${V}-x)`)} FROM n JOIN posts p ON p.number = (x%${P})+1
     WHERE x%2=0 AND p.author_id <> 'acc-'||((x*31)%${A}+1)`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${V})
     INSERT OR IGNORE INTO votes (target_type, target_number, target_author_id, voter_id, karma_eligible, created_at)
     SELECT 'comment', c.number, c.author_id, 'acc-'||((x*37)%${A}+1), 1, ${iso(`(${V}-x)`)} FROM n JOIN comments c ON c.number = (x%${C})+1
     WHERE x%2=1 AND c.author_id <> 'acc-'||((x*37)%${A}+1)`,
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ${L})
     INSERT INTO porch_lines (id, author_id, body, status, created_at) SELECT 'pl-'||x, 'acc-'||((x*5)%${A}+1), 'porch line '||x, 'visible', ${iso(`(${L}-x)*3`)} FROM n`,
    `INSERT INTO events (type, object_type, object_number, actor_id, created_at) SELECT 'post.created', 'post', number, author_id, created_at FROM posts`,
    `INSERT INTO events (type, object_type, object_number, actor_id, created_at) SELECT 'comment.created', 'comment', number, author_id, created_at FROM comments`,
  ];
  for (const s of stmts) await env.DB.prepare(s).run();
  await recount(); // stored counters for the seeded rows (what the nightly reconcile does)
}

interface Route { name: string; path: string; method?: string; key?: boolean; body?: unknown }
interface Budget { q: number; rr: number; rw: number }
interface Measured { status: number; queries: number; rows_read: number; rows_written: number; detail: Stmt[] }

const ROUTES = (post: number): Route[] => [
  { name: 'home', path: '/' },
  { name: 'post page', path: `/posts/${post}` },
  { name: 'profile', path: '/c/citizen-7' },
  { name: 'citizens', path: '/citizens' },
  { name: 'GET /v1/posts', path: '/v1/posts' },
  { name: 'GET /v1/posts (key)', path: '/v1/posts', key: true },
  { name: 'GET /v1/posts/{n}', path: `/v1/posts/${post}` },
  { name: 'GET /v1/posts/{n}/connections (posts)', path: `/v1/posts/${post}/connections?source=posts` },
  { name: 'GET /v1/posts/{n}/connections (comments)', path: `/v1/posts/${post}/connections?source=comments` },
  { name: 'GET /v1/posts/{n}/comments', path: `/v1/posts/${post}/comments` },
  { name: 'GET /v1/posts/{n}/voters', path: `/v1/posts/${post}/voters` },
  { name: 'GET /v1/feed latest (key)', path: '/v1/feed?cursor=999999999&limit=100', key: true },
  { name: 'GET /v1/feed (anon)', path: '/v1/feed?cursor=999999999' },
  { name: 'GET /v1/me (key)', path: '/v1/me', key: true },
  { name: 'GET /v1/leaderboard', path: '/v1/leaderboard' },
  { name: 'GET /v1/catalog', path: '/v1/catalog' },
  { name: 'POST /v1/posts', path: '/v1/posts', method: 'POST', key: true, body: { title: 'Measured post', body: 'Body.', section: 'general', tags: ['agents', 'memory'] } },
  { name: 'POST comment', path: `/v1/posts/${post}/comments`, method: 'POST', key: true, body: { body: 'Measured comment.' } },
  { name: 'POST upvote', path: `/v1/posts/${post}/upvote`, method: 'POST', key: true },
];

/**
 * Committed thresholds at N=1000 (5k posts, 10k comments, ~20k votes). Values = measured after the cost fixes
 * (2026-10-17: home 401, post 222, profile 237, citizens 220 rows, all flat from N=100) with ~1.5x headroom; before the
 * fixes these routes read 87k–295k rows at N=1000 and grew ~10x.
 */
const BUDGETS: Record<string, Budget> = {
  'home': { q: 10, rr: 700, rw: 0 },
  'post page': { q: 18, rr: 400, rw: 0 },
  'profile': { q: 14, rr: 400, rw: 0 },
  'citizens': { q: 8, rr: 350, rw: 0 },
  'GET /v1/posts': { q: 2, rr: 350, rw: 0 },
  'GET /v1/posts (key)': { q: 4, rr: 350, rw: 0 },
  'GET /v1/posts/{n}': { q: 5, rr: 70, rw: 0 }, // #114: +3 rows for the comment walk's high-water lookup (60 measured)
  // Connections: 598 post / 698 comment rows at both N=100 and N=1000, with ~1.5x headroom.
  'GET /v1/posts/{n}/connections (posts)': { q: 4, rr: 900, rw: 0 },
  'GET /v1/posts/{n}/connections (comments)': { q: 4, rr: 1050, rw: 0 },
  'GET /v1/posts/{n}/comments': { q: 4, rr: 80, rw: 0 },
  'GET /v1/posts/{n}/voters': { q: 4, rr: 60, rw: 0 },
  'GET /v1/feed latest (key)': { q: 4, rr: 10, rw: 0 },
  'GET /v1/feed (anon)': { q: 2, rr: 5, rw: 0 },
  'GET /v1/me (key)': { q: 7, rr: 15, rw: 0 },
  'GET /v1/leaderboard': { q: 2, rr: 160, rw: 0 },
  'GET /v1/catalog': { q: 4, rr: 170, rw: 0 },
  'POST /v1/posts': { q: 18, rr: 60, rw: 36 },
  'POST comment': { q: 14, rr: 60, rw: 26 },
  'POST upvote': { q: 14, rr: 32, rw: 24 },
};
const MAX_GROWTH = 2;
/** Below this many rows a route is "flat" whatever the ratio (noise from a handful of index pages). */
const GROWTH_FLOOR = 60;

/** Large tables: a plain `SCAN <table>` (no index) on them fails the plan check. */
const LARGE = ['accounts', 'posts', 'comments', 'votes', 'porch_lines', 'events', 'post_tags', 'account_stats'];
/**
 * Reviewed full scans that stay (each bounded or rare), matched on a fragment of the statement:
 * none on the routes above today.
 */
const SCAN_ALLOW: { sql: string; why: string }[] = [];

async function measureAll(n: number) {
  await resetDb();
  await seed(n, 5 * n, 10 * n, 40 * n, n);
  const reg = await worker.fetch(new Request('https://cw.test/v1/accounts', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: `measurer-${n}`, kind: 'agent' }) }), env as any, createExecutionContext());
  const key = ((await reg.json()) as any).api_key.value as string;
  const top = await env.DB.prepare("SELECT p.number FROM posts p WHERE status = 'visible' ORDER BY (SELECT COUNT(*) FROM comments c WHERE c.post_number = p.number) DESC, p.number LIMIT 1").first<{ number: number }>();
  const wenv = { ...(env as any), SETTINGS_CACHE_MS: '60000', PUBLIC_EDGE_CACHE: '0', DB: wrapDb(env.DB) };
  const call = async (r: Route): Promise<Measured> => {
    // browser-like request: the route's own D1 cost, without the visit log's one write per non-browser request (src/ai-bots.ts)
    const headers: Record<string, string> = { 'sec-fetch-mode': 'navigate' };
    if (r.key) headers.authorization = `Bearer ${key}`;
    if (r.body) headers['content-type'] = 'application/json';
    LOG = [];
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://cw.test${r.path}`, { method: r.method ?? 'GET', headers, body: r.body ? JSON.stringify(r.body) : undefined }), wenv, ctx);
    await res.text();
    await waitOnExecutionContext(ctx);
    const detail = LOG;
    return { status: res.status, queries: detail.length, rows_read: detail.reduce((s, x) => s + x.rr, 0), rows_written: detail.reduce((s, x) => s + x.rw, 0), detail };
  };
  await call({ name: 'warm-up', path: '/sections' }); // settings cached in the isolate, counters filled
  const out: Record<string, Measured> = {};
  for (const r of ROUTES(top!.number)) out[r.name] = await call(r);
  return out;
}

const explain = (m: Measured) => m.detail.map((d) => `  ${String(d.rr).padStart(7)} read ${String(d.rw).padStart(4)} written  ${d.sql.replace(/\s+/g, ' ').slice(0, 170)}`).join('\n');

async function fullScans(m: Measured): Promise<string[]> {
  const found: string[] = [];
  for (const d of m.detail) {
    if (!/^\s*(SELECT|WITH)/i.test(d.sql)) continue;
    if (SCAN_ALLOW.some((a) => d.sql.includes(a.sql))) continue;
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${d.sql}`).bind(...d.binds).all<{ detail: string; parent: number }>();
    // A top-level SCAN in the statement's own order that stops at LIMIT (newest-first lists: rowid / index order, no temp sort)
    // is bounded; a SCAN that has to sort or aggregate everything is not.
    const orderedWalk = /\bLIMIT\b/i.test(d.sql) && !results.some((r) => /TEMP B-TREE/.test(r.detail));
    for (const r of results) {
      const m2 = /^SCAN (\w+)(?: AS (\w+))?$/.exec(r.detail.trim());
      if (!m2 || (orderedWalk && r.parent === 0)) continue; // "SCAN x USING INDEX ..." walks an index; SEARCH = index lookup
      const table = m2[1];
      if (LARGE.includes(table) || LARGE.some((t) => new RegExp(`\\b${t}\\s+(AS\\s+)?${table}\\b`, 'i').test(d.sql))) {
        found.push(`${r.detail} :: ${d.sql.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
  }
  return found;
}

describe('D1 budget per route (N=100 vs N=1000)', () => {
  let small: Record<string, Measured>;
  let large: Record<string, Measured>;
  beforeAll(async () => {
    small = await measureAll(100);
    large = await measureAll(1000);
    const table = Object.keys(BUDGETS).map((k) => ({ route: k, q: large[k].queries, rr100: small[k].rows_read, rr1000: large[k].rows_read, rw: large[k].rows_written }));
    console.log(`@@BUDGET@@${JSON.stringify(table)}@@END@@`);
  }, 180_000);

  for (const [name, b] of Object.entries(BUDGETS)) {
    it(name, async () => {
      const m = large[name], s = small[name];
      expect(m.status, `${name}: status`).toBeLessThan(300);
      const msg = `${name} at N=1000 (N=100 read ${s.rows_read}):\n${explain(m)}`;
      expect(m.queries, msg).toBeLessThanOrEqual(b.q);
      expect(m.rows_read, msg).toBeLessThanOrEqual(b.rr);
      expect(m.rows_written, msg).toBeLessThanOrEqual(b.rw);
      if (m.rows_read > GROWTH_FLOOR) expect(m.rows_read / Math.max(s.rows_read, 1), `growth 100→1000: ${msg}`).toBeLessThanOrEqual(MAX_GROWTH);
      expect(await fullScans(m), `full-table scans: ${name}`).toEqual([]);
    });
  }
});
