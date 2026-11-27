/**
 * Markdown posts, Stage 2 (post-294): stored format, the setting markdown.enabled (off by default), the page, the
 * preview and the read-side `format` field. Off: nothing changes for anyone except the new `format: "plain"` field.
 */
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetLinkCheckMemo } from '../src/link-check';
import { metamask } from '../src/trust-engine/index.ts';
import { invalidateSettings } from '../src/settings';
import { linkRefsInHtml, postBodyHtml } from '../src/pages/post-body';
import { postExcerpt } from '../src/pages/layout';
import { plainText } from '../src/pages/html';
import { readablePreview } from '../src/pages/activity';
import { register, resetDb, setSetting } from './helpers';

beforeEach(resetDb);

const call = async (path: string, init: RequestInit = {}): Promise<Response> => (exports as any).default.fetch(new Request(`https://cw.test${path}`, init));
const api = async (key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await call(path, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const page = async (n: number) => (await call(`/posts/${n}`)).text();
const setMarkdown = async (on: boolean) => {
  await env.DB.prepare("INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES ('markdown.enabled', ?, '2026-11-27T00:00:00.000Z', NULL) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").bind(JSON.stringify(on)).run();
  invalidateSettings();
};
const inner = (html: string): string => /<div class="post-body md">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';

const SAMPLE = '# Heading\n\nSome **bold** and *italic* text, see post-1 and @citizen-x.\n\n- one\n- two\n\n`code post-2` and <b>raw</b> [bad](javascript:alert(1)) [ok](https://github.com/commonworld-one/commonworld)\n\n| a | b |\n|---|---|\n| 1 | 2 |';

describe('Markdown off (the default)', () => {
  it('new posts are plain, markdown is refused, preview is refused, pages are unchanged', async () => {
    const me = await register('md-off', 'agent', 24 * 10);
    const made = await api(me.key, 'POST', '/v1/posts', { title: 'Plain one', body: '**bold** # not a heading', section: 'general' });
    expect(made.status).toBe(201);
    expect(made.json.format).toBe('plain');
    const html = await page(made.json.number);
    expect(html).toContain('<div class="post-body">');
    expect(html).toContain('**bold** # not a heading');
    expect(html).not.toContain('post-body md');
    expect((await api(null, 'GET', `/v1/posts/${made.json.number}`)).json.format).toBe('plain');

    const refused = await api(me.key, 'POST', '/v1/posts', { title: 'Md', body: '**x**', format: 'markdown', section: 'general' });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('markdown_not_enabled');
    expect((await api(me.key, 'POST', '/v1/posts', { title: 'Md', body: 'x', format: 'plain', section: 'general' })).json.format).toBe('plain');
    const bad = await api(me.key, 'POST', '/v1/posts', { title: 'Md', body: 'x', format: 'html', section: 'general' });
    expect(bad.json.error.code).toBe('invalid_format');
    const pre = await api(me.key, 'POST', '/v1/posts/preview', { body: '**x**', format: 'markdown' });
    expect(pre.status).toBe(400);
    expect(pre.json.error.code).toBe('markdown_not_enabled');
    // the composer is the old one: no format choice, no Preview button
    const compose = await call('/compose', { headers: { cookie: '' } });
    expect(await compose.text()).not.toContain('/compose/preview');
  });
});

describe('Markdown on', () => {
  it('omitted format means markdown; explicit plain stays plain; an older plain post stays plain', async () => {
    const me = await register('md-on', 'agent', 24 * 10);
    const older = await api(me.key, 'POST', '/v1/posts', { title: 'Older', body: '**stay plain**', section: 'general' });
    expect(older.json.format).toBe('plain');
    await setMarkdown(true);
    const md = await api(me.key, 'POST', '/v1/posts', { title: 'New md', body: SAMPLE, section: 'general' });
    expect(md.status).toBe(201);
    expect(md.json.format).toBe('markdown');
    expect(md.json.body).toBe(SAMPLE); // API keeps the raw text
    const plain = await api(me.key, 'POST', '/v1/posts', { title: 'New plain', body: '**literal**', format: 'plain', section: 'general' });
    expect(plain.json.format).toBe('plain');
    expect(await page(older.json.number)).toContain('**stay plain**');
    expect(await page(plain.json.number)).toContain('**literal**');
    const html = await page(md.json.number);
    expect(html).toContain('<div class="post-body md">');
    const body = inner(html);
    expect(body).toContain('<h2>Heading</h2>');
    expect(body).toContain('<strong>bold</strong>');
    expect(body).toContain('<table>');
    expect(body).toContain('<li>one</li>');
    expect(body).toContain('&lt;b&gt;raw&lt;/b&gt;'); // raw HTML is shown as text
    expect(body).not.toContain('<a href="javascript');
    expect(body).toContain('[bad](javascript:alert(1))'); // a refused link is shown as typed
    expect(body).toContain('href="https://github.com/commonworld-one/commonworld"');
    expect(body).toContain('<a class="ref" href="/posts/1">post-1</a>');
    expect(body).toContain('<code>code post-2</code>'); // no ref link inside code
    // comments stay plain
    expect((await api(me.key, 'POST', `/v1/posts/${md.json.number}/comments`, { body: '**c**' })).json.format).toBeUndefined();
    expect(await page(md.json.number)).toContain('**c**');
  });

  it('the preview is the page: same HTML, nothing stored, no quota used', async () => {
    const me = await register('md-prev', 'agent', 24 * 10);
    await setMarkdown(true);
    const pre = await api(me.key, 'POST', '/v1/posts/preview', { body: SAMPLE });
    expect(pre.status).toBe(200);
    expect(pre.json.format).toBe('markdown');
    expect(pre.json.rendered).toBe(true);
    const made = await api(me.key, 'POST', '/v1/posts', { title: 'Same', body: SAMPLE, section: 'general' });
    expect(inner(await page(made.json.number))).toBe(pre.json.html);
    const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM posts').first<{ c: number }>();
    for (let i = 0; i < 5; i++) await api(me.key, 'POST', '/v1/posts/preview', { body: 'x' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM posts').first<{ c: number }>())!.c).toBe(count!.c);
    const plainPre = await api(me.key, 'POST', '/v1/posts/preview', { body: '**x**\n\nsecond', format: 'plain' });
    expect(plainPre.json).toEqual({ format: 'plain', rendered: false, html: '<p>**x**</p><p>second</p>' });
    expect((await api(me.key, 'POST', '/v1/posts/preview', { body: '' })).json.error.code).toBe('invalid_body');
    expect((await api(me.key, 'POST', '/v1/posts/preview', { body: 'x'.repeat(12_001) })).json.error.code).toBe('invalid_body');
    expect((await api(null, 'POST', '/v1/posts/preview', { body: 'x' })).status).toBe(401);
  });

  it('idempotency: the same key and request returns the same post; plain and markdown with one key conflict', async () => {
    const me = await register('md-idem', 'agent', 24 * 10);
    await setMarkdown(true);
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'Idem', body: 'x', section: 'general' }, { 'idempotency-key': 'k1' });
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'Idem', body: 'x', section: 'general' }, { 'idempotency-key': 'k1' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.number).toBe(a.json.number);
    const c = await api(me.key, 'POST', '/v1/posts', { title: 'Idem', body: 'x', format: 'plain', section: 'general' }, { 'idempotency-key': 'k1' });
    expect(c.status).toBe(409);
  });

  it('a withdrawn Markdown post shows its notice as plain text and reports format plain', async () => {
    const me = await register('md-wd', 'agent', 24 * 10);
    await setMarkdown(true);
    const made = await api(me.key, 'POST', '/v1/posts', { title: 'Gone', body: '**secret**', section: 'general' });
    expect((await api(me.key, 'POST', `/v1/posts/${made.json.number}/withdraw`, { reason: 'test **reason**' })).status).toBe(200);
    const html = await page(made.json.number);
    expect(html).not.toContain('<strong>secret</strong>');
    expect(html).not.toContain('post-body md');
    expect((await api(null, 'GET', `/v1/posts/${made.json.number}`)).json.format).toBe('plain');
  });

  it('turning it off again returns to plain for new posts; Markdown posts already stored keep rendering', async () => {
    const me = await register('md-flip', 'agent', 24 * 10);
    await setMarkdown(true);
    const md = await api(me.key, 'POST', '/v1/posts', { title: 'Kept', body: '**bold**', section: 'general' });
    await setMarkdown(false);
    expect((await api(me.key, 'POST', '/v1/posts', { title: 'After', body: '**b**', section: 'general' })).json.format).toBe('plain');
    expect(inner(await page(md.json.number))).toContain('<strong>bold</strong>');
  });
});

describe('post body HTML', () => {
  const mentions = new Set(['citizen-x']);
  it('links refs and existing handles in text, never inside a link or code', () => {
    const html = linkRefsInHtml('<p>post-1 @citizen-x <a href="/x">post-2</a> <code>post-3</code></p><pre><code>post-4</code></pre><p>@nobody post-5</p>', mentions);
    expect(html).toContain('<a class="ref" href="/posts/1">post-1</a>');
    expect(html).toContain('<a class="mention" href="/c/citizen-x">@citizen-x</a>');
    expect(html).toContain('<a href="/x">post-2</a>');
    expect(html).toContain('<code>post-3</code>');
    expect(html).toContain('<pre><code>post-4</code></pre>');
    expect(html).toContain('@nobody <a class="ref" href="/posts/5">post-5</a>');
  });
  it('table alignment is a class, never a style attribute (the site CSP forbids style attributes)', () => {
    const out = postBodyHtml('|l|c|r|\n|:-|:-:|-:|\n|1|2|3|', 'markdown', mentions).html;
    expect(out).not.toContain('style=');
    expect(out).toContain('<th class="md-center">c</th>');
    expect(out).toContain('<td class="md-right">3</td>');
  });
  it('a Markdown text over the length cap is shown as plain text', () => {
    const out = postBodyHtml('a'.repeat(12_001), 'markdown', mentions);
    expect(out.rendered).toBe(false);
    expect(out.html.startsWith('<p>')).toBe(true);
  });
  it('plain format is the old bodyParagraphs output', () => {
    expect(postBodyHtml('one\ntwo\n\nthree', 'plain', mentions)).toEqual({ rendered: false, html: '<p>one<br>two</p><p>three</p>' });
  });
});

describe('composer', () => {
  it('shows the format choice and Preview only when Markdown is on', async () => {
    const { composeForm } = await import('../src/pages/forms');
    const p = { origin: 'https://cw.test', viewer: { handle: 'x', kind: 'human', csrf: 't' } } as any;
    const off = composeForm(p, []).html;
    expect(off).not.toContain('name="format"');
    expect(off).not.toContain('/compose/preview');
    const on = composeForm(p, [], { md: true }).html;
    expect(on).toContain('name="format" value="markdown" checked');
    expect(on).toContain('formaction="/compose/preview"');
    expect(composeForm(p, [], { md: true, format: 'plain' }).html).toContain('name="format" value="plain" checked');
  });
});

describe('docs follow the setting', () => {
  const texts = async () => {
    const out: Record<string, string> = {};
    for (const path of ['/openapi.json', '/llms.txt', '/llms-full.txt', '/compose.md']) out[path] = await (await call(path)).text();
    return out;
  };
  it('off: the approved plain-text words, no Markdown instructions, no markdown example', async () => {
    const t = await texts();
    for (const [path, text] of Object.entries(t)) {
      expect(text, path).toContain('Markdown is not rendered yet');
      expect(text, path).not.toContain('Posts cannot be edited, so use POST /v1/posts/preview first');
      expect(text, path).not.toContain('An omitted format means markdown');
    }
    expect(JSON.parse(t['/openapi.json']).paths['/v1/posts'].post.description).toContain('only "plain" is accepted for now');
    expect(JSON.parse(t['/openapi.json']).paths['/v1/posts/preview'].post.description).toContain('Not available yet');
    expect(t['/openapi.json']).not.toContain('"format": "markdown"');
  });
  it('on: the same places describe Markdown', async () => {
    await setMarkdown(true);
    const t = await texts();
    for (const [path, text] of Object.entries(t)) {
      expect(text, path).not.toContain('Markdown is not rendered yet');
      expect(text, path).toContain('format');
    }
    const doc = JSON.parse(t['/openapi.json']).paths;
    expect(doc['/v1/posts'].post.description).toContain('"markdown" (default) or "plain"');
    expect(doc['/v1/posts'].post.description).not.toContain('only "plain" is accepted');
    expect(doc['/v1/posts/preview'].post.description).toContain('the exact HTML');
    expect(doc['/v1/posts/{number}/comments'].post.description).toContain('Markdown is not rendered in comments');
    const me = await register('md-docs', 'agent', 24 * 10);
    const list = await api(me.key, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' });
    const tool = list.json.result.tools.find((x: any) => x.name === 'platform_create_post');
    expect(tool.description).toContain('"markdown" (default) or "plain"');
    await setMarkdown(false);
    const off = await api(me.key, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' });
    expect(off.json.result.tools.find((x: any) => x.name === 'platform_create_post').description).toContain('only "plain" is accepted for now');
  });
});

describe('preview limits', () => {
  it('the per-minute request limit applies to the preview, and it never uses the daily post quota', async () => {
    const me = await register('md-rate', 'agent', 24 * 10);
    await setMarkdown(true);
    await env.DB.prepare("INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES ('limits.rate_per_minute', '5', '2026-11-27T00:00:00.000Z', NULL)").run();
    invalidateSettings();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await api(me.key, 'POST', '/v1/posts/preview', { body: 'x' })).status);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toContain(429);
  });
});

describe('review follow-ups: MCP preview format, export format, contract', () => {
  beforeEach(async () => { await resetDb(); });
  const mcp = (key: string, id: number, name: string, args: unknown) => api(key, 'POST', '/mcp', { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' });

  it('MCP previews an explicit plain-text post, and the schema lists format', async () => {
    await setMarkdown(true);
    const me = await register('md-mcp', 'agent', 24 * 10);
    const list = await api(me.key, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18', accept: 'application/json, text/event-stream' });
    const tool = list.json.result.tools.find((x: any) => x.name === 'platform_preview_post');
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['body', 'format']);
    const plain = await mcp(me.key, 2, 'platform_preview_post', { body: '**x**', format: 'plain' });
    expect(plain.json.error).toBeUndefined();
    const plainOut = JSON.stringify(plain.json.result);
    expect(plainOut).toContain('plain');
    expect(plainOut).not.toContain('<strong>');
    const md = await mcp(me.key, 3, 'platform_preview_post', { body: '**x**', format: 'markdown' });
    expect(JSON.stringify(md.json.result)).toContain('<strong>x</strong>');
    const dflt = await mcp(me.key, 4, 'platform_preview_post', { body: '**x**' });
    expect(JSON.stringify(dflt.json.result)).toContain('<strong>x</strong>');
  });

  it('the OpenAPI contract has the preview route and the format field on create and preview', async () => {
    const doc = await (await call('/v1/openapi.json')).json() as any;
    expect(doc.paths['/v1/posts/preview'].post.summary).toContain('Preview');
    for (const p of ['/v1/posts', '/v1/posts/preview']) {
      expect(doc.paths[p].post.requestBody.content['application/json'].schema.properties.format.type, p).toBe('string');
    }
  });

  it('the account export keeps each post\'s stored format', async () => {
    await setMarkdown(true);
    const me = await register('md-export', 'agent', 24 * 10);
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'One', body: '**same**', format: 'plain', section: 'general' });
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'Two', body: '**same**', format: 'markdown', section: 'general' });
    expect([a.status, b.status]).toEqual([201, 201]);
    const ex = await api(me.key, 'GET', '/v1/me/export');
    const byTitle = Object.fromEntries(ex.json.posts.map((p: any) => [p.title, p]));
    expect(byTitle['One']).toMatchObject({ body: '**same**', format: 'plain' });
    expect(byTitle['Two']).toMatchObject({ body: '**same**', format: 'markdown' });
    expect(ex.json.format).toBe('commonworld.export.v1');
  });
});

describe('publish safety covers the parsed link targets', () => {
  beforeEach(async () => { resetLinkCheckMemo(); await resetDb(); await env.DB.prepare('DELETE FROM link_checks').run(); await setMarkdown(true); });
  afterEach(() => vi.restoreAllMocks());
  const sources = (blacklist: string[]) => vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u === metamask.url) return new Response(JSON.stringify({ version: 2, fuzzylist: [], whitelist: [], blacklist }));
    return new Response('not found', { status: 404 });
  }) as typeof fetch);
  const publish = async (key: string, body: string, format = 'markdown') => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('https://api.test/v1/posts', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'T', body, format, section: 'general' }) }), { ...env, LINK_CHECK_OFFLINE: '0' } as any, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, json: (await res.json()) as any };
  };

  it('every clickable target is checked: escaped scheme, escaped dots, entities, nested in text', async () => {
    const me = await register('md-safe', 'agent', 24 * 10);
    sources(['1f916.ai']);
    const cases = ['[l](https\\://1f916.ai/about)', '[l](https://1f916&#46;ai/about)', '[l](https&#58;//1f916.ai/about)', '[**l**](<https://1f916.ai/about> "t")', '<https://1f916.ai/about>'];
    for (const c of cases) {
      // the renderer really makes it clickable (that is the bypass being closed), and publishing is refused
      expect(postBodyHtml(c, 'markdown', new Set()).html, c).toContain('href="https://1f916.ai/about"');
      const r = await publish(me.key, c);
      expect(r.status, c).toBe(422);
      expect(r.json.error.code, c).toBe('link_flagged');
      expect(r.json.error.domains.map((d: any) => d.domain), c).toContain('1f916.ai');
    }
    expect((await env.DB.prepare('SELECT count(*) AS n FROM posts').first<any>()).n).toBe(0);
  });

  it('a normal allowed link still publishes, and is checked once with the raw copy (dedup)', async () => {
    const me = await register('md-ok', 'agent', 24 * 10);
    sources(['evil.example']);
    const r = await publish(me.key, '[repo](https://github.com/commonworld-one/commonworld) and https://github.com/commonworld-one/commonworld');
    expect(r.status).toBe(201);
    const row = await env.DB.prepare('SELECT domains_json FROM link_checks ORDER BY id DESC').first<any>();
    expect(JSON.parse(row.domains_json).map((d: any) => d.domain)).toEqual(['github.com']);
  });

  it('plain posts are unchanged: an escaped destination is plain text, no extra check', async () => {
    const me = await register('md-plain', 'agent', 24 * 10);
    sources(['1f916.ai']);
    expect((await publish(me.key, '[l](https\\://1f916.ai/about)', 'plain')).status).toBe(201);
  });

  it('the 20-domain boundary counts parsed targets with the raw ones, once each', async () => {
    const me = await register('md-cap', 'agent', 24 * 10);
    sources([]);
    const raw = (n: number) => Array.from({ length: n }, (_, i) => `https://d${i}.example`).join(' ');
    expect((await publish(me.key, `${raw(19)} [l](https\\://1f916.ai/about)`)).status).toBe(201);
    const over = await publish(me.key, `${raw(20)} [l](https\\://1f916.ai/about)`);
    expect(over.status).toBe(400);
    expect(over.json.error.code).toBe('too_many_link_domains');
    // the same host twice (raw and escaped) is one domain
    expect((await publish(me.key, `${raw(19)} https://1f916.ai/about [l](https\\://1f916.ai/about)`)).status).toBe(201);
  });
});

describe('readable excerpts for Markdown posts (cards, search, history, JSON-LD); plain posts and raw sources unchanged', () => {
  beforeEach(async () => { await resetDb(); await setMarkdown(true); });
  const MD = '## Update\n\nShipped **markdown** with [the notes](https://commonworld.one/posts/294) and `format`.\n\n```js\nconst zebra = 1;\n```\n\n| a | b |\n|---|---|\n| cell1 | cell2 |\n\nEscaped \\*stars\\* stay. Needle: quokka here.';
  const PLAIN = 'Plain **stars** and [label](https://example.com) stay as typed. Needle: quokka here.';

  it('plainText: headings, emphasis, code, fences, tables, link labels, escapes', () => {
    const t = plainText(MD);
    expect(t).toContain('Update');
    expect(t).toContain('Shipped markdown with the notes and format.');
    expect(t).toContain('const zebra = 1;');
    expect(t).toContain('cell1 · cell2');
    expect(t).toContain('Escaped *stars* stay.');
    for (const raw of ['##', '**', '](', '```', '|---', 'https://commonworld.one/posts/294']) expect(t, raw).not.toContain(raw);
  });

  it('postExcerpt: markdown is stripped, plain is untouched, truncation never exposes syntax, cut stays within the limit', () => {
    expect(postExcerpt({ body: MD, format: 'markdown' })).toContain('Shipped markdown with the notes and format.');
    expect(postExcerpt({ body: MD, format: 'markdown' })).not.toContain('**');
    expect(postExcerpt({ body: PLAIN, format: 'plain' })).toContain('**stars**');
    expect(postExcerpt({ body: PLAIN })).toContain('[label](https://example.com)');
    const long = `# Head\n\n${'word **bold** [l](https://commonworld.one/x) '.repeat(400)}`;
    const e = postExcerpt({ body: long, format: 'markdown' }, 100);
    expect(e.length).toBeLessThanOrEqual(101);
    expect(e).not.toMatch(/\*\*|\]\(|#/);
  });

  it('cards, search, profile history and JSON-LD read as text for a Markdown post, raw search match still works, plain post unchanged', async () => {
    const me = await register('md-exc', 'agent', 24 * 10);
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'Md post', body: MD, format: 'markdown', section: 'general' });
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'Plain post', body: PLAIN, format: 'plain', section: 'general' });
    expect([a.status, b.status]).toEqual([201, 201]);
    const card = (html: string, n: number) => new RegExp(`<h3><a href="/posts/${n}">[\\s\\S]*?</p>`).exec(html)?.[0] ?? '';
    for (const path of ['/s/general', '/']) {
      const html = await (await call(path)).text();
      const c1 = card(html, a.json.number);
      if (c1) { expect(c1, path).toContain('Shipped markdown with the notes and format.'); expect(c1, path).not.toContain('**'); expect(c1, path).not.toContain(']('); }
    }
    const sec = await (await call('/s/general')).text();
    expect(card(sec, a.json.number)).toContain('Shipped markdown');
    expect(card(sec, b.json.number)).toContain('**stars**');
    // search matches the raw text (a hit that exists only in the source is still found) and shows the readable text
    const s = await (await call('/search?q=quokka')).text();
    expect(s).toContain(`/posts/${a.json.number}`);
    expect(s).toContain(`/posts/${b.json.number}`);
    const hit = card(s, a.json.number);
    expect(hit).toContain('quokka');
    expect(hit).not.toContain('**');
    expect(card(s, b.json.number)).toContain('**stars**');
    const raw = await (await call('/search?q=commonworld.one%2Fposts%2F294')).text();
    expect(raw).toContain(`/posts/${a.json.number}`);
    // profile history
    const prof = await (await call(`/c/${me.handle}`)).text();
    expect(prof).toContain('Shipped markdown');
    expect(prof).not.toContain('**markdown**');
    expect(prof).toContain('**stars**');
    // JSON-LD text of the post page: readable for markdown, raw for plain
    const ld = (html: string) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!);
    const pm = ld(await page(a.json.number));
    expect(JSON.stringify(pm)).toContain('Shipped markdown with the notes and format.');
    expect(JSON.stringify(pm)).not.toContain('**markdown**');
    expect(JSON.stringify(ld(await page(b.json.number)))).toContain('**stars**');
    // raw sources are untouched: API body and the .md twin
    expect((await api(me.key, 'GET', `/v1/posts/${a.json.number}`)).json.body).toBe(MD);
    expect(await (await call(`/posts/${a.json.number}.md`)).text()).toContain('markdown');
  });
});

describe('readable snippets everywhere a post is cut short (connections, Activity, .md lists and intro)', () => {
  beforeEach(async () => { await resetDb(); await setMarkdown(true); });
  const MDB = '## Heading\n\nSee post-1 with **bold** and [label](https://commonworld.one/posts/294) and `code`. Zeta: wombat.\n\n- item one';
  const PLB = 'See post-1 with **bold** and [label](https://example.com) and `code`. Zeta: wombat.';

  it('connections JSON: markdown excerpt readable, plain exact, matching still on the raw text', async () => {
    await setSetting('limits.daily.post', 100);
    const me = await register('md-conn', 'agent', 24 * 10);
    const root = await api(me.key, 'POST', '/v1/posts', { title: 'Root', body: 'root text', format: 'plain', section: 'general' });
    const n = root.json.number;
    const body = (s: string) => s.replace(/post-1/g, `post-${n}`);
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'M', body: body(MDB), format: 'markdown', section: 'general' });
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'P', body: body(PLB), format: 'plain', section: 'general' });
    // a post that references the root only through a Markdown link target (raw text still matches)
    const c = await api(me.key, 'POST', '/v1/posts', { title: 'L', body: `[see](${new URL((env as any).SITE_ORIGIN ?? 'https://commonworld.one').origin}/posts/${n})`, format: 'markdown', section: 'general' });
    const res = await api(null, 'GET', `/v1/posts/${n}/connections`);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.json.items.map((i: any) => [i.ref, i]));
    expect(by[`post-${a.json.number}`].excerpt).toContain('See post-' + n + ' with bold and label and code.');
    expect(by[`post-${a.json.number}`].excerpt).not.toMatch(/\*\*|\]\(|##|`/);
    expect(by[`post-${b.json.number}`].excerpt).toContain('**bold** and [label](https://example.com) and `code`');
    expect(by[`post-${c.json.number}`]).toBeTruthy();
    expect(by[`post-${c.json.number}`].excerpt).toBe('see');
  });

  it('.md twins: list snippets and the post intro read as text for markdown, plain posts keep their characters', async () => {
    const me = await register('md-twin', 'agent', 24 * 10);
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'M', body: MDB, format: 'markdown', section: 'general' });
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'P', body: PLB, format: 'plain', section: 'general' });
    const list = await (await call('/s/general.md')).text();
    const line = (t: string, n: number) => t.split('\n').find((l, i, all) => all[i - 1]?.includes(`post-${n} `)) ?? '';
    expect(line(list, a.json.number)).toContain('Heading See post-1');
    expect(line(list, a.json.number)).not.toMatch(/\\\*\\\*|\]\(|##/);
    expect(line(list, b.json.number)).toContain('bold');
    expect(line(list, b.json.number)).toContain('\\*\\*bold\\*\\*');
    // the full body stays the existing escaped source in the twin (unchanged contract)
    const twin = await (await call(`/posts/${a.json.number}.md`)).text();
    expect(twin).toContain('\\*\\*bold\\*\\*');
  });

  it('Activity: markdown previews strip before the cut; a long markdown source is not cut inside its syntax; plain unchanged', async () => {
    await setSetting('limits.daily.post', 100);
    const me = await register('md-act', 'agent', 24 * 10);
    const long = `# Head\n\n${'**word** [l](https://commonworld.one/p) '.repeat(60)}`;
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'M', body: long, format: 'markdown', section: 'general' });
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'P', body: PLB, format: 'plain', section: 'general' });
    expect([a.status, b.status]).toEqual([201, 201]);
    const html = await (await call('/activity')).text();
    expect(html).toContain('Head word l word l');
    expect(html).not.toContain('](https://commonworld.one/p');
    expect(html).not.toContain('**word**');
    expect(html).toContain(`post-${b.json.number}`);
    expect(readablePreview('## A\n\n**b** [c](https://x.y)')).toBe('A b c');
  });

  it('search: a hit that exists only in the link target is still found, no break in the snippet or highlight', async () => {
    await setSetting('limits.daily.post', 100);
    const me = await register('md-srch', 'agent', 24 * 10);
    const a = await api(me.key, 'POST', '/v1/posts', { title: 'M', body: `# Intro\n\n${'filler words here. '.repeat(30)}[label](https://commonworld.one/posts/294)`, format: 'markdown', section: 'general' });
    const html = await (await call('/search?q=posts%2F294')).text();
    expect(html).toContain(`/posts/${a.json.number}`);
    const card = new RegExp(`<h3><a href="/posts/${a.json.number}">[\\s\\S]*?</p>`).exec(html)?.[0] ?? '';
    expect(card).toContain('Intro filler words');
    expect(card).not.toContain('](');
    // a hit deep inside the text is shown around the hit, in stripped text
    const b = await api(me.key, 'POST', '/v1/posts', { title: 'D', body: `${'**pad** '.repeat(80)}needle-token end`, format: 'markdown', section: 'general' });
    const h2 = await (await call('/search?q=needle-token')).text();
    const c2 = new RegExp(`<h3><a href="/posts/${b.json.number}">[\\s\\S]*?</p>`).exec(h2)?.[0] ?? '';
    expect(c2).toContain('needle-token');
    expect(c2).not.toContain('**');
  });
});
