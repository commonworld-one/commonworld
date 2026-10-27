/**
 * Decisions of a living post (GET/POST /v1/posts/{n}/decisions, /posts/{n}/decisions and .md): author or active admin
 * only, append-only, supersede chains stay unambiguous, the record is public in JSON, HTML, Markdown and the change
 * feed, refusals write nothing, account deletion redacts or removes what the account wrote.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { MAX_LINK_DOMAINS, resetLinkCheckMemo } from '../src/link-check';
import { DECISION_SUMMARY_MAX, DECISION_WHY_MAX } from '../src/post-decisions';
import { DEFAULTS } from '../src/settings';
import { metamask } from '../src/trust-engine/index.ts';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  resetLinkCheckMemo();
  await resetDb();
  await env.DB.prepare('DELETE FROM link_checks').run();
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

  it('daily cap per account (setting limits.daily.decision, default 30)', async () => {
    expect(DEFAULTS['limits.daily.decision']).toBe(30);
    const t = await thread();
    for (let i = 0; i < (DEFAULTS['limits.daily.decision'] as number); i++) expect((await decide(t.a.key, t.p.number, { summary: `d${i}` })).status).toBe(201);
    const over = await decide(t.a.key, t.p.number, { summary: 'one too many' });
    expect(over.status).toBe(429);
    expect(JSON.stringify(over.body)).toContain('daily_limit_exceeded');
  });

  it('the daily cap follows the live setting; null = no cap; refused calls use no quota', async () => {
    const t = await thread();
    await setSetting('limits.daily.decision', 2);
    expect((await decide(t.a.key, t.p.number, { summary: '' })).status).toBe(400);
    expect((await decide(t.a.key, t.p.number, { summary: 'one' })).status).toBe(201);
    expect((await decide(t.a.key, t.p.number, { summary: 'two' })).status).toBe(201);
    const over = await decide(t.a.key, t.p.number, { summary: 'three' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'daily_limit_exceeded', kind: 'decision' });
    await setSetting('limits.daily.decision', null);
    expect((await decide(t.a.key, t.p.number, { summary: 'three' })).status).toBe(201);
  });
});

describe('decisions: the post page links them', () => {
  it('no link without decisions; a nofollow link once one is recorded; the post JSON shape is unchanged', async () => {
    const t = await thread();
    const before = await page(`/posts/${t.p.number}`);
    expect(before.status).toBe(200);
    expect(before.text).not.toContain(`/posts/${t.p.number}/decisions`);
    await decide(t.a.key, t.p.number, { summary: 'Ship on Friday.' });
    const after = await page(`/posts/${t.p.number}`);
    expect(after.text).toContain(`<a rel="nofollow" href="/posts/${t.p.number}/decisions">Decisions recorded on post-${t.p.number}</a>`);
    const json = (await api(`/v1/posts/${t.p.number}`)).body;
    expect(json).not.toHaveProperty('has_decisions');
    expect(json).not.toHaveProperty('has_moves');
    // another post without decisions still shows no link
    const other = (await post(t.a.key, 'Quiet post')).body;
    expect((await page(`/posts/${other.number}`)).text).not.toContain(`/posts/${other.number}/decisions`);
  });

  it('the decisions page ignores ?limit (it is cached under after only): always a full page', async () => {
    const t = await thread();
    await decide(t.a.key, t.p.number, { summary: 'First call.' });
    await decide(t.a.key, t.p.number, { summary: 'Second call.' });
    for (const path of [`/posts/${t.p.number}/decisions?limit=1`, `/posts/${t.p.number}/decisions.md?limit=1`]) {
      const res = await page(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('First call');
      expect(res.text, path).toContain('Second call');
    }
    expect((await api(`/v1/posts/${t.p.number}/decisions?limit=1`)).body.items).toHaveLength(1);
  });

  it('llms.txt maps the decisions read next to Connections', async () => {
    const res = await page('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('- Decisions: `GET /v1/posts/{number}/decisions?after=0`');
  });
});

describe('decisions: link check (src/link-check.ts)', () => {
  function sources() {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u === metamask.url) return new Response(JSON.stringify({ version: 2, fuzzylist: [], whitelist: [], blacklist: ['drainer.example'] }));
      return new Response('not found', { status: 404 });
    }) as typeof fetch);
  }
  async function decideOnline(key: string, n: number, body: Record<string, unknown>) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://api.test/v1/posts/${n}/decisions`, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...env, LINK_CHECK_OFFLINE: '0' } as any, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: await res.json<any>() };
  }

  it('a flagged link in why or summary refuses the decision (422); nothing written, no quota used; rejection recorded', async () => {
    const t = await thread();
    await setSetting('limits.daily.decision', 1);
    sources();
    const r = await decideOnline(t.a.key, t.p.number, { summary: 'Ship it.', why: 'Details at https://app.drainer.example/claim' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('link_flagged');
    expect(r.body.error.domains[0].domain).toBe('app.drainer.example');
    expect((await decideOnline(t.a.key, t.p.number, { summary: 'see www.drainer.example' })).status).toBe(422);
    expect(await rows(t.p.number)).toEqual([]);
    const checks = (await env.DB.prepare('SELECT object_type, outcome FROM link_checks ORDER BY id').all()).results;
    expect(checks).toEqual([{ object_type: 'post', outcome: 'rejected' }, { object_type: 'post', outcome: 'rejected' }]);
    // the cap of 1 is still free: refusals used no quota; a clean link goes through and is recorded as allowed
    const ok = await decideOnline(t.a.key, t.p.number, { summary: 'Ship it.', why: 'Patch: https://good.example/pr/1' });
    expect(ok.status).toBe(201);
    expect((await env.DB.prepare("SELECT outcome FROM link_checks ORDER BY id DESC").first<any>()).outcome).toBe('allowed');
  });

  it(`more than ${MAX_LINK_DOMAINS} different domains: 400 too_many_link_domains, nothing written`, async () => {
    const t = await thread();
    sources();
    const why = Array.from({ length: MAX_LINK_DOMAINS + 1 }, (_, i) => `https://d${i}.example`).join(' ');
    const r = await decideOnline(t.a.key, t.p.number, { summary: 'Links.', why });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('too_many_link_domains');
    expect(await rows(t.p.number)).toEqual([]);
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

  it('banned (disabled) author: 410 to read and to write, even for an admin; nothing written', async () => {
    const t = await thread();
    const admin = await makeAdmin();
    expect((await api(`/v1/admin/accounts/${t.a.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: 'decisions test' } })).status).toBe(200);
    expect((await api(`/v1/posts/${t.p.number}/decisions`)).status).toBe(410);
    const res = await decide(admin.key, t.p.number, { summary: 'Nobody could read this.' });
    expect(res.status).toBe(410);
    expect(JSON.stringify(res.body)).toContain('content_gone');
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
