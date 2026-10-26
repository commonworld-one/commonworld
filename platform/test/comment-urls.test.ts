/**
 * Outbound comment links past the first 500 comments (#158): every comment link that leaves the post page (the API
 * `url`, the export, profile history, search, recent comments, moderation log) is the stable `/comments/{n}` path. That
 * path redirects page-aware (commentPagePath, #114), so a comment past the first MAX_COMMENTS_LISTED of its post opens
 * the window `/posts/{p}?after=N` that actually shows it, instead of the first window where the anchor is missing.
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_COMMENTS_LISTED } from '../src/post-comments';
import { api, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.comment', null);
});

async function page(path: string) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** `count` top-level comments by `authorId` written straight into D1 (oldest first). */
async function bulkComments(postNumber: number, authorId: string, count: number): Promise<number[]> {
  const stmts = [];
  for (let i = 1; i <= count; i++) {
    const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
    stmts.push(env.DB.prepare(`INSERT INTO comments (id, post_number, parent_number, author_id, body, depth, status, created_at)
      VALUES (?, ?, NULL, ?, ?, 1, 'visible', ?)`).bind(`comment_bulk_${postNumber}_${i}`, postNumber, authorId, `bulk comment ${i}`, at));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  const { results } = await env.DB.prepare("SELECT number FROM comments WHERE post_number = ? AND id LIKE 'comment_bulk_%' ORDER BY number").bind(postNumber).all<{ number: number }>();
  return results.map((r) => r.number);
}

/** Follows a comment `url` the way a browser does: the 302, then the page it names; returns the redirect target and the page. */
async function follow(url: string) {
  const hop = await page(url);
  expect(hop.status).toBe(302);
  const location = hop.headers.get('location')!;
  const landing = await page(location.split('#')[0]);
  expect(landing.status).toBe(200);
  return { location, html: landing.text };
}

describe('outbound comment links reach their comment past the first 500 (#158)', () => {
  it('the 501st comment: its API url redirects to the window that shows it; an early comment opens the post page', async () => {
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'A very long discussion')).body;
    const numbers = await bulkComments(p.number, b.id, MAX_COMMENTS_LISTED + 1);
    const late = numbers[MAX_COMMENTS_LISTED];
    const early = numbers[0];

    const lateView = await api(`/v1/comments/${late}`);
    expect(lateView.status).toBe(200);
    expect(lateView.body.url).toBe(`/comments/${late}`);
    const lateHop = await follow(lateView.body.url);
    expect(lateHop.location).toBe(`/posts/${p.number}?after=${late - 1}#comment-${late}`);
    expect(lateHop.html).toContain(`id="comment-${late}"`);
    // the first window, where the old /posts/{p}#comment-{n} url landed, does not hold it
    expect((await page(`/posts/${p.number}`)).text).not.toContain(`id="comment-${late}"`);

    const earlyView = await api(`/v1/comments/${early}`);
    expect(earlyView.body.url).toBe(`/comments/${early}`);
    const earlyHop = await follow(earlyView.body.url);
    expect(earlyHop.location).toBe(`/posts/${p.number}#comment-${early}`);
    expect(earlyHop.html).toContain(`id="comment-${early}"`);

    // the same url in the post embed and the paged list
    const embed = await api(`/v1/posts/${p.number}`);
    expect(embed.body.comments[0].url).toBe(`/comments/${early}`);
    const rest = await api(`/v1/posts/${p.number}/comments?after=${numbers[MAX_COMMENTS_LISTED - 1]}`);
    expect(rest.body.items.map((c: any) => c.url)).toEqual([`/comments/${late}`]);

    // profile history links the stable path too, never the first-window anchor
    const profile = await page(`/c/${b.handle}`);
    expect(profile.text).toContain(`href="/comments/${late}"`);
    expect(profile.text).not.toContain(`href="/posts/${p.number}#comment-${late}"`);
  });
});
