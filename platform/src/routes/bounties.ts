/**
 * Bounties API (src/bounties.ts holds the data, views and field rules; migration 0024 the tables).
 *
 * Public reads (anyone, cached like other public reads):
 *   GET /v1/bounties                    newest first; ?status=open|closed|paid|cancelled, ?before=<bounty number>, ?limit=1-100
 *   GET /v1/bounties/{number}           one bounty with every payout (oldest first)
 *
 * Admin writes (active admin only; never through an OAuth token, like every admin route):
 *   POST /v1/admin/bounties                       {"title", "task_url", "amount_atomic", "funder_address", "chain_id"?, "token"?, "closes_at"?, "post"?}
 *   POST /v1/admin/bounties/{number}/status       {"status": "open|closed|paid|cancelled", "reason"?}
 *   POST /v1/admin/bounties/{number}/payouts      {"payee", "payee_address", "amount_atomic", "tx_hash", "paid_at", "work_url"?}
 *
 * Every write is public: a `bounty.created`, `bounty.status` or `bounty.paid` event goes to the change feed, the staff
 * action log keeps who did it, and the content cache version is bumped so /bounties and its twins show it at once.
 * Recording a payout on an open or closed bounty marks it paid. A transaction hash is recorded once (409 duplicate_tx);
 * a cancelled bounty takes no payout (409 bounty_cancelled). The registry does not read the chain: the payout links its
 * transaction on the explorer, where anyone can check from, to and amount.
 */
import type { Ctx } from '../context';
import { requireRole } from '../auth';
import { HttpError, intParam, json, nowIso, readJson } from '../http';
import { bumpContentCacheVersion } from '../cache-version';
import {
  BOUNTIES_PAGE_DEFAULT, BOUNTIES_PAGE_MAX, BOUNTY_EVENTS, BOUNTY_REASON_MAX, BOUNTY_STATUSES, BOUNTY_TITLE_MAX, PAID_AT_SKEW_MS, PAYEE_MAX,
  addressField, atomicField, bountiesData, bountyData, chainAndToken, httpsUrlField, isoField, lineField, payoutData, statusField, txHashField,
  type BountyStatus,
} from '../bounties';
import { numberParam } from './content';

const KNOWN_CREATE = new Set(['title', 'task_url', 'amount_atomic', 'funder_address', 'chain_id', 'token', 'closes_at', 'post']);
const KNOWN_STATUS = new Set(['status', 'reason']);
const KNOWN_PAYOUT = new Set(['payee', 'payee_address', 'amount_atomic', 'tx_hash', 'paid_at', 'work_url']);

function onlyKnown(body: Record<string, unknown>, known: Set<string>): void {
  for (const field of Object.keys(body)) if (!known.has(field)) throw new HttpError(400, 'unknown_field', { field });
}

const logAction = (c: Ctx, actorId: string, action: string, ref: string, why: string | null, details: unknown) =>
  c.env.DB.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(actorId, action, 'bounty', ref, why, JSON.stringify(details), nowIso());

const event = (c: Ctx, type: string, number: number, actorId: string, data: unknown, at: string) =>
  c.env.DB.prepare('INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(type, 'bounty', number, actorId, JSON.stringify(data), at);

async function existing(c: Ctx, number: number) {
  const row = await c.env.DB.prepare('SELECT number, status, chain_id, token FROM bounties WHERE number = ?').bind(number).first<{ number: number; status: BountyStatus; chain_id: number; token: string }>();
  if (!row) throw new HttpError(404, 'bounty_not_found', { ref: `bounty-${number}` });
  return row;
}

// ---------------------------------------------------------------- public reads

export async function listBounties(c: Ctx): Promise<Response> {
  const raw = (c.url.searchParams.get('status') ?? '').trim().toLowerCase();
  if (raw && !(BOUNTY_STATUSES as readonly string[]).includes(raw)) throw new HttpError(400, 'invalid_query_parameter', { parameter: 'status', allowed: BOUNTY_STATUSES });
  const before = intParam(c.url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(c.url, 'limit', BOUNTIES_PAGE_DEFAULT, 1, BOUNTIES_PAGE_MAX);
  return json(200, await bountiesData(c.env, { status: (raw || null) as BountyStatus | null, before, limit }));
}

export async function getBounty(c: Ctx): Promise<Response> {
  const number = numberParam(c.params[0]);
  const data = await bountyData(c.env, number);
  if (!data) throw new HttpError(404, 'bounty_not_found', { ref: `bounty-${number}` });
  return json(200, data);
}

// ---------------------------------------------------------------- admin writes

export async function createBounty(c: Ctx): Promise<Response> {
  const p = requireRole(c.principal, 'admin');
  const body = await readJson(c.request);
  onlyKnown(body, KNOWN_CREATE);
  const title = lineField(body, 'title', BOUNTY_TITLE_MAX)!;
  const taskUrl = httpsUrlField(body, 'task_url', true)!;
  const amount = atomicField(body);
  const funder = addressField(body, 'funder_address');
  const { chain, token } = chainAndToken(body);
  const closesAt = isoField(body, 'closes_at', false);
  let post: number | null = null;
  if (body.post !== undefined && body.post !== null) {
    if (typeof body.post !== 'number' || !Number.isSafeInteger(body.post) || body.post < 1) throw new HttpError(400, 'invalid_post');
    const row = await c.env.DB.prepare("SELECT number FROM posts WHERE number = ? AND status = 'visible' AND withdrawn_at IS NULL").bind(body.post).first();
    if (!row) throw new HttpError(404, 'post_not_found', { ref: `post-${body.post}` });
    post = body.post;
  }
  const at = nowIso();
  const db = c.env.DB;
  // One D1 batch = one transaction: the bounty row, its public event, the staff log entry and the cache bump land
  // together or not at all. Inside the batch MAX(number) is the row this request just inserted.
  const last = '(SELECT MAX(number) FROM bounties)';
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO bounties (title, task_url, post_number, amount_atomic, token, chain_id, funder_address, closes_at, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING number`).bind(title, taskUrl, post, amount, token.symbol, chain.id, funder, closesAt, p.account.id, at, at),
    db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) SELECT ?, 'bounty', ${last}, ?, ?, ?`)
      .bind(BOUNTY_EVENTS.created, p.account.id, JSON.stringify({ title, amount_atomic: amount, token: token.symbol, chain_id: chain.id, task_url: taskUrl }), at),
    db.prepare(`INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, created_at) SELECT ?, 'bounty.create', 'bounty', 'bounty-' || ${last}, NULL, ?, ?`)
      .bind(p.account.id, JSON.stringify({ title, amount_atomic: amount, token: token.symbol, chain_id: chain.id }), at),
    bumpContentCacheVersion(db),
  ]);
  const number = (inserted.results[0] as { number: number }).number;
  return json(201, await bountyData(c.env, number));
}

export async function setBountyStatus(c: Ctx): Promise<Response> {
  const p = requireRole(c.principal, 'admin');
  const number = numberParam(c.params[0]);
  const body = await readJson(c.request);
  onlyKnown(body, KNOWN_STATUS);
  const status = statusField(body);
  const reason = lineField(body, 'reason', BOUNTY_REASON_MAX, false);
  const row = await existing(c, number);
  if (row.status === status) return json(200, await bountyData(c.env, number));
  const at = nowIso();
  const db = c.env.DB;
  await db.batch([
    db.prepare('UPDATE bounties SET status = ?, updated_at = ? WHERE number = ?').bind(status, at, number),
    event(c, BOUNTY_EVENTS.status, number, p.account.id, { from: row.status, to: status, reason }, at),
    logAction(c, p.account.id, 'bounty.status', `bounty-${number}`, reason, { from: row.status, to: status }),
    bumpContentCacheVersion(db),
  ]);
  return json(200, await bountyData(c.env, number));
}

export async function recordPayout(c: Ctx): Promise<Response> {
  const p = requireRole(c.principal, 'admin');
  const number = numberParam(c.params[0]);
  const body = await readJson(c.request);
  onlyKnown(body, KNOWN_PAYOUT);
  const payee = lineField(body, 'payee', PAYEE_MAX)!;
  const payeeAddress = addressField(body, 'payee_address');
  const amount = atomicField(body);
  const tx = txHashField(body);
  const paidAt = isoField(body, 'paid_at', true)!;
  if (Date.parse(paidAt) > Date.now() + PAID_AT_SKEW_MS) throw new HttpError(400, 'invalid_paid_at', { reason: 'in the future' });
  const workUrl = httpsUrlField(body, 'work_url', false);
  const row = await existing(c, number);
  if (row.status === 'cancelled') throw new HttpError(409, 'bounty_cancelled', { ref: `bounty-${number}` });
  const dup = await c.env.DB.prepare('SELECT number, bounty_number FROM bounty_payouts WHERE tx_hash = ?').bind(tx).first<{ number: number; bounty_number: number }>();
  if (dup) throw new HttpError(409, 'duplicate_tx', { ref: `payout-${dup.number}`, bounty: `bounty-${dup.bounty_number}` });
  const at = nowIso();
  const db = c.env.DB;
  // One D1 batch = one transaction: the payout row, the status change, the public event, the staff log entry and the
  // cache bump land together or not at all. Inside the batch MAX(number) is the payout this request just inserted.
  const last = '(SELECT MAX(number) FROM bounty_payouts)';
  let payoutNumber: number;
  try {
    const [inserted] = await db.batch([
      db.prepare(`INSERT INTO bounty_payouts (bounty_number, payee, payee_address, amount_atomic, tx_hash, work_url, paid_at, recorded_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING number`).bind(number, payee, payeeAddress, amount, tx, workUrl, paidAt, p.account.id, at),
      // a payout marks an open or closed bounty paid (a paid one stays paid; cancelled was refused above)
      db.prepare("UPDATE bounties SET status = 'paid', updated_at = ? WHERE number = ? AND status IN ('open', 'closed')").bind(at, number),
      db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at)
        SELECT ?1, 'bounty', ?2, ?3, json_object('payout', ${last}, 'payee', ?4, 'payee_address', ?5, 'amount_atomic', ?6, 'token', ?7, 'chain_id', ?8, 'tx_hash', ?9), ?10`)
        .bind(BOUNTY_EVENTS.paid, number, p.account.id, payee, payeeAddress, amount, row.token, row.chain_id, tx, at),
      db.prepare(`INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, created_at)
        SELECT ?1, 'bounty.payout', 'bounty', ?2, NULL, json_object('payout', ${last}, 'payee', ?3, 'amount_atomic', ?4, 'tx_hash', ?5), ?6`)
        .bind(p.account.id, `bounty-${number}`, payee, amount, tx, at),
      bumpContentCacheVersion(db),
    ]);
    payoutNumber = (inserted.results[0] as { number: number }).number;
  } catch (error) {
    // two requests raced with the same transaction: the UNIQUE index refused the second, nothing of it was written
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'duplicate_tx', { tx_hash: tx });
    throw error;
  }
  return json(201, { payout: await payoutData(c.env, payoutNumber), bounty: await bountyData(c.env, number) });
}
