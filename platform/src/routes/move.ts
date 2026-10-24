/**
 * Move a post to another section:
 *   POST /v1/posts/{n}/section   {"section": "<slug>", "reason": "short public reason (optional)"}
 *
 * Who: the post's author, or an active admin (403 not_your_content otherwise). Frozen / disabled accounts and Lock mode
 * are refused like every write. Idempotency-Key as other writes. Capped per account per UTC day (setting
 * limits.daily.move; 429 daily_limit_exceeded, kind move; refused calls use no quota).
 *
 * What changes: only posts.section_slug. The post keeps its number, id, URL (/posts/{n} has no section in it), author,
 * title, body, tags, comments and votes. Stored section counters (post_count, comment_count) of the two sections are
 * recounted in the same D1 batch; tag counts are global and do not change; the content cache version is bumped, so
 * cached section, post and list pages and public reads show the move at once (src/cache-version.ts). When the guarded
 * UPDATE changes no row (lost race), no statement of the batch writes: no move row, event, key, recount or bump.
 *
 * Public, permanent record (migration 0023, table post_section_moves): from, to, actor, the role used (author or
 * admin), time and reason. The post JSON carries `moves` (the newest 100, oldest of them first) and `moves_total`; the
 * full history is GET /v1/posts/{n}/moves (paged, oldest first). The post page and its Markdown twin show
 * "Moved from X to Y by @actor on DATE", and a public `post.moved` event goes to the change feed
 * (actor = who moved it; data: from, to, reason, role). There is no API to delete or edit a move record.
 *
 * Refused:
 *   400 invalid_section     section missing, not a string or not a slug
 *   404 section_not_found   no active section with that slug
 *   400 same_section        the post is already in that section (nothing written, no quota used)
 *   400 invalid_reason / reason_too_long   reason not a string / longer than MOVE_REASON_MAX (never cut)
 *   404 post_not_found      no such post
 *   410 content_gone        the post's author is banned (F1)
 *   409 content_hidden      the post is hidden by moderation (moderation decides where hidden content stays)
 *   409 already_withdrawn   the author withdrew the post
 *   409 section_changed     another move landed first (race); read the post again
 */
import type { Ctx } from '../context';
import { isAdmin } from '../auth';
import { HttpError, goneError, json, nowIso, readJson } from '../http';
import { reserveDayBucket } from '../limits';
import { bumpContentCacheVersion } from '../cache-version';
import { sectionRecountStatement } from '../counters';
import { MOVE_EVENT, MOVE_REASON_MAX, postMoves } from '../post-moves';
import { POST_SELECT, bannedSql, postView } from '../views';
import { idempotency, numberParam, writer } from './content';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sectionField(body: Record<string, unknown>): string {
  if (typeof body.section !== 'string') throw new HttpError(400, 'invalid_section');
  const slug = body.section.trim().toLowerCase();
  if (!slug || slug.length > 64 || !SLUG.test(slug)) throw new HttpError(400, 'invalid_section');
  return slug;
}

function reasonField(body: Record<string, unknown>): string | null {
  if (body.reason === undefined || body.reason === null) return null;
  if (typeof body.reason !== 'string') throw new HttpError(400, 'invalid_reason');
  const value = body.reason.replace(/\s+/g, ' ').trim();
  if (value.length > MOVE_REASON_MAX) throw new HttpError(400, 'reason_too_long', { max_length: MOVE_REASON_MAX, length: value.length });
  return value || null;
}

interface PostState { id: string; author_id: string; section_slug: string; status: string; withdrawn_at: string | null; banned: number }

const postState = (c: Ctx, number: number) => c.env.DB.prepare(`SELECT p.id, p.author_id, p.section_slug, p.status, p.withdrawn_at, ${bannedSql('p.author_id')} AS banned
  FROM posts p WHERE p.number = ?`).bind(number).first<PostState>();

/** The post as the move endpoint returns it: the post view plus its newest moves and moves_total, as GET /v1/posts/{n}. */
async function movedView(c: Ctx, number: number) {
  const row = await c.env.DB.prepare(`${POST_SELECT} WHERE p.number = ?`).bind(number).first<any>();
  return { ...postView(row), ...(await postMoves(c.env, number)) };
}

export async function movePost(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const number = numberParam(c.params[0]);
  const body = await readJson(c.request);
  const to = sectionField(body);
  const reason = reasonField(body);
  const row = await postState(c, number);
  if (!row) throw new HttpError(404, 'post_not_found');
  const ref = `post-${number}`;
  if (row.banned) throw goneError('content_gone', { ref });
  const mine = row.author_id === p.account.id;
  if (!mine && !isAdmin(p)) throw new HttpError(403, 'not_your_content', { ref, reason: 'only the author or an admin can move it' });
  const role: 'author' | 'admin' = mine ? 'author' : 'admin';
  const objectType = 'post.move';
  const idem = await idempotency(c, p, objectType, { number, to, reason });
  if (idem.existing) return json(200, await movedView(c, number));
  if (row.status !== 'visible') throw new HttpError(409, 'content_hidden', { ref, reason: 'hidden content cannot be moved' });
  if (row.withdrawn_at) throw new HttpError(409, 'already_withdrawn', { ref, withdrawn_at: row.withdrawn_at });
  const target = await c.env.DB.prepare("SELECT slug FROM sections WHERE slug = ? AND status = 'active'").bind(to).first<{ slug: string }>();
  if (!target) throw new HttpError(404, 'section_not_found', { slug: to });
  const from = row.section_slug;
  if (from === to) throw new HttpError(400, 'same_section', { ref, section: to, reason: 'the post is already in this section' });

  const release = await reserveDayBucket(c.env, 'move', p.account.id, settings['limits.daily.move']);
  const at = nowIso();
  const moveId = `move_${crypto.randomUUID()}`;
  const db = c.env.DB;
  // The UPDATE only changes the post when it is still in `from`, visible and not withdrawn. Every statement after it
  // (move row, event, idempotency key, section recount, cache bump) only writes when this request's UPDATE moved the
  // post: the move row is inserted on changes() = 1, and the rest check that this request's move row exists. A lost
  // race (another move, a hide or a withdrawal in between) therefore writes nothing at all.
  const moved = 'EXISTS (SELECT 1 FROM post_section_moves WHERE id = ?1)';
  const movedGuard = { sql: 'EXISTS (SELECT 1 FROM post_section_moves WHERE id = ?2)', value: moveId };
  let changed = 0;
  try {
    const [update] = await db.batch([
      db.prepare(`UPDATE posts SET section_slug = ?2 WHERE number = ?1 AND section_slug = ?3 AND status = 'visible' AND withdrawn_at IS NULL`).bind(number, to, from),
      // changes() = rows changed by the UPDATE just above (same connection, previous statement of this batch)
      db.prepare(`INSERT INTO post_section_moves (id, post_number, from_section, to_section, actor_id, actor_role, reason, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE changes() = 1`).bind(moveId, number, from, to, p.account.id, role, reason, at),
      db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at)
        SELECT '${MOVE_EVENT}', 'post', ?2, ?3, json_object('from', ?4, 'to', ?5, 'reason', ?6, 'role', ?7), ?8 WHERE ${moved}`)
        .bind(moveId, number, p.account.id, from, to, reason, role, at),
      ...(idem.key ? [db.prepare(`INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at)
        SELECT ?2, ?3, ?4, ?5, ?6, ?7 WHERE ${moved}`).bind(moveId, p.account.id, idem.key, idem.hash, objectType, row.id, at)] : []),
      // stored counters of both sections, exact (reference recount, src/counters.ts); only when this request moved it
      sectionRecountStatement(db, [from, to], movedGuard),
      // the post now lists under another section: cached section, post and list pages and public reads drop at once;
      // only when this request moved it (a lost race changed nothing public, so nothing to invalidate)
      bumpContentCacheVersion(db, movedGuard),
    ]);
    changed = update.meta.changes ?? 0;
  } catch (error) {
    await release();
    if (idem.key && String(error).includes('UNIQUE')) {
      const replay = await idempotency(c, p, objectType, { number, to, reason });
      if (replay.existing) return json(200, await movedView(c, number));
    }
    throw error;
  }
  if (!changed) {
    // lost a race (a moderation hide, a withdrawal or another move in between): report the state that refused it
    await release();
    const now = await postState(c, number);
    if (now && now.status !== 'visible') throw new HttpError(409, 'content_hidden', { ref, reason: 'hidden content cannot be moved' });
    if (now?.withdrawn_at) throw new HttpError(409, 'already_withdrawn', { ref, withdrawn_at: now.withdrawn_at });
    throw new HttpError(409, 'section_changed', { ref, section: now?.section_slug ?? null, reason: 'the post was moved by another request; read it again' });
  }
  return json(200, await movedView(c, number));
}
