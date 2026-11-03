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
});
