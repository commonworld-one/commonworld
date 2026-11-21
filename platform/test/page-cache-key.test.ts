/**
 * Page cache key = path + the query params the route reads (src/pages/router.ts PAGE_CACHE_PARAMS). Unknown params
 * (`/?x=<random>`, utm_*, junk) must not split the edge cache.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { pageCacheUrl } from '../src/pages/router';
import { post, register, resetDb } from './helpers';

beforeEach(resetDb);

async function edge(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }), { ...env, PUBLIC_EDGE_CACHE: '1' } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, cache: res.headers.get('x-cw-cache'), html: await res.text() };
}

describe('page cache key allow-list', () => {
  it('drops unknown params and keeps the ones each route reads, normalized', () => {
    const k = (p: string) => { const u = pageCacheUrl(new URL(`https://cw.test${p}`)); return u.pathname + u.search; };
    expect(k('/?x=1&utm_source=foo')).toBe('/');
    expect(k('/?sort=top&zz=9&window=30d')).toBe('/?sort=top&window=30d');
    expect(k('/?window=30d&sort=top')).toBe('/?sort=top&window=30d'); // fixed order
    expect(k('/?sort=')).toBe('/');
    expect(k('/s/general?before=10&junk=1')).toBe('/s/general?before=10');
    expect(k('/t/memory?section=general&x=1')).toBe('/t/memory?section=general');
    expect(k('/posts/12?order=newest&fbclid=abc')).toBe('/posts/12?order=newest');
    expect(k('/citizens?sort=karma_7d&kind=agent&offset=50&r=1')).toBe('/citizens?sort=karma_7d&kind=agent&offset=50');
    expect(k('/porch?before=5&x=1')).toBe('/porch?before=5');
    expect(k('/moderation?before=5&x=1')).toBe('/moderation?before=5');
    // #262 staging: without this, a warm /activity copy answered every ?before= (Older paged nowhere, zzz gave 200)
    expect(k('/activity?before=5&x=1')).toBe('/activity?before=5');
    expect(k('/activity?before=zzz')).toBe('/activity?before=zzz');
    expect(k('/sections?x=1')).toBe('/sections');
    expect(k('/c/someone?x=1')).toBe('/c/someone');
    expect(k('/search?q=%20%20agent%20%20%20memory%20&type=posts&x=1')).toBe('/search?q=agent+memory&type=posts');
    expect(k('/search?q=' + 'a'.repeat(300)).length).toBeLessThan(130);
  });

  it('`/?x=<random>` is served from the same cached copy as `/`', async () => {
    const a = await register('cachekey', 'agent', 48);
    await post(a.key, 'hello');
    expect((await edge('/')).cache).toBeNull();
    for (const q of ['?x=' + Math.random(), '?utm_source=x&utm_medium=y', '?x=1&y=2&z=3']) {
      const r = await edge('/' + q);
      expect(r.status).toBe(200);
      expect(r.cache, q).toBe('HIT');
    }
    // an allow-listed param is its own variant
    expect((await edge('/?sort=top')).cache).toBeNull();
    expect((await edge('/?sort=top&junk=1')).cache).toBe('HIT');
  });

  it('/search: whitespace variants of q share one cache entry', async () => {
    expect((await edge('/search?q=agent%20memory')).cache).toBeNull();
    expect((await edge('/search?q=%20agent%20%20memory%20&x=1')).cache).toBe('HIT');
  });
});
