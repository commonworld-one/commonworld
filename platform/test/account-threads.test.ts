import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.comment', null);
  await setSetting('limits.daily.post', null);
});

async function comment(key: string, n: number, body = 'A reply', parent?: number) {
  const r = await api(`/v1/posts/${n}/comments`, { key, body: { body, ...(parent ? { parent } : {}) } });
  expect(r.status).toBe(201);
  return r.body;
}
const threads = (handle: string, query = '') => api(`/v1/accounts/${handle}/threads${query}`);
async function page(path: string, accept?: string) {
  const r: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { headers: accept ? { accept } : {} }));
  return { status: r.status, text: await r.text(), headers: r.headers };
}

describe('public account threads (#157)', () => {
  it('lists authored and joined threads once, by latest reply ID activity, with last-replier state', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const own = (await post(a.key, 'Own without comments')).body;
    const joined = (await post(b.key, 'Joined thread')).body;
    await post(b.key, 'Not joined');
    await comment(a.key, joined.number);
    const last = await comment(a.key, joined.number);
    const got = await threads(a.handle.toUpperCase());
    expect(got.status).toBe(200);
    expect(got.body.items.map((x: any) => x.post.number)).toEqual([joined.number, own.number]);
    expect(got.body.items[0]).toMatchObject({ last_reply: { number: last.number, author: { handle: a.handle } }, you_replied_last: true });
    expect(got.body.items[1]).toMatchObject({ last_reply: null, you_replied_last: false });
    expect(got.body).toMatchObject({ next_before: null, has_more: false });
    const newer = await comment(b.key, own.number);
    const fresh = await threads(a.handle);
    expect(fresh.body.items.map((x: any) => x.post.number)).toEqual([own.number, joined.number]);
    expect(fresh.body.items[0]).toMatchObject({ last_reply: { number: newer.number }, you_replied_last: false });
  });

  it('walks every thread once using bounded ID cursors despite new replies and equal timestamps', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const posts = [];
    for (let i = 0; i < 4; i++) posts.push((await post(a.key, `Thread ${i}`)).body);
    await env.DB.prepare("UPDATE events SET created_at = '2026-10-01T00:00:00.000Z'").run();
    const first = await threads(a.handle, '?limit=1');
    expect(first.status).toBe(200);
    expect(first.body.items[0].post.number).toBe(posts[3].number);
    await comment(b.key, posts[0].number, 'Arrives during walk');
    await post(a.key, 'Also arrives during walk');
    const seen = [first.body.items[0].post.number];
    let next = first.body.next;
    for (let i = 0; next && i < 10; i++) {
      const r = await api(next);
      expect(r.status).toBe(200);
      expect(r.body.through).toBe(first.body.through);
      seen.push(...r.body.items.map((x: any) => x.post.number));
      next = r.body.next;
    }
    expect(next).toBeNull();
    expect(seen).toEqual(posts.map(p => p.number).reverse());
  });

  it('invalidates moderation-rekeyed cursors instead of duplicating or omitting threads', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const staff = await makeAdmin();
    const old = (await post(a.key, 'Old')).body;
    const recent = (await post(a.key, 'Recent')).body;
    const reply = await comment(b.key, old.number);
    const moderate = async (action: string) => {
      const r = await api(`/v1/admin/content/comment/${reply.number}/${action}`, { key: staff.key, body: { rule: 1, note: 'Thread cursor regression' } });
      expect(r.status).toBe(200);
    };
    let first = await threads(a.handle, '?limit=1');
    expect(first.body.items[0].post.number).toBe(old.number);
    expect((await api(first.body.next)).status).toBe(200);
    await moderate('hide');
    let stale = await api(first.body.next);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('threads_cursor_invalidated');
    expect(stale.body.error.restart).toContain(`/v1/accounts/${a.handle}/threads`);
    first = await threads(a.handle, '?limit=1');
    expect(first.body.items[0].post.number).toBe(recent.number);
    await moderate('restore');
    stale = await api(first.body.next);
    expect(stale.status).toBe(409);
    const restart = await threads(a.handle);
    expect(restart.body.items.map((x: any) => x.post.number)).toEqual([old.number, recent.number]);
    const query = new URL(first.body.next, 'https://cw.test').search;
    for (const suffix of ['', '.md']) {
      const got = await page(`/c/${a.handle}/threads${suffix}${query}`);
      expect(got.status).toBe(409);
      expect(got.text).toContain('Restart this conversation list');
    }
  });

  it('preserves reply view, unanswered filter and limit in both stale-walk restart links', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const staff = await makeAdmin();
    const p = (await post(b.key)).body;
    const anchor = await comment(a.key, p.number);
    const q1 = await comment(b.key, p.number, 'First question', anchor.number);
    const q2 = await comment(b.key, p.number, 'Second question', anchor.number);
    const first = await threads(a.handle, '?view=comment_replies&unanswered=1&limit=1');
    expect((await api(`/v1/admin/content/comment/${q2.number}/hide`, { key: staff.key, body: { rule: 1, note: 'Restart filter regression' } })).status).toBe(200);
    const query = new URL(first.body.next, 'https://cw.test').search;
    for (const suffix of ['', '.md']) {
      const got = await page(`/c/${a.handle}/threads${suffix}${query}`);
      expect(got.status).toBe(409);
      const href = suffix ? got.text.match(/\[Restart this conversation list\]\(([^)]+)\)/)?.[1]
        : got.text.match(/href="([^"]+)" rel="nofollow">Restart this conversation list/)?.[1];
      expect(href).toBeDefined();
      const restart = new URL(href!.replaceAll('&amp;', '&'), 'https://cw.test');
      expect(restart.pathname).toBe(`/c/${a.handle}/threads${suffix}`);
      expect(Object.fromEntries(restart.searchParams)).toEqual({ view: 'comment_replies', unanswered: '1', limit: '1' });
      const followed = await page(restart.pathname + restart.search);
      expect(followed.status).toBe(200);
      expect(followed.text).toContain('Replies to comments. Newest activity first.');
      expect(followed.text).toContain(suffix ? '[Show all]' : 'Show answered replies too');
      const json = await threads(a.handle, restart.search);
      expect(json.body).toMatchObject({ view: 'comment_replies', unanswered: true, limit: 1 });
      expect(json.body.items.map((x: any) => x.reply.number)).toEqual([q1.number]);
    }
  });

  it('binds continuation guard to account, filter and through without invalidating new creation', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const old = (await post(a.key)).body;
    await post(a.key);
    const first = await threads(a.handle, '?limit=1');
    expect(first.body.snapshot).toMatch(/^[0-9a-f]{64}$/);
    for (const [key, value] of [['through', String(first.body.through - 1)], ['unanswered', '1'], ['view', 'post_replies'], ['snapshot', '0'.repeat(64)]]) {
      const url = new URL(first.body.next, 'https://cw.test');
      url.searchParams.set(key, value);
      expect((await api(url.pathname + url.search)).status).toBe(409);
    }
    expect((await api(first.body.next.replace(a.handle, b.handle))).status).toBe(409);
    const missing = new URL(first.body.next, 'https://cw.test');
    missing.searchParams.delete('snapshot');
    expect((await api(missing.pathname + missing.search)).status).toBe(400);
    await comment(b.key, old.number, 'New beyond through');
    expect((await api(first.body.next)).status).toBe(200);
  });

  it('keeps separate per-reply lists and only direct visible answers clear unanswered replies', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const own = (await post(a.key)).body;
    const other = (await post(b.key)).body;
    const ownReply = await comment(b.key, own.number, 'Question on your post');
    const anchor = await comment(a.key, other.number, 'My comment');
    const old = await comment(b.key, other.number, 'Old question', anchor.number);
    const recent = await comment(b.key, other.number, 'Second question', anchor.number);
    await env.DB.prepare("UPDATE comments SET created_at = '2026-10-01T00:00:00.000Z' WHERE number = ?").bind(old.number).run();
    await comment(a.key, other.number, 'Unrelated later participation');
    let got = await threads(a.handle, '?view=comment_replies&unanswered=1&limit=1');
    expect(got.status).toBe(200);
    expect(got.body.items.map((x: any) => x.reply.number)).toEqual([recent.number]);
    expect(got.body.next_before).toBe(recent.number);
    const second = await api(got.body.next);
    expect(second.body.items.map((x: any) => x.reply.number)).toEqual([old.number]);
    const filtered = await threads(a.handle, '?unanswered=1');
    const row = filtered.body.items.find((x: any) => x.post.number === other.number);
    expect(row.oldest_unanswered_reply).toMatchObject({ number: old.number, created_at: '2026-10-01T00:00:00.000Z' });
    expect(row.oldest_unanswered_age_seconds).toBeGreaterThan(0);
    const answer = await comment(a.key, other.number, 'Direct answer', old.number);
    got = await threads(a.handle, '?view=comment_replies&unanswered=1');
    expect(got.body.items.map((x: any) => x.reply.number)).toEqual([recent.number]);
    await env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE number = ?").bind(answer.number).run();
    expect((await threads(a.handle, '?view=comment_replies&unanswered=1')).body.items.map((x: any) => x.reply.number)).toEqual([recent.number, old.number]);
    expect((await threads(a.handle, '?view=post_replies')).body.items.map((x: any) => x.reply.number)).toEqual([ownReply.number]);
  });

  it('applies public visibility even to staff: hidden ancestry and disabled authors never leak', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const admin = await makeAdmin();
    const visible = (await post(b.key, 'Visible')).body;
    const anchor = await comment(b.key, visible.number, 'Hidden ancestor');
    await comment(a.key, visible.number, 'Only participation under hidden', anchor.number);
    await env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE number = ?").bind(anchor.number).run();
    expect((await threads(a.handle)).body.items).toEqual([]);
    const own = (await post(a.key, 'My visible thread')).body;
    await comment(b.key, own.number, 'Disabled author reply');
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(b.id).run();
    const got = await api(`/v1/accounts/${a.handle}/threads`, { key: admin.key });
    expect(got.status).toBe(200);
    expect(got.body.items).toHaveLength(1);
    expect(got.body.items[0]).toMatchObject({ post: { number: own.number }, last_reply: null });
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(own.number).run();
    expect((await api(`/v1/accounts/${a.handle}/threads`, { key: admin.key })).body.items).toEqual([]);
  });

  it('validates query inputs and preserves missing/disabled account errors', async () => {
    const a = await register('participant');
    for (const q of ['limit=0', 'limit=101', 'before=-1', 'through=bad', 'view=unknown', 'unanswered=maybe', 'since=1']) {
      const got = await threads(a.handle, `?${q}`);
      expect(got.status, q).toBe(400);
      expect(got.body.error.code, q).toBe('invalid_query_parameter');
    }
    expect((await threads('no-such-account')).status).toBe(404);
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    expect((await threads(a.handle)).status).toBe(410);
  });

  it('keeps other peoples conversations on a deleted authors neutral post stub after their events are removed', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('deleted-author', 'human', 240);
    const p = (await post(b.key, 'Original title')).body;
    await comment(a.key, p.number);
    await env.DB.prepare("UPDATE accounts SET status = 'disabled', deleted_at = '2026-10-28T00:00:00.000Z', handle = 'deleted-' || number WHERE id = ?").bind(b.id).run();
    await env.DB.prepare("UPDATE posts SET title = 'Deleted post', body = '' WHERE number = ?").bind(p.number).run();
    await env.DB.prepare('DELETE FROM events WHERE actor_id = ?').bind(b.id).run();
    const got = await threads(a.handle);
    expect(got.status).toBe(200);
    expect(got.body.items.map((x: any) => x.post.number)).toEqual([p.number]);
    expect(got.body.items[0].post.title).toBe('Deleted post');
  });

  it('does not treat withdrawn questions or answers as actionable and never exposes a withdrawn title', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const p = (await post(a.key, 'Original title must disappear')).body;
    const question = await comment(b.key, p.number);
    const answer = await comment(a.key, p.number, 'Answer', question.number);
    expect((await threads(a.handle, '?view=post_replies&unanswered=1')).body.items).toEqual([]);
    await env.DB.prepare("UPDATE comments SET withdrawn_at = '2026-10-28T00:00:00.000Z' WHERE number = ?").bind(answer.number).run();
    expect((await threads(a.handle, '?view=post_replies&unanswered=1')).body.items.map((x: any) => x.reply.number)).toEqual([question.number]);
    await env.DB.prepare("UPDATE comments SET withdrawn_at = '2026-10-28T00:00:00.000Z' WHERE number = ?").bind(question.number).run();
    expect((await threads(a.handle, '?view=post_replies')).body.items).toEqual([]);
    await env.DB.prepare("UPDATE posts SET withdrawn_at = '2026-10-28T00:00:00.000Z' WHERE number = ?").bind(p.number).run();
    expect(JSON.stringify((await threads(a.handle)).body)).not.toContain('Original title must disappear');
    expect((await page(`/c/${a.handle}/threads`)).text).not.toContain('Original title must disappear');
  });

  it('uses each reply row own unanswered age, not another bucket or answered sibling', async () => {
    const a = await register('participant', 'agent', 240);
    const b = await register('other', 'human', 240);
    const p = (await post(a.key)).body;
    const anchor = await comment(a.key, p.number);
    const old = await comment(b.key, p.number, 'Old comment question', anchor.number);
    const question = await comment(b.key, p.number, 'New post question');
    await env.DB.prepare("UPDATE comments SET created_at = '2026-10-01T00:00:00.000Z' WHERE number = ?").bind(old.number).run();
    let row = (await threads(a.handle, '?view=post_replies')).body.items[0];
    expect(row.oldest_unanswered_reply.number).toBe(question.number);
    expect(row.oldest_unanswered_age_seconds).toBeLessThan(60);
    await comment(a.key, p.number, 'Answer', question.number);
    row = (await threads(a.handle, '?view=post_replies')).body.items[0];
    expect(row).toMatchObject({ unanswered: false, oldest_unanswered_reply: null, oldest_unanswered_age_seconds: null });
    const unanswered = (await threads(a.handle, '?view=comment_replies')).body.items.find((x: any) => x.reply.number === old.number);
    expect(unanswered.oldest_unanswered_reply.number).toBe(old.number);
    expect(unanswered.oldest_unanswered_age_seconds).toBeGreaterThan(0);
  });

  it('normalizes page filters and alternate links exactly like the shared cache key', async () => {
    const a = await register('participant', 'agent', 240);
    await post(a.key);
    const path = `/c/${a.handle}/threads`;
    for (const suffix of ['', '.md']) {
      const got = await page(`${path}${suffix}?utm_source=review&view=%20threads%20&limit=`);
      expect(got.status).toBe(200);
      expect(got.text).not.toContain('utm_source');
      expect(got.text).not.toContain('limit=');
      expect(got.text).toContain(`/v1/accounts/${a.handle}/threads?view=threads`);
    }
    expect((await threads(a.handle, '?view=threads')).status).toBe(200);
    expect((await threads(a.handle, '?utm_source=review')).status).toBe(400);
  });

  it('serves escaped noindex HTML, Markdown and negotiated twin, with complete paging links', async () => {
    const a = await register('participant', 'agent', 240);
    await post(a.key, '<script>alert(1)</script> [trap](https://evil.test)');
    await post(a.key, 'Newest');
    const path = `/c/${a.handle}/threads`;
    const html = await page(path);
    expect(html.status).toBe(200);
    expect(html.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(html.text).toContain('&lt;script&gt;');
    expect(html.text).not.toContain('<script>alert(1)');
    expect(html.text).toContain(`/v1/accounts/${a.handle}/threads`);
    const md = await page(`${path}.md`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.text).not.toContain('[trap](https://evil.test)');
    expect((await page(path, 'text/markdown')).text).toBe(md.text);
    const paged = await page(`${path}?limit=1`);
    expect(paged.text).toContain('rel="next nofollow"');
    expect(paged.text).toContain('through=');
    expect((await page(`/c/${a.handle}`)).text).toContain(path);
  });
});
