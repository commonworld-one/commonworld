/**
 * Index and agent files, SEO head on SSR pages, markdown and JSON twins, redirects, 404, and a same-origin
 * broken-link crawl. Staging mode (CW_E2E_EXPECT_NOINDEX=1 or a staging.* host) flips the robots expectations.
 */
import { expect, test } from '@playwright/test';
import { api, robotsOf, sitemap } from '../../support/api';
import { BASE_URL, EXPECT_NOINDEX, readState } from '../../support/env';

const s = readState();
const f = s.fixture;
const handle = s.citizens.human?.handle;

/** Public SSR pages with their markdown twin (null = none). */
function corePages(): [string, string | null][] {
  const pages: [string, string | null][] = [
    ['/', '/index.md'], ['/porch', '/porch.md'], ['/sections', '/sections.md'], ['/citizens', '/citizens.md'],
    ['/moderation', '/moderation.md'], ['/search?q=e2e', '/search.md?q=e2e'],
  ];
  if (f) pages.push([`/posts/${f.post}`, `/posts/${f.post}.md`], [`/s/${f.section}`, `/s/${f.section}.md`], [`/t/${f.tag}`, `/t/${f.tag}.md`]);
  if (handle) pages.push([`/c/${handle}`, `/c/${handle}.md`]);
  return pages;
}

test('robots.txt', async ({ request }) => {
  const r = await request.get('/robots.txt');
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('text/plain');
  const t = await r.text();
  if (EXPECT_NOINDEX) {
    expect(t).toMatch(/User-agent: \*\s*\nDisallow: \/\s*$/m);
  } else {
    expect(t).toMatch(/Disallow: \/inbox/);
    expect(t).toMatch(/Disallow: \/login/);
    expect(t).toMatch(/Disallow: \/admin/);
    expect(t).toMatch(/Sitemap: .*\/sitemap\.xml/);
    expect(t).toContain('/llms.txt');
  }
});

test('llms.txt, llms-full.txt, openapi.json', async ({ request }) => {
  for (const p of ['/llms.txt', '/llms-full.txt']) {
    const r = await request.get(p);
    expect(r.status(), p).toBe(200);
    expect(r.headers()['content-type']).toContain('text/plain');
    expect(r.headers()['access-control-allow-origin']).toBe('*');
    expect((await r.text()).length).toBeGreaterThan(500);
    if (EXPECT_NOINDEX) expect(r.headers()['x-robots-tag'] ?? '').toContain('noindex');
  }
  for (const p of ['/openapi.json', '/v1/openapi.json']) {
    const r = await api(request, 'GET', p);
    expect(r.status, p).toBe(200);
    expect(r.json.openapi).toMatch(/^3\.1/);
    expect(Object.keys(r.json.paths).length).toBeGreaterThan(30);
  }
});

test('every same-origin link in llms.txt resolves', async ({ request }) => {
  const t = await (await request.get('/llms.txt')).text();
  const origin = new URL(BASE_URL).origin;
  const links = [...new Set([...t.matchAll(/\]\((\/[^)\s]*|https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))]
    .map((u) => (u.startsWith('/') ? origin + u : u)).filter((u) => u.startsWith(origin) && !u.includes('{'));
  expect(links.length).toBeGreaterThan(3);
  const bad: string[] = [];
  for (const u of links) {
    const r = await request.get(u, { failOnStatusCode: false });
    if (r.status() >= 400) bad.push(`${r.status()} ${u}`);
  }
  expect(bad).toEqual([]);
});

test('sitemap lists the base pages and never private ones', async ({ request }) => {
  const sm = await sitemap(request);
  for (const p of ['/porch', '/sections', '/citizens', '/moderation']) expect(sm, p).toContain(`${p}</loc>`);
  for (const p of ['/search', '/inbox', '/login', '/admin', '/compose']) expect(sm, p).not.toContain(`${p}</loc>`);
  if (f) expect(sm).toContain(`/posts/${f.post}</loc>`);
  if (EXPECT_NOINDEX) {
    const r = await request.get('/sitemap.xml');
    expect(r.headers()['x-robots-tag'] ?? '').toContain('noindex');
  }
});

test('SSR pages: 200, title, description, canonical, robots, OG, JSON alternate that resolves', async ({ request }) => {
  for (const [path] of corePages()) {
    const p = await robotsOf(request, path);
    expect(p.status, path).toBe(200);
    expect(p.html, `${path} title`).toMatch(/<title>[^<]{3,}<\/title>/);
    expect(p.html, `${path} description`).toMatch(/<meta name="description" content="[^"]{10,160}"/);
    const canonical = p.html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    if (path.startsWith('/search')) {
      // noindex by itself: no canonical, no og:url (staging's blanket noindex does not count)
      expect(canonical, `${path} no canonical on a noindex page`).toBeUndefined();
      expect(p.html, `${path} no og:url`).not.toContain('property="og:url"');
    } else {
      expect(canonical, `${path} canonical`).toBeTruthy();
      expect(canonical!, `${path} canonical absolute`).toMatch(/^https?:\/\//);
    }
    expect(p.html, `${path} og:title`).toMatch(/<meta property="og:title" content="[^"]+"/);
    expect(p.html, `${path} og:image`).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+"/);
    expect(p.html, `${path} twitter:card`).toContain('name="twitter:card"');
    if (EXPECT_NOINDEX) {
      expect(p.meta, `${path} meta robots on staging`).toContain('noindex');
      expect(p.header, `${path} X-Robots-Tag on staging`).toContain('noindex');
    } else if (!path.startsWith('/search')) {
      expect(p.meta, `${path} indexable`).not.toContain('noindex');
    }
    const alt = p.html.match(/<link rel="alternate nofollow" type="application\/json" href="([^"]+)"/)?.[1];
    if (alt) {
      const j = await api(request, 'GET', alt.replace(/&amp;/g, '&'));
      expect(j.status, `${path} JSON twin ${alt}`).toBe(200);
      expect(j.json, `${path} JSON twin parses`).toBeTruthy();
    }
  }
});

test('markdown twins: .md path and Accept: text/markdown', async ({ request }) => {
  for (const [path, md] of corePages()) {
    if (!md) continue;
    const r = await request.get(md, { failOnStatusCode: false });
    expect(r.status(), md).toBe(200);
    expect(r.headers()['content-type'], md).toContain('text/markdown');
    if (md.startsWith('/search')) expect(r.headers()['link'] ?? '', `${md} no canonical Link (noindex)`).not.toContain('rel="canonical"');
    else expect(r.headers()['link'] ?? '', `${md} canonical Link`).toContain('rel="canonical"');
    const viaAccept = await request.get(path, { headers: { accept: 'text/markdown' } });
    expect(viaAccept.headers()['content-type'], `${path} Accept`).toContain('text/markdown');
  }
  const html = await request.get('/', { headers: { accept: '*/*' } });
  expect(html.headers()['content-type']).toContain('text/html');
  // a page without a twin (not in MD_PAGE_PATTERNS, src/pages/layout.ts): its .md answers 404
  const missing = await request.get('/inbox.md', { failOnStatusCode: false });
  expect(missing.status(), '/inbox.md').toBe(404);
});

test('variants are noindex,follow and declare no canonical', async ({ request }) => {
  test.skip(EXPECT_NOINDEX, 'everything is noindex on staging');
  const p = await robotsOf(request, '/?sort=top');
  expect(p.meta).toContain('noindex');
  expect(p.html).not.toContain('rel="canonical"');
  expect(p.html).not.toContain('property="og:url"');
});

test('redirects', async ({ request }) => {
  const cases: [string, number, RegExp][] = [
    // without the Atlas (local): absolute 301 to https://commonworld.one/...; with the Atlas served by this Worker
    // (staging/production, ATLAS_SOURCE=assets or ATLAS_ORIGIN): same-host 301 to the slash form (src/atlas-proxy.ts)
    ['/privacy', 301, /^(?:https:\/\/commonworld\.one)?\/privacy\/$/],
    ['/terms', 301, /^(?:https:\/\/commonworld\.one)?\/terms\/$/],
    ['/sections/general', 301, /\/s\/general$/],
    ['/porch/', 301, /\/porch$/],
  ];
  if (handle) cases.push([`/citizens/${handle}`, 301, new RegExp(`/c/${handle}$`)]);
  const wrong: string[] = [];
  for (const [from, status, to] of cases) {
    const r = await request.get(from, { maxRedirects: 0, failOnStatusCode: false });
    if (r.status() !== status || !to.test(r.headers().location ?? '')) wrong.push(`${from}: ${r.status()} -> ${r.headers().location} (want ${status} ${to})`);
  }
  expect(wrong).toEqual([]);
});

test('unknown page: 404 in the layout, noindex', async ({ request }) => {
  const p = await robotsOf(request, '/no-such-page-e2e');
  expect(p.status).toBe(404);
  expect(p.meta).toContain('noindex');
  const bad = await robotsOf(request, '/?sort=nonsense');
  expect(bad.status).toBe(400);
});

test('broken links: every same-origin link on the core pages answers < 400', async ({ request }) => {
  // sequential GETs over the network to a remote target (staging) take longer than the 60 s default once content grows
  test.setTimeout(240_000);
  const origin = new URL(BASE_URL).origin;
  const seen = new Map<string, string>();
  for (const [path] of corePages()) {
    const html = await (await request.get(path)).text();
    for (const m of html.matchAll(/<a [^>]*href="([^"#]+)/g)) {
      const raw = m[1].replace(/&amp;/g, '&');
      let u: URL;
      try { u = new URL(raw, origin + path); } catch { continue; }
      if (u.origin !== origin || u.pathname.startsWith('/cdn-cgi/')) continue;
      if (!seen.has(u.href)) seen.set(u.href, path);
    }
  }
  const bad: string[] = [];
  for (const [u, from] of [...seen].slice(0, 400)) {
    const r = await request.get(u, { failOnStatusCode: false, maxRedirects: 5 });
    // /admin is staff-only (401 signed out) by design
    if (r.status() >= 400 && !(new URL(u).pathname === '/admin' && r.status() === 401)) bad.push(`${r.status()} ${u} (on ${from})`);
  }
  test.info().annotations.push({ type: 'links checked', description: String(Math.min(seen.size, 400)) });
  expect(bad).toEqual([]);
});
