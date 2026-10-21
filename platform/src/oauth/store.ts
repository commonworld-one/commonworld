/**
 * D1 access for OAuth (tables of migrations/0022_oauth.sql). Every secret is looked up and stored as
 * HMAC-SHA256(KEY_PEPPER, value) (same scheme as API keys and sessions); plain values exist only in the one response
 * that hands them out.
 */
import type { Env } from '../env';
import type { AccountRow } from '../auth';
import { requirePepper } from '../auth';
import { hmacHex } from '../crypto';
import { ACCESS_TTL_MS, CODE_TTL_MS, IDLE_CLIENT_MS, REFRESH_TTL_MS, REVOKED_GRANT_KEEP_MS, randomToken, scopeString } from './config';

export const tokenHash = (env: Env, value: string): Promise<string> => hmacHex(requirePepper(env), `oauth:${value}`);

export interface ClientRow {
  client_id: string; client_secret_hash: string | null; client_name: string; redirect_uris: string; grant_types: string;
  token_endpoint_auth_method: 'none' | 'client_secret_post'; scope: string; created_at: string; last_used_at: string | null;
}
export interface Client extends Omit<ClientRow, 'redirect_uris' | 'grant_types'> { redirect_uris: string[]; grant_types: string[] }

const toClient = (row: ClientRow): Client => ({ ...row, redirect_uris: JSON.parse(row.redirect_uris), grant_types: JSON.parse(row.grant_types) });

export async function getClient(env: Env, clientId: string): Promise<Client | null> {
  const row = await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first<ClientRow>();
  return row ? toClient(row) : null;
}

export async function insertClient(env: Env, c: Omit<Client, 'created_at' | 'last_used_at' | 'client_secret_hash'> & { client_secret: string | null }, now = Date.now()): Promise<string> {
  const at = new Date(now).toISOString();
  await env.DB.prepare(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.client_id, c.client_secret ? await tokenHash(env, c.client_secret) : null, c.client_name,
    JSON.stringify(c.redirect_uris), JSON.stringify(c.grant_types), c.token_endpoint_auth_method, c.scope, at).run();
  return at;
}

export const touchClient = (db: D1Database, clientId: string, at: string): D1PreparedStatement =>
  db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').bind(at, clientId);

// ---------------------------------------------------------------- codes

export interface CodeInput { clientId: string; accountId: string; redirectUri: string; challenge: string; scope: string; resource: string }

export async function createCode(env: Env, input: CodeInput, now = Date.now()): Promise<string> {
  const code = randomToken('cwo1c_');
  await env.DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(await tokenHash(env, code), input.clientId, input.accountId, input.redirectUri, input.challenge,
    input.scope, input.resource, new Date(now).toISOString(), new Date(now + CODE_TTL_MS).toISOString()).run();
  return code;
}

export interface CodeRow { code_hash: string; client_id: string; account_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; expires_at: string; used_at: string | null; grant_id: string | null; replayed_at: string | null }

/**
 * Uses a code once: the UPDATE … WHERE used_at IS NULL wins exactly once (whatever the outcome of the checks that
 * follow, so a code never gets a second try). `reused` = the code exists but was already used: the caller records the
 * replay with recordCodeReplay, which revokes the grant that first use created (OAuth 2.1 4.1.3).
 */
export async function consumeCode(env: Env, code: string, now = Date.now()): Promise<{ row: CodeRow | null; reused: CodeRow | null }> {
  const hash = await tokenHash(env, code);
  const row = await env.DB.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING *')
    .bind(new Date(now).toISOString(), hash).first<CodeRow>();
  if (row) return { row, reused: null };
  const old = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first<CodeRow>();
  return { row: null, reused: old };
}

/**
 * A second use of a code by the client it was issued to (OAuth 2.1 4.1.3), in ONE D1 batch (a transaction): marks the
 * code replayed (createGrant refuses a replayed code) and revokes whatever grant the first use already attached. The
 * first exchange marks the code used, then runs several awaited checks before createGrant attaches grant_id, so a
 * concurrent replay can land in between: D1 serializes the two batches, and either this one comes first (the grant
 * INSERT sees replayed_at and writes nothing, so no token is issued) or createGrant comes first (grant_id is set and
 * this batch revokes that grant and deletes its tokens). Either way the stolen-code race leaves no usable token.
 * (Codex review P1, PR #38.)
 */
export async function recordCodeReplay(env: Env, codeHash: string, clientId: string, now = Date.now()): Promise<void> {
  const at = new Date(now).toISOString();
  const grantOf = 'SELECT grant_id FROM oauth_codes WHERE code_hash = ?2 AND client_id = ?3';
  await env.DB.batch([
    env.DB.prepare('UPDATE oauth_codes SET replayed_at = COALESCE(replayed_at, ?1) WHERE code_hash = ?2 AND client_id = ?3').bind(at, codeHash, clientId),
    env.DB.prepare(`UPDATE oauth_grants SET revoked_at = ?1, revoke_reason = 'code_reuse' WHERE revoked_at IS NULL AND id = (${grantOf})`).bind(at, codeHash, clientId),
    env.DB.prepare(`DELETE FROM oauth_tokens WHERE grant_id = (${grantOf})`).bind(at, codeHash, clientId),
  ]);
}

// ---------------------------------------------------------------- grants and tokens

export interface IssuedTokens { access_token: string; refresh_token: string | null; expires_in: number; scope: string }

/**
 * Statements that store a new access token (+ refresh token when allowed) for a grant. Conditional: a token row is
 * written only while the grant exists, is not revoked and its account is active, checked inside the same D1 batch
 * (one transaction), so a revocation (key rotation, recovery, freeze, deletion) that lands before the batch leaves
 * no usable token behind (Codex review P2-a).
 */
async function tokenStatements(env: Env, grantId: string, scope: string, withRefresh: boolean, now: number): Promise<{ statements: D1PreparedStatement[]; tokens: IssuedTokens }> {
  const access = randomToken('cwo1_');
  const refresh = withRefresh ? randomToken('cwo1r_') : null;
  const at = new Date(now).toISOString();
  const ins = `INSERT INTO oauth_tokens (token_hash, grant_id, kind, scope, created_at, expires_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM oauth_grants g JOIN accounts a ON a.id = g.account_id
      WHERE g.id = ?2 AND g.revoked_at IS NULL AND a.status = 'active')`;
  const statements = [env.DB.prepare(ins).bind(await tokenHash(env, access), grantId, 'access', scope, at, new Date(now + ACCESS_TTL_MS).toISOString())];
  if (refresh) statements.push(env.DB.prepare(ins).bind(await tokenHash(env, refresh), grantId, 'refresh', scope, at, new Date(now + REFRESH_TTL_MS).toISOString()));
  return { statements, tokens: { access_token: access, refresh_token: refresh, expires_in: Math.floor(ACCESS_TTL_MS / 1000), scope } };
}

/**
 * New grant (a connected app) from an exchanged code, with its first token pair, in ONE D1 batch (a transaction) whose
 * grant INSERT is conditional: the account is still active AND the code row is still there, unexchanged and not
 * replayed (recordCodeReplay: a concurrent second use of the code refuses the grant, Codex review P1). Every
 * credential change that must stop an app (key rotation, approved recovery, freeze single or bulk, disable, deletion)
 * deletes the account's codes in its own batch (revokeAccountOAuth / revokeFreezeBatchOAuth), so the code row is the
 * credential generation: if any of them lands between the status check and this batch, nothing is inserted and the
 * caller answers invalid_grant. null = refused, no grant and no token exist. (Codex review P2-a.)
 */
export async function createGrant(env: Env, code: CodeRow, withRefresh: boolean, now = Date.now()): Promise<IssuedTokens | null> {
  const grantId = `grant_${crypto.randomUUID()}`;
  const at = new Date(now).toISOString();
  const { statements, tokens } = await tokenStatements(env, grantId, code.scope, withRefresh, now);
  const [grant] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO oauth_grants (id, client_id, account_id, scope, resource, created_at, last_used_at)
      SELECT ?1, ?2, a.id, ?4, ?5, ?6, ?6 FROM accounts a
      WHERE a.id = ?3 AND a.status = 'active'
        AND EXISTS (SELECT 1 FROM oauth_codes c WHERE c.code_hash = ?7 AND c.account_id = a.id AND c.grant_id IS NULL AND c.replayed_at IS NULL)`)
      .bind(grantId, code.client_id, code.account_id, code.scope, code.resource, at, code.code_hash),
    ...statements,
    env.DB.prepare('UPDATE oauth_codes SET grant_id = ?1 WHERE code_hash = ?2 AND EXISTS (SELECT 1 FROM oauth_grants WHERE id = ?1)').bind(grantId, code.code_hash),
    touchClient(env.DB, code.client_id, at),
  ]);
  return (grant.meta.changes ?? 0) === 1 ? tokens : null;
}

export interface RefreshRow { token_hash: string; grant_id: string; scope: string; expires_at: string; used_at: string | null; client_id: string; account_id: string; resource: string; revoked_at: string | null; status: AccountRow['status'] }

export async function findRefresh(env: Env, token: string): Promise<RefreshRow | null> {
  return env.DB.prepare(`SELECT t.token_hash, t.grant_id, t.scope, t.expires_at, t.used_at, g.client_id, g.account_id, g.resource, g.revoked_at, a.status
    FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN accounts a ON a.id = g.account_id
    WHERE t.token_hash = ? AND t.kind = 'refresh'`).bind(await tokenHash(env, token)).first<RefreshRow>();
}

/**
 * Rotates a refresh token: marks it used (once, atomically) and issues a new pair. null = lost the race (a reuse);
 * 'revoked' = the grant was revoked or the account stopped being active in between (no token was written).
 */
export async function rotateRefresh(env: Env, row: RefreshRow, scope: string, now = Date.now()): Promise<IssuedTokens | null | 'revoked'> {
  const at = new Date(now).toISOString();
  const used = await env.DB.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING token_hash').bind(at, row.token_hash).first();
  if (!used) {
    // gone entirely = the grant was revoked in between (revocation deletes its tokens); still there = a second use
    const still = await env.DB.prepare('SELECT 1 AS x FROM oauth_tokens WHERE token_hash = ?').bind(row.token_hash).first();
    return still ? null : 'revoked';
  }
  const { statements, tokens } = await tokenStatements(env, row.grant_id, scope, true, now);
  const [access] = await env.DB.batch([
    ...statements,
    env.DB.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').bind(at, row.grant_id),
    touchClient(env.DB, row.client_id, at),
  ]);
  return (access.meta.changes ?? 0) === 1 ? tokens : 'revoked';
}

export type RevokeReason = 'user' | 'client' | 'refresh_reuse' | 'code_reuse' | 'account' | 'key_rotation';

/** Statements that end a grant: revoked_at set, every token of it deleted (the refresh family dies with it). */
export const revokeGrantStatements = (db: D1Database, grantId: string, reason: RevokeReason, at = new Date().toISOString()): D1PreparedStatement[] => [
  db.prepare('UPDATE oauth_grants SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL').bind(at, reason, grantId),
  db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').bind(grantId),
];

export async function revokeGrant(env: Env, grantId: string, reason: RevokeReason): Promise<void> {
  await env.DB.batch(revokeGrantStatements(env.DB, grantId, reason));
}

/**
 * Statements for batches: ends every OAuth grant of one account (key rotation, recovery, freeze, disable, deletion),
 * plus its unused codes. Same place as deleteAccountSessions (src/sessions.ts).
 */
export const revokeAccountOAuth = (db: D1Database, accountId: string, reason: RevokeReason): D1PreparedStatement[] => {
  const at = new Date().toISOString();
  return [
    db.prepare('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE account_id = ?)').bind(accountId),
    db.prepare('UPDATE oauth_grants SET revoked_at = ?, revoke_reason = ? WHERE account_id = ? AND revoked_at IS NULL').bind(at, reason, accountId),
    db.prepare('DELETE FROM oauth_codes WHERE account_id = ?').bind(accountId),
  ];
};

/**
 * The same for every account of one bulk-freeze batch (accounts.frozen_batch_id, src/routes/admin.ts createFreeze):
 * reverting the freeze does not reconnect the apps, as with a single freeze.
 */
export const revokeFreezeBatchOAuth = (db: D1Database, batchId: string): D1PreparedStatement[] => {
  const at = new Date().toISOString();
  const accounts = 'SELECT id FROM accounts WHERE frozen_batch_id = ?';
  return [
    db.prepare(`DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE account_id IN (${accounts}))`).bind(batchId),
    db.prepare(`UPDATE oauth_grants SET revoked_at = ?, revoke_reason = 'account' WHERE revoked_at IS NULL AND account_id IN (${accounts})`).bind(at, batchId),
    db.prepare(`DELETE FROM oauth_codes WHERE account_id IN (${accounts})`).bind(batchId),
  ];
};

/** Finds the grant of an access or refresh token (revocation endpoint). */
export async function grantOfToken(env: Env, token: string): Promise<{ grant_id: string; client_id: string } | null> {
  return env.DB.prepare('SELECT t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?')
    .bind(await tokenHash(env, token)).first();
}

// ---------------------------------------------------------------- connected apps

export interface AppView { id: string; client_id: string; client_name: string; redirect_hosts: string[]; scope: string[]; connected_at: string; last_used_at: string | null }

/** The citizen's connected apps: live (not revoked) grants, newest first. */
export async function listApps(env: Env, accountId: string): Promise<AppView[]> {
  const { results } = await env.DB.prepare(`SELECT g.id, g.client_id, g.scope, g.created_at, g.last_used_at, c.client_name, c.redirect_uris
    FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id WHERE g.account_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC LIMIT 100`)
    .bind(accountId).all<{ id: string; client_id: string; scope: string; created_at: string; last_used_at: string | null; client_name: string; redirect_uris: string }>();
  return results.map((r) => ({
    id: r.id, client_id: r.client_id, client_name: r.client_name,
    redirect_hosts: [...new Set((JSON.parse(r.redirect_uris) as string[]).map((u) => new URL(u).host))],
    scope: scopeString(r.scope.split(' ')).split(' ').filter(Boolean), connected_at: r.created_at, last_used_at: r.last_used_at,
  }));
}

/** Revokes one of the account's own grants. false = no such live grant of this account. */
export async function revokeOwnApp(env: Env, accountId: string, grantId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM oauth_grants WHERE id = ? AND account_id = ? AND revoked_at IS NULL').bind(grantId, accountId).first();
  if (!row) return false;
  await revokeGrant(env, grantId, 'user');
  return true;
}

// ---------------------------------------------------------------- nightly clean-up

export interface OAuthPruneResult { codes: number; tokens: number; grants: number; clients: number }

/**
 * Nightly (CLEANUP_CRON, src/index.ts): expired codes and tokens; revoked grants after REVOKED_GRANT_KEEP_MS; grants
 * left with no token at all (every refresh token expired) after a day; registered clients idle for IDLE_CLIENT_MS with
 * no live grant (their revoked grants and codes go first).
 */
export async function pruneOAuth(env: Env, now = Date.now()): Promise<OAuthPruneResult> {
  const nowIso = new Date(now).toISOString();
  const revokedCut = new Date(now - REVOKED_GRANT_KEEP_MS).toISOString();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const idleCut = new Date(now - IDLE_CLIENT_MS).toISOString();
  const idleClients = `SELECT client_id FROM oauth_clients c WHERE COALESCE(c.last_used_at, c.created_at) < ?1
    AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL)`;
  const [codes, tokens, , grants, , , clients] = await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(nowIso),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(nowIso),
    env.DB.prepare('DELETE FROM oauth_tokens WHERE grant_id IN (SELECT id FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?)').bind(revokedCut),
    env.DB.prepare(`DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at < ?1)
      OR (revoked_at IS NULL AND created_at < ?2 AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id))`).bind(revokedCut, dayAgo),
    env.DB.prepare(`DELETE FROM oauth_codes WHERE client_id IN (${idleClients})`).bind(idleCut),
    env.DB.prepare(`DELETE FROM oauth_grants WHERE client_id IN (${idleClients})`).bind(idleCut),
    env.DB.prepare(`DELETE FROM oauth_clients WHERE client_id IN (${idleClients})`).bind(idleCut),
  ]);
  return { codes: codes.meta.changes ?? 0, tokens: tokens.meta.changes ?? 0, grants: grants.meta.changes ?? 0, clients: clients.meta.changes ?? 0 };
}
