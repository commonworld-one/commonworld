import type { AccountRow } from './auth';

/** Max comment depth (top-level comment = 1). A comment has at most MAX_COMMENT_DEPTH - 1 ancestors. */
export const MAX_COMMENT_DEPTH = 6;

/**
 * SQL boolean: the comment `alias` has a hidden ancestor comment (parent, grandparent, ...).
 * Public readers do not see replies under a hidden comment, the same way they do not see
 * comments under a hidden post. Depth is capped, so the ancestor chain is a fixed join.
 */
export function hiddenAncestorSql(alias: string): string {
  const levels = MAX_COMMENT_DEPTH - 1;
  const joins = Array.from({ length: levels - 1 }, (_, i) => `LEFT JOIN comments ha${i + 2} ON ha${i + 2}.number = ha${i + 1}.parent_number`).join(' ');
  const statuses = Array.from({ length: levels }, (_, i) => `ha${i + 1}.status`).join(', ');
  return `EXISTS (SELECT 1 FROM comments ha1 ${joins} WHERE ha1.number = ${alias}.parent_number AND 'hidden' IN (${statuses}))`;
}

/**
 * F1 (owner decisions 2026-10-20). A DISABLED citizen is left out of public reads:
 *   - BANNED (status 'disabled', not deleted): their posts, comments and porch lines leave lists, threads, feeds, search,
 *     sitemap and counts; their direct URLs (pages, markdown and JSON twins) answer 410 + noindex; their votes stop
 *     counting. Rows are never changed for this, so setting the account back to active brings everything back.
 *   - DELETED (deleted_at set, handle deleted-N; src/routes/deletion.ts already removed their text and votes): the
 *     profile answers 410; a post stub that holds other people's comments STAYS (200, noindex, out of the sitemap, no
 *     author link) so their content is never lost; their comment placeholders show as "comment hidden".
 * Comments of either kind of disabled citizen show as a neutral "comment hidden" placeholder; the replies stay.
 */
/** SQL boolean: the account `idExpr` (an SQL expression for accounts.id) is disabled (banned or deleted). */
export const disabledSql = (idExpr: string): string => `EXISTS (SELECT 1 FROM accounts dx WHERE dx.id = ${idExpr} AND dx.status = 'disabled')`;
export const notDisabledSql = (idExpr: string): string => `NOT ${disabledSql(idExpr)}`;
/** SQL boolean: the account is banned (disabled and not deleted): its posts answer 410. */
export const bannedSql = (idExpr: string): string => `EXISTS (SELECT 1 FROM accounts bx WHERE bx.id = ${idExpr} AND bx.status = 'disabled' AND bx.deleted_at IS NULL)`;
export const notBannedSql = (idExpr: string): string => `NOT ${bannedSql(idExpr)}`;

/** A post the public sees: visible and its author not banned (a deleted account's stub stays). */
export const shownPostSql = (alias: string): string => `${alias}.status = 'visible' AND ${notBannedSql(`${alias}.author_id`)}`;

/** A porch line the public sees: visible and its author not disabled. */
export const shownPorchSql = (alias: string): string => `${alias}.status = 'visible' AND ${notDisabledSql(`${alias}.author_id`)}`;

/**
 * A comment the public sees: visible, author not disabled, no hidden ancestor, on a post the public sees.
 * (A disabled citizen's comment does NOT hide the replies under it: the thread shows a "comment hidden" placeholder.)
 */
export const shownCommentSql = (alias: string): string => `${alias}.status = 'visible' AND ${notDisabledSql(`${alias}.author_id`)} AND NOT ${hiddenAncestorSql(alias)}
  AND EXISTS (SELECT 1 FROM posts vp WHERE vp.number = ${alias}.post_number AND ${shownPostSql('vp')})`;

/** A vote that counts in public numbers: its voter is not disabled. */
export const countedVoteSql = (alias: string): string => notDisabledSql(`${alias}.voter_id`);

/** Handles of deleted accounts (deleted-N, reserved at sign-up): their profile is 410, so pages never link to it. */
export const isDeletedHandle = (handle: string): boolean => /^deleted-\d+$/.test(handle);

export const POST_SELECT = `SELECT p.*, a.handle AS author_handle, a.kind AS author_kind, a.number AS author_number, s.name AS section_name,
  (SELECT group_concat(tag_slug) FROM post_tags t WHERE t.post_number = p.number) AS tags,
  (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'post' AND v.target_number = p.number AND ${countedVoteSql('v')}) AS upvotes,
  (SELECT COUNT(*) FROM comments c WHERE c.post_number = p.number AND c.status = 'visible' AND ${notDisabledSql('c.author_id')} AND NOT ${hiddenAncestorSql('c')}) AS comment_count
  FROM posts p JOIN accounts a ON a.id = p.author_id JOIN sections s ON s.slug = p.section_slug`;

export const COMMENT_SELECT = `SELECT c.*, a.handle AS author_handle, a.kind AS author_kind, a.number AS author_number,
  (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'comment' AND v.target_number = c.number AND ${countedVoteSql('v')}) AS upvotes
  FROM comments c JOIN accounts a ON a.id = c.author_id`;

export const PORCH_SELECT = `SELECT l.*, a.handle AS author_handle, a.kind AS author_kind, a.number AS author_number
  FROM porch_lines l JOIN accounts a ON a.id = l.author_id`;

type Row = Record<string, any>;

/** Canonical public profile path. `/citizens/{handle}` is a permanent 301 to this, forever. */
export const citizenPath = (handle: string) => `/c/${encodeURIComponent(handle)}`;

/** Exact public moderation log entry: the page that starts at this entry, anchored to it. */
export const moderationLogUrl = (seq: number) => `/moderation?before=${seq + 1}#mod-${seq}`;

/** Shown in place of the text of withdrawn content (pages and API). The stored title/body are empty. */
export const WITHDRAWN_TITLE = 'Withdrawn by author';
export const withdrawnText = (reason: string | null | undefined) => `${WITHDRAWN_TITLE}: ${reason ?? ''}`.trim();

/** `withdrawn` field of a post, comment or porch line: null, or when and why the author withdrew it. */
const withdrawn = (row: Row) => (row.withdrawn_at ? { at: row.withdrawn_at as string, reason: (row.withdraw_reason ?? null) as string | null } : null);

const author = (row: Row) => ({ handle: row.author_handle, kind: row.author_kind, number: row.author_number, url: citizenPath(row.author_handle) });

export const postView = (row: Row) => ({
  number: row.number,
  ref: `post-${row.number}`,
  url: `/posts/${row.number}`,
  id: row.id,
  title: row.withdrawn_at ? WITHDRAWN_TITLE : row.title,
  body: row.withdrawn_at ? withdrawnText(row.withdraw_reason) : row.body,
  section: { slug: row.section_slug, name: row.section_name },
  tags: row.tags ? String(row.tags).split(',').sort() : [],
  author: author(row),
  upvotes: row.upvotes,
  comment_count: row.comment_count,
  created_at: row.created_at,
  withdrawn: withdrawn(row),
});

export const commentView = (row: Row) => ({
  number: row.number,
  ref: `comment-${row.number}`,
  url: `/comments/${row.number}`,
  id: row.id,
  post_number: row.post_number,
  parent_number: row.parent_number ?? null,
  depth: row.depth,
  body: row.withdrawn_at ? withdrawnText(row.withdraw_reason) : row.body,
  author: author(row),
  upvotes: row.upvotes,
  created_at: row.created_at,
  withdrawn: withdrawn(row),
});

export const porchView = (row: Row) => ({
  number: row.number,
  ref: `porch-${row.number}`,
  url: `/porch/${row.number}`,
  id: row.id,
  body: row.withdrawn_at ? withdrawnText(row.withdraw_reason) : row.body,
  author: author(row),
  created_at: row.created_at,
  withdrawn: withdrawn(row),
});

export const accountView = (row: Pick<AccountRow, 'number' | 'id' | 'handle' | 'kind' | 'status' | 'created_at'>) => ({
  number: row.number,
  ref: `citizen-${row.number}`,
  url: citizenPath(row.handle),
  id: row.id,
  handle: row.handle,
  kind: row.kind,
  status: row.status,
  created_at: row.created_at,
});

// ---------- change feed visibility (GET /v1/feed public readers; Pulse activity counts in src/counters.ts)

/**
 * 1 when the event's object is currently hidden for public readers: a hidden post,
 * a hidden porch line, or a comment that is hidden itself, sits under a hidden post, or sits under a hidden comment
 * (same visibility rule as GET /v1/comments/{n}). 0 otherwise (incl. accounts, announcements).
 */
export const EVENT_OBJECT_HIDDEN = `CASE e.object_type
    WHEN 'post' THEN COALESCE((SELECT p.status = 'hidden' FROM posts p WHERE p.number = e.object_number), 0)
    WHEN 'comment' THEN COALESCE((SELECT c.status = 'hidden' OR p.status = 'hidden' OR ${hiddenAncestorSql('c')}
      FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number = e.object_number), 0)
    WHEN 'porch' THEN COALESCE((SELECT l.status = 'hidden' FROM porch_lines l WHERE l.number = e.object_number), 0)
    ELSE 0 END`;

/**
 * F1: 1 when the event's object belongs to a disabled citizen: their post (banned only: a deleted account's post stub stays) or porch
 * line, a comment they wrote or that sits on a banned citizen's post, or a banned account itself (account.deleted stays). Public readers do not get these events (moderation markers excepted).
 */
export const EVENT_OBJECT_GONE = `CASE e.object_type
    WHEN 'post' THEN COALESCE((SELECT ${bannedSql('p.author_id')} FROM posts p WHERE p.number = e.object_number), 0)
    WHEN 'comment' THEN COALESCE((SELECT ${disabledSql('c.author_id')} OR ${bannedSql('p.author_id')}
      FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number = e.object_number), 0)
    WHEN 'porch' THEN COALESCE((SELECT ${disabledSql('l.author_id')} FROM porch_lines l WHERE l.number = e.object_number), 0)
    WHEN 'account' THEN COALESCE((SELECT x.status = 'disabled' AND x.deleted_at IS NULL FROM accounts x WHERE x.number = e.object_number), 0)
    ELSE 0 END`;
