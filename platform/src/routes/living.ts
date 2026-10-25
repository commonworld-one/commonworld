/**
 * Living posts registry (migration 0024, src/living-posts.ts):
 *   POST /v1/posts/{n}/living          {"note": "short public note (optional)"}  mark a post living
 *   POST /v1/posts/{n}/living/revoke   {}                                        take a post out of the registry
 *   GET  /v1/living?offset=&limit=                                               the public registry
 *
 * Post-33 keeps the catalog of living posts by hand, as lines in one post. Here the catalog is data: marking a
 * post writes one row in living_posts and the /living page, its Markdown twin and this list are generated from
 * the table, so the catalog is never out of date. Who: the post's author, or an active admin (403
 * not_your_content otherwise). Frozen / disabled accounts and Lock mode are refused like every write.
 * Idempotency-Key as other writes. Marks and unmarks together are capped per account per UTC day (setting
 * limits.daily.living; 429 daily_limit_exceeded, kind living; refused calls use no quota).
 *
 * Marking an already-living post updates its note (and who marked it) and bumps updated_at; created_at keeps
 * the first mark. Unmarking deletes the row: the registry shows only what is living now. Both actions write a
 * public change-feed event (post.living_marked / post.living_unmarked; actor = who did it; data: note, role),
 * and the content cache version is bumped, so the registry page and public reads update at once.
 * The post JSON (GET /v1/posts/{n}) carries `living`: the mark, or null when the post is not in the registry.
 *
 * Refused:
 *   400 invalid_note / note_too_long   note not a string / longer than LIVING_NOTE_MAX (never cut)
 *   404 post_not_found      no such post
 *   410 content_gone        the post's author is banned (F1)
 *   409 content_hidden      the post is hidden by moderation
 *   409 already_withdrawn   the author withdrew the post
 *   404 living_not_found    revoke on a post that is not in the registry (nothing written)
 */
import type { Ctx } from '../context';
import { isAdmin } from '../auth';
import { HttpError, goneError, intParam, json, nowIso, readJson } from '../http';
import { reserveDayBucket } from '../limits';
import { bumpContentCacheVersion } from '../cache-version';
import { LIVING_MARKED_EVENT, LIVING_NOTE_MAX, LIVING_PAGE_MAX, LIVING_UNMARKED_EVENT, livingMark, livingPage } from '../living-posts';
import { bannedSql } from '../views';
import { idempotency, numberParam, writer } from './content';

function noteField(body: Record<string, unknown>): string | null {
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string') throw new HttpError(400, 'invalid_note');
  const value = body.note.replace(/\s+/g, ' ').trim();
  if (value.length > LIVING_NOTE_MAX) throw new HttpError(400, 'note_too_long', { max_length: LIVING_NOTE_MAX, length: value.length });
  return value || null;
}

interface PostState { id: string; author_id: string; status: string; withdrawn_at: string | null; banned: number }

const postState = (c: Ctx, number: number) => c.env.DB.prepare(`SELECT p.id, p.author_id, p.status, p.withdrawn_at, ${bannedSql('p.author_id')} AS banned
  FROM posts p WHERE p.number = ?`).bind(number).first<PostState>();

async function livingView(c: Ctx, number: number) {
  return { post_number: number, living: await livingMark(c.env, number) };
}

export async function markLiving(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const number = numberParam(c.params[0]);
  const body = await readJson(c.request);
  const note = noteField(body);
  const row = await postState(c, number);
  if (!row) throw new HttpError(404, 'post_not_found');
  const ref = `post-${number}`;
  if (row.banned) throw goneError('content_gone', { ref });
  const mine = row.author_id === p.account.id;
  if (!mine && !isAdmin(p)) throw new HttpError(403, 'not_your_content', { ref, reason: 'only the author or an admin can mark it living' });
  const role: 'author' | 'admin' = mine ? 'author' : 'admin';
  const objectType = 'post.living';
  const idem = await idempotency(c, p, objectType, { number, note });
  if (idem.existing) return json(200, await livingView(c, number));
  if (row.status !== 'visible') throw new HttpError(409, 'content_hidden', { ref, reason: 'hidden content cannot be marked living' });
  if (row.withdrawn_at) throw new HttpError(409, 'already_withdrawn', { ref, withdrawn_at: row.withdrawn_at });

  const release = await reserveDayBucket(c.env, 'living', p.account.id, settings['limits.daily.living']);
  const at = nowIso();
  const markId = `living_${crypto.randomUUID()}`;
  const db = c.env.DB;
  // The INSERT only writes when the post is still visible and not withdrawn (same guard as the checks above);
  // the event, idempotency key and cache bump only write when this request's row exists afterwards
  // (guarded on the mark id this request created, or the post's living row for a re-mark).
  const marked = 'EXISTS (SELECT 1 FROM living_posts WHERE post_number = ?2)';
  const markedGuard = { sql: 'EXISTS (SELECT 1 FROM living_posts WHERE post_number = ?2)', value: number };
  let changed = 0;
  try {
    const [insert] = await db.batch([
      db.prepare(`INSERT INTO living_posts (id, post_number, marked_by_id, actor_role, note, created_at, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6 WHERE EXISTS (SELECT 1 FROM posts WHERE number = ?2 AND status = 'visible' AND withdrawn_at IS NULL)
        ON CONFLICT(post_number) DO UPDATE SET marked_by_id = excluded.marked_by_id, actor_role = excluded.actor_role,
          note = excluded.note, updated_at = excluded.updated_at`).bind(markId, number, p.account.id, role, note, at),
      db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at)
        SELECT '${LIVING_MARKED_EVENT}', 'post', ?2, ?3, json_object('note', ?4, 'role', ?5), ?6 WHERE ${marked}`)
        .bind(markId, number, p.account.id, note, role, at),
      ...(idem.key ? [db.prepare(`INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at)
        SELECT ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM living_posts WHERE post_number = ?8)`).bind(markId, p.account.id, idem.key, idem.hash, objectType, row.id, at, number)] : []),
      bumpContentCacheVersion(db, markedGuard),
    ]);
    changed = insert.meta.changes ?? 0;
  } catch (error) {
    await release();
    if (idem.key && String(error).includes('UNIQUE')) {
      const replay = await idempotency(c, p, objectType, { number, note });
      if (replay.existing) return json(200, await livingView(c, number));
    }
    throw error;
  }
  if (!changed) {
    await release();
    const now = await postState(c, number);
    if (now && now.status !== 'visible') throw new HttpError(409, 'content_hidden', { ref, reason: 'hidden content cannot be marked living' });
    if (now?.withdrawn_at) throw new HttpError(409, 'already_withdrawn', { ref, withdrawn_at: now.withdrawn_at });
    throw new HttpError(409, 'content_hidden', { ref, reason: 'the post changed while it was being marked; read it again' });
  }
  return json(200, await livingView(c, number));
}

export async function unmarkLiving(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const number = numberParam(c.params[0]);
  await readJson(c.request).catch(() => ({}));
  const row = await postState(c, number);
  if (!row) throw new HttpError(404, 'post_not_found');
  const ref = `post-${number}`;
  if (row.banned) throw goneError('content_gone', { ref });
  const mine = row.author_id === p.account.id;
  if (!mine && !isAdmin(p)) throw new HttpError(403, 'not_your_content', { ref, reason: 'only the author or an admin can take it out of the registry' });
  const role: 'author' | 'admin' = mine ? 'author' : 'admin';
  const objectType = 'post.living.revoke';
  const idem = await idempotency(c, p, objectType, { number });
  if (idem.existing) return json(200, await livingView(c, number));
  const existing = await livingMark(c.env, number);
  if (!existing) throw new HttpError(404, 'living_not_found', { ref, reason: 'the post is not in the living registry' });

  const release = await reserveDayBucket(c.env, 'living', p.account.id, settings['limits.daily.living']);
  const at = nowIso();
  const db = c.env.DB;
  let changed = 0;
  try {
    const [del] = await db.batch([
      db.prepare('DELETE FROM living_posts WHERE post_number = ?1').bind(number),
      db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at)
        SELECT '${LIVING_UNMARKED_EVENT}', 'post', ?1, ?2, json_object('role', ?3), ?4 WHERE changes() = 1`)
        .bind(number, p.account.id, role, at),
      ...(idem.key ? [db.prepare(`INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1`).bind(p.account.id, idem.key, idem.hash, objectType, row.id, at)] : []),
      // unguarded on purpose: the mark was verified above; a lost race only bumps the version with no visible change
      bumpContentCacheVersion(db),
    ]);
    changed = del.meta.changes ?? 0;
  } catch (error) {
    await release();
    if (idem.key && String(error).includes('UNIQUE')) {
      const replay = await idempotency(c, p, objectType, { number });
      if (replay.existing) return json(200, await livingView(c, number));
    }
    throw error;
  }
  if (!changed) {
    await release();
    throw new HttpError(404, 'living_not_found', { ref, reason: 'the post is not in the living registry' });
  }
  return json(200, await livingView(c, number));
}

/** GET /v1/living?offset=&limit=: the public registry of living posts, most recently marked or updated first. */
export async function listLiving(c: Ctx): Promise<Response> {
  const offset = intParam(c.url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.url, 'limit', LIVING_PAGE_MAX, 1, LIVING_PAGE_MAX);
  return json(200, await livingPage(c.env, offset, limit));
}
