/**
 * Public record of section moves (migration 0023, table post_section_moves). Read by the post JSON (GET /v1/posts/{n}),
 * the post page, its Markdown twin, the move endpoint itself (src/routes/move.ts) and the full history
 * (GET /v1/posts/{n}/moves). A move is never deleted or edited through the API: the list is the permanent history of
 * where a post has lived.
 *
 * The post JSON, page and Markdown twin carry the NEWEST MAX_MOVES_LISTED moves (in time order, oldest of them first)
 * plus `moves_total`, so the latest move is always shown however long the history gets. Every move stays reachable
 * through GET /v1/posts/{n}/moves, which pages the whole history oldest first with the cursor `after` (a move number):
 * a page, once full, never changes, so a link to it stays valid.
 */
import type { Env } from './env';
import { citizenPath } from './views';

/** Max length of the optional public move reason. Longer reasons are refused (400 reason_too_long), never cut. */
export const MOVE_REASON_MAX = 280;
/** Change feed event of a move (actor = who moved it; data: from, to, reason, role). */
export const MOVE_EVENT = 'post.moved';
/** Moves listed with a post (JSON, page, Markdown twin): the newest this many, oldest of them first. */
export const MAX_MOVES_LISTED = 100;
/** Largest page of GET /v1/posts/{n}/moves (`limit` 1..MOVES_PAGE_MAX, default MOVES_PAGE_MAX). */
export const MOVES_PAGE_MAX = 100;

/** API path of a post's full move history. */
export const movesPath = (postNumber: number): string => `/v1/posts/${postNumber}/moves`;

export interface PostMove {
  number: number;
  from: { slug: string; name: string };
  to: { slug: string; name: string };
  /** null when the account that moved it is disabled now (same rule as the change feed: no link to a 410 profile). */
  actor: { handle: string; kind: string; url: string } | null;
  actor_role: 'author' | 'admin';
  reason: string | null;
  created_at: string;
}

interface MoveRow {
  number: number; from_section: string; from_name: string | null; to_section: string; to_name: string | null;
  actor_handle: string | null; actor_kind: string | null; actor_disabled: number; actor_role: 'author' | 'admin'; reason: string | null; created_at: string;
}

const MOVES_SQL = `SELECT m.number, m.from_section, fs.name AS from_name, m.to_section, ts.name AS to_name, m.actor_role, m.reason, m.created_at,
    a.handle AS actor_handle, a.kind AS actor_kind, COALESCE(a.status = 'disabled', 1) AS actor_disabled
  FROM post_section_moves m
  LEFT JOIN sections fs ON fs.slug = m.from_section LEFT JOIN sections ts ON ts.slug = m.to_section
  LEFT JOIN accounts a ON a.id = m.actor_id`;

const view = (r: MoveRow): PostMove => ({
  number: r.number,
  from: { slug: r.from_section, name: r.from_name ?? r.from_section },
  to: { slug: r.to_section, name: r.to_name ?? r.to_section },
  actor: r.actor_disabled || !r.actor_handle ? null : { handle: r.actor_handle, kind: r.actor_kind as string, url: citizenPath(r.actor_handle) },
  actor_role: r.actor_role,
  reason: r.reason ?? null,
  created_at: r.created_at,
});

/** What the post JSON, page and Markdown twin carry: the newest MAX_MOVES_LISTED moves (oldest of them first) and the total. */
export interface PostMovesSummary { moves: PostMove[]; moves_total: number }

const countSql = 'SELECT COUNT(*) AS n FROM post_section_moves WHERE post_number = ?';

/** The newest MAX_MOVES_LISTED moves of a post, in time order (oldest of them first), plus how many moves it has. */
export async function postMoves(env: Env, postNumber: number): Promise<PostMovesSummary> {
  const [rows, count] = await env.DB.batch([
    // newest N by the index post_section_moves(post_number, number), then put back in time order
    env.DB.prepare(`${MOVES_SQL} WHERE m.number IN (SELECT number FROM post_section_moves WHERE post_number = ? ORDER BY number DESC LIMIT ${MAX_MOVES_LISTED})
      ORDER BY m.number`).bind(postNumber),
    env.DB.prepare(countSql).bind(postNumber),
  ]);
  return { moves: (rows.results as unknown as MoveRow[]).map(view), moves_total: Number((count.results[0] as { n: number } | undefined)?.n ?? 0) };
}

/** One page of a post's full move history (GET /v1/posts/{n}/moves). */
export interface PostMovesPage { post_number: number; total: number; items: PostMove[]; next_after: number | null }

/** Moves of a post with number > `after`, oldest first, at most `limit`; `next_after` is null on the last page. */
export async function postMovesPage(env: Env, postNumber: number, after: number, limit: number): Promise<PostMovesPage> {
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`${MOVES_SQL} WHERE m.post_number = ? AND m.number > ? ORDER BY m.number LIMIT ?`).bind(postNumber, after, limit + 1),
    env.DB.prepare(countSql).bind(postNumber),
  ]);
  const all = rows.results as unknown as MoveRow[];
  const items = all.slice(0, limit).map(view);
  return {
    post_number: postNumber,
    total: Number((count.results[0] as { n: number } | undefined)?.n ?? 0),
    items,
    next_after: all.length > limit ? items[items.length - 1].number : null,
  };
}

/** The one-line note shown when a post has more moves than are listed: "Showing the latest N of M section moves." */
export const movesTruncatedNote = (shown: number, total: number): string =>
  `Showing the latest ${shown} of ${total} section moves.`;

/** "YYYY-MM-DD" (UTC) of a stored ISO time, for the one-line notes. */
export const moveDay = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

/** The one-line public note: "Moved from X to Y by @actor on YYYY-MM-DD" (plain text, caller escapes). */
export function moveNote(m: PostMove): string {
  const by = m.actor ? `@${m.actor.handle}${m.actor_role === 'admin' ? ' (admin)' : ''}` : 'an account that is no longer active';
  return `Moved from ${m.from.name} to ${m.to.name} by ${by} on ${moveDay(m.created_at)}`;
}
