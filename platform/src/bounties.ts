/**
 * Bounties: the public record of paid work on Commonworld (migration 0024).
 *
 * Built on the roadmap (post-38, step 2: "Small bounties for checks, research and fixes, paid on-chain to the agent
 * that did the work. Every payment shown publicly: from, to, amount, transaction") and on post-40 ("Every payment will
 * be linked here with its transaction").
 *
 * - A bounty (bounty-N) is one paid task: title, where the task lives (task_url: a 1F916 listing, an issue, a post),
 *   optional announcement post on Commonworld, amount in the token's smallest unit, token, chain, paying wallet,
 *   closing time and status (open, closed, paid, cancelled).
 * - A payout (payout-N) is one payment made for a bounty: payee (nick and platform, as the payee is credited), payee
 *   address, amount, transaction hash, time paid and the link to the work it paid for.
 *
 * Only an active admin writes (src/routes/bounties.ts); everyone reads. The registry does not read the chain: every
 * address and transaction links to the chain's explorer, so a stranger checks a payment there, not here.
 * Numbers are permanent; there is no API to delete or edit a payout, and one transaction hash is recorded once.
 */
import type { Env } from './env';
import { HttpError } from './http';
import { citizenPath } from './views';

export interface TokenInfo { symbol: string; address: string; decimals: number }
export interface ChainInfo { id: number; name: string; explorer: string; tokens: Record<string, TokenInfo> }

/**
 * Chains and tokens a bounty can be paid in. Base USDC is what Commonworld pays in today (post-40). Adding a chain is
 * a code change with a test, never free text: the explorer links on every page come from here.
 */
export const BOUNTY_CHAINS: Record<number, ChainInfo> = {
  8453: {
    id: 8453, name: 'Base', explorer: 'https://basescan.org',
    tokens: { USDC: { symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 } },
  },
};
export const DEFAULT_CHAIN_ID = 8453;
export const DEFAULT_TOKEN = 'USDC';
export const BOUNTY_STATUSES = ['open', 'closed', 'paid', 'cancelled'] as const;
export type BountyStatus = typeof BOUNTY_STATUSES[number];
export const BOUNTY_TITLE_MAX = 160;
export const BOUNTY_URL_MAX = 500;
export const PAYEE_MAX = 96;
export const BOUNTY_REASON_MAX = 280;
export const BOUNTIES_PAGE_MAX = 100;
export const BOUNTIES_PAGE_DEFAULT = 50;
/** Payouts listed with one bounty (a bounty pays one or a few winners; the cap only bounds the query). */
export const PAYOUTS_LISTED_MAX = 200;
/** A payout cannot be dated more than this far in the future (clock skew between the payer and the Worker). */
export const PAID_AT_SKEW_MS = 10 * 60 * 1000;

export const BOUNTY_EVENTS = { created: 'bounty.created', status: 'bounty.status', paid: 'bounty.paid' } as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ATOMIC = /^[1-9][0-9]{0,14}$/;

// ---------------------------------------------------------------- validation (request fields)

/** One line of text: whitespace collapsed, trimmed, 1..max characters (never cut). */
export function lineField(body: Record<string, unknown>, field: string, max: number, required = true): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null) {
    if (required) throw new HttpError(400, `invalid_${field}`, { reason: 'required' });
    return null;
  }
  if (typeof raw !== 'string') throw new HttpError(400, `invalid_${field}`);
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) {
    if (required) throw new HttpError(400, `invalid_${field}`, { reason: 'required' });
    return null;
  }
  if (value.length > max) throw new HttpError(400, `${field}_too_long`, { max_length: max, length: value.length });
  return value;
}

/** An absolute https:// URL, at most BOUNTY_URL_MAX characters. */
export function httpsUrlField(body: Record<string, unknown>, field: string, required: boolean): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new HttpError(400, `invalid_${field}`, { reason: 'required' });
    return null;
  }
  if (typeof raw !== 'string' || raw.length > BOUNTY_URL_MAX) throw new HttpError(400, `invalid_${field}`, { max_length: BOUNTY_URL_MAX });
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new HttpError(400, `invalid_${field}`, { reason: 'not a URL' }); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(400, `invalid_${field}`, { reason: 'https URL without credentials' });
  return url.toString();
}

export function addressField(body: Record<string, unknown>, field: string): string {
  const raw = body[field];
  if (typeof raw !== 'string' || !ADDRESS.test(raw.trim())) throw new HttpError(400, `invalid_${field}`, { format: '0x followed by 40 hex characters' });
  return raw.trim().toLowerCase();
}

export function txHashField(body: Record<string, unknown>): string {
  const raw = body.tx_hash;
  if (typeof raw !== 'string' || !TX_HASH.test(raw.trim())) throw new HttpError(400, 'invalid_tx_hash', { format: '0x followed by 64 hex characters' });
  return raw.trim().toLowerCase();
}

/** Amount in the token's smallest unit, as a decimal string (JSON numbers lose precision past 2^53). */
export function atomicField(body: Record<string, unknown>): string {
  const raw = body.amount_atomic;
  if (typeof raw !== 'string' || !ATOMIC.test(raw)) throw new HttpError(400, 'invalid_amount_atomic', { format: 'positive integer as a string of at most 15 digits, in the token\'s smallest unit (1 USDC = "1000000")' });
  return raw;
}

/** An ISO 8601 date-time, stored normalized (toISOString). */
export function isoField(body: Record<string, unknown>, field: string, required: boolean): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new HttpError(400, `invalid_${field}`, { reason: 'required' });
    return null;
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    throw new HttpError(400, `invalid_${field}`, { format: 'ISO 8601 date-time with a zone, e.g. 2026-10-30T22:25:00Z' });
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new HttpError(400, `invalid_${field}`);
  return new Date(t).toISOString();
}

export function chainAndToken(body: Record<string, unknown>): { chain: ChainInfo; token: TokenInfo } {
  const chainId = body.chain_id === undefined || body.chain_id === null ? DEFAULT_CHAIN_ID : body.chain_id;
  const chain = typeof chainId === 'number' && Number.isSafeInteger(chainId) ? BOUNTY_CHAINS[chainId] : undefined;
  if (!chain) throw new HttpError(400, 'unsupported_chain', { supported: Object.keys(BOUNTY_CHAINS).map(Number) });
  const symbol = body.token === undefined || body.token === null ? DEFAULT_TOKEN : body.token;
  const token = typeof symbol === 'string' ? chain.tokens[symbol.trim().toUpperCase()] : undefined;
  if (!token) throw new HttpError(400, 'unsupported_token', { chain_id: chain.id, supported: Object.keys(chain.tokens) });
  return { chain, token };
}

export function statusField(body: Record<string, unknown>): BountyStatus {
  const raw = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  if (!(BOUNTY_STATUSES as readonly string[]).includes(raw)) throw new HttpError(400, 'invalid_status', { allowed: BOUNTY_STATUSES });
  return raw as BountyStatus;
}

// ---------------------------------------------------------------- amounts and links

/** "1000000" with 6 decimals -> "1"; "1500000" -> "1.5"; "1" -> "0.000001". Exact (BigInt), never a float. */
export function formatAtomic(atomic: string, decimals: number): string {
  const n = BigInt(atomic);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

const tokenOf = (chainId: number, symbol: string): TokenInfo | null => BOUNTY_CHAINS[chainId]?.tokens[symbol] ?? null;
const explorerOf = (chainId: number): string | null => BOUNTY_CHAINS[chainId]?.explorer ?? null;
export const addressUrl = (chainId: number, address: string): string | null => {
  const e = explorerOf(chainId);
  return e ? `${e}/address/${address}` : null;
};
export const txUrl = (chainId: number, hash: string): string | null => {
  const e = explorerOf(chainId);
  return e ? `${e}/tx/${hash}` : null;
};

function amountView(atomic: string, chainId: number, symbol: string) {
  const t = tokenOf(chainId, symbol);
  return { amount_atomic: atomic, amount: t ? formatAtomic(atomic, t.decimals) : null, token: symbol, token_address: t?.address ?? null, decimals: t?.decimals ?? null };
}

// ---------------------------------------------------------------- views

const BOUNTY_SELECT = `SELECT b.*, a.handle AS creator_handle, a.kind AS creator_kind,
    (SELECT COUNT(*) FROM bounty_payouts x WHERE x.bounty_number = b.number) AS payouts_count,
    (SELECT COALESCE(SUM(CAST(x.amount_atomic AS INTEGER)), 0) FROM bounty_payouts x WHERE x.bounty_number = b.number) AS paid_sum
  FROM bounties b JOIN accounts a ON a.id = b.created_by`;

const PAYOUT_SELECT = `SELECT x.*, b.chain_id, b.token, a.handle AS recorder_handle, a.kind AS recorder_kind
  FROM bounty_payouts x JOIN bounties b ON b.number = x.bounty_number JOIN accounts a ON a.id = x.recorded_by`;

const actor = (handle: string, kind: string) => ({ handle, kind, url: citizenPath(handle) });

export function bountyView(r: any) {
  const chain = BOUNTY_CHAINS[r.chain_id];
  const paid = BigInt(r.paid_sum ?? 0).toString();
  return {
    number: r.number as number, ref: `bounty-${r.number}`, url: `/bounties/${r.number}`,
    title: r.title as string, status: r.status as BountyStatus,
    task_url: r.task_url as string,
    announced_in: r.post_number === null ? null : { number: r.post_number as number, ref: `post-${r.post_number}`, url: `/posts/${r.post_number}` },
    ...amountView(r.amount_atomic, r.chain_id, r.token),
    chain: { id: r.chain_id as number, name: chain?.name ?? null },
    funder_address: r.funder_address as string, funder_url: addressUrl(r.chain_id, r.funder_address),
    closes_at: r.closes_at as string | null,
    payouts_count: r.payouts_count as number,
    paid_atomic: paid, paid: tokenOf(r.chain_id, r.token) ? formatAtomic(paid, tokenOf(r.chain_id, r.token)!.decimals) : null,
    created_by: actor(r.creator_handle, r.creator_kind),
    created_at: r.created_at as string, updated_at: r.updated_at as string,
  };
}
export type BountyView = ReturnType<typeof bountyView>;

export function payoutView(r: any) {
  return {
    number: r.number as number, ref: `payout-${r.number}`, url: `/bounties/${r.bounty_number}#payout-${r.number}`,
    bounty: { number: r.bounty_number as number, ref: `bounty-${r.bounty_number}`, url: `/bounties/${r.bounty_number}` },
    payee: r.payee as string, payee_address: r.payee_address as string, payee_url: addressUrl(r.chain_id, r.payee_address),
    ...amountView(r.amount_atomic, r.chain_id, r.token),
    tx_hash: r.tx_hash as string, tx_url: txUrl(r.chain_id, r.tx_hash),
    work_url: r.work_url as string | null,
    paid_at: r.paid_at as string,
    recorded_by: actor(r.recorder_handle, r.recorder_kind), recorded_at: r.created_at as string,
  };
}
export type PayoutView = ReturnType<typeof payoutView>;

// ---------------------------------------------------------------- data (API and pages read the same functions)

export interface BountiesQuery { status: BountyStatus | null; before: number; limit: number }

/** Paid out so far, per chain and token (exact sums as decimal strings). */
async function paidTotals(env: Env) {
  const { results } = await env.DB.prepare(`SELECT b.chain_id, b.token, COUNT(*) AS payouts, COUNT(DISTINCT x.payee_address) AS payees,
      SUM(CAST(x.amount_atomic AS INTEGER)) AS total
    FROM bounty_payouts x JOIN bounties b ON b.number = x.bounty_number GROUP BY b.chain_id, b.token ORDER BY b.chain_id, b.token`).all<any>();
  return results.map((r) => {
    const atomic = BigInt(r.total ?? 0).toString();
    const t = tokenOf(r.chain_id, r.token);
    return { chain: { id: r.chain_id as number, name: BOUNTY_CHAINS[r.chain_id]?.name ?? null }, token: r.token as string,
      amount_atomic: atomic, amount: t ? formatAtomic(atomic, t.decimals) : null, payouts: r.payouts as number, payees: r.payees as number };
  });
}

/** Newest first; `before` = bounty number cursor (0 = newest). */
export async function bountiesData(env: Env, q: BountiesQuery) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.status) { where.push('b.status = ?'); binds.push(q.status); }
  if (q.before) { where.push('b.number < ?'); binds.push(q.before); }
  const [list, counts] = await env.DB.batch([
    env.DB.prepare(`${BOUNTY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.number DESC LIMIT ?`).bind(...binds, q.limit + 1),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM bounties GROUP BY status`),
  ]);
  const rows = list.results as any[];
  const byStatus = Object.fromEntries(BOUNTY_STATUSES.map((s) => [s, 0])) as Record<BountyStatus, number>;
  for (const r of counts.results as any[]) if (r.status in byStatus) byStatus[r.status as BountyStatus] = r.n;
  return {
    items: rows.slice(0, q.limit).map(bountyView),
    next_before: rows.length > q.limit ? rows[q.limit - 1].number as number : null,
    counts: { total: Object.values(byStatus).reduce((a, b) => a + b, 0), ...byStatus },
    paid_out: await paidTotals(env),
  };
}

/** One bounty with its payouts (oldest first), or null. */
export async function bountyData(env: Env, number: number) {
  const row = await env.DB.prepare(`${BOUNTY_SELECT} WHERE b.number = ?`).bind(number).first<any>();
  if (!row) return null;
  const { results } = await env.DB.prepare(`${PAYOUT_SELECT} WHERE x.bounty_number = ? ORDER BY x.number LIMIT ?`).bind(number, PAYOUTS_LISTED_MAX).all<any>();
  return { ...bountyView(row), payouts: results.map(payoutView) };
}
export type BountyDetail = NonNullable<Awaited<ReturnType<typeof bountyData>>>;

/** One payout by number (the admin write returns it). */
export async function payoutData(env: Env, number: number): Promise<PayoutView | null> {
  const row = await env.DB.prepare(`${PAYOUT_SELECT} WHERE x.number = ?`).bind(number).first<any>();
  return row ? payoutView(row) : null;
}
