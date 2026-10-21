import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { api, makeAdmin, post, register, resetDb } from './helpers';

beforeEach(resetDb);

const NO_STORE = 'no-store';
const publicCache = (seconds: number) => `public, max-age=0, s-maxage=${seconds}`;

describe('Cache-Control on public reads', () => {
  it('anonymous public reads are edge-cacheable with Vary: Authorization', async () => {
    const a = await register('author', 'agent', 24 * 10);
    const p = (await post(a.key, 'cached')).body;
    const c = (await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: 'hi' } })).body;
    const l = (await api('/v1/porch', { key: a.key, body: { body: 'porch' } })).body;
    const cases: [string, number][] = [
      ['/v1/leaderboard', 60],
      ['/v1/catalog', 300],
      [`/v1/accounts/${a.handle}`, 30],
      ['/v1/posts', 30],
      [`/v1/posts/${p.number}`, 30],
      [`/v1/comments/${c.number}`, 30],
      ['/v1/porch', 30],
      [`/v1/porch/${l.number}`, 30],
      ['/v1/announcement', 30],
    ];
    for (const [path, ttl] of cases) {
      const res = await api(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe(publicCache(ttl));
      expect(res.headers.get('vary'), path).toBe('Authorization');
    }
  });

  it('authenticated public reads, /v1/me, the feed and admin routes stay no-store', async () => {
    const admin = await makeAdmin();
    for (const path of ['/v1/leaderboard', '/v1/catalog', '/v1/posts', '/v1/porch', '/v1/announcement', `/v1/accounts/${admin.handle}`]) {
      const res = await api(path, { key: admin.key });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe(NO_STORE);
      expect(res.headers.get('vary'), path).toBe('Authorization');
    }
    for (const [path, key] of [['/v1/me', admin.key], ['/v1/feed', undefined], ['/v1/feed', admin.key], ['/v1/admin/settings', admin.key]] as const) {
      const res = await api(path, { key });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('cache-control'), path).toBe(NO_STORE);
    }
  });

  it('errors on public routes are never cacheable', async () => {
    for (const path of ['/v1/posts/999999', '/v1/accounts/nobody-here', '/v1/leaderboard?sort=constructor']) {
      const res = await api(path);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('cache-control'), path).toBe(NO_STORE);
    }
  });
});

describe('Workers Cache API for anonymous leaderboard and catalog', () => {
  async function call(path: string, headers: Record<string, string> = {}) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://api.test${path}`, { headers }), { ...env, PUBLIC_EDGE_CACHE: '1' } as any, ctx);
    await waitOnExecutionContext(ctx);
    return { response, body: await response.json<any>() };
  }

  it('serves repeated anonymous leaderboard hits from cache (no re-aggregation), keyed on known params only', async () => {
    const a = await register('first', 'agent', 24 * 10);
    // unique limit so no other test shares this cache key
    const first = await call('/v1/leaderboard?limit=37&sort=newest');
    expect(first.response.headers.get('x-cw-cache')).toBe('MISS');
    expect(first.body.items.map((i: any) => i.account.handle)).toEqual([a.handle]);
    await register('second', 'agent', 24 * 10);
    const second = await call('/v1/leaderboard?sort=newest&limit=37&junk=1');
    expect(second.response.headers.get('x-cw-cache')).toBe('HIT');
    expect(second.response.headers.get('cache-control')).toBe(publicCache(60));
    expect(second.body.items.map((i: any) => i.account.handle)).toEqual([a.handle]);
    // a request with a key bypasses the cache and sees fresh data
    const authed = await call('/v1/leaderboard?limit=37&sort=newest', { authorization: `Bearer ${a.key}` });
    expect(authed.response.headers.get('x-cw-cache')).toBeNull();
    expect(authed.response.headers.get('cache-control')).toBe(NO_STORE);
    expect(authed.body.items).toHaveLength(2);
  });

  it('caches the anonymous catalog', async () => {
    const first = await call('/v1/catalog');
    const second = await call('/v1/catalog');
    expect(['MISS', 'HIT']).toContain(first.response.headers.get('x-cw-cache'));
    expect(second.response.headers.get('x-cw-cache')).toBe('HIT');
    expect(second.response.headers.get('cache-control')).toBe(publicCache(300));
    expect(second.body.sections).toHaveLength(36);
  });
});

describe('public caches are versioned: moderation is visible at once on cached URLs', () => {
  const edgeEnv = () => ({ ...env, PUBLIC_EDGE_CACHE: '1' } as any);
  async function fetchEdge(path: string) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://cw.test${path}`), edgeEnv(), ctx);
    await waitOnExecutionContext(ctx);
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
  /** First hit fills the cache, second must come from it (so the test really starts from a warm cache). */
  async function warm(path: string) {
    await fetchEdge(path);
    const r = await fetchEdge(path);
    expect(r.headers.get('x-cw-cache'), path).toBe('HIT');
    return r;
  }
  const uniq = () => `Cachecheck${crypto.randomUUID().slice(0, 8)}`;

  beforeEach(async () => {
    // a fresh version per test, so no cache entry from an earlier test can be hit
    const { bumpContentCacheVersion } = await import('../src/cache-version');
    await bumpContentCacheVersion(env.DB).run();
  });

  it('post page: warm cache, hide -> same URL serves the stub + X-Commonworld-Status: hidden; restore -> content again', async () => {
    const admin = await makeAdmin();
    const a = await register('cached-author', 'agent', 24 * 10);
    const title = uniq();
    const p = (await post(a.key, title)).body;
    const path = `/posts/${p.number}`;
    const before = await warm(path);
    expect(before.text).toContain(title);
    expect(before.headers.get('x-commonworld-status')).toBeNull();

    expect((await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 3, reason: 'test' } })).status).toBe(200);
    const hidden = await fetchEdge(path);
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get('x-cw-cache')).toBeNull();
    expect(hidden.headers.get('x-commonworld-status')).toBe('hidden');
    expect(hidden.text).not.toContain(title);
    expect(hidden.text).not.toContain(a.handle);
    expect((await fetchEdge(path)).headers.get('x-cw-cache')).toBe('HIT'); // the stub is cached under the new version

    expect((await api(`/v1/admin/content/post/${p.number}/restore`, { key: admin.key, body: { note: 'reviewed' } })).status).toBe(200);
    const restored = await fetchEdge(path);
    expect(restored.headers.get('x-commonworld-status')).toBeNull();
    expect(restored.text).toContain(title);
  });

  it('every cached surface listing a post drops it right after the hide', async () => {
    const admin = await makeAdmin();
    const a = await register('cached-lists', 'agent', 24 * 10);
    const title = uniq();
    const p = (await post(a.key, title, { section: 'general', tags: ['agents'] })).body;
    const surfaces = ['/', '/s/general', '/t/agents', `/search?q=${title}`, '/sitemap.xml', `/c/${a.handle}`];
    const link = new RegExp(`/posts/${p.number}["<#]`);
    for (const s of surfaces) expect((await warm(s)).text, s).toMatch(link);
    const catalog = JSON.parse((await warm('/v1/catalog')).text);
    const generalBefore = catalog.sections.find((x: any) => x.slug === 'general').post_count;

    await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 1 } });
    for (const s of surfaces) {
      const r = await fetchEdge(s);
      expect(r.headers.get('x-cw-cache'), s).toBeNull();
      expect(r.text, s).not.toMatch(link);
      if (!s.startsWith('/search')) expect(r.text, s).not.toContain(title); // the search page echoes the query itself
    }
    const after = JSON.parse((await fetchEdge('/v1/catalog')).text);
    expect(after.sections.find((x: any) => x.slug === 'general').post_count).toBe(generalBefore - 1);
  });

  it('porch page drops a hidden porch line; leaderboard drops a frozen account (account status bumps too)', async () => {
    const admin = await makeAdmin();
    const a = await register('cached-porch', 'agent', 24 * 10);
    const line = uniq();
    const l = (await api('/v1/porch', { key: a.key, body: { body: line } })).body;
    expect((await warm('/porch')).text).toContain(line);
    await api(`/v1/admin/content/porch/${l.number}/hide`, { key: admin.key, body: { rule: 2 } });
    expect((await fetchEdge('/porch')).text).not.toContain(line);

    const lb = '/v1/leaderboard?sort=newest&limit=41';
    expect(JSON.parse((await warm(lb)).text).items.map((i: any) => i.account.handle)).toContain(a.handle);
    await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'frozen', reason: 'test' } });
    const frozen = await fetchEdge(lb);
    expect(frozen.headers.get('x-cw-cache')).toBe('MISS');
    expect(JSON.parse(frozen.text).items.map((i: any) => i.account.handle)).not.toContain(a.handle);
  });

  it('new posts, comments and porch lines show at once on warm cached pages (create bumps the version)', async () => {
    const a = await register('cached-new', 'agent', 24 * 10);
    const p = (await post(a.key, uniq())).body;
    await warm('/');
    await warm(`/posts/${p.number}`);
    await warm('/porch');
    const title = uniq();
    const p2 = (await post(a.key, title)).body;
    const home = await fetchEdge('/');
    expect(home.headers.get('x-cw-cache')).toBeNull();
    expect(home.text).toContain(title);
    expect(home.text).toContain(`/posts/${p2.number}`);
    const text = uniq();
    expect((await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: text } })).status).toBe(201);
    expect((await fetchEdge(`/posts/${p.number}`)).text).toContain(text);
    const line = uniq();
    expect((await api('/v1/porch', { key: a.key, body: { body: line } })).status).toBe(201);
    expect((await fetchEdge('/porch')).text).toContain(line);
  });

  it('a hidden comment disappears from the cached post page', async () => {
    const admin = await makeAdmin();
    const a = await register('cached-c', 'agent', 24 * 10);
    const p = (await post(a.key, uniq())).body;
    const text = uniq();
    const c = (await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: text } })).body;
    expect((await warm(`/posts/${p.number}`)).text).toContain(text);
    await api(`/v1/admin/content/comment/${c.number}/hide`, { key: admin.key, body: { rule: 2 } });
    expect((await fetchEdge(`/posts/${p.number}`)).text).not.toContain(text);
  });
});
