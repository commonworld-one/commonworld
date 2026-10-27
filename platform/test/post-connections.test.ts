import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { connectionsData, referencesPost } from '../src/post-connections';
import { pageCacheUrl } from '../src/pages/router';
import { api, makeAdmin, register, resetDb } from './helpers';

beforeEach(resetDb);

async function addPost(author: string, body: string, title = 'Source post') {
  const r = await env.DB.prepare(`INSERT INTO posts (id, author_id, section_slug, title, body, status, created_at)
    VALUES (?, ?, 'general', ?, ?, 'visible', '2026-10-25T00:00:00.000Z')`).bind(crypto.randomUUID(), author, title, body).run();
  return Number(r.meta.last_row_id);
}
async function addComment(author: string, post: number, body: string, parent: number | null = null) {
  const r = await env.DB.prepare(`INSERT INTO comments (id, author_id, post_number, body, parent_number, depth, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'visible', '2026-10-25T00:00:00.000Z')`).bind(crypto.randomUUID(), author, post, body, parent, parent ? 2 : 1).run();
  return Number(r.meta.last_row_id);
}
const refs = (response: any) => response.body.items.map((x: any) => x.ref);
const fetchPage = (path: string, headers: Record<string, string> = {}) => (exports as any).default.fetch(new Request(`https://cw.test${path}`, { headers, redirect: 'manual' })) as Promise<Response>;

describe('exact reference parsing', () => {
  it.each([
    ['post-1', true], ['See (POST-1).', true], ['`post-1` is a literal quote', true],
    ['post-10 post-11 post-100', false], ['post-01', false], ['post-1@example.test', false], ['evil.example?ref=post-1', false], ['evil.example#post-1', false], ['例子.测试?ref=post-1', false], ['evil.example:8080?ref=post-1', false], ['127.0.0.1?ref=post-1', false], ['mail@post-1.com', false], ['post-1.com', false], ['apost-1', false], ['post-1abc', false], ['post-1-more', false],
    ['https://commonworld.one/posts/1', true], ['https://commonworld.one/posts/1/#comment-2', true],
    ['(https://commonworld.one/posts/1?order=top).', true], ['https://commonworld.one/posts/10', false],
    ['https://commonworld.one.evil.test/posts/1', false], ['https://commonworld.one@evil.test/posts/1', false],
    ['https://evil.test/post-1', false], ['https://evil.test/?q=post-1', false], ['https://evil.test/#post-1', false],
    ['//evil.test/post-1', false], ['www.evil.test/post-1', false], ['evil.test/post-1', false],
    ['http://commonworld.one/posts/1', false], ['https://commonworld.one:8443/posts/1', false],
    ['https://user@commonworld.one/posts/1', false], ['https://commonworld.one/posts/1/edit', false],
    ['https://evil.test/post-1 and post-1', true],
  ])('%s -> %s', (text, matches) => expect(referencesPost(text as string, 1)).toBe(matches));

  it('only accepts the explicitly configured origin, not staging as production', () => {
    expect(referencesPost('https://staging.commonworld.one/posts/1', 1)).toBe(false);
    expect(referencesPost('https://staging.commonworld.one/posts/1', 1, 'https://staging.commonworld.one')).toBe(true);
  });
});

describe('public connections in the Workers D1 runtime', () => {
  it('finds actual title/body references once per source, not substring matches or its own post', async () => {
    const a = await register();
    const target = await addPost(a.id, 'Target');
    await env.DB.prepare('UPDATE posts SET body = ? WHERE number = ?').bind(`post-${target}`, target).run();
    const yes = await addPost(a.id, `post-${target} twice: post-${target}.`);
    const title = await addPost(a.id, 'Body', `Follow-up to post-${target}`);
    const url = await addPost(a.id, `https://commonworld.one/posts/${target}?order=top`);
    await addPost(a.id, `post-${target}0 https://evil.test/posts/${target} https://evil.test/post-${target}`);
    const result = await api(`/v1/posts/${target}/connections`);
    expect(result.status).toBe(200);
    expect(refs(result)).toEqual([yes, title, url].map((n) => `post-${n}`));
    expect(result.body.next_after).toBeNull();
    expect(result.body.note).toContain('not evidence of collaboration');
    expect(result.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('never exposes hidden, withdrawn, deleted-author or banned-author post source text, even to staff', async () => {
    const a = await register(); const disabled = await register(); const deleted = await register(); const admin = await makeAdmin();
    const target = await addPost(a.id, 'Target'); const text = `secret-reference post-${target}`;
    const visible = await addPost(a.id, text);
    const hidden = await addPost(a.id, text); const withdrawn = await addPost(a.id, text);
    await addPost(disabled.id, text); await addPost(deleted.id, text);
    await env.DB.batch([
      env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(hidden),
      env.DB.prepare("UPDATE posts SET withdrawn_at = '2026-10-25' WHERE number = ?").bind(withdrawn),
      env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(disabled.id),
      env.DB.prepare("UPDATE accounts SET status = 'disabled', deleted_at = '2026-10-25' WHERE id = ?").bind(deleted.id),
    ]);
    for (const key of [undefined, admin.key]) expect(refs(await api(`/v1/posts/${target}/connections`, { key }))).toEqual([`post-${visible}`]);
  });

  it('applies comment visibility, hidden ancestors and hidden/banned parent posts; disabled ancestors do not hide replies', async () => {
    const a = await register(); const banned = await register();
    const target = await addPost(a.id, 'Target'); const other = await addPost(a.id, 'Other');
    const hiddenPost = await addPost(a.id, 'Hidden'); const bannedPost = await addPost(banned.id, 'Banned');
    const text = `post-${target}`;
    const visible = await addComment(a.id, other, text);
    const hidden = await addComment(a.id, other, text); await addComment(a.id, other, text, hidden);
    const disabled = await addComment(banned.id, other, text); const reply = await addComment(a.id, other, text, disabled);
    await addComment(a.id, hiddenPost, text); await addComment(a.id, bannedPost, text);
    const withdrawn = await addComment(a.id, other, text);
    await env.DB.batch([
      env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE number = ?").bind(hidden),
      env.DB.prepare("UPDATE comments SET withdrawn_at = '2026-10-25' WHERE number = ?").bind(withdrawn),
      env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(hiddenPost),
      env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(banned.id),
    ]);
    const result = await api(`/v1/posts/${target}/connections?source=comments`);
    expect(refs(result)).toEqual([visible, reply].map((n) => `comment-${n}`));
    expect(result.body.items[1].url).toBe(`/comments/${reply}`);
  });

  it('returns 404 for missing/hidden targets and 410 for banned targets, with neutral withdrawn/deleted titles', async () => {
    const a = await register(); const n = await addPost(a.id, 'Text', 'Never leak this title');
    expect((await api('/v1/posts/999999999999999/connections')).status).toBe(404);
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(n).run();
    expect((await api(`/v1/posts/${n}/connections`)).status).toBe(404);
    await env.DB.prepare("UPDATE posts SET status = 'visible', withdrawn_at = '2026-10-25' WHERE number = ?").bind(n).run();
    expect((await api(`/v1/posts/${n}/connections`)).body.post.title).toBe('Withdrawn by author');
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    const gone = await api(`/v1/posts/${n}/connections`);
    expect(gone.status).toBe(410); expect(JSON.stringify(gone.body)).not.toContain('Never leak');
    await env.DB.prepare("UPDATE accounts SET deleted_at = '2026-10-25' WHERE id = ?").bind(a.id).run();
    await env.DB.prepare('UPDATE posts SET withdrawn_at = NULL WHERE number = ?').bind(n).run();
    expect((await api(`/v1/posts/${n}/connections`)).body.post.title).toBe('Deleted account post');
  });

  it('continues past an empty 100-record window; pins the high-water mark and rechecks moderation on later pages', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    for (let i = 0; i < 99; i++) await addPost(a.id, 'No reference');
    const last = await addPost(a.id, `post-${target}`);
    const page1 = await api(`/v1/posts/${target}/connections`);
    expect(refs(page1)).toEqual([]); expect(page1.body.next_after).not.toBeNull(); expect(page1.body.through).toBe(last);
    const later = await addPost(a.id, `post-${target}`);
    const next = `/v1/posts/${target}/connections?after=${page1.body.next_after}&through=${page1.body.through}`;
    const page2 = await api(next);
    expect(refs(page2)).toEqual([`post-${last}`]); expect(page2.body.next_after).toBeNull();
    expect(refs(page2)).not.toContain(`post-${later}`);
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(last).run();
    expect(refs(await api(next))).toEqual([]);
    expect(refs(await api(`/v1/posts/${target}/connections?after=${last}`))).toEqual([`post-${later}`]);
  });

  it('pages comments independently without repeating a match', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    const expected: string[] = [];
    for (let i = 0; i < 101; i++) expected.push(`comment-${await addComment(a.id, target, `post-${target}`)}`);
    const first = await api(`/v1/posts/${target}/connections?source=comments`);
    const second = await api(`/v1/posts/${target}/connections?source=comments&after=${first.body.next_after}&through=${first.body.through}`);
    expect(refs(first).length).toBe(100); expect([...refs(first), ...refs(second)]).toEqual(expected); expect(second.body.next_after).toBeNull();
  });

  it('links a comment past the first 500 comments to its reachable permalink window', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target'); const other = await addPost(a.id, 'Other');
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500)
      INSERT INTO comments (id, author_id, post_number, body, depth, status, created_at)
      SELECT 'filler-' || x, ?, ?, 'No reference', 1, 'visible', '2026-10-25T00:00:00.000Z' FROM n`).bind(a.id, other).run();
    const late = await addComment(a.id, other, `Late reference to post-${target}`);
    const path = `/posts/${target}/connections`;
    const query = `?source=comments&after=${late - 1}&through=${late}`;
    const result = await api(`/v1${path}${query}`);
    expect(refs(result)).toEqual([`comment-${late}`]);
    expect(result.body.items[0].url).toBe(`/comments/${late}`);
    expect(await (await fetchPage(path + query)).text()).toContain(`href="/comments/${late}"`);
    expect(await (await fetchPage(path + '.md' + query)).text()).toContain(`](https://cw.test/comments/${late})`);
    const redirect = await fetchPage(`/comments/${late}`);
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get('location')!, 'https://cw.test');
    expect(location.pathname).toBe(`/posts/${other}`);
    expect(location.searchParams.get('after')).toBe(String(late - 1));
    expect(location.hash).toBe(`#comment-${late}`);
    const destination = await fetchPage(location.pathname + location.search);
    expect(destination.status).toBe(200);
    expect(await destination.text()).toContain(`id="comment-${late}"`);
  });

  it('keeps the selected scan in Markdown alternates and discourages crawl traversal without blocking reads', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    const skipped = await addComment(a.id, target, 'Outside the selected window');
    for (let i = 0; i < 101; i++) await addComment(a.id, target, `Reference post-${target}`);
    const path = `/posts/${target}/connections`;
    const through = skipped + 101;
    const query = `?source=comments&after=${skipped}&through=${through}`;
    const html = await fetchPage(path + query); const text = await html.text();
    expect(html.status).toBe(200);
    expect(text).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(html.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const alternate = text.match(/<link rel="alternate" type="text\/markdown" href="([^"]+)"/)![1].replace(/&amp;/g, '&');
    expect(alternate).toBe(`https://cw.test${path}.md${query}`);
    expect(html.headers.get('link')).toBe(`<${alternate}>; rel="alternate"; type="text/markdown"`);
    const md = await fetchPage(path + '.md' + query); const markdown = await md.text();
    expect(md.status).toBe(200);
    expect(md.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(markdown).toContain(`Source: comments. Scan after ${skipped}, through ${through}.`);
    expect(markdown).not.toContain('Outside the selected window');
    for (const source of ['posts', 'comments']) expect(text).toContain(`rel="nofollow" href="${path}?source=${source}"`);
    expect(text).toContain('rel="next nofollow"');
    expect(await (await fetchPage(`/posts/${target}`)).text()).toContain(`rel="nofollow" href="${path}"`);
    // the indexable post Markdown twin must not hand crawlers a bare, followable link into the scan
    const twin = await fetchPage(`/posts/${target}.md`);
    expect(twin.status).toBe(200);
    expect(await twin.text()).not.toContain('/connections');
    expect(await (await fetchPage('/robots.txt')).text()).not.toMatch(/Disallow:[^\n]*connections/i);
  });

  it.each(['', '.md'])('applies hidden 404 and banned 410 to the %s public view', async (suffix) => {
    const a = await register(); const target = await addPost(a.id, 'Private body', 'Private title');
    const path = `/posts/${target}/connections${suffix}`;
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(target).run();
    const hidden = await fetchPage(path);
    expect(hidden.status).toBe(404); expect(await hidden.text()).not.toContain('Private title');
    await env.DB.prepare("UPDATE posts SET status = 'visible' WHERE number = ?").bind(target).run();
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    const banned = await fetchPage(path);
    expect(banned.status).toBe(410); expect(await banned.text()).not.toContain('Private title');
  });

  it('truncates excerpts by Unicode code point without splitting an emoji at the boundary', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    const prefix = 'a'.repeat(279) + '😀';
    const source = await addPost(a.id, prefix + ` post-${target}`);
    const exact = await addPost(a.id, prefix, `post-${target}`);
    const result = await api(`/v1/posts/${target}/connections`);
    expect(refs(result)).toEqual([`post-${source}`, `post-${exact}`]);
    expect(result.body.items.map((x: any) => x.excerpt)).toEqual([prefix + '…', prefix]);
    expect(await (await fetchPage(`/posts/${target}/connections`)).text()).toContain(prefix + '…');
    expect(await (await fetchPage(`/posts/${target}/connections.md`)).text()).toContain(prefix + '…');
  });

  it('rejects invalid cursors/source before interpolating SQL', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    for (const query of ['source=posts%3BDROP%20TABLE%20posts', 'source=', 'after=-1', 'after=1e2', 'after=1%20OR%201=1', 'through=1000000000000000', 'through=0&after=1']) {
      expect((await api(`/v1/posts/${target}/connections?${query}`)).status, query).toBe(400);
    }
    expect((await api(`/v1/posts/${target}/connections`)).status).toBe(200);
  });

  it('serves matching HTML, Markdown and JSON views with escaped text and distinct cursor cache keys', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    const source = await addPost(a.id, `post-${target} <img src=x onerror=alert(1)>`, '[click](https://evil.test) <script>bad</script>');
    const path = `/posts/${target}/connections`;
    const html = await fetchPage(path); const text = await html.text();
    expect(html.status).toBe(200); expect(text).toContain(`post-${source}`); expect(text).toContain('&lt;script&gt;bad');
    expect(text).not.toContain('<img src=x'); expect(text).toContain(`href="https://cw.test/v1${path}"`);
    expect(text).toContain('noindex,nofollow'); expect(text).toContain(`${path}.md`);
    const md = await fetchPage(`${path}.md`); const markdown = await md.text();
    expect(md.status).toBe(200); expect(markdown).toContain(`post-${source}`); expect(markdown).toContain('\\[click\\]');
    expect(markdown).not.toContain('<script>'); expect(markdown).toContain('&lt;img');
    const negotiated = await fetchPage(path, { accept: 'text/markdown' });
    expect(await negotiated.text()).toBe(markdown);
    const json = await api(`/v1${path}`); expect(refs(json)).toEqual([`post-${source}`]);
    const key = pageCacheUrl(new URL(`https://cw.test${path}?source=comments&after=3&through=11&ignored=x`));
    expect(key.search).toBe('?source=comments&after=3&through=11');
    expect(await (await fetchPage(`/posts/${target}`)).text()).toContain(`href="${path}"`);
  });

  it('bounds source texts and uses at most four read statements with no writes', async () => {
    const a = await register(); const target = await addPost(a.id, 'Target');
    for (let i = 0; i < 110; i++) await addPost(a.id, `post-${target}`);
    const log: { sql: string; rows: number; writes: number }[] = [];
    const wrap = (sql: string, binds: unknown[] = []): any => ({
      bind: (...args: unknown[]) => wrap(sql, args),
      all: async () => { const result = await env.DB.prepare(sql).bind(...binds).all(); log.push({ sql, rows: result.results.length, writes: result.meta.rows_written }); return result; },
      first: async () => { const result = await env.DB.prepare(sql).bind(...binds).all(); log.push({ sql, rows: result.results.length, writes: result.meta.rows_written }); return result.results[0] ?? null; },
    });
    const data = await connectionsData({ env: { ...env, DB: { prepare: (sql: string) => wrap(sql) } } as any,
      url: new URL(`https://api.test/v1/posts/${target}/connections`), params: [String(target)], principal: null });
    expect(data.items.length).toBe(99); expect(log).toHaveLength(4);
    expect(log.every((entry) => entry.writes === 0)).toBe(true);
    expect(log[2].rows).toBe(101); expect(log[3].rows).toBeLessThanOrEqual(100);
    expect(log[3].sql).toContain('IN ('); expect(log[3].sql).not.toContain('LIKE');
  });
});
