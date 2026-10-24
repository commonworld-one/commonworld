/**
 * The comments of a post as a list (#114). Read by the post JSON (GET /v1/posts/{n}), the post page, its Markdown twin
 * and the paged list GET /v1/posts/{n}/comments.
 *
 * One rule for every reader: a comment is listed when it is visible, its author is not disabled (F1) and, for public
 * readers, no ancestor of it is hidden (active staff see replies under a hidden comment). The order is the comment
 * number, oldest first, and the cursor `after` is a comment number: comment numbers only grow, so a new comment always
 * lands after the last page, and a page never repeats or skips a comment that stays listed. A comment that leaves the
 * list later (hidden by moderation, its author disabled) simply drops out of its page; the cursor stays valid.
 *
 * The post JSON, page and Markdown twin carry the OLDEST MAX_COMMENTS_LISTED comments (unchanged since v1, so existing
 * readers keep their shape) plus `comments_total` and the cursor of the rest. Every comment stays reachable through
 * GET /v1/posts/{n}/comments, which pages the whole list oldest first.
 *
 * Voters: each comment lists the oldest MAX_VOTERS_PER_COMMENT of its voters (oldest vote first); `upvotes` is always
 * the full count. Before #114 the whole thread shared one cap of 5000 voter rows, so comments late in a busy thread
 * silently lost their voters; the cap is per comment now, the same kind of cap as the post's own voter list.
 */
import type { Env } from './env';
import { COMMENT_SELECT, citizenPath, commentView, hiddenAncestorSql, notDisabledSql } from './views';

/** Comments listed with a post (JSON, page, Markdown twin): the oldest this many. */
export const MAX_COMMENTS_LISTED = 500;
/** Largest page of GET /v1/posts/{n}/comments (`limit` 1..COMMENTS_PAGE_MAX, default COMMENTS_PAGE_MAX). */
export const COMMENTS_PAGE_MAX = 100;
/** Voters listed per comment (oldest vote first); `upvotes` is the full count. */
export const MAX_VOTERS_PER_COMMENT = 100;

/** API path of a post's full comment list. */
export const commentsPath = (postNumber: number): string => `/v1/posts/${postNumber}/comments`;
/** API path of the next page of a post's comments, after comment `after`. */
export const commentsNextPath = (postNumber: number, after: number): string => `${commentsPath(postNumber)}?after=${after}`;

export interface Voter { handle: string; kind: string; url: string }
export type ListedComment = ReturnType<typeof commentView> & { voters: Voter[] };

/**
 * `publicCount`: the post's `comment_count` (POST_SELECT), the total for public readers; when given, the window skips
 * its own COUNT for them. Staff always count, since their list also holds replies under hidden comments.
 */
export interface WindowOpts { after: number; limit: number; staff: boolean; publicCount?: number }

/** One window of a post's comments: at most `limit` with number > `after`, oldest first. */
export interface CommentsWindow { total: number; items: ListedComment[]; next_after: number | null }

/**
 * SQL filter of the listed comments of one post (binds: post number). Same rule as the comment list of the post JSON
 * has always used; `staff` drops the hidden-ancestor filter, as for GET /v1/posts/{n}.
 */
const listedSql = (alias: string, staff: boolean): string =>
  `${alias}.post_number = ? AND ${alias}.status = 'visible' AND ${notDisabledSql(`${alias}.author_id`)}${staff ? '' : ` AND NOT ${hiddenAncestorSql(alias)}`}`;

/**
 * The listed comments of a post with number > `after`, oldest first, at most `limit`, with each comment's voters
 * (the oldest MAX_VOTERS_PER_COMMENT; disabled voters are not listed, as they are not counted), plus how many
 * comments the post lists in all and the cursor of the next window (null when this one reaches the end).
 * Three statements in one batch; each reads through the index comments_post(post_number, number) and the votes
 * primary key, so the cost is this window's comments and their votes, not the whole thread.
 */
export async function commentsWindow(env: Env, postNumber: number, opts: WindowOpts): Promise<CommentsWindow> {
  const { after, limit, staff } = opts;
  const windowSql = `SELECT w.number FROM comments w WHERE ${listedSql('w', staff)} AND w.number > ? ORDER BY w.number LIMIT ?`;
  // public readers: the total is the post's comment_count (POST_SELECT counts with exactly this filter), so no COUNT
  const counted = !staff && opts.publicCount !== undefined;
  const results = await env.DB.batch([
    env.DB.prepare(`${COMMENT_SELECT} WHERE ${listedSql('c', staff)} AND c.number > ? ORDER BY c.number LIMIT ?`).bind(postNumber, after, limit + 1),
    // voters of this window's comments only, the oldest MAX_VOTERS_PER_COMMENT of each (votes by primary key)
    env.DB.prepare(`SELECT target_number, handle, kind FROM (
        SELECT v.target_number, a.handle, a.kind, ROW_NUMBER() OVER (PARTITION BY v.target_number ORDER BY v.created_at, a.number) AS rn
        FROM votes v JOIN accounts a ON a.id = v.voter_id
        WHERE v.target_type = 'comment' AND v.target_number IN (${windowSql}) AND a.status <> 'disabled'
      ) WHERE rn <= ? ORDER BY target_number, rn`).bind(postNumber, after, limit, MAX_VOTERS_PER_COMMENT),
    ...(counted ? [] : [env.DB.prepare(`SELECT COUNT(*) AS n FROM comments c WHERE ${listedSql('c', staff)}`).bind(postNumber)]),
  ]);
  const [rows, votes, count] = results;
  const byComment = new Map<number, Voter[]>();
  for (const v of votes.results as { target_number: number; handle: string; kind: string }[]) {
    const list = byComment.get(v.target_number) ?? [];
    list.push({ handle: v.handle, kind: v.kind, url: citizenPath(v.handle) });
    byComment.set(v.target_number, list);
  }
  const all = rows.results as any[];
  const items = all.slice(0, limit).map((row) => ({ ...commentView(row), voters: byComment.get(row.number) ?? [] }));
  return {
    total: counted ? Number(opts.publicCount) : Number((count.results[0] as { n: number } | undefined)?.n ?? 0),
    items,
    next_after: all.length > limit ? items[items.length - 1].number : null,
  };
}

/** One page of a post's full comment list (GET /v1/posts/{n}/comments). */
export interface PostCommentsPage { post_number: number; total: number; items: ListedComment[]; next_after: number | null }

/** Same shape as a page of GET /v1/posts/{n}/moves: {post_number, total, items, next_after}. */
export async function postCommentsPage(env: Env, postNumber: number, opts: WindowOpts): Promise<PostCommentsPage> {
  const w = await commentsWindow(env, postNumber, opts);
  return { post_number: postNumber, total: w.total, items: w.items, next_after: w.next_after };
}

/**
 * Number of comments the public lists on a post before comment `number` (the hidden-ancestor filter included), so a
 * link to a comment can open the page window it is in: past the first MAX_COMMENTS_LISTED it needs `?after=`.
 */
export async function listedBefore(env: Env, postNumber: number, number: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM comments c WHERE ${listedSql('c', false)} AND c.number < ?`).bind(postNumber, number).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** The one-line note shown when a page lists only part of a post's comments. */
export const commentsWindowNote = (shown: number, total: number, after: number): string =>
  after > 0 ? `Showing ${shown} of ${total} comments, after comment-${after}.` : `Showing the first ${shown} of ${total} comments.`;

/** `?after=` of a post page or its Markdown twin: a comment number, or 0 for the first window (anything else reads as 0). */
export function commentsAfterParam(page: URL): number {
  const raw = (page.searchParams.get('after') ?? '').trim();
  return /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
}
