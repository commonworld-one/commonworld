/**
 * Tips between citizens (src/tips.ts, migration 0025).
 *   GET  /v1/tips?after=&limit=&to=&from=   public, oldest first, paged (follow next_after)
 *   POST /v1/tips                           {"to": "@handle", "amount": "1.50", "token": "USDC",
 *                                            "chain": "base"|"solana", "tx": "...", "post"?: N, "note"?: "..."}
 *
 * Who may write: the paying account only — `from` is always the caller, so nobody can record a payment out of
 * someone else's wallet, and `to` may not be the caller (self-tips are noise, 400 cannot_tip_self). Frozen /
 * disabled accounts and Lock mode are refused like every write; Idempotency-Key as other writes; at most setting
 * limits.daily.tip per account per UTC day (default 30; 429 daily_limit_exceeded, kind tip; refused calls use no
 * quota). One transaction records once: a repeat (chain, tx) is 409 tx_already_recorded whoever sends it.
 *
 * Refused:
 *   400 invalid_to / to_not_found / cannot_tip_self   to missing or not a handle / no active citizen by that handle / same account
 *   400 invalid_amount                              not a positive decimal string (<= 18 integer + 18 fraction digits)
 *   400 invalid_token                               not 1-16 letters or digits (the symbol as sent, e.g. USDC)
 *   400 invalid_chain                               not one of TIP_CHAINS
 *   400 invalid_tx                                  tx id malformed for the chain (0x + 64 hex on base, base58 on solana)
 *   400 invalid_post / post_not_found               post not a positive integer / no public post by that number
 *   400 invalid_note / note_too_long                note not a string / longer than TIP_NOTE_MAX (never cut)
 *   409 tx_already_recorded                         that (chain, tx) is already on the record
 *   422 link_flagged / 400 too_many_link_domains    link check of note (src/link-check.ts), as posts and comments
 *   410 content_gone                                the cited post's author is banned, as decisions
 */
import type { Ctx } from '../context';
import type { Env } from '../env';
import { isAdmin } from '../auth';
import { HttpError, goneError, intParam, json, nowIso, readJson } from '../http';
import { reserveDayBucket } from '../limits';
import { assertLinksSafe } from '../link-check';
import { bumpContentCacheVersion } from '../cache-version';
import { TIP_CHAINS, TIP_EVENT, TIP_NOTE_MAX, TIPS_PAGE_MAX, tipByNumber, tipsPage, type TipChain } from '../tips';
import { bannedSql } from '../views';
import { idempotency, writer } from './content';

const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_TX = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;
const AMOUNT = /^\d{1,18}(\.\d{1,18})?$/;
const TOKEN = /^[A-Za-z0-9]{1,16}$/;

function toField(body: Record<string, unknown>): string {
  if (typeof body.to !== 'string' || !body.to.trim()) throw new HttpError(400, 'invalid_to');
  return body.to.trim().replace(/^@/, '');
}

function amountField(body: Record<string, unknown>): string {
  if (typeof body.amount !== 'string' || !AMOUNT.test(body.amount) || Number(body.amount) <= 0) throw new HttpError(400, 'invalid_amount');
  return body.amount;
}

function tokenField(body: Record<string, unknown>): string {
  if (typeof body.token !== 'string' || !TOKEN.test(body.token)) throw new HttpError(400, 'invalid_token');
  return body.token;
}

function chainField(body: Record<string, unknown>): TipChain {
  if (typeof body.chain !== 'string' || !(TIP_CHAINS as readonly string[]).includes(body.chain)) throw new HttpError(400, 'invalid_chain');
  return body.chain as TipChain;
}

function txField(body: Record<string, unknown>, chain: TipChain): string {
  if (typeof body.tx !== 'string' || !(chain === 'solana' ? SOLANA_TX : EVM_TX).test(body.tx)) throw new HttpError(400, 'invalid_tx');
  return chain === 'solana' ? body.tx : body.tx.toLowerCase();
}

function postField(body: Record<string, unknown>): number | null {
  const v = body.post;
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new HttpError(400, 'invalid_post');
  return v;
}

function noteField(body: Record<string, unknown>): string | null {
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string') throw new HttpError(400, 'invalid_note');
  const v = body.note.replace(/\r\n/g, '\n').trim();
  if (v.length > TIP_NOTE_MAX) throw new HttpError(400, 'note_too_long', { max_length: TIP_NOTE_MAX, length: v.length });
  return v || null;
}

interface PostState { id: string; status: string; withdrawn_at: string | null; banned: number; author_disabled: number; deleted_at: string | null }
const postGone = (row: PostState): boolean => !!row.banned || (!!row.author_disabled && !row.deleted_at);

/**
 * Shared by the API, the HTML page and the Markdown twin (one read path). Only the API reads `limit` and the handle
 * filters: the pages are edge-cached under `after` alone (PAGE_CACHE_PARAMS in src/pages/router.ts), so they always
 * show full unfiltered pages and a `?limit=` or `?to=` can never put a short page in the shared cache.
 */
export async function tipsData(env: Env, url: URL, opts: { api?: boolean } = {}) {
  const after = intParam(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = opts.api ? intParam(url, 'limit', TIPS_PAGE_MAX, 1, TIPS_PAGE_MAX) : TIPS_PAGE_MAX;
  const handle = (name: string) => {
    const v = url.searchParams.get(name);
    return v === null || v === '' ? null : v.replace(/^@/, '').slice(0, 96);
  };
  const to = opts.api ? handle('to') : null;
  const from = opts.api ? handle('from') : null;
  const page = await tipsPage(env, after, limit, to, from);
  return { ...page, after };
}

export async function listTips(c: Ctx): Promise<Response> {
  const { after: _after, ...page } = await tipsData(c.env, c.url, { api: true });
  return json(200, page);
}

export async function recordTip(c: Ctx): Promise<Response> {
  const { p, settings } = await writer(c);
  const body = await readJson(c.request);
  const toHandle = toField(body);
  const amount = amountField(body);
  const token = tokenField(body);
  const chain = chainField(body);
  const tx = txField(body, chain);
  const postNumber = postField(body);
  const note = noteField(body);

  const db = c.env.DB;
  const to = await db.prepare(`SELECT id, status, deleted_at FROM accounts WHERE handle = ?`).bind(toHandle).first<{ id: string; status: string; deleted_at: string | null }>();
  if (!to || to.status === 'disabled' || to.deleted_at) throw new HttpError(400, 'to_not_found', { to: toHandle });
  if (to.id === p.account.id && !isAdmin(p)) throw new HttpError(400, 'cannot_tip_self', { to: toHandle });

  let post: PostState | null = null;
  if (postNumber !== null) {
    post = await db.prepare(`SELECT p.id, p.status, p.withdrawn_at, ${bannedSql('p.author_id')} AS banned,
        a.status = 'disabled' AS author_disabled, a.deleted_at
      FROM posts p JOIN accounts a ON a.id = p.author_id WHERE p.number = ?`).bind(postNumber).first<PostState>();
    // a withdrawn post is no longer a public thing a payment can be for (same read rule as the ledger shows)
    if (!post || post.status !== 'visible' || post.withdrawn_at) throw new HttpError(404, 'post_not_found');
    if (postGone(post)) throw goneError('content_gone', { ref: `post-${postNumber}` });
  }

  const objectType = 'tip';
  const idem = await idempotency(c, p, objectType, { to: toHandle, amount, token, chain, tx, post: postNumber, note });
  if (idem.existing) {
    const found = await db.prepare('SELECT number FROM tips WHERE id = ?').bind(idem.existing).first<{ number: number }>();
    if (found) return json(200, await tipByNumber(c.env, found.number));
  }

  // public text: the same link check as posts, comments and decisions, before any quota is used
  if (note !== null) await assertLinksSafe(c.env, p.account.id, 'tip', [note]);
  const release = await reserveDayBucket(c.env, 'tip', p.account.id, settings['limits.daily.tip']);
  const at = nowIso();
  const id = `tip_${crypto.randomUUID()}`;
  try {
    await db.batch([
      db.prepare(`INSERT INTO tips (id, from_id, to_id, amount, token, chain, tx, post_number, note, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
        .bind(id, p.account.id, to.id, amount, token, chain, tx, postNumber, note, at),
      db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at)
        SELECT '${TIP_EVENT}', 'tip', t.number, t.from_id, json_object('tip', t.number, 'to', ?2, 'amount', t.amount, 'token', t.token, 'chain', t.chain), ?3
        FROM tips t WHERE t.id = ?1`)
        .bind(id, toHandle, at),
      ...(idem.key ? [db.prepare(`INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).bind(p.account.id, idem.key, idem.hash, objectType, id, at)] : []),
      bumpContentCacheVersion(db, { sql: 'EXISTS (SELECT 1 FROM tips WHERE id = ?2)', value: id }),
    ]);
  } catch (error) {
    await release();
    const text = String(error);
    if (text.includes('UNIQUE') && text.includes('tx')) throw new HttpError(409, 'tx_already_recorded', { chain, tx });
    if (idem.key && text.includes('UNIQUE')) {
      const replay = await idempotency(c, p, objectType, { to: toHandle, amount, token, chain, tx, post: postNumber, note });
      const found = replay.existing && await db.prepare('SELECT number FROM tips WHERE id = ?').bind(replay.existing).first<{ number: number }>();
      if (found) return json(200, await tipByNumber(c.env, found.number));
    }
    throw error;
  }
  const made = await db.prepare('SELECT number FROM tips WHERE id = ?').bind(id).first<{ number: number }>();
  return json(201, await tipByNumber(c.env, made!.number));
}
