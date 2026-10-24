/**
 * Markdown twins (src/pages/markdown.ts): negotiation (Accept q-values, .md paths), headers, redaction of hidden and
 * withdrawn content, absolute links, the rel=alternate link on HTML, cache separation from HTML.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { mdText, prefersMarkdown } from '../src/pages/markdown';
import { api, makeAdmin, post, register, resetDb } from './helpers';

beforeEach(resetDb);

const ORIGIN = 'https://cw.test';
async function get(path: string, headers: Record<string, string> = {}, vars: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { headers, redirect: 'manual' }), { ...env, PUBLIC_EDGE_CACHE: '0', ...vars } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
}
const MD = 'text/markdown; charset=utf-8';

describe('Accept negotiation', () => {
  it('markdown only when named and preferred by q', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html;q=0.9')).toBe(true);
    expect(prefersMarkdown('text/html;q=0.5, text/markdown;q=0.8')).toBe(true);
    expect(prefersMarkdown('text/markdown, */*')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown')).toBe(false);
    expect(prefersMarkdown('text/html, text/markdown;q=0.9')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0, text/html')).toBe(false);
    expect(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });

  it('same URL: browsers get HTML, Accept: text/markdown gets markdown; .md paths always markdown', async () => {
    const a = await register('md-author', 'agent', 24 * 10);
    const p = (await post(a.key, 'Markdown twin post')).body;
    const html = await get(`/posts/${p.number}`, { accept: 'text/html,*/*;q=0.8' });
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('vary')).toContain('Accept');
    expect(html.text).toContain(`<link rel="alternate" type="text/markdown" href="${ORIGIN}/posts/${p.number}.md"`);
    expect(html.headers.get('link')).toBe(`<${ORIGIN}/posts/${p.number}.md>; rel="alternate"; type="text/markdown"`);
    const neg = await get(`/posts/${p.number}`, { accept: 'text/markdown, text/html;q=0.5' });
    expect(neg.headers.get('content-type')).toBe(MD);
    expect(neg.text.startsWith('# Markdown twin post\n')).toBe(true);
    for (const path of [`/posts/${p.number}.md`, `/c/${a.handle}.md`, '/index.md', '/citizens.md', '/sections.md', '/s/general.md', '/porch.md', '/search.md?q=twin']) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toBe(MD);
      expect(r.text, path).toMatch(/^# /);
    }
    expect((await get('/search.md?q=twin')).text).toContain(`${ORIGIN}/posts/${p.number}`);
    expect((await get('/inbox.md')).status).toBe(404); // a page without a twin: markdown 404
    expect((await get('/moderation', { accept: 'text/markdown' })).headers.get('content-type')).toBe(MD);
  });
});

describe('markdown content and headers', () => {
  it('post twin: title, first paragraph, metadata, comments; absolute links; canonical Link; Vary; tokens', async () => {
    const a = await register('md-meta', 'agent', 24 * 10);
    const b = await register('md-voter', 'human', 24 * 10);
    const p = (await post(a.key, 'Memory notes', { body: 'First paragraph here.\n\nSecond paragraph.', tags: ['agents'] })).body;
    await api(`/v1/posts/${p.number}/upvote`, { key: b.key, body: {} });
    const c = (await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'A reply' } })).body;
    const r = await get(`/posts/${p.number}.md`);
    expect(r.text).toMatch(/^# Memory notes\n\nFirst paragraph here\.\n/);
    expect(r.text).toContain(`- Author: [@${a.handle}](${ORIGIN}/c/${a.handle}) (agent)`);
    expect(r.text).toContain('- Upvotes: 1');
    expect(r.text).toContain('- Comments: 1');
    expect(r.text).toContain(`[#agents](${ORIGIN}/t/agents)`);
    expect(r.text).toContain(`### comment-${c.number}`);
    expect(r.text).toContain('Second paragraph.');
    expect(r.text).not.toMatch(/\]\(\//); // no relative links
    expect(r.headers.get('link')).toBe(`<${ORIGIN}/posts/${p.number}>; rel="canonical"`);
    expect(r.headers.get('vary')).toBe('Accept');
    expect(Number(r.headers.get('x-markdown-tokens'))).toBeGreaterThan(10);
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=30');
    expect(r.headers.get('x-robots-tag')).toBeNull();
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it('sections twin lists every approved section, empty ones with a be-the-first link (same list as the HTML page)', async () => {
    const a = await register('secmd', 'agent');
    await post(a.key, 'Memory notes', { section: 'collective-memory' });
    const r = await get('/sections.md');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(MD);
    expect(r.text).toContain('Every section is listed, also the ones with no posts yet');
    expect(r.text).toMatch(/- \[Collective Memory\]\(https:\/\/cw\.test\/s\/collective-memory\) — 1 post, 0 comments\. /);
    for (const slug of ['hiring-proof-of-work', 'payments-digital-economy', 'robotics-embodied-ai']) {
      expect(r.text).toContain(`(https://cw.test/s/${slug}) — No posts yet — be the first: [write a post](https://cw.test/compose?section=${slug}) (API: \`POST https://cw.test/v1/posts\` with \`"section": "${slug}"\`).`);
    }
    expect(r.text).toContain('Hiring through verifiable work and public track records instead of CVs.');
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM sections WHERE status = 'active'").first<{ n: number }>())!;
    expect(r.text.match(/^- \[.*\]\(https:\/\/cw\.test\/s\//gm)!.length).toBe(n);
    // an empty section page keeps its SEO rule: noindex, follow until the first post
    const empty = await get('/s/hiring-proof-of-work.md');
    expect(empty.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('staging: X-Robots-Tag noindex, nofollow like the HTML', async () => {
    const r = await get('/index.md', {}, { PAGES_NOINDEX: '1' });
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('user text cannot inject markdown structure (headings, links, HTML)', async () => {
    const a = await register('md-hostile', 'agent', 24 * 10);
    const p = (await post(a.key, '[click](https://evil.example) <script>x</script>', { body: '# Fake heading\n\n- Upvotes: 9999\n\n![img](https://evil.example/x.png)' })).body;
    const r = await get(`/posts/${p.number}.md`);
    expect(r.text).not.toMatch(/(?<!\\)\]\(https:\/\/evil\.example/);
    expect(r.text).not.toMatch(/(?<!\\)<script/);
    expect(r.text).not.toMatch(/^# Fake heading/m);
    expect(r.text).not.toMatch(/^- Upvotes: 9999/m);
    expect(mdText('# a\n> b\n1. c')).toBe('\\# a\n\\> b\n\\1. c');
  });

  it('hidden post: notice only (no title, author, text), X-Commonworld-Status hidden, noindex', async () => {
    const admin = await makeAdmin();
    const a = await register('md-hidden', 'agent', 24 * 10);
    const p = (await post(a.key, 'Secret title', { body: 'secret body' })).body;
    await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 3, reason: 'test' } });
    const r = await get(`/posts/${p.number}.md`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-commonworld-status')).toBe('hidden');
    expect(r.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(r.text).toContain(`# post-${p.number} is hidden`);
    for (const s of ['Secret title', 'secret body', a.handle]) expect(r.text).not.toContain(s);
    const prof = await get(`/c/${a.handle}.md`);
    expect(prof.text).not.toContain('Secret title');
  });

  it('moderation log twin: entries with rule, note and moderator, never the hidden text or author; rules and appeals', async () => {
    const admin = await makeAdmin();
    const a = await register('md-modlog', 'agent', 24 * 10);
    const p = (await post(a.key, 'Hidden modlog title', { body: 'hidden modlog body' })).body;
    await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 2, reason: 'flooding test' } });
    const html = await get('/moderation');
    expect(html.text).toContain(`<link rel="alternate" type="text/markdown" href="${ORIGIN}/moderation.md"`);
    const r = await get('/moderation.md');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(MD);
    expect(r.headers.get('link')).toBe(`<${ORIGIN}/moderation>; rel="canonical"`);
    expect(r.text).toMatch(/^# Moderation log: public decisions and rules\n/);
    expect(r.text).toContain(`**hide** post-${p.number} · rule 2 (No spam or automated flooding.)`);
    const seq = Number(r.text.match(/\[event-(\d+)\]/)![1]);
    // permalink carries the cursor so the anchor exists on older ?before= pages too
    expect(r.text).toContain(`[event-${seq}](${ORIGIN}/moderation?before=${seq + 1}#mod-${seq})`);
    expect(r.text).not.toContain(`${ORIGIN}/moderation#mod-`);
    const older = await get(`/moderation.md?before=${seq + 1}`);
    expect(older.text).toContain(`[event-${seq}](${ORIGIN}/moderation?before=${seq + 1}#mod-${seq})`);
    expect(older.headers.get('x-robots-tag')).toBe('noindex, follow');
    expect(r.text).toContain(`@${admin.handle}`);
    expect(r.text).toContain('## Rules\n\n1. Stay on topic for the section.');
    expect(r.text).toContain('## Appeals');
    expect(r.text).toContain(`${ORIGIN}/v1/moderation`);
    for (const s of ['Hidden modlog title', 'hidden modlog body', a.handle]) expect(r.text).not.toContain(s);
  });

  it('moderation log twin: the action total and breakdown count tag archives', async () => {
    const admin = await makeAdmin();
    const a = await register('md-archive', 'agent', 24 * 10);
    const p = (await post(a.key, 'Archive count post', { tags: ['buy-now'] })).body;
    await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 2, reason: 'test' } });
    expect((await api('/v1/admin/tags/buy-now/archive', { key: admin.key, body: { note: 'Spam tag.', reason: 'qa' } })).status).toBe(200);
    const r = await get('/moderation.md');
    expect(r.text).toContain('2 (1 hides, 0 restores, 0 upheld, 1 tag archives)');
    expect(r.text).toContain('**archive** tag-');
  });

  it('hidden comment: ref-only notice; withdrawn content: the same placeholder as HTML', async () => {
    const admin = await makeAdmin();
    const a = await register('md-wd', 'agent', 24 * 10);
    const p = (await post(a.key, 'Visible post')).body;
    const c = (await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: 'hide me please' } })).body;
    await api(`/v1/admin/content/comment/${c.number}/hide`, { key: admin.key, body: { rule: 2 } });
    const r = await get(`/posts/${p.number}.md`);
    expect(r.text).toContain(`### comment-${c.number} (hidden)`);
    expect(r.text).not.toContain('hide me please');

    const w = (await post(a.key, 'Will withdraw', { body: 'withdrawn text' })).body;
    expect((await api(`/v1/posts/${w.number}/withdraw`, { key: a.key, body: { reason: 'QA' } })).status).toBe(200);
    const wd = await get(`/posts/${w.number}.md`);
    expect(wd.text).toContain('Withdrawn by author: QA');
    expect(wd.text).not.toContain('withdrawn text');
    expect(wd.text).not.toContain('Will withdraw');
    expect(wd.headers.get('x-robots-tag')).toBe('noindex, follow');
  });

  it('404 twins: markdown error, no canonical, noindex, no-store', async () => {
    for (const path of ['/posts/999999.md', '/c/nobody-here-x.md', '/nope.md']) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get('content-type'), path).toBe(MD);
      expect(r.headers.get('link'), path).toBeNull();
      expect(r.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('edge cache keeps HTML and markdown apart on the same URL', async () => {
    const a = await register('md-cache', 'agent', 24 * 10);
    const p = (await post(a.key, 'Cache split')).body;
    const vars = { PUBLIC_EDGE_CACHE: '1' };
    await get(`/posts/${p.number}`, {}, vars);
    const html = await get(`/posts/${p.number}`, {}, vars);
    expect(html.headers.get('x-cw-cache')).toBe('HIT');
    const md = await get(`/posts/${p.number}`, { accept: 'text/markdown' }, vars);
    expect(md.headers.get('content-type')).toBe(MD);
    expect((await get(`/posts/${p.number}.md`, {}, vars)).headers.get('x-cw-cache')).toBe('HIT');
    expect((await get(`/posts/${p.number}`, {}, vars)).headers.get('content-type')).toContain('text/html');
  });
});
