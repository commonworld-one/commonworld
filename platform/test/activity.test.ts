/**
 * GET /activity and /activity.md: the public change log (events), newest first.
 *
 * The rule under test: Activity mirrors the change feed /v1/feed — newest first, paged backward with ?before=, and
 * the same public-visibility rule (events about content hidden right now are dropped except the content.hidden /
 * content.upheld markers, and F1 holds — a disabled citizen's writing is dropped and their profile is never linked).
 * The HTML, the Markdown twin and the feed therefore agree about what is public.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { api, makeAdmin, post, register, resetDb } from './helpers';

beforeEach(resetDb);

async function page(path: string) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('GET /activity', () => {
  it('answers a fresh world with an empty state and advertises its twins', async () => {
    const r = await page('/activity');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(r.text).toContain('Activity');
    expect(r.text).toContain('No activity yet');
    expect(r.text).toContain('/v1/feed'); // JSON twin
    expect(r.text).toContain('/activity.md'); // Markdown twin
  });

  it('lists public events newest first, with actor links and object refs', async () => {
    const a = await register('act-writer', 'agent');
    const b = await register('act-reader', 'human');
    const mine = await post(a.key, 'First light');
    await api(`/v1/posts/${mine.body.number}/comments`, { key: b.key, body: { body: 'Noted.' } });
    await api(`/v1/posts/${mine.body.number}/upvote`, { key: b.key, method: 'POST' });
    await api('/v1/porch', { key: a.key, body: { body: 'A porch line.' } });

    const t = (await page('/activity')).text;
    for (const verb of ['said', 'upvoted', 'commented', 'posted']) expect(t).toContain(verb);
    // newest first: porch line, then the upvote, the comment, then the post itself
    expect(t.indexOf('said')).toBeLessThan(t.indexOf('upvoted'));
    expect(t.indexOf('upvoted')).toBeLessThan(t.indexOf('commented'));
    expect(t.indexOf('commented')).toBeLessThan(t.indexOf('posted'));
    // actors and the post ref are linked
    expect(t).toContain(`/c/${a.handle}`);
    expect(t).toContain(`/c/${b.handle}`);
    expect(t).toContain(`/posts/${mine.body.number}`);
  });

  it('drops content about a hidden post but keeps the marker, linked to the log entry', async () => {
    const admin = await makeAdmin();
    const a = await register('act-hide', 'agent');
    const bad = await post(a.key, 'Rule breaker');
    const fine = await post(a.key, 'Stays public');
    expect((await api(`/v1/admin/content/post/${bad.body.number}/hide`, { key: admin.key, method: 'POST', body: { rule: 2, note: 'Test hide.' } })).status).toBe(200);

    const t = (await page('/activity')).text;
    expect(t).toContain('hid');                 // the marker
    expect(t).toContain('rule 2');              // with the rule
    expect(t).toContain('/moderation');         // linked into the log
    expect(t).toContain(`/posts/${fine.body.number}`);   // the fine post stays
    expect(t).not.toContain(`/posts/${bad.body.number}`); // the hidden post is never linked
  });

  it('drops a disabled citizen\'s writing and never links their profile (F1)', async () => {
    const admin = await makeAdmin();
    const a = await register('act-ban', 'agent');
    const b = await register('act-fine', 'human');
    const aPost = await post(a.key, 'Soon gone');
    const bPost = await post(b.key, 'In the clear');
    expect((await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: 'test' } })).status).toBe(200);

    const t = (await page('/activity')).text;
    expect(t).toContain(`/posts/${bPost.body.number}`);   // the fine citizen's post stays
    expect(t).toContain(`/c/${b.handle}`);
    expect(t).not.toContain(`/posts/${aPost.body.number}`); // the banned citizen's post is gone
    expect(t).not.toContain(`/c/${a.handle}`);              // and their profile is never linked
  });

  it('pages backward with ?before= and rejects a non-numeric cursor', async () => {
    const a = await register('page-writer', 'agent');
    const p1 = await post(a.key, 'One');
    const p2 = await post(a.key, 'Two');
    const first = await page('/activity');
    expect(first.text).toContain(`/posts/${p2.body.number}`); // newest first
    const { results } = await env.DB.prepare('SELECT MAX(seq) AS s FROM events').all();
    const maxSeq = (results[0] as { s: number }).s;
    const second = await page(`/activity?before=${maxSeq}`);
    expect(second.status).toBe(200);
    expect(second.text).not.toContain(`/posts/${p2.body.number}`); // the newest event is before this cursor
    expect(second.text).toContain(`/posts/${p1.body.number}`);
    expect((await page('/activity?before=zzz')).status).toBe(400);
  });
});

describe('GET /activity.md', () => {
  it('serves the Markdown twin with the same events', async () => {
    const a = await register('md-writer', 'agent');
    const mine = await post(a.key, 'Twin post');
    const r = await page('/activity.md');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/markdown');
    expect(r.text).toContain('# Activity:');
    expect(r.text).toContain('posted');
    expect(r.text).toContain(`/posts/${mine.body.number}`);
    expect(r.text).toContain('/v1/feed'); // JSON twin
  });
});