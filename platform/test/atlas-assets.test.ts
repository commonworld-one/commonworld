/**
 * Routing option A3 (src/atlas-assets.ts): the Atlas from this Worker's Static Assets.
 * Contract: Atlas static files never invoke the Worker (run_worker_first negative patterns, same in every environment);
 * Atlas HTML runs the Worker and gets the per-response CSP nonce; URLs, headers, 404, redirects, merged robots / sitemap /
 * llms stay as with the Pages proxy. Uses the fixture build in test/fixtures/atlas-dist (wrangler.toml top-level [assets]).
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { ATLAS_NOT_FOUND_CACHE, ATLAS_NOT_FOUND_JSON_MESSAGE, ATLAS_NOT_FOUND_MD, ATLAS_RUN_WORKER_FIRST, atlasNotFoundKind, isTypedNotFoundFile, runsWorkerFirst, withAtlasNonce } from '../src/atlas-assets';
import { isAtlasPath } from '../src/atlas-proxy';
import { resetDb } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const PROD = 'https://commonworld.one';
const VARS = { ATLAS_SOURCE: 'assets', ATLAS_ORIGIN: 'https://atlas-pages.test', SITE_ORIGIN: PROD };

async function call(path: string, vars: Record<string, string> = VARS, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${PROD}${path}`, { redirect: 'manual', ...init }), { ...env, PUBLIC_EDGE_CACHE: '0', ...vars } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** Any network fetch is a bug in assets mode (the Pages origin must not be asked). */
function noNetwork() {
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('network not allowed in this test', { status: 599 });
  });
  return seen;
}

const nonceOf = (csp: string | null) => csp?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1] ?? null;

/** run_worker_first arrays of each [assets] table in wrangler.toml, in file order: top-level, staging, production. */
function tomlRunWorkerFirst(): { table: string; list: string[] }[] {
  const toml = env.TEST_WRANGLER_TOML;
  const out: { table: string; list: string[] }[] = [];
  const re = /^\[((?:env\.\w+\.)?assets)\]\n([\s\S]*?)(?=^\[)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml))) {
    const arr = m[2].match(/run_worker_first\s*=\s*\[([\s\S]*?)\]/);
    out.push({ table: m[1], list: arr ? [...arr[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [] });
  }
  return out;
}

describe('A3 routing contract (wrangler.toml run_worker_first)', () => {
  it('every environment uses exactly ATLAS_RUN_WORKER_FIRST, under the 100-entry limit', () => {
    const tables = tomlRunWorkerFirst();
    expect(tables.map((t) => t.table)).toEqual(['assets', 'env.staging.assets', 'env.production.assets']);
    for (const t of tables) expect(t.list, t.table).toEqual([...ATLAS_RUN_WORKER_FIRST]);
    expect(ATLAS_RUN_WORKER_FIRST.length).toBeLessThanOrEqual(100);
    const toml = env.TEST_WRANGLER_TOML;
    expect(toml).toMatch(/\[env\.staging\.assets\]\ndirectory = "\.\/\.atlas-dist"/);
    expect(toml).toMatch(/\[env\.production\.assets\]\ndirectory = "\.\/\.atlas-dist"/);
    expect(toml.match(/^ATLAS_SOURCE = "assets"$/gm)?.length).toBe(2);
  });

  it('a miss keeps not_found_handling = "404-page" in every environment (the nearest 404.html: typed 404 bodies of the build)', () => {
    const toml = env.TEST_WRANGLER_TOML;
    const tables = [...toml.matchAll(/^\[((?:env\.\w+\.)?assets)\]\n([\s\S]*?)(?=^\[)/gm)];
    expect(tables.map((m) => m[1])).toEqual(['assets', 'env.staging.assets', 'env.production.assets']);
    for (const m of tables) expect(m[2], m[1]).toMatch(/^not_found_handling = "404-page"$/m);
  });

  it('Atlas static files are served by Static Assets, never by the Worker', () => {
    for (const p of ['/atlas/assets/atlas.css', '/atlas/assets/cw-components.js', '/atlas/assets/favicon.ico', '/atlas/og/1f916.png', '/atlas/screens/1f916.webp',
      '/atlas/screens/index.json', '/atlas/badge/1f916.svg', '/atlas/badge/', '/atlas/data/claims.json', '/atlas/platforms/1f916.json', '/atlas/categories/social.json',
      '/atlas/platforms.json', '/atlas/earn.json', '/atlas/decisions.json', '/atlas/llms.txt', '/atlas/sitemap.xml', '/atlas/decisions/index.md', '/atlas/events.md', '/atlas/platforms/1f916/index.md', '/atlas/categories/social/index.md', '/atlas/events.json', '/stats.json',
      '/atlas/index.md', '/atlas/page/2/index.md', '/atlas/categories/social/page/2/index.md', '/api/v1/atlas/page/1.json', '/api/v1/atlas/categories/social/page/2.json',
      '/atlas/platforms/index.md', '/atlas/platforms/page/2/index.md', '/api/v1/atlas/platforms/page/1.json',
      '/stats/index.md', '/about/index.md', '/privacy/index.md', '/terms/index.md', '/api/v1/index.json', '/api/v1/openapi.json', '/api/v1/CHANGELOG.md', '/api/v1/schemas/platform.schema.json', '/.well-known/security.txt']) {
      expect(runsWorkerFirst(p), p).toBe(false);
    }
  });

  it('v1 and the Atlas HTML pages run the Worker first', () => {
    for (const p of ['/', '/porch', '/sections', '/s/general', '/posts/1', '/c/someone', '/search', '/login', '/admin', '/v1/catalog', '/health', '/assets/ssr.css',
      '/favicon.ico', '/robots.txt', '/sitemap.xml', '/sitemap-v1.xml', '/llms.txt', '/llms-full.txt', '/openapi.json', '/porch.md',
      '/atlas', '/atlas/', '/atlas/page/2/', '/atlas/categories/social/page/3/', '/atlas/platforms/1f916/', '/atlas/platforms/', '/atlas/platforms/page/2/', '/atlas/categories/social/', '/atlas/earn/', '/atlas/decisions/', '/atlas/about/', '/atlas/privacy/',
      '/privacy/', '/terms/', '/about/', '/stats/', '/404.html', '/0123456789abcdef0123456789abcdef.txt']) {
      expect(runsWorkerFirst(p), p).toBe(true);
    }
  });

  it('against the real Atlas build (when it is next to this checkout): HTML runs the Worker, other files are static', () => {
    if (!env.TEST_ATLAS_DIST_FILES) return; // no cw-public checkout here (CI of this repo)
    const files: string[] = JSON.parse(env.TEST_ATLAS_DIST_FILES);
    const url = (f: string) => f.endsWith('/index.html') ? f.slice(0, -'index.html'.length) : f;
    // Static on Pages too (_routes.json excludes /atlas/badge/*): the badge page has no nonce today either.
    // /api/404.html is the typed JSON 404 body (atlas/site/build.py typed_404_files), static like the rest of /api/.
    const staticHtml = new Set(['/atlas/badge/', '/api/404.html']);
    // Worker-owned (v1 files, merged files, or Atlas root files the Worker answers itself).
    const workerOwned = new Set(['/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt', '/favicon.ico', '/_headers', '/_redirects', '/_routes.json']);
    let html = 0; let assets = 0;
    for (const f of files) {
      const p = url(f);
      if (f.endsWith('.html')) {
        html++;
        expect(runsWorkerFirst(p), p).toBe(!staticHtml.has(p));
        if (p !== '/' && p !== '/404.html' && !staticHtml.has(p)) expect(p.startsWith('/atlas/') || isAtlasPath(p), `${p} reaches the Worker but is not an Atlas path`).toBe(true);
      } else if (!workerOwned.has(f) && !/^\/[A-Fa-f0-9]{8,128}\.txt$/.test(f)) {
        assets++;
        expect(runsWorkerFirst(p), p).toBe(false);
      }
    }
    expect(html).toBeGreaterThan(10);
    expect(assets).toBeGreaterThan(100);
  });
});

describe('A3: the Atlas from Static Assets (ATLAS_SOURCE=assets)', () => {
  it('Atlas HTML: 200 from the build, Atlas _headers kept, fresh CSP nonce per response, no Pages request', async () => {
    const net = noNetwork();
    const a = await call('/atlas/');
    expect(a.status).toBe(200);
    expect(a.text).toContain('Atlas home');
    expect(a.headers.get('x-cw-upstream')).toBe('atlas-assets');
    expect(a.headers.get('x-content-type-options')).toBe('nosniff');
    expect(a.headers.get('strict-transport-security')).toBe('max-age=15552000');
    expect(a.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const csp = a.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'sha256-FIXTUREHASH0000000000000000000000000000000='");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(a.text).not.toContain('nonce'); // the nonce is only for Cloudflare's injected script, never in our markup
    const b = await call('/atlas/platforms/demo/');
    expect(b.status).toBe(200);
    expect(b.text).toContain('Atlas demo platform');
    expect(nonceOf(b.headers.get('content-security-policy'))).not.toBe(nonceOf(csp));
    for (const [p, body] of [['/privacy/', 'Atlas privacy'], ['/terms/', 'Atlas terms'], ['/about/', 'Atlas about'], ['/stats/', 'Atlas stats']]) {
      const r = await call(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).toContain(body);
      expect(nonceOf(r.headers.get('content-security-policy')), p).not.toBeNull();
    }
    expect(net).toEqual([]);
  });

  it('missing Atlas page: the Atlas 404 page with status 404 and a nonce', async () => {
    noNetwork();
    const r = await call('/atlas/no-such-page/');
    expect(r.status).toBe(404);
    expect(r.text).toContain('Atlas 404');
    expect(nonceOf(r.headers.get('content-security-policy'))).not.toBeNull();
  });

  it('redirects: bare paths 301 to the slash form; slashless/.html pages 308 (as Pages); _redirects kept; all same-host', async () => {
    noNetwork();
    for (const p of ['/atlas', '/privacy', '/terms', '/about', '/stats']) {
      const r = await call(p + '?a=1');
      expect(r.status, p).toBe(301);
      expect(r.headers.get('location'), p).toBe(`${p}/?a=1`);
    }
    const slashless = await call('/atlas/platforms/demo');
    expect(slashless.status).toBe(308);
    expect(slashless.headers.get('location')).toBe('/atlas/platforms/demo/');
    const dotHtml = await call('/atlas/platforms/demo/index.html');
    expect(dotHtml.status).toBe(308);
    expect(dotHtml.headers.get('location')).toBe('/atlas/platforms/demo/');
    const old = await call('/atlas/privacy/');
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('/privacy/');
    // paged lists: page 1 is the list itself (_redirects 301), a page past the last one is a plain 404
    const p1 = await call('/atlas/page/1/');
    expect(p1.status).toBe(301);
    expect(p1.headers.get('location')).toBe('/atlas/');
    expect((await call('/atlas/page/2/')).status).toBe(200);
    expect((await call('/atlas/page/99/')).status).toBe(404);
    // the A-Z list pages the same way (#107)
    const az1 = await call('/atlas/platforms/page/1/');
    expect(az1.status).toBe(301);
    expect(az1.headers.get('location')).toBe('/atlas/platforms/');
    expect((await call('/atlas/platforms/page/2/')).status).toBe(200);
    expect((await call('/atlas/platforms/page/99/')).status).toBe(404);
    expect((await call('/api/v1/atlas/platforms/page/1.json')).status).toBe(200);
    expect((await call('/api/v1/atlas/platforms/page/99.json')).status).toBe(404);
  });

  it('a vanished list page (it may come back) answers a temporary 302 that is never stored, in every format', async () => {
    noNetwork();
    // HTML runs the Worker: the 302 from _redirects gets cache-control: no-store
    for (const p of ['/atlas/page/3/', '/atlas/page/3']) {
      const r = await call(p);
      expect(r.status, p).toBe(302);
      expect(r.headers.get('location'), p).toBe('/atlas/page/2/');
      expect(r.headers.get('cache-control'), p).toBe('no-store');
    }
    // Markdown twin and JSON page are served by Static Assets without the Worker (run_worker_first negatives):
    // _headers gives their 302s the same no-store (Static Assets applies _headers to _redirects responses)
    for (const [p, to] of [['/atlas/page/3/index.md', '/atlas/page/2/index.md'], ['/api/v1/atlas/page/3.json', '/api/v1/atlas/page/1.json']]) {
      expect(runsWorkerFirst(p), p).toBe(false);
      const r = await (env as any).ASSETS.fetch(new Request(`${PROD}${p}`, { redirect: 'manual' }));
      expect(r.status, p).toBe(302);
      expect(r.headers.get('location'), p).toBe(to);
      expect(r.headers.get('cache-control'), p).toBe('no-store');
    }
    // only the /page/1/ alias stays a permanent 301 (and keeps no no-store)
    const p1 = await call('/atlas/page/1/');
    expect(p1.status).toBe(301);
    expect(p1.headers.get('cache-control')).not.toBe('no-store');
  });

  it('typed 404s of static files: the nearest 404.html, JSON under /api/, Markdown for list-page twins (Atlas paging findings 2026-10-25)', async () => {
    noNetwork();
    // the JSON pages and Markdown twins are static (run_worker_first negatives): Static Assets answers their misses itself
    const assets = async (p: string, init: RequestInit = {}) => {
      const r = await (env as any).ASSETS.fetch(new Request(`${PROD}${p}`, { redirect: 'manual', ...init }));
      return { status: r.status, headers: r.headers as Headers, text: await r.text() };
    };
    for (const p of ['/api/v1/atlas/page/9.json', '/api/v1/atlas/page/0.json', '/api/v1/atlas/page/abc.json', '/api/v1/atlas/page/99.json',
      '/api/v1/atlas/categories/social/page/99.json', '/api/v1/atlas/platforms/page/99.json', '/api/v1/atlas/platforms/no-such-id.json']) {
      expect(runsWorkerFirst(p), p).toBe(false);
      const r = await assets(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toBe('application/json; charset=utf-8');
      expect(r.headers.get('access-control-allow-origin'), p).toBe('*');
      expect(JSON.parse(r.text).error, p).toEqual({ code: 'not_found', message: ATLAS_NOT_FOUND_JSON_MESSAGE });
    }
    for (const p of ['/atlas/page/9/index.md', '/atlas/page/0/index.md', '/atlas/platforms/page/99/index.md']) {
      expect(runsWorkerFirst(p), p).toBe(false);
      const r = await assets(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toBe('text/markdown; charset=utf-8');
      expect(r.text, p).toBe(ATLAS_NOT_FOUND_MD);
    }
    // the same bodies when a JSON or Markdown path reaches the Worker (HEAD: no body)
    const w = await call('/api/v1/atlas/page/9.json');
    expect([w.status, w.headers.get('content-type')]).toEqual([404, 'application/json; charset=utf-8']);
    expect(JSON.parse(w.text)).toEqual({ error: { code: 'not_found', message: ATLAS_NOT_FOUND_JSON_MESSAGE },
      links: { index: `${PROD}/api/v1/atlas/index.json`, docs: `${PROD}/atlas/api/` } });
    expect(w.headers.get('cache-control')).toBe(ATLAS_NOT_FOUND_CACHE);
    const wm = await call('/atlas/page/9/index.md');
    expect([wm.status, wm.headers.get('content-type'), wm.text]).toEqual([404, 'text/markdown; charset=utf-8', ATLAS_NOT_FOUND_MD]);
    const head = await call('/api/v1/atlas/page/9.json', VARS, { method: 'HEAD' });
    expect([head.status, head.text]).toEqual([404, '']);
    // HTML misses run the Worker and always get the site 404 page, never the Markdown 404.html of a list folder
    for (const p of ['/atlas/page/9/', '/atlas/page/0/', '/atlas/page/abc/', '/atlas/platforms/page/99/', '/atlas/page/404', '/atlas/page/404.html',
      '/atlas/platforms/page/404']) {
      const r = await call(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toMatch(/^text\/html/);
      expect(r.text, p).toContain('Atlas 404');
      expect(nonceOf(r.headers.get('content-security-policy')), p).not.toBeNull();
    }
    expect(isTypedNotFoundFile('/atlas/categories/social/page/404.html')).toBe(true);
    expect(isTypedNotFoundFile('/atlas/page/4/')).toBe(false);
    expect(atlasNotFoundKind('/api/v1/CHANGELOG.md')).toBe('json');
    expect(atlasNotFoundKind('/atlas/events.md')).toBe('markdown');
    expect(atlasNotFoundKind('/atlas/page/9/')).toBe('html');
  });

  it('the bare Atlas API root (/api/v1/atlas, /api/v1/atlas/) answers the module index as JSON, not a text/html 404 (#159)', async () => {
    noNetwork();
    const index = await (env as any).ASSETS.fetch(new Request(`${PROD}/api/v1/atlas/index.json`, { redirect: 'manual' }));
    const want = JSON.parse(await index.text());
    for (const p of ['/api/v1/atlas', '/api/v1/atlas/']) {
      // static (run_worker_first negative): a 200 rewrite in _redirects, typed by the exact-path _headers rules
      expect(runsWorkerFirst(p), p).toBe(false);
      for (const method of ['GET', 'HEAD']) {
        const r = await (env as any).ASSETS.fetch(new Request(`${PROD}${p}`, { method, redirect: 'manual' }));
        const text = await r.text();
        expect(r.status, `${method} ${p}`).toBe(200);
        expect(r.headers.get('location'), `${method} ${p}`).toBeNull();
        expect(r.headers.get('content-type'), `${method} ${p}`).toBe('application/json; charset=utf-8');
        expect(r.headers.get('x-robots-tag'), `${method} ${p}`).toBe('noindex');
        expect(r.headers.get('access-control-allow-origin'), `${method} ${p}`).toBe('*');
        if (method === 'GET') expect(JSON.parse(text), p).toEqual(want);
      }
    }
    // other misses under /api/ keep the typed JSON 404
    const miss = await (env as any).ASSETS.fetch(new Request(`${PROD}/api/v1/atlas/nope.json`, { redirect: 'manual' }));
    expect([miss.status, miss.headers.get('content-type')]).toEqual([404, 'application/json; charset=utf-8']);
    await miss.text();
  });

  it('page 1 of a list is the list itself in HTML and Markdown (301); JSON page 1 is a real file (200)', async () => {
    noNetwork();
    const html = await call('/atlas/page/1/');
    expect([html.status, html.headers.get('location')]).toEqual([301, '/atlas/']);
    // the Markdown twin is static (run_worker_first negative): its 301 comes from _redirects
    expect(runsWorkerFirst('/atlas/page/1/index.md')).toBe(false);
    const md = await (env as any).ASSETS.fetch(new Request(`${PROD}/atlas/page/1/index.md`, { redirect: 'manual' }));
    expect(md.status).toBe(301);
    expect(md.headers.get('location')).toBe('/atlas/index.md');
    const az = await (env as any).ASSETS.fetch(new Request(`${PROD}/atlas/platforms/page/1/index.md`, { redirect: 'manual' }));
    expect([az.status, az.headers.get('location')]).toEqual([301, '/atlas/platforms/index.md']);
    expect((await call('/api/v1/atlas/page/1.json')).status).toBe(200);
  });

  it('a page number that never existed is a 404 in every format (HTML, Markdown twin, JSON)', async () => {
    noNetwork();
    for (const p of ['/atlas/page/99/', '/atlas/platforms/page/99/', '/atlas/page/99/index.md', '/api/v1/atlas/page/99.json',
      '/api/v1/atlas/platforms/page/99.json', '/api/v1/atlas/categories/social/page/99.json']) {
      const r = await call(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('location'), p).toBeNull();
    }
  });

  it('a list page that is built (one that came back after a shrink) is a plain 200 page with no redirect', async () => {
    noNetwork();
    // atlas/site/build.py paged_redirects emits a 302 only for pages past the current last page, never for a built page,
    // and check.py fails a build whose _redirects names a built page (Static Assets applies _redirects before files)
    for (const p of ['/atlas/page/2/', '/atlas/platforms/page/2/', '/api/v1/atlas/page/1.json', '/api/v1/atlas/platforms/page/1.json',
      '/api/v1/atlas/categories/social/page/1.json']) {
      const r = await call(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('location'), p).toBeNull();
    }
  });

  it('filter and search views of Atlas pages are noindex (X-Robots-Tag); plain list pages and other query strings are not (D1)', async () => {
    noNetwork();
    for (const q of ['?tag=x402', '?q=mcp', '?category=social&status=live', '?sort=claims', '?feature=money', '?type=platform']) {
      const r = await call('/atlas/' + q);
      expect(r.status, q).toBe(200);
      expect(r.headers.get('x-robots-tag'), q).toBe('noindex, follow');
    }
    expect((await call('/atlas/page/2/?tag=x402')).headers.get('x-robots-tag')).toBe('noindex, follow');
    expect((await call('/atlas/')).headers.get('x-robots-tag')).toBeNull();
    expect((await call('/atlas/page/2/')).headers.get('x-robots-tag')).toBeNull();
    expect((await call('/atlas/?utm_source=x')).headers.get('x-robots-tag')).toBeNull();
    expect((await call('/api/v1/atlas/page/1.json?q=x')).headers.get('x-robots-tag')).toBeNull(); // JSON, not a page
    expect((await call('/atlas/?tag=x402', { ...VARS, PAGES_NOINDEX: '1' })).headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('Worker-owned Atlas files (IndexNow key, security.txt, static API) still answer if they reach the Worker', async () => {
    noNetwork();
    const key = await call('/0123456789abcdef0123456789abcdef.txt');
    expect(key.status).toBe(200);
    expect(key.text.trim()).toBe('fixture-indexnow-key');
    expect((await call('/.well-known/security.txt')).text).toContain('Contact:');
    // /.well-known/mcp.json is the Worker's own (MCP discovery manifest), never an Atlas file; other unknown
    // well-known paths are the Atlas 404
    const wk = await call('/.well-known/mcp.json');
    expect(wk.status).toBe(200);
    expect(wk.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(wk.headers.get('x-cw-upstream')).toBeNull();
    expect(JSON.parse(wk.text).servers[0].transport).toBe('streamable-http');
    expect((await call('/.well-known/openid-configuration')).status).toBe(404);
    const api = await call('/api/v1/index.json');
    expect(api.status).toBe(200);
    expect(api.headers.get('access-control-allow-origin')).toBe('*');
    expect(api.headers.get('content-security-policy')).not.toContain('nonce'); // not HTML: no nonce
  });

  it('GET/HEAD only; HEAD has no body; closed staging marks Atlas pages noindex', async () => {
    noNetwork();
    expect((await call('/atlas/', VARS, { method: 'POST', body: 'x' })).status).toBe(405);
    const head = await call('/atlas/', VARS, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect((await call('/atlas/', { ...VARS, PAGES_NOINDEX: '1' })).headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect((await call('/atlas/')).headers.get('x-robots-tag')).toBeNull();
  });

  it('v1 keeps /, robots.txt, sitemap index, and merges the Atlas llms files from Static Assets', async () => {
    const net = noNetwork();
    const home = await call('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('A shared world');
    expect(home.text).not.toContain('Pages landing');
    const robots = await call('/robots.txt');
    expect(robots.text).toContain(`Sitemap: ${PROD}/sitemap.xml`);
    expect(robots.text).not.toContain('atlas-robots-must-not-win');
    const idx = await call('/sitemap.xml');
    expect(idx.text).toContain('<sitemapindex');
    expect(idx.text).toContain(`<loc>${PROD}/atlas/sitemap.xml</loc>`);
    expect((await call('/sitemap-v1.xml')).text).toContain(`<loc>${PROD}/privacy/</loc>`);
    const llms = await call('/llms.txt');
    expect(llms.text.indexOf('# Commonworld')).toBe(0);
    expect(llms.text).toContain('# Atlas llms');
    const full = await call('/llms-full.txt');
    expect(full.text).toContain('# Commonworld: full reference for agents');
    expect(full.text).toContain('# Atlas full');
    expect(net).toEqual([]);
  });

  it('without ATLAS_SOURCE the Worker does not touch Static Assets for Atlas paths (proxy or nothing, as before)', async () => {
    noNetwork();
    const r = await call('/atlas/', { SITE_ORIGIN: PROD });
    expect(r.headers.get('x-cw-upstream')).toBeNull();
    expect(r.text).not.toContain('Atlas home');
  });
});

describe('withAtlasNonce (port of cw-public functions/_middleware.js)', () => {
  it('adds a nonce only to HTML with the Atlas script-src', () => {
    const csp = "default-src 'self'; script-src 'self' 'sha256-x'";
    const html = withAtlasNonce(new Response('x', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp } }));
    expect(html.headers.get('content-security-policy')).toMatch(/^default-src 'self'; script-src 'self' 'nonce-[A-Za-z0-9+/]{24}' 'sha256-x'$/);
    const json = withAtlasNonce(new Response('{}', { headers: { 'content-type': 'application/json', 'content-security-policy': csp } }));
    expect(json.headers.get('content-security-policy')).toBe(csp);
    const other = withAtlasNonce(new Response('x', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" } }));
    expect(other.headers.get('content-security-policy')).toBe("default-src 'none'");
    const none = withAtlasNonce(new Response('x', { headers: { 'content-type': 'text/html' } }));
    expect(none.headers.get('content-security-policy')).toBeNull();
  });
});
