/** Free tags (owner decision 2026-10-17): up to 5 per post, unknown slugs created on first use, staff tag merge. */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
});

const page = async (path: string) => {
  const r: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: r.status, headers: r.headers, html: await r.text() };
};
const tagRow = (slug: string) => env.DB.prepare('SELECT * FROM tags WHERE slug = ?').bind(slug).first<any>();

describe('free tags', () => {
  it('creates an unknown tag on first use (name = slug) with one public tag.created event; reuse does not', async () => {
    const a = await register();
    const r = await post(a.key, 'new tag', { tags: ['agent-swarms', 'memory'] });
    expect(r.status).toBe(201);
    expect(r.body.tags).toEqual(['agent-swarms', 'memory']);
    expect(await tagRow('agent-swarms')).toMatchObject({ name: 'agent-swarms', status: 'active', merged_into: null });
    await post(a.key, 'again', { tags: ['agent-swarms'] });
    const feed = (await api('/v1/feed')).body.items.filter((e: any) => e.type === 'tag.created');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ object: { type: 'tag', ref: `tag-${(await tagRow('agent-swarms')).number}` }, actor: { handle: a.handle }, data: { slug: 'agent-swarms' } });
    const cat = (await api('/v1/catalog')).body;
    expect(cat.tags.find((t: any) => t.slug === 'agent-swarms')).toMatchObject({ post_count: 2, has_posts: true });
    expect(cat.tags).toHaveLength(68);
  });

  it('limits: at most 5 tags, slug rule, max 32 chars, no duplicates; input is lowercased', async () => {
    const a = await register();
    for (const tags of [['a', 'b', 'c', 'd', 'e', 'f'], ['bad slug'], ['-x'], ['a--b'], ['x'.repeat(33)], ['dup', 'dup'], ['Dup', 'dup'], [7]]) {
      const r = await post(a.key, 'x', { tags });
      expect(r.status, JSON.stringify(tags)).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'invalid_tags', max_tags: 5, max_length: 32 });
    }
    expect(await tagRow('bad slug')).toBeNull();
    expect((await post(a.key, 'five', { tags: ['a', 'b', 'c', 'd', 'x'.repeat(32)] })).status).toBe(201);
    expect((await post(a.key, 'upper', { tags: [' MiXed-Case '] })).body.tags).toEqual(['mixed-case']);
  });

  it('existing posts with more than 5 tags are left as they are', async () => {
    const a = await register();
    const p = (await post(a.key, 'old', { tags: ['memory'] })).body;
    await env.DB.batch(['agents', 'identity', 'design', 'porch', 'trust', 'provenance'].map((t) => env.DB.prepare('INSERT INTO post_tags (post_number, tag_slug) VALUES (?, ?)').bind(p.number, t)));
    expect((await api(`/v1/posts/${p.number}`)).body.tags).toHaveLength(7);
  });
});

describe('tag merge', () => {
  it('moves posts to the target (dedupe), marks the source merged, logs publicly; old links and filters resolve', async () => {
    const admin = await makeAdmin();
    const a = await register();
    const p1 = (await post(a.key, 'one', { tags: ['llm', 'agents'] })).body;
    const p2 = (await post(a.key, 'two', { tags: ['llm', 'models'] })).body;
    const r = await api('/v1/admin/tags/llm/merge', { key: admin.key, body: { into: 'models', note: 'Duplicate of #models.', reason: 'private' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tag: { slug: 'llm', status: 'merged', merged_into: 'models' }, into: { slug: 'models' }, posts_moved: 2, note: 'Duplicate of #models.', moderator: { handle: admin.handle } });
    expect(await tagRow('llm')).toMatchObject({ status: 'merged', merged_into: 'models' });
    expect((await api(`/v1/posts/${p1.number}`)).body.tags).toEqual(['agents', 'models']);
    expect((await api(`/v1/posts/${p2.number}`)).body.tags).toEqual(['models']);
    // catalog lists active tags only; filters by the old slug resolve to the target
    const cat = (await api('/v1/catalog')).body;
    expect(cat.tags.find((t: any) => t.slug === 'llm')).toBeUndefined();
    expect(cat.tags.find((t: any) => t.slug === 'models').post_count).toBe(2);
    expect((await api('/v1/posts?tag=llm')).body.items.map((x: any) => x.number).sort()).toEqual([p1.number, p2.number].sort());
    // a new post tagged with the old slug gets the target
    expect((await post(a.key, 'three', { tags: ['llm', 'models'] })).body.tags).toEqual(['models']);
    // old page 301s
    const old = await page('/t/llm?sort=top');
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('/t/models?sort=top');
    // public log + feed; private reason stays in the staff action log
    const log = (await api('/v1/moderation')).body;
    expect(log.counts).toMatchObject({ merged: 1 });
    expect(log.items[0]).toMatchObject({ type: 'tag.merged', note: 'Duplicate of #models.', rule: null, moderator: { handle: admin.handle },
      object: { type: 'tag', status_now: 'merged' }, merged_into: { from: 'llm', into: 'models', posts_moved: 2 } });
    expect(JSON.stringify(log)).not.toContain('private');
    const ev = (await api('/v1/feed')).body.items.find((e: any) => e.type === 'tag.merged');
    expect(ev).toMatchObject({ object: { type: 'tag' }, actor: { handle: admin.handle }, data: { from: 'llm', into: 'models', note: 'Duplicate of #models.' } });
    expect(JSON.stringify(ev)).not.toContain('private');
    const actions = (await api('/v1/admin/actions', { key: admin.key })).body.items;
    expect(actions[0]).toMatchObject({ action: 'tag.merge', target_type: 'tag', reason: 'private', note: 'Duplicate of #models.' });
    const mod = await page('/moderation');
    expect(mod.html).toContain('#llm → <a href="/t/models">#models</a>');
  });

  it('chains stay one hop; validation and permissions', async () => {
    const admin = await makeAdmin();
    const a = await register();
    await post(a.key, 'x', { tags: ['llm'] });
    const merge = (from: string, body: unknown, key = admin.key) => api(`/v1/admin/tags/${from}/merge`, { key, body });
    expect((await merge('llm', { into: 'models', note: 'dup' }, a.key)).status).toBe(403);
    expect((await merge('llm', { into: 'models' })).body.error.code).toBe('note_required');
    expect((await merge('llm', { into: 'llm', note: 'x' })).body.error.code).toBe('invalid_merge_target');
    expect((await merge('llm', { into: 'nope', note: 'x' })).body.error).toMatchObject({ code: 'tag_not_found', slug: 'nope' });
    expect((await merge('nope', { into: 'models', note: 'x' })).body.error).toMatchObject({ code: 'tag_not_found', slug: 'nope' });
    expect((await merge('llm', { into: 'models', note: 'dup' })).status).toBe(200);
    expect((await merge('llm', { into: 'agents', note: 'again' })).body.error.code).toBe('tag_already_merged');
    expect((await merge('agents', { into: 'llm', note: 'into merged' })).body.error).toMatchObject({ code: 'tag_not_found', slug: 'llm' });
    expect((await merge('models', { into: 'agents', note: 'wider' })).status).toBe(200);
    expect(await tagRow('llm')).toMatchObject({ merged_into: 'agents' });
    expect((await page('/t/llm')).headers.get('location')).toBe('/t/agents');
  });
});

describe('staff tag archive + daily cap on new tags', () => {
  const archive = (key: string, slug: string, body: Record<string, unknown>) => api(`/v1/admin/tags/${slug}/archive`, { key, body });

  it('archives a tag: removed from posts, out of the catalog, unusable, public tag.archived entry', async () => {
    const admin = await makeAdmin();
    const a = await register();
    const p1 = (await post(a.key, 'spam 1', { tags: ['buy-now', 'memory'] })).body;
    await post(a.key, 'spam 2', { tags: ['buy-now'] });
    expect((await archive(a.key, 'buy-now', { note: 'x' })).status).toBe(403);
    expect((await archive(admin.key, 'buy-now', {})).body.error.code).toBe('note_required');
    const r = await archive(admin.key, 'buy-now', { note: 'Spam tag.', reason: 'private' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ tag: { slug: 'buy-now', status: 'archived' }, posts_untagged: 2, note: 'Spam tag.', moderator: { handle: admin.handle } });
    expect(await tagRow('buy-now')).toMatchObject({ status: 'archived' });
    expect((await api(`/v1/posts/${p1.number}`)).body.tags).toEqual(['memory']);
    expect((await api('/v1/catalog')).body.tags.find((t: any) => t.slug === 'buy-now')).toBeUndefined();
    expect((await post(a.key, 'again', { tags: ['buy-now'] })).body.error).toMatchObject({ code: 'tag_not_found', slug: 'buy-now' });
    expect((await page('/t/buy-now')).status).toBe(404);
    expect((await archive(admin.key, 'buy-now', { note: 'again' })).body.error.code).toBe('tag_not_active');
    const log = (await api('/v1/moderation')).body;
    expect(log.counts).toMatchObject({ archived: 1 });
    expect(log.items[0]).toMatchObject({ type: 'tag.archived', note: 'Spam tag.', rule: null, archived_tag: { slug: 'buy-now', posts_untagged: 2 } });
    expect(JSON.stringify(log)).not.toContain('private');
    expect((await api('/v1/feed')).body.items.some((e: any) => e.type === 'tag.archived')).toBe(true);
    expect((await page('/moderation')).html).toContain('mod-archive');
  });

  it('caps brand-new tags per account per UTC day (limits.new_tags_per_day); existing tags and trusted accounts are not limited', async () => {
    await setSetting('limits.new_tags_per_day', 3);
    const a = await register();
    expect((await post(a.key, 'p1', { tags: ['n-one', 'n-two'] })).status).toBe(201);
    const over = await post(a.key, 'p2', { tags: ['n-three', 'n-four'] });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'rate_limit_exceeded', scope: 'new_tags_daily', limit: 3 });
    expect(await tagRow('n-three')).toBeNull();
    expect((await post(a.key, 'p3', { tags: ['n-three', 'n-one', 'memory'] })).status).toBe(201); // 1 new: fits
    expect((await post(a.key, 'p4', { tags: ['n-one', 'n-two', 'memory'] })).status).toBe(201);   // nothing new
    expect((await post(a.key, 'p5', { tags: ['n-five'] })).status).toBe(429);
    const admin = await makeAdmin();
    expect((await post(admin.key, 'staff', { tags: ['s-1', 's-2', 's-3', 's-4'] })).status).toBe(201);
  });
});
