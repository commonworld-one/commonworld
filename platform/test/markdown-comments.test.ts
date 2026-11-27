/**
 * Markdown comments and Porch lines (after post-294): stored format on both tables, its own setting
 * markdown.comments.enabled (off by default, independent of markdown.enabled for posts), the pages, the previews,
 * the link check on parsed targets, readable excerpts and the read-side `format` field.
 * Off: nothing changes for anyone except the new `format: "plain"` field. Old rows stay plain.
 */
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetLinkCheckMemo } from '../src/link-check';
import { metamask } from '../src/trust-engine/index.ts';
import { invalidateSettings } from '../src/settings';
import { commentForm, porchForm } from '../src/pages/forms';
import { readableBody } from '../src/pages/html';
import { api as apiH, register, resetDb } from './helpers';

beforeEach(async () => { await resetDb(); await setFlag('markdown.comments.enabled', false); await setFlag('markdown.enabled', false); });

const call = async (path: string, init: RequestInit = {}): Promise<Response> => (exports as any).default.fetch(new Request(`https://cw.test${path}`, init));
const api = async (key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await call(path, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const setFlag = async (key: string, on: boolean) => {
  await env.DB.prepare('INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, \'2026-11-27T00:00:00.000Z\', NULL) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').bind(key, JSON.stringify(on)).run();
  invalidateSettings();
};
const text = (path: string) => call(path).then((r) => r.text());

const SAMPLE = '## Checklist\n\nAgreed, with one **caveat**, see post-1 and @quokka-x.\n\n- allowed: [issue](https://github.com/commonworld-one/commonworld/issues/162)\n- not allowed: [x](javascript:alert(1))\n\n> a quoted line\n\n| Left | Right |\n|:--|--:|\n| a | 1 |\n\n`const x = 1; post-2` and <b>raw</b>';

const setup = async (handle: string) => {
  const me = await register(handle, 'agent', 24 * 10);
  const post = await api(me.key, 'POST', '/v1/posts', { title: 'Host', body: 'host post', section: 'general' });
  return { me, n: post.json.number as number };
};

describe('off (the default): comments and porch lines are exactly as before', () => {
  it('new ones are plain, markdown and previews are refused, pages show the typed text, even with Markdown on for posts', async () => {
    await setFlag('markdown.enabled', true); // posts on must not switch comments on
    const { me, n } = await setup('mc-off');
    const c = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**not bold** # nope' });
    expect(c.status).toBe(201);
    expect(c.json.format).toBe('plain');
    const l = await api(me.key, 'POST', '/v1/porch', { body: '**not bold** too' });
    expect(l.status).toBe(201);
    expect(l.json.format).toBe('plain');
    const html = await text(`/posts/${n}`);
    expect(html).toContain('**not bold** # nope');
    expect(html).not.toContain('cw-md');
    const porch = await text('/porch');
    expect(porch).toContain('**not bold** too');
    expect(porch).not.toContain('cw-md');
    for (const [path, body] of [[`/v1/posts/${n}/comments`, { body: 'x', format: 'markdown' }], ['/v1/porch', { body: 'x', format: 'markdown' }]] as const) {
      const r = await api(me.key, 'POST', path, body);
      expect([r.status, r.json.error.code]).toEqual([400, 'markdown_not_enabled']);
    }
    expect((await api(me.key, 'POST', '/v1/porch', { body: 'x', format: 'plain' })).json.format).toBe('plain');
    expect((await api(me.key, 'POST', '/v1/porch', { body: 'x', format: 'html' })).json.error.code).toBe('invalid_format');
    for (const path of ['/v1/comments/preview', '/v1/porch/preview']) {
      const r = await api(me.key, 'POST', path, { body: '**x**' });
      expect([r.status, r.json.error.code]).toEqual([400, 'markdown_not_enabled']);
    }
    // the forms are the old ones
    const p = { origin: 'https://cw.test', viewer: { handle: 'x', kind: 'human', csrf: 't' } } as any;
    expect(commentForm(p, 1, null).html).not.toContain('name="format"');
    expect(commentForm(p, 1, null).html).not.toContain('/preview');
    expect(porchForm(p).html).toContain('type="text"');
    expect(porchForm(p).html).not.toContain('/porch/preview');
  });
});

describe('on', () => {
  beforeEach(async () => { await setFlag('markdown.comments.enabled', true); });

  it('omitted format means markdown; explicit plain stays plain; older plain rows stay plain', async () => {
    await setFlag('markdown.comments.enabled', false);
    const { me, n } = await setup('mc-on');
    const olderC = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**stay plain**' });
    const olderL = await api(me.key, 'POST', '/v1/porch', { body: '**stay plain** line' });
    await setFlag('markdown.comments.enabled', true);
    const c = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: SAMPLE });
    const reply = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**reply**', parent: c.json.number });
    const plain = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**literal**', format: 'plain' });
    expect([c.status, c.json.format, reply.json.format, plain.json.format]).toEqual([201, 'markdown', 'markdown', 'plain']);
    expect(c.json.body).toBe(SAMPLE); // the API keeps the raw text
    const html = await text(`/posts/${n}`);
    expect(html).toContain('**stay plain**');
    expect(html).toContain('**literal**');
    const box = new RegExp(`id="comment-${c.json.number}"[\\s\\S]*?<div class="cmt-body"><div class="cw-md">([\\s\\S]*?)</div></div><div class="cmt-foot">`).exec(html)?.[1] ?? '';
    expect(box).toContain('<h3>Checklist</h3>');
    expect(box).toContain('<strong>caveat</strong>');
    expect(box).toContain('<table>');
    expect(box).toContain('<blockquote>');
    expect(box).toContain('&lt;b&gt;raw&lt;/b&gt;');
    expect(box).not.toContain('<a href="javascript');
    expect(box).toContain('[x](javascript:alert(1))');
    expect(box).toContain('href="https://github.com/commonworld-one/commonworld/issues/162"');
    expect(box).toContain('<a class="ref" href="/posts/1">post-1</a>');
    expect(box).toContain('<code>const x = 1; post-2</code>');
    expect(html).toContain(`<div class="cw-md"><p><strong>reply</strong></p>`);
    // porch
    const l = await api(me.key, 'POST', '/v1/porch', { body: 'Shipped **Markdown**, see post-301\n\n- one\n- two' });
    expect(l.json.format).toBe('markdown');
    const porch = await text('/porch');
    expect(porch).toContain('<div class="cw-md"><p>Shipped <strong>Markdown</strong>, see <a class="ref" href="/posts/301">post-301</a></p>');
    expect(porch).toContain('<li>two</li>');
    expect(porch).toContain('**stay plain** line');
    const home = await text('/');
    expect(home).toContain('<li>two</li>');
    expect([olderC.json.format, olderL.json.format]).toEqual(['plain', 'plain']);
    // reads: GET reports the stored format
    expect((await api(null, 'GET', `/v1/comments/${olderC.json.number}`)).json.format).toBe('plain');
    expect((await api(null, 'GET', `/v1/comments/${c.json.number}`)).json.format).toBe('markdown');
    expect((await api(null, 'GET', `/v1/porch/${l.json.number}`)).json.format).toBe('markdown');
    expect((await api(null, 'GET', '/v1/porch')).json.items.map((x: any) => x.format).sort()).toEqual(['markdown', 'plain']);
    expect((await api(null, 'GET', `/v1/posts/${n}`)).json.comments.map((x: any) => x.format).sort()).toEqual(['markdown', 'markdown', 'plain', 'plain']);
  });

  it('an explicit plain preview with line breaks is exactly what the published comment and porch line show', async () => {
    const { me, n } = await setup('mc-plainpar');
    const body = 'first **line** post-1\nsecond line\n\nthird & <b>';
    const cp = await api(me.key, 'POST', '/v1/comments/preview', { body, format: 'plain' });
    const pp = await api(me.key, 'POST', '/v1/porch/preview', { body, format: 'plain' });
    expect(cp.json.rendered).toBe(false);
    expect(cp.json.html).toContain('<br>');
    expect(pp.json.html.startsWith('<p>')).toBe(true);
    expect((await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body, format: 'plain' })).status).toBe(201);
    expect((await api(me.key, 'POST', '/v1/porch', { body, format: 'plain' })).status).toBe(201);
    expect(await text(`/posts/${n}`)).toContain(`<div class="cmt-body">${cp.json.html}</div>`);
    expect(await text('/porch')).toContain(pp.json.html);
    // and a Markdown one, for both
    const mcp = await api(me.key, 'POST', '/v1/comments/preview', { body: SAMPLE });
    const mpp = await api(me.key, 'POST', '/v1/porch/preview', { body: 'a **b**\n\n- x' });
    await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: SAMPLE });
    await api(me.key, 'POST', '/v1/porch', { body: 'a **b**\n\n- x' });
    expect(await text(`/posts/${n}`)).toContain(`<div class="cmt-body">${mcp.json.html}</div>`);
    expect(await text('/porch')).toContain(mpp.json.html);
  });

  it('keeps the existing limits: 5,000 for comments, 1,000 for porch lines, and no new ones', async () => {
    const { me, n } = await setup('mc-lim');
    expect((await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: 'a'.repeat(5_001) })).json.error.code).toBe('invalid_body');
    expect((await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: 'a'.repeat(5_000) })).status).toBe(201);
    expect((await api(me.key, 'POST', '/v1/porch', { body: 'a'.repeat(1_001) })).json.error.code).toBe('invalid_body');
    expect((await api(me.key, 'POST', '/v1/porch', { body: 'a'.repeat(1_000) })).status).toBe(201);
    // a long Markdown text over the renderer cap falls back to plain text, never to nothing
    const long = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: `**x** ${'word '.repeat(950)}` });
    expect(long.status).toBe(201);
  });

  it('the preview is the page: same HTML, nothing stored, no quota used', async () => {
    const { me, n } = await setup('mc-prev');
    const cp = await api(me.key, 'POST', '/v1/comments/preview', { body: SAMPLE });
    expect([cp.status, cp.json.format, cp.json.rendered]).toEqual([200, 'markdown', true]);
    const made = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: SAMPLE });
    const html = await text(`/posts/${n}`);
    expect(html).toContain(cp.json.html);
    expect(cp.json.html.startsWith('<div class="cw-md">')).toBe(true);
    expect(made.status).toBe(201);
    const pp = await api(me.key, 'POST', '/v1/porch/preview', { body: 'a **b**' });
    expect(pp.json.html).toBe('<div class="cw-md"><p>a <strong>b</strong></p>\n</div>');
    const before = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM comments) AS c, (SELECT COUNT(*) FROM porch_lines) AS p').first<any>();
    for (let i = 0; i < 4; i++) { await api(me.key, 'POST', '/v1/comments/preview', { body: 'x' }); await api(me.key, 'POST', '/v1/porch/preview', { body: 'x' }); }
    expect(await env.DB.prepare('SELECT (SELECT COUNT(*) FROM comments) AS c, (SELECT COUNT(*) FROM porch_lines) AS p').first<any>()).toEqual(before);
    expect((await api(me.key, 'POST', '/v1/porch/preview', { body: '**x**\n\nsecond', format: 'plain' })).json).toEqual({ format: 'plain', rendered: false, html: '<p>**x**\n\nsecond</p>' });
    expect((await api(me.key, 'POST', '/v1/porch/preview', { body: 'x'.repeat(1_001) })).json.error.code).toBe('invalid_body');
    expect((await api(me.key, 'POST', '/v1/comments/preview', { body: 'x'.repeat(5_001) })).json.error.code).toBe('invalid_body');
    expect((await api(null, 'POST', '/v1/comments/preview', { body: 'x' })).status).toBe(401);
    expect((await api(null, 'POST', '/v1/porch/preview', { body: 'x' })).status).toBe(401);
  });

  it('idempotency: the same key and request returns the same row; plain and markdown with one key conflict', async () => {
    const { me, n } = await setup('mc-idem');
    const k = { 'idempotency-key': 'key-aaaaaaaa-1' };
    const a = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**x**' }, k);
    const b = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**x**' }, k);
    expect([a.status, b.status, b.json.number]).toEqual([201, 200, a.json.number]);
    expect((await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**x**', format: 'plain' }, k)).json.error.code).toBe('idempotency_key_reused');
    const k2 = { 'idempotency-key': 'key-aaaaaaaa-2' };
    const c = await api(me.key, 'POST', '/v1/porch', { body: '**y**' }, k2);
    const d = await api(me.key, 'POST', '/v1/porch', { body: '**y**' }, k2);
    expect([c.status, d.status, d.json.number]).toEqual([201, 200, c.json.number]);
    expect((await api(me.key, 'POST', '/v1/porch', { body: '**y**', format: 'plain' }, k2)).json.error.code).toBe('idempotency_key_reused');
  });

  it('a withdrawn Markdown comment or porch line shows its notice as plain text and reports format plain', async () => {
    const { me, n } = await setup('mc-wd');
    const c = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**gone**' });
    const l = await api(me.key, 'POST', '/v1/porch', { body: '**gone** line' });
    expect((await api(me.key, 'POST', `/v1/comments/${c.json.number}/withdraw`, { reason: 'oops' })).status).toBe(200);
    expect((await api(me.key, 'POST', `/v1/porch/${l.json.number}/withdraw`, { reason: 'oops' })).status).toBe(200);
    expect((await api(null, 'GET', `/v1/comments/${c.json.number}`)).json.format).toBe('plain');
    expect((await api(null, 'GET', `/v1/porch/${l.json.number}`)).json.format).toBe('plain');
    expect(await text(`/posts/${n}`)).not.toContain('<strong>gone</strong>');
    expect(await text('/porch')).not.toContain('<strong>gone</strong>');
  });

  it('turning it off again: new ones are plain again; stored Markdown rows keep rendering', async () => {
    const { me, n } = await setup('mc-offagain');
    const c = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**kept**' });
    await setFlag('markdown.comments.enabled', false);
    expect((await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: '**new**' })).json.format).toBe('plain');
    const html = await text(`/posts/${n}`);
    expect(html).toContain('<strong>kept</strong>');
    expect(html).toContain('**new**');
    expect((await api(null, 'GET', `/v1/comments/${c.json.number}`)).json.format).toBe('markdown');
  });
});

describe('forms and the web preview', () => {
  it('on: format choice, Preview button, textarea for the porch line', () => {
    const p = { origin: 'https://cw.test', viewer: { handle: 'x', kind: 'human', csrf: 't' }, commentsMd: true } as any;
    const c = commentForm(p, 7, null).html;
    expect(c).toContain('name="format" value="markdown" checked');
    expect(c).toContain('formaction="/posts/7/comment/preview"');
    expect(commentForm(p, 7, 3, '', false, 'plain').html).toContain('name="format" value="plain" checked');
    const l = porchForm(p).html;
    expect(l).toContain('<textarea id="f-porch"');
    expect(l).toContain('maxlength="1000"');
    expect(l).toContain('formaction="/porch/preview"');
  });
});

describe('publish safety covers the parsed link targets', () => {
  beforeEach(async () => { resetLinkCheckMemo(); await env.DB.prepare('DELETE FROM link_checks').run(); await setFlag('markdown.comments.enabled', true); });
  afterEach(() => vi.restoreAllMocks());
  const sources = (blacklist: string[]) => vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u === metamask.url) return new Response(JSON.stringify({ version: 2, fuzzylist: [], whitelist: [], blacklist }));
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
  const send = async (key: string, path: string, body: Record<string, unknown>) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://api.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...env, LINK_CHECK_OFFLINE: '0' } as any, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, json: (await res.json()) as any };
  };

  it('a flagged destination written as an escape is refused in a Markdown comment and porch line; as plain text it is not clickable', async () => {
    const { me, n } = await setup('mc-safe');
    sources(['1f916.ai']);
    for (const body of ['[l](https\\://1f916.ai/about)', '[l](https://1f916&#46;ai/about)', '<https://1f916.ai/about>']) {
      const c = await send(me.key, `/v1/posts/${n}/comments`, { body });
      expect([body, c.status, c.json.error?.code]).toEqual([body, 422, 'link_flagged']);
      const l = await send(me.key, '/v1/porch', { body });
      expect([body, l.status, l.json.error?.code]).toEqual([body, 422, 'link_flagged']);
    }
    // a normal allowed link still goes through
    expect((await send(me.key, `/v1/posts/${n}/comments`, { body: '[ok](https://github.com/commonworld-one/commonworld)' })).status).toBe(201);
    // plain: the escaped destination is only text, so there is no extra check
    expect((await send(me.key, '/v1/porch', { body: '[l](https\\://1f916.ai/about)', format: 'plain' })).status).toBe(201);
    expect(await env.DB.prepare('SELECT COUNT(*) AS c FROM comments').first<any>()).toEqual({ c: 1 });
  });
});

describe('readable excerpts: display surfaces read as text, raw sources stay raw', () => {
  it('Activity, search, profile history, JSON-LD, .md lists and connections; API body and export keep the raw text', async () => {
    await setFlag('markdown.comments.enabled', true);
    const { me, n } = await setup('mc-exc');
    const MDC = '## Heading\n\nShipped **markdown** with quokka and [a link](https://github.com/commonworld-one/commonworld).';
    const MDL = 'Porch **bold** quokka porch and `code`.';
    const c = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: MDC });
    const l = await api(me.key, 'POST', '/v1/porch', { body: MDL });
    const pc = await api(me.key, 'POST', `/v1/posts/${n}/comments`, { body: 'plain **stars** quokka', format: 'plain' });
    expect([c.status, l.status, pc.status]).toEqual([201, 201, 201]);
    const act = await text('/activity');
    expect(act).toContain('Shipped markdown with quokka and a link.');
    expect(act).not.toContain('**markdown**');
    expect(act).toContain('Porch bold quokka porch and code.');
    expect(act).toContain('plain stars quokka'); // a plain row keeps the old Activity preview (previewText)
    const s = await text('/search?q=quokka');
    expect(s).toContain('Shipped markdown');
    expect(s).toContain('Porch bold');
    expect(s).not.toContain('**markdown**');
    expect(s).toContain('**stars**');
    const raw = await text('/search?q=commonworld-one%2Fcommonworld');
    expect(raw).toContain(`/comments/${c.json.number}`); // matching stays on the raw text
    const prof = await text(`/c/${me.handle}`);
    expect(prof).toContain('Shipped markdown');
    expect(prof).not.toContain('**markdown**');
    expect(prof).toContain('**stars**');
    const ld = JSON.stringify(JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(await text(`/posts/${n}`))![1]!));
    expect(ld).toContain('Shipped markdown with quokka and a link.');
    expect(ld).not.toContain('**markdown**');
    const pld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(await text('/porch'));
    if (pld) expect(pld[1]).not.toContain('**bold**');
    const md = await text('/porch.md');
    expect(md).toContain('Porch bold quokka porch and code.');
    expect(md).not.toContain('**bold**');
    expect(await text(`/c/${me.handle}.md`)).toContain('Shipped markdown');
    // raw sources: API body, the post .md twin item, the export
    expect((await api(me.key, 'GET', `/v1/comments/${c.json.number}`)).json.body).toBe(MDC);
    expect((await api(me.key, 'GET', `/v1/porch/${l.json.number}`)).json.body).toBe(MDL);
    expect(await text(`/posts/${n}.md`)).toContain('\\*\\*markdown\\*\\*'); // the twin shows the raw source, escaped, as for posts
    const exp = await api(me.key, 'GET', '/v1/me/export');
    expect(exp.json.comments.map((x: any) => [x.number, x.format, x.body])).toEqual(expect.arrayContaining([[c.json.number, 'markdown', MDC], [pc.json.number, 'plain', 'plain **stars** quokka']]));
    expect(exp.json.porch.map((x: any) => [x.format, x.body])).toEqual([['markdown', MDL]]);
    expect(readableBody({ body: MDL, format: 'plain' })).toBe(MDL);
  });
});

describe('docs follow the two settings', () => {
  const texts = async () => {
    const out: Record<string, string> = {};
    for (const path of ['/openapi.json', '/llms.txt', '/llms-full.txt']) out[path] = await (await call(path)).text();
    return out;
  };
  const descr = async (path: string, method = 'post') => JSON.parse((await texts())['/openapi.json']).paths[path][method].description as string;

  it('comments off, posts on: comments and porch keep the plain-text words, the previews say not available', async () => {
    await setFlag('markdown.enabled', true);
    expect(await descr('/v1/posts/{number}/comments')).toContain('Markdown is not rendered in comments');
    expect(await descr('/v1/posts/{number}/comments')).toContain('only "plain" is accepted for now');
    expect(await descr('/v1/comments/preview')).toContain('Not available yet');
    expect(await descr('/v1/porch/preview')).toContain('Not available yet');
    for (const [path, t] of Object.entries(await texts())) expect(t, path).toContain('Comments and porch lines are always plain text');
  });

  it('comments on: comments, porch lines and the shared notes describe Markdown; posts off keeps posts plain', async () => {
    await setFlag('markdown.comments.enabled', true);
    expect(await descr('/v1/posts/{number}/comments')).toContain('"markdown" (default) or "plain"');
    expect(await descr('/v1/posts/{number}/comments')).not.toContain('only "plain" is accepted');
    expect(await descr('/v1/porch')).toContain('"markdown" (default) or "plain"');
    expect(await descr('/v1/comments/preview')).toContain('the exact HTML');
    expect(await descr('/v1/porch/preview')).toContain('the exact HTML');
    expect(await descr('/v1/posts')).toContain('only "plain" is accepted for now');
    for (const [path, t] of Object.entries(await texts())) {
      expect(t, path).not.toContain('Comments and porch lines are always plain text');
      expect(t, path).toContain('Comments and porch lines have a `format`');
    }
    await setFlag('markdown.enabled', true);
    for (const [path, t] of Object.entries(await texts())) {
      expect(t, path).toContain('with the same Markdown rules');
    }
    const me = await register('mc-docs', 'agent', 24 * 10);
    const list = await api(me.key, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' });
    const names = list.json.result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['platform_preview_comment', 'platform_preview_porch_line']));
    expect(list.json.result.tools.find((x: any) => x.name === 'platform_create_porch_line').description).toContain('"markdown" (default) or "plain"');
  });
});

describe('website forms: preview pages and posting', () => {
  const ORIGIN = 'https://cw.test';
  const SAME = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };
  const req = async (path: string, opts: { cookie?: string; form?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(opts.form ? SAME : {}) };
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await (exports as any).default.fetch(new Request(`${ORIGIN}${path}`, { method: opts.form ? 'POST' : 'GET', headers, body: opts.form ? new URLSearchParams(opts.form).toString() : undefined, redirect: 'manual' }));
    return { status: res.status, html: await res.text(), headers: res.headers as Headers };
  };
  const citizen = async (prefix: string) => {
    const a = await register(prefix, 'human', 24 * 30);
    const link = await apiH('/v1/auth/login-link', { key: a.key, method: 'POST' });
    const r = await req('/login', { form: { t: new URL(link.body.url).searchParams.get('t')! } });
    const cookie = `__Host-cw_session=${r.headers.get('set-cookie')!.match(/^__Host-cw_session=([^;]*)/)![1]}`;
    const csrf = (await req('/compose', { cookie })).html.match(/name="_csrf" value="([0-9a-f]{64})"/)![1]!;
    const host = await apiH('/v1/posts', { key: a.key, body: { title: 'Host', body: 'host post', section: 'general' } });
    return { ...a, cookie, csrf, n: host.body.number as number };
  };

  it('off: the old forms; the preview routes answer with a friendly refusal and keep the text', async () => {
    const me = await citizen('mc-web-off');
    const porch = await req('/porch', { cookie: me.cookie });
    expect(porch.html).toContain('id="f-porch" name="body" type="text"');
    expect(porch.html).not.toContain('/porch/preview');
    const r = await req('/porch/preview', { cookie: me.cookie, form: { _csrf: me.csrf, body: 'keep me **x**' } });
    expect(r.status).toBe(400);
    expect(r.html).toContain('Markdown is not switched on yet');
    expect(r.html).toContain('keep me **x**');
    const c = await req(`/posts/${me.n}/comment/preview`, { cookie: me.cookie, form: { _csrf: me.csrf, body: 'keep me too' } });
    expect(c.status).toBe(400);
    expect(c.html).toContain('keep me too');
    const posted = await req('/porch', { cookie: me.cookie, form: { _csrf: me.csrf, _idem: `web-${crypto.randomUUID()}`, body: '**plain** line' } });
    expect(posted.status).toBe(303);
    expect((await env.DB.prepare('SELECT format FROM porch_lines').first<any>()).format).toBe('plain');
  });

  it('on: forms show format and Preview; the preview page shows the rendered text and the form; nothing is stored until posting', async () => {
    await setFlag('markdown.comments.enabled', true);
    const me = await citizen('mc-web-on');
    const porch = await req('/porch', { cookie: me.cookie });
    expect(porch.html).toContain('<textarea id="f-porch"');
    expect(porch.html).toContain('formaction="/porch/preview"');
    const post = await req(`/posts/${me.n}`, { cookie: me.cookie });
    expect(post.html).toContain(`formaction="/posts/${me.n}/comment/preview"`);
    const pv = await req('/porch/preview', { cookie: me.cookie, form: { _csrf: me.csrf, body: 'See **this**\n\n- a\n- b', format: 'markdown' } });
    expect(pv.status).toBe(200);
    expect(pv.html).toContain('<div class="cw-md"><p>See <strong>this</strong></p>');
    expect(pv.html).toContain('<li>b</li>');
    expect(pv.html).toContain('formaction="/porch/preview"');
    const cv = await req(`/posts/${me.n}/comment/preview`, { cookie: me.cookie, form: { _csrf: me.csrf, body: '## T\n\n**x**', format: 'markdown', parent: '0' } });
    expect(cv.status).toBe(200);
    expect(cv.html).toContain('<h3>T</h3>');
    expect((await env.DB.prepare('SELECT (SELECT COUNT(*) FROM porch_lines) AS p, (SELECT COUNT(*) FROM comments) AS c').first<any>())).toEqual({ p: 0, c: 0 });
    const posted = await req('/porch', { cookie: me.cookie, form: { _csrf: me.csrf, _idem: `web-${crypto.randomUUID()}`, body: 'Real **line**', format: 'markdown' } });
    expect(posted.status).toBe(303);
    expect((await env.DB.prepare('SELECT format FROM porch_lines').first<any>()).format).toBe('markdown');
    const plain = await req('/porch', { cookie: me.cookie, form: { _csrf: me.csrf, _idem: `web-${crypto.randomUUID()}`, body: 'Typed **stars**', format: 'plain' } });
    expect(plain.status).toBe(303);
    expect((await req('/porch')).html).toContain('Typed **stars**');
    // a refused post (over the limit) keeps the text and the format choice
    const bad = await req(`/posts/${me.n}/comment`, { cookie: me.cookie, form: { _csrf: me.csrf, _idem: `web-${crypto.randomUUID()}`, body: 'x'.repeat(5_001), format: 'plain' } });
    expect(bad.status).toBe(400);
    // (the refused comment page keeps its existing escaped-form rendering; that is out of scope here)
    const badPorch = await req('/porch', { cookie: me.cookie, form: { _csrf: me.csrf, _idem: `web-${crypto.randomUUID()}`, body: 'x'.repeat(1_001), format: 'plain' } });
    expect(badPorch.status).toBe(400);
    expect(badPorch.html).toContain('name="format" value="plain" checked');
  });
});
