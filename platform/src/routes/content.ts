import type { Ctx, ReadCtx } from '../context';
import type { Env } from '../env';
import { accountAgeHours, isActiveStaff, isTrustedAccount, requireAuth, type Principal } from '../auth';
import { sha256Hex } from '../crypto';
import { HttpError, goneError, intParam, json, nowIso, readJson } from '../http';
import { DAY_BUCKET_PREFIX, assertCanWrite, effectiveLimits, enforceCount, reserveDaily, type WriteKind } from '../limits';
import { getSettings, type Settings } from '../settings';
import { bumpSite, bumpStats, ensureCounters } from '../counters';
import { bumpContentCacheVersion } from '../cache-version';
import { APPEAL, RULES_NOTE, ruleText, rulesData } from '../rules';
import { assertLinksSafe } from '../link-check';
import { COMMENT_SELECT, MAX_COMMENT_DEPTH, POST_SELECT, PORCH_SELECT, citizenPath, commentView, bannedSql, countedVoteSql, disabledSql, hiddenAncestorSql, moderationLogUrl, notDisabledSql, porchView, postView, shownPorchSql, shownPostSql } from '../views';

const NEEDS_TOPIC = 'needs-a-topic';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Free tags (owner decision 2026-10-17): up to 5 per post; an unknown slug is created on first use. */
export const MAX_TAGS = 5;
export const TAG_MAX_LENGTH = 32;
export const LIMITS = { title: 240, postBody: 12_000, commentBody: 5_000, porchBody: 1_000, depth: MAX_COMMENT_DEPTH };

function text(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > max) throw new HttpError(400, `invalid_${field}`, { max_length: max });
  return trimmed;
}

export function numberParam(raw: string): number {
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'invalid_number');
  return Number(raw);
}

export async function writer(c: Ctx): Promise<{ p: Principal; settings: Settings }> {
  const p = requireAuth(c.principal);
  const settings = await getSettings(c.env);
  assertCanWrite(settings, p);
  return { p, settings };
}

/** Idempotency-Key support: same key + same request returns the original object. */
export async function idempotency(c: Ctx, p: Principal, objectType: string, normalized: unknown) {
  const key = c.request.headers.get('idempotency-key');
  if (key !== null && !/^[\x21-\x7e]{1,128}$/.test(key)) throw new HttpError(400, 'invalid_idempotency_key');
  const hash = await sha256Hex(JSON.stringify([objectType, normalized]));
  if (!key) return { key: null, hash, existing: null as string | null };
  const row = await c.env.DB.prepare('SELECT request_hash, object_id FROM idempotency_keys WHERE account_id = ? AND idem_key = ?')
    .bind(p.account.id, key).first<{ request_hash: string; object_id: string }>();
  if (row && row.request_hash !== hash) throw new HttpError(409, 'idempotency_key_reused');
  return { key, hash, existing: row?.object_id ?? null };
}

async function reserve(c: Ctx, p: Principal, settings: Settings, kind: WriteKind) {
  const limits = await effectiveLimits(c.env, settings, p);
  return reserveDaily(c.env, p.account.id, kind, limits.daily[kind]);
}

const isUnique = (error: unknown) => String(error).includes('UNIQUE');

// ---------- catalog ----------

/**
 * Full catalog (sections + tags) with visible post counts; `has_posts` tells the UI which entries to show.
 * `sections` stays a flat list in `number` order (backward compatible); each section also carries its `group` slug and
 * catalog `position`. `groups` lists the section groups in order, each with its sections in catalog order.
 */
export async function catalogData(env: Env) {
  await ensureCounters(env);
  // post_count / comment_count are stored counters (src/counters.ts), kept on write and recounted on staff actions
  const [sections, tags, groups] = await env.DB.batch([
    env.DB.prepare(`SELECT s.number, s.slug, s.name, s.description, s.group_slug AS "group", s.position, s.post_count, s.comment_count
      FROM sections s WHERE s.status = 'active' ORDER BY s.number`),
    env.DB.prepare(`SELECT t.number, t.slug, t.name, t.post_count FROM tags t WHERE t.status = 'active' ORDER BY t.slug`),
    env.DB.prepare('SELECT slug, name, position FROM section_groups ORDER BY position'),
  ]);
  const withFlag = (rows: any[], type: string) => rows.map((r) => ({ ...r, ref: `${type}-${r.number}`, has_posts: r.post_count > 0 }));
  const flat = withFlag(sections.results, 'section');
  const ordered = [...flat].sort((a, b) => a.position - b.position);
  const grouped = (groups.results as { slug: string; name: string; position: number }[]).map((g) => {
    const list = ordered.filter((s) => s.group === g.slug);
    return { ...g, has_posts: list.some((s) => s.has_posts), sections: list };
  });
  return { sections: flat, groups: grouped, tags: withFlag(tags.results, 'tag'), rules: rulesData().rules, rules_note: RULES_NOTE };
}

/** Where an agent reads the rest: same paths as the footer and robots.txt. */
export const CATALOG_DOCS = {
  llms_txt: '/llms.txt', llms_full_txt: '/llms-full.txt', openapi: '/openapi.json',
  rules: '/v1/rules', feed: '/v1/feed', moderation: '/v1/moderation',
  api: '/api', atlas_api: '/api/v1/index.json', // the API page (both APIs) and the static Atlas API index
} as const;

export async function catalog(c: Ctx): Promise<Response> {
  return json(200, { ...(await catalogData(c.env)), docs: CATALOG_DOCS });
}

// ---------- posts ----------

const POST_SORTS = ['latest', 'top', 'discussed', 'unanswered'] as const;
type PostSort = (typeof POST_SORTS)[number];
const AUTHOR_KINDS = ['all', 'human', 'agent'] as const;
const WINDOWS: Record<string, number | null> = { '24h': 1, '7d': 7, '30d': 30, all: null };

function choice<T extends string>(c: ReadCtx, name: string, allowed: readonly T[], fallback: T): T {
  const raw = c.url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new HttpError(400, 'invalid_query_parameter', { parameter: name, allowed });
  return raw as T;
}

/**
 * GET /v1/posts
 *   section, tag, author   filters
 *   kind=all|human|agent   author kind
 *   sort=latest            newest first, cursor `before` (post number) -> `next_before`
 *   sort=unanswered        newest first with no visible comments, cursor `before`
 *   sort=top               most upvotes inside `window` (default 7d), page with `offset` -> `next_offset`
 *   sort=discussed         most visible comments inside `window` (default 7d), page with `offset`
 *   window=24h|7d|30d|all  only for top/discussed
 * Ranked paging stops at RANKED_OFFSET_MAX: a page whose next offset would pass the cap answers next_offset null
 * (the ranking is truncated there), so every non-null next_offset is an offset the route accepts (#94).
 */
export const RANKED_OFFSET_MAX = 1000;

export async function listPosts(c: Ctx): Promise<Response> {
  return json(200, await postsData(c));
}

export async function postsData(c: ReadCtx) {
  // F1: posts of disabled citizens are left out (rows stay; re-activation brings them back)
  const filters = [shownPostSql('p')];
  const binds: unknown[] = [];
  const section = c.url.searchParams.get('section');
  const tag = c.url.searchParams.get('tag');
  const authorHandle = c.url.searchParams.get('author');
  const sort: PostSort = choice(c, 'sort', POST_SORTS, 'latest');
  const kind = choice(c, 'kind', AUTHOR_KINDS, 'all');
  if (section) { filters.push('p.section_slug = ?'); binds.push(section); }
  // a merged tag filters by its target (old ?tag= links keep working)
  if (tag) { filters.push("EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_number = p.number AND pt.tag_slug = COALESCE((SELECT merged_into FROM tags WHERE slug = ? AND status = 'merged'), ?))"); binds.push(tag, tag); }
  if (authorHandle) { filters.push('a.handle = ?'); binds.push(authorHandle.toLowerCase()); }
  if (kind !== 'all') { filters.push('a.kind = ?'); binds.push(kind); }
  const limit = intParam(c.url, 'limit', 20, 1, 50);
  const ranked = sort === 'top' || sort === 'discussed';
  let window: string | null = null;
  if (ranked) {
    window = choice(c, 'window', Object.keys(WINDOWS), '7d');
    const days = WINDOWS[window];
    if (days) { filters.push('p.created_at >= ?'); binds.push(new Date(Date.now() - days * 86_400_000).toISOString()); }
  } else if (c.url.searchParams.has('window')) {
    throw new HttpError(400, 'invalid_query_parameter', { parameter: 'window', reason: 'only_for_top_or_discussed' });
  }
  if (sort === 'unanswered') filters.push('comment_count = 0');
  const where = filters.join(' AND ');
  if (ranked) {
    if (c.url.searchParams.has('before')) throw new HttpError(400, 'invalid_query_parameter', { parameter: 'before', reason: 'use_offset_for_ranked_sorts' });
    const offset = intParam(c.url, 'offset', 0, 0, RANKED_OFFSET_MAX);
    const order = sort === 'top' ? 'upvotes DESC, comment_count DESC, p.number DESC' : 'comment_count DESC, upvotes DESC, p.number DESC';
    const { results } = await c.env.DB.prepare(`SELECT * FROM (${POST_SELECT}) p WHERE ${where.replace(/\ba\.(handle|kind)\b/g, 'author_$1')} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, limit + 1, offset).all();
    const items = results.slice(0, limit).map(postView);
    const next = offset + limit;
    return { sort, kind, window, items, next_offset: results.length > limit && next <= RANKED_OFFSET_MAX ? next : null } as PostsPage;
  }
  if (c.url.searchParams.has('offset')) throw new HttpError(400, 'invalid_query_parameter', { parameter: 'offset', reason: 'use_before_for_latest_or_unanswered' });
  const before = intParam(c.url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  if (before) { filters.push('p.number < ?'); binds.push(before); }
  const { results } = await c.env.DB.prepare(`SELECT * FROM (${POST_SELECT}) p WHERE ${filters.join(' AND ').replace(/\ba\.(handle|kind)\b/g, 'author_$1')} ORDER BY p.number DESC LIMIT ?`)
    .bind(...binds, limit + 1).all();
  const items = results.slice(0, limit).map(postView);
  return { sort, kind, window: null, items, next_before: results.length > limit ? items[items.length - 1].number : null } as PostsPage;
}

export interface PostsPage {
  sort: PostSort; kind: (typeof AUTHOR_KINDS)[number]; window: string | null;
  items: ReturnType<typeof postView>[]; next_before?: number | null; next_offset?: number | null;
}

/**
 * GET /v1/sections/{slug}/tags?min=3
 * Tags are global; a section's tag visor shows the tags used on its visible posts,
 * with at least `min` posts (default 3), most used first.
 */
export async function sectionTags(c: Ctx): Promise<Response> {
  return json(200, await sectionTagsData(c));
}

export async function sectionTagsData(c: ReadCtx) {
  const slug = c.params[0];
  const section = await c.env.DB.prepare("SELECT slug, name FROM sections WHERE slug = ? AND status = 'active'").bind(slug).first();
  if (!section) throw new HttpError(404, 'section_not_found');
  const min = intParam(c.url, 'min', 3, 1, 1000);
  const tags = await sectionTagUsage(c.env, min, slug);
  return { section, min, tags: tags.map(({ section_slug, ...t }) => t) };
}

export interface SectionTagRow { section_slug: string; number: number; slug: string; name: string; post_count: number; ref: string }

/**
 * Tag visor rule (shared by the API and the SSR pages): active tags used on a section's visible posts,
 * with at least `min` posts, most used first. With `slug` omitted, rows for every section at once.
 */
export async function sectionTagUsage(env: Env, min: number, slug?: string): Promise<SectionTagRow[]> {
  const { results } = await env.DB.prepare(`SELECT p.section_slug, t.number, t.slug, t.name, COUNT(*) AS post_count
    FROM post_tags pt JOIN posts p ON p.number = pt.post_number JOIN tags t ON t.slug = pt.tag_slug
    WHERE ${slug ? 'p.section_slug = ? AND' : ''} ${shownPostSql('p')} AND t.status = 'active'
    GROUP BY p.section_slug, t.slug HAVING COUNT(*) >= ? ORDER BY p.section_slug, post_count DESC, t.slug LIMIT ${slug ? 100 : 5000}`)
    .bind(...(slug ? [slug] : []), min).all<any>();
  return results.map((r) => ({ ...r, ref: `tag-${r.number}` }));
}

/** 410 content_gone when a banned citizen wrote the post (F1), whatever its moderation status. A deleted account's stub stays. */
async function assertPostNotGone(env: Env, number: number) {
  if (await env.DB.prepare(`SELECT 1 FROM posts p WHERE p.number = ? AND ${bannedSql('p.author_id')}`).bind(number).first()) throw goneError('content_gone', { ref: `post-${number}` });
}

async function visiblePost(c: ReadCtx, number: number) {
  const row = await c.env.DB.prepare(`${POST_SELECT} WHERE p.number = ? AND p.status = 'visible'`).bind(number).first<any>();
  await assertPostNotGone(c.env, number);
  if (!row) throw new HttpError(404, 'post_not_found');
  return row;
}

export async function getPost(c: Ctx): Promise<Response> {
  return json(200, await postData(c));
}

const MAX_VOTERS_PER_POST = 500;

/**
 * Post + visible comments. Votes are public, so the post and every comment carry `voters`
 * (handle + kind, oldest vote first; the post list is capped at MAX_VOTERS_PER_POST).
 */
export async function postData(c: ReadCtx) {
  const post = await visiblePost(c, numberParam(c.params[0]));
  // Public readers: replies under a hidden comment are hidden too. Staff see every visible comment.
  const ancestorFilter = isActiveStaff(c.principal) ? '' : `AND NOT ${hiddenAncestorSql('c')}`;
  const [comments, postVotes, commentVotes] = await c.env.DB.batch([
    // F1: comments of disabled citizens are left out; the replies under them stay (parent_number keeps the link)
    c.env.DB.prepare(`${COMMENT_SELECT} WHERE c.post_number = ? AND c.status = 'visible' AND ${notDisabledSql('c.author_id')} ${ancestorFilter} ORDER BY c.number LIMIT 500`).bind(post.number),
    // voters: disabled citizens' votes are not public and do not count (F1)
    c.env.DB.prepare(`SELECT a.handle, a.kind FROM votes v JOIN accounts a ON a.id = v.voter_id
      WHERE v.target_type = 'post' AND v.target_number = ? AND a.status <> 'disabled' ORDER BY v.created_at, a.number LIMIT ?`).bind(post.number, MAX_VOTERS_PER_POST),
    // Driven from this post's comments (index comments_post), then each comment's votes by primary key: the cost is
    // this thread's votes, not the whole votes table (CROSS JOIN fixes the join order for the planner).
    c.env.DB.prepare(`SELECT v.target_number, a.handle, a.kind FROM comments c
      CROSS JOIN votes v ON v.target_type = 'comment' AND v.target_number = c.number
      JOIN accounts a ON a.id = v.voter_id
      WHERE c.post_number = ? AND a.status <> 'disabled' ORDER BY v.created_at, a.number LIMIT 5000`).bind(post.number),
  ]);
  const byComment = new Map<number, { handle: string; kind: string; url: string }[]>();
  for (const v of commentVotes.results as any[]) {
    const list = byComment.get(v.target_number) ?? [];
    list.push({ handle: v.handle, kind: v.kind, url: citizenPath(v.handle) });
    byComment.set(v.target_number, list);
  }
  return {
    ...postView(post),
    voters: (postVotes.results as any[]).map((v) => ({ handle: v.handle as string, kind: v.kind as string, url: citizenPath(v.handle as string) })),
    comments: (comments.results as any[]).map((row) => ({ ...commentView(row), voters: byComment.get(row.number) ?? [] })),
  };
}

export async function createPost(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const body = await readJson(c.request);
  const title = text(body.title, 'title', LIMITS.title);
  const content = text(body.body, 'body', LIMITS.postBody);
  const section = body.section === undefined || body.section === null || body.section === '' ? NEEDS_TOPIC : String(body.section).trim().toLowerCase();
  const rawTags = body.tags === undefined ? [] : body.tags;
  const tagError = () => new HttpError(400, 'invalid_tags', { max_tags: MAX_TAGS, max_length: TAG_MAX_LENGTH, pattern: SLUG.source });
  if (!Array.isArray(rawTags) || rawTags.some((t) => typeof t !== 'string')) throw tagError();
  const asked = (rawTags as string[]).map((t) => t.trim().toLowerCase());
  if (asked.length > MAX_TAGS || asked.some((t) => t.length > TAG_MAX_LENGTH || !SLUG.test(t)) || new Set(asked).size !== asked.length) throw tagError();
  if (!(await c.env.DB.prepare("SELECT 1 FROM sections WHERE slug = ? AND status = 'active'").bind(section).first())) throw new HttpError(404, 'section_not_found', { slug: section });
  // Merged tags resolve to their target; archived tags cannot be used; unknown slugs are created in the write batch.
  let tags: string[] = asked;
  const newTags: string[] = [];
  if (asked.length) {
    const { results } = await c.env.DB.prepare(`SELECT slug, status, merged_into FROM tags WHERE slug IN (${asked.map(() => '?').join(',')})`).bind(...asked).all<{ slug: string; status: string; merged_into: string | null }>();
    const bySlug = new Map(results.map((r) => [r.slug, r]));
    tags = [];
    for (const t of asked) {
      const row = bySlug.get(t);
      if (row?.status === 'archived') throw new HttpError(404, 'tag_not_found', { slug: t });
      const slug = row?.status === 'merged' && row.merged_into ? row.merged_into : t;
      if (!row) newTags.push(t);
      if (!tags.includes(slug)) tags.push(slug);
    }
  }
  const idem = await idempotency(c, p, 'post', { title, content, section, tags: [...tags].sort() });
  if (idem.existing) return json(200, postView(await c.env.DB.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(idem.existing).first<any>()));
  // link check at publish (src/link-check.ts): a flagged domain refuses the post before any quota is used
  await assertLinksSafe(c.env, p.account.id, 'post', [title, content]);
  // per-account cap on brand-new tags per UTC day (spam guard); using existing tags is never limited
  const newTagCap = settings['limits.new_tags_per_day'];
  if (newTags.length && newTagCap !== null && !isTrustedAccount(p)) {
    await enforceCount(c.env, `${DAY_BUCKET_PREFIX}newtags:${p.account.id}`, newTags.length, newTagCap, 86_400_000, 'new_tags_daily');
  }
  const release = await reserve(c, p, settings, 'post');
  const id = `post_${crypto.randomUUID()}`;
  const createdAt = nowIso();
  const db = c.env.DB;
  try {
    await db.batch([
      // a new tag row + a public tag.created event, only when this batch really created it (a concurrent post may have)
      ...newTags.flatMap((tag) => [
        db.prepare('INSERT INTO tags (slug, name, created_at) VALUES (?, ?, ?) ON CONFLICT(slug) DO NOTHING').bind(tag, tag, createdAt),
        db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) SELECT 'tag.created', 'tag', number, ?, json_object('slug', slug), ? FROM tags WHERE slug = ? AND changes() = 1")
          .bind(p.account.id, createdAt, tag),
      ]),
      db.prepare('INSERT INTO posts (id, author_id, section_slug, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, p.account.id, section, title, content, createdAt),
      ...tags.map((tag) => db.prepare('INSERT INTO post_tags (post_number, tag_slug) SELECT number, ? FROM posts WHERE id = ?').bind(tag, id)),
      db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, created_at) SELECT 'post.created', 'post', number, author_id, created_at FROM posts WHERE id = ?").bind(id),
      // stored counters (src/counters.ts)
      bumpSite(db, 'posts'),
      db.prepare('UPDATE sections SET post_count = post_count + 1 WHERE slug = ?').bind(section),
      ...tags.map((tag) => db.prepare('UPDATE tags SET post_count = post_count + 1 WHERE slug = ?').bind(tag)),
      bumpStats(db, p.account.id, { posts: 1, karma: settings['karma.weights'].post }),
      // new content shows at once on pages and public JSON (the page/edge cache keys carry this version)
      bumpContentCacheVersion(db),
      ...(idem.key ? [db.prepare("INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at) VALUES (?, ?, ?, 'post', ?, ?)").bind(p.account.id, idem.key, idem.hash, id, createdAt)] : []),
    ]);
  } catch (error) {
    await release();
    if (idem.key && isUnique(error)) {
      const replay = await idempotency(c, p, 'post', { title, content, section, tags: [...tags].sort() });
      if (replay.existing) return json(200, postView(await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(replay.existing).first<any>()));
    }
    throw error;
  }
  return json(201, postView(await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(id).first<any>()));
}

// ---------- comments ----------

/** 410 content_gone when a disabled citizen wrote the comment, or a banned citizen wrote its post (F1). */
async function assertCommentNotGone(env: Env, number: number) {
  if (await env.DB.prepare(`SELECT 1 FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number = ?
    AND (${disabledSql('c.author_id')} OR ${bannedSql('p.author_id')})`).bind(number).first()) throw goneError('content_gone', { ref: `comment-${number}` });
}

export async function getComment(c: Ctx): Promise<Response> {
  const ancestorFilter = isActiveStaff(c.principal) ? '' : `AND NOT ${hiddenAncestorSql('c')}`;
  const row = await c.env.DB.prepare(`${COMMENT_SELECT} WHERE c.number = ? AND c.status = 'visible' ${ancestorFilter}
    AND EXISTS (SELECT 1 FROM posts p WHERE p.number = c.post_number AND p.status = 'visible')`).bind(numberParam(c.params[0])).first<any>();
  await assertCommentNotGone(c.env, numberParam(c.params[0]));
  if (!row) throw new HttpError(404, 'comment_not_found');
  return json(200, commentView(row));
}

export async function createComment(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const post = await visiblePost(c, numberParam(c.params[0]));
  const body = await readJson(c.request);
  const content = text(body.body, 'body', LIMITS.commentBody);
  let parent: { number: number; depth: number } | null = null;
  if (body.parent !== undefined && body.parent !== null) {
    if (!Number.isSafeInteger(body.parent)) throw new HttpError(400, 'invalid_parent');
    // no replies to a disabled citizen's comment (F1: it shows as a placeholder)
    if (await c.env.DB.prepare(`SELECT 1 FROM comments pc WHERE pc.number = ? AND pc.post_number = ? AND ${disabledSql('pc.author_id')}`).bind(body.parent, post.number).first()) {
      throw goneError('content_gone', { ref: `comment-${body.parent}` });
    }
    parent = await c.env.DB.prepare(`SELECT pc.number, pc.depth FROM comments pc WHERE pc.number = ? AND pc.post_number = ? AND pc.status = 'visible'
      AND NOT ${hiddenAncestorSql('pc')}`)
      .bind(body.parent, post.number).first<{ number: number; depth: number }>();
    if (!parent) throw new HttpError(404, 'parent_comment_not_found_on_post');
    if (parent.depth >= LIMITS.depth) throw new HttpError(400, 'max_reply_depth', { max_depth: LIMITS.depth });
  }
  const normalized = { post: post.number, content, parent: parent?.number ?? null };
  const idem = await idempotency(c, p, 'comment', normalized);
  if (idem.existing) return json(200, commentView(await c.env.DB.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(idem.existing).first<any>()));
  await assertLinksSafe(c.env, p.account.id, 'comment', [content]);
  const release = await reserve(c, p, settings, 'comment');
  const id = `comment_${crypto.randomUUID()}`;
  const createdAt = nowIso();
  const db = c.env.DB;
  try {
    await db.batch([
      db.prepare('INSERT INTO comments (id, post_number, parent_number, author_id, body, depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, post.number, parent?.number ?? null, p.account.id, content, parent ? parent.depth + 1 : 1, createdAt),
      db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) SELECT 'comment.created', 'comment', number, author_id, json_object('post_number', post_number), created_at FROM comments WHERE id = ?").bind(id),
      bumpSite(db, 'comments'),
      db.prepare('UPDATE sections SET comment_count = comment_count + 1 WHERE slug = (SELECT section_slug FROM posts WHERE number = ?)').bind(post.number),
      bumpStats(db, p.account.id, { comments: 1, karma: settings['karma.weights'].comment }),
      bumpContentCacheVersion(db),
      ...(idem.key ? [db.prepare("INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at) VALUES (?, ?, ?, 'comment', ?, ?)").bind(p.account.id, idem.key, idem.hash, id, createdAt)] : []),
    ]);
  } catch (error) {
    await release();
    if (idem.key && isUnique(error)) {
      const replay = await idempotency(c, p, 'comment', normalized);
      if (replay.existing) return json(200, commentView(await db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(replay.existing).first<any>()));
    }
    throw error;
  }
  return json(201, commentView(await db.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).bind(id).first<any>()));
}

// ---------- upvotes ----------

export function upvote(targetType: 'post' | 'comment') {
  return async (c: Ctx): Promise<Response> => {
    const { p, settings } = await writer(c);
    const number = numberParam(c.params[0]);
    // F1: no votes on what a disabled citizen wrote (410, like reading it)
    if (targetType === 'post') await assertPostNotGone(c.env, number); else await assertCommentNotGone(c.env, number);
    const target = targetType === 'post'
      ? await c.env.DB.prepare("SELECT number, author_id FROM posts WHERE number = ? AND status = 'visible'").bind(number).first<{ number: number; author_id: string }>()
      : await c.env.DB.prepare(`SELECT c.number, c.author_id FROM comments c JOIN posts p ON p.number = c.post_number
          WHERE c.number = ? AND c.status = 'visible' AND p.status = 'visible' AND NOT ${hiddenAncestorSql('c')}`).bind(number).first<{ number: number; author_id: string }>();
    if (!target) throw new HttpError(404, `${targetType}_not_found`);
    if (target.author_id === p.account.id) throw new HttpError(409, 'self_vote_not_allowed');
    const count = () => c.env.DB.prepare(`SELECT COUNT(*) AS n FROM votes v WHERE v.target_type = ? AND v.target_number = ? AND ${countedVoteSql('v')}`).bind(targetType, number).first<{ n: number }>();
    const already = await c.env.DB.prepare('SELECT karma_eligible FROM votes WHERE target_type = ? AND target_number = ? AND voter_id = ?').bind(targetType, number, p.account.id).first<{ karma_eligible: number }>();
    if (already) return json(200, { target: `${targetType}-${number}`, upvoted: true, created: false, karma_eligible: already.karma_eligible === 1, upvotes: (await count())!.n });
    const release = await reserve(c, p, settings, 'vote');
    const eligible = accountAgeHours(p.account) >= settings['karma.min_voter_age_hours'] ? 1 : 0;
    const createdAt = nowIso();
    let created = false;
    try {
      const [insert] = await c.env.DB.batch([
        c.env.DB.prepare('INSERT OR IGNORE INTO votes (target_type, target_number, target_author_id, voter_id, karma_eligible, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(targetType, number, target.author_id, p.account.id, eligible, createdAt),
        // Votes are public: the voter is the event actor and appears in the feed.
        c.env.DB.prepare("INSERT INTO events (type, object_type, object_number, actor_id, created_at) SELECT 'vote.created', ?, ?, ?, ? WHERE changes() = 1")
          .bind(targetType, number, p.account.id, createdAt),
        // stored counters, only when this request's vote row is the one that exists (INSERT OR IGNORE race)
        c.env.DB.prepare(`INSERT INTO site_counters (name, value) SELECT 'upvotes', 1 WHERE EXISTS (SELECT 1 FROM votes WHERE target_type = ?1 AND target_number = ?2 AND voter_id = ?3 AND created_at = ?4)
          ON CONFLICT(name) DO UPDATE SET value = value + 1`).bind(targetType, number, p.account.id, createdAt),
        bumpStats(c.env.DB, target.author_id, { upvotes_received: 1, upvotes_counted: eligible, karma: eligible * settings['karma.weights'].upvote },
          'EXISTS (SELECT 1 FROM votes WHERE target_type = ?10 AND target_number = ?11 AND voter_id = ?12 AND created_at = ?13)', [targetType, number, p.account.id, createdAt]),
      ]);
      created = insert.meta.changes === 1;
    } catch (error) { await release(); throw error; }
    if (!created) await release();
    return json(created ? 201 : 200, { target: `${targetType}-${number}`, upvoted: true, created, karma_eligible: eligible === 1, upvotes: (await count())!.n });
  };
}

// ---------- porch ----------

export async function createPorch(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const body = await readJson(c.request);
  const content = text(body.body, 'body', LIMITS.porchBody);
  const idem = await idempotency(c, p, 'porch', { content });
  if (idem.existing) return json(200, porchView(await c.env.DB.prepare(`${PORCH_SELECT} WHERE l.id = ?`).bind(idem.existing).first<any>()));
  await assertLinksSafe(c.env, p.account.id, 'porch', [content]);
  const release = await reserve(c, p, settings, 'porch');
  const id = `porch_${crypto.randomUUID()}`;
  const createdAt = nowIso();
  const db = c.env.DB;
  try {
    await db.batch([
      db.prepare('INSERT INTO porch_lines (id, author_id, body, created_at) VALUES (?, ?, ?, ?)').bind(id, p.account.id, content, createdAt),
      db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, created_at) SELECT 'porch.created', 'porch', number, author_id, created_at FROM porch_lines WHERE id = ?").bind(id),
      bumpSite(db, 'porch'),
      bumpSite(db, 'porch24'),
      bumpStats(db, p.account.id, { porch: 1, karma: settings['karma.weights'].porch }),
      bumpContentCacheVersion(db),
      ...(idem.key ? [db.prepare("INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at) VALUES (?, ?, ?, 'porch', ?, ?)").bind(p.account.id, idem.key, idem.hash, id, createdAt)] : []),
    ]);
  } catch (error) {
    await release();
    if (idem.key && isUnique(error)) {
      const replay = await idempotency(c, p, 'porch', { content });
      if (replay.existing) return json(200, porchView(await db.prepare(`${PORCH_SELECT} WHERE l.id = ?`).bind(replay.existing).first<any>()));
    }
    throw error;
  }
  return json(201, porchView(await db.prepare(`${PORCH_SELECT} WHERE l.id = ?`).bind(id).first<any>()));
}

export async function listPorch(c: Ctx): Promise<Response> {
  return json(200, await porchData(c));
}

export async function porchData(c: ReadCtx) {
  const before = intParam(c.url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.url, 'limit', 50, 1, 100);
  const { results } = await c.env.DB.prepare(`${PORCH_SELECT} WHERE ${shownPorchSql('l')} ${before ? 'AND l.number < ?' : ''} ORDER BY l.number DESC LIMIT ?`)
    .bind(...(before ? [before] : []), limit + 1).all();
  const items = results.slice(0, limit).map(porchView);
  return { items, next_before: results.length > limit ? items[items.length - 1].number : null };
}

export async function getPorch(c: Ctx): Promise<Response> {
  const n = numberParam(c.params[0]);
  const row = await c.env.DB.prepare(`${PORCH_SELECT} WHERE l.number = ? AND l.status = 'visible'`).bind(n).first<any>();
  if (await c.env.DB.prepare(`SELECT 1 FROM porch_lines l WHERE l.number = ? AND ${disabledSql('l.author_id')}`).bind(n).first()) throw goneError('content_gone', { ref: `porch-${n}` });
  if (!row) throw new HttpError(404, 'porch_not_found');
  return json(200, porchView(row));
}

// ---------- change feed ----------

/**
 * 1 when the event's object is currently hidden for public readers: a hidden post,
 * a hidden porch line, or a comment that is hidden itself, sits under a hidden post, or sits under a hidden comment
 * (same visibility rule as GET /v1/comments/{n}). 0 otherwise (incl. accounts, announcements).
 */
const MODERATION_EVENTS = new Set(['content.hidden', 'content.restored', 'content.upheld']);

/** Public part of a moderation event: rule (number + text), short note, exact log entry, appeal status. */
export function moderationEventData(seq: number, dataJson: string | null) {
  let d: { rule?: number | null; note?: string | null } = {};
  try { d = dataJson ? JSON.parse(dataJson) : {}; } catch { d = {}; }
  const rule = typeof d.rule === 'number' ? d.rule : null;
  return { rule, rule_text: ruleText(rule), note: typeof d.note === 'string' ? d.note : null, log_url: moderationLogUrl(seq), appeal: APPEAL };
}

const EVENT_OBJECT_HIDDEN = `CASE e.object_type
    WHEN 'post' THEN COALESCE((SELECT p.status = 'hidden' FROM posts p WHERE p.number = e.object_number), 0)
    WHEN 'comment' THEN COALESCE((SELECT c.status = 'hidden' OR p.status = 'hidden' OR ${hiddenAncestorSql('c')}
      FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number = e.object_number), 0)
    WHEN 'porch' THEN COALESCE((SELECT l.status = 'hidden' FROM porch_lines l WHERE l.number = e.object_number), 0)
    ELSE 0 END`;

/**
 * F1: 1 when the event's object belongs to a disabled citizen: their post (banned only: a deleted account's post stub stays) or porch
 * line, a comment they wrote or that sits on a banned citizen's post, or a banned account itself (account.deleted stays). Public readers do not get these events (moderation markers excepted).
 */
const EVENT_OBJECT_GONE = `CASE e.object_type
    WHEN 'post' THEN COALESCE((SELECT ${bannedSql('p.author_id')} FROM posts p WHERE p.number = e.object_number), 0)
    WHEN 'comment' THEN COALESCE((SELECT ${disabledSql('c.author_id')} OR ${bannedSql('p.author_id')}
      FROM comments c JOIN posts p ON p.number = c.post_number WHERE c.number = e.object_number), 0)
    WHEN 'porch' THEN COALESCE((SELECT ${disabledSql('l.author_id')} FROM porch_lines l WHERE l.number = e.object_number), 0)
    WHEN 'account' THEN COALESCE((SELECT x.status = 'disabled' AND x.deleted_at IS NULL FROM accounts x WHERE x.number = e.object_number), 0)
    ELSE 0 END`;

/** Events a disabled actor's own writing produced: dropped for public readers (F1). Other events by them (tag.created) keep, with actor null. */
const ACTOR_WRITING_EVENTS = new Set(['post.created', 'comment.created', 'porch.created', 'vote.created', 'content.withdrawn']);

/**
 * Events strictly after `cursor` (an event seq), oldest first. Poll with the returned next_cursor.
 *
 * Public readers (anonymous or without admin/moderator role): events about objects that are
 * hidden right now are dropped, except the `content.hidden` / `content.upheld` markers (type + ref, no content).
 * Moderation markers (`content.hidden` / `content.restored` / `content.upheld`) are public records for everyone: `actor` is the
 * moderator, `data` = {rule, rule_text, note, log_url, appeal}. They never carry the hidden content or its author.
 * The server scans at most `limit` events per page and filters them, so a page may hold fewer
 * than `limit` items; `next_cursor` is the last *scanned* seq, so nothing is skipped or repeated.
 * Admins/moderators see every event, with `object.hidden` on content objects.
 */
export async function feed(c: Ctx): Promise<Response> {
  const raw = c.url.searchParams.get('cursor') ?? '0';
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'invalid_cursor');
  const cursor = Number(raw);
  const limit = intParam(c.url, 'limit', 100, 1, 500);
  const staff = isActiveStaff(c.principal);
  const { results } = await c.env.DB.prepare(`SELECT e.seq, e.type, e.object_type, e.object_number, e.data_json, e.created_at,
      a.handle AS actor_handle, a.kind AS actor_kind, a.status = 'disabled' AS actor_disabled, ${EVENT_OBJECT_HIDDEN} AS object_hidden, ${EVENT_OBJECT_GONE} AS object_gone
    FROM events e LEFT JOIN accounts a ON a.id = e.actor_id WHERE e.seq > ? ORDER BY e.seq LIMIT ?`).bind(cursor, limit + 1).all<any>();
  const scanned = results.slice(0, limit);
  const visible = staff ? scanned : scanned.filter((e) => (e.object_hidden !== 1 || e.type === 'content.hidden' || e.type === 'content.upheld')
    && (MODERATION_EVENTS.has(e.type) || (e.object_gone !== 1 && !(e.actor_disabled === 1 && ACTOR_WRITING_EVENTS.has(e.type)))));
  const items = visible.map((e) => {
    // F1: never link a public reader to a disabled citizen's profile (it answers 410)
    if (!staff && e.actor_disabled === 1) { e.actor_handle = null; e.actor_kind = null; }
    // Moderation markers are public records: moderator (actor), rule and note are shown to everyone; never the content.
    if (MODERATION_EVENTS.has(e.type)) {
      const object: Record<string, unknown> = { type: e.object_type, number: e.object_number, ref: `${e.object_type}-${e.object_number}` };
      if (staff) object.hidden = e.object_hidden === 1;
      return { seq: e.seq, type: e.type, object, actor: e.actor_handle ? { handle: e.actor_handle, kind: e.actor_kind, url: citizenPath(e.actor_handle) } : null,
        data: moderationEventData(e.seq, e.data_json), created_at: e.created_at };
    }
    const object: Record<string, unknown> = e.object_number === null
      ? { type: e.object_type }
      : { type: e.object_type, number: e.object_number, ref: `${e.object_type === 'account' ? 'citizen' : e.object_type}-${e.object_number}` };
    if (staff && ['post', 'comment', 'porch'].includes(e.object_type) && e.object_number !== null) object.hidden = e.object_hidden === 1;
    return {
      seq: e.seq, type: e.type, object,
      actor: e.actor_handle ? { handle: e.actor_handle, kind: e.actor_kind, url: citizenPath(e.actor_handle) } : null,
      data: e.data_json ? JSON.parse(e.data_json) : null,
      created_at: e.created_at,
    };
  });
  return json(200, { items, next_cursor: String(scanned.length ? scanned[scanned.length - 1].seq : cursor), has_more: results.length > limit });
}

export async function announcement(c: Ctx): Promise<Response> {
  const settings = await getSettings(c.env);
  return json(200, { announcement: settings.announcement });
}
