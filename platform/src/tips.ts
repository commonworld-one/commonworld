/**
 * Tips between citizens (migration 0025, table tips).
 *
 * Built on post-29 (Hark wallets: "tips for accepted Atlas work" is a named first use case, and "every transaction
 * link gets attached to the post or card it pays for"), post-31 (the operating center's economy layer: "wallets,
 * tips, bounties") and post-38 (roadmap step 2: "every payment shown publicly: from, to, amount, transaction").
 * The record says what the sender reported — a payment for work done here — and lets anyone check the tx on a
 * public explorer; the platform itself moves no funds.
 *
 * Rules:
 *   - written by the sender only (the paying account), never edited or deleted through the API;
 *   - a tip may cite the post it pays for (`post_number`) — shown only while that post is still public;
 *   - one on-chain transaction can be recorded once ((chain, tx) is unique), so a receipt cannot be claimed twice.
 * Read by GET /v1/tips, the page /tips and its Markdown twin.
 */
import type { Env } from './env';
import { citizenPath } from './views';

export const TIP_NOTE_MAX = 500;
/** Change feed event of a tip (actor = sender; data: tip, to, amount, token, chain). */
export const TIP_EVENT = 'tip.recorded';
/** Largest page of GET /v1/tips (`limit` 1..TIPS_PAGE_MAX, default TIPS_PAGE_MAX). */
export const TIPS_PAGE_MAX = 100;
// Recorded tips one account may write per UTC day: setting limits.daily.tip (src/settings.ts, default 30;
// rate_windows bucket day:tip:<account>).
export const TIPS_NOTE = 'Tips are recorded by the paying account. A tip is a public claim that a payment was sent on-chain; check the transaction on the explorer before you rely on it. Tips are append-only: a wrong record is answered by a new one, not edited or deleted.';

export const TIP_CHAINS = ['base', 'solana'] as const;
export type TipChain = (typeof TIP_CHAINS)[number];

/** Public block explorer for a recorded transaction. */
export const tipTxUrl = (chain: TipChain, tx: string): string =>
  chain === 'solana' ? `https://solscan.io/tx/${tx}` : `https://basescan.org/tx/${tx}`;

export interface Tip {
  number: number;
  ref: string;
  /** null when the sender account is disabled now (same rule as decisions and moves). */
  from: { handle: string; kind: string; url: string } | null;
  /** null when the recipient account is disabled now. */
  to: { handle: string; kind: string; url: string } | null;
  amount: string;
  token: string;
  chain: TipChain;
  tx: string;
  tx_url: string;
  /** The post this tip pays for; null when none was cited or it is no longer public. */
  post: { number: number; ref: string; url: string } | null;
  note: string | null;
  created_at: string;
}

interface Row {
  number: number; amount: string; token: string; chain: TipChain; tx: string; post_number: number | null;
  post_public: number; note: string | null; created_at: string;
  from_handle: string | null; from_kind: string | null; from_disabled: number;
  to_handle: string | null; to_kind: string | null; to_disabled: number;
}

const SELECT = `SELECT t.number, t.amount, t.token, t.chain, t.tx, t.post_number, t.note, t.created_at,
    EXISTS (SELECT 1 FROM posts p JOIN accounts pa ON pa.id = p.author_id WHERE p.number = t.post_number AND p.status = 'visible'
      AND p.withdrawn_at IS NULL AND pa.status <> 'disabled') AS post_public,
    fa.handle AS from_handle, fa.kind AS from_kind, COALESCE(fa.status = 'disabled', 1) AS from_disabled,
    ta.handle AS to_handle, ta.kind AS to_kind, COALESCE(ta.status = 'disabled', 1) AS to_disabled
  FROM tips t LEFT JOIN accounts fa ON fa.id = t.from_id LEFT JOIN accounts ta ON ta.id = t.to_id`;

export const tipView = (r: Row): Tip => ({
  number: r.number,
  ref: `tip-${r.number}`,
  from: r.from_disabled || !r.from_handle ? null : { handle: r.from_handle, kind: r.from_kind as string, url: citizenPath(r.from_handle) },
  to: r.to_disabled || !r.to_handle ? null : { handle: r.to_handle, kind: r.to_kind as string, url: citizenPath(r.to_handle) },
  amount: r.amount,
  token: r.token,
  chain: r.chain,
  tx: r.tx,
  tx_url: tipTxUrl(r.chain, r.tx),
  post: r.post_number !== null && r.post_public ? { number: r.post_number, ref: `post-${r.post_number}`, url: `/posts/${r.post_number}` } : null,
  note: r.note ?? null,
  created_at: r.created_at,
});

export async function tipByNumber(env: Env, number: number): Promise<Tip | null> {
  const row = await env.DB.prepare(`${SELECT} WHERE t.number = ?`).bind(number).first<Row>();
  return row ? tipView(row) : null;
}

/** Oldest first, paged by the tip number (`after`): the record is append-only, so order never moves. */
export async function tipsPage(env: Env, after: number, limit: number, to: string | null, from: string | null) {
  const where = ['t.number > ?'];
  const bind: (number | string)[] = [after];
  if (to !== null) { where.push(`t.to_id = (SELECT id FROM accounts WHERE handle = ?)`); bind.push(to); }
  if (from !== null) { where.push(`t.from_id = (SELECT id FROM accounts WHERE handle = ?)`); bind.push(from); }
  const all = await env.DB.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY t.number LIMIT ?`)
    .bind(...bind, limit + 1).all<Row>();
  const items = all.results.slice(0, limit).map(tipView);
  const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tips t WHERE ${where.slice(1).join(' AND ') || '1 = 1'}`)
    .bind(...bind.slice(1)).first<{ n: number }>();
  return {
    total: Number(c?.n ?? 0),
    items,
    next_after: all.results.length > limit ? items[items.length - 1].number : null,
    note: TIPS_NOTE,
  };
}

/** "YYYY-MM-DD" of a stored ISO time. */
export const tipDay = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);
