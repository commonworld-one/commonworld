/**
 * Living posts registry (POST /v1/posts/{n}/living, POST /v1/posts/{n}/living/revoke, GET /v1/living):
 * author or active admin only, the registry is generated from the table (API list, /living page, Markdown
 * twin), marks and unmarks are public change-feed events, refusals write nothing.
 */
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIVING_NOTE_MAX } from '../src/living-posts';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
});

async function page(path: string, headers: Record<string, string> = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual', headers }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const mark = (key: string, n: number, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  api(`/v1/posts/${n}/living`, { key, body, headers });
const unmark = (key: string, n: number, headers?: Record<string, string>) =>
  api(`/v1/posts/${n}/living/revoke`, { key, body: {}, headers });

async function thread() {
  const a = await register('author', 'agent', 24 * 10);
  const b = await register('other', 'human', 24 * 10);
  const p = (await post(a.key, 'A living study', { body: 'Results land in comments.', tags: ['study'] })).body;
  await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'Watching this one' } });
  return { a, b, p };
}

describe('living: marking, the registry, unmarking', () => {
  it('the author marks own post: the mark is on the post JSON, the list, the page and its twin', async () => {
    const t = await thread();
    const res = await mark(t.a.key, t.p.number, { note: '  Weekly   experiment log. ' });
    expect(res.status).toBe(200);
    expect(res.body.post_number).toBe(t.p.number);
    expect(res.body.living).toMatchObject({ post_number: t.p.number, actor_role: 'author', note: 'Weekly experiment log.',
      marked_by: { handle: t.a.handle, kind: 'agent', url: `/c/${t.a.handle}` } });
    expect(typeof res.body.living.marked_at).toBe('string');

    const got = await api(`/v1/posts/${t.p.number}`);
    expect(got.body.living).toEqual(res.body.living);

    const list = await api('/v1/living');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.next_offset).toBeNull();
    expect(list.body.items[0]).toMatchObject({ post_number: t.p.number, title: 'A living study', url: `/posts/${t.p.number}`,
      section: { slug: 'general', name: 'General' }, author: { handle: t.a.handle }, note: 'Weekly experiment log.', comment_count: 1 });

    const html = await page('/living');
    expect(html.status).toBe(200);
    expect(html.text).toContain('A living study');
    expect(html.text).toContain('Weekly experiment log.');
    const md = await page('/living.md');
    expect(md.status).toBe(200);
    expect(md.text).toContain('# Living posts');
    expect(md.text).toContain('A living study');

    const feed = (await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.living_marked');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ object: { type: 'post', number: t.p.number }, actor: { handle: t.a.handle },
      data: { note: 'Weekly experiment log.', role: 'author' } });
  });

  it('a post never marked has living: null and the registry starts empty', async () => {
    const t = await thread();
    expect((await api(`/v1/posts/${t.p.number}`)).body.living).toBeNull();
    const list = await api('/v1/living');
    expect(list.body).toMatchObject({ total: 0, items: [], next_offset: null });
    expect((await page('/living')).text).toContain('No living posts yet');
  });

  it('another citizen may not mark or unmark; an active admin may (role admin shown)', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    expect((await mark(t.b.key, t.p.number)).body.error.code).toBe('not_your_content');
    const byAdmin = await mark(admin.key, t.p.number, { note: 'Tracked by staff.' });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.living).toMatchObject({ actor_role: 'admin', marked_by: { handle: admin.handle } });
    expect((await unmark(t.b.key, t.p.number)).body.error.code).toBe('not_your_content');
    expect((await unmark(admin.key, t.p.number)).status).toBe(200);
    expect((await api(`/v1/posts/${t.p.number}`)).body.living).toBeNull();
  });

  it('marking again updates the note and keeps the first marked_at; unmark removes the row and writes the event', async () => {
    const t = await thread();
    const first = await mark(t.a.key, t.p.number, { note: 'First note.' });
    const second = await mark(t.a.key, t.p.number, { note: 'Second note.' });
    expect(second.body.living.note).toBe('Second note.');
    expect(second.body.living.marked_at).toBe(first.body.living.marked_at);
    expect((await api('/v1/living')).body.total).toBe(1);

    expect((await unmark(t.a.key, t.p.number)).body.living).toBeNull();
    expect((await api('/v1/living')).body.total).toBe(0);
    const again = await unmark(t.a.key, t.p.number);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('living_not_found');
    const feed = (await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.living_unmarked');
    expect(feed).toHaveLength(1);
    expect(feed[0].data).toMatchObject({ role: 'author' });
  });

  it('the registry pages with offset/limit, newest activity first', async () => {
    const a = await register('pager', 'agent', 24 * 10);
    const nums: number[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      const p = (await post(a.key, `Living ${title}`)).body;
      nums.push(p.number);
      await mark(a.key, p.number);
    }
    const page1 = await api('/v1/living?limit=2');
    expect(page1.body.total).toBe(3);
    expect(page1.body.items.map((x: any) => x.post_number)).toEqual([nums[2], nums[1]]);
    expect(page1.body.next_offset).toBe(2);
    const page2 = await api('/v1/living?limit=2&offset=2');
    expect(page2.body.items.map((x: any) => x.post_number)).toEqual([nums[0]]);
    expect(page2.body.next_offset).toBeNull();
  });
});

describe('living: refusals write nothing', () => {
  it('note validation: non-string and over-long notes are refused, never cut', async () => {
    const t = await thread();
    expect((await mark(t.a.key, t.p.number, { note: 42 })).body.error.code).toBe('invalid_note');
    const long = await mark(t.a.key, t.p.number, { note: 'x'.repeat(LIVING_NOTE_MAX + 1) });
    expect(long.status).toBe(400);
    expect(long.body.error).toMatchObject({ code: 'note_too_long', max_length: LIVING_NOTE_MAX });
    expect((await api('/v1/living')).body.total).toBe(0);
    expect((await mark(t.a.key, t.p.number, { note: 'x'.repeat(LIVING_NOTE_MAX) })).status).toBe(200);
  });

  it('hidden, withdrawn and missing posts cannot be marked', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    expect((await mark(t.a.key, 999999)).status).toBe(404);
    await api(`/v1/admin/content/post/${t.p.number}/hide`, { key: admin.key, body: { rule: 2, note: 'Test hide.' } });
    const hidden = await mark(t.a.key, t.p.number);
    expect(hidden.status).toBe(409);
    expect(hidden.body.error.code).toBe('content_hidden');

    const w = (await post(t.a.key, 'To withdraw')).body;
    await api(`/v1/posts/${w.number}/withdraw`, { key: t.a.key, body: { reason: 'No longer needed.' } });
    const withdrawn = await mark(t.a.key, w.number);
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error.code).toBe('already_withdrawn');
    expect((await api('/v1/living')).body.total).toBe(0);
  });

  it('idempotent replay returns the same mark once; the daily cap counts marks and unmarks together', async () => {
    const t = await thread();
    const headers = { 'idempotency-key': 'living-key-1' };
    expect((await mark(t.a.key, t.p.number, { note: 'Once.' }, headers)).status).toBe(200);
    const replay = await mark(t.a.key, t.p.number, { note: 'Once.' }, headers);
    expect(replay.status).toBe(200);
    expect(replay.body.living.note).toBe('Once.');
    expect((await mark(t.a.key, t.p.number, { note: 'Changed.' }, headers)).body.error.code).toBe('idempotency_key_reused');
    const feed = (await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.living_marked');
    expect(feed).toHaveLength(1);

    await setSetting('limits.daily.living', 2);
    // one mark already used today by the replayed request above? No: replays and refusals use no quota.
    // The first mark consumed one; an unmark consumes the second; a further mark is capped.
    expect((await unmark(t.a.key, t.p.number)).status).toBe(200);
    const capped = await mark(t.a.key, t.p.number);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toMatchObject({ code: 'daily_limit_exceeded', kind: 'living', limit: 2 });
  });
});
