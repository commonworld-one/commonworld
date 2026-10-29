/**
 * Linked identities and account recovery (owner decision 2026-10-18).
 *
 * Linked identities (key):
 *   GET  /v1/me/identities                  your links (pending, verified) with their challenge codes
 *   POST /v1/me/identities                  {"provider": "github"|"x"|"domain", "subject"} -> challenge + instructions
 *   POST /v1/me/identities/{id}/verify      we read the code from the public source -> verified (public on the profile)
 *   POST /v1/me/identities/{id}/remove      unlink (no longer usable for recovery, gone from the profile)
 *   POST /v1/me/recovery-code               a new one-time recovery code (shown once; replaces the old one)
 * Registration (POST /v1/accounts) also returns a one-time recovery code once.
 *
 * Lost key (no key):
 *   POST /v1/recovery                       {"handle", "method": "proof"} -> challenge to post on an already verified link,
 *                                           or {"handle", "method": "code", "recovery_code"} -> verified at once.
 *                                           Returns a claim_token ONCE (keep it: it is the only way to collect the key).
 *   POST /v1/recovery/{number}/check        {"claim_token"} -> looks for the challenge on the verified links (auto-verify)
 *   POST /v1/recovery/{number}/claim        {"claim_token"} -> after admin approval: the new key, once
 * Staff (capability accounts:recover, admin):
 *   GET  /v1/admin/recovery                 requests, newest first (?status=)
 *   POST /v1/admin/recovery/{number}/approve|reject {"note"} -> public `account.recovered` / `account.recovery_rejected`
 *                                           entry in the moderation log and change feed (no secrets). Approve revokes
 *                                           the old keys and browser sessions at once; the requester then claims a new key.
 * Limits: POST /v1/recovery 5 per client network per hour; a recovery code is checked BEFORE any per-account cap is charged
 * (a wrong code costs only the sender's network budget), then 3 per account per UTC day; proof requests 3 per account per
 * client network per UTC day and 20 per account per UTC day. check/claim: the claim token is validated first; a valid
 * token is charged 10 per request per hour, an invalid one 20 per client network per hour (so strangers guessing tokens
 * can never use up the owner's budget). Identity verify 20 per account per hour; recovery code 5 per account per day.
 */
import type { Ctx } from '../context';
import { requireAuth, requirePepper } from '../auth';
import { hmacHex } from '../crypto';
import { HttpError, intParam, json, nowIso, readJson } from '../http';
import { DAY_BUCKET_PREFIX, clientNetwork, enforceRate } from '../limits';
import { requireCapability } from '../policy';
import { bumpContentCacheVersion } from '../cache-version';
import { deleteAccountSessions } from '../sessions';
import { revokeAccountOAuth } from '../oauth/store';
import { citizenPath } from '../views';
import { PROVIDERS, type Provider, findProof, instructions, newChallenge, normalizeSubject, profileUrl } from '../recovery';
import { issueKey, KEY_WARNING } from './accounts';

export const MAX_IDENTITIES = 10;
export const CHALLENGE_TTL_MS = 24 * 3_600_000;
export const CLAIM_TTL_MS = 7 * 86_400_000;
export const RECOVERY_EVENTS = ['account.recovered', 'account.recovery_rejected'] as const;
const RECOVERY_CODE_WARNING = 'Store this recovery code somewhere safe and offline. It is shown once and works once: with it (and an admin\'s approval) you can get a new key if you lose yours.';

function token(prefix: string): string {
  let bin = '';
  for (const b of crypto.getRandomValues(new Uint8Array(32))) bin += String.fromCharCode(b);
  return `${prefix}${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
const RECOVERY_CODE = /^cwr_[A-Za-z0-9_-]{43}$/;
const CLAIM_TOKEN = /^cwc_[A-Za-z0-9_-]{43}$/;
const hash = (c: Pick<Ctx, 'env'>, value: string) => hmacHex(requirePepper(c.env), value);

/** Statement that (re)places the account's recovery code; returns the plain code once. */
export async function recoveryCodeStatement(c: Pick<Ctx, 'env'>, accountId: string) {
  const value = token('cwr_');
  const statement = c.env.DB.prepare(`INSERT INTO recovery_codes (account_id, code_hash, created_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, used_at = NULL`)
    .bind(accountId, await hash(c, value), nowIso());
  return { value, statement, view: { value, warning: RECOVERY_CODE_WARNING } };
}

// ---------------------------------------------------------------- linked identities

interface IdentityRow { id: number; account_id: string; provider: Provider; subject: string; challenge: string; status: string; method: string | null; proof_url: string | null; created_at: string; verified_at: string | null; last_checked_at: string | null }

const identityView = (r: IdentityRow, withChallenge = true) => ({
  id: r.id, provider: r.provider, subject: r.subject, url: profileUrl(r.provider, r.subject), status: r.status,
  method: r.method, proof_url: r.proof_url, verified_at: r.verified_at, created_at: r.created_at,
  ...(withChallenge && r.status !== 'verified' ? { challenge: r.challenge, instructions: instructions(r.provider, r.subject, r.challenge) } : {}),
});

/** Public "verified links" of an account (profile API and page). */
export async function verifiedLinks(env: Ctx['env'], accountId: string) {
  const { results } = await env.DB.prepare("SELECT * FROM linked_identities WHERE account_id = ? AND status = 'verified' ORDER BY provider, subject").bind(accountId).all<IdentityRow>();
  return results.map((r) => ({ provider: r.provider, subject: r.subject, url: profileUrl(r.provider, r.subject), method: r.method, proof_url: r.proof_url, verified_at: r.verified_at }));
}

export async function listIdentities(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const { results } = await c.env.DB.prepare("SELECT * FROM linked_identities WHERE account_id = ? AND status != 'removed' ORDER BY id").bind(p.account.id).all<IdentityRow>();
  return json(200, { items: results.map((r) => identityView(r)) });
}

export async function createIdentity(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const body = await readJson(c.request);
  const provider = body.provider as Provider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'invalid_provider', { allowed: PROVIDERS });
  const subject = normalizeSubject(c.env, provider, body.subject);
  if (!subject) throw new HttpError(400, 'invalid_subject', { provider });
  const db = c.env.DB;
  const taken = await db.prepare("SELECT account_id FROM linked_identities WHERE provider = ? AND subject = ? AND status = 'verified'").bind(provider, subject).first<{ account_id: string }>();
  if (taken && taken.account_id !== p.account.id) throw new HttpError(409, 'identity_taken', { provider, subject });
  const mine = await db.prepare("SELECT * FROM linked_identities WHERE account_id = ? AND provider = ? AND subject = ? AND status != 'removed'").bind(p.account.id, provider, subject).first<IdentityRow>();
  if (mine) return json(200, identityView(mine));
  const count = (await db.prepare("SELECT COUNT(*) AS n FROM linked_identities WHERE account_id = ? AND status != 'removed'").bind(p.account.id).first<{ n: number }>())!.n;
  if (count >= MAX_IDENTITIES) throw new HttpError(409, 'too_many_identities', { max: MAX_IDENTITIES });
  const row = await db.prepare(`INSERT INTO linked_identities (account_id, provider, subject, challenge, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING *`)
    .bind(p.account.id, provider, subject, newChallenge(p.account.number), nowIso()).first<IdentityRow>();
  return json(201, identityView(row!));
}

async function ownIdentity(c: Ctx, accountId: string): Promise<IdentityRow> {
  const id = Number(c.params[0]);
  const row = await c.env.DB.prepare("SELECT * FROM linked_identities WHERE id = ? AND account_id = ? AND status != 'removed'").bind(id, accountId).first<IdentityRow>();
  if (!row) throw new HttpError(404, 'identity_not_found');
  return row;
}

export async function verifyIdentity(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const row = await ownIdentity(c, p.account.id);
  await enforceRate(c.env, `identity-verify:${p.account.id}`, 20, 3_600_000, 'identity_verify');
  const at = nowIso();
  const proof = await findProof(row.provider, row.subject, row.challenge);
  if (!proof.ok) {
    await c.env.DB.prepare('UPDATE linked_identities SET last_checked_at = ? WHERE id = ?').bind(at, row.id).run();
    throw new HttpError(422, 'proof_not_found', { provider: row.provider, subject: row.subject, detail: proof.detail, challenge: row.challenge, instructions: instructions(row.provider, row.subject, row.challenge) });
  }
  try {
    await c.env.DB.prepare(`UPDATE linked_identities SET status = 'verified', method = ?, proof_url = ?, verified_at = COALESCE(verified_at, ?), last_checked_at = ? WHERE id = ?`)
      .bind(proof.method, proof.proof_url, at, at, row.id).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new HttpError(409, 'identity_taken', { provider: row.provider, subject: row.subject });
    throw e;
  }
  await bumpContentCacheVersion(c.env.DB).run();
  return json(200, identityView((await c.env.DB.prepare('SELECT * FROM linked_identities WHERE id = ?').bind(row.id).first<IdentityRow>())!));
}

export async function removeIdentity(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const row = await ownIdentity(c, p.account.id);
  await c.env.DB.batch([c.env.DB.prepare("UPDATE linked_identities SET status = 'removed' WHERE id = ?").bind(row.id), bumpContentCacheVersion(c.env.DB)]);
  return json(200, { id: row.id, provider: row.provider, subject: row.subject, status: 'removed' });
}

export async function newRecoveryCode(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  await enforceRate(c.env, `${DAY_BUCKET_PREFIX}recovery-code:${p.account.id}`, 5, 86_400_000, 'recovery_code');
  const code = await recoveryCodeStatement(c, p.account.id);
  await code.statement.run();
  return json(201, { recovery_code: code.view });
}

// ---------------------------------------------------------------- recovery requests

interface RequestRow { number: number; account_id: string; method: 'proof' | 'code'; challenge: string | null; claim_hash: string; status: string; proof_identity_id: number | null; proof_url: string | null; created_at: string; expires_at: string; verified_at: string | null; decided_at: string | null; decided_by: string | null; decision_note: string | null; completed_at: string | null; handle?: string }

const NEXT: Record<string, string> = {
  pending: 'Post the challenge on one of your verified links, then call check.',
  verified: 'Proof received. An admin reviews the request; then call claim to collect your new key (once).',
  approved: 'Approved: your old key and browser sessions are revoked. Call claim with your claim_token to collect the new key (once).',
  completed: 'Done: the new key was issued.',
  rejected: 'An admin rejected this request. See the public moderation log for the note.',
  expired: 'This request expired. Start a new one.',
};

const requestView = (r: RequestRow, links: { provider: string; subject: string; url: string }[] = []) => ({
  number: r.number, ref: `recovery-${r.number}`, status: r.status, method: r.method, created_at: r.created_at, expires_at: r.expires_at,
  verified_at: r.verified_at, decided_at: r.decided_at, completed_at: r.completed_at, proof_url: r.proof_url,
  ...(r.status === 'pending' && r.challenge ? { challenge: r.challenge, post_it_on: links.map((l) => ({ ...l, how: instructions(l.provider as Provider, l.subject, r.challenge!) })) } : {}),
  next: NEXT[r.status],
});

async function networkId(c: Ctx): Promise<string> {
  const net = clientNetwork(c.request.headers.get('cf-connecting-ip') || 'local');
  return (await hmacHex(requirePepper(c.env), net)).slice(0, 32);
}
async function networkBucket(c: Ctx): Promise<string> {
  return `recovery-ip:${await networkId(c)}`;
}
export const PROOF_PER_ACCOUNT_NETWORK_DAY = 3;
export const PROOF_PER_ACCOUNT_DAY = 20;
export const BAD_CLAIM_PER_NETWORK_HOUR = 20;

export async function startRecovery(c: Ctx): Promise<Response> {
  requirePepper(c.env);
  await enforceRate(c.env, await networkBucket(c), 5, 3_600_000, 'recovery_ip');
  const body = await readJson(c.request);
  const method = body.method;
  // HOOK: 'signing_key' (an agent's Ed25519 key) is planned; it is not accepted yet.
  if (method === 'signing_key') throw new HttpError(400, 'method_not_available', { method, planned: true });
  if (method !== 'proof' && method !== 'code') throw new HttpError(400, 'invalid_method', { allowed: ['proof', 'code'] });
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase().replace(/^@/, '') : '';
  const acct = handle ? await c.env.DB.prepare("SELECT id, number, handle, status, deleted_at FROM accounts WHERE handle = ?").bind(handle).first<{ id: string; number: number; handle: string; status: string; deleted_at: string | null }>() : null;
  if (!acct || acct.deleted_at || acct.status === 'disabled') throw new HttpError(404, 'account_not_found');
  // No per-account cap before the caller has shown something only the owner has: otherwise anyone who knows a handle
  // could use up the owner's daily recovery budget (denial of recovery). See the method branches below.
  const db = c.env.DB;
  const claim = token('cwc_');
  const at = nowIso();
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  let row: RequestRow | null;
  let links: { provider: string; subject: string; url: string }[] = [];
  if (method === 'code') {
    const code = typeof body.recovery_code === 'string' ? body.recovery_code.trim() : '';
    if (!RECOVERY_CODE.test(code)) throw new HttpError(403, 'invalid_recovery_code');
    const codeHash = await hash(c, code);
    // a wrong code is charged only to the sender's network (above); the account's cap is charged once the code matched,
    // and before it is used up, so a capped request never burns a valid code
    const matches = await db.prepare('SELECT 1 FROM recovery_codes WHERE account_id = ? AND code_hash = ? AND used_at IS NULL').bind(acct.id, codeHash).first();
    if (!matches) throw new HttpError(403, 'invalid_recovery_code');
    await enforceRate(c.env, `${DAY_BUCKET_PREFIX}recovery:${acct.id}`, 3, 86_400_000, 'recovery_account');
    // atomic: the code works once
    const used = await db.prepare('UPDATE recovery_codes SET used_at = ? WHERE account_id = ? AND code_hash = ? AND used_at IS NULL RETURNING account_id')
      .bind(at, acct.id, codeHash).first();
    if (!used) throw new HttpError(403, 'invalid_recovery_code');
    row = await db.prepare(`INSERT INTO recovery_requests (account_id, method, claim_hash, status, created_at, expires_at, verified_at)
      VALUES (?, 'code', ?, 'verified', ?, ?, ?) RETURNING *`).bind(acct.id, await hash(c, claim), at, new Date(Date.now() + CLAIM_TTL_MS).toISOString(), at).first<RequestRow>();
  } else {
    const verified = await db.prepare("SELECT provider, subject FROM linked_identities WHERE account_id = ? AND status = 'verified' ORDER BY id").bind(acct.id).all<{ provider: Provider; subject: string }>();
    if (!verified.results.length) throw new HttpError(409, 'no_verified_links', { hint: 'use method "code" with your recovery code' });
    // A proof request proves nothing yet (the proof comes later through check), so its cap is per account AND client
    // network: one network cannot lock the owner out. A higher per-account ceiling bounds the admin queue.
    await enforceRate(c.env, `${DAY_BUCKET_PREFIX}recovery-net:${acct.id}:${await networkId(c)}`, PROOF_PER_ACCOUNT_NETWORK_DAY, 86_400_000, 'recovery_account_network');
    await enforceRate(c.env, `${DAY_BUCKET_PREFIX}recovery-proof:${acct.id}`, PROOF_PER_ACCOUNT_DAY, 86_400_000, 'recovery_account');
    links = verified.results.map((l) => ({ provider: l.provider, subject: l.subject, url: profileUrl(l.provider, l.subject) }));
    row = await db.prepare(`INSERT INTO recovery_requests (account_id, method, challenge, claim_hash, status, created_at, expires_at)
      VALUES (?, 'proof', ?, ?, 'pending', ?, ?) RETURNING *`).bind(acct.id, newChallenge(acct.number), await hash(c, claim), at, expires).first<RequestRow>();
  }
  return json(201, { request: requestView(row!, links), claim_token: claim, warning: 'Keep the claim_token: it is shown once and is the only way to check this request and collect the new key.' });
}

async function claimedRequest(c: Ctx): Promise<RequestRow> {
  const number = Number(c.params[0]);
  const body = await readJson(c.request);
  const claim = typeof body.claim_token === 'string' ? body.claim_token.trim() : '';
  // The claim token is validated BEFORE the per-request bucket is charged: a stranger with a wrong token is charged to
  // their own network and can never use up the owner's check/claim budget (denial of recovery).
  const row = CLAIM_TOKEN.test(claim)
    ? await c.env.DB.prepare('SELECT * FROM recovery_requests WHERE number = ? AND claim_hash = ?').bind(number, await hash(c, claim)).first<RequestRow>()
    : null;
  if (!row) {
    await enforceRate(c.env, `recovery-claim-ip:${await networkId(c)}`, BAD_CLAIM_PER_NETWORK_HOUR, 3_600_000, 'recovery_claim_ip');
    throw new HttpError(403, 'invalid_claim_token');
  }
  await enforceRate(c.env, `recovery-claim:${number}`, 10, 3_600_000, 'recovery_claim');
  const expired = Date.parse(row.expires_at) <= Date.now() && ['pending', 'verified', 'approved'].includes(row.status);
  if (expired) {
    await c.env.DB.prepare("UPDATE recovery_requests SET status = 'expired' WHERE number = ?").bind(number).run();
    row.status = 'expired';
  }
  return row;
}

export async function checkRecovery(c: Ctx): Promise<Response> {
  const row = await claimedRequest(c);
  if (row.status !== 'pending') return json(200, requestView(row));
  const { results } = await c.env.DB.prepare("SELECT * FROM linked_identities WHERE account_id = ? AND status = 'verified' ORDER BY id").bind(row.account_id).all<IdentityRow>();
  const links = results.map((l) => ({ provider: l.provider, subject: l.subject, url: profileUrl(l.provider, l.subject) }));
  for (const l of results) {
    const proof = await findProof(l.provider, l.subject, row.challenge!);
    if (proof.ok) {
      const at = nowIso();
      await c.env.DB.prepare(`UPDATE recovery_requests SET status = 'verified', verified_at = ?, proof_identity_id = ?, proof_url = ?, expires_at = ? WHERE number = ? AND status = 'pending'`)
        .bind(at, l.id, proof.proof_url, new Date(Date.now() + CLAIM_TTL_MS).toISOString(), row.number).run();
      return json(200, requestView((await c.env.DB.prepare('SELECT * FROM recovery_requests WHERE number = ?').bind(row.number).first<RequestRow>())!));
    }
  }
  return json(200, { ...requestView(row, links), detail: 'The challenge was not found on any verified link yet. It can take a minute for a bio or DNS change to show.' });
}

export async function claimRecovery(c: Ctx): Promise<Response> {
  const row = await claimedRequest(c);
  if (row.status !== 'approved') throw new HttpError(409, 'recovery_not_approved', { status: row.status, next: NEXT[row.status] });
  const key = await issueKey(c, row.account_id);
  const at = nowIso();
  const [done] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE recovery_requests SET status = 'completed', completed_at = ? WHERE number = ? AND status = 'approved'").bind(at, row.number),
    c.env.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM recovery_requests WHERE number = ? AND completed_at = ?)`).bind(at, row.account_id, row.number, at),
  ]);
  if (!done.meta.changes) throw new HttpError(409, 'recovery_not_approved', { status: 'completed' });
  await key.statement.run();
  const account = await c.env.DB.prepare('SELECT handle FROM accounts WHERE id = ?').bind(row.account_id).first<{ handle: string }>();
  return json(200, { handle: account!.handle, api_key: key.view, warning: KEY_WARNING });
}

// ---------------------------------------------------------------- staff

/**
 * Staff view of recovery requests. Carries what a reviewer needs to judge a request: the challenge (public by design:
 * the requester posts it on the external resource), where it was seen, the link that proved it and when that link was
 * verified, and the citizen's current verified links. Never keys, claim tokens or recovery codes (only "code used, when").
 */
export async function adminRecoveryData(env: Ctx['env'], status: string | null, limit = 50) {
  const where = status ? 'WHERE r.status = ?' : '';
  const binds = [...(status ? [status] : []), limit];
  const { results } = await env.DB.prepare(`SELECT r.*, a.handle, a.number AS account_number, a.kind, d.handle AS decided_by_handle
    FROM recovery_requests r JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts d ON d.id = r.decided_by
    ${where} ORDER BY r.number DESC LIMIT ?`).bind(...binds).all<any>();
  // identities of the listed accounts: their verified links plus any link that proved a listed request (even if removed since)
  const { results: ids } = results.length ? await env.DB.prepare(`SELECT * FROM linked_identities WHERE account_id IN (SELECT r.account_id FROM recovery_requests r ${where} ORDER BY r.number DESC LIMIT ?)
      AND (status = 'verified' OR id IN (SELECT r.proof_identity_id FROM recovery_requests r ${where} ORDER BY r.number DESC LIMIT ?)) ORDER BY provider, subject`)
    .bind(...binds, ...binds).all<IdentityRow>() : { results: [] as IdentityRow[] };
  const linkView = (l: IdentityRow) => ({ provider: l.provider, subject: l.subject, url: profileUrl(l.provider, l.subject), status: l.status, method: l.method, proof_url: l.proof_url, verified_at: l.verified_at });
  return {
    items: results.map((r) => {
      const proofLink = r.proof_identity_id ? ids.find((l) => l.id === r.proof_identity_id) : undefined;
      const evidence = r.method === 'code'
        ? { kind: 'recovery_code' as const, detail: 'The citizen\'s one-time recovery code matched (the code itself is never stored or shown).', seen_at: r.verified_at }
        : proofLink ? { kind: 'linked_identity' as const, detail: `The challenge was found on ${proofLink.provider}:${proofLink.subject}, a link this citizen verified before.`, seen_at: r.verified_at, seen_on: r.proof_url, link: linkView(proofLink) }
          : null;
      return {
        number: r.number, ref: `recovery-${r.number}`, status: r.status, method: r.method,
        account: { handle: r.handle, kind: r.kind, ref: `citizen-${r.account_number}`, url: citizenPath(r.handle) },
        proof: r.method === 'code' ? 'recovery code' : proofLink ? `${proofLink.provider}:${proofLink.subject}` : null, proof_url: r.proof_url,
        challenge: r.method === 'proof' ? r.challenge : null,
        evidence,
        verified_links: ids.filter((l) => l.account_id === r.account_id && l.status === 'verified').map(linkView),
        created_at: r.created_at, verified_at: r.verified_at, expires_at: r.expires_at,
        decided_at: r.decided_at, decided_by: r.decided_by_handle ?? null, note: r.decision_note, completed_at: r.completed_at,
      };
    }),
  };
}

const STATUSES = ['pending', 'verified', 'approved', 'completed', 'rejected', 'expired'];

export async function adminListRecovery(c: Ctx): Promise<Response> {
  requireCapability(c.principal, 'accounts:recover');
  const status = c.url.searchParams.get('status');
  if (status && !STATUSES.includes(status)) throw new HttpError(400, 'invalid_query_parameter', { parameter: 'status', allowed: STATUSES });
  return json(200, await adminRecoveryData(c.env, status, intParam(c.url, 'limit', 50, 1, 200)));
}

export async function adminDecideRecovery(c: Ctx): Promise<Response> {
  const p = requireCapability(c.principal, 'accounts:recover');
  const number = Number(c.params[0]);
  const decision = c.params[1] as 'approve' | 'reject';
  const body = await readJson(c.request);
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim() : '';
  if (!note || note.length > 280) throw new HttpError(400, 'note_required', { max_length: 280 });
  const db = c.env.DB;
  const row = await db.prepare('SELECT r.*, a.number AS account_number FROM recovery_requests r JOIN accounts a ON a.id = r.account_id WHERE r.number = ?').bind(number).first<RequestRow & { account_number: number }>();
  if (!row) throw new HttpError(404, 'recovery_not_found');
  if (row.account_id === p.account.id) throw new HttpError(409, 'cannot_decide_own_recovery');
  if (Date.parse(row.expires_at) <= Date.now() && ['pending', 'verified'].includes(row.status)) throw new HttpError(409, 'recovery_expired');
  const allowed = decision === 'approve' ? ['verified'] : ['pending', 'verified'];
  if (!allowed.includes(row.status)) throw new HttpError(409, 'invalid_recovery_state', { status: row.status, needs: allowed });
  const at = nowIso();
  const proof = row.method === 'code' ? 'recovery_code' : (await db.prepare('SELECT provider FROM linked_identities WHERE id = ?').bind(row.proof_identity_id).first<{ provider: string }>())?.provider ?? null;
  const type = decision === 'approve' ? 'account.recovered' : 'account.recovery_rejected';
  const results = await db.batch([
    db.prepare(`UPDATE recovery_requests SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, expires_at = ? WHERE number = ? AND status = ?`)
      .bind(decision === 'approve' ? 'approved' : 'rejected', at, p.account.id, note, new Date(Date.now() + CLAIM_TTL_MS).toISOString(), number, row.status),
    // public record: no secrets, no challenge, no claim token
    db.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) SELECT ?, 'account', ?, ?, json_object('note', ?, 'request', ?, 'method', ?, 'proof', ?), ? WHERE changes() = 1`)
      .bind(type, row.account_number, p.account.id, note, `recovery-${number}`, row.method, proof, at),
    ...(decision === 'approve' ? [
      db.prepare('UPDATE api_keys SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL').bind(at, row.account_id),
      deleteAccountSessions(db, row.account_id),
      ...revokeAccountOAuth(db, row.account_id, 'key_rotation'),
    ] : []),
    db.prepare(`INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, created_at) VALUES (?, ?, 'account', ?, ?, ?)`)
      .bind(p.account.id, decision === 'approve' ? 'recovery.approve' : 'recovery.reject', `recovery-${number}`, note, at),
  ]);
  if (!results[0].meta.changes) throw new HttpError(409, 'invalid_recovery_state');
  const out = await adminRecoveryData(c.env, null, 200);
  return json(200, out.items.find((x) => x.number === number));
}
