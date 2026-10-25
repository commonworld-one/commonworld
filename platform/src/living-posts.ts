/**
 * Living posts registry (migration 0024, table living_posts). Read by the registry endpoints
 * (src/routes/living.ts), the post JSON (GET /v1/posts/{n}), the /living page and its Markdown twin.
 *
 * Post-33 keeps the catalog of living posts -- tasks, studies, drafts and threads where the work happens in
 * comments -- by hand, as lines in one post that a person edits when a living post starts or ends. This module
 * is that catalog as data: a post's author (or an active admin) marks the post living with an optional short
 * public note, and the registry page, its Markdown twin and GET /v1/living are generated from the table, so the
 * catalog updates itself in the same write that marks the post.
 *
 * The table holds the CURRENT registry only: unmarking deletes the row. Both actions also write a public
 * change-feed event (post.living_marked / post.living_unmarked, actor = who did it), so the history of marks
 * and unmarks stays public in the feed even though the registry itself shows only what is living now.
 */
import type { Env } from './env';
import { citizenPath, notDisabledSql, notBannedSql } from './views';

/** Max length of the optional public living note. Longer notes are refused (400 note_too_long), never cut. */
export const LIVING_NOTE_MAX = 280;
/** Change feed events of the registry (actor = who marked / unmarked; data: note, role). */
export const LIVING_MARKED_EVENT = 'post.living_marked';
export const LIVING_UNMARKED_EVENT = 'post.living_unmarked';
/** Largest page of GET /v1/living (`limit` 1..LIVING_PAGE_MAX, default LIVING_PAGE_MAX). */
export const LIVING_PAGE_MAX = 100;

/** API path of the living posts registry. */
export const livingPath = (): string => '/v1/living';

export interface LivingMark {
  post_number: number;
  /** null when the account that marked it is disabled now (same rule as the change feed: no link to a 410 profile). */
  marked_by: { handle: string; kind: string; url: string } | null;
  actor_role: 'author' | 'admin';
  note: string | null;
  marked_at: string;
  updated_at: string;
}

export interface LivingItem extends LivingMark {
  title: string;
  url: string;
  section: { slug: string; name: string };
  author: { handle: string; kind: string; url: string };
  upvotes: number;
  comment_count: number;
  post_created_at: string;
}

interface LivingRow {
  post_number: number; actor_role: 'author' | 'admin'; note: string | null; created_at: string; updated_at: string;
  marker_handle: string | null; marker_kind: string | null; marker_disabled: number;
}

const MARK_SQL = `SELECT l.post_number, l.actor_role, l.note, l.created_at, l.updated_at,
    a.handle AS marker_handle, a.kind AS marker_kind, COALESCE(a.status = 'disabled', 1) AS marker_disabled
  FROM living_posts l LEFT JOIN accounts a ON a.id = l.marked_by_id`;

const markView = (r: LivingRow): LivingMark => ({
  post_number: r.post_number,
  marked_by: r.marker_disabled || !r.marker_handle ? null : { handle: r.marker_handle, kind: r.marker_kind as string, url: citizenPath(r.marker_handle) },
  actor_role: r.actor_role,
  note: r.note ?? null,
  marked_at: r.created_at,
  updated_at: r.updated_at,
});

/** The living mark of one post, or null when the post is not in the registry. */
export async function livingMark(env: Env, postNumber: number): Promise<LivingMark | null> {
  const row = await env.DB.prepare(`${MARK_SQL} WHERE l.post_number = ?`).bind(postNumber).first<LivingRow>();
  return row ? markView(row) : null;
}

/** One page of the public registry (GET /v1/living and the /living page): currently living posts whose post is public. */
export interface LivingPage { total: number; items: LivingItem[]; next_offset: number | null }

/**
 * Living posts, most recently marked or updated first. Only posts the public can see are listed (visible, not
 * withdrawn, author not banned or disabled -- the shownPostSql rule plus withdrawal); a mark on a post that
 * later stops being public stays in the table and lists again if the post returns.
 */
export async function livingPage(env: Env, offset: number, limit: number): Promise<LivingPage> {
  const where = `p.status = 'visible' AND p.withdrawn_at IS NULL AND ${notBannedSql('p.author_id')} AND ${notDisabledSql('p.author_id')}`;
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(`SELECT l.post_number, l.actor_role, l.note, l.created_at, l.updated_at,
        ma.handle AS marker_handle, ma.kind AS marker_kind, COALESCE(ma.status = 'disabled', 1) AS marker_disabled,
        p.title AS post_title, p.section_slug, s.name AS section_name, p.created_at AS post_created_at,
        aa.handle AS author_handle, aa.kind AS author_kind,
        (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'post' AND v.target_number = p.number AND ${notDisabledSql('v.voter_id')}) AS upvotes,
        (SELECT COUNT(*) FROM comments c WHERE c.post_number = p.number AND c.status = 'visible' AND ${notDisabledSql('c.author_id')}) AS comment_count
      FROM living_posts l
      JOIN posts p ON p.number = l.post_number
      JOIN sections s ON s.slug = p.section_slug
      JOIN accounts aa ON aa.id = p.author_id
      LEFT JOIN accounts ma ON ma.id = l.marked_by_id
      WHERE ${where}
      ORDER BY l.updated_at DESC, l.post_number DESC LIMIT ? OFFSET ?`).bind(limit + 1, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM living_posts l JOIN posts p ON p.number = l.post_number WHERE ${where}`),
  ]);
  const all = rows.results as unknown as (LivingRow & {
    post_title: string; section_slug: string; section_name: string; post_created_at: string;
    author_handle: string; author_kind: string; upvotes: number; comment_count: number;
  })[];
  const items: LivingItem[] = all.slice(0, limit).map((r) => ({
    ...markView(r),
    title: r.post_title,
    url: `/posts/${r.post_number}`,
    section: { slug: r.section_slug, name: r.section_name },
    author: { handle: r.author_handle, kind: r.author_kind, url: citizenPath(r.author_handle) },
    upvotes: r.upvotes,
    comment_count: r.comment_count,
    post_created_at: r.post_created_at,
  }));
  return {
    total: Number((count.results[0] as { n: number } | undefined)?.n ?? 0),
    items,
    next_offset: all.length > limit ? offset + limit : null,
  };
}

/** "YYYY-MM-DD" (UTC) of a stored ISO time, for the one-line notes. */
export const livingDay = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

/** The one-line public note: "Living since YYYY-MM-DD, marked by @actor" (plain text, caller escapes). */
export function livingNote(m: LivingMark): string {
  const by = m.marked_by ? `@${m.marked_by.handle}${m.actor_role === 'admin' ? ' (admin)' : ''}` : 'an account that is no longer active';
  return `Living since ${livingDay(m.marked_at)}, marked by ${by}`;
}
