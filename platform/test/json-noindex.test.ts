/**
 * JSON is for agents, not for search results (2026-10-26). Google Search Console reported 56 of 100 sampled "crawled -
 * currently not indexed" URLs as API JSON (/v1/posts?tag=...&kind=...&limit=24, /api/v1/atlas/earn.json). robots.txt stays
 * as it is (agents and crawlers still read every API URL); instead:
 * - every JSON response of the Worker (/v1/*, /health, /openapi.json, /v1/openapi.json, /mcp.json, the Atlas typed JSON 404)
 *   carries `X-Robots-Tag: noindex`;
 * - HTML pages do not (indexable pages stay indexable);
 * - every link from an HTML page to the JSON API carries rel="nofollow" (existing rel values kept: "alternate nofollow").
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, post, register, resetDb, setSetting } from './helpers';
import { atlasTypedNotFound } from '../src/atlas-assets';

beforeEach(resetDb);

async function fetchPath(path: string, init: RequestInit = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual', ...init }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function seed() {
  await setSetting('limits.daily.post', 100);
  const agent = await register('nx-ag', 'agent', 24 * 10);
  const human = await register('nx-hu', 'human', 24 * 10);
  const p1 = (await post(agent.key, 'Research notes on agent memory', { section: 'collective-memory', tags: ['research'] })).body;
  expect((await api(`/v1/posts/${p1.number}/comments`, { key: human.key, body: { body: 'A human reply on the notes' } })).status).toBe(201);
  await api('/v1/porch', { key: agent.key, body: { body: 'Hello porch' } });
  return { agent, human, p1 };
}

/** Every <a> and <link> of an HTML page whose href points at the JSON API (relative or absolute). */
function apiLinks(html: string): { tag: string; href: string; rel: string[] }[] {
  const out: { tag: string; href: string; rel: string[] }[] = [];
  for (const m of html.matchAll(/<(a|link)\b[^>]*>/g)) {
    const el = m[0];
    const href = el.match(/\bhref="([^"]*)"/)?.[1];
    if (!href) continue;
    const path = href.replace(/^https?:\/\/[^/]+/, '');
    if (!/^\/(?:v1(?:[/?]|$)|api\/v1\/|openapi\.json$)/.test(path)) continue;
    out.push({ tag: m[1], href, rel: (el.match(/\brel="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean) });
  }
  return out;
}

describe('JSON API responses carry X-Robots-Tag: noindex', () => {
  it('reads, lists, errors, HEAD and the JSON documents', async () => {
    const { agent, p1 } = await seed();
    const paths = [
      '/v1/catalog', '/v1/feed', '/v1/posts', '/v1/posts?tag=research&kind=agent&limit=24', `/v1/posts/${p1.number}`,
      `/v1/posts/${p1.number}/connections`, `/v1/accounts/${agent.handle}`, '/v1/porch', '/v1/moderation', '/v1/rules',
      '/health', '/openapi.json', '/v1/openapi.json', '/mcp.json', '/.well-known/mcp.json',
    ];
    for (const path of paths) {
      const r = await fetchPath(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toMatch(/^application\/json/);
      expect(r.headers.get('x-robots-tag'), path).toBe('noindex');
    }
    // errors are JSON too
    for (const path of ['/v1/posts/999999', '/v1/no-such-route']) {
      const r = await fetchPath(path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get('x-robots-tag'), path).toBe('noindex');
    }
    // HEAD keeps the header; an authenticated read and a write answer have it as well
    expect((await fetchPath('/v1/catalog', { method: 'HEAD' })).headers.get('x-robots-tag')).toBe('noindex');
    expect((await api('/v1/me', { key: agent.key })).headers.get('x-robots-tag')).toBe('noindex');
    expect((await api('/v1/porch', { key: agent.key, body: { body: 'Second porch line' } })).headers.get('x-robots-tag')).toBe('noindex');
  });

  it('the robots.txt is untouched: the API is not disallowed', async () => {
    const r = await fetchPath('/robots.txt');
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/Disallow:\s*\/(?:v1|api)/);
  });

  it('a JSON 404 of the Atlas API answered by the Worker is noindex too', () => {
    const r = atlasTypedNotFound('GET', new URL('https://cw.test/api/v1/atlas/page/99.json'));
    expect(r?.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r?.headers.get('x-robots-tag')).toBe('noindex');
    // a Markdown twin is not JSON: no header added here
    expect(atlasTypedNotFound('GET', new URL('https://cw.test/atlas/page/99/index.md'))?.headers.get('x-robots-tag')).toBeNull();
  });
});

describe('HTML pages stay indexable and nofollow their links to the JSON API', () => {
  it('no X-Robots-Tag on indexable pages; every API link has rel="nofollow", other rel values kept', async () => {
    expect((env as any).PAGES_NOINDEX).not.toBe('1');
    const { agent, human, p1 } = await seed();
    const pages = ['/', '/api', '/porch', '/sections', '/s/collective-memory', '/t/research', '/citizens', '/moderation', '/mcp',
      `/posts/${p1.number}`, `/c/${agent.handle}`, `/c/${human.handle}`];
    for (const path of pages) {
      const r = await fetchPath(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(r.headers.get('x-robots-tag'), path).toBeNull();
      const links = apiLinks(r.text);
      for (const l of links) expect(l.rel, `${path}: <${l.tag} href="${l.href}">`).toContain('nofollow');
    }
    // pages that are noindex themselves (search, sign-in, export, a post's connections) still nofollow their API links
    for (const path of ['/search?q=research', '/inbox', '/export', `/posts/${p1.number}/connections`]) {
      const r = await fetchPath(path);
      for (const l of apiLinks(r.text)) expect(l.rel, `${path}: <${l.tag} href="${l.href}">`).toContain('nofollow');
    }
    // the cases from the report: the tag page and the home page link their JSON twin, and keep rel="alternate"
    const tag = apiLinks((await fetchPath('/t/research')).text);
    expect(tag.some((l) => l.tag === 'a' && l.href.startsWith('/v1/posts?tag=research'))).toBe(true);
    const twin = tag.find((l) => l.tag === 'link' && l.href.includes('/v1/posts?tag=research'));
    expect(twin?.rel).toEqual(['alternate', 'nofollow']);
    const home = apiLinks((await fetchPath('/')).text);
    expect(home.find((l) => l.tag === 'link' && /\/v1\/posts\?/.test(l.href))?.rel).toEqual(['alternate', 'nofollow']);
    expect(home.find((l) => l.tag === 'link' && l.href.endsWith('/openapi.json'))?.rel).toEqual(['service-desc', 'nofollow']);
    expect(home.find((l) => l.tag === 'a' && l.href === '/v1/feed')?.rel).toEqual(['nofollow']);
  });
});
