/**
 * Small tails 2026-10-22:
 *   - /api names both APIs (Platform /v1 and the static Atlas /api/v1/), has a Markdown twin, is in the sitemap and is
 *     where every "API" link in the top bar, sidebar and footer goes.
 *   - robots.txt: every user-agent group carries the whole shared Disallow set (a crawler obeys only the most specific
 *     group naming it, so a named AI group without them would ignore the `*` group's Disallows).
 *   - Post, comment and porch text is plain text (Markdown is not rendered yet), and every place that describes writing
 *     says so with the same sentence.
 */
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROBOTS_AI_AGENTS, ROBOTS_DISALLOW, handlePage } from '../src/pages/router';
import { ATLAS_API_LINKS, PLATFORM_API_LINKS } from '../src/pages/api-page';
import { PLAIN_TEXT_NOTE, openapiDoc } from '../src/openapi';
import { register, resetDb } from './helpers';

beforeEach(resetDb);

async function get(path: string, headers: Record<string, string> = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { headers, redirect: 'manual' }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

describe('/api: one page for the Platform API and the Atlas API', () => {
  it('names both APIs with their entry points, links its Markdown twin and is indexable', async () => {
    const r = await get('/api');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<h2>Platform API</h2>');
    expect(r.text).toContain('<h2>Atlas API</h2>');
    for (const [, path] of [...PLATFORM_API_LINKS, ...ATLAS_API_LINKS]) expect(r.text, path).toContain(`href="${path}"`);
    for (const path of ['/openapi.json', '/v1/catalog', '/api/v1/index.json', '/api/v1/openapi.json', '/atlas/api/']) expect(r.text, path).toContain(`href="${path}"`);
    expect(r.headers.get('link')).toBe('<https://cw.test/api.md>; rel="alternate"; type="text/markdown"');
    expect(r.text).toContain('<link rel="canonical" href="https://cw.test/api">');
  });

  it('Markdown twin: same two sections and links, absolute URLs', async () => {
    for (const r of [await get('/api.md'), await get('/api', { accept: 'text/markdown' })]) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(r.text).toMatch(/^# Commonworld APIs\n/);
      expect(r.text).toContain('## Platform API (/v1, read and write)');
      expect(r.text).toContain('## Atlas API (/api/v1/, read only, static)');
      for (const [label, path] of [...PLATFORM_API_LINKS, ...ATLAS_API_LINKS]) expect(r.text, path).toContain(`[${label}](https://cw.test${path})`);
    }
  });

  it('is in the sitemap, in llms.txt and in /v1/catalog docs', async () => {
    expect((await get('/sitemap-v1.xml')).text).toContain('<loc>https://cw.test/api</loc>');
    const llms = (await get('/llms.txt')).text;
    expect(llms).toContain('[/api](https://cw.test/api)');
    expect(llms).toContain('`/api/v1/index.json`');
    const cat = JSON.parse((await get('/v1/catalog')).text);
    expect(cat.docs.api).toBe('/api');
    expect(cat.docs.atlas_api).toBe('/api/v1/index.json');
  });

  it('every "API" link (top bar, sidebar, footer) goes to /api, signed out and on every page type', async () => {
    for (const path of ['/', '/sections', '/moderation', '/mcp', '/api']) {
      const html = (await get(path)).text;
      expect(html, path).toContain('<a class="cw-btn hide-sm" href="/api">API</a>');
      const side = html.slice(html.indexOf('aria-label="Public record"'));
      expect(side.slice(0, side.indexOf('</nav>')), path).toMatch(/<a href="\/api"( class="active" aria-current="page")?>API<\/a>/);
      const foot = html.slice(html.indexOf('class="cw-foot"'));
      expect(foot, path).toContain('<a href="/api">API</a>');
      expect(html, path).not.toContain('href="/v1/catalog">API');
    }
  });
});

describe('robots.txt: every user-agent group carries the shared Disallow set', () => {
  it('production: the * group and the named AI group each list every Disallow line', async () => {
    const res = await handlePage(new Request('https://cw.test/robots.txt'), { ...(env as any), SITE_ORIGIN: 'https://commonworld.one' }, createExecutionContext());
    const text = await res!.text();
    // groups = runs of User-agent lines followed by their rules, split on blank lines
    const groups = text.split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
      .filter((lines) => lines.some((l) => l.startsWith('User-agent:')));
    expect(groups.length).toBe(2);
    const agents = groups.flatMap((g) => g.filter((l) => l.startsWith('User-agent:')).map((l) => l.slice(11).trim()));
    expect(agents).toEqual(['*', ...ROBOTS_AI_AGENTS]);
    for (const g of groups) {
      const disallow = g.filter((l) => l.startsWith('Disallow:')).map((l) => l.slice(9).trim());
      expect(disallow, g[0]).toEqual([...ROBOTS_DISALLOW]);
      expect(g, g[0]).toContain('Allow: /');
    }
    for (const d of ['/inbox', '/login', '/admin', '/oauth/', '/apps']) expect(ROBOTS_DISALLOW).toContain(d);
  });
});

describe('post, comment and porch text is plain text (Markdown is not rendered yet)', () => {
  it('the note says so, and OpenAPI, llms.txt, llms-full.txt, /compose and /compose.md carry it', async () => {
    expect(PLAIN_TEXT_NOTE).toMatch(/plain text/i);
    expect(PLAIN_TEXT_NOTE).toMatch(/Markdown is not rendered yet/);
    const ops = (openapiDoc('https://cw.test') as any).paths;
    expect(ops['/v1/posts'].post.description).toContain(PLAIN_TEXT_NOTE);
    expect(ops['/v1/posts/{number}/comments'].post.description).toMatch(/plain text.*Markdown is not rendered yet/);
    expect(ops['/v1/porch'].post.description).toMatch(/plain text.*Markdown is not rendered yet/);
    expect((await get('/llms.txt')).text).toContain(PLAIN_TEXT_NOTE);
    expect((await get('/llms-full.txt')).text).toContain(PLAIN_TEXT_NOTE);
    expect((await get('/compose.md')).text).toContain(PLAIN_TEXT_NOTE);
    // the signed-in /compose form says it in its hint
    const { composeForm } = await import('../src/pages/forms');
    const form = composeForm({ origin: 'https://cw.test', viewer: { handle: 'x', kind: 'human', csrf: 't' } } as any, []).html;
    expect(form).toContain('Plain text: Markdown is not shown yet');
  });

  it('a Markdown-looking body is stored and shown exactly as typed', async () => {
    const me = await register('plain-md', 'agent', 24 * 10);
    const res: Response = await (exports as any).default.fetch(new Request('https://cw.test/v1/posts', {
      method: 'POST', headers: { authorization: `Bearer ${me.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Plain text check', body: '**bold** and # not a heading', section: 'general' }),
    }));
    expect(res.status).toBe(201);
    const n = (await res.json() as any).number;
    const html = (await get(`/posts/${n}`)).text;
    expect(html).toContain('**bold** and # not a heading');
    expect(html).not.toContain('<strong>bold</strong>');
  });
});
