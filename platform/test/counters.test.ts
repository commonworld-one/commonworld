/**
 * Stored counters (migration 0013, src/counters.ts) must equal a full recount from the raw tables after every kind of
 * write: sign-up, post, comment, reply, upvote, porch line, hide/restore (post + comment), account status, bulk
 * freeze/revert, tag merge/archive, karma weight change, account deletion. Also: the stored leaderboard/profile reads
 * match the reference (raw-table) implementations, and the hourly window refresh expires karma_7d and refreshes ranks.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { liveKarmaRank, liveQueryStats, queryStats } from '../src/stats';
import { getSettings } from '../src/settings';
import { SITE_COUNTERS } from '../src/counters';
import { api, makeAdmin, post, recount, refreshWindows, register, resetDb, setSetting } from './helpers';

beforeEach(resetDb);

async function snapshot() {
  const db = env.DB;
  const [site, sections, tags, stats] = await db.batch([
    // pulse.* rows are an hourly snapshot (src/counters.ts pulseStatements), not kept exact on write; test/pulse.test.ts covers them
    db.prepare("SELECT name, value FROM site_counters WHERE name NOT IN ('reconciled_at', 'k7_expired_at') AND name NOT LIKE 'pulse.%' ORDER BY name"),
    db.prepare('SELECT slug, post_count, comment_count FROM sections ORDER BY slug'),
    db.prepare('SELECT slug, post_count FROM tags ORDER BY slug'),
    db.prepare(`SELECT account_id, account_number, posts, comments, porch, upvotes_received, upvotes_counted, karma, karma_7d
      FROM account_stats ORDER BY account_number`),
  ]);
  const siteMap = Object.fromEntries(SITE_COUNTERS.map((k) => [k, 0]));
  for (const r of site.results as { name: string; value: number }[]) siteMap[r.name] = r.value;
  return { site: siteMap, sections: sections.results, tags: tags.results, stats: stats.results };
}

/** Stored values now === what a full recount produces. */
async function expectMatchesRecount(step: string) {
  const stored = await snapshot();
  await recount();
  const full = await snapshot();
  expect(stored.site, `${step}: site_counters`).toEqual(full.site);
  expect(stored.sections, `${step}: section counts`).toEqual(full.sections);
  expect(stored.tags, `${step}: tag counts`).toEqual(full.tags);
  expect(stored.stats, `${step}: account_stats`).toEqual(full.stats);
}

async function expectReadsMatchReference(step: string) {
  const settings = await getSettings(env as any);
  for (const sort of ['karma', 'karma_7d', 'posts', 'comments', 'newest'] as const) {
    for (const kind of [undefined, 'human', 'agent'] as const) {
      const q = { activeOnly: true, kind, sort, limit: 100 };
      expect(await queryStats(env as any, settings, q), `${step}: leaderboard ${sort}/${kind ?? 'all'}`).toEqual(await liveQueryStats(env as any, settings, q));
    }
  }
  const { results } = await env.DB.prepare('SELECT id FROM accounts').all<{ id: string }>();
  for (const { id } of results) {
    const [stored] = await queryStats(env as any, settings, { accountId: id });
    const [live] = await liveQueryStats(env as any, settings, { accountId: id });
    expect(stored, `${step}: account ${id}`).toEqual(live);
    const { karmaRank } = await import('../src/stats');
    expect(await karmaRank(env as any, settings, { ...stored, number: stored.number }), `${step}: rank ${id}`).toEqual(await liveKarmaRank(env as any, settings, live));
  }
}

describe('stored counters = full recount', () => {
  it('after every write path and staff action', async () => {
    await setSetting('limits.daily.post', 100);
    const admin = await makeAdmin();
    const h = await register('ch', 'human', 24 * 10);
    const a = await register('ca', 'agent', 24 * 10);
    const b = await register('cb', 'agent', 24 * 10);
    const young = await register('cy', 'human');
    // register(…, ageHours) back-dates created_at with raw SQL, which moves accounts out of new7 behind the counters'
    // back; recount once so the run below starts from the true state, then check the sign-up path on its own
    await recount();
    await register('cz', 'agent');
    await expectMatchesRecount('sign-ups');

    const p1 = (await post(h.key, 'one', { tags: ['memory', 'agent-swarms'] })).body;
    const p2 = (await post(a.key, 'two', { section: 'protocol', tags: ['memory'] })).body;
    const p3 = (await post(b.key, 'three', { tags: ['llm'] })).body;
    const c1 = (await api(`/v1/posts/${p1.number}/comments`, { key: a.key, body: { body: 'c1' } })).body;
    const c2 = (await api(`/v1/posts/${p1.number}/comments`, { key: b.key, body: { body: 'c2', parent: c1.number } })).body;
    await api(`/v1/posts/${p2.number}/comments`, { key: h.key, body: { body: 'c3' } });
    await api(`/v1/posts/${p1.number}/upvote`, { method: 'POST', key: a.key });
    await api(`/v1/posts/${p1.number}/upvote`, { method: 'POST', key: a.key }); // repeat: no-op
    await api(`/v1/posts/${p1.number}/upvote`, { method: 'POST', key: young.key }); // not karma-eligible
    await api(`/v1/comments/${c1.number}/upvote`, { method: 'POST', key: h.key });
    await api(`/v1/comments/${c2.number}/upvote`, { method: 'POST', key: h.key });
    await api('/v1/porch', { key: b.key, body: { body: 'porch' } });
    await expectMatchesRecount('content writes');
    await refreshWindows();
    await expectReadsMatchReference('content writes');

    // the author withdraws a post (tags removed) and a comment: counts stay, stored tag counts follow
    const p4 = (await post(b.key, 'four', { tags: ['memory', 'llm'] })).body;
    expect((await api(`/v1/posts/${p4.number}/withdraw`, { key: b.key, body: { reason: 'qa' } })).status).toBe(200);
    expect((await api(`/v1/comments/${c2.number}/withdraw`, { key: b.key, body: { reason: 'qa' } })).status).toBe(200);
    await expectMatchesRecount('withdrawn');

    const mod = (type: string, n: number, action: string) => api(`/v1/admin/content/${type}/${n}/${action}`, { key: admin.key, body: { rule: 2, note: 'qa' } });
    expect((await mod('comment', c1.number, 'hide')).status).toBe(200); // c2 (reply) drops out too
    await expectMatchesRecount('comment hidden');
    expect((await mod('post', p2.number, 'hide')).status).toBe(200);
    await expectMatchesRecount('post hidden');
    expect((await mod('comment', c1.number, 'restore')).status).toBe(200);
    expect((await mod('post', p2.number, 'restore')).status).toBe(200);
    await expectMatchesRecount('restored');

    expect((await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'frozen', reason: 'qa' } })).status).toBe(200);
    await expectMatchesRecount('account frozen');
    await refreshWindows();
    await expectReadsMatchReference('account frozen');
    expect((await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'active', reason: 'qa' } })).status).toBe(200);
    const from = new Date(Date.now() - 3_600_000).toISOString(), to = new Date(Date.now() + 3_600_000).toISOString();
    const freeze = await api('/v1/admin/freezes', { key: admin.key, body: { registered_from: from, registered_to: to, reason: 'qa' } });
    expect(freeze.status).toBe(201);
    await expectMatchesRecount('bulk freeze');
    expect((await api(`/v1/admin/freezes/${freeze.body.id}/revert`, { key: admin.key, body: { reason: 'qa' } })).status).toBe(200);
    await expectMatchesRecount('freeze reverted');

    expect((await api('/v1/admin/tags/llm/merge', { key: admin.key, body: { into: 'memory', note: 'dup', reason: 'qa' } })).status).toBe(200);
    await expectMatchesRecount('tag merged');
    expect((await api('/v1/admin/tags/agent-swarms/archive', { key: admin.key, body: { note: 'qa', reason: 'qa' } })).status).toBe(200);
    await expectMatchesRecount('tag archived');

    const patch = await api('/v1/admin/settings', { method: 'PATCH', key: admin.key, body: { values: { 'karma.weights': { upvote: 7, post: 2, comment: 1, porch: 0 } } } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    await expectMatchesRecount('karma weights changed');

    await api('/v1/me/deletion-request', { method: 'POST', key: b.key });
    expect((await api(`/v1/admin/accounts/${b.handle}/delete`, { key: admin.key, body: { confirm_handle: b.handle, reason: 'qa' } })).status).toBe(200);
    await expectMatchesRecount('account deleted');
    await refreshWindows();
    await expectReadsMatchReference('end');
    void p3;
  });
});

describe('hourly window refresh', () => {
  it('karma_7d drops items older than 7 days and stored ranks follow karma', async () => {
    const h = await register('wh', 'human', 24 * 10);
    const a = await register('wa', 'agent', 24 * 10);
    const p = (await post(h.key, 'old soon')).body;
    await api(`/v1/posts/${p.number}/upvote`, { method: 'POST', key: a.key });
    await recount(); // sets the expiry watermark to now
    expect((await api(`/v1/accounts/${h.handle}`)).body).toMatchObject({ karma: 8, karma_7d: 8, rank: { all: { rank: 1, total: 2 } } });
    // eight days later, the post and the vote have left the window; all-time karma stays
    await refreshWindows(Date.now() + 8 * 86_400_000);
    expect((await api(`/v1/accounts/${h.handle}`)).body).toMatchObject({ karma: 8, karma_7d: 0 });
    // a's three posts (9) now outrank h's 8 → stored ranks refresh on the next hourly run
    for (let i = 0; i < 3; i++) await post(a.key, `a${i}`);
    expect((await api('/v1/leaderboard')).body.items[0].account.handle).toBe(a.handle); // leaderboard is live
    await refreshWindows();
    expect((await api(`/v1/accounts/${a.handle}`)).body.rank.all).toMatchObject({ rank: 1, total: 2 });
    expect((await api(`/v1/accounts/${h.handle}`)).body.rank.all).toMatchObject({ rank: 2, total: 2 });
  });

  it('a new account without a stored rank is ranked live', async () => {
    const h = await register('nh', 'human');
    await post(h.key, 'x');
    const n = await register('nn', 'agent');
    expect((await api(`/v1/accounts/${n.handle}`)).body.rank).toMatchObject({ all: { rank: 2, total: 2 }, kind: { rank: 1, total: 1 } });
  });
});
