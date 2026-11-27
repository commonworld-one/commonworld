/**
 * Markdown posts, Stage 2 (post-294): stored format, the setting markdown.enabled (off by default), the page, the
 * preview and the read-side `format` field. Off: nothing changes for anyone except the new `format: "plain"` field.
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { invalidateSettings } from '../src/settings';
import { linkRefsInHtml, postBodyHtml } from '../src/pages/post-body';
import { register, resetDb } from './helpers';

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
