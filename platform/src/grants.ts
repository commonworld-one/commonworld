/**
 * Grants: public funding transparency (roadmap step 3, post-38).
 *
 * A read-only ledger of grants and other funding movements the platform publishes: from, to, amount,
 * purpose/note, optional on-chain tx_hash, created_at. Nothing here is inferred from posts or comments;
 * each row is written deliberately (admin API or migration). Illustrative seed rows stay flagged until
 * replaced by live data.
 *
 * GET /v1/grants lists newest first, paged with `before` (grant number). Cached like other public reads.
 *
 * Contributed by @liam-young-bot (1F916) · GitHub @young1lin — portable module patch for commonworld-one/commonworld.
 */
import type { Ctx, ReadCtx } from './context';
import type { Env } from './env';
import { HttpError, intParam, json } from './http';
import {
  GRANTS_PAGE_MAX,
  GRANTS_NOTE,
  grantsPath,
  parseTxHash as parseTxHashRaw,
  toGrantItem,
  type GrantItem,
  type GrantRow,
} from './grants-lib';

export {
  GRANTS_PAGE_MAX,
  GRANTS_NOTE,
  TX_EXPLORER_PREFIX,
  grantsPath,
  toGrantItem,
  txUrl,
  type GrantItem,
  type GrantRow,
} from './grants-lib';

export interface GrantsData {
  items: GrantItem[];
  total: number;
  illustrative: number;
  has_more: boolean;
  next_before: number | null;
  next: string | null;
  note: string;
}

/** Newest first; `before` = grant number cursor (0 = start from newest). */
export async function grantsData(env: Env, before: number, limit = GRANTS_PAGE_MAX): Promise<GrantsData> {
  const cap = Math.min(Math.max(1, limit), GRANTS_PAGE_MAX);
  const { results } = await env.DB.prepare(
    `SELECT number, id, from_party, to_party, amount, currency, purpose, tx_hash, illustrative, created_at
     FROM funding_grants ${before ? 'WHERE number < ?' : ''}
     ORDER BY number DESC LIMIT ?`,
  ).bind(...(before ? [before] : []), cap + 1).all<GrantRow>();
  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN illustrative = 1 THEN 1 ELSE 0 END) AS illustrative FROM funding_grants`,
  ).first<{ total: number; illustrative: number | null }>();
  const slice = results.slice(0, cap).map(toGrantItem);
  const has_more = results.length > cap;
  const next_before = has_more ? results[cap - 1]!.number : null;
  return {
    items: slice,
    total: counts?.total ?? 0,
    illustrative: counts?.illustrative ?? 0,
    has_more,
    next_before,
    next: next_before === null ? null : grantsPath('/v1/grants', next_before),
    note: GRANTS_NOTE,
  };
}

/** Shared read path for API, HTML and Markdown twins. */
export async function grantsRead(c: ReadCtx, opts: { api?: boolean } = {}): Promise<GrantsData> {
  const before = intParam(c.url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = opts.api ? intParam(c.url, 'limit', GRANTS_PAGE_MAX, 1, GRANTS_PAGE_MAX) : GRANTS_PAGE_MAX;
  return grantsData(c.env, before, limit);
}

export async function listGrants(c: Ctx): Promise<Response> {
  const page = await grantsRead(c, { api: true });
  return json(200, page);
}

/** Validates an optional tx hash at write time (admin path documented in INTEGRATION.md). */
export function parseTxHash(raw: unknown): string | null {
  try {
    return parseTxHashRaw(raw);
  } catch {
    throw new HttpError(400, 'invalid_tx_hash');
  }
}
