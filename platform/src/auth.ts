import type { Env } from './env';
import { API_KEY_PATTERN, hmacHex } from './crypto';
import { HttpError } from './http';
import { ACCESS_PATTERN, isMcpEndpoint, mcpResource, resourceMetadataUrl, siteOrigin, type McpEndpoint } from './oauth/config';

export interface AccountRow {
  number: number;
  id: string;
  handle: string;
  kind: 'human' | 'agent';
  status: 'active' | 'frozen' | 'disabled';
  trusted: number;
  frozen_batch_id: string | null;
  created_at: string;
}

export interface Principal {
  account: AccountRow;
  roles: Set<string>;
  keyId: string;
  /**
   * Set when the caller used an OAuth access token (cwo1_…) instead of the API key: the granted scopes and the grant.
   * Such a principal never carries roles (no staff powers through OAuth) and src/oauth/scopes.ts limits what it may call.
   */
  oauth?: { grantId: string; clientId: string; scopes: string[] };
}

/**
 * Requests the MCP server builds for a platform tool (src/mcp/server.ts restRequest) and hands to the router in-process,
 * each remembered with the MCP endpoint (/mcp or /mcp/me) it came from. An OAuth access token is accepted only on that
 * endpoint itself and on these internal requests: its audience is the resource of one endpoint (RFC 8707), so the same
 * token sent straight to /v1 from outside, or to the other endpoint, is refused (401 invalid_token).
 */
const MCP_INTERNAL = new WeakMap<Request, McpEndpoint>();
export function markMcpInternal(request: Request, endpoint: McpEndpoint): Request { MCP_INTERNAL.set(request, endpoint); return request; }
export const isMcpInternal = (request: Request): boolean => MCP_INTERNAL.has(request);
/** The MCP endpoint a request belongs to: the path itself, or the endpoint an internal /v1 request was built for. */
export function mcpEndpointOf(request: Request): McpEndpoint | null {
  const path = new URL(request.url).pathname;
  return isMcpEndpoint(path) ? path : MCP_INTERNAL.get(request) ?? null;
}

/** WWW-Authenticate for a refused OAuth token (RFC 6750 3.1 + RFC 9728 resource_metadata of the endpoint called). */
export function invalidTokenHeader(request: Request, env: Env, description: string): Record<string, string> {
  const meta = resourceMetadataUrl(siteOrigin(env, new URL(request.url)), mcpEndpointOf(request) ?? undefined);
  return { 'www-authenticate': `Bearer error="invalid_token", error_description="${description}", resource_metadata="${meta}"` };
}

/** Refreshes oauth_grants.last_used_at at most this often (most requests do no D1 write). */
const GRANT_TOUCH_MS = 3_600_000;

async function authenticateOAuth(request: Request, env: Env, token: string): Promise<Principal> {
  const url = new URL(request.url);
  const refuse = (code: string) => new HttpError(401, 'invalid_token', { reason: code }, invalidTokenHeader(request, env, code));
  const endpoint = mcpEndpointOf(request);
  if (!endpoint) throw refuse('token_audience_is_mcp');
  const hash = await hmacHex(requirePepper(env), `oauth:${token}`); // same input as src/oauth/store.ts tokenHash
  const row = await env.DB.prepare(
    `SELECT a.*, t.expires_at AS token_expires_at, t.scope AS token_scope, g.id AS grant_id, g.client_id AS grant_client_id,
       g.resource AS grant_resource, g.last_used_at AS grant_last_used_at, g.revoked_at AS grant_revoked_at
     FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN accounts a ON a.id = g.account_id
     WHERE t.token_hash = ? AND t.kind = 'access'`,
  ).bind(hash).first<AccountRow & { token_expires_at: string; token_scope: string; grant_id: string; grant_client_id: string; grant_resource: string; grant_last_used_at: string | null; grant_revoked_at: string | null }>();
  const now = Date.now();
  if (!row || row.grant_revoked_at) throw refuse('unknown_or_revoked');
  if (Date.parse(row.token_expires_at) <= now) throw refuse('expired');
  // bound to one endpoint: a /mcp token is refused at /mcp/me and the other way round
  if (row.grant_resource !== mcpResource(siteOrigin(env, url), endpoint)) throw refuse('wrong_audience');
  // a frozen, banned or deleted citizen's connected apps stop working at once (their grants are also revoked on those changes)
  if (row.status !== 'active') throw new HttpError(403, row.status === 'frozen' ? 'account_frozen' : 'account_disabled');
  if (!row.grant_last_used_at || now - Date.parse(row.grant_last_used_at) >= GRANT_TOUCH_MS) {
    await env.DB.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').bind(new Date(now).toISOString(), row.grant_id).run();
  }
  const { token_expires_at, token_scope, grant_id, grant_client_id, grant_resource, grant_last_used_at, grant_revoked_at, ...account } = row;
  return { account, roles: new Set(), keyId: `oauth:${grant_id}`, oauth: { grantId: grant_id, clientId: grant_client_id, scopes: token_scope.split(' ').filter(Boolean) } };
}

export function requirePepper(env: Env): string {
  if (typeof env.KEY_PEPPER !== 'string' || env.KEY_PEPPER.length < 32) throw new HttpError(500, 'server_misconfigured');
  return env.KEY_PEPPER;
}

/**
 * Resolves the `Authorization: Bearer cw1_...` header (or an OAuth access token cwo1_…, MCP only: authenticateOAuth).
 * Returns null when no header is present; throws 401/403 for bad keys.
 */
export async function authenticate(request: Request, env: Env): Promise<Principal | null> {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const token = header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  if (ACCESS_PATTERN.test(token)) return authenticateOAuth(request, env, token);
  if (!API_KEY_PATTERN.test(token)) throw new HttpError(401, 'invalid_api_key');
  const hash = await hmacHex(requirePepper(env), token);
  const row = await env.DB.prepare(
    `SELECT a.*, k.id AS key_id,
       (SELECT group_concat(role) FROM account_roles r WHERE r.account_id = a.id) AS roles
     FROM api_keys k JOIN accounts a ON a.id = k.account_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
  ).bind(hash).first<AccountRow & { key_id: string; roles: string | null }>();
  if (!row) throw new HttpError(401, 'invalid_api_key');
  if (row.status === 'disabled') throw new HttpError(403, 'account_disabled');
  const { key_id, roles, ...account } = row;
  return { account, roles: new Set(roles ? roles.split(',') : []), keyId: key_id };
}

export function requireAuth(principal: Principal | null): Principal {
  if (!principal) throw new HttpError(401, 'api_key_required');
  return principal;
}

/**
 * A role only takes effect while the account is active: a frozen (or disabled) admin or
 * moderator keeps the role row but loses every staff power until the status is restored.
 */
export const hasActiveRole = (p: Principal | null, role: string): boolean => !!p && p.account.status === 'active' && p.roles.has(role);
export const isActiveStaff = (p: Principal | null): boolean => hasActiveRole(p, 'admin') || hasActiveRole(p, 'moderator');

export function requireRole(principal: Principal | null, ...roles: string[]): Principal {
  const p = requireAuth(principal);
  if (!roles.some((role) => p.roles.has(role))) throw new HttpError(403, 'forbidden', { required_role: roles });
  if (p.account.status !== 'active') throw new HttpError(403, p.account.status === 'frozen' ? 'account_frozen' : 'account_disabled', { staff_access: 'suspended' });
  return p;
}

export const isAdmin = (p: Principal) => hasActiveRole(p, 'admin');
/** Admin-marked trusted accounts and (active) admins are exempt from defensive modes. */
export const isTrustedAccount = (p: Principal) => p.account.trusted === 1 || hasActiveRole(p, 'admin');
export const accountAgeHours = (account: { created_at: string }, now = Date.now()) => (now - Date.parse(account.created_at)) / 3_600_000;

/**
 * The Principal of a signed-in browser session (website writes, src/pages/writes.ts): the same account row, roles and
 * active key id that the account's Bearer key would give, so the shared handlers apply identical rules and limits.
 */
export async function principalForAccount(env: Env, accountId: string): Promise<Principal | null> {
  const row = await env.DB.prepare(
    `SELECT a.*, (SELECT k.id FROM api_keys k WHERE k.account_id = a.id AND k.revoked_at IS NULL LIMIT 1) AS key_id,
       (SELECT group_concat(role) FROM account_roles r WHERE r.account_id = a.id) AS roles
     FROM accounts a WHERE a.id = ?`,
  ).bind(accountId).first<AccountRow & { key_id: string | null; roles: string | null }>();
  if (!row) return null;
  const { key_id, roles, ...account } = row;
  return { account, roles: new Set(roles ? roles.split(',') : []), keyId: key_id ?? '' };
}
