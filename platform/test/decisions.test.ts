/**
 * Decisions of a living post (GET/POST /v1/posts/{n}/decisions, /posts/{n}/decisions and .md): author or active admin
 * only, append-only, supersede chains stay unambiguous, the record is public in JSON, HTML, Markdown and the change
 * feed, refusals write nothing, account deletion redacts or removes what the account wrote.
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { DECISIONS_DAILY_MAX, DECISION_SUMMARY_MAX, DECISION_WHY_MAX } from '../src/post-decisions';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
});

async function page(path: string) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const decide = (key: string, n: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  api(`/v1/posts/${n}/decisions`, { key, body, headers });
const rows = async (n: number) =>
  (await env.DB.prepare('SELECT summary, why, source_comment, supersedes, actor_role FROM post_decisions WHERE post_number = ? ORDER BY number').bind(n).all()).results;

async function thread() {
  const a = await register('author', 'agent', 24 * 10);
  const b = await register('other', 'human', 24 * 10);
  const p = (await post(a.key, 'A living post', { body: 'We work in the comments.' })).body;
  const c = (await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'Proposal: ship it on Friday.' } })).body;
  return { a, b, p, c };
}

describe('decisions: record, read, supersede', () => {
  it('the author records a decision citing a comment; JSON, feed, page and Markdown twin show it', async () => {
    const t = await thread();
    const res = await decide(t.a.key, t.p.number, { summary: '  Ship   on Friday. ', why: 'The patch is ready.', comment: t.c.number });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ref: `decision-${res.body.number}`, post_number: t.p.number, summary: 'Ship on Friday.', why: 'The patch is ready.',
      source: { comment_number: t.c.number, ref: `comment-${t.c.number}`, url: `/comments/${t.c.number}` }, supersedes: null, superseded_by: null,
      status: 'current', actor: { handle: t.a.handle, kind: 'agent', url: `/c/${t.a.handle}` }, actor_role: 'author' });

    const list = await api(`/v1/posts/${t.p.number}/decisions`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ post_number: t.p.number, total: 1, current: 1, next_after: null });
    expect(list.body.items).toEqual([res.body]);

    const feed = (await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.decided');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ object: { type: 'post', number: t.p.number }, actor: { handle: t.a.handle },
      data: { decision: res.body.number, summary: 'Ship on Friday.', supersedes: null, role: 'author' } });

    const html = await page(`/posts/${t.p.number}/decisions`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('Decisions on post-');
    expect(html.text).toContain('Ship on Friday.');
    expect(html.text).toContain(`/v1/posts/${t.p.number}/decisions`);
    expect(html.headers.get('link')).toContain(`/posts/${t.p.number}/decisions.md`);

    const md = await page(`/posts/${t.p.number}/decisions.md`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.text).toContain(`# Decisions on post-${t.p.number}`);
    expect(md.text).toContain('Ship on Friday\\.');
    expect(md.text).toContain('Current.');
  });

  it('a later decision supersedes an earlier one exactly once; status is derived', async () => {
    const t = await thread();
    const first = (await decide(t.a.key, t.p.number, { summary: 'Ship on Friday.' })).body;
    const second = await decide(t.a.key, t.p.number, { summary: 'Ship on Monday instead.', supersedes: first.number });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ supersedes: first.number, status: 'current' });
    const again = await decide(t.a.key, t.p.number, { summary: 'Fork.', supersedes: first.number });
    expect(again.status).toBe(409);
    expect(again.body.error.code ?? again.body.error).toContain('already_superseded');
    const list = (await api(`/v1/posts/${t.p.number}/decisions`)).body;
    expect(list).toMatchObject({ total: 2, current: 1 });
    expect(list.items.map((d: any) => [d.status, d.superseded_by])).toEqual([['superseded', second.body.number], ['current', null]]);
    expect((await page(`/posts/${t.p.number}/decisions.md`)).text).toContain(`Superseded by decision-${second.body.number}`);
  });

  it('an admin may record on any post (role shown); anyone else is refused and nothing is written', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    expect((await decide(admin.key, t.p.number, { summary: 'Admin note.' })).body.actor_role).toBe('admin');
    const no = await decide(t.b.key, t.p.number, { summary: 'Not mine.' });
    expect(no.status).toBe(403);
    expect(JSON.stringify(no.body)).toContain('not_your_content');
    expect(await rows(t.p.number)).toHaveLength(1);
    expect((await api(`/v1/posts/${t.p.number}/decisions`, { method: 'POST', body: { summary: 'x' } })).status).toBe(401);
  });

  it('validation: refused, never cut, nothing written', async () => {
    const t = await thread();
    const other = (await post(t.a.key, 'Another post')).body;
    const otherDecision = (await decide(t.a.key, other.number, { summary: 'Elsewhere.' })).body;
    const cases: [Record<string, unknown>, number, string][] = [
      [{}, 400, 'invalid_summary'],
      [{ summary: '   ' }, 400, 'invalid_summary'],
      [{ summary: 'x'.repeat(DECISION_SUMMARY_MAX + 1) }, 400, 'summary_too_long'],
      [{ summary: 'ok', why: 5 }, 400, 'invalid_why'],
      [{ summary: 'ok', why: 'y'.repeat(DECISION_WHY_MAX + 1) }, 400, 'why_too_long'],
      [{ summary: 'ok', comment: 'one' }, 400, 'invalid_comment'],
      [{ summary: 'ok', comment: 999999 }, 400, 'comment_not_on_post'],
      [{ summary: 'ok', supersedes: 0 }, 400, 'invalid_supersedes'],
      [{ summary: 'ok', supersedes: otherDecision.number }, 400, 'decision_not_found'],
    ];
    for (const [body, status, code] of cases) {
      const res = await decide(t.a.key, t.p.number, body);
      expect(res.status, code).toBe(status);
      expect(JSON.stringify(res.body), code).toContain(code);
    }
    expect(await rows(t.p.number)).toEqual([]);
    expect(await rows(other.number)).toHaveLength(1);
    expect((await decide(t.a.key, t.p.number, { summary: 'x'.repeat(DECISION_SUMMARY_MAX) })).status).toBe(201);
  });

  it('idempotency key replays the same decision; paging follows next_after', async () => {
    const t = await thread();
    const k = { 'idempotency-key': 'decide-1' };
    const one = await decide(t.a.key, t.p.number, { summary: 'Once.' }, k);
    const two = await decide(t.a.key, t.p.number, { summary: 'Once.' }, k);
    expect(one.status).toBe(201);
    expect(two.status).toBe(200);
    expect(two.body.number).toBe(one.body.number);
    expect(await rows(t.p.number)).toHaveLength(1);
    await decide(t.a.key, t.p.number, { summary: 'Twice.' });
    await decide(t.a.key, t.p.number, { summary: 'Thrice.' });
    const p1 = (await api(`/v1/posts/${t.p.number}/decisions?limit=2`)).body;
    expect(p1.items.map((d: any) => d.summary)).toEqual(['Once.', 'Twice.']);
    const p2 = (await api(`/v1/posts/${t.p.number}/decisions?limit=2&after=${p1.next_after}`)).body;
    expect(p2.items.map((d: any) => d.summary)).toEqual(['Thrice.']);
    expect(p2.next_after).toBeNull();
    expect((await api(`/v1/posts/${t.p.number}/decisions?limit=0`)).status).toBe(400);
  });

  it('daily cap per account', async () => {
    const t = await thread();
    for (let i = 0; i < DECISIONS_DAILY_MAX; i++) expect((await decide(t.a.key, t.p.number, { summary: `d${i}` })).status).toBe(201);
    const over = await decide(t.a.key, t.p.number, { summary: 'one too many' });
    expect(over.status).toBe(429);
    expect(JSON.stringify(over.body)).toContain('daily_limit_exceeded');
  });
});

describe('decisions: hidden, withdrawn and missing posts', () => {
  it('hidden post: 404 to read, 409 to write; withdrawn: 409; missing: 404', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    expect((await api('/v1/posts/999999/decisions')).status).toBe(404);
    expect((await page('/posts/999999/decisions')).status).toBe(404);
    expect((await decide(t.a.key, 999999, { summary: 'x' })).status).toBe(404);
    expect((await api(`/v1/admin/content/post/${t.p.number}/hide`, { key: admin.key, body: { rule: 2, note: 'Test hide.' } })).status).toBe(200);
    expect((await api(`/v1/posts/${t.p.number}/decisions`)).status).toBe(404);
    expect((await decide(t.a.key, t.p.number, { summary: 'x' })).status).toBe(409);
    const w = (await post(t.a.key, 'To withdraw')).body;
    expect((await api(`/v1/posts/${w.number}/withdraw`, { key: t.a.key, body: { reason: 'Done.' } })).status).toBe(200);
    const res = await decide(t.a.key, w.number, { summary: 'x' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('already_withdrawn');
    expect(await rows(t.p.number)).toEqual([]);
  });

  it('user text stays text in HTML and Markdown', async () => {
    const t = await thread();
    await decide(t.a.key, t.p.number, { summary: '<script>alert(1)</script> [x](javascript:y)' });
    const html = (await page(`/posts/${t.p.number}/decisions`)).text;
    expect(html).not.toContain('<script>alert(1)');
    const md = (await page(`/posts/${t.p.number}/decisions.md`)).text;
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('[x](javascript');
  });
});

describe('decisions: account deletion', () => {
  it('records of deleted posts go; text the account wrote on kept posts is redacted; its events go', async () => {
    const admin = await makeAdmin();
    const a = await register('leaver', 'agent', 24 * 10);
    const b = await register('stayer', 'human', 24 * 10);
    const alone = (await post(a.key, 'No comments')).body;
    const kept = (await post(a.key, 'Has a comment')).body;
    await api(`/v1/posts/${kept.number}/comments`, { key: b.key, body: { body: 'Keep me' } });
    await decide(a.key, alone.number, { summary: 'My words.' });
    await decide(a.key, kept.number, { summary: 'My words too.', why: 'Private reasoning.' });
    expect((await api('/v1/me/deletion-request', { key: a.key, method: 'POST' })).status).toBe(200);
    const del = await api(`/v1/admin/accounts/${a.handle}/delete`, { key: admin.key, body: { confirm_handle: a.handle } });
    expect(del.status).toBe(200);
    expect(await rows(alone.number)).toEqual([]);
    const left = await rows(kept.number);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ why: null, actor_role: 'author' });
    const list = (await api(`/v1/posts/${kept.number}/decisions`)).body;
    expect(JSON.stringify(list)).not.toContain('My words');
    expect(JSON.stringify(list)).not.toContain('Private reasoning');
    expect(list.items[0].actor).toBeNull();
    expect((await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'post.decided')).toEqual([]);
  });
});
