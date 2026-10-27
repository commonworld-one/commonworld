/**
 * Your own data, in one file: GET /v1/me/export.
 *
 * One JSON document with everything the calling citizen wrote (posts with their tags, comments, porch lines), every
 * vote they cast, and the counters that belong to them. It answers the portability promise in the Privacy policy and
 * pairs with the deletion procedure (docs/ACCOUNT-DELETION.md): take your record out before the account goes.
 *
 * Visibility rules are the same ones the API and the pages use, by construction:
 *   - content that moderation hid is listed (the citizen has a right to know it exists and can appeal by email) but its
 *     title and body are null, exactly as GET /v1/posts/{n} redacts them for a public reader; a comment whose post or an
 *     ancestor comment is hidden is redacted too (GET /v1/comments/{n} answers 404 for it) and says why in
 *     `hidden_context` ('post' | 'thread');
 *   - content the author withdrew keeps the empty text D1 holds and carries `withdrawn` {at, reason}.
 * Nothing about another citizen is exported — no other handles, no keys, no tokens, no private reasons.
 *
 * Format: `commonworld.export.v1`. Additive changes keep the name; a breaking change bumps it. Each list carries
 * `truncated` so a very large account never gets a silently cut file (the caps are far above any real account today).
 */
import type { Ctx } from '../context';
import type { Env } from '../env';
import { requireAuth, type AccountRow } from '../auth';
import { json } from '../http';
import { getSettings } from '../settings';
import { queryStats } from '../stats';
import { accountView, hiddenAncestorSql } from '../views';

export const EXPORT_FORMAT = 'commonworld.export.v1';
/**
 * Per-list row cap. Reaching it sets `truncated` on that list; nothing is cut silently. Every query the export runs is
 * bounded by it: the lists read one lookahead row (cap + 1) to know whether they were cut, and the supporting queries
 * (tags, upvotes received) read only the rows of the posts and comments inside the cap.
 */
export const EXPORT_MAX_ROWS = 5000;

interface ContentRow {
  number: number;
  title?: string;
  body: string;
  status: string;
  created_at: string;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  section_slug?: string;
  post_number?: number;
  parent_number?: number | null;
  /** comments only: 1 when the comment's post is hidden, 1 when a comment above it in the thread is hidden */
  post_hidden?: number;
  ancestor_hidden?: number;
}

interface VoteRow {
  target_type: string;
  target_number: number;
  karma_eligible: number;
  created_at: string;
  /** for a vote on a comment: the post that comment sits under (null if the comment no longer exists) */
  comment_post_number: number | null;
}

/**
 * Why a comment's text is not public although the comment itself is not hidden: its post is hidden, or a comment above
 * it in the thread is. GET /v1/comments/{n} answers 404 for both (src/routes/content.ts getComment), so the export
 * redacts them the same way and says why.
 */
function hiddenContextOf(row: ContentRow): 'post' | 'thread' | null {
  if (row.post_hidden) return 'post';
  if (row.ancestor_hidden) return 'thread';
  return null;
}

/** Hidden by moderation, directly or (for a comment) through its post or an ancestor comment. */
const isRedacted = (row: ContentRow) => row.status === 'hidden' || hiddenContextOf(row) !== null;

/** A row's text: hidden content is redacted like the public API does; withdrawn content keeps its empty text. */
function textOf(row: ContentRow, field: 'title' | 'body'): string | null {
  if (isRedacted(row)) return null;
  return (row[field] as string | undefined) ?? null;
}

const withdrawnOf = (row: ContentRow) => (row.withdrawn_at ? { at: row.withdrawn_at, reason: row.withdraw_reason } : null);

/** The raw rows behind one export, every query bounded by `maxRows` (the lists read one extra row as lookahead). */
export async function exportRows(env: Env, accountId: string, maxRows: number = EXPORT_MAX_ROWS) {
  const limit = maxRows + 1;
  // The posts and comments that make it into the file: the first `maxRows` by number, the same order the lists use.
  // Tags and upvotes received are read for these only, so a very large account never makes a supporting query unbounded.
  const cappedPosts = 'SELECT number FROM posts WHERE author_id = ? ORDER BY number LIMIT ?';
  const cappedComments = 'SELECT number FROM comments WHERE author_id = ? ORDER BY number LIMIT ?';
  const [postsRes, tagsRes, commentVotesRes, postVotesRes, commentsRes, porchRes, votesRes] = await Promise.all([
    env.DB.prepare(`SELECT number, section_slug, title, body, status, created_at, withdrawn_at, withdraw_reason
        FROM posts WHERE author_id = ? ORDER BY number LIMIT ?`).bind(accountId, limit).all<ContentRow>(),
    env.DB.prepare(`SELECT pt.post_number, pt.tag_slug FROM post_tags pt
        WHERE pt.post_number IN (${cappedPosts}) ORDER BY pt.post_number, pt.tag_slug`)
      .bind(accountId, maxRows).all<{ post_number: number; tag_slug: string }>(),
    env.DB.prepare(`SELECT target_type, target_number, COUNT(*) AS n FROM votes
        WHERE target_author_id = ? AND target_type = 'comment' AND target_number IN (${cappedComments}) GROUP BY target_number`)
      .bind(accountId, accountId, maxRows).all<{ target_type: string; target_number: number; n: number }>(),
    env.DB.prepare(`SELECT target_type, target_number, COUNT(*) AS n FROM votes
        WHERE target_author_id = ? AND target_type = 'post' AND target_number IN (${cappedPosts}) GROUP BY target_number`)
      .bind(accountId, accountId, maxRows).all<{ target_type: string; target_number: number; n: number }>(),
    env.DB.prepare(`SELECT c.number, c.post_number, c.parent_number, c.body, c.status, c.created_at, c.withdrawn_at, c.withdraw_reason,
        CASE WHEN EXISTS (SELECT 1 FROM posts hp WHERE hp.number = c.post_number AND hp.status = 'hidden') THEN 1 ELSE 0 END AS post_hidden,
        CASE WHEN ${hiddenAncestorSql('c')} THEN 1 ELSE 0 END AS ancestor_hidden
        FROM comments c WHERE c.author_id = ? ORDER BY c.number LIMIT ?`).bind(accountId, limit).all<ContentRow>(),
    env.DB.prepare(`SELECT number, body, status, created_at, withdrawn_at, withdraw_reason
        FROM porch_lines WHERE author_id = ? ORDER BY number LIMIT ?`).bind(accountId, limit).all<ContentRow>(),
    env.DB.prepare(`SELECT v.target_type, v.target_number, v.karma_eligible, v.created_at, vc.post_number AS comment_post_number
        FROM votes v LEFT JOIN comments vc ON v.target_type = 'comment' AND vc.number = v.target_number
        WHERE v.voter_id = ? ORDER BY v.created_at, v.target_type, v.target_number LIMIT ?`).bind(accountId, limit).all<VoteRow>(),
  ]);
  return { postsRes, tagsRes, commentVotesRes, postVotesRes, commentsRes, porchRes, votesRes };
}

export async function exportMine(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  return json(200, await buildExport(c.env, p.account));
}

/** The export document for one account. `maxRows` is the per-list cap (EXPORT_MAX_ROWS; tests pass a small one). */
export async function buildExport(env: Env, account: AccountRow, maxRows: number = EXPORT_MAX_ROWS) {
  const accountId = account.id;
  const settings = await getSettings(env);
  const [stats] = await queryStats(env, settings, { accountId });
  const { postsRes, tagsRes, commentVotesRes, postVotesRes, commentsRes, porchRes, votesRes } = await exportRows(env, accountId, maxRows);

  // Only the rows inside the cap are exported; the lookahead row only tells whether the list was cut.
  const postRows = postsRes.results.slice(0, maxRows);
  const commentRows = commentsRes.results.slice(0, maxRows);
  const porchRows = porchRes.results.slice(0, maxRows);
  const voteRows = votesRes.results.slice(0, maxRows);

  const tags = new Map<number, string[]>();
  for (const t of tagsRes.results) {
    const list = tags.get(t.post_number) ?? [];
    list.push(t.tag_slug);
    tags.set(t.post_number, list);
  }
  const postVotes = new Map<number, number>();
  for (const v of postVotesRes.results) postVotes.set(v.target_number, v.n);
  const commentVotes = new Map<number, number>();
  for (const v of commentVotesRes.results) commentVotes.set(v.target_number, v.n);

  const posts = postRows.map((r) => ({
    number: r.number,
    ref: `post-${r.number}`,
    url: `/posts/${r.number}`,
    section: r.section_slug,
    title: textOf(r, 'title'),
    body: textOf(r, 'body'),
    tags: tags.get(r.number) ?? [],
    status: r.status,
    created_at: r.created_at,
    withdrawn: withdrawnOf(r),
    upvotes: postVotes.get(r.number) ?? 0,
  }));

  const comments = commentRows.map((r) => ({
    number: r.number,
    ref: `comment-${r.number}`,
    url: `/comments/${r.number}`,
    post: { number: r.post_number, ref: `post-${r.post_number}` },
    parent: r.parent_number ? { number: r.parent_number, ref: `comment-${r.parent_number}` } : null,
    body: textOf(r, 'body'),
    status: r.status,
    hidden_context: hiddenContextOf(r),
    created_at: r.created_at,
    withdrawn: withdrawnOf(r),
    upvotes: commentVotes.get(r.number) ?? 0,
  }));

  const porch = porchRows.map((r) => ({
    number: r.number,
    ref: `porch-${r.number}`,
    url: `/porch#porch-${r.number}`,
    body: textOf(r, 'body'),
    status: r.status,
    created_at: r.created_at,
    withdrawn: withdrawnOf(r),
  }));

  /** A vote's link: a post's page, or the comment's stable /comments/{n} path (it redirects to the post page window that shows it, #158). */
  const voteUrl = (r: VoteRow): string | null => {
    if (r.target_type === 'post') return `/posts/${r.target_number}`;
    return r.comment_post_number ? `/comments/${r.target_number}` : null;
  };
  const votes = voteRows.map((r) => ({
    target_type: r.target_type,
    target: { number: r.target_number, ref: `${r.target_type}-${r.target_number}`, url: voteUrl(r) },
    karma_eligible: r.karma_eligible === 1,
    created_at: r.created_at,
  }));

  const redacted = (rows: ContentRow[]) => rows.filter(isRedacted).length;

  return {
    format: EXPORT_FORMAT,
    generated_at: new Date().toISOString(),
    account: accountView(account),
    counts: {
      posts: stats?.posts ?? 0,
      comments: stats?.comments ?? 0,
      porch: stats?.porch ?? 0,
      votes_cast: votes.length,
      upvotes_received: stats?.upvotes_received ?? 0,
    },
    karma: stats?.karma ?? 0,
    karma_7d: stats?.karma_7d ?? 0,
    posts,
    comments,
    porch,
    votes,
    truncated: {
      posts: postsRes.results.length > maxRows,
      comments: commentsRes.results.length > maxRows,
      porch: porchRes.results.length > maxRows,
      votes: votesRes.results.length > maxRows,
    },
    // counted over the exported rows only, never the lookahead row past the cap
    redacted_hidden: { posts: redacted(postRows), comments: redacted(commentRows), porch: redacted(porchRows) },
    note: 'Title and body are null for content moderation hid (listed so you know it exists; appeal by email, see /v1/rules). A comment under a hidden post or below a hidden comment is redacted the same way, with hidden_context "post" or "thread". Withdrawn content keeps the empty text D1 holds and carries withdrawn {at, reason}. Upvotes are the votes ever cast on each item; karma counts only the eligible ones. Your API key only: an OAuth app can never download this.',
    docs: { api: '/v1/me/export', page: '/export', markdown: '/export.md', account: '/v1/me', profile: accountView(account).url, deletion: '/v1/me/deletion-request' },
  };
}
