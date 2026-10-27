/**
 * Paged public voter lists (#114): GET /v1/posts/{n}/voters and GET /v1/comments/{n}/voters.
 *
 * The post JSON keeps its capped lists (the post's oldest 500 voters, each comment's oldest 100); `voters_next` on the
 * post and on each comment points here when the list was cut. Order: the time of the vote, then the voter's account
 * number, the same order as the capped lists, so the paged list continues exactly where the capped one stops.
 *
 * The cursor is the (vote time, voter account number) pair of the last voter on the page, sent back as one opaque
 * string `after`. The pair is unique per target (one vote per account and target) and never changes (votes are never
 * edited; there is no unvote), so ties on the time cannot skip or repeat a voter, and a new vote, stamped with the
 * current time, lands after the last page. A voter whose account is disabled during a walk drops out of later pages
 * (disabled voters are not listed and not counted), the cursor stays valid.
 */
import type { Env } from './env';
import { HttpError } from './http';
import { citizenPath } from './views';

/** Largest page of a voter list (`limit` 1..VOTERS_PAGE_MAX, default VOTERS_PAGE_MAX). */
export const VOTERS_PAGE_MAX = 100;

export interface VoteKey { at: string; n: number }
export interface PagedVoter { handle: string; kind: string; url: string }
export interface VotersPage { target: string; total: number; items: PagedVoter[]; next_voters_after: string | null }

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

/** Opaque cursor of a vote: base64url("<created_at>|<voter account number>"). */
export const encodeVoteCursor = (k: VoteKey): string => b64url(`${k.at}|${k.n}`);

export function decodeVoteCursor(raw: string): VoteKey {
  const bad = () => new HttpError(400, 'invalid_query_parameter', { parameter: 'after', reason: 'not_a_voter_cursor' });
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(raw)) throw bad();
  let text: string;
  try { text = unb64url(raw); } catch { throw bad(); }
  const m = /^([\x20-\x7e]{1,80})\|(\d{1,15})$/.exec(text);
  if (!m) throw bad();
  return { at: m[1], n: Number(m[2]) };
}

/** API path of a target's voter list after `cursor`. */
export const votersPath = (type: 'post' | 'comment', number: number): string => `/v1/${type === 'post' ? 'posts' : 'comments'}/${number}/voters`;
export const votersNextPath = (type: 'post' | 'comment', number: number, cursor: string): string => `${votersPath(type, number)}?after=${cursor}`;

/**
 * Voters of one post or comment after `after` (null = from the oldest vote), at most `limit`, plus the counted total
 * (the target's `upvotes`). Disabled voters are neither listed nor counted (F1). Reads the target's votes through the
 * votes primary key (target_type, target_number, voter_id).
 */
export async function votersPage(env: Env, type: 'post' | 'comment', number: number, after: VoteKey | null, limit: number): Promise<VotersPage> {
  const keyset = after ? 'AND (v.created_at > ? OR (v.created_at = ? AND a.number > ?))' : '';
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`SELECT a.handle, a.kind, a.number, v.created_at FROM votes v JOIN accounts a ON a.id = v.voter_id
      WHERE v.target_type = ? AND v.target_number = ? AND a.status <> 'disabled' ${keyset}
      ORDER BY v.created_at, a.number LIMIT ?`).bind(type, number, ...(after ? [after.at, after.at, after.n] : []), limit + 1),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM votes v JOIN accounts a ON a.id = v.voter_id
      WHERE v.target_type = ? AND v.target_number = ? AND a.status <> 'disabled'`).bind(type, number),
  ]);
  const all = rows.results as { handle: string; kind: string; number: number; created_at: string }[];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  return {
    target: `${type}-${number}`,
    total: Number((count.results[0] as { n: number } | undefined)?.n ?? 0),
    items: page.map((v) => ({ handle: v.handle, kind: v.kind, url: citizenPath(v.handle) })),
    next_voters_after: all.length > limit && last ? encodeVoteCursor({ at: last.created_at, n: last.number }) : null,
  };
}
