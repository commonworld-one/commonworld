/**
 * Low findings of the staging QA pass of 2026-10-17, fixed in the polish pass: mobile legible font sizes (CSS),
 * staging sitemap without the Atlas root pages, no canonical on error pages, Atlas llms screenshots link.
 * (New content showing at once: test/cache.test.ts; RateLimit-* headers: test/ratelimit.test.ts.)
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { cleanAtlasDoc } from '../src/atlas-proxy';
import { ASSETS } from '../src/pages/assets.gen';
import { recount, register, resetDb } from './helpers';

beforeEach(resetDb);

async function call(path: string, vars: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }), { ...env, PUBLIC_EDGE_CACHE: '0', ...vars } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('QA polish 2026-10-17', () => {
  it('phones (<= 720 px): the small meta text styles are lifted to 12 px', () => {
    const css = ASSETS['ssr.css'].text!;
    const block = css.slice(css.lastIndexOf('@media (max-width:720px)'));
    for (const sel of ['.formula', '.cw-foot', '.cw-stat span', '.list.stack td.st::before', '.kb', '.ref', '.byline']) expect(block, sel).toContain(sel);
    expect(block).toMatch(/\{ font-size:12px; \}/);
  });

  it('staging sitemap (PAGES_NOINDEX=1 + Atlas proxy) does not list /about/ /privacy/ /terms/ /stats/; production-like does', async () => {
    const atlas = { ATLAS_ORIGIN: 'https://atlas-pages.test' };
    const staging = await call('/sitemap-v1.xml', { ...atlas, PAGES_NOINDEX: '1', SITE_ORIGIN: 'https://staging.example' });
    expect(staging.status).toBe(200);
    for (const p of ['/about/', '/privacy/', '/terms/', '/stats/']) expect(staging.text).not.toContain(`https://staging.example${p}<`);
    const prod = await call('/sitemap-v1.xml', { ...atlas, SITE_ORIGIN: 'https://commonworld.one' });
    for (const p of ['/about/', '/privacy/', '/terms/', '/stats/']) expect(prod.text, p).toContain(`https://commonworld.one${p}<`);
  });

  it('error pages declare no canonical URL', async () => {
    for (const path of ['/no-such-page', '/posts/99999', '/c/nobody-here-x']) {
      const r = await call(path);
      expect(r.status, path).toBe(404);
      expect(r.text, path).not.toContain('rel="canonical"');
    }
    expect((await call('/')).text).toContain('rel="canonical"');
  });

  it('the bare Atlas screenshots directory URL becomes a code template; templates and other links stay', () => {
    const src = '- Homepage screenshots (`preview`, https://commonworld.one/atlas/screens/): third-party\n'
      + 'https://commonworld.one/atlas/screens/<id>.webp and https://commonworld.one/atlas/screens/manifest.json\n';
    const out = cleanAtlasDoc(src);
    expect(out).toContain('(`preview`, `https://commonworld.one/atlas/screens/<id>.webp`)');
    expect(out).toContain('https://commonworld.one/atlas/screens/<id>.webp and https://commonworld.one/atlas/screens/manifest.json');
    expect(out).not.toMatch(/screens\/\)/);
  });

  it('humans / agents / citizens counts read right at 0, 1 and 2 (home + /citizens; Codex re-check)', async () => {
    const text = async (path: string) => (await call(path)).text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    await recount();
    let home = await text('/'), cit = await text('/citizens');
    expect(home).toContain('0 citizens · 0 humans · 0 agents');
    expect(cit).toContain('0 humans and 0 agents');
    await register('solo', 'human');
    await recount();
    home = await text('/'); cit = await text('/citizens');
    expect(home).toContain('1 citizen · 1 human · 0 agents');
    expect(cit).toContain('1 human and 0 agents');
    expect(cit).toContain('1 citizen ');
    await register('bot', 'agent');
    await recount();
    home = await text('/'); cit = await text('/citizens');
    expect(home).toContain('2 citizens · 1 human · 1 agent');
    expect(cit).toContain('1 human and 1 agent.');
    await register('second', 'human');
    await register('bot-two', 'agent');
    await recount();
    home = await text('/'); cit = await text('/citizens');
    expect(home).toContain('4 citizens · 2 humans · 2 agents');
    expect(cit).toContain('2 humans and 2 agents');
    for (const t of [home, cit]) expect(t).not.toMatch(/\b1 (humans|agents|citizens)\b/);
  });

  it('header search keeps a visible width at 320 px (narrow-phone CSS)', () => {
    const css = ASSETS['ssr.css'].text!;
    const block = css.slice(css.lastIndexOf('@media (max-width:420px)'));
    expect(block).toMatch(/\.cw-search-wrap \{ min-width:\d+px; \}/);
    expect(block).toContain('.cw-search { padding:9px 26px 9px 9px; }');
  });
});
