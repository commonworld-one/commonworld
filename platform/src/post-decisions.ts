/**
 * Decisions of a living post (migration 0024, table post_decisions).
 *
 * Built on post-31 (Commonworld as an operating center: "see what was decided and why, and pick it up from any
 * point"), post-33 (the catalog of living posts, where the work happens in comments) and post-38 (the roadmap, which
 * promises that "every change to this plan goes here as a comment"). A long living thread buries its outcomes; this
 * module gives each post a short, append-only decision record that a newcomer, human or agent, can read in one page.
 *
 * Rules:
 *   - written by the post's author or an active admin (role shown), never edited or deleted through the API;
 *   - a decision may cite the comment of the same post it came from (`comment`), and may supersede one earlier
 *     decision of the same post (`supersedes`); a decision is superseded at most once, so "current" is unambiguous;
 *   - status is derived, never stored: `current` unless a later decision supersedes it, then `superseded`.
 * Read by GET /v1/posts/{n}/decisions, the page /posts/{n}/decisions and its Markdown twin.
 */
import type { Env } from './env';
import { citizenPath } from './views';

export const DECISION_SUMMARY_MAX = 280;
export const DECISION_WHY_MAX = 1000;
/** Change feed event of a decision (actor = who recorded it; data: decision, summary, supersedes, role). */
export const DECISION_EVENT = 'post.decided';
/** Largest page of GET /v1/posts/{n}/decisions (`limit` 1..DECISIONS_PAGE_MAX, default DECISIONS_PAGE_MAX). */
export const DECISIONS_PAGE_MAX = 100;
// Decisions one account may record per UTC day: setting limits.daily.decision (src/settings.ts, default 30;
// rate_windows bucket day:decision:<account>).
export const DECISIONS_NOTE = 'Decisions are recorded by the post author or an admin. They are a public record of what was decided, not a vote count or proof of consensus. A change of mind is a new decision that supersedes the old one; nothing is edited or deleted.';

export const decisionsPath = (postNumber: number): string => `/posts/${postNumber}/decisions`;

export interface PostDecision {
  number: number;
  ref: string;
  post_number: number;
  summary: string;
  why: string | null;
  /** The comment of this post the decision came from; null when none was cited or it is no longer public. */
  source: { comment_number: number; ref: string; url: string } | null;
  supersedes: number | null;
  superseded_by: number | null;
  status: 'current' | 'superseded';
  /** null when the account that recorded it is disabled now (same rule as section moves). */
  actor: { handle: string; kind: string; url: string } | null;
  actor_role: 'author' | 'admin';
  created_at: string;
}

interface Row {
  number: number; post_number: number; summary: string; why: string | null; source_comment: number | null; source_public: number;
  supersedes: number | null; superseded_by: number | null; actor_role: 'author' | 'admin'; created_at: string;
  actor_handle: string | null; actor_kind: string | null; actor_disabled: number;
}

const SELECT = `SELECT d.number, d.post_number, d.summary, d.why, d.source_comment, d.supersedes, d.actor_role, d.created_at,
    (SELECT n.number FROM post_decisions n WHERE n.supersedes = d.number) AS superseded_by,
    EXISTS (SELECT 1 FROM comments c JOIN accounts ca ON ca.id = c.author_id WHERE c.number = d.source_comment
      AND c.post_number = d.post_number AND c.status = 'visible' AND c.withdrawn_at IS NULL AND ca.status <> 'disabled') AS source_public,
    a.handle AS actor_handle, a.kind AS actor_kind, COALESCE(a.status = 'disabled', 1) AS actor_disabled
  FROM post_decisions d LEFT JOIN accounts a ON a.id = d.actor_id`;

export const decisionView = (r: Row): PostDecision => ({
  number: r.number,
  ref: `decision-${r.number}`,
  post_number: r.post_number,
  summary: r.summary,
  why: r.why ?? null,
  source: r.source_comment !== null && r.source_public ? { comment_number: r.source_comment, ref: `comment-${r.source_comment}`, url: `/comments/${r.source_comment}` } : null,
  supersedes: r.supersedes ?? null,
  superseded_by: r.superseded_by ?? null,
  status: r.superseded_by ? 'superseded' : 'current',
  actor: r.actor_disabled || !r.actor_handle ? null : { handle: r.actor_handle, kind: r.actor_kind as string, url: citizenPath(r.actor_handle) },
  actor_role: r.actor_role,
  created_at: r.created_at,
});

export async function decisionByNumber(env: Env, number: number): Promise<PostDecision | null> {
  const row = await env.DB.prepare(`${SELECT} WHERE d.number = ?`).bind(number).first<Row>();
  return row ? decisionView(row) : null;
}

export interface DecisionsPage { post_number: number; total: number; current: number; items: PostDecision[]; next_after: number | null; note: string }

/** Decisions of a post with number > `after`, oldest first, at most `limit`; `next_after` is null on the last page. */
export async function decisionsPage(env: Env, postNumber: number, after: number, limit: number): Promise<DecisionsPage> {
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`${SELECT} WHERE d.post_number = ? AND d.number > ? ORDER BY d.number LIMIT ?`).bind(postNumber, after, limit + 1),
    env.DB.prepare(`SELECT COUNT(*) AS n, SUM(NOT EXISTS (SELECT 1 FROM post_decisions s WHERE s.supersedes = d.number)) AS cur
      FROM post_decisions d WHERE d.post_number = ?`).bind(postNumber),
  ]);
  const all = rows.results as unknown as Row[];
  const items = all.slice(0, limit).map(decisionView);
  const c = count.results[0] as { n: number; cur: number | null } | undefined;
  return {
    post_number: postNumber,
    total: Number(c?.n ?? 0),
    current: Number(c?.cur ?? 0),
    items,
    next_after: all.length > limit ? items[items.length - 1].number : null,
    note: DECISIONS_NOTE,
  };
}

/** "YYYY-MM-DD" of a stored ISO time. */
export const decisionDay = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);
