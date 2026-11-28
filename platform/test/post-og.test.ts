/**
 * Per-post Open Graph image (2026-10-23): GET /posts/{n}/og.png is the post's own 1200x630 PNG (src/pages/og.ts), the
 * post page points og:image / twitter:image at it with a ?v= cache-buster and the title as alt text, and the meta
 * descriptions of a post are plain text (Markdown syntax removed, plainText in src/pages/html.ts).
 */
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { handlePage, OG_CACHE_CURRENT, OG_CACHE_OTHER } from '../src/pages/router';
import { plainText } from '../src/pages/html';
import { DESC_MAX, postDescription, wordExcerpt } from '../src/pages/post';
import { OG_LAYOUT } from '../src/pages/og-assets.gen';
import { type PostOg, layoutPost, ogVersion, renderPostOg, sectionColor } from '../src/pages/og';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

beforeEach(resetDb);

const PROD = 'https://commonworld.one';
async function prodPage(path: string) {
  const res = await handlePage(new Request(`https://cw.test${path}`), { ...(env as any), SITE_ORIGIN: PROD }, createExecutionContext());
  return { status: res!.status, html: await res!.text(), headers: res!.headers };
}
async function get(path: string, method = 'GET') {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { method, redirect: 'manual' }));
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}
// &amp; last, so "&amp;lt;" becomes "&lt;" and not "<"
const unesc = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const meta = (html: string, key: string) => {
  const v = html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`))?.[1];
  return v === undefined ? undefined : unesc(v);
};
const ldOf = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) => JSON.parse(m[1]));

/** Minimal PNG reader: checks the signature and every chunk CRC, returns IHDR fields, palette size and the inflated image data. */
async function readPng(b: Uint8Array) {
  expect([...b.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (u: Uint8Array) => { let c = 0xffffffff; for (const x of u) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  let o = 8;
  const types: string[] = [];
  let ihdr: { w: number; h: number; depth: number; color: number } | null = null;
  let plte = 0;
  const idat: Uint8Array[] = [];
  while (o < b.length) {
    const len = dv.getUint32(o);
    const type = new TextDecoder().decode(b.slice(o + 4, o + 8));
    expect(dv.getUint32(o + 8 + len), `${type} crc`).toBe(crc(b.slice(o + 4, o + 8 + len)));
    const data = b.slice(o + 8, o + 8 + len);
    types.push(type);
    if (type === 'IHDR') ihdr = { w: dv.getUint32(o + 8), h: dv.getUint32(o + 12), depth: data[8], color: data[9] };
    if (type === 'PLTE') plte = len / 3;
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const all = new Uint8Array(idat.reduce((n, x) => n + x.length, 0));
  let p = 0;
  for (const x of idat) { all.set(x, p); p += x.length; }
  const raw = new Uint8Array(await new Response(new Blob([all]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  return { types, ihdr: ihdr!, plte, raw };
}

const SAMPLE: PostOg = {
  number: 22, title: 'Commonworld Agent Discovery Watch #2: From Cloudflare Observations to an Independent Agent Discovery Benchmark',
  handle: 'nerd27dk', kind: 'human', section_slug: 'general', section_name: 'General', created_at: '2026-10-23T08:10:00.000Z',
};

describe('plainText: Markdown syntax out of meta descriptions', () => {
  it('drops emphasis, links, headings, code, lists, quotes and tables but keeps the words', () => {
    const cases: [string, string][] = [
      ['**How do AI systems discover agents?**', 'How do AI systems discover agents?'],
      ['__bold__ and *italic* and _also_ and ***both*** and ~~gone~~', 'bold and italic and also and both and gone'],
      ['See [the docs](https://example.com/a_(b)) and ![a chart](https://x.test/c.png "t")', 'See the docs and a chart'],
      ['Use `npm test` or <https://commonworld.one>', 'Use npm test or https://commonworld.one'],
      ['## 1. Recent observations ##', '1. Recent observations'],
      ['# C# tips', 'C# tips'],
      ['> quoted line', 'quoted line'],
      ['- one\n* two\n+ three\n1. four\n2) five\n- [x] done', 'one\ntwo\nthree\nfour\nfive\ndone'],
      ['| Signal | Oct 22 |\n| --- | ---: |\n| OAI-SearchBot | 6 |', 'Signal · Oct 22\n\nOAI-SearchBot · 6'],
      ['```ts\nconst a = 1;\n```', '\nconst a = 1;\n'],
      ['above\n\n---\n\nbelow', 'above\n\n\n\nbelow'],
      ['a \\*literal\\* star', 'a *literal* star'],
    ];
    for (const [md, want] of cases) expect(plainText(md), md).toBe(want);
  });

  it('leaves ordinary text alone: snake_case, arithmetic, @handles, post refs, a lone star or underscore', () => {
    for (const s of ['call snake_case_name now', '2*3*4 = 24', 'ask @memory-bot about post-12', 'rated 5* overall', 'a _ b', 'file_name.md and v1_2_3']) {
      expect(plainText(s), s).toBe(s);
    }
  });

  it('stays fast on hostile input (no catastrophic backtracking)', () => {
    const inputs = ['[a](' + 'x'.repeat(5000), '**'.repeat(3000), '*a '.repeat(3000), '_a '.repeat(3000), '[' .repeat(3000) + '](', '`'.repeat(5000), '| a '.repeat(2000), '~~'.repeat(3000)];
    const t0 = Date.now();
    for (const s of inputs) plainText(s);
    // workerd freezes Date.now() during pure CPU work; this also runs under Node-like timers in other pools
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a post description is plain text, at most DESC_MAX characters, cut on a word with an ellipsis', () => {
    const body = 'Commonworld is exploring a simple question:\n\n**How do AI systems discover, retrieve, and interact with an agent-native platform?**\n\nOur [Cloudflare](https://cloudflare.com) observations show *meaningful* differences between AI crawlers and search bots.';
    const d = postDescription({ body, section: { name: 'General' }, author: { handle: 'a', kind: 'human' } });
    expect(d).toBe('Commonworld is exploring a simple question: How do AI systems discover, retrieve, and interact with an agent-native platform? Our Cloudflare observations show…');
    expect(d.length).toBeLessThanOrEqual(DESC_MAX);
    expect(d).not.toMatch(/[*_[\]#`]/);
    // short Markdown body: plain text + the context sentence
    const s = postDescription({ body: '## Hello **there**', section: { name: 'General' }, author: { handle: 'bob', kind: 'agent' } });
    expect(s).toBe('Hello there · A post in General by @bob (AI agent) on Commonworld.');
  });
});

describe('postDescription: always cut on a word boundary', () => {
  const ctxOf = (handle = 'a') => `A post in General by @${handle} on Commonworld.`;
  const desc = (body: string) => postDescription({ body, section: { name: 'General' }, author: { handle: 'a', kind: 'human' } });

  it('wordExcerpt keeps whole words, ends with …, fits max, and gives \'\' when no boundary fits', () => {
    expect(wordExcerpt('short text', 20)).toBe('short text');
    expect(wordExcerpt('alpha beta gamma delta', 12)).toBe('alpha beta…');
    expect(wordExcerpt('alpha beta gamma delta', 11)).toBe('alpha beta…'); // the space right after "beta" is a boundary
    expect(wordExcerpt('alpha beta gamma delta', 10)).toBe('alpha…');
    // a word or URL longer than the room is never split
    expect(wordExcerpt(`https://example.com/${'a'.repeat(300)}`, 160)).toBe('');
    expect(wordExcerpt(`See https://example.com/${'a'.repeat(300)}`, 160)).toBe('See…');
    expect(wordExcerpt('x'.repeat(50), 1)).toBe('');
    for (let max = 2; max < 60; max++) {
      const out = wordExcerpt('lorem ipsum dolor sit amet consectetur adipiscing elit sed do', max);
      expect(out.length, String(max)).toBeLessThanOrEqual(max);
      if (out) expect('lorem ipsum dolor sit amet consectetur adipiscing elit sed do'.startsWith(out.slice(0, -1)), String(max)).toBe(true);
    }
  });

  it('a long word or URL past the preferred range is dropped whole, not split', () => {
    const words = 'Short words here then a link'; // 28 chars, so the old 60% rule would hard-cut the URL
    const url = `https://example.com/${'p'.repeat(400)}`;
    const d = desc(`${words} ${url}`);
    expect(d).toBe(`${words}… · ${ctxOf()}`);
    expect(d).not.toContain('https://');
    expect(d.length).toBeLessThanOrEqual(DESC_MAX);
  });

  it('a body that is one unbroken token gives just the context sentence', () => {
    expect(desc('y'.repeat(500))).toBe(ctxOf());
    expect(desc(`https://example.com/${'q'.repeat(500)}`)).toBe(ctxOf());
  });

  it('every description of a long text ends on a whole word', () => {
    const body = Array.from({ length: 80 }, (_, i) => `word${i}${i % 7 === 0 ? 'x'.repeat(i) : ''}`).join(' ');
    const d = desc(body);
    expect(d.length).toBeLessThanOrEqual(DESC_MAX);
    expect(d.endsWith('…')).toBe(true);
    expect(body.startsWith(d.slice(0, -1))).toBe(true);
    expect(body[d.length - 1]).toBe(' ');
  });
});

describe('post page: own og:image, alt = title, plain-text descriptions', () => {
  it('og:image and twitter:image point at /posts/{n}/og.png?v=…, alt is the title, descriptions have no Markdown', async () => {
    const a = await register('og-author', 'agent', 24 * 10);
    const title = 'Agent Discovery Watch: **not** markdown in titles';
    const p = (await post(a.key, title, { body: '**How do AI systems discover platforms?** See [our notes](https://commonworld.one/posts/1) and `code`.\n\n## Next\n\nMore text here to make the body long enough for a full description without context.' })).body;
    const r = await prodPage(`/posts/${p.number}`);
    expect(r.status).toBe(200);
    const img = meta(r.html, 'og:image')!;
    expect(img).toMatch(new RegExp(`^${PROD}/posts/${p.number}/og\\.png\\?v=[0-9a-z]{1,8}$`));
    expect(meta(r.html, 'twitter:image')).toBe(img);
    expect(meta(r.html, 'og:image:alt')).toBe(title);
    expect(meta(r.html, 'twitter:image:alt')).toBe(title);
    expect(meta(r.html, 'og:image:type')).toBe('image/png');
    expect(meta(r.html, 'og:image:width')).toBe('1200');
    expect(meta(r.html, 'og:image:height')).toBe('630');
    expect(meta(r.html, 'twitter:card')).toBe('summary_large_image');
    for (const k of ['description', 'og:description', 'twitter:description']) {
      const d = meta(r.html, k)!;
      expect(d, k).toMatch(/^How do AI systems discover platforms\? See our notes and code\. Next More text/);
      expect(d, k).not.toMatch(/[*`#[\]]/);
    }
    const ld = ldOf(r.html).find((x) => x['@type'] === 'DiscussionForumPosting');
    expect(ld.image).toBe(img);

    // the version in the URL is the one the image route calls current
    const v = new URL(img).searchParams.get('v');
    const og = await get(`/posts/${p.number}/og.png?v=${v}`);
    expect(og.headers.get('cache-control')).toBe(OG_CACHE_CURRENT);
  });

  it('other pages and a withdrawn post keep the default image', async () => {
    const a = await register('og-wd', 'agent', 24 * 10);
    const p = (await post(a.key, 'Will be withdrawn')).body;
    expect((await api(`/v1/posts/${p.number}/withdraw`, { key: a.key, body: { reason: 'QA' } })).status).toBe(200);
    for (const path of ['/', `/posts/${p.number}`, `/c/${a.handle}`]) {
      const r = await prodPage(path);
      expect(meta(r.html, 'og:image'), path).toMatch(new RegExp(`^${PROD}/assets/og-default\\.png\\?v=`));
      expect(meta(r.html, 'og:image:alt'), path).toBe('Commonworld: a shared world for humans and agents');
    }
    expect((await get(`/posts/${p.number}/og.png`)).status).toBe(404);
  });
});

describe('GET /posts/{n}/og.png', () => {
  it('is a valid 1200x630 palette PNG under 5 MB, image/png, deterministic, HEAD without a body', async () => {
    const a = await register('og-png', 'human', 24 * 10);
    const p = (await post(a.key, 'Hello, world — привет 🚀', { section: 'general' })).body;
    const r = await get(`/posts/${p.number}/og.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe(OG_CACHE_OTHER); // no ?v=: short cache
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.bytes.length).toBeLessThan(5 * 1024 * 1024);
    const png = await readPng(r.bytes);
    expect(png.types).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(png.ihdr).toEqual({ w: 1200, h: 630, depth: 8, color: 3 });
    expect(png.plte).toBeLessThanOrEqual(256);
    expect(png.raw.length).toBe(630 * 1201);
    // every pixel index is inside the palette, every row filter is None
    for (let y = 0; y < 630; y++) expect(png.raw[y * 1201]).toBe(0);
    let maxIdx = 0;
    for (const x of png.raw) if (x > maxIdx) maxIdx = x;
    expect(maxIdx).toBeLessThan(png.plte);

    expect((await get(`/posts/${p.number}/og.png`)).bytes).toEqual(r.bytes);
    const head = await get(`/posts/${p.number}/og.png`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
  });

  it('404 for a missing or hidden post (no title leaks), 405 for POST', async () => {
    const admin = await makeAdmin();
    const a = await register('og-hidden', 'agent', 24 * 10);
    const p = (await post(a.key, 'Hide this one')).body;
    expect((await get(`/posts/${p.number}/og.png`)).status).toBe(200);
    expect((await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 3, reason: 'test' } })).status).toBe(200);
    for (const path of [`/posts/${p.number}/og.png`, '/posts/999999/og.png']) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get('cache-control'), path).toBe('no-store');
    }
    // the hidden post's page keeps the default image
    const page = await prodPage(`/posts/${p.number}`);
    expect(meta(page.html, 'og:image')).toMatch(/\/assets\/og-default\.png\?v=/);
    expect((await get(`/posts/${p.number}/og.png`, 'POST')).status).toBe(405);
  });

  it("404 for a deleted account's retained '[deleted]' stub; its page keeps og-default.png", async () => {
    const admin = await makeAdmin();
    const gone = await register('og-leaver', 'human', 24 * 10);
    const other = await register('og-stayer', 'agent', 24 * 10);
    const p = (await post(gone.key, 'Busy post by a leaver')).body;
    // a comment by someone else keeps the post as a '[deleted]' stub after the account is deleted
    expect((await api(`/v1/posts/${p.number}/comments`, { key: other.key, body: { body: 'keeps the stub' } })).status).toBe(201);
    expect((await get(`/posts/${p.number}/og.png`)).status).toBe(200);
    expect((await api('/v1/me/deletion-request', { method: 'POST', key: gone.key })).status).toBe(200);
    const del = await api(`/v1/admin/accounts/${gone.handle}/delete`, { key: admin.key, body: { confirm_handle: gone.handle, reason: 'test' } });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.kept_as_placeholders.posts).toBe(1);
    const r = await get(`/posts/${p.number}/og.png`);
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const page = await prodPage(`/posts/${p.number}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('<meta name="robots" content="noindex,follow">');
    expect(meta(page.html, 'og:image')).toMatch(new RegExp(`^${PROD}/assets/og-default\\.png\\?v=`));
    expect(meta(page.html, 'twitter:image')).toMatch(/\/assets\/og-default\.png\?v=/);
    expect(page.html).not.toContain(`/posts/${p.number}/og.png`);
    const ld = ldOf(page.html).find((x) => x['@type'] === 'DiscussionForumPosting');
    expect(ld.image).toBeUndefined();
  });

  it('edge cache: warm copy is served, a hide drops it at once (content cache version)', async () => {
    const { bumpContentCacheVersion } = await import('../src/cache-version');
    await bumpContentCacheVersion(env.DB).run();
    const edge = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://cw.test${path}`), { ...env, PUBLIC_EDGE_CACHE: '1' } as any, ctx);
      await waitOnExecutionContext(ctx);
      return { status: res.status, cache: res.headers.get('x-cw-cache'), body: await res.arrayBuffer() };
    };
    const admin = await makeAdmin();
    const a = await register('og-edge', 'agent', 24 * 10);
    const p = (await post(a.key, `Edge ${crypto.randomUUID().slice(0, 8)}`)).body;
    const path = `/posts/${p.number}/og.png?v=x1`;
    expect((await edge(path)).cache).toBeNull();
    const hit = await edge(path);
    expect(hit.status).toBe(200);
    expect(hit.cache).toBe('HIT');
    await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 1 } });
    expect((await edge(path)).status).toBe(404);
  });

  it('section colors come from product.css (unknown: olive); an emoji-only title shows post-N', async () => {
    expect(sectionColor('general')).toMatch(/^#[0-9a-f]{6}$/);
    expect(sectionColor('no-such-section')).toBeNull();
    const px = await layoutPost({ ...SAMPLE, title: '🚀🚀🚀' }, 'commonworld.one');
    // something was drawn in the title area (ink ramp) even though no emoji glyph exists: the post-N fallback
    const ink = OG_LAYOUT.RAMP_BASE.ink;
    let inkPixels = 0;
    for (let y = 214; y < 300; y++) for (let x = 90; x < 1110; x++) if (px[y * 1200 + x] > ink && px[y * 1200 + x] < ink + 16) inkPixels++;
    expect(inkPixels).toBeGreaterThan(500);
  });

  it('never draws outside the card, even for very long titles, handles and section names', async () => {
    const long: PostOg = { ...SAMPLE, number: 123456789012345, title: 'W'.repeat(400), handle: 'x'.repeat(32), kind: 'agent', section_name: 'S'.repeat(200) };
    const base = await layoutPost({ ...SAMPLE, title: '', handle: null, section_name: '' }, 'commonworld.one');
    const px = await layoutPost(long, 'commonworld.one');
    for (let y = 0; y < 630; y++) {
      for (let x = 0; x < 1200; x++) {
        if (x >= 42 && x < 1158 && y >= 42 && y < 588) continue;
        if (px[y * 1200 + x] !== base[y * 1200 + x]) throw new Error(`pixel outside the card changed at ${x},${y}`);
      }
    }
    expect((await renderPostOg(long, 'commonworld.one')).length).toBeLessThan(5 * 1024 * 1024);
  });

  it('?v= changes with what is drawn (title, author, section), not with anything else', () => {
    const v = ogVersion(SAMPLE);
    expect(ogVersion({ ...SAMPLE })).toBe(v);
    expect(ogVersion({ ...SAMPLE, title: 'Other' })).not.toBe(v);
    expect(ogVersion({ ...SAMPLE, handle: 'other' })).not.toBe(v);
    expect(ogVersion({ ...SAMPLE, section_slug: 'protocol', section_name: 'Protocol' })).not.toBe(v);
  });
});

describe('docs', () => {
  it('/llms.txt names the image URL', async () => {
    await setSetting('limits.daily.post', 100);
    const r = await (exports as any).default.fetch(new Request('https://cw.test/llms.txt'));
    expect(await r.text()).toContain('/posts/{number}/og.png');
  });
});
