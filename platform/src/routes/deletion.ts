/**
 * Account deletion (Privacy v1 "Deleting your data"). Manual, by staff, in two steps:
 *   1. the owner writes to privacy@ and then proves ownership with their own key:
 *        POST /v1/me/deletion-request            -> records deletion_requested_at (idempotent)
 *   2. an admin deletes the account (only when step 1 happened in the last REQUEST_VALID_DAYS days):
 *        POST /v1/admin/accounts/{handle}/delete {"confirm_handle": "<handle>", "reason"?: "private note"}
 *
 * What step 2 does, in one D1 batch (all or nothing):
 *   - porch lines, votes given and votes received, API keys, browser sessions, login links, per-account limits,
 *     roles, daily counters and idempotency records of the account: deleted;
 *   - the account's comments: deleted, except a comment that has a reply by someone else somewhere below it — that
 *     one keeps its place as "[deleted]" (no text) so the other people's replies stay readable;
 *   - the account's posts: deleted, except a post with comments by others — it stays as a stub titled "[deleted]"
 *     with an empty body and no tags, so the other people's comments stay (Privacy promise: deleting your content
 *     does not delete theirs);
 *   - placeholders and stubs drop a withdraw reason too (it is the account's own words): they show "[deleted]";
 *   - section moves (migration 0023): records of posts that are deleted go with them, their post.moved events go,
 *     and any move reason the account wrote is cleared on the records that stay (from, to, role and time stay);
 *   - change-feed events that describe the account's own writing (post/comment/porch created, its withdrawals, votes it gave or got)
 *     are deleted; account.created stays (its actor now shows deleted-N); moderation records stay (they never held
 *     content), and staff-log entries that named the old handle are rewritten to deleted-N;
 *   - the account row stays (citizen-N refs and other people's history point at it) with handle `deleted-N`
 *     (N = citizen number), status `disabled`, not trusted, deleted_at set;
 *   - a public `account.deleted` event (actor = the admin) and a staff-log entry `account.delete`.
 */
import type { Ctx } from '../context';
import { requireAuth, requireRole } from '../auth';
import { HttpError, decodePathParam, json, nowIso, readJson } from '../http';
import { bumpContentCacheVersion } from '../cache-version';
import { recountStatements } from '../counters';
import { accountView } from '../views';
import { revokeAccountOAuth } from '../oauth/store';

export const REQUEST_VALID_DAYS = 60;
export const DELETED_TITLE = '[deleted]';
export const deletedHandle = (number: number) => `deleted-${number}`;

/** POST /v1/me/deletion-request — the owner's own-key confirmation (step 2 of the Privacy procedure). */
export async function requestDeletion(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const at = nowIso();
  await c.env.DB.prepare('UPDATE accounts SET deletion_requested_at = ? WHERE id = ?').bind(at, p.account.id).run();
  return json(200, {
    account: accountView(p.account), deletion_requested_at: at,
    next: 'Staff delete the account by hand within one month, as described in the Privacy policy (privacy@commonworld.one). Nothing is deleted yet; this call only confirms that the request comes from the key holder.',
  });
}

/** POST /v1/admin/accounts/{handle}/delete — admins only. */
export async function deleteAccount(c: Ctx): Promise<Response> {
  const p = requireRole(c.principal, 'admin');
  const handle = decodePathParam(c.params[0], () => new HttpError(404, 'account_not_found')).toLowerCase();
  const body = await readJson(c.request);
  if (typeof body.confirm_handle !== 'string' || body.confirm_handle.trim().toLowerCase() !== handle) {
    throw new HttpError(400, 'confirm_handle_mismatch', { reason: 'send confirm_handle equal to the handle in the path' });
  }
  const why = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) || null : null;
  const db = c.env.DB;
  const target = await db.prepare('SELECT * FROM accounts WHERE handle = ?').bind(handle).first<any>();
  if (!target) throw new HttpError(404, 'account_not_found');
  if (target.deleted_at) throw new HttpError(409, 'account_already_deleted');
  if (target.id === p.account.id) throw new HttpError(409, 'cannot_delete_own_account');
  if (await db.prepare('SELECT 1 FROM account_roles WHERE account_id = ?').bind(target.id).first()) throw new HttpError(409, 'revoke_roles_first');
  const requested = target.deletion_requested_at ? Date.parse(target.deletion_requested_at) : NaN;
  if (!Number.isFinite(requested) || Date.now() - requested > REQUEST_VALID_DAYS * 86_400_000) {
    throw new HttpError(409, 'deletion_not_confirmed', { reason: `the owner must call POST /v1/me/deletion-request with the account key first (valid ${REQUEST_VALID_DAYS} days)` });
  }
  const u = target.id as string;
  const newHandle = deletedHandle(target.number);
  if (await db.prepare('SELECT 1 FROM accounts WHERE handle = ?').bind(newHandle).first()) throw new HttpError(409, 'deleted_handle_taken', { handle: newHandle });

  // Comments of the account that have a reply by someone else anywhere below them stay as "[deleted]" placeholders.
  const { results: keepRows } = await db.prepare(`WITH RECURSIVE d(root, num) AS (
      SELECT number, number FROM comments WHERE author_id = ?1
      UNION ALL SELECT d.root, c.number FROM d JOIN comments c ON c.parent_number = d.num)
    SELECT DISTINCT d.root AS number FROM d JOIN comments c ON c.number = d.num WHERE c.author_id <> ?1`).bind(u).all<{ number: number }>();
  const keep = JSON.stringify(keepRows.map((r) => r.number));
  const counts = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM posts WHERE author_id = ?1) AS posts,
      (SELECT COUNT(*) FROM comments WHERE author_id = ?1) AS comments,
      (SELECT COUNT(*) FROM porch_lines WHERE author_id = ?1) AS porch,
      (SELECT COUNT(*) FROM votes WHERE voter_id = ?1) AS votes_given`).bind(u).first<{ posts: number; comments: number; porch: number; votes_given: number }>();
  const at = nowIso();
  const own = (type: string, table: string) =>
    `(object_type = '${type}' AND object_number IN (SELECT number FROM ${table} WHERE author_id = ?1))`;
  const out = await db.batch([
    db.prepare('PRAGMA defer_foreign_keys = true'),
    // feed events about the account's own writing (before the rows they point at go)
    db.prepare(`DELETE FROM events WHERE type IN ('post.created', 'comment.created', 'porch.created', 'vote.created', 'content.withdrawn', 'post.moved', 'post.decided') AND actor_id = ?1`).bind(u),
    // section moves (migration 0023): move events of the account's posts go; reasons the account wrote on kept
    // records are cleared (from, to, role and time stay); move records of posts that are deleted go with them below
    db.prepare(`DELETE FROM events WHERE type = 'post.moved' AND ${own('post', 'posts')}`).bind(u),
    db.prepare('UPDATE post_section_moves SET reason = NULL WHERE actor_id = ?1').bind(u),
    // post decisions (migration 0024): decision events of the account's posts go; text the account wrote on kept
    // records is redacted (number, role, time and the supersedes chain stay); records of deleted posts go below
    db.prepare(`DELETE FROM events WHERE type = 'post.decided' AND ${own('post', 'posts')}`).bind(u),
    db.prepare(`UPDATE post_decisions SET summary = '${DELETED_TITLE}', why = NULL WHERE actor_id = ?1`).bind(u),
    db.prepare(`DELETE FROM events WHERE type = 'vote.created' AND (${own('post', 'posts')} OR ${own('comment', 'comments')})`).bind(u),
    db.prepare('DELETE FROM votes WHERE voter_id = ?1 OR target_author_id = ?1').bind(u),
    // comments: placeholders for those with other people's replies below, the rest deleted
    db.prepare(`UPDATE comments SET body = '${DELETED_TITLE}', withdrawn_at = NULL, withdraw_reason = NULL WHERE author_id = ?1 AND number IN (SELECT value FROM json_each(?2))`).bind(u, keep),
    db.prepare('DELETE FROM comments WHERE author_id = ?1 AND number NOT IN (SELECT value FROM json_each(?2))').bind(u, keep),
    // posts: stubs where other people commented, the rest deleted. Every child row of a post that is deleted goes
    // first, and only after the account's comments are gone: a post whose only comments were the account's own is
    // deleted too, so its move records must go here, not before the comments (else the deferred FK fails the batch)
    db.prepare('DELETE FROM post_tags WHERE post_number IN (SELECT number FROM posts WHERE author_id = ?1)').bind(u),
    db.prepare('DELETE FROM post_decisions WHERE post_number IN (SELECT number FROM posts WHERE author_id = ?1 AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.post_number = posts.number))').bind(u),
    db.prepare('DELETE FROM post_section_moves WHERE post_number IN (SELECT number FROM posts WHERE author_id = ?1 AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.post_number = posts.number))').bind(u),
    db.prepare(`UPDATE posts SET title = '${DELETED_TITLE}', body = '', withdrawn_at = NULL, withdraw_reason = NULL WHERE author_id = ?1 AND EXISTS (SELECT 1 FROM comments c WHERE c.post_number = posts.number)`).bind(u),
    db.prepare('DELETE FROM posts WHERE author_id = ?1 AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.post_number = posts.number)').bind(u),
    db.prepare('DELETE FROM porch_lines WHERE author_id = ?1').bind(u),
    // credentials, sessions, counters; connected apps (OAuth grants, their tokens and codes)
    ...revokeAccountOAuth(db, u, 'account'),
    db.prepare('DELETE FROM oauth_grants WHERE account_id = ?1').bind(u),
    ...['api_keys', 'sessions', 'login_links', 'account_limits', 'account_roles', 'daily_usage', 'idempotency_keys', 'link_checks', 'linked_identities', 'recovery_codes', 'recovery_requests']
      .map((t) => db.prepare(`DELETE FROM ${t} WHERE account_id = ?1`).bind(u)),
    // staff log entries that named the old handle
    db.prepare("UPDATE moderation_actions SET target_ref = ?2 WHERE target_type = 'account' AND target_ref = ?1 COLLATE NOCASE").bind(target.handle, newHandle),
    db.prepare("UPDATE accounts SET handle = ?2, status = 'disabled', trusted = 0, frozen_batch_id = NULL, deleted_at = ?3 WHERE id = ?1").bind(u, newHandle, at),
    db.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(p.account.id, 'account.delete', 'account', newHandle, why, JSON.stringify({ requested_at: target.deletion_requested_at, ...counts, placeholders: keepRows.length }), at),
    db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) VALUES ('account.deleted', 'account', ?, ?, ?, ?) RETURNING seq")
      .bind(target.number, p.account.id, JSON.stringify({ handle: newHandle }), at),
    bumpContentCacheVersion(db),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  const seq = (out.find((r) => (r.results?.[0] as any)?.seq !== undefined)!.results[0] as { seq: number }).seq;
  const after = await db.prepare(`SELECT (SELECT COUNT(*) FROM posts WHERE author_id = ?1) AS post_stubs,
      (SELECT COUNT(*) FROM comments WHERE author_id = ?1) AS comment_placeholders`).bind(u).first<{ post_stubs: number; comment_placeholders: number }>();
  return json(200, {
    account: { number: target.number, ref: `citizen-${target.number}`, handle: newHandle, status: 'disabled', deleted_at: at },
    removed: { posts: (counts?.posts ?? 0) - (after?.post_stubs ?? 0), comments: (counts?.comments ?? 0) - (after?.comment_placeholders ?? 0), porch: counts?.porch ?? 0, votes_given: counts?.votes_given ?? 0 },
    kept_as_placeholders: { posts: after?.post_stubs ?? 0, comments: after?.comment_placeholders ?? 0 },
    event_seq: seq,
  });
}
