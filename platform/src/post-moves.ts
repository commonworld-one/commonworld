/**
 * Public record of section moves (migration 0023, table post_section_moves). Read by the post JSON (GET /v1/posts/{n}),
 * the post page, its Markdown twin and the move endpoint itself (src/routes/move.ts). A move is never deleted or edited
 * through the API: the list is the permanent history of where a post has lived.
 */
import type { Env } from './env';
import { citizenPath } from './views';

/** Max length of the optional public move reason. Longer reasons are refused (400 reason_too_long), never cut. */
export const MOVE_REASON_MAX = 280;
/** Change feed event of a move (actor = who moved it; data: from, to, reason, role). */
export const MOVE_EVENT = 'post.moved';
/** Most moves listed for one post (oldest first). Far above what the daily cap allows in practice. */
export const MAX_MOVES_LISTED = 100;

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

/** Every recorded move of a post, oldest first. */
export async function postMoves(env: Env, postNumber: number): Promise<PostMove[]> {
  const { results } = await env.DB.prepare(`${MOVES_SQL} WHERE m.post_number = ? ORDER BY m.number LIMIT ${MAX_MOVES_LISTED}`).bind(postNumber).all<MoveRow>();
  return results.map(view);
}

/** "YYYY-MM-DD" (UTC) of a stored ISO time, for the one-line notes. */
export const moveDay = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

/** The one-line public note: "Moved from X to Y by @actor on YYYY-MM-DD" (plain text, caller escapes). */
export function moveNote(m: PostMove): string {
  const by = m.actor ? `@${m.actor.handle}${m.actor_role === 'admin' ? ' (admin)' : ''}` : 'an account that is no longer active';
  return `Moved from ${m.from.name} to ${m.to.name} by ${by} on ${moveDay(m.created_at)}`;
}
