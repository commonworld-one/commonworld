/**
 * Move a post to another section (POST /v1/posts/{n}/section): author or active admin only, only the section changes,
 * every move is a public permanent record (post JSON, page, Markdown twin, change feed), section counters stay exact,
 * cached pages and reads show the move at once, refusals write nothing.
 */
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { beforeEach, describe, expect, it } from 'vitest';
import { MOVE_REASON_MAX } from '../src/post-moves';
import { api, makeAdmin, post, recount, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
});

async function page(path: string, headers: Record<string, string> = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual', headers }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** Through the Worker's own edge cache (Workers Cache API on, as in production). */
async function edge(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }), { ...env, PUBLIC_EDGE_CACHE: '1' } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { cache: res.headers.get('x-cw-cache'), text: await res.text() };
}

const move = (key: string, n: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  api(`/v1/posts/${n}/section`, { key, body, headers });

const sectionCounts = async (slug: string) =>
  env.DB.prepare('SELECT post_count, comment_count FROM sections WHERE slug = ?').bind(slug).first<{ post_count: number; comment_count: number }>();

const moveRows = async (n: number) =>
  (await env.DB.prepare('SELECT from_section, to_section, actor_role, reason FROM post_section_moves WHERE post_number = ? ORDER BY number').bind(n).all()).results;

async function thread() {
  const a = await register('author', 'agent', 24 * 10);
  const b = await register('other', 'human', 24 * 10);
  const p = (await post(a.key, 'A post to move', { body: 'Body text stays.', tags: ['agents'] })).body;
  await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'A comment by someone else' } });
  await api(`/v1/posts/${p.number}/upvote`, { key: b.key, method: 'POST' });
  return { a, b, p };
}

describe('move: who may move, what changes, the public record', () => {
  it('the author moves own post: section changes, everything else stays, the move is recorded', async () => {
    const t = await thread();
    const res = await move(t.a.key, t.p.number, { section: ' Building-Together ', reason: '  Fits   better here. ' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ number: t.p.number, id: t.p.id, url: `/posts/${t.p.number}`, title: 'A post to move', body: 'Body text stays.',
      section: { slug: 'building-together', name: 'Building Together' }, tags: ['agents'], author: { handle: t.a.handle }, upvotes: 1, comment_count: 1 });
    expect(res.body.moves).toHaveLength(1);
    expect(res.body.moves[0]).toMatchObject({ from: { slug: 'general', name: 'General' }, to: { slug: 'building-together', name: 'Building Together' },
      actor: { handle: t.a.handle, kind: 'agent', url: `/c/${t.a.handle}` }, actor_role: 'author', reason: 'Fits better here.' });
    expect(typeof res.body.moves[0].created_at).toBe('string');

    const got = await api(`/v1/posts/${t.p.number}`);
    expect(got.status).toBe(200);
    expect(got.body.section.slug).toBe('building-together');
    expect(got.body.moves).toEqual(res.body.moves);
    expect(got.body.comments).toHaveLength(1);
    expect(got.body.voters.map((v: any) => v.handle)).toEqual([t.b.handle]);
    expect(await moveRows(t.p.number)).toEqual([{ from_section: 'general', to_section: 'building-together', actor_role: 'author', reason: 'Fits better here.' }]);

    // listings follow
    expect((await api('/v1/posts?section=general')).body.items).toEqual([]);
    expect((await api('/v1/posts?section=building-together')).body.items.map((x: any) => x.number)).toEqual([t.p.number]);

    // public change feed event, actor = mover
    const feed = (await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.moved');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ object: { type: 'post', number: t.p.number, ref: `post-${t.p.number}` }, actor: { handle: t.a.handle },
      data: { from: 'general', to: 'building-together', reason: 'Fits better here.', role: 'author' } });
  });

  it('a post never moved has moves: [] in its JSON and no move note on its page', async () => {
    const t = await thread();
    const got = await api(`/v1/posts/${t.p.number}`);
    expect(got.body.moves).toEqual([]);
    const html = (await page(`/posts/${t.p.number}`)).text;
    expect(html).not.toContain('Moved from');
    expect((await page(`/posts/${t.p.number}.md`)).text).not.toContain('Section moves');
  });

  it('an active admin may move anyone\'s post (role admin shown); another citizen may not', async () => {
    const t = await thread();
    const refused = await move(t.b.key, t.p.number, { section: 'building-together' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('not_your_content');
    expect(await moveRows(t.p.number)).toEqual([]);

    const admin = await makeAdmin();
    const res = await move(admin.key, t.p.number, { section: 'commonworld-development' });
    expect(res.status).toBe(200);
    expect(res.body.section.slug).toBe('commonworld-development');
    expect(res.body.moves[0]).toMatchObject({ actor: { handle: admin.handle }, actor_role: 'admin', reason: null });

    // a frozen admin keeps the role row but cannot move (403 like every write)
    await env.DB.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").bind(admin.id).run();
    const frozen = await move(admin.key, t.p.number, { section: 'general' });
    expect(frozen.status).toBe(403);
    expect(await moveRows(t.p.number)).toHaveLength(1);
  });

  it('without a key: 401, nothing written', async () => {
    const t = await thread();
    const res = await api(`/v1/posts/${t.p.number}/section`, { body: { section: 'building-together' } });
    expect(res.status).toBe(401);
    expect(await moveRows(t.p.number)).toEqual([]);
  });

  it('page and Markdown twin show "Moved from X to Y by @actor on DATE", oldest first', async () => {
    const t = await thread();
    await move(t.a.key, t.p.number, { section: 'building-together', reason: 'Better fit.' });
    await move(t.a.key, t.p.number, { section: 'commonworld-development' });
    const day = new Date().toISOString().slice(0, 10);
    const html = (await page(`/posts/${t.p.number}`)).text;
    const first = html.indexOf('Moved from <a href="/s/general">General</a> to <a href="/s/building-together">Building Together</a>');
    const second = html.indexOf('Moved from <a href="/s/building-together">Building Together</a> to <a href="/s/commonworld-development">Commonworld Development</a>');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(html).toContain(`by <a href="/c/${t.a.handle}">@${t.a.handle}</a> on <time`);
    expect(html).toContain(`>${day}</time>: Better fit.`);

    const md = (await page(`/posts/${t.p.number}.md`)).text;
    expect(md).toContain('## Section moves');
    expect(md).toContain(`- Moved from General to Building Together by @${t.a.handle} on ${day}: Better fit.`);
    expect(md).toContain(`- Moved from Building Together to Commonworld Development by @${t.a.handle} on ${day}`);
  });

  it('section page links survive: the post URL stays /posts/{n} and the old section page no longer lists it', async () => {
    const t = await thread();
    const before = (await page('/s/general')).text;
    expect(before).toContain(`/posts/${t.p.number}"`);
    await move(t.a.key, t.p.number, { section: 'building-together' });
    expect((await page(`/posts/${t.p.number}`)).status).toBe(200);
    // the content cache version was bumped: the cached copy of the old section page is not served again
    expect((await page('/s/general')).text).not.toContain(`/posts/${t.p.number}"`);
    expect((await page('/s/building-together')).text).toContain(`/posts/${t.p.number}`);
  });
});

describe('move: edge cache', () => {
  it('cached section pages and the post page do not serve the old section after a move', async () => {
    const t = await thread();
    // pages are in the Worker's edge cache; /v1/posts reads are s-maxage=30 only (no Worker cache), checked for freshness
    const paths = ['/s/general', '/s/building-together', `/posts/${t.p.number}`];
    for (const path of paths) await edge(path);
    for (const path of paths) expect((await edge(path)).cache, path).toBe('HIT');
    expect((await edge('/s/general')).text).toContain(`/posts/${t.p.number}"`);
    await move(t.a.key, t.p.number, { section: 'building-together' });
    // the move bumped the content cache version: every key above misses once and renders fresh
    const general = await edge('/s/general');
    expect(general.cache).not.toBe('HIT');
    expect(general.text).not.toContain(`/posts/${t.p.number}"`);
    const target = await edge('/s/building-together');
    expect(target.cache).not.toBe('HIT');
    expect(target.text).toContain(`/posts/${t.p.number}"`);
    const postPage = await edge(`/posts/${t.p.number}`);
    expect(postPage.cache).not.toBe('HIT');
    expect(postPage.text).toContain('Moved from');
    expect(JSON.parse((await edge(`/v1/posts/${t.p.number}`)).text).section.slug).toBe('building-together');
  });
});

describe('move: counters stay exact', () => {
  it('post_count and comment_count of both sections follow, and equal a full recount', async () => {
    const t = await thread();
    const a2 = (await post(t.a.key, 'Stays in general')).body;
    await api(`/v1/posts/${a2.number}/comments`, { key: t.b.key, body: { body: 'x' } });
    expect(await sectionCounts('general')).toEqual({ post_count: 2, comment_count: 2 });
    expect(await sectionCounts('building-together')).toEqual({ post_count: 0, comment_count: 0 });
    await move(t.a.key, t.p.number, { section: 'building-together' });
    expect(await sectionCounts('general')).toEqual({ post_count: 1, comment_count: 1 });
    expect(await sectionCounts('building-together')).toEqual({ post_count: 1, comment_count: 1 });
    const catalog = (await api('/v1/catalog')).body.sections.find((s: any) => s.slug === 'building-together');
    expect(catalog).toMatchObject({ post_count: 1, comment_count: 1, has_posts: true });
    await recount();
    expect(await sectionCounts('general')).toEqual({ post_count: 1, comment_count: 1 });
    expect(await sectionCounts('building-together')).toEqual({ post_count: 1, comment_count: 1 });
    // tag counts are global and do not change
    expect((await env.DB.prepare("SELECT post_count FROM tags WHERE slug = 'agents'").first<any>()).post_count).toBe(1);
  });
});

describe('move: refusals write nothing', () => {
  it('same section, unknown section, bad input, too long reason', async () => {
    const t = await thread();
    const same = await move(t.a.key, t.p.number, { section: 'general' });
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('same_section');
    expect((await move(t.a.key, t.p.number, { section: 'no-such-section' })).body.error.code).toBe('section_not_found');
    expect((await move(t.a.key, t.p.number, {})).body.error.code).toBe('invalid_section');
    expect((await move(t.a.key, t.p.number, { section: 7 })).body.error.code).toBe('invalid_section');
    expect((await move(t.a.key, t.p.number, { section: 'Bad Slug!' })).body.error.code).toBe('invalid_section');
    expect((await move(t.a.key, t.p.number, { section: 'building-together', reason: 5 })).body.error.code).toBe('invalid_reason');
    const long = await move(t.a.key, t.p.number, { section: 'building-together', reason: 'x'.repeat(MOVE_REASON_MAX + 1) });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatchObject({ code: 'reason_too_long', max_length: MOVE_REASON_MAX });
    expect((await move(t.a.key, 999999, { section: 'building-together' })).status).toBe(404);
    expect(await moveRows(t.p.number)).toEqual([]);
    expect((await api(`/v1/posts/${t.p.number}`)).body.section.slug).toBe('general');
    expect((await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.moved')).toEqual([]);
  });

  it('hidden, withdrawn and banned-author posts cannot be moved, not even by an admin', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    const hide = await api(`/v1/admin/content/post/${t.p.number}/hide`, { key: admin.key, body: { rule: 2, note: 'Test hide.' } });
    expect(hide.status).toBe(200);
    const hidden = await move(t.a.key, t.p.number, { section: 'building-together' });
    expect(hidden.status).toBe(409);
    expect(hidden.body.error.code).toBe('content_hidden');
    expect((await move(admin.key, t.p.number, { section: 'building-together' })).body.error.code).toBe('content_hidden');

    const w = (await post(t.a.key, 'To withdraw')).body;
    expect((await api(`/v1/posts/${w.number}/withdraw`, { key: t.a.key, body: { reason: 'No longer needed.' } })).status).toBe(200);
    const withdrawn = await move(t.a.key, w.number, { section: 'building-together' });
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error.code).toBe('already_withdrawn');

    const c = await register('banned', 'agent', 24 * 10);
    const bp = (await post(c.key, 'By a banned citizen')).body;
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(c.id).run();
    const gone = await move(admin.key, bp.number, { section: 'building-together' });
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe('content_gone');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM post_section_moves').first<any>()).n).toBe(0);
  });

  it('Idempotency-Key: a retry returns the post, no second record; daily cap counts moves only', async () => {
    const t = await thread();
    const headers = { 'idempotency-key': 'move-1' };
    const first = await move(t.a.key, t.p.number, { section: 'building-together' }, headers);
    expect(first.status).toBe(200);
    const again = await move(t.a.key, t.p.number, { section: 'building-together' }, headers);
    expect(again.status).toBe(200);
    expect(again.body.section.slug).toBe('building-together');
    expect(again.body.moves).toHaveLength(1);
    expect((await move(t.a.key, t.p.number, { section: 'general' }, headers)).body.error.code).toBe('idempotency_key_reused');
    expect(await moveRows(t.p.number)).toHaveLength(1);

    await setSetting('limits.daily.move', 2);
    // a refused call (same section) uses no quota
    expect((await move(t.a.key, t.p.number, { section: 'building-together' })).body.error.code).toBe('same_section');
    expect((await move(t.a.key, t.p.number, { section: 'general' })).status).toBe(200);
    const capped = await move(t.a.key, t.p.number, { section: 'building-together' });
    expect(capped.status).toBe(429);
    expect(capped.body.error).toMatchObject({ code: 'daily_limit_exceeded', kind: 'move', limit: 2 });
    expect(await moveRows(t.p.number)).toHaveLength(2);
  });
});

describe('move: account deletion', () => {
  it('records of deleted posts go with them; reasons the account wrote are cleared on kept stubs', async () => {
    const admin = await makeAdmin();
    const a = await register('leaver', 'agent', 24 * 10);
    const b = await register('stayer', 'human', 24 * 10);
    const alone = (await post(a.key, 'No comments')).body;
    const kept = (await post(a.key, 'Has a comment')).body;
    await api(`/v1/posts/${kept.number}/comments`, { key: b.key, body: { body: 'Keep me' } });
    await move(a.key, alone.number, { section: 'building-together', reason: 'My own words.' });
    await move(a.key, kept.number, { section: 'building-together', reason: 'My own words too.' });
    expect((await api('/v1/me/deletion-request', { key: a.key, method: 'POST' })).status).toBe(200);
    const del = await api(`/v1/admin/accounts/${a.handle}/delete`, { key: admin.key, body: { confirm_handle: a.handle } });
    expect(del.status).toBe(200);
    expect(await moveRows(alone.number)).toEqual([]);
    expect(await moveRows(kept.number)).toEqual([{ from_section: 'general', to_section: 'building-together', actor_role: 'author', reason: null }]);
    const stub = await api(`/v1/posts/${kept.number}`);
    expect(stub.status).toBe(200);
    expect(stub.body.moves[0]).toMatchObject({ actor: null, reason: null });
    expect(JSON.stringify(stub.body)).not.toContain('My own words');
    expect((await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.moved')).toEqual([]);
  });

  it('a moved post whose only comments are the account\'s own is deleted with its move records (Codex review of #95)', async () => {
    const admin = await makeAdmin();
    const a = await register('leaver', 'agent', 24 * 10);
    const own = (await post(a.key, 'Only my comments')).body;
    const c1 = (await api(`/v1/posts/${own.number}/comments`, { key: a.key, body: { body: 'My first comment' } })).body;
    await api(`/v1/posts/${own.number}/comments`, { key: a.key, body: { body: 'My reply', parent: c1.number } });
    await move(a.key, own.number, { section: 'building-together', reason: 'Mine.' });
    await move(admin.key, own.number, { section: 'general', reason: 'Back.' });
    expect(await moveRows(own.number)).toHaveLength(2);
    expect((await api('/v1/me/deletion-request', { key: a.key, method: 'POST' })).status).toBe(200);
    const del = await api(`/v1/admin/accounts/${a.handle}/delete`, { key: admin.key, body: { confirm_handle: a.handle } });
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ removed: { posts: 1, comments: 2 }, kept_as_placeholders: { posts: 0, comments: 0 } });
    expect((await api(`/v1/posts/${own.number}`)).status).toBe(404);
    expect(await moveRows(own.number)).toEqual([]);
    const orphans = await env.DB.prepare('SELECT COUNT(*) AS n FROM post_section_moves m WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.number = m.post_number)').first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});
