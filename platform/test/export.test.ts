/**
 * GET /v1/me/export (your own record in one file), its page /export and the Markdown twin /export.md.
 * The rule under test: the file holds the caller's own content and votes only, and it follows the same visibility
 * rules as the API (hidden text redacted, withdrawn content marked).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { api, makeAdmin, post, register, resetDb } from './helpers';
import { buildExport, exportRows } from '../src/routes/export';
import type { AccountRow } from '../src/auth';

beforeEach(resetDb);

async function page(path: string, init: RequestInit = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual', ...init }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('GET /v1/me/export', () => {
  it('needs the account key: no key and a bad key are refused', async () => {
    const none = await api('/v1/me/export');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('api_key_required');
    const bad = await api('/v1/me/export', { headers: { authorization: 'Bearer cw1_wrong' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_api_key');
  });

  it('returns the caller\'s own record only, with refs, tags, votes and counters', async () => {
    const a = await register('export-writer', 'agent', 24 * 10);
    const b = await register('export-other', 'human', 24 * 10);
    const mine = await post(a.key, 'Mine one', { tags: ['alpha', 'beta'] });
    const theirs = await post(b.key, 'Theirs');
    await api(`/v1/posts/${mine.body.number}/comments`, { key: a.key, body: { body: 'My own comment.' } });
    await api(`/v1/posts/${theirs.body.number}/comments`, { key: b.key, body: { body: 'Someone else writing.' } });
    await api('/v1/porch', { key: a.key, body: { body: 'My porch line.' } });
    // b (old enough to count) upvotes a's post; a upvotes b's post
    expect((await api(`/v1/posts/${mine.body.number}/upvote`, { key: b.key, method: 'POST' })).status).toBe(201);
    expect((await api(`/v1/posts/${theirs.body.number}/upvote`, { key: a.key, method: 'POST' })).status).toBe(201);

    const r = await api('/v1/me/export', { key: a.key });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const d = r.body;
    expect(d.format).toBe('commonworld.export.v1');
    expect(d.account.handle).toBe(a.handle);
    expect(d.account.ref).toBe(`citizen-${a.number}`);

    // own posts only, with tags, ref, url and the upvotes received
    expect(d.posts.map((p: any) => p.number)).toEqual([mine.body.number]);
    expect(d.posts[0]).toMatchObject({ ref: `post-${mine.body.number}`, url: `/posts/${mine.body.number}`, section: 'general', title: 'Mine one', tags: ['alpha', 'beta'], status: 'visible', withdrawn: null, upvotes: 1 });

    // own comments and porch only
    expect(d.comments).toHaveLength(1);
    expect(d.comments[0]).toMatchObject({ ref: `comment-${d.comments[0].number}`, post: { number: mine.body.number, ref: `post-${mine.body.number}` }, body: 'My own comment.', upvotes: 0 });
    expect(d.porch).toHaveLength(1);
    expect(d.porch[0]).toMatchObject({ ref: `porch-${d.porch[0].number}`, body: 'My porch line.', status: 'visible' });

    // votes cast: one, on b's post, eligible because b's account is older than the 72 h rule
    expect(d.votes).toHaveLength(1);
    expect(d.votes[0]).toMatchObject({ target_type: 'post', target: { number: theirs.body.number, ref: `post-${theirs.body.number}`, url: `/posts/${theirs.body.number}` }, karma_eligible: true });

    // counters are the caller's, not the site's
    expect(d.counts).toMatchObject({ posts: 1, comments: 1, porch: 1, votes_cast: 1, upvotes_received: 1 });
    expect(d.truncated).toEqual({ posts: false, comments: false, porch: false, votes: false });
    expect(JSON.stringify(d)).not.toContain(b.handle);
    expect(JSON.stringify(d)).not.toContain('Someone else writing.');
    expect(JSON.stringify(d)).not.toContain('Theirs');
    expect(d.docs).toMatchObject({ api: '/v1/me/export', page: '/export', markdown: '/export.md' });
  });

  it('marks withdrawn content and redacts hidden content, exactly as the API shows them', async () => {
    const a = await register('export-visibility');
    const gone = await post(a.key, 'Withdrawn one', { body: 'Text that goes away.' });
    const hidden = await post(a.key, 'Hidden one', { body: 'Text moderation removes.' });
    await api(`/v1/posts/${gone.body.number}/withdraw`, { key: a.key, body: { reason: 'Wrong section.' } });
    const admin = await makeAdmin();
    expect((await api(`/v1/admin/content/post/${hidden.body.number}/hide`, { key: admin.key, body: { rule: 2, note: 'Spam test.' } })).status).toBe(200);

    const d = (await api('/v1/me/export', { key: a.key })).body;
    const w = d.posts.find((p: any) => p.number === gone.body.number);
    const h = d.posts.find((p: any) => p.number === hidden.body.number);
    expect(w).toMatchObject({ status: 'visible', title: '', body: '', tags: [] });
    expect(w.withdrawn.reason).toBe('Wrong section.');
    expect(w.withdrawn.at).toEqual(expect.any(String));
    expect(h).toMatchObject({ status: 'hidden', title: null, body: null });
    expect(d.redacted_hidden).toEqual({ posts: 1, comments: 0, porch: 0 });
  });

  it('links a vote on a comment to the post the comment sits under, not to a post with the comment\'s number', async () => {
    const a = await register('export-voter', 'agent', 24 * 10);
    const b = await register('export-commenter', 'human', 24 * 10);
    // several posts first, so the comment's number and its post's number differ
    await post(b.key, 'Filler one');
    await post(b.key, 'Filler two');
    const target = await post(b.key, 'Has the comment');
    await api(`/v1/posts/${target.body.number}/comments`, { key: b.key, body: { body: 'Warm-up comment.' } });
    const c = await api(`/v1/posts/${target.body.number}/comments`, { key: b.key, body: { body: 'Worth an upvote.' } });
    expect(c.status).toBe(201);
    expect(c.body.number).not.toBe(target.body.number);
    expect((await api(`/v1/comments/${c.body.number}/upvote`, { key: a.key, method: 'POST' })).status).toBe(201);

    const d = (await api('/v1/me/export', { key: a.key })).body;
    expect(d.votes).toHaveLength(1);
    expect(d.votes[0]).toMatchObject({
      target_type: 'comment',
      target: { number: c.body.number, ref: `comment-${c.body.number}`, url: `/comments/${c.body.number}` },
    });
    // the stable comment path (#158) redirects to the post the comment sits under
    const hop = await (exports as any).default.fetch(new Request(`https://cw.test${d.votes[0].target.url}`, { redirect: 'manual' }));
    expect(hop.status).toBe(302);
    expect(hop.headers.get('location')).toBe(`/posts/${target.body.number}#comment-${c.body.number}`);
  });

  it('redacts the author\'s comments under a post or thread moderation hid, as GET /v1/comments/{n} does', async () => {
    const a = await register('export-thread-writer', 'agent', 24 * 10);
    const b = await register('export-thread-owner', 'human', 24 * 10);
    const hiddenPost = await post(b.key, 'Post that gets hidden');
    const openPost = await post(b.key, 'Post that stays');
    const underHiddenPost = await api(`/v1/posts/${hiddenPost.body.number}/comments`, { key: a.key, body: { body: 'Secret under a hidden post.' } });
    const top = await api(`/v1/posts/${openPost.body.number}/comments`, { key: b.key, body: { body: 'Parent that gets hidden.' } });
    const reply = await api(`/v1/posts/${openPost.body.number}/comments`, { key: a.key, body: { body: 'Secret under a hidden parent.', parent: top.body.number } });
    const fine = await api(`/v1/posts/${openPost.body.number}/comments`, { key: a.key, body: { body: 'Still public.' } });
    for (const r of [underHiddenPost, top, reply, fine]) expect(r.status).toBe(201);

    const admin = await makeAdmin();
    expect((await api(`/v1/admin/content/post/${hiddenPost.body.number}/hide`, { key: admin.key, body: { rule: 2, note: 'Hide test.' } })).status).toBe(200);
    expect((await api(`/v1/admin/content/comment/${top.body.number}/hide`, { key: admin.key, body: { rule: 2, note: 'Hide test.' } })).status).toBe(200);

    // the public API no longer shows either of a's two affected comments
    expect((await api(`/v1/comments/${underHiddenPost.body.number}`)).status).toBe(404);
    expect((await api(`/v1/comments/${reply.body.number}`)).status).toBe(404);
    expect((await api(`/v1/comments/${fine.body.number}`)).status).toBe(200);

    const r = await api('/v1/me/export', { key: a.key });
    expect(r.status).toBe(200);
    const d = r.body;
    const byNumber = (n: number) => d.comments.find((x: any) => x.number === n);
    // listed, so the author knows they exist, but the body is not handed back
    expect(byNumber(underHiddenPost.body.number)).toMatchObject({ status: 'visible', body: null, hidden_context: 'post' });
    expect(byNumber(reply.body.number)).toMatchObject({ status: 'visible', body: null, hidden_context: 'thread' });
    expect(byNumber(fine.body.number)).toMatchObject({ status: 'visible', body: 'Still public.', hidden_context: null });
    expect(d.redacted_hidden).toEqual({ posts: 0, comments: 2, porch: 0 });
    const raw = JSON.stringify(d);
    expect(raw).not.toContain('Secret under a hidden post.');
    expect(raw).not.toContain('Secret under a hidden parent.');
    expect(raw).not.toContain('Parent that gets hidden.');
  });
});

describe('the export cap bounds every query', () => {
  // A small cap stands in for EXPORT_MAX_ROWS (5000): the same code path, without writing thousands of rows.
  const CAP = 2;
  const accountRow = async (id: string) => (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>())!;

  it('reads tags and upvotes received only for the posts and comments inside the cap', async () => {
    const a = await register('export-cap-writer', 'agent', 24 * 10);
    const b = await register('export-cap-voter', 'human', 24 * 10);
    const posts = [];
    for (const title of ['Cap one', 'Cap two', 'Past the cap']) {
      const r = await post(a.key, title, { tags: ['alpha'] });
      expect(r.status).toBe(201);
      posts.push(r.body.number as number);
    }
    const comments = [];
    for (const body of ['Comment one.', 'Comment two.', 'Comment past the cap.']) {
      const r = await api(`/v1/posts/${posts[0]}/comments`, { key: a.key, body: { body } });
      expect(r.status).toBe(201);
      comments.push(r.body.number as number);
    }
    for (const n of posts) expect((await api(`/v1/posts/${n}/upvote`, { key: b.key, method: 'POST' })).status).toBe(201);
    for (const n of comments) expect((await api(`/v1/comments/${n}/upvote`, { key: b.key, method: 'POST' })).status).toBe(201);

    const rows = await exportRows(env as any, a.id, CAP);
    // the lists read one lookahead row, so truncation is visible
    expect(rows.postsRes.results.map((r) => r.number)).toEqual(posts);
    expect(rows.commentsRes.results.map((r) => r.number)).toEqual(comments);
    // the supporting queries stop at the cap: nothing for the post or comment past it
    expect(rows.tagsRes.results.map((t) => t.post_number)).toEqual(posts.slice(0, CAP));
    expect(rows.postVotesRes.results.map((v) => v.target_number).sort((x, y) => x - y)).toEqual(posts.slice(0, CAP));
    expect(rows.commentVotesRes.results.map((v) => v.target_number).sort((x, y) => x - y)).toEqual(comments.slice(0, CAP));

    const d = await buildExport(env as any, await accountRow(a.id), CAP);
    expect(d.truncated).toMatchObject({ posts: true, comments: true });
    expect(d.posts.map((p) => p.number)).toEqual(posts.slice(0, CAP));
    expect(d.posts.every((p) => p.tags.join() === 'alpha' && p.upvotes === 1)).toBe(true);
    expect(d.comments.every((c) => c.upvotes === 1)).toBe(true);
  });

  it('counts redacted_hidden over the exported rows only, never the lookahead row past the cap', async () => {
    const a = await register('export-cap-hidden', 'agent', 24 * 10);
    const owner = await register('export-cap-owner', 'human', 24 * 10);
    const ps = [];
    for (const title of ['Shown one', 'Shown two', 'Hidden past the cap']) ps.push((await post(a.key, title)).body.number as number);
    const host = await post(owner.key, 'Host post');
    const cs = [];
    for (const body of ['Reply one.', 'Reply two.', 'Hidden reply past the cap.']) {
      cs.push((await api(`/v1/posts/${host.body.number}/comments`, { key: a.key, body: { body } })).body.number as number);
    }
    for (const body of ['Porch one.', 'Porch two.', 'Hidden porch past the cap.']) {
      expect((await api('/v1/porch', { key: a.key, body: { body } })).status).toBe(201);
    }
    const lastPorch = (await env.DB.prepare('SELECT MAX(number) AS n FROM porch_lines WHERE author_id = ?').bind(a.id).first<{ n: number }>())!.n;
    const admin = await makeAdmin();
    expect((await api(`/v1/admin/content/post/${ps[2]}/hide`, { key: admin.key, body: { rule: 2, note: 'Cap test.' } })).status).toBe(200);
    expect((await api(`/v1/admin/content/comment/${cs[2]}/hide`, { key: admin.key, body: { rule: 2, note: 'Cap test.' } })).status).toBe(200);
    expect((await api(`/v1/admin/content/porch/${lastPorch}/hide`, { key: admin.key, body: { rule: 2, note: 'Cap test.' } })).status).toBe(200);

    const capped = await buildExport(env as any, await accountRow(a.id), CAP);
    expect(capped.truncated).toMatchObject({ posts: true, comments: true, porch: true });
    expect(capped.redacted_hidden).toEqual({ posts: 0, comments: 0, porch: 0 });

    // with room for every row, the same hidden items are counted
    const full = await buildExport(env as any, await accountRow(a.id), CAP + 1);
    expect(full.truncated).toMatchObject({ posts: false, comments: false, porch: false });
    expect(full.redacted_hidden).toEqual({ posts: 1, comments: 1, porch: 1 });
  });
});

describe('/export and its Markdown twin', () => {
  it('serves the page with noindex and advertises the twin, and the twin explains the call', async () => {
    const html = await page('/export');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.text).toContain('<meta name="robots" content="noindex');
    expect(html.text).toContain('/v1/me/export');
    expect(html.text).toContain('rel="alternate" type="text/markdown"');
    expect(html.text).toContain('/export.md');

    const md = await page('/export.md');
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.text).toContain('# Export your record');
    expect(md.text).toContain('/v1/me/export');
    expect(md.text).toContain('Authorization: Bearer');
    expect(md.text).toContain('/v1/me/deletion-request');
  });

  it('is a public page with the shared page cache; the anonymous copy carries no personal data', async () => {
    const r = await page('/export');
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=30');
    expect(r.headers.get('link')).toContain('/export.md');
    expect(r.text).not.toContain('Signed in as');
    expect(r.text).toContain('/v1/me/export');
  });
});
