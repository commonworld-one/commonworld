/** Header circle to Muse RAISE: Forge's avatar in a .cw-iconbtn right after the Atlas globe, served from /assets (not hotlinked). */
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/pages/assets.gen';

const get = async (path: string) => {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`));
  return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
};

describe('Muse RAISE header circle', () => {
  it('sits right after the Atlas globe, links raise.commonworld.one, uses the local Forge avatar', async () => {
    const html = new TextDecoder().decode((await get('/sections')).body);
    const top = html.slice(html.indexOf('<header class="cw-top">'), html.indexOf('</header>'));
    const globe = top.indexOf('aria-label="Atlas" title="Atlas"');
    const circle = top.indexOf('<a class="cw-iconbtn cw-raise" href="https://raise.commonworld.one" rel="noopener" aria-label="Muse RAISE" title="Muse RAISE">');
    expect(globe).toBeGreaterThan(0);
    expect(circle).toBeGreaterThan(globe);
    expect(top.slice(globe, circle)).toMatch(/^[^<]*>.*?<\/svg><\/a>$/s); // nothing between the globe link and the circle
    expect(top).toContain(`<img src="/assets/raise-forge.png?v=${ASSETS['raise-forge.png'].hash}" alt="" width="32" height="32" decoding="async">`);
    expect(top).not.toContain('raise.commonworld.one/avatars');
  });

  it('serves the avatar as a small PNG (96 px)', async () => {
    const r = await get(`/assets/raise-forge.png?v=${ASSETS['raise-forge.png'].hash}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const dv = new DataView(r.body.buffer);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([96, 96]);
    expect(r.body.byteLength).toBeLessThan(20_000);
  });

  it('yields its space in a signed-in header on screens <= 420 px (no overflow at 390/414 px), same breakpoint as the narrow search', () => {
    const css = ASSETS['ssr.css'].text!;
    expect(css).toContain('@media (max-width:420px) { .cw-top:has(.cw-signout) > .cw-raise { display:none; } }');
    expect(css).not.toContain('@media (max-width:400px) { .cw-top:has(.cw-signout)');
    // the narrow-search rule that gives the search its 104 px minimum uses the same breakpoint
    const narrow = css.slice(css.indexOf('@media (max-width:420px) {\n'));
    expect(narrow.slice(0, narrow.indexOf('}\n}'))).toContain('.cw-search-wrap { min-width:104px; }');
    // signed-out headers keep the circle: the only rule hiding it is scoped to a header with a Sign out form
    expect(css.match(/\.cw-raise\s*\{\s*display:none/g)?.length).toBe(1);
  });

  it('is described in /llms.txt and /llms-full.txt', async () => {
    const line = 'open board where Muses post and join feature wishes and bug reports; open API and MCP for Muse & Muse Code.';
    for (const path of ['/llms.txt', '/llms-full.txt']) {
      const txt = new TextDecoder().decode((await get(path)).body);
      expect(txt).toContain(`[Muse RAISE](https://raise.commonworld.one): ${line}`);
    }
  });
});
