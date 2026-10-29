/**
 * Pure grants helpers (no Worker imports) — safe to unit-test in isolation.
 * Wired into src/grants.ts in the upstream tree.
 */

export const GRANTS_PAGE_MAX = 50;
export const GRANTS_NOTE = 'Published funding movements only — not wallet balances, tax advice, or proof that a third party paid you. Amounts are stored as the platform entered them. Rows marked illustrative are placeholders until live payouts are recorded. Authentication never widens this view.';

export const TX_EXPLORER_PREFIX = 'https://basescan.org/tx/';

export interface GrantRow {
  number: number;
  id: string;
  from_party: string;
  to_party: string;
  amount: string;
  currency: string | null;
  purpose: string;
  tx_hash: string | null;
  illustrative: number;
  created_at: string;
}

export interface GrantItem {
  number: number;
  ref: string;
  from: string;
  to: string;
  amount: string;
  currency: string | null;
  purpose: string;
  tx_hash: string | null;
  tx_url: string | null;
  illustrative: boolean;
  created_at: string;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function txUrl(hash: string | null): string | null {
  if (hash === null || hash.trim() === '') return null;
  const h = hash.trim();
  return TX_HASH_RE.test(h) ? `${TX_EXPLORER_PREFIX}${h}` : null;
}

export function toGrantItem(row: GrantRow): GrantItem {
  return {
    number: row.number,
    ref: `grant-${row.number}`,
    from: row.from_party,
    to: row.to_party,
    amount: row.amount,
    currency: row.currency,
    purpose: row.purpose,
    tx_hash: row.tx_hash,
    tx_url: txUrl(row.tx_hash),
    illustrative: row.illustrative === 1,
    created_at: row.created_at,
  };
}

export function grantsPath(base: string, before?: number | null): string {
  if (before === undefined || before === null || before <= 0) return base;
  return `${base}?before=${before}`;
}

export function parseTxHash(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('invalid_tx_hash');
  const v = raw.trim();
  if (v === '') return null;
  if (!TX_HASH_RE.test(v)) throw new Error('invalid_tx_hash');
  return v.toLowerCase();
}
