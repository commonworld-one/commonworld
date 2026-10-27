/**
 * Decisions of a living post (src/post-decisions.ts, migration 0024).
 *   GET  /v1/posts/{n}/decisions?after=&limit=   public, oldest first, paged (follow next_after)
 *   POST /v1/posts/{n}/decisions                 {"summary": "...", "why"?: "...", "comment"?: N, "supersedes"?: N}
 *
 * Who may write: the post's author, or an active admin (403 not_your_content otherwise). Frozen / disabled accounts and
 * Lock mode are refused like every write; Idempotency-Key as other writes; at most setting limits.daily.decision per
 * account per UTC day (default 30; 429 daily_limit_exceeded, kind decision; refused calls use no quota). A post whose
 * author is banned (disabled, not deleted) is 410 content_gone for writes as for reads (postGone), even for an admin.
 *
 * Refused:
 *   400 invalid_summary / summary_too_long      summary missing or empty / longer than DECISION_SUMMARY_MAX (never cut)
 *   400 invalid_why / why_too_long              why not a string / longer than DECISION_WHY_MAX
 *   400 invalid_comment / comment_not_on_post   comment not a positive integer / not a public comment of this post
 *   400 invalid_supersedes / decision_not_found supersedes not a positive integer / no such decision on this post
 *   409 already_superseded                      that decision was already superseded (supersede the current one)
 *   422 link_flagged / 400 too_many_link_domains   link check of summary + why (src/link-check.ts), as posts and comments
 *   404 post_not_found, 410 content_gone, 409 content_hidden, 409 already_withdrawn   as section moves
 */
import type { Ctx } from '../context';
import type { Env } from '../env';
import { WITHDRAWN_TITLE } from '../views';
import { isAdmin } from '../auth';
import { HttpError, goneError, intParam, json, nowIso, readJson } from '../http';
import { reserveDayBucket } from '../limits';
import { assertLinksSafe } from '../link-check';
import { bumpContentCacheVersion } from '../cache-version';
import {
  DECISIONS_PAGE_MAX, DECISION_EVENT, DECISION_SUMMARY_MAX, DECISION_WHY_MAX,
  decisionByNumber, decisionsPage,
} from '../post-decisions';
import { bannedSql } from '../views';
import { idempotency, numberParam, writer } from './content';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function summaryField(body: Record<string, unknown>): string {
  if (typeof body.summary !== 'string' || !oneLine(body.summary)) throw new HttpError(400, 'invalid_summary');
  const v = oneLine(body.summary);
  if (v.length > DECISION_SUMMARY_MAX) throw new HttpError(400, 'summary_too_long', { max_length: DECISION_SUMMARY_MAX, length: v.length });
  return v;
}

function whyField(body: Record<string, unknown>): string | null {
  if (body.why === undefined || body.why === null) return null;
  if (typeof body.why !== 'string') throw new HttpError(400, 'invalid_why');
  const v = body.why.replace(/\r\n/g, '\n').trim();
  if (v.length > DECISION_WHY_MAX) throw new HttpError(400, 'why_too_long', { max_length: DECISION_WHY_MAX, length: v.length });
  return v || null;
}

function numberField(body: Record<string, unknown>, name: 'comment' | 'supersedes'): number | null {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new HttpError(400, `invalid_${name}`);
  return v;
}

interface PostState { title: string; id: string; author_id: string; status: string; withdrawn_at: string | null; banned: number; author_disabled: number; deleted_at: string | null }

const postState = (c: { env: Env }, number: number) => c.env.DB.prepare(`SELECT p.title, p.id, p.author_id, p.status, p.withdrawn_at, ${bannedSql('p.author_id')} AS banned,
    a.status = 'disabled' AS author_disabled, a.deleted_at
  FROM posts p JOIN accounts a ON a.id = p.author_id WHERE p.number = ?`).bind(number).first<PostState>();

/** 410 for reads and writes alike: the author is banned (disabled and not deleted; a deleted account's post stays). */
const postGone = (row: PostState): boolean => !!row.banned || (!!row.author_disabled && !row.deleted_at);

/** The public post a decision list belongs to (404 hidden or missing, 410 banned author), as connections. */
async function publicPost(c: { env: Env }, number: number) {
  const row = await postState(c, number);
  if (!row || row.status !== 'visible') throw new HttpError(404, 'post_not_found');
  if (postGone(row)) throw goneError('content_gone', { ref: `post-${number}` });
  return row;
}

/**
 * Shared by the API, the HTML page and the Markdown twin (one read path, one set of visibility rules). Only the API
 * reads `limit`: the pages are edge-cached under `after` alone (PAGE_CACHE_PARAMS in src/pages/router.ts), so they
 * always show full pages of DECISIONS_PAGE_MAX and a `?limit=` can never put a short page in the shared cache.
 */
export async function decisionsData(env: Env, url: URL, param: string, opts: { api?: boolean } = {}) {
  const number = numberParam(param);
  const after = intParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = opts.api ? intParam(url, 'limit', DECISIONS_PAGE_MAX, 1, DECISIONS_PAGE_MAX) : DECISIONS_PAGE_MAX;
  const post = await publicPost({ env }, number);
  const page = await decisionsPage(env, number, after, limit);
  return { ...page, after, post: { number, ref: `post-${number}`, url: `/posts/${number}`, title: post.withdrawn_at ? WITHDRAWN_TITLE : post.title } };
}

export async function listDecisions(c: Ctx): Promise<Response> {
  const { post: _post, after: _after, ...page } = await decisionsData(c.env, c.url, c.params[0], { api: true });
  return json(200, page);
}

export async function recordDecision(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const number = numberParam(c.params[0]);
  const body = await readJson(c.request);
  const summary = summaryField(body);
  const why = whyField(body);
  const comment = numberField(body, 'comment');
  const supersedes = numberField(body, 'supersedes');
  const row = await postState(c, number);
  if (!row) throw new HttpError(404, 'post_not_found');
  const ref = `post-${number}`;
  // same rule as the read path: records nobody could read are never written
  if (postGone(row)) throw goneError('content_gone', { ref });
  const mine = row.author_id === p.account.id;
  if (!mine && !isAdmin(p)) throw new HttpError(403, 'not_your_content', { ref, reason: 'only the author or an admin can record a decision' });
  const role: 'author' | 'admin' = mine ? 'author' : 'admin';
  const objectType = 'post.decision';
  const idem = await idempotency(c, p, objectType, { number, summary, why, comment, supersedes });
  if (idem.existing) {
    const found = await c.env.DB.prepare('SELECT number FROM post_decisions WHERE id = ?').bind(idem.existing).first<{ number: number }>();
    if (found) return json(200, await decisionByNumber(c.env, found.number));
  }
  if (row.status !== 'visible') throw new HttpError(409, 'content_hidden', { ref, reason: 'hidden content takes no decisions' });
  if (row.withdrawn_at) throw new HttpError(409, 'already_withdrawn', { ref, withdrawn_at: row.withdrawn_at });

  const db = c.env.DB;
  if (comment !== null) {
    const ok = await db.prepare(`SELECT 1 AS ok FROM comments c JOIN accounts a ON a.id = c.author_id WHERE c.number = ? AND c.post_number = ?
      AND c.status = 'visible' AND c.withdrawn_at IS NULL AND a.status <> 'disabled'`).bind(comment, number).first<{ ok: number }>();
    if (!ok) throw new HttpError(400, 'comment_not_on_post', { ref, comment });
  }
  if (supersedes !== null) {
    const old = await db.prepare(`SELECT d.number, EXISTS (SELECT 1 FROM post_decisions n WHERE n.supersedes = d.number) AS taken
      FROM post_decisions d WHERE d.number = ? AND d.post_number = ?`).bind(supersedes, number).first<{ number: number; taken: number }>();
    if (!old) throw new HttpError(400, 'decision_not_found', { ref, supersedes });
    if (old.taken) throw new HttpError(409, 'already_superseded', { ref, supersedes, reason: 'supersede the current decision instead' });
  }

  // public text: the same link check as posts, comments and porch lines, before any quota is used (422 link_flagged,
  // 400 too_many_link_domains; nothing written)
  await assertLinksSafe(c.env, p.account.id, 'decision', why === null ? [summary] : [summary, why]);
  const release = await reserveDayBucket(c.env, 'decision', p.account.id, settings['limits.daily.decision']);
  const at = nowIso();
  const id = `decision_${crypto.randomUUID()}`;
  const written = 'EXISTS (SELECT 1 FROM post_decisions WHERE id = ?1)';
  try {
    await db.batch([
      // the insert only lands while the post is still visible and not withdrawn (a hide in between writes nothing)
      db.prepare(`INSERT INTO post_decisions (id, post_number, summary, why, source_comment, supersedes, actor_id, actor_role, created_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM posts WHERE number = ?2 AND status = 'visible' AND withdrawn_at IS NULL)`)
        .bind(id, number, summary, why, comment, supersedes, p.account.id, role, at),
      db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at)
        SELECT '${DECISION_EVENT}', 'post', ?2, ?3, json_object('decision', (SELECT number FROM post_decisions WHERE id = ?1), 'summary', ?4, 'supersedes', ?5, 'role', ?6), ?7 WHERE ${written}`)
        .bind(id, number, p.account.id, summary, supersedes, role, at),
      ...(idem.key ? [db.prepare(`INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at)
        SELECT ?2, ?3, ?4, ?5, ?1, ?6 WHERE ${written}`).bind(id, p.account.id, idem.key, idem.hash, objectType, at)] : []),
      bumpContentCacheVersion(db, { sql: 'EXISTS (SELECT 1 FROM post_decisions WHERE id = ?2)', value: id }),
    ]);
  } catch (error) {
    await release();
    const text = String(error);
    // two requests superseding the same decision: the partial unique index lets only one land
    if (text.includes('UNIQUE') && text.includes('supersedes')) throw new HttpError(409, 'already_superseded', { ref, supersedes });
    if (idem.key && text.includes('UNIQUE')) {
      const replay = await idempotency(c, p, objectType, { number, summary, why, comment, supersedes });
      const found = replay.existing && await db.prepare('SELECT number FROM post_decisions WHERE id = ?').bind(replay.existing).first<{ number: number }>();
      if (found) return json(200, await decisionByNumber(c.env, found.number));
    }
    throw error;
  }
  const made = await db.prepare('SELECT number FROM post_decisions WHERE id = ?').bind(id).first<{ number: number }>();
  if (!made) {
    await release();
    const now = await postState(c, number);
    if (now?.withdrawn_at) throw new HttpError(409, 'already_withdrawn', { ref, withdrawn_at: now.withdrawn_at });
    throw new HttpError(409, 'content_hidden', { ref, reason: 'hidden content takes no decisions' });
  }
  return json(201, await decisionByNumber(c.env, made.number));
}
