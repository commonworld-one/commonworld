/**
 * Move a post (src/routes/move.ts): race safety of the move batch.
 *
 * The batch starts with a guarded UPDATE (post still in `from`, visible, not withdrawn). When it changes no row (another
 * move, a hide or a withdrawal landed between the request's read and its batch), no other statement of the batch may
 * write: no move row, no event, no idempotency key, no section recount, no content cache bump.
 *
 * The races are made deterministic by running the Worker with a D1 binding that pauses (or acts) right before the move
 * batch is sent; everything else goes to the real test database.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeAdmin, post, recount, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
});

/** The real DB, except that `beforeMoveBatch` runs right before the batch that follows the move UPDATE is sent. */
function hookedDb(beforeMoveBatch: () => Promise<void>): D1Database {
  const real = env.DB;
  let armed = false;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (/^\s*UPDATE posts SET section_slug/.test(sql)) armed = true;
          return target.prepare(sql);
        };
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (armed) { armed = false; await beforeMoveBatch(); }
          return target.batch(statements);
        };
      }
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function moveWith(db: D1Database, key: string, n: number, section: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://api.test/v1/posts/${n}/section`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ section }),
  }), { ...env, DB: db } as any, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const cacheVersion = async () =>
  (await env.DB.prepare("SELECT version FROM cache_versions WHERE name = 'content'").first<{ version: number }>())?.version ?? 0;
const sectionCounts = async (slug: string) =>
  env.DB.prepare('SELECT post_count, comment_count FROM sections WHERE slug = ?').bind(slug).first<{ post_count: number; comment_count: number }>();
/** Stored counters set to a value no recount would produce: if a statement recounts the section, the marker is gone. */
const markCounts = async (...slugs: string[]) => {
  for (const slug of slugs) await env.DB.prepare('UPDATE sections SET post_count = 77, comment_count = 77 WHERE slug = ?').bind(slug).run();
};
const MARK = { post_count: 77, comment_count: 77 };
const moveCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM post_section_moves').first<{ n: number }>())!.n;
const moveEvents = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'post.moved'").first<{ n: number }>())!.n;

async function thread() {
  const a = await register('author', 'agent', 24 * 10);
  const b = await register('other', 'human', 24 * 10);
  const p = (await post(a.key, 'A post to move', { body: 'Body.' })).body;
  const c = await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'A comment' } });
  expect(c.status).toBe(201);
  return { a, b, p };
}

describe('move race: two concurrent moves of the same post', () => {
  it('both read the post before either batch runs: exactly one move lands, the loser writes nothing', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    // both requests wait here until both have read the post and built their batch
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const barrier = async () => { arrived += 1; if (arrived === 2) open(); await gate; };
    await markCounts('building-together', 'commonworld-development');
    const v0 = await cacheVersion();

    const [r1, r2] = await Promise.all([
      moveWith(hookedDb(barrier), t.a.key, t.p.number, 'building-together'),
      moveWith(hookedDb(barrier), admin.key, t.p.number, 'commonworld-development'),
    ]);
    expect(arrived).toBe(2);
    const results = [{ r: r1, to: 'building-together' }, { r: r2, to: 'commonworld-development' }];
    const won = results.filter((x) => x.r.status === 200);
    const lost = results.filter((x) => x.r.status !== 200);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].r.status).toBe(409);
    expect(lost[0].r.body.error).toMatchObject({ code: 'section_changed', section: won[0].to });

    expect(await moveCount()).toBe(1);
    expect(await moveEvents()).toBe(1);
    expect((await env.DB.prepare('SELECT section_slug FROM posts WHERE number = ?').bind(t.p.number).first<any>()).section_slug).toBe(won[0].to);
    // the winner recounted general and its target; the loser's target was not recounted (marker kept)
    expect(await sectionCounts('general')).toEqual({ post_count: 0, comment_count: 0 });
    expect(await sectionCounts(won[0].to)).toEqual({ post_count: 1, comment_count: 1 });
    expect(await sectionCounts(lost[0].to)).toEqual(MARK);
    // the content cache version went up once, not twice
    expect(await cacheVersion()).toBe(v0 + 1);

    await recount();
    expect(await sectionCounts(lost[0].to)).toEqual({ post_count: 0, comment_count: 0 });
  });
});

describe('move race: the post is hidden or withdrawn between the read and the batch', () => {
  it('hidden by moderation in between: 409 content_hidden, no move row, no event, no recount, no cache bump', async () => {
    const t = await thread();
    await markCounts('general', 'building-together');
    const v0 = await cacheVersion();
    const hide = async () => { await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(t.p.number).run(); };
    const res = await moveWith(hookedDb(hide), t.a.key, t.p.number, 'building-together');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('content_hidden');
    expect(await moveCount()).toBe(0);
    expect(await moveEvents()).toBe(0);
    expect(await sectionCounts('general')).toEqual(MARK);
    expect(await sectionCounts('building-together')).toEqual(MARK);
    expect(await cacheVersion()).toBe(v0);
    expect((await env.DB.prepare('SELECT section_slug FROM posts WHERE number = ?').bind(t.p.number).first<any>()).section_slug).toBe('general');
  });

  it('withdrawn by the author in between: 409 already_withdrawn, nothing written', async () => {
    const t = await thread();
    await markCounts('general', 'building-together');
    const v0 = await cacheVersion();
    const withdraw = async () => {
      await env.DB.prepare('UPDATE posts SET withdrawn_at = ? WHERE number = ?').bind(new Date().toISOString(), t.p.number).run();
    };
    const res = await moveWith(hookedDb(withdraw), t.a.key, t.p.number, 'building-together');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_withdrawn');
    expect(await moveCount()).toBe(0);
    expect(await moveEvents()).toBe(0);
    expect(await sectionCounts('general')).toEqual(MARK);
    expect(await sectionCounts('building-together')).toEqual(MARK);
    expect(await cacheVersion()).toBe(v0);
  });

  it('a lost race uses no daily quota: with limits.daily.move = 1 the next real move still goes through', async () => {
    const t = await thread();
    await setSetting('limits.daily.move', 1);
    const hide = async () => { await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(t.p.number).run(); };
    expect((await moveWith(hookedDb(hide), t.a.key, t.p.number, 'building-together')).status).toBe(409);
    await env.DB.prepare("UPDATE posts SET status = 'visible' WHERE number = ?").bind(t.p.number).run();
    expect((await moveWith(env.DB, t.a.key, t.p.number, 'building-together')).status).toBe(200);
  });
});

describe('D1 batch: changes() is the row count of the previous write statement of the same batch', () => {
  it('each changes() reads the statement just before it, never an earlier one or a stale value', async () => {
    const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sections').first<{ n: number }>())!.n;
    expect(total).toBeGreaterThan(1);
    const db = env.DB;
    const out = await db.batch([
      db.prepare("UPDATE sections SET name = name WHERE slug = 'general'"),       // 1 row
      db.prepare('SELECT changes() AS n'),
      db.prepare("UPDATE sections SET name = name WHERE slug = 'no-such-slug'"),  // 0 rows: must read 0, not the 1 above
      db.prepare('SELECT changes() AS n'),
      db.prepare('UPDATE sections SET name = name'),                              // every row
      db.prepare('SELECT 1 AS x'),                                                // a read does not reset it
      db.prepare('SELECT changes() AS n'),
      db.prepare("UPDATE sections SET name = name WHERE slug = 'no-such-slug'"),
      // the move pattern: a conditional write keyed on changes() of the UPDATE just before it
      db.prepare("SELECT 'written' AS w WHERE changes() = 1"),
    ]);
    expect(out[0].meta.changes).toBe(1);
    expect((out[1].results[0] as any).n).toBe(1);
    expect(out[2].meta.changes).toBe(0);
    expect((out[3].results[0] as any).n).toBe(0);
    expect(out[4].meta.changes).toBe(total);
    expect((out[6].results[0] as any).n).toBe(total);
    expect(out[8].results).toEqual([]);
  });
});
