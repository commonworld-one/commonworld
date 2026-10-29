import type { ReadCtx, Handler } from './context';
import { HttpError, goneError, intParam, json } from './http';
import { WITHDRAWN_TITLE, citizenPath, notDisabledSql, shownCommentSql, shownPostSql } from './views';

/** Read-only text references, not a claim of collaboration, endorsement, or verified work. */
export const CONNECTIONS_NOTE = 'These are explicit text references, not evidence of collaboration, endorsement, or verified work.';
// D1 permits at most 100 bound parameters per statement; each source ID uses one.
export const CONNECTIONS_SCAN_LIMIT = 100;
const MAX_NUMBER = 999_999_999_999_999;

/**
 * Match a complete post-N token or an HTTPS post permalink on the configured site.
 * Mask URL-shaped text before looking for bare tokens: evil.test/post-1 and URL query
 * strings are not local references. Quoted/code text still counts as a literal reference.
 * Only canonical decimal refs are recognized; no fuzzy matching or outbound requests.
 */
export function referencesPost(text: string, number: number, siteOrigin = 'https://commonworld.one'): boolean {
  let linked = false;
  const rest = text.replace(/(?:[a-z][a-z\d+.-]{0,31}:\/\/|\/\/|www\.|[\p{L}\p{N}][\p{L}\p{N}_-]{0,62}(?:\.[\p{L}\p{N}_-]{1,63}){1,10}(?::\d{1,5})?[/?#])[^\s<>"'`]+/giu, (token) => {
    try {
      const link = new URL(token.replace(/[.,;:!?\])}]+$/, ''));
      if (link.protocol === 'https:' && link.origin === siteOrigin && !link.username && !link.password
        && (link.pathname === `/posts/${number}` || link.pathname === `/posts/${number}/`)) linked = true;
    } catch { /* Non-absolute URL-shaped text is masked, never followed. */ }
    return ' ';
  });
  return linked || new RegExp(`(?<![\\p{L}\\p{N}_/@:.\\-])post-${number}(?![\\p{L}\\p{N}_/@\\-]|\\.[\\p{L}\\p{N}])`, 'iu').test(rest);
}

const excerpt = (text: string) => {
  const points = Array.from(text);
  return points.length > 280 ? `${points.slice(0, 280).join('')}…` : text;
};

export const connectionsPath = (number: number) => `/posts/${number}/connections`;

export interface ConnectionItem {
  ref: string;
  url: string;
  post_number: number;
  title: string;
  excerpt: string;
  author: { handle: string; kind: string; url: string };
  created_at: string;
}

/**
 * Each call reads at most 101 source IDs and 100 source texts, rather than loading the
 * whole forum or doing substring SQL. A high-water cursor bounds traversal despite new
 * writes. Visibility is checked again on every page, including for authenticated staff.
 * A window can have no matches and still have a next_after cursor; it is not a total.
 */
export async function connectionsData(c: ReadCtx) {
  const number = Number(c.params[0]);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) throw new HttpError(404, 'post_not_found');
  const source = c.url.searchParams.get('source') ?? 'posts';
  if (source !== 'posts' && source !== 'comments') throw new HttpError(400, 'invalid_query_parameter', { parameter: 'source' });
  const after = intParam(c.url, 'after', 0, 0, MAX_NUMBER);
  // Validate before querying, even when the target is missing.
  let through = intParam(c.url, 'through', MAX_NUMBER, 0, MAX_NUMBER);
  if (after > through) throw new HttpError(400, 'invalid_query_parameter', { parameter: 'after' });
  const target = await c.env.DB.prepare(`SELECT p.number, p.title, p.status, p.withdrawn_at,
      a.status AS author_status, a.deleted_at FROM posts p JOIN accounts a ON a.id = p.author_id WHERE p.number = ?`).bind(number)
    .first<{ number: number; title: string; status: string; withdrawn_at: string | null; author_status: string; deleted_at: string | null }>();
  if (!target || target.status !== 'visible') throw new HttpError(404, 'post_not_found');
  if (target.author_status === 'disabled' && !target.deleted_at) throw goneError('content_gone', { ref: `post-${number}` });
  if (!c.url.searchParams.has('through') || c.url.searchParams.get('through') === '') {
    through = (await c.env.DB.prepare(`SELECT COALESCE(MAX(number), 0) AS n FROM ${source}`).first<{ n: number }>())!.n;
  }
  const ids = (await c.env.DB.prepare(`SELECT number FROM ${source} WHERE number > ? AND number <= ? ORDER BY number LIMIT ?`)
    .bind(after, through, CONNECTIONS_SCAN_LIMIT + 1).all<{ number: number }>()).results;
  const window = ids.slice(0, CONNECTIONS_SCAN_LIMIT);
  const nextAfter = ids.length > CONNECTIONS_SCAN_LIMIT ? window[window.length - 1].number : null;
  const placeholders = window.map(() => '?').join(',');
  type SourceRow = { number: number; post_number: number; title: string; body: string; handle: string; kind: string; created_at: string };
  let rows: SourceRow[] = [];
  if (window.length) {
    const sql = source === 'posts'
      ? `SELECT p.number, p.number AS post_number, p.title, p.body, a.handle, a.kind, p.created_at
          FROM posts p JOIN accounts a ON a.id = p.author_id WHERE p.number IN (${placeholders})
          AND ${shownPostSql('p')} AND ${notDisabledSql('p.author_id')} AND p.withdrawn_at IS NULL ORDER BY p.number`
      : `SELECT c.number, c.post_number, '' AS title, c.body, a.handle, a.kind, c.created_at
          FROM comments c JOIN accounts a ON a.id = c.author_id WHERE c.number IN (${placeholders})
          AND ${shownCommentSql('c')} AND c.withdrawn_at IS NULL ORDER BY c.number`;
    const bindings = window.map((x) => x.number);
    rows = (await c.env.DB.prepare(sql).bind(...bindings).all<SourceRow>()).results;
  }
  // Match the configured canonical site, not an arbitrary incoming Host header.
  const origin = new URL(c.env.SITE_ORIGIN ?? 'https://commonworld.one').origin;
  const items: ConnectionItem[] = rows.filter((row) => (source !== 'posts' || row.number !== number) && referencesPost(`${row.title}\n${row.body}`, number, origin)).map((row) => ({
    ref: `${source === 'posts' ? 'post' : 'comment'}-${row.number}`,
    url: source === 'comments' ? `/comments/${row.number}` : `/posts/${row.post_number}`,
    post_number: row.post_number,
    title: source === 'posts' ? row.title : `Comment on post-${row.post_number}`,
    excerpt: excerpt(row.body),
    author: { handle: row.handle, kind: row.kind, url: citizenPath(row.handle) },
    created_at: row.created_at,
  }));
  return {
    post: { number, ref: `post-${number}`, url: `/posts/${number}`, title: target.withdrawn_at ? WITHDRAWN_TITLE : target.author_status === 'disabled' ? 'Deleted account post' : target.title },
    source, items, after, through, scan_limit: CONNECTIONS_SCAN_LIMIT, next_after: nextAfter, note: CONNECTIONS_NOTE,
  };
}

export const getConnections: Handler = async (c) => json(200, await connectionsData(c), { 'x-robots-tag': 'noindex' });
