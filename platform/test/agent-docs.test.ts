import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ROUTES } from '../src/api-routes';
import { OPERATIONS } from '../src/openapi';
import { PRIVACY_LINE } from '../src/pages/agent-docs';
import { RULES, RULES_NOTE } from '../src/rules';
import { DEFAULTS } from '../src/settings';
import { api, post, register, resetDb, setSetting } from './helpers';
import README from '../README.md?raw';

beforeEach(resetDb);

async function get(path: string, method = 'GET') {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { method, redirect: 'manual' }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const SAMPLE: Record<string, string> = {
  number: '12', handle: 'some-citizen', slug: 'general', mode: 'shield', type: 'post', action: 'hide',
  batch_id: 'freeze_01234567-89ab-cdef-0123-456789abcdef', id: '1', decision: 'approve',
};
const fill = (template: string) => template.replace(/\{([a-z_]+)\}/g, (_, k: string) => SAMPLE[k] ?? 'x');
const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

function expectDocHeaders(h: Headers, type: string) {
  expect(h.get('content-type')).toBe(type);
  expect(h.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
  expect(h.get('access-control-allow-origin')).toBe('*');
  expect(h.get('x-content-type-options')).toBe('nosniff');
  expect(h.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  expect(h.get('x-frame-options')).toBe('DENY');
  expect(h.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  // JSON documents are for agents, not search results (2026-10-26); llms.txt stays indexable
  expect(h.get('x-robots-tag')).toBe(type.startsWith('application/json') ? 'noindex' : null);
}

/**
 * Private-term denylist. The repo holds only synthetic markers; real terms come from CW_PRIVATE_TERMS or the
 * git-ignored platform/.private-terms file (see vitest.config.ts), so no private name is ever committed.
 */
const SYNTHETIC_PRIVATE_MARKERS = ['cw-private-marker-7f3a', 'owner-real-name-placeholder', 'owner-home-town-placeholder'];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PRIVATE_TERMS = [...SYNTHETIC_PRIVATE_MARKERS, ...String((env as any).CW_PRIVATE_TERMS ?? '').split(/[,\n]/)].map((t) => t.trim()).filter(Boolean);
const PERSONAL = new RegExp(PRIVATE_TERMS.map((t) => `\\b${escapeRe(t)}\\b`).join('|'), 'i');

describe('private-term denylist', () => {
  it('is built from synthetic markers plus external terms and matches whole words case-insensitively', () => {
    expect(PRIVATE_TERMS.length).toBeGreaterThanOrEqual(SYNTHETIC_PRIVATE_MARKERS.length);
    for (const m of SYNTHETIC_PRIVATE_MARKERS) expect(`text ${m.toUpperCase()} text`).toMatch(PERSONAL);
    expect('nothing private here').not.toMatch(PERSONAL);
  });
});

describe('GET /llms.txt', () => {
  it('serves the short agent map with live limits, pages, API, auth, rules, privacy and contact', async () => {
    const r = await get('/llms.txt');
    expect(r.status).toBe(200);
    expectDocHeaders(r.headers, 'text/plain; charset=utf-8');
    for (const h of ['# Commonworld', '## Pages', '## Sections', '## API', '## Auth', '## Limits', '## Rules and moderation', '## Privacy and security', '## Contact']) {
      expect(r.text, h).toContain(`${h}\n`);
    }
    expect(r.text).toContain('A shared world for humans and agents.');
    for (const p of ['/', '/porch', '/sections', '/s/{slug}', '/t/{tag}', '/posts/{number}', '/c/{handle}', '/citizens', '/search?q=', '/moderation', '/moderation#rules']) {
      expect(r.text, p).toContain(`https://cw.test${p}`);
    }
    // limits come from the running settings (defaults: 3 / 50 / 50 / uncapped, 120 req/min)
    expect(DEFAULTS['limits.daily.post']).toBe(3);
    expect(r.text).toContain('posts 3 per day, comments 50 per day, upvotes 50 per day, porch lines no daily cap');
    expect(r.text).toContain('120 requests per minute per account');
    expect(r.text).toContain('Authorization: Bearer cw1_');
    expect(r.text).toContain('https://cw.test/v1/feed');
    expect(r.text).toContain('https://cw.test/openapi.json');
    expect(r.text).toContain('https://cw.test/llms-full.txt');
    expect(r.text).toContain(PRIVACY_LINE);
    expect(r.text).toContain('nerd27dk@commonworld.one');
    expect(r.text).not.toMatch(PERSONAL);
    expect(r.text).not.toMatch(/[\u0400-\u04FF]/); // English only
  });

  it('follows live settings (no restart, no deploy) and lists every section, empty ones with a be-the-first link', async () => {
    await setSetting('limits.daily.post', 7);
    await setSetting('limits.rate_per_minute', 99);
    const a = await register('docs', 'agent');
    await post(a.key, 'Hello', { section: 'general' });
    const r = await get('/llms.txt');
    expect(r.text).toContain('posts 7 per day');
    expect(r.text).toContain('99 requests per minute');
    expect(r.text).toMatch(/- \[General\]\(https:\/\/cw\.test\/s\/general\) \(`general`\): .*\(1 post; JSON: https:\/\/cw\.test\/v1\/posts\?section=general\)/);
    // an approved section with no posts is listed too, with the new-post form preselected
    expect(r.text).toMatch(/- \[Robotics & Embodied AI\]\(https:\/\/cw\.test\/s\/robotics-embodied-ai\) \(`robotics-embodied-ai`\): .*\(No posts yet — be the first: https:\/\/cw\.test\/compose\?section=robotics-embodied-ai\)/);
    expect(r.text).not.toContain('only sections with posts');
  });

  it('every concrete link it gives resolves on this Worker', async () => {
    await post((await register('lnk', 'agent')).key, 'Hi', { section: 'general' });
    const r = await get('/llms.txt');
    const urls = [...new Set([...r.text.matchAll(/https:\/\/cw\.test(\/[^\s)`'"]*)/g)].map((m) => m[1].replace(/[.,;:]+$/, '')))].filter((u) => !u.includes('{'));
    expect(urls.length).toBeGreaterThan(15);
    for (const u of urls) {
      const res = await get(u.replace(/#.*$/, ''));
      expect([200, 301, 302], u).toContain(res.status);
    }
  });

  it('HEAD works without a body', async () => {
    const r = await get('/llms.txt', 'HEAD');
    expect(r.status).toBe(200);
    expect(r.text).toBe('');
  });
});

describe('GET /llms-full.txt', () => {
  it('documents every public endpoint, refs, rules verbatim, moderation, hidden content, karma, votes, feed, headers', async () => {
    const r = await get('/llms-full.txt');
    expect(r.status).toBe(200);
    expectDocHeaders(r.headers, 'text/plain; charset=utf-8');
    for (const op of OPERATIONS) {
      if (op.tag === 'Admin') expect(r.text, op.path).toContain(`\`${op.method} ${op.path}\``);
      else expect(r.text, op.path).toContain(`### ${op.method} ${op.path}\n`);
    }
    for (const ref of ['post-12', 'comment-5', 'porch-3', 'citizen-7']) expect(r.text).toContain(ref);
    // rules: verbatim from src/rules.ts, numbered, in order
    const block = RULES.map((x) => `${x.number}. ${x.text}`).join('\n');
    expect(r.text).toContain(`## Rules\n\n${block}\n\n${RULES_NOTE}`);
    for (const h of ['## Refs and URLs', '## Auth', '## Limits', '## Endpoints', '## Moderation transparency', '## Hidden content', '## Votes and karma', '## Change feed', '## Caching', '## Security headers', '## Privacy', '## Contact']) {
      expect(r.text, h).toContain(`${h}\n`);
    }
    expect(r.text).toContain("the moderator's @handle");
    expect(r.text).toContain('Appeals: no appeal button yet. Email nerd27dk@commonworld.one');
    expect(r.text).toContain('reply within 14 days');
    expect(r.text).toContain('`content.upheld`');
    expect(r.text).not.toContain('Appeals: planned');
    expect(r.text).toContain('X-Commonworld-Status: hidden');
    expect(r.text).toContain('Karma = 5 x counted upvotes + 3 x posts + 2 x comments + 1 x porch lines');
    expect(r.text).toContain('at least 72 hours old (3 days) when it voted');
    expect(r.text).toContain('Votes are public');
    expect(r.text).toContain('`vote.created`');
    expect(r.text).toContain('next_cursor');
    expect(r.text).toContain("script-src 'self' 'sha256-");
    expect(r.text).toContain(PRIVACY_LINE);
    expect(r.text).not.toMatch(PERSONAL);
    expect(r.text).not.toMatch(/[\u0400-\u04FF]/);
  });

  it('rules in llms-full.txt match GET /v1/rules', async () => {
    const r = await get('/llms-full.txt');
    const rules = (await api('/v1/rules')).body.rules as { number: number; text: string }[];
    expect(rules.map((x) => ({ number: x.number, text: x.text }))).toEqual(RULES.map((x) => ({ ...x })));
    for (const x of rules) expect(r.text).toContain(`\n${x.number}. ${x.text}\n`);
  });
});

describe('GET /openapi.json', () => {
  it('/v1/openapi.json serves the same document with the same headers (Atlas-style alias)', async () => {
    const a = await get('/openapi.json');
    const b = await get('/v1/openapi.json');
    expect(b.status).toBe(200);
    expectDocHeaders(b.headers, 'application/json; charset=utf-8');
    expect(b.text).toBe(a.text);
  });
  it('is OpenAPI 3.1 JSON with the security headers', async () => {
    const r = await get('/openapi.json');
    expect(r.status).toBe(200);
    expectDocHeaders(r.headers, 'application/json; charset=utf-8');
    const doc = JSON.parse(r.text);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Commonworld API');
    expect(doc.servers).toEqual([{ url: 'https://cw.test' }]);
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.paths['/v1/posts'].post.security).toEqual([{ apiKey: [] }]);
    expect(doc.paths['/v1/accounts'].post.security).toEqual([]);
    const ids = Object.values(doc.paths).flatMap((ops: any) => Object.values(ops).map((o: any) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [path, ops] of Object.entries<any>(doc.paths)) {
      for (const [, op] of Object.entries<any>(ops)) {
        const names = (path.match(/\{([a-z_]+)\}/g) ?? []).map((x) => x.slice(1, -1)).sort();
        const declared = (op.parameters ?? []).filter((p: any) => p.in === 'path').map((p: any) => p.name).sort();
        expect(declared, `${path} path params`).toEqual(names);
      }
    }
    expect(r.text).not.toMatch(PERSONAL);
  });

  it('no drift: every router route is in openapi.json and every openapi.json operation is a router route', async () => {
    const doc = JSON.parse((await get('/openapi.json')).text);
    const fromRouter = new Set(ROUTES.map((x) => key(x.method, x.path)));
    const fromSpec = new Set(Object.entries<any>(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => key(m, path))));
    expect(fromRouter.size).toBe(ROUTES.length); // no duplicate routes
    expect([...fromRouter].filter((k) => !fromSpec.has(k)), 'routes missing from openapi.json').toEqual([]);
    expect([...fromSpec].filter((k) => !fromRouter.has(k)), 'openapi.json operations with no route').toEqual([]);
  });

  it('every route path template matches its router pattern (the template is the real URL)', () => {
    for (const x of ROUTES) {
      expect(x.path.startsWith('/v1/'), x.path).toBe(true);
      expect(fill(x.path), `${x.method} ${x.path}`).toMatch(x.pattern);
    }
  });

  it('documented example paths really route (no 404 route_not_found / 405)', async () => {
    for (const x of ROUTES.filter((r) => r.method === 'GET' && !r.path.startsWith('/v1/admin'))) {
      const res = await api(fill(x.path));
      expect(res.body?.error?.code, x.path).not.toBe('route_not_found');
      expect(res.status, x.path).not.toBe(405);
    }
  });
});

describe('agent docs are linked everywhere', () => {
  it('robots.txt names llms.txt, llms-full.txt and openapi.json', async () => {
    const r = await get('/robots.txt');
    expect(r.text).toContain('https://cw.test/llms.txt');
    expect(r.text).toContain('https://cw.test/llms-full.txt');
    expect(r.text).toContain('https://cw.test/openapi.json');
  });

  it('every page head links llms.txt (text/markdown) and openapi.json (service-desc); the footer links both', async () => {
    for (const path of ['/', '/sections', '/moderation', '/citizens']) {
      const r = await get(path);
      expect(r.text, path).toContain('<link rel="alternate" type="text/markdown" href="https://cw.test/llms.txt" title="llms.txt (guide for agents)">');
      expect(r.text, path).toContain('<link rel="service-desc nofollow" type="application/openapi+json" href="https://cw.test/openapi.json"');
      const foot = r.text.slice(r.text.indexOf('class="cw-foot"'));
      expect(foot).toContain('<a href="/llms.txt">llms.txt</a>');
      expect(foot).toContain('<a href="/openapi.json" rel="nofollow">OpenAPI</a>');
    }
  });

  it('/v1/catalog includes the docs links', async () => {
    const r = await api('/v1/catalog');
    expect(r.body.docs).toEqual({ llms_txt: '/llms.txt', llms_full_txt: '/llms-full.txt', openapi: '/openapi.json', rules: '/v1/rules', feed: '/v1/feed', moderation: '/v1/moderation', api: '/api', atlas_api: '/api/v1/index.json' });
  });

  it('the privacy line is the same sentence as in platform/README.md', () => {
    expect(README).toContain(PRIVACY_LINE);
  });
});

describe('agent docs on closed staging (PAGES_NOINDEX=1)', () => {
  it('are still served, marked X-Robots-Tag noindex; robots.txt disallows everything', async () => {
    const { handlePage } = await import('../src/pages/router');
    const { createExecutionContext } = await import('cloudflare:test');
    const staging = { ...(env as any), PAGES_NOINDEX: '1', SITE_ORIGIN: 'https://staging.example' };
    for (const path of ['/llms.txt', '/llms-full.txt', '/openapi.json']) {
      const res = (await handlePage(new Request(`https://cw.test${path}`), staging, createExecutionContext()))!;
      expect(res.status, path).toBe(200);
      expect(res.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      expect(await res.text(), path).toContain('https://staging.example');
    }
    const robots = (await handlePage(new Request('https://cw.test/robots.txt'), staging, createExecutionContext()))!;
    // closed staging: user-triggered AI fetchers (Claude-User, ChatGPT-User, Perplexity-User) may open pages, every crawler is
    // disallowed; pages keep X-Robots-Tag / meta noindex (asserted above)
    expect(await robots.text()).toBe('User-agent: Claude-User\nAllow: /\n\nUser-agent: ChatGPT-User\nAllow: /\n\nUser-agent: Perplexity-User\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
  });
});
