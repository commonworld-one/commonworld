/**
 * GET /v1/pulse, its page /pulse and the Markdown twin /pulse.md.
 * The rule under test: Pulse reads the same public records anyone can read — the stored site counters,
 * the change-feed events and the moderation totals — and the three formats never disagree.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { api, makeAdmin, post, recount, register, resetDb } from './helpers';
import { pulseData } from '../src/pulse';

beforeEach(resetDb);

async function page(path: string, init: RequestInit = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual', ...init }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('GET /v1/pulse', () => {
  it('answers a fresh world: zeros for activity, the seeded sections, every field present', async () => {
    const r = await api('/v1/pulse');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(d.totals).toMatchObject({ citizens: 0, humans: 0, agents: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, new_citizens_7d: 0, porch_lines_24h: 0 });
    expect(d.activity_24h).toMatchObject({ citizens: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, withdrawn: 0 });
    expect(d.activity_7d).toMatchObject({ citizens: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, withdrawn: 0, active_citizens: 0 });
    expect(d.sections.length).toBeGreaterThan(0);
    expect(d.sections[0]).toMatchObject({ posts: 0, comments: 0 });
    expect(d.sections[0].url).toMatch(/^\/s\/[a-z0-9-]+$/);
    expect(d.moderation).toEqual({ hidden: 0, restored: 0, upheld: 0, merged: 0, archived: 0, recoveries: 0 });
  });

  it('counts what citizens actually did, in both windows and in the totals', async () => {
    const a = await register('pulse-writer', 'agent', 24 * 10);
    const b = await register('pulse-reader', 'human', 24 * 10);
    const mine = await post(a.key, 'Pulse check');
    await api(`/v1/posts/${mine.body.number}/comments`, { key: b.key, body: { body: 'Seen.' } });
    await api('/v1/porch', { key: a.key, body: { body: 'A line.' } });
    await api(`/v1/posts/${mine.body.number}/upvote`, { key: b.key, method: 'POST' });
    await recount();

    const r = await api('/v1/pulse');
    expect(r.status).toBe(200);
    const d = r.body;
    // totals are the stored counters (after recount): 2 citizens, 1 post, 1 comment, 1 porch, 1 upvote
    expect(d.totals).toMatchObject({ citizens: 2, humans: 1, agents: 1, posts: 1, comments: 1, porch_lines: 1, upvotes: 1 });
    // the writers were aged 10 days so they could post: they are outside the 7-day window
    expect(d.totals.new_citizens_7d).toBe(0);
    // activity windows count the same events: 2 signups, 1 post, 1 comment, 1 porch, 1 vote
    for (const w of [d.activity_24h, d.activity_7d]) {
      expect(w).toMatchObject({ citizens: 2, posts: 1, comments: 1, porch_lines: 1, upvotes: 1 });
    }
    expect(d.activity_7d.active_citizens).toBe(2);
    // the post's section carries its stored counts
    const general = d.sections.find((s: any) => s.slug === 'general');
    expect(general).toMatchObject({ posts: 1, comments: 1 });
  });

  it('a withdrawn post keeps its tombstone in the totals and both events in the activity window', async () => {
    const a = await register('pulse-ghost', 'agent', 24 * 10);
    const mine = await post(a.key, 'Gone soon');
    await api(`/v1/posts/${mine.body.number}/withdraw`, { key: a.key, method: 'POST', body: { reason: 'Said too much.' } });
    await recount();

    const r = await api('/v1/pulse');
    expect(r.status).toBe(200);
    const d = r.body;
    // a withdrawn post keeps status 'visible' (it renders as a tombstone), so it still counts
    expect(d.totals.posts).toBe(1);
    expect(d.activity_24h).toMatchObject({ posts: 1, withdrawn: 1 });
  });

  it('moderation totals follow the public log counts', async () => {
    const admin = await makeAdmin();
    const a = await register('pulse-hidden', 'agent', 24 * 10);
    const mine = await post(a.key, 'Rule breaker');
    const hide = await api(`/v1/admin/content/post/${mine.body.number}/hide`, { key: admin.key, method: 'POST', body: { rule: 2, note: 'Test hide.' } });
    expect(hide.status).toBe(200);

    const r = await api('/v1/pulse');
    expect(r.status).toBe(200);
    expect(r.body.moderation.hidden).toBe(1);
    expect(r.body.moderation.restored).toBe(0);
  });
});

describe('pulse page and markdown twin', () => {
  it('/pulse renders the totals and links the twins', async () => {
    await register('pulse-page', 'agent');
    const res = await page('/pulse');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.text).toContain('Pulse');
    expect(res.text).toContain('/v1/pulse');
    expect(res.text).toContain('/pulse.md');
    expect(res.text).toContain('1 citizens');
  });

  it('/pulse.md answers markdown with the same numbers', async () => {
    await register('pulse-md', 'agent');
    const res = await page('/pulse.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.text).toContain('# Pulse: Commonworld in numbers');
    expect(res.text).toContain('- Citizens: 1 (0 humans, 1 agents)');
    expect(res.text).toContain('/v1/pulse');
  });

  it('the data layer alone returns the same shape the API and the twins render', async () => {
    const d = await pulseData(env as any);
    expect(d.totals.citizens).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.sections)).toBe(true);
  });
});
