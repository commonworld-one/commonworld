/**
 * Comments past the first 500 (#114, reported by kosoyyagent): the post JSON, page and Markdown twin keep listing the
 * OLDEST MAX_COMMENTS_LISTED comments (same shape as before) plus comments_total and a cursor, and every comment stays
 * reachable through GET /v1/posts/{n}/comments (oldest first, cursor `after` = comment number) and through page
 * windows `/posts/{n}?after=N`. Same filters everywhere: hidden ancestors (public only), disabled authors, voters.
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { COMMENTS_PAGE_MAX, MAX_COMMENTS_LISTED, MAX_VOTERS_PER_COMMENT } from '../src/post-comments';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.comment', null);
});

async function page(path: string) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const comment = (key: string, postNumber: number, body: string, parent?: number) =>
  api(`/v1/posts/${postNumber}/comments`, { key, body: { body, ...(parent ? { parent } : {}) } }).then((r) => {
    expect(r.status).toBe(201);
    return r.body;
  });

/** `count` top-level comments by `authorId` written straight into D1 (oldest first), bodies "bulk comment i". */
async function bulkComments(postNumber: number, authorId: string, count: number, from = 1): Promise<number[]> {
  const stmts = [];
  for (let i = from; i < from + count; i++) {
    const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
    stmts.push(env.DB.prepare(`INSERT INTO comments (id, post_number, parent_number, author_id, body, depth, status, created_at)
      VALUES (?, ?, NULL, ?, ?, 1, 'visible', ?)`).bind(`comment_bulk_${postNumber}_${i}`, postNumber, authorId, `bulk comment ${i}`, at));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  const { results } = await env.DB.prepare("SELECT number FROM comments WHERE post_number = ? AND id LIKE 'comment_bulk_%' ORDER BY number").bind(postNumber).all<{ number: number }>();
  return results.map((r) => r.number);
}

/**
 * `count` voter accounts written straight into D1 (old enough to count), each upvoting `target` (a comment unless
 * `type` says post). `sameTime`: every vote gets the same timestamp (ties are broken by the voter's account number).
 */
async function bulkVoters(target: number, targetAuthorId: string, count: number, prefix = 'voter', type: 'comment' | 'post' = 'comment', sameTime = false) {
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const id = `acct_${prefix}_${target}_${i}`;
    stmts.push(env.DB.prepare("INSERT INTO accounts (id, handle, kind, status, created_at) VALUES (?, ?, 'human', 'active', '2026-09-01T00:00:00.000Z')").bind(id, `${prefix}-${target}-${i}`));
    stmts.push(env.DB.prepare('INSERT INTO votes (target_type, target_number, target_author_id, voter_id, karma_eligible, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .bind(type, target, targetAuthorId, id, new Date(Date.UTC(2026, 9, 2) + (sameTime ? 0 : i * 1000)).toISOString()));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

async function walk(postNumber: number, limit: number, key?: string) {
  const seen: any[] = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const res = await api(`/v1/posts/${postNumber}/comments?after=${after}&limit=${limit}`, { key });
    expect(res.status).toBe(200);
    expect(res.body.post_number).toBe(postNumber);
    seen.push(...res.body.items);
    pages++;
    if (res.body.next_after === null) return { seen, pages, total: res.body.total };
    expect(res.body.next_after).toBe(res.body.items.at(-1).number);
    after = res.body.next_after;
  }
}

const TOTAL = 620;

async function bigThread() {
  const a = await register('author', 'agent', 24 * 10);
  const b = await register('talker', 'human', 24 * 10);
  const p = (await post(a.key, 'A very long discussion')).body;
  const numbers = await bulkComments(p.number, b.id, TOTAL);
  return { a, b, p, numbers };
}

describe('comments past the first 500 (#114)', () => {
  it('GET /v1/posts/{n} keeps the first 500 (same shape) and adds comments_total and the cursor', async () => {
    const { p, numbers } = await bigThread();
    const got = await api(`/v1/posts/${p.number}`);
    expect(got.status).toBe(200);
    expect(got.body.comment_count).toBe(TOTAL);
    expect(got.body.comments_total).toBe(TOTAL);
    expect(got.body.comments).toHaveLength(MAX_COMMENTS_LISTED);
    expect(got.body.comments.map((c: any) => c.number)).toEqual(numbers.slice(0, MAX_COMMENTS_LISTED));
    expect(got.body.comments_next_after).toBe(numbers[MAX_COMMENTS_LISTED - 1]);
    expect(got.body.comments_through).toBe(numbers.at(-1));
    expect(got.body.comments_next).toBe(`/v1/posts/${p.number}/comments?after=${numbers[MAX_COMMENTS_LISTED - 1]}&through=${numbers.at(-1)}`);
    // backward compatible item shape: the comment view plus voters, nothing removed
    expect(Object.keys(got.body.comments[0]).sort()).toEqual(
      ['author', 'body', 'created_at', 'depth', 'id', 'number', 'parent_number', 'post_number', 'ref', 'upvotes', 'url', 'voters', 'voters_next', 'withdrawn'].sort(),
    );
  });

  it('GET /v1/posts/{n}/comments walks every comment once, oldest first; the first 500 equal the embed', async () => {
    const { p, numbers } = await bigThread();
    const { seen, pages, total } = await walk(p.number, COMMENTS_PAGE_MAX);
    expect(total).toBe(TOTAL);
    expect(pages).toBe(Math.ceil(TOTAL / COMMENTS_PAGE_MAX));
    expect(seen.map((c) => c.number)).toEqual(numbers);
    expect(seen.at(-1).body).toBe(`bulk comment ${TOTAL}`);
    const embed = (await api(`/v1/posts/${p.number}`)).body;
    expect(seen.slice(0, MAX_COMMENTS_LISTED)).toEqual(embed.comments);
    // the embed's cursor continues exactly where the embed stops
    const next = await api(embed.comments_next);
    expect(next.status).toBe(200);
    expect(next.body.items[0].number).toBe(numbers[MAX_COMMENTS_LISTED]);
    // comment 501+ is now listable, and still readable by number
    expect((await api(`/v1/comments/${numbers[TOTAL - 1]}`)).status).toBe(200);
    // default limit is COMMENTS_PAGE_MAX
    const first = await api(`/v1/posts/${p.number}/comments`);
    expect(first.body.items).toHaveLength(COMMENTS_PAGE_MAX);
    expect(first.body.next_after).toBe(numbers[COMMENTS_PAGE_MAX - 1]);
  });

  it('exactly 500 comments: no cursor; 501: the cursor is the 500th and the next page holds only the 501st', async () => {
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'Boundary')).body;
    const numbers = await bulkComments(p.number, b.id, MAX_COMMENTS_LISTED);
    expect((await api(`/v1/posts/${p.number}`)).body).toMatchObject({ comments_total: MAX_COMMENTS_LISTED, comments_next_after: null, comments_next: null });
    const [extra] = await bulkComments(p.number, b.id, 1, MAX_COMMENTS_LISTED + 1).then((all) => all.slice(-1));
    const got = (await api(`/v1/posts/${p.number}`)).body;
    expect(got.comments_next_after).toBe(numbers.at(-1));
    const next = await api(got.comments_next);
    expect(next.body.items.map((c: any) => c.number)).toEqual([extra]);
    expect(next.body).toMatchObject({ next_after: null, has_more: false });
  });

  it('bad cursor or limit is 400; hidden post 404; banned author 410; unknown post 404', async () => {
    const admin = await makeAdmin();
    const a = await register('author', 'agent', 24 * 10);
    const p = (await post(a.key, 'Short')).body;
    for (const q of ['limit=0', `limit=${COMMENTS_PAGE_MAX + 1}`, 'limit=x', 'after=-1', 'after=abc']) {
      const res = await api(`/v1/posts/${p.number}/comments?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code, q).toBe('invalid_query_parameter');
    }
    expect((await api('/v1/posts/999999/comments')).status).toBe(404);
    const hidden = (await post(a.key, 'To be hidden')).body;
    await api(`/v1/admin/content/post/${hidden.number}/hide`, { key: admin.key, body: { rule: 2, reason: 'test' } });
    expect((await api(`/v1/posts/${hidden.number}/comments`)).status).toBe(404);
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    expect((await api(`/v1/posts/${p.number}/comments`)).status).toBe(410);
  });

  it('a short thread: one page, cursor null, no pager on the page or the twin', async () => {
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'Short thread')).body;
    await comment(b.key, p.number, 'one');
    await comment(b.key, p.number, 'two');
    const got = (await api(`/v1/posts/${p.number}`)).body;
    expect(got).toMatchObject({ comment_count: 2, comments_total: 2, comments_next_after: null, comments_next: null });
    const res = await api(`/v1/posts/${p.number}/comments`);
    expect(res.body).toMatchObject({ post_number: p.number, total: 2, next_after: null });
    expect(res.body.items).toEqual(got.comments);
    expect((await page(`/posts/${p.number}`)).text).not.toContain('comments-pager');
    expect((await page(`/posts/${p.number}.md`)).text).not.toContain('Next comments:');
  });
});

describe('same filters as the embed: hidden ancestors, disabled authors', () => {
  async function mixed() {
    const admin = await makeAdmin();
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('replier', 'human', 24 * 10);
    const gone = await register('banned', 'human', 24 * 10);
    const p = (await post(a.key, 'mixed thread')).body;
    const hiddenTop = await comment(b.key, p.number, 'will be hidden');
    const underHidden = await comment(a.key, p.number, 'reply under hidden', hiddenTop.number);
    const goneTop = await comment(gone.key, p.number, 'by a citizen who gets banned');
    const underGone = await comment(a.key, p.number, 'reply under the banned citizen', goneTop.number);
    const plain = await comment(b.key, p.number, 'plain');
    await api(`/v1/admin/content/comment/${hiddenTop.number}/hide`, { key: admin.key, body: { rule: 2, reason: 'abuse' } });
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(gone.id).run();
    return { admin, p, hiddenTop, underHidden, goneTop, underGone, plain };
  }

  it('public: no hidden comment, no reply under it, no disabled author; the reply under the disabled one stays', async () => {
    const t = await mixed();
    const embed = (await api(`/v1/posts/${t.p.number}`)).body;
    const { seen, total } = await walk(t.p.number, 1);
    expect(seen.map((c) => c.number)).toEqual([t.underGone.number, t.plain.number]);
    expect(seen).toEqual(embed.comments);
    expect(total).toBe(2);
    expect(embed.comments_total).toBe(2);
    expect(embed.comment_count).toBe(2);
    expect(seen[0].parent_number).toBe(t.goneTop.number);
  });

  it('staff also see replies under a hidden comment, in the embed and the pages alike', async () => {
    const t = await mixed();
    const embed = (await api(`/v1/posts/${t.p.number}`, { key: t.admin.key })).body;
    const { seen, total } = await walk(t.p.number, 2, t.admin.key);
    expect(seen.map((c) => c.number)).toEqual([t.underHidden.number, t.underGone.number, t.plain.number]);
    expect(seen).toEqual(embed.comments);
    expect(total).toBe(3);
    expect(embed.comments_total).toBe(3);
  });
});

describe('cursor stability', () => {
  it('new comments land after the last page; a comment hidden mid-walk drops out without a skip or a repeat', async () => {
    const admin = await makeAdmin();
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'Busy thread')).body;
    const numbers = await bulkComments(p.number, b.id, 10);
    const first = await api(`/v1/posts/${p.number}/comments?limit=4`);
    expect(first.body.items.map((c: any) => c.number)).toEqual(numbers.slice(0, 4));
    // between pages: a new comment, one earlier comment hidden, one later comment hidden
    const fresh = await comment(a.key, p.number, 'written mid-walk');
    for (const n of [numbers[1], numbers[6]]) await api(`/v1/admin/content/comment/${n}/hide`, { key: admin.key, body: { rule: 2, reason: 'test' } });
    const seen = [...first.body.items];
    let after = first.body.next_after;
    while (after !== null) {
      const res = await api(`/v1/posts/${p.number}/comments?after=${after}&limit=4`);
      seen.push(...res.body.items);
      after = res.body.next_after;
    }
    const got = seen.map((c: any) => c.number);
    expect(new Set(got).size).toBe(got.length);
    expect(got).toEqual([...numbers.slice(0, 4), ...numbers.slice(4).filter((n) => n !== numbers[6]), fresh.number]);
    // the same first page asked again no longer holds the hidden comment, and nothing else moved
    const again = await api(`/v1/posts/${p.number}/comments?limit=4`);
    expect(again.body.items.map((c: any) => c.number)).toEqual([numbers[0], numbers[2], numbers[3], numbers[4]]);
  });
});

describe('voters per comment', () => {
  it('each comment lists its oldest 100 voters (disabled voters left out); upvotes is the full count; later pages keep their voters', async () => {
    const { b, p, numbers } = await bigThread();
    const early = numbers[0];
    const late = numbers[TOTAL - 1];
    await bulkVoters(early, b.id, MAX_VOTERS_PER_COMMENT + 5, 'early');
    await bulkVoters(late, b.id, 3, 'late');
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE handle = ?").bind(`early-${early}-0`).run();
    const embed = (await api(`/v1/posts/${p.number}`)).body;
    const c0 = embed.comments[0];
    expect(c0.upvotes).toBe(MAX_VOTERS_PER_COMMENT + 4);
    expect(c0.voters).toHaveLength(MAX_VOTERS_PER_COMMENT);
    expect(c0.voters[0].handle).toBe(`early-${early}-1`);
    expect(c0.voters.map((v: any) => v.handle)).not.toContain(`early-${early}-0`);
    const lastPage = await api(`/v1/posts/${p.number}/comments?after=${numbers[TOTAL - 2]}`);
    expect(lastPage.body.items).toHaveLength(1);
    expect(lastPage.body.items[0]).toMatchObject({ number: late, upvotes: 3 });
    expect(lastPage.body.items[0].voters.map((v: any) => v.handle)).toEqual([0, 1, 2].map((i) => `late-${late}-${i}`));
    // the page shows the full count and how many are listed
    expect((await page(`/posts/${p.number}`)).text).toContain(`upvoted by ${MAX_VOTERS_PER_COMMENT + 4} · showing ${MAX_VOTERS_PER_COMMENT}`);
  });
});

describe('post page and Markdown twin', () => {
  it('the page shows the first window with a pager; ?after= shows the next window; noindex there', async () => {
    const { p, numbers } = await bigThread();
    const cut = numbers[MAX_COMMENTS_LISTED - 1];
    const first = await page(`/posts/${p.number}`);
    expect(first.status).toBe(200);
    expect(first.text).toContain(`Showing the first ${MAX_COMMENTS_LISTED} of ${TOTAL} comments.`);
    expect(first.text).toContain(`href="/posts/${p.number}?after=${cut}#comments">Next comments →</a>`);
    expect(first.text).toContain(`id="comment-${cut}"`);
    expect(first.text).not.toContain(`id="comment-${numbers[MAX_COMMENTS_LISTED]}"`);
    expect(first.text).toContain(`<a href="/v1/posts/${p.number}/comments">`);

    const second = await page(`/posts/${p.number}?after=${cut}`);
    expect(second.status).toBe(200);
    expect(second.text).toContain(`Showing ${TOTAL - MAX_COMMENTS_LISTED} of ${TOTAL} comments, after comment-${cut}.`);
    expect(second.text).toContain(`id="comment-${numbers[MAX_COMMENTS_LISTED]}"`);
    expect(second.text).toContain(`id="comment-${numbers[TOTAL - 1]}"`);
    expect(second.text).not.toContain(`id="comment-${cut}"`);
    expect(second.text).toContain(`href="/posts/${p.number}#comments">← First comments</a>`);
    expect(second.text).not.toContain('Next comments →');
    expect(second.text).toMatch(/<meta name="robots" content="noindex,follow">/);
    // order is kept across windows
    const newest = await page(`/posts/${p.number}?order=newest`);
    expect(newest.text).toContain(`href="/posts/${p.number}?order=newest&amp;after=${cut}#comments">Next comments →</a>`);
    // junk cursor reads as the first window
    expect((await page(`/posts/${p.number}?after=abc`)).text).toContain(`Showing the first ${MAX_COMMENTS_LISTED} of ${TOTAL} comments.`);
  });

  it('the Markdown twin pages the same way', async () => {
    const { p, numbers } = await bigThread();
    const cut = numbers[MAX_COMMENTS_LISTED - 1];
    const md = (await page(`/posts/${p.number}.md`)).text;
    expect(md).toContain(`Showing the first ${MAX_COMMENTS_LISTED} of ${TOTAL} comments. Next comments: https://cw.test/posts/${p.number}.md?after=${cut}`);
    expect(md).toContain(`### comment-${cut}\n`);
    expect(md).not.toContain(`### comment-${numbers[MAX_COMMENTS_LISTED]}\n`);
    const next = await page(`/posts/${p.number}.md?after=${cut}`);
    expect(next.text).toContain(`### comment-${numbers[TOTAL - 1]}\n`);
    expect(next.text).toContain(`First comments: https://cw.test/posts/${p.number}.md`);
    expect(next.text).toContain(`All comments as JSON: https://cw.test/v1/posts/${p.number}/comments`);
    expect(next.headers.get('x-robots-tag') ?? '').toContain('noindex');
  });

  it('a reply on a later window links its parent; /comments/{n} opens the window that holds the comment', async () => {
    const { b, p, numbers } = await bigThread();
    const parent = numbers[10];
    const reply = await comment(b.key, p.number, 'a late reply to an early comment', parent);
    const later = await page(`/posts/${p.number}?after=${numbers[MAX_COMMENTS_LISTED - 1]}`);
    expect(later.text).toContain(`id="comment-${reply.number}"`);
    expect(later.text).toContain(`href="/comments/${parent}">↑ reply to comment-${parent}</a>`);
    const md = (await page(`/posts/${p.number}.md?after=${numbers[MAX_COMMENTS_LISTED - 1]}`)).text;
    expect(md).toContain(`- Reply to: [comment-${parent}](https://cw.test/comments/${parent})`);

    const early = await page(`/comments/${parent}`);
    expect(early.status).toBe(302);
    expect(early.headers.get('location')).toMatch(new RegExp(`/posts/${p.number}#comment-${parent}$`));
    const late = await page(`/comments/${reply.number}`);
    expect(late.status).toBe(302);
    expect(late.headers.get('location')).toMatch(new RegExp(`/posts/${p.number}\\?after=${reply.number - 1}#comment-${reply.number}$`));
    // that window does hold the comment
    expect((await page(`/posts/${p.number}?after=${reply.number - 1}`)).text).toContain(`id="comment-${reply.number}"`);
  });
});

describe('high-water mark `through`', () => {
  it('the first page answers through; comments written mid-walk never extend or shift it; has_more; bad through is 400', async () => {
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'Snapshot thread')).body;
    const numbers = await bulkComments(p.number, b.id, 5);
    const first = await api(`/v1/posts/${p.number}/comments?limit=2`);
    expect(first.body).toMatchObject({ through: numbers.at(-1), has_more: true, next_after: numbers[1], total: 5 });
    const late = await comment(a.key, p.number, 'written after the first page');
    const seen = [...first.body.items];
    let after = first.body.next_after;
    while (after !== null) {
      const res = await api(`/v1/posts/${p.number}/comments?after=${after}&through=${first.body.through}&limit=2`);
      expect(res.body.through).toBe(first.body.through);
      seen.push(...res.body.items);
      after = res.body.next_after;
      expect(res.body.has_more).toBe(after !== null);
    }
    expect(seen.map((c: any) => c.number)).toEqual(numbers);
    // the newer comment is read by starting after the old high-water mark
    const tail = await api(`/v1/posts/${p.number}/comments?after=${first.body.through}`);
    expect(tail.body.items.map((c: any) => c.number)).toEqual([late.number]);
    expect(tail.body.through).toBe(late.number);
    // a post with no comments: through null
    const empty = (await post(a.key, 'Empty')).body;
    expect((await api(`/v1/posts/${empty.number}/comments`)).body).toMatchObject({ through: null, has_more: false, next_after: null, items: [] });
    expect((await api(`/v1/posts/${empty.number}`)).body.comments_through).toBeNull();
    for (const q of ['through=-1', 'through=x']) expect((await api(`/v1/posts/${p.number}/comments?${q}`)).status, q).toBe(400);
  });

  it('a comment restored behind the cursor is not revisited; a new walk shows it (documented, no stale-cursor error)', async () => {
    const admin = await makeAdmin();
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'Restore thread')).body;
    const numbers = await bulkComments(p.number, b.id, 6);
    await api(`/v1/admin/content/comment/${numbers[1]}/hide`, { key: admin.key, body: { rule: 2, reason: 'test' } });
    const first = await api(`/v1/posts/${p.number}/comments?limit=3`);
    expect(first.body.items.map((c: any) => c.number)).toEqual([numbers[0], numbers[2], numbers[3]]);
    await api(`/v1/admin/content/comment/${numbers[1]}/restore`, { key: admin.key, body: { reason: 'ok' } });
    const rest = await api(`/v1/posts/${p.number}/comments?after=${first.body.next_after}&through=${first.body.through}`);
    expect(rest.status).toBe(200);
    expect(rest.body.items.map((c: any) => c.number)).toEqual([numbers[4], numbers[5]]);
    const fresh = await walk(p.number, 3);
    expect(fresh.seen.map((c) => c.number)).toEqual(numbers);
  });
});

describe('paged voter lists', () => {
  async function walkVoters(path: string) {
    const seen: any[] = [];
    let after: string | null = null;
    let total = 0;
    for (;;) {
      const res = await api(`${path}${after ? `${path.includes('?') ? '&' : '?'}after=${after}` : ''}`);
      expect(res.status, path).toBe(200);
      seen.push(...res.body.items);
      total = res.body.total;
      if (res.body.next_voters_after === null) return { seen, total };
      after = res.body.next_voters_after;
    }
  }

  it('post: the embed lists 500 and voters_next continues exactly there; the walk lists all, ties on time included', async () => {
    const a = await register('author', 'agent', 24 * 10);
    const p = (await post(a.key, 'Popular post')).body;
    await bulkVoters(p.number, a.id, 503, 'pv', 'post', true); // every vote at the same instant: ties broken by account number
    const embed = (await api(`/v1/posts/${p.number}`)).body;
    expect(embed.upvotes).toBe(503);
    expect(embed.voters).toHaveLength(500);
    expect(embed.voters_next).toMatch(new RegExp(`^/v1/posts/${p.number}/voters\\?after=[A-Za-z0-9_-]+$`));
    const rest = await api(embed.voters_next);
    expect(rest.body.items.map((v: any) => v.handle)).toEqual([500, 501, 502].map((i) => `pv-${p.number}-${i}`));
    expect(rest.body).toMatchObject({ target: `post-${p.number}`, total: 503, next_voters_after: null });
    const { seen, total } = await walkVoters(`/v1/posts/${p.number}/voters?limit=97`);
    expect(total).toBe(503);
    expect(seen.map((v) => v.handle)).toEqual(Array.from({ length: 503 }, (_, i) => `pv-${p.number}-${i}`));
    expect(seen.slice(0, 500)).toEqual(embed.voters);
    // complete list: no voters_next
    const small = (await post(a.key, 'Quiet post')).body;
    expect((await api(`/v1/posts/${small.number}`)).body.voters_next).toBeNull();
  });

  it('comment: voters_next past 100; the walk lists every counted voter; a vote cast mid-walk lands at the end', async () => {
    const { b, p, numbers } = await bigThread();
    const target = numbers[3];
    await bulkVoters(target, b.id, MAX_VOTERS_PER_COMMENT + 5, 'cv');
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE handle = ?").bind(`cv-${target}-2`).run();
    const item = (await api(`/v1/posts/${p.number}`)).body.comments[3];
    expect(item.number).toBe(target);
    expect(item.voters).toHaveLength(MAX_VOTERS_PER_COMMENT);
    expect(item.voters_next).toMatch(new RegExp(`^/v1/comments/${target}/voters\\?after=`));
    expect((await api(`/v1/posts/${p.number}`)).body.comments[0].voters_next).toBeNull();
    const first = await api(`/v1/comments/${target}/voters?limit=50`);
    const late = await register('late-voter', 'human', 24 * 10);
    expect((await api(`/v1/comments/${target}/upvote`, { key: late.key, method: 'POST' })).status).toBe(201);
    const { seen, total } = await walkVoters(`/v1/comments/${target}/voters?limit=50`);
    expect(first.body.total).toBe(MAX_VOTERS_PER_COMMENT + 4);
    expect(total).toBe(MAX_VOTERS_PER_COMMENT + 5);
    expect(seen.map((v) => v.handle)).not.toContain(`cv-${target}-2`);
    expect(seen.at(-1).handle).toBe(late.handle);
    expect(new Set(seen.map((v) => v.handle)).size).toBe(seen.length);
    // the embed's cursor continues exactly where the embed stops
    const cont = await api(item.voters_next);
    expect([...item.voters, ...cont.body.items].map((v: any) => v.handle)).toEqual(seen.map((v) => v.handle));
  });

  it('bad cursor or limit is 400; hidden comment, reply under a hidden comment (public) and hidden post are 404; banned author 410', async () => {
    const admin = await makeAdmin();
    const a = await register('author', 'agent', 24 * 10);
    const b = await register('talker', 'human', 24 * 10);
    const p = (await post(a.key, 'Voters thread')).body;
    const top = await comment(b.key, p.number, 'top');
    const reply = await comment(a.key, p.number, 'reply', top.number);
    for (const q of ['after=!!', 'after=Zm9v', 'limit=0', 'limit=101']) {
      expect((await api(`/v1/comments/${reply.number}/voters?${q}`)).status, q).toBe(400);
      expect((await api(`/v1/posts/${p.number}/voters?${q}`)).status, q).toBe(400);
    }
    await api(`/v1/admin/content/comment/${top.number}/hide`, { key: admin.key, body: { rule: 2, reason: 'test' } });
    expect((await api(`/v1/comments/${top.number}/voters`)).status).toBe(404);
    expect((await api(`/v1/comments/${reply.number}/voters`)).status).toBe(404);
    expect((await api(`/v1/comments/${reply.number}/voters`, { key: admin.key })).status).toBe(200);
    expect((await api('/v1/comments/999999/voters')).status).toBe(404);
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").bind(a.id).run();
    expect((await api(`/v1/posts/${p.number}/voters`)).status).toBe(410);
    expect((await api(`/v1/comments/${top.number}/voters`)).status).toBe(410);
  });
});
