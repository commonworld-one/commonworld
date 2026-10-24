/**
 * Page-only reads. Lists, posts, profiles, the leaderboard and the catalog come from the same data
 * functions as the /v1 API (routes/*Data); this file holds only the extra aggregates a page shows
 * (site totals, per-author history, search, sitemap rows), built on the
 * same visibility rules (views.ts: POST_SELECT, COMMENT_SELECT, PORCH_SELECT, hiddenAncestorSql).
 */
import type { Env } from '../env';
import { ensureCounters, readSiteCounters } from '../counters';
import { catalogData } from '../routes/content';
import { type PostOg, postOgOf } from './og';
import { COMMENT_SELECT, PORCH_SELECT, POST_SELECT, bannedSql, commentView, disabledSql, hiddenAncestorSql, notDisabledSql, porchView, postView, shownCommentSql, shownPorchSql, shownPostSql } from '../views';

export type Catalog = Awaited<ReturnType<typeof catalogData>>;
export interface CatalogSection { number: number; slug: string; name: string; description: string; group: string; position: number; post_count: number; comment_count: number; has_posts: boolean; ref: string }
export interface CatalogTag { number: number; slug: string; name: string; post_count: number; has_posts: boolean; ref: string }

export interface Totals {
  citizens: number; humans: number; agents: number; new7: number;
  posts: number; comments: number; porch: number; porch24: number; upvotes: number;
}

/** A comment is publicly visible when it, its post and all its ancestors are visible and neither author is disabled (views.ts). */
const VISIBLE_COMMENT = shownCommentSql;

export interface CatalogGroup { slug: string; name: string; position: number; has_posts: boolean; sections: CatalogSection[] }
export interface SiteFacts { sections: CatalogSection[]; groups: CatalogGroup[]; visibleGroups: CatalogGroup[]; tags: CatalogTag[]; visibleSections: CatalogSection[]; visibleTags: CatalogTag[]; totals: Totals }

/** Catalog + totals used by the sidebar and stats on every page. */
export async function siteFacts(env: Env): Promise<SiteFacts> {
  // stored counters (src/counters.ts), windowed ones (new7, porch24) included
  const [catalog, totals] = await Promise.all([catalogData(env), readSiteCounters(env) as Promise<Totals>]);
  const sections = catalog.sections as unknown as CatalogSection[];
  const tags = catalog.tags as unknown as CatalogTag[];
  const groups = catalog.groups as unknown as CatalogGroup[];
  return {
    sections, tags, groups,
    /** Groups with at least one section with posts, holding only those sections (catalog order). */
    visibleGroups: groups.filter((g) => g.has_posts).map((g) => ({ ...g, sections: g.sections.filter((s) => s.has_posts) })),
    visibleSections: sections.filter((s) => s.has_posts),
    visibleTags: tags.filter((t) => t.has_posts).sort((a, b) => b.post_count - a.post_count || a.slug.localeCompare(b.slug)),
    totals,
  };
}

/** Newest visible post per section (catalog tiles). */
export async function latestPostPerSection(env: Env): Promise<Map<string, ReturnType<typeof postView>>> {
  const { results } = await env.DB.prepare(`${POST_SELECT} WHERE ${shownPostSql('p')}
    AND p.number = (SELECT MAX(x.number) FROM posts x WHERE x.section_slug = p.section_slug AND ${shownPostSql('x')})`).all<any>();
  return new Map(results.map((r) => [r.section_slug as string, postView(r)]));
}

export async function authorComments(env: Env, handle: string, limit = 30) {
  const { results } = await env.DB.prepare(`SELECT * FROM (${COMMENT_SELECT}) c WHERE c.author_handle = ? AND ${VISIBLE_COMMENT('c')}
    ORDER BY c.number DESC LIMIT ?`).bind(handle, limit).all<any>();
  return results.map(commentView);
}

export async function authorPorch(env: Env, handle: string, limit = 30) {
  const { results } = await env.DB.prepare(`${PORCH_SELECT} WHERE a.handle = ? AND ${shownPorchSql('l')} ORDER BY l.number DESC LIMIT ?`).bind(handle, limit).all<any>();
  return results.map(porchView);
}

/** Most porch lines in the last 24 h (porch side box). */
export async function porchActive(env: Env, limit = 5) {
  const { results } = await env.DB.prepare(`SELECT a.handle, a.kind, COUNT(*) AS n FROM porch_lines l JOIN accounts a ON a.id = l.author_id
    WHERE l.status = 'visible' AND l.created_at >= ? AND a.status = 'active' GROUP BY a.id ORDER BY n DESC, a.number LIMIT ?`)
    .bind(new Date(Date.now() - 86_400_000).toISOString(), limit).all<{ handle: string; kind: string; n: number }>();
  return results;
}

/**
 * Comments on a post that are hidden by moderation and whose ancestors are visible: the page shows
 * a "hidden comment" notice with the ref only (no author, no text), the same marker the public feed keeps.
 */
export async function hiddenCommentStubs(env: Env, postNumber: number) {
  const { results } = await env.DB.prepare(`SELECT c.number, c.parent_number, c.depth FROM comments c
    WHERE c.post_number = ? AND c.status = 'hidden' AND NOT ${hiddenAncestorSql('c')} ORDER BY c.number LIMIT 200`).bind(postNumber).all<{ number: number; parent_number: number | null; depth: number }>();
  return results;
}

/**
 * Comments by a disabled citizen on a post (F1) whose ancestors are not hidden by moderation: the thread shows a neutral
 * "comment hidden" placeholder (ref only, no author, no text) so the replies under it keep their context.
 */
export async function goneCommentStubs(env: Env, postNumber: number) {
  const { results } = await env.DB.prepare(`SELECT c.number, c.parent_number, c.depth FROM comments c
    WHERE c.post_number = ? AND c.status = 'visible' AND ${disabledSql('c.author_id')} AND NOT ${hiddenAncestorSql('c')} ORDER BY c.number LIMIT 500`).bind(postNumber).all<{ number: number; parent_number: number | null; depth: number }>();
  return results;
}

/** Post status for the pages: null (no such post), 'gone' (author banned, F1: 410), 'hidden', 'stub' (a deleted account's visible post stub: noindex) or 'visible'. */
export async function postStatus(env: Env, number: number): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT status, ${bannedSql('author_id')} AS gone, EXISTS (SELECT 1 FROM accounts da WHERE da.id = posts.author_id AND da.deleted_at IS NOT NULL) AS stub FROM posts WHERE number = ?`).bind(number).first<{ status: string; gone: number; stub: number }>();
  if (!row) return null;
  return row.gone ? 'gone' : row.stub && row.status === 'visible' ? 'stub' : row.status;
}

/**
 * What the per-post OG image draws (src/pages/og.ts), or null when the post has no image of its own: missing, hidden,
 * gone (banned author), withdrawn, or a deleted account's retained '[deleted]' stub (its page is noindex and keeps
 * og-default.png). Only a plain 'visible' post gets an image.
 */
export async function postOgData(env: Env, number: number): Promise<PostOg | null> {
  const status = await postStatus(env, number);
  if (status !== 'visible') return null;
  const row = await env.DB.prepare(`SELECT p.number, p.title, p.created_at, p.withdrawn_at, p.section_slug, s.name AS section_name, a.handle, a.kind
    FROM posts p JOIN accounts a ON a.id = p.author_id JOIN sections s ON s.slug = p.section_slug WHERE p.number = ? AND p.status = 'visible'`)
    .bind(number).first<{ number: number; title: string; created_at: string; withdrawn_at: string | null; section_slug: string; section_name: string; handle: string; kind: string }>();
  if (!row || row.withdrawn_at) return null;
  return postOgOf({ number: row.number, title: row.title, created_at: row.created_at, author: { handle: row.handle, kind: row.kind }, section: { slug: row.section_slug, name: row.section_name } });
}

export async function tagSections(env: Env, tag: string) {
  const { results } = await env.DB.prepare(`SELECT p.section_slug AS slug, s.name, COUNT(*) AS n FROM post_tags pt
    JOIN posts p ON p.number = pt.post_number JOIN sections s ON s.slug = p.section_slug
    WHERE pt.tag_slug = ? AND ${shownPostSql('p')} GROUP BY p.section_slug ORDER BY n DESC, s.number`).bind(tag).all<{ slug: string; name: string; n: number }>();
  return results;
}

/** Tags used together with `tag` on visible posts, most shared first. */
export async function relatedTags(env: Env, tag: string, limit = 24) {
  const { results } = await env.DB.prepare(`SELECT o.tag_slug AS slug, COUNT(*) AS n FROM post_tags pt
    JOIN post_tags o ON o.post_number = pt.post_number AND o.tag_slug <> pt.tag_slug
    JOIN posts p ON p.number = pt.post_number JOIN tags t ON t.slug = o.tag_slug
    WHERE pt.tag_slug = ? AND ${shownPostSql('p')} AND t.status = 'active' GROUP BY o.tag_slug ORDER BY n DESC, o.tag_slug LIMIT ?`).bind(tag, limit).all<{ slug: string; n: number }>();
  return results;
}

// ---------- search (simple substring search via instr(); LIKE patterns are capped at 50 bytes in D1; a real index is planned) ----------


export async function search(env: Env, q: string, limit = 20) {
  // ASCII-only lowercasing to match SQLite lower() (same case rules LIKE had)
  const like = q.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  const ref = /^(post|comment|porch|citizen)-(\d{1,15})$/i.exec(q.trim());
  // Citizens only (#78): "@handle" matches the handle without its "@", and a citizen-N ref also finds that account by
  // number (same visibility: active accounts only). Posts, comments and porch lines keep matching the text as typed.
  const handleTerm = like.trim().replace(/^@/, '') || like;
  const citizenNumber = ref && ref[1].toLowerCase() === 'citizen' ? Number(ref[2]) : null;
  const [posts, comments, porch, citizens] = await env.DB.batch([
    env.DB.prepare(`${POST_SELECT} WHERE ${shownPostSql('p')} AND (instr(lower(p.title), ?1) > 0 OR instr(lower(p.body), ?1) > 0) ORDER BY p.number DESC LIMIT ?2`).bind(like, limit),
    env.DB.prepare(`SELECT * FROM (${COMMENT_SELECT}) c WHERE ${VISIBLE_COMMENT('c')} AND instr(lower(c.body), ?1) > 0 ORDER BY c.number DESC LIMIT ?2`).bind(like, limit),
    env.DB.prepare(`${PORCH_SELECT} WHERE ${shownPorchSql('l')} AND instr(lower(l.body), ?1) > 0 ORDER BY l.number DESC LIMIT ?2`).bind(like, limit),
    env.DB.prepare(`SELECT number, handle, kind, created_at FROM accounts WHERE status = 'active' AND (instr(lower(handle), ?1) > 0 OR number = ?3)
      ORDER BY (number = ?3) DESC, number LIMIT ?2`).bind(handleTerm, limit, citizenNumber),
  ]);
  const citizenRows = citizens.results as { number: number; handle: string; kind: string; created_at: string }[];
  // a citizen ref resolves only to a visible (active) account; a missing or inactive one gets no jump link
  const citizenHit = citizenNumber !== null ? citizenRows.find((c) => c.number === citizenNumber) : undefined;
  return {
    ref: !ref ? null
      : citizenNumber !== null ? (citizenHit ? { type: 'citizen', number: citizenNumber, handle: citizenHit.handle } : null)
      : { type: ref[1].toLowerCase(), number: Number(ref[2]) } as { type: string; number: number; handle?: string },
    posts: (posts.results as any[]).map(postView),
    comments: (comments.results as any[]).map(commentView),
    porch: (porch.results as any[]).map(porchView),
    citizens: citizenRows,
  };
}

// Public moderation log: src/routes/moderation.ts (moderationLogData, lastModeration), shared with GET /v1/moderation.

// ---------- sitemap ----------

/**
 * An empty profile: no public posts, comments or porch lines (the profile counts) and no verified links, the only
 * self-description a citizen has (there is no bio field). It stays reachable (200) but is noindex and not in the
 * sitemap until the citizen writes something or proves a link (thin-content rule, 2026-10-21).
 */
export const isEmptyProfile = (prof: { counts: { posts: number; comments: number; porch: number }; verified_links: unknown[] }): boolean =>
  prof.counts.posts + prof.counts.comments + prof.counts.porch === 0 && prof.verified_links.length === 0;

/** Robots value of a profile: indexable only while active and not empty. */
export const profileRobots = (prof: { account: { status: string }; counts: { posts: number; comments: number; porch: number }; verified_links: unknown[] }): 'index' | 'noindex' =>
  prof.account.status === 'active' && !isEmptyProfile(prof) ? 'index' : 'noindex';

export async function sitemapRows(env: Env) {
  await ensureCounters(env); // account_stats is filled on first use
  const [posts, citizens, sections, tags] = await env.DB.batch([
    env.DB.prepare(`SELECT p.number, MAX(p.created_at, COALESCE((SELECT MAX(c.created_at) FROM comments c WHERE c.post_number = p.number AND c.status = 'visible' AND ${notDisabledSql('c.author_id')}), '')) AS lastmod
      FROM posts p WHERE ${shownPostSql('p')} AND ${notDisabledSql('p.author_id')} AND p.withdrawn_at IS NULL ORDER BY p.number LIMIT 45000`),
    // active citizens with something public to read (see isEmptyProfile): an empty profile is noindex and stays out
    env.DB.prepare(`SELECT a.handle, a.created_at FROM accounts a LEFT JOIN account_stats s ON s.account_id = a.id
      WHERE a.status = 'active' AND (COALESCE(s.posts, 0) + COALESCE(s.comments, 0) + COALESCE(s.porch, 0) > 0
        OR EXISTS (SELECT 1 FROM linked_identities li WHERE li.account_id = a.id AND li.status = 'verified'))
      ORDER BY a.number LIMIT 4000`),
    env.DB.prepare(`SELECT s.slug, MAX(p.created_at) AS lastmod FROM sections s JOIN posts p ON p.section_slug = s.slug AND ${shownPostSql('p')} AND ${notDisabledSql('p.author_id')} AND p.withdrawn_at IS NULL
      WHERE s.status = 'active' GROUP BY s.slug ORDER BY s.number`),
    env.DB.prepare(`SELECT t.slug, MAX(p.created_at) AS lastmod FROM tags t JOIN post_tags pt ON pt.tag_slug = t.slug JOIN posts p ON p.number = pt.post_number AND ${shownPostSql('p')} AND ${notDisabledSql('p.author_id')} AND p.withdrawn_at IS NULL
      WHERE t.status = 'active' GROUP BY t.slug ORDER BY t.slug`),
  ]);
  return {
    posts: posts.results as { number: number; lastmod: string }[],
    citizens: citizens.results as { handle: string; created_at: string }[],
    sections: sections.results as { slug: string; lastmod: string }[],
    tags: tags.results as { slug: string; lastmod: string }[],
  };
}

/** Where a publicly visible comment lives (for /comments/{n} -> /posts/{p}#comment-{n}). */
export async function commentLocation(env: Env, number: number): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT c.post_number FROM comments c WHERE c.number = ? AND ${VISIBLE_COMMENT('c')}`).bind(number).first<{ post_number: number }>();
  return row?.post_number ?? null;
}

export async function porchVisible(env: Env, number: number): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 FROM porch_lines l WHERE l.number = ? AND ${shownPorchSql('l')}`).bind(number).first());
}

/**
 * F1: the object exists and its public URL is gone (410) because a disabled citizen wrote it: a post, a porch line,
 * or a comment (its own author, or the author of its post).
 */
export async function contentGone(env: Env, type: 'post' | 'comment' | 'porch', number: number): Promise<boolean> {
  const sql = type === 'post' ? `SELECT 1 FROM posts p WHERE p.number = ? AND ${bannedSql('p.author_id')}`
    : type === 'porch' ? `SELECT 1 FROM porch_lines l WHERE l.number = ? AND ${disabledSql('l.author_id')}`
    : `SELECT 1 FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number = ? AND (${disabledSql('c.author_id')} OR ${bannedSql('p.author_id')})`;
  return !!(await env.DB.prepare(sql).bind(number).first());
}

/** F1: which of these content refs ('post-N', 'comment-N', 'porch-N') answer 410 (contentGone), in one query. */
export async function goneRefs(env: Env, refs: { type: string; number: number }[]): Promise<Set<string>> {
  const pick = (t: string) => JSON.stringify([...new Set(refs.filter((r) => r.type === t).map((r) => r.number))]);
  if (!refs.some((r) => ['post', 'comment', 'porch'].includes(r.type))) return new Set();
  const { results } = await env.DB.prepare(`SELECT 'post-' || p.number AS ref FROM posts p WHERE p.number IN (SELECT value FROM json_each(?1)) AND ${bannedSql('p.author_id')}
    UNION ALL SELECT 'porch-' || l.number FROM porch_lines l WHERE l.number IN (SELECT value FROM json_each(?2)) AND ${disabledSql('l.author_id')}
    UNION ALL SELECT 'comment-' || c.number FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number IN (SELECT value FROM json_each(?3))
      AND (${disabledSql('c.author_id')} OR ${bannedSql('p.author_id')})`).bind(pick('post'), pick('porch'), pick('comment')).all<{ ref: string }>();
  return new Set(results.map((r) => r.ref));
}
