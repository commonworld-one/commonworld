import type { ReadCtx, Handler } from './context';
import { HttpError, decodePathParam, goneError, intParam, json } from './http';
import { WITHDRAWN_TITLE, accountView, citizenPath, shownCommentSql, shownPostSql } from './views';
import type { AccountRow } from './auth';
import { hmacHex } from './crypto';

export const THREADS_PAGE_MAX = 100;
const MAX_ID = 999_999_999_999_999;
const VIEWS = ['threads', 'post_replies', 'comment_replies'] as const;
export type ThreadsView = typeof VIEWS[number];
export const THREADS_PARAMS = ['view', 'unanswered', 'before', 'through', 'limit', 'snapshot'];
export const THREADS_NOTE = 'Unanswered means no visible, non-withdrawn direct reply from this account. Later participation elsewhere does not answer a reply. This is a public conversation view, not a private inbox or a read receipt.';
export const threadsPath = (handle: string) => `/c/${encodeURIComponent(handle)}/threads`;
export const threadsApiPath = (handle: string) => `/v1/accounts/${encodeURIComponent(handle)}/threads`;

interface Author { handle: string; kind: string; url: string }
interface Reply { number: number; ref: string; url: string; parent_number: number | null; created_at: string; author: Author }
interface Row {
  number: number; title: string; withdrawn_at: string | null; activity_id: number;
  reply_number: number | null; reply_parent: number | null; reply_at: string | null; reply_handle: string | null; reply_kind: string | null;
  oldest_number: number | null; oldest_parent: number | null; oldest_at: string | null; oldest_handle: string | null; oldest_kind: string | null;
  unanswered_count: number;
}

const reply = (number: number | null, parent: number | null, at: string | null, handle: string | null, kind: string | null): Reply | null =>
  number === null ? null : { number, ref: `comment-${number}`, url: `/comments/${number}`, parent_number: parent, created_at: at!, author: { handle: handle!, kind: kind!, url: citizenPath(handle!) } };

/** One public reader for JSON and both twins, including when a staff key is supplied. */
export async function accountThreadsData(c: ReadCtx) {
  for (const key of c.url.searchParams.keys()) if (!THREADS_PARAMS.includes(key)) throw new HttpError(400, 'invalid_query_parameter', { parameter: key.slice(0, 64), reason: 'unknown_parameter', allowed: THREADS_PARAMS });
  const view = c.url.searchParams.get('view') ?? 'threads';
  if (!VIEWS.includes(view as ThreadsView)) throw new HttpError(400, 'invalid_query_parameter', { parameter: 'view', allowed: VIEWS });
  const unanswered = c.url.searchParams.get('unanswered') ?? '0';
  if (unanswered !== '0' && unanswered !== '1') throw new HttpError(400, 'invalid_query_parameter', { parameter: 'unanswered' });
  const limit = intParam(c.url, 'limit', 50, 1, THREADS_PAGE_MAX);
  const before = intParam(c.url, 'before', MAX_ID, 0, MAX_ID);
  const requestedThrough = intParam(c.url, 'through', MAX_ID, 0, MAX_ID);
  const suppliedSnapshot = c.url.searchParams.get('snapshot');
  if ((suppliedSnapshot !== null && (!/^[0-9a-f]{64}$/.test(suppliedSnapshot) || !c.url.searchParams.has('through'))) ||
      (before !== MAX_ID && before !== 0 && suppliedSnapshot === null))
    throw new HttpError(400, 'invalid_query_parameter', { parameter: 'snapshot', reason: 'follow_next_verbatim' });
  const handle = decodePathParam(c.params[0], () => new HttpError(404, 'account_not_found')).toLowerCase();
  const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE handle = ?').bind(handle).first<AccountRow>();
  if (!account) throw new HttpError(404, 'account_not_found');
  if (account.status === 'disabled') throw goneError('account_gone');
  const head = await c.env.DB.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS n").first<{ n: number }>();
  const through = Math.min(requestedThrough, head?.n ?? 0);

  // A shared event-ID high-water mark spans post and comment number spaces. The CTEs
  // exclude later participation as well as later replies, so new writes cannot reorder a walk.
  // Visibility is current. A revision guard below rejects stale walks instead of silently rekeying them.
  // Deletion removes the post author's creation event but retains a neutral stub for others'
  // comments. The LEFT JOIN keeps that stub; its visible replies supply the activity ID.
  const common = `WITH
    candidates AS (SELECT number FROM posts WHERE author_id = ?2 UNION SELECT post_number FROM comments WHERE author_id = ?2),
    vp AS (SELECT p.*, COALESCE(pe.seq, 0) AS activity_id FROM posts p LEFT JOIN events pe ON pe.type = 'post.created' AND pe.object_number = p.number
      WHERE p.number IN (SELECT number FROM candidates) AND (pe.seq <= ?1 OR pe.seq IS NULL) AND ${shownPostSql('p')}),
    vc AS (SELECT c.*, ce.seq AS activity_id, a.handle, a.kind FROM comments c
      JOIN events ce ON ce.type = 'comment.created' AND ce.object_number = c.number
      JOIN accounts a ON a.id = c.author_id
      WHERE c.post_number IN (SELECT number FROM candidates) AND ce.seq <= ?1 AND ${shownCommentSql('c')}),
    joined AS (SELECT p.number FROM vp p WHERE p.author_id = ?2
      UNION SELECT c.post_number FROM vc c WHERE c.author_id = ?2),
    incoming AS (SELECT c.*, CASE WHEN c.parent_number IS NULL THEN 'post_replies' ELSE 'comment_replies' END AS bucket
      FROM vc c JOIN posts p ON p.number = c.post_number
      WHERE c.author_id <> ?2 AND c.withdrawn_at IS NULL AND
        ((c.parent_number IS NULL AND p.author_id = ?2) OR EXISTS (SELECT 1 FROM vc parent WHERE parent.number = c.parent_number AND parent.author_id = ?2))),
    unanswered AS (SELECT i.* FROM incoming i WHERE NOT EXISTS
      (SELECT 1 FROM vc answer WHERE answer.parent_number = i.number AND answer.author_id = ?2 AND answer.withdrawn_at IS NULL)),
    oldest AS (SELECT * FROM (SELECT u.*, ROW_NUMBER() OVER (PARTITION BY post_number ORDER BY number) AS rn FROM unanswered u) WHERE rn = 1),
    latest AS (SELECT * FROM (SELECT c.*, ROW_NUMBER() OVER (PARTITION BY post_number ORDER BY activity_id DESC) AS rn FROM vc c) WHERE rn = 1)`;
  const isThreads = view === 'threads';
  const selected = isThreads
    ? `SELECT p.number, p.title, p.withdrawn_at, COALESCE(r.activity_id, p.activity_id) AS activity_id,
        r.number AS reply_number, r.parent_number AS reply_parent, r.created_at AS reply_at, r.handle AS reply_handle, r.kind AS reply_kind,
        o.number AS oldest_number, o.parent_number AS oldest_parent, o.created_at AS oldest_at, o.handle AS oldest_handle, o.kind AS oldest_kind,
        (SELECT COUNT(*) FROM unanswered u WHERE u.post_number = p.number) AS unanswered_count
      FROM vp p JOIN joined j ON j.number = p.number LEFT JOIN latest r ON r.post_number = p.number LEFT JOIN oldest o ON o.post_number = p.number
      WHERE COALESCE(r.activity_id, p.activity_id) < ?3 ${unanswered === '1' ? 'AND o.number IS NOT NULL' : ''}
      ORDER BY activity_id DESC LIMIT ?4`
    : `SELECT p.number, p.title, p.withdrawn_at, r.number AS activity_id,
        r.number AS reply_number, r.parent_number AS reply_parent, r.created_at AS reply_at, r.handle AS reply_handle, r.kind AS reply_kind,
        o.number AS oldest_number, o.parent_number AS oldest_parent, o.created_at AS oldest_at, o.handle AS oldest_handle, o.kind AS oldest_kind,
        (SELECT COUNT(*) FROM unanswered u WHERE u.number = r.number) AS unanswered_count
      FROM ${unanswered === '1' ? 'unanswered' : 'incoming'} r JOIN posts p ON p.number = r.post_number LEFT JOIN unanswered o ON o.number = r.number
      WHERE r.bucket = ?5 AND r.number < ?3 ORDER BY r.number DESC LIMIT ?4`;
  const statement = c.env.DB.prepare(`${common} ${selected}`);
  // All production hide/restore/status/deletion writes append moderation_actions in the same
  // D1 batch; withdrawal appends content.withdrawn. Creation is bounded by through instead.
  // Read guard + page in one transaction. Never expose private moderation IDs or their counts.
  // Conservative global invalidation is observable (including unrelated staff actions).
  interface Revision { moderation: number; withdrawal: number }
  const [revisionResult, pageResult] = await c.env.DB.batch<Row | Revision>([
    c.env.DB.prepare(`SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'moderation_actions'), 0) AS moderation,
      COALESCE((SELECT MAX(seq) FROM events WHERE type = 'content.withdrawn'), 0) AS withdrawal`),
    isThreads ? statement.bind(through, account.id, before, limit + 1) : statement.bind(through, account.id, before, limit + 1, view),
  ]);
  const revision = revisionResult.results[0] as Revision;
  const snapshot = await hmacHex(c.env.KEY_PEPPER, JSON.stringify(['account-threads-v1', account.id, view, unanswered, through, revision.moderation, revision.withdrawal]));
  if (suppliedSnapshot !== null && suppliedSnapshot !== snapshot)
    throw new HttpError(409, 'threads_cursor_invalidated', {
      reason: 'visibility_may_have_changed',
      restart: `${threadsApiPath(account.handle)}?${new URLSearchParams({ view, unanswered, limit: String(limit) })}`,
    });
  const rows = pageResult as D1Result<Row>;
  const now = Date.now();
  const items = rows.results.slice(0, limit).map(row => {
    const last = reply(row.reply_number, row.reply_parent, row.reply_at, row.reply_handle, row.reply_kind);
    const oldest = reply(row.oldest_number, row.oldest_parent, row.oldest_at, row.oldest_handle, row.oldest_kind);
    return {
      post: { number: row.number, ref: `post-${row.number}`, url: `/posts/${row.number}`, title: row.withdrawn_at ? WITHDRAWN_TITLE : row.title },
      activity_id: row.activity_id,
      ...(isThreads ? { last_reply: last, you_replied_last: last?.author.handle === account.handle } : { reply: last!, unanswered: row.unanswered_count > 0 }),
      oldest_unanswered_reply: oldest,
      oldest_unanswered_age_seconds: oldest ? Math.max(0, Math.floor((now - Date.parse(oldest.created_at)) / 1000)) : null,
    };
  });
  const nextBefore = rows.results.length > limit ? rows.results[limit - 1].activity_id : null;
  const query = new URLSearchParams({ view, unanswered, limit: String(limit), through: String(through), snapshot });
  if (nextBefore !== null) query.set('before', String(nextBefore));
  return { account: accountView(account), view: view as ThreadsView, unanswered: unanswered === '1', through, snapshot, limit, items, has_more: nextBefore !== null, next_before: nextBefore,
    next: nextBefore === null ? null : `${threadsApiPath(account.handle)}?${query}`, note: THREADS_NOTE };
}

export const getAccountThreads: Handler = async c => json(200, await accountThreadsData(c));
