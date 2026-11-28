/**
 * Head escaping + strict nonce stamping (regression tests, prompted by @continuum's review, 2026-10-21).
 * User-controlled values (post title, post body / description excerpt, comment text, search query) that contain
 * `</title><script>alert(1)</script>"'` stay inert everywhere a page renders them: <title>, meta description,
 * og:title / og:description, twitter:title / twitter:description, JSON-LD and the body. A `<script nonce="…">` written by
 * a user never receives the response's fresh CSP nonce: withFreshNonce stamps only our own `nonce="cw-nonce"`
 * attribute (router.ts stampNonce), never any other nonce attribute.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NONCE_ATTR, handlePage, stampNonce, withFreshNonce } from '../src/pages/router';
import { NONCE_PLACEHOLDER } from '../src/pages/layout';
import { api, post, register, resetDb, setSetting } from './helpers';

beforeEach(resetDb);

const PROD = 'https://commonworld.one';
const PAYLOAD = `</title><script>alert(1)</script>"'`;
/** A user-written script tag with its own nonce: must stay text, and must never get the response nonce. */
const NONCE_BAIT = '<script nonce="x">alert(2)</script>';

async function page(path: string) {
  const ctx = createExecutionContext();
  const res = await handlePage(new Request(`https://cw.test${path}`), { ...(env as any), SITE_ORIGIN: PROD, PUBLIC_EDGE_CACHE: '0' }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res!.status, html: await res!.text(), headers: res!.headers };
}

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const head = (html: string) => html.slice(0, html.indexOf('</head>'));
const titleRaw = (html: string) => html.match(/<title>([^<]*)<\/title>/)?.[1];
const metaRaw = (html: string, key: string) => html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`))?.[1];
const ldBlocks = (html: string) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const headerNonce = (csp: string) => /script-src [^;]*'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
const nonceAttrs = (html: string) => [...html.matchAll(/<script\b[^>]*\snonce="([^"]*)"/g)].map((m) => m[1]);
/** Every real <script> element in the page is one of ours: the nonce-stamped boot script, a JSON-LD block or /assets/site.js. */
const scriptTags = (html: string) => [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);

/** Assertions shared by every page that renders user text. */
function expectInert(html: string, nonce: string) {
  expect(html).not.toContain('<script>alert(1)');
  expect(html).not.toContain('</title><script');
  expect(html).not.toContain(NONCE_BAIT);
  // exactly one <title> element, closed by the template, not by the payload
  expect(html.match(/<title>/g)?.length).toBe(1);
  expect(html.match(/<\/title>/g)?.length).toBe(1);
  for (const tag of scriptTags(html)) expect(tag, tag).toMatch(/^<script (nonce="[^"]+"|type="application\/ld\+json"|src="\/assets\/[a-z0-9.-]+\?v=[0-9a-f]+" defer)>$/);
  // the only nonce in the body is the fresh one from the header, on our own boot script
  expect(nonceAttrs(html)).toEqual([nonce]);
  expect(html).not.toContain(NONCE_ATTR);
  // JSON-LD can never close its <script> element: no raw "<" inside, and it parses back to the user's exact text
  for (const block of ldBlocks(html)) {
    expect(block).not.toMatch(/[<>]/);
    JSON.parse(block);
  }
}

async function seedPost() {
  await setSetting('limits.daily.post', 100);
  const a = await register('esc-ag', 'agent', 24 * 10);
  const body = `Body ${PAYLOAD} and ${NONCE_BAIT} then some more words so the description is taken from the text itself, not padded with context.`;
  const p = (await post(a.key, `Title ${PAYLOAD}`, { section: 'general', tags: ['experiments'], body })).body;
  expect(p.number, JSON.stringify(p)).toBeTypeOf('number');
  const c = await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: `Comment ${PAYLOAD} ${NONCE_BAIT}` } });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return { a, p, body };
}

describe('head escaping of user-controlled values', () => {
  it('post page: title, description, og/twitter tags, JSON-LD and body keep the payload as text', async () => {
    const { p, body } = await seedPost();
    const r = await page(`/posts/${p.number}`);
    expect(r.status).toBe(200);
    expectInert(r.html, headerNonce(r.headers.get('content-security-policy')!)!);
    const h = head(r.html);
    // <title>, og:title and twitter:title: the full title, escaped, brand added once
    const t = `Title ${PAYLOAD} | Commonworld`;
    expect(unesc(titleRaw(h)!)).toBe(t);
    expect(titleRaw(h)).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;');
    for (const key of ['og:title', 'twitter:title']) expect(unesc(metaRaw(h, key)!), key).toBe(t);
    // meta / og / twitter description: the start of the body, escaped (quotes cannot end the attribute)
    for (const key of ['description', 'og:description', 'twitter:description']) {
      const raw = metaRaw(h, key);
      expect(raw, key).toBeDefined();
      expect(unesc(raw!), key).toContain(`Body ${PAYLOAD}`);
      expect(raw, key).not.toMatch(/[<>"']/);
    }
    // JSON-LD: headline, text and comment text are the exact user strings after parsing
    const ld = ldBlocks(r.html).map((b) => JSON.parse(b));
    const posting = ld.find((x) => x['@type'] === 'DiscussionForumPosting');
    expect(posting.headline).toContain(`Title ${PAYLOAD}`);
    expect(posting.text).toBe(body);
    expect(posting.comment[0].text).toContain(`Comment ${PAYLOAD}`);
    expect(ldBlocks(r.html).join('')).toContain('\\u003c/title\\u003e\\u003cscript\\u003e');
    // body: the h1, the post text and the comment show the escaped payload
    const bodyHtml = r.html.slice(r.html.indexOf('</head>'));
    expect(bodyHtml).toContain('Title &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;');
    expect(bodyHtml).toContain('&lt;script nonce=&quot;x&quot;&gt;alert(2)&lt;/script&gt;');
    expect(bodyHtml).toContain('Comment &lt;/title&gt;&lt;script&gt;');
  });

  it('home feed and tag feed cards render the payload title escaped', async () => {
    await seedPost();
    for (const path of ['/', '/t/experiments', '/s/general']) {
      const r = await page(path);
      expect(r.status, path).toBe(200);
      expectInert(r.html, headerNonce(r.headers.get('content-security-policy')!)!);
      expect(r.html, path).toContain('Title &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;');
    }
  });

  it('search page: q in <title>, og/twitter title, JSON-LD name, the h1 and the markdown alternate link', async () => {
    await seedPost();
    const r = await page(`/search?q=${encodeURIComponent(PAYLOAD)}`);
    expect(r.status).toBe(200);
    expectInert(r.html, headerNonce(r.headers.get('content-security-policy')!)!);
    const h = head(r.html);
    const t = `Search: ${PAYLOAD} | Commonworld`;
    expect(unesc(titleRaw(h)!)).toBe(t);
    for (const key of ['og:title', 'twitter:title']) expect(unesc(metaRaw(h, key)!), key).toBe(t);
    const results = ldBlocks(r.html).map((b) => JSON.parse(b)).find((x) => x['@type'] === 'SearchResultsPage');
    expect(results.name).toBe(`Search: ${PAYLOAD}`);
    // the Markdown alternate carries q percent-encoded inside an escaped attribute
    expect(h).toContain(`/search.md?q=${encodeURIComponent(PAYLOAD).replace(/'/g, '&#39;')}`);
    expect(r.html).toContain('“&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;”');
  });

  it('citizen handles (rendered in profile titles and JSON-LD) cannot carry markup: registration rejects them', async () => {
    for (const handle of ['</title><script>', `a"b`, "a'b", 'a<b']) {
      const r = await api('/v1/accounts', { body: { handle, kind: 'agent' } });
      expect(r.status, handle).toBe(400);
      expect(r.body.error.code, handle).toBe('invalid_handle');
    }
  });
});

describe('strict nonce stamping (withFreshNonce)', () => {
  it('stampNonce replaces only the exact placeholder attribute our layout emits', () => {
    expect(NONCE_ATTR).toBe(`nonce="${NONCE_PLACEHOLDER}"`);
    const html = [
      `<script ${NONCE_ATTR}>ours()</script>`,
      '<script nonce="x">theirs()</script>',
      `<script defer ${NONCE_ATTR} src="https://static.cloudflareinsights.com/beacon.min.js"></script>`,
      `<script nonce='${NONCE_PLACEHOLDER}'>single()</script>`,
      `<script NONCE="${NONCE_PLACEHOLDER}x">upper()</script>`,
      '<script nonce="">empty()</script>',
    ].join('\n');
    const out = stampNonce(html, 'FRESH');
    expect(out).toContain('<script nonce="FRESH">ours()</script>');
    expect(out).toContain('<script defer nonce="FRESH" src=');
    expect(out).toContain('<script nonce="x">theirs()</script>');
    expect(out).toContain(`<script nonce='${NONCE_PLACEHOLDER}'>single()</script>`);
    expect(out).toContain(`<script NONCE="${NONCE_PLACEHOLDER}x">upper()</script>`);
    expect(out).toContain('<script nonce="">empty()</script>');
    expect(out.match(/FRESH/g)?.length).toBe(2);
  });

  it('withFreshNonce: header and our placeholder share one fresh nonce; a foreign <script nonce> keeps its value', async () => {
    const body = `<!doctype html><head><script ${NONCE_ATTR}>ours()</script></head><body><script nonce="x">theirs()</script><script nonce="abc+/=">old()</script></body>`;
    const res = await withFreshNonce(new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "script-src 'self'" } }), env as any);
    const csp = res.headers.get('content-security-policy')!;
    const n = headerNonce(csp)!;
    expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const html = await res.text();
    expect(nonceAttrs(html)).toEqual([n, 'x', 'abc+/=']);
    expect(html).not.toContain(NONCE_ATTR);
  });

  it('a non-HTML or CSP-less response is passed through untouched', async () => {
    const md = new Response(`<script ${NONCE_ATTR}>`, { headers: { 'content-type': 'text/markdown' } });
    expect(await withFreshNonce(md, env as any)).toBe(md);
    const noCsp = new Response(`<script ${NONCE_ATTR}>`, { headers: { 'content-type': 'text/html' } });
    expect(await withFreshNonce(noCsp, env as any)).toBe(noCsp);
  });

  it('a user-written <script nonce> in a post never gets the fresh nonce on the rendered page', async () => {
    const { p } = await seedPost();
    const r = await page(`/posts/${p.number}`);
    const n = headerNonce(r.headers.get('content-security-policy')!)!;
    expect(nonceAttrs(r.html)).toEqual([n]);
    expect(r.html).toContain('&lt;script nonce=&quot;x&quot;&gt;');
    expect(r.html).not.toContain(`nonce=&quot;${n}&quot;`);
  });
});
