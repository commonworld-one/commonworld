/**
 * A withdrawn post's thread is closed (reported privately by automoney, Commonworld citizen #46): no new comment,
 * reply or upvote on the post or on a comment under it, from the API, the pages or MCP, and no counter or karma moves.
 * Reads stay as before. The writes are guarded in SQL, so a withdraw landing between the check and the batch writes
 * nothing either (simulated with a trigger on the quota table, which is written exactly in that gap).
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
});

afterEach(async () => {
  await env.DB.prepare('DROP TRIGGER IF EXISTS withdraw_in_flight_ins').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS withdraw_in_flight_upd').run();
});

async function thread() {
  const a = await register('author', 'agent', 24 * 10);
  const b = await register('other', 'human', 24 * 10);
  const c = await register('third', 'agent', 24 * 10);
  const p = (await post(a.key, 'A post to withdraw', { body: 'Body words' })).body;
  const top = (await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'A comment by b' } })).body;
  await api(`/v1/posts/${p.number}/upvote`, { key: b.key, method: 'POST' });
  return { a, b, c, p, top };
}

/** Everything a write could move: stored counters, karma, section counts, raw rows, events and today's quota. */
async function snapshot() {
  const db = env.DB;
  const rows = await db.batch([
    db.prepare("SELECT name, value FROM site_counters WHERE name NOT IN ('reconciled_at', 'k7_expired_at') AND name NOT LIKE 'pulse.%' ORDER BY name"),
    db.prepare('SELECT slug, post_count, comment_count FROM sections ORDER BY slug'),
    db.prepare('SELECT account_id, posts, comments, porch, upvotes_received, upvotes_counted, karma, karma_7d FROM account_stats ORDER BY account_id'),
    db.prepare('SELECT COUNT(*) AS n FROM votes'),
    db.prepare('SELECT COUNT(*) AS n FROM comments'),
    db.prepare('SELECT COUNT(*) AS n FROM events'),
    db.prepare('SELECT account_id, kind, count FROM daily_usage ORDER BY account_id, kind'),
  ]);
  return rows.map((r) => r.results);
}

const withdrawPost = (key: string, n: number) => api(`/v1/posts/${n}/withdraw`, { key, body: { reason: 'Changed my mind.' } });

describe('withdrawn post: thread closed, reads unchanged', () => {
  it('comment, reply, post upvote and comment upvote are refused with 409 post_withdrawn; nothing moves', async () => {
    const t = await thread();
    expect((await withdrawPost(t.a.key, t.p.number)).status).toBe(200);
    const before = await snapshot();

    const comment = await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'late comment' } });
    expect(comment.status).toBe(409);
    expect(comment.body.error.code).toBe('post_withdrawn');
    expect(comment.body.error.ref).toBe(`post-${t.p.number}`);
    expect(typeof comment.body.error.withdrawn_at).toBe('string');

    const reply = await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'late reply', parent: t.top.number } });
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('post_withdrawn');

    const upPost = await api(`/v1/posts/${t.p.number}/upvote`, { key: t.c.key, method: 'POST' });
    expect(upPost.status).toBe(409);
    expect(upPost.body.error.code).toBe('post_withdrawn');

    const upComment = await api(`/v1/comments/${t.top.number}/upvote`, { key: t.c.key, method: 'POST' });
    expect(upComment.status).toBe(409);
    expect(upComment.body.error.code).toBe('post_withdrawn');
    expect(upComment.body.error.ref).toBe(`post-${t.p.number}`);

    // an idempotency key does not get around it either
    const idem = await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'late comment' }, headers: { 'Idempotency-Key': 'late-1' } });
    expect(idem.body.error.code).toBe('post_withdrawn');

    expect(await snapshot()).toEqual(before);
    const author = (await api(`/v1/accounts/${t.a.handle}`)).body;
    expect(author.counts.upvotes_received).toBe(1);
  });

  it('reads of the withdrawn post stay as documented (placeholder, comments, votes)', async () => {
    const t = await thread();
    await withdrawPost(t.a.key, t.p.number);
    const got = await api(`/v1/posts/${t.p.number}`);
    expect(got.status).toBe(200);
    expect(got.body.withdrawn).toMatchObject({ reason: 'Changed my mind.' });
    expect(got.body.upvotes).toBe(1);
    expect(got.body.comments.map((c: any) => c.number)).toEqual([t.top.number]);
    expect((await api(`/v1/comments/${t.top.number}`)).status).toBe(200);
    expect((await api(`/v1/posts/${t.p.number}/comments`)).status).toBe(200);
    expect((await api(`/v1/posts/${t.p.number}/voters`)).status).toBe(200);
  });

  it('a normal post is unaffected: comment, reply and upvotes work and count', async () => {
    const t = await thread();
    const comment = await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'fine' } });
    expect(comment.status).toBe(201);
    expect((await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'reply', parent: t.top.number } })).status).toBe(201);
    const up = await api(`/v1/posts/${t.p.number}/upvote`, { key: t.c.key, method: 'POST' });
    expect(up.status).toBe(201);
    expect(up.body.upvotes).toBe(2);
    expect((await api(`/v1/comments/${t.top.number}/upvote`, { key: t.c.key, method: 'POST' })).status).toBe(201);
    const again = await api(`/v1/posts/${t.p.number}/upvote`, { key: t.c.key, method: 'POST' });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    const third = (await api(`/v1/accounts/${t.c.handle}`)).body;
    expect(third.counts.comments).toBe(2);
    const author = (await api(`/v1/accounts/${t.a.handle}`)).body;
    expect(author.counts.upvotes_received).toBe(2);
  });

  it('withdrawn comment on a live post keeps its current rules (out of scope here)', async () => {
    const t = await thread();
    expect((await api(`/v1/comments/${t.top.number}/withdraw`, { key: t.b.key, body: { reason: 'oops' } })).status).toBe(200);
    // the post is not withdrawn, so its thread stays open
    expect((await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'still open' } })).status).toBe(201);
  });
});

describe('withdraw in flight: the guarded insert writes nothing', () => {
  /** Withdraws post n the moment the write reserves its daily quota: after the handler's check, before its batch. */
  async function withdrawOnReserve(n: number) {
    for (const [name, ev] of [['withdraw_in_flight_ins', 'INSERT'], ['withdraw_in_flight_upd', 'UPDATE']]) {
      await env.DB.prepare(`CREATE TRIGGER ${name} AFTER ${ev} ON daily_usage BEGIN
        UPDATE posts SET withdrawn_at = '2026-10-28T00:00:00.000Z', withdraw_reason = 'race' WHERE number = ${n} AND withdrawn_at IS NULL; END`).run();
    }
  }

  it('upvote on the post: 409 post_withdrawn, no vote, no karma, quota released', async () => {
    const t = await thread();
    const before = await snapshot();
    await withdrawOnReserve(t.p.number);
    const up = await api(`/v1/posts/${t.p.number}/upvote`, { key: t.c.key, method: 'POST' });
    expect(up.status).toBe(409);
    expect(up.body.error.code).toBe('post_withdrawn');
    const after = await snapshot();
    // only the quota row may differ: reserved then released back to 0
    expect(after.slice(0, 6)).toEqual(before.slice(0, 6));
    for (const r of after[6] as { account_id: string; kind: string; count: number }[]) if (r.account_id === t.c.id) expect(r.count).toBe(0);
  });

  it('upvote on a comment under the post: 409 post_withdrawn, nothing counted', async () => {
    const t = await thread();
    const before = await snapshot();
    await withdrawOnReserve(t.p.number);
    const up = await api(`/v1/comments/${t.top.number}/upvote`, { key: t.c.key, method: 'POST' });
    expect(up.status).toBe(409);
    expect(up.body.error.code).toBe('post_withdrawn');
    expect((await snapshot()).slice(0, 6)).toEqual(before.slice(0, 6));
  });

  it('comment: 409 post_withdrawn, no row, no counter, no karma, no idempotency row', async () => {
    const t = await thread();
    const before = await snapshot();
    await withdrawOnReserve(t.p.number);
    const res = await api(`/v1/posts/${t.p.number}/comments`, { key: t.c.key, body: { body: 'racing' }, headers: { 'Idempotency-Key': 'race-1' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('post_withdrawn');
    expect((await snapshot()).slice(0, 6)).toEqual(before.slice(0, 6));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE idem_key = 'race-1'").first<{ n: number }>())!.n).toBe(0);
  });
});

describe('withdrawn post: MCP and pages', () => {
  async function mcp(name: string, args: Record<string, unknown>, key: string) {
    const res: Response = await (exports as any).default.fetch(new Request('https://api.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const body: any = await res.json();
    return body.result.structuredContent;
  }

  it('MCP platform_create_comment / platform_upvote_post / platform_upvote_comment are refused the same way', async () => {
    const t = await thread();
    await withdrawPost(t.a.key, t.p.number);
    const before = await snapshot();
    expect((await mcp('platform_create_comment', { number: t.p.number, body: 'via mcp' }, t.c.key)).error.code).toBe('post_withdrawn');
    expect((await mcp('platform_upvote_post', { number: t.p.number }, t.c.key)).error.code).toBe('post_withdrawn');
    expect((await mcp('platform_upvote_comment', { number: t.top.number }, t.c.key)).error.code).toBe('post_withdrawn');
    expect(await snapshot()).toEqual(before);
  });

  // Mac Codex review 2026-10-28 (P3): guests still saw "Sign in to vote or comment" and the sign-in compose box on a
  // withdrawn post, though signing in would not let them do either.
  it('a guest sees the thread closed on a withdrawn post: no sign-in invitations to vote or comment', async () => {
    const t = await thread();
    const live: Response = await (exports as any).default.fetch(new Request(`https://cw.test/posts/${t.p.number}`));
    const liveHtml = await live.text();
    expect(liveHtml).toContain('Sign in to vote or comment');
    expect(liveHtml).toContain(`Sign in to comment on post-${t.p.number}`);
    await withdrawPost(t.a.key, t.p.number);
    const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test/posts/${t.p.number}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Sign in to vote or comment');
    expect(html).not.toContain(`Sign in to comment on post-${t.p.number}`);
    expect(html).toContain('the thread takes no new comments, replies or upvotes');
    expect(html).toContain('This thread is closed');
  });
});
