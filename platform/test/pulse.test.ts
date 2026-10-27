/**
 * GET /v1/pulse, its page /pulse and the Markdown twin /pulse.md.
 * The rule under test: Pulse reads stored public numbers only — the site counters, the activity windows and
 * moderation totals the hourly cron stores (src/counters.ts pulseStatements) — with the public change feed's
 * visibility rule, and the three formats never disagree.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { api, makeAdmin, post, recount, refreshWindows, register, resetDb } from './helpers';
import { pulseData } from '../src/pulse';
import { PULSE_MOD_TYPES } from '../src/counters';
import { MODERATION_LOG_TYPES } from '../src/routes/moderation';
import { plural } from '../src/pages/html';

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
    expect(d.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(d.totals).toMatchObject({ citizens: 0, humans: 0, agents: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, new_citizens_7d: 0, porch_lines_24h: 0 });
    expect(d.activity_24h).toMatchObject({ citizens: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, withdrawn: 0 });
    expect(d.activity_7d).toMatchObject({ citizens: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, withdrawn: 0, active_citizens: 0 });
    expect(d.sections.length).toBeGreaterThan(0);
    expect(d.sections[0]).toMatchObject({ posts: 0, comments: 0 });
    expect(d.sections[0].url).toMatch(/^\/s\/[a-z0-9-]+$/);
    expect(d.moderation).toEqual({ hidden: 0, restored: 0, upheld: 0, merged: 0, archived: 0, recoveries: 0 });
    // per-day activity: 7 consecutive UTC days, oldest first, the last one is the UTC day of the count
    expect(d.activity_7d.days).toHaveLength(7);
    const last = (d.counted_at ?? d.generated_at).slice(0, 10);
    expect(d.activity_7d.days[6].date).toBe(last);
    for (let i = 0; i < 7; i++) {
      expect(d.activity_7d.days[i]).toEqual({ date: new Date(Date.parse(`${last}T00:00:00Z`) - (6 - i) * 86_400_000).toISOString().slice(0, 10), posts: 0, comments: 0, porch_lines: 0, citizens: 0, upvotes: 0 });
    }
  });

  it('counts what citizens actually did, in both windows and in the totals, once the hourly count ran', async () => {
    const a = await register('pulse-writer', 'agent', 24 * 10);
    const b = await register('pulse-reader', 'human', 24 * 10);
    const c = await register('pulse-new', 'agent');
    const mine = await post(a.key, 'Pulse check');
    await api(`/v1/posts/${mine.body.number}/comments`, { key: b.key, body: { body: 'Seen.' } });
    await api('/v1/porch', { key: a.key, body: { body: 'A line.' } });
    await api(`/v1/posts/${mine.body.number}/upvote`, { key: b.key, method: 'POST' });
    await api('/v1/posts', { key: a.key, body: { title: 'Moved later', body: 'x', section: 'general' } });
    await refreshWindows();

    const r = await api('/v1/pulse');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.counted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(d.totals).toMatchObject({ citizens: 3, humans: 1, agents: 2, posts: 2, comments: 1, porch_lines: 1, upvotes: 1 });
    // new citizens: active accounts that joined in the window (the two writers were aged 10 days), one source with new7
    expect(d.totals.new_citizens_7d).toBe(1);
    expect(d.activity_24h.citizens).toBe(1);
    expect(d.activity_7d.citizens).toBe(d.totals.new_citizens_7d);
    for (const w of [d.activity_24h, d.activity_7d]) expect(w).toMatchObject({ posts: 2, comments: 1, porch_lines: 1, upvotes: 1 });
    expect(d.activity_7d.active_citizens).toBe(2);
    expect(c.handle).toBeTruthy();
    const general = d.sections.find((s: any) => s.slug === 'general');
    expect(general).toMatchObject({ posts: 2, comments: 1 });
    // today's bar holds everything (the two writers' accounts are 10 days old, so only pulse-new joined today)
    const days = d.activity_7d.days;
    expect(days[6]).toMatchObject({ date: d.counted_at.slice(0, 10), posts: 2, comments: 1, porch_lines: 1, upvotes: 1, citizens: 1 });
    for (const k of ['posts', 'comments', 'porch_lines', 'upvotes'] as const) expect(days.reduce((n: number, x: any) => n + x[k], 0)).toBe(d.activity_7d[k]);
  });

  it('activity outside 24 hours counts in the 7-day window only; a post.moved event is not activity', async () => {
    const a = await register('pulse-old', 'agent', 24 * 10);
    const mine = await post(a.key, 'Three days ago');
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await env.DB.prepare(`UPDATE events SET created_at = ? WHERE type = 'post.created' AND object_number = ?`).bind(old, mine.body.number).run();
    await env.DB.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, created_at) VALUES ('post.moved', 'post', ?, ?, ?)`)
      .bind(mine.body.number, a.id, new Date().toISOString()).run();
    await refreshWindows();
    const d = (await api('/v1/pulse')).body;
    expect(d.activity_24h.posts).toBe(0);
    expect(d.activity_7d.posts).toBe(1);
    expect(d.activity_7d.active_citizens).toBe(1);
    // the post lands on its own UTC day in the week chart, not on today
    const day = d.activity_7d.days.find((x: any) => x.date === old.slice(0, 10));
    expect(day).toMatchObject({ posts: 1 });
    expect(d.activity_7d.days[6].posts).toBe(0);
  });

  it('per-day counts follow the public feed rule too: a hidden post leaves its day', async () => {
    const admin = await makeAdmin();
    const a = await register('pulse-dayhide', 'agent', 24 * 10);
    const bad = await post(a.key, 'Hidden later');
    await post(a.key, 'Stays');
    await refreshWindows();
    expect((await api('/v1/pulse')).body.activity_7d.days[6].posts).toBe(2);
    expect((await api(`/v1/admin/content/post/${bad.body.number}/hide`, { key: admin.key, method: 'POST', body: { rule: 2, note: 'Test hide.' } })).status).toBe(200);
    await refreshWindows();
    expect((await api('/v1/pulse')).body.activity_7d.days[6].posts).toBe(1);
  });

  it('a withdrawn post keeps its tombstone in the totals and both events in the activity window', async () => {
    const a = await register('pulse-ghost', 'agent', 24 * 10);
    const mine = await post(a.key, 'Gone soon');
    await api(`/v1/posts/${mine.body.number}/withdraw`, { key: a.key, method: 'POST', body: { reason: 'Said too much.' } });
    await recount();

    const d = (await api('/v1/pulse')).body;
    // a withdrawn post keeps status 'visible' (it renders as a tombstone), so it still counts
    expect(d.totals.posts).toBe(1);
    expect(d.activity_24h).toMatchObject({ posts: 1, withdrawn: 1 });
  });

  it('applies the public feed rule: events about hidden content and from disabled citizens are not counted', async () => {
    const admin = await makeAdmin();
    const a = await register('pulse-hidden', 'agent', 24 * 10);
    const b = await register('pulse-banned', 'agent', 24 * 10);
    const c = await register('pulse-fine', 'human', 24 * 10);
    const hidden = await post(a.key, 'Rule breaker');
    await post(b.key, 'Soon banned');
    await post(c.key, 'Fine post');
    await api(`/v1/posts/${hidden.body.number}/upvote`, { key: c.key, method: 'POST' });
    await refreshWindows();
    expect((await api('/v1/pulse')).body.activity_24h).toMatchObject({ posts: 3, upvotes: 1 });

    expect((await api(`/v1/admin/content/post/${hidden.body.number}/hide`, { key: admin.key, method: 'POST', body: { rule: 2, note: 'Test hide.' } })).status).toBe(200);
    expect((await api(`/v1/admin/accounts/${b.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: 'test' } })).status).toBe(200);
    await refreshWindows();
    const d = (await api('/v1/pulse')).body;
    // the hidden post and the upvote on it drop out, the disabled citizen's post too; only the fine post stays
    expect(d.activity_24h).toMatchObject({ posts: 1, upvotes: 0 });
    expect(d.activity_7d.active_citizens).toBe(1);
  });

  it('moderation totals follow the public log counts (the hide recounts in its own batch)', async () => {
    const admin = await makeAdmin();
    const a = await register('pulse-mod', 'agent', 24 * 10);
    const mine = await post(a.key, 'Rule breaker');
    const hide = await api(`/v1/admin/content/post/${mine.body.number}/hide`, { key: admin.key, method: 'POST', body: { rule: 2, note: 'Test hide.' } });
    expect(hide.status).toBe(200);

    const r = await api('/v1/pulse');
    expect(r.body.moderation).toMatchObject({ hidden: 1, restored: 0 });
    // the hourly count adds only events past its watermark (no double count); the nightly recount starts from zero
    await refreshWindows();
    await refreshWindows();
    expect((await api('/v1/pulse')).body.moderation.hidden).toBe(1);
    await recount();
    expect((await api('/v1/pulse')).body.moderation.hidden).toBe(1);
    const log = await api('/v1/moderation');
    expect(log.body.counts.hidden).toBe(1);
  });

  it('counts the same moderation event types as the public log', () => {
    expect([...PULSE_MOD_TYPES]).toEqual([...MODERATION_LOG_TYPES]);
  });

  it('anonymous hits are served from the Workers cache', async () => {
    const call = async () => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request('https://api.test/v1/pulse?junk=1'), { ...env, PUBLIC_EDGE_CACHE: '1' } as any, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const first = await call();
    expect(['MISS', 'HIT']).toContain(first.headers.get('x-cw-cache'));
    const second = await call();
    expect(second.headers.get('x-cw-cache')).toBe('HIT');
    expect(second.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });
});

describe('pulse page and markdown twin', () => {
  it('/pulse renders the totals with correct plurals and links the twins and Atlas stats', async () => {
    await register('pulse-page', 'agent');
    const res = await page('/pulse');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.text).toContain('Pulse');
    expect(res.text).toContain('/v1/pulse');
    expect(res.text).toContain('/pulse.md');
    expect(res.text).toContain('<b>1</b> agent<');
    expect(res.text).toContain('<b>0</b> humans<');
    expect(res.text).not.toContain('1 agents');
    expect(res.text).toContain('https://commonworld.one/stats/');
    expect(res.text).not.toContain('anyone can recount');
  });

  it('/pulse counted state: live status, week chart from the per-day counts, section bars, clean moderation line', async () => {
    const a = await register('pulse-busy', 'agent', 24 * 10);
    const mine = await post(a.key, 'Busy day');
    await api(`/v1/posts/${mine.body.number}/comments`, { key: a.key, body: { body: 'One comment.' } });
    await refreshWindows();
    const res = await page('/pulse');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Live · counted');
    expect(res.text).not.toContain('First count coming within the hour');
    expect(res.text).toContain('class="wk wk-wide"');
    expect(res.text).toContain('class="wk wk-narrow"');
    expect(res.text).toContain('Today so far: <span class="n">1 post</span> and <span class="n">1 comment</span>.');
    expect(res.text).toContain('<b>1 post</b> · 1 comment');
    expect(res.text).toMatch(/sections<\/b> waiting for their first post|section<\/b> waiting for its first post/);
    expect(res.text).toContain('href="/sections">Browse all sections');
    expect(res.text).toContain('Clean record.');
    expect(res.text).not.toContain('1 posts');
    expect(res.text).not.toContain('1 comments');
  });

  it('/pulse before the first hourly count: waiting status, no quiet-day or clean-record claims, empty week', async () => {
    await register('pulse-early', 'agent');
    await page('/pulse'); // the first read fills the counters; drop the pulse rows to get "never counted"
    await env.DB.prepare(`DELETE FROM site_counters WHERE name LIKE 'pulse.%'`).run();
    expect((await api('/v1/pulse')).body.counted_at).toBeNull();
    const res = await page('/pulse');
    expect(res.status).toBe(200);
    expect(res.text).toContain('First count coming within the hour');
    expect(res.text).toContain('today: after first count');
    expect(res.text).toContain('The weekly chart starts with the first hourly count');
    expect(res.text).not.toContain('class="wk wk-wide"');
    expect(res.text).not.toContain('Quiet day');
    expect(res.text).not.toContain('Clean record');
  });

  it('/pulse is CSP-clean: no style attributes, no <style>, inline scripts only with the nonce', async () => {
    const a = await register('pulse-csp', 'agent', 24 * 10);
    await post(a.key, 'CSP check');
    await refreshWindows();
    for (const counted of [true, false]) {
      if (!counted) await env.DB.prepare(`DELETE FROM site_counters WHERE name LIKE 'pulse.%'`).run();
      const res = await page('/pulse');
      expect(res.headers.get('content-security-policy')).toContain("style-src 'self'");
      expect(res.text).not.toMatch(/\sstyle\s*=/i);
      expect(res.text).not.toMatch(/<style[\s>]/i);
      for (const tag of res.text.match(/<script\b[^>]*>/gi) ?? []) expect(tag).toMatch(/\bsrc=|\bnonce=|type="application\/ld\+json"/);
    }
  });

  it('/pulse.md answers markdown with the same numbers', async () => {
    await register('pulse-md', 'agent');
    const res = await page('/pulse.md');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.text).toContain('# Pulse: Commonworld in numbers');
    expect(res.text).toContain('- Citizens: 1 (0 humans, 1 agent)');
    expect(res.text).toContain('## Last 7 days by day (UTC)');
  });

  it('/pulse.md says "1 post, 1 comment" (singular) in the sections list and the per-day lines', async () => {
    const a = await register('pulse-md-one', 'agent', 24 * 10);
    const mine = await post(a.key, 'Only one');
    await api(`/v1/posts/${mine.body.number}/comments`, { key: a.key, body: { body: 'Only one comment.' } });
    await refreshWindows();
    const res = await page('/pulse.md');
    expect(res.text).toContain('/s/general) · 1 post, 1 comment');
    expect(res.text).toMatch(/- \d{4}-\d{2}-\d{2}: 1 post, 1 comment, 0 porch lines, 0 upvotes, 0 new citizens/);
    expect(res.text).not.toMatch(/\b1 (posts|comments|porch lines|upvotes|new citizens)\b/);
    expect(res.text).toContain('/v1/pulse');
    expect(res.text).toContain('https://commonworld.one/stats/');
  });

  it('plural() says "1 citizen" and "2 agents"', () => {
    expect(plural(1, 'citizen')).toBe('1 citizen');
    expect(plural(0, 'human')).toBe('0 humans');
    expect(plural(2, 'agent')).toBe('2 agents');
  });

  it('the data layer alone returns the same shape the API and the twins render', async () => {
    const d = await pulseData(env as any);
    expect(d.totals.citizens).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(d.sections)).toBe(true);
  });
});
