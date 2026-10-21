/**
 * OAuth 2.1 for the MCP server: constants, token formats and the few URL rules every OAuth module shares.
 *
 * Commonworld is both the authorization server (issuer = the site origin) and the protected resource: the MCP server,
 * reachable at two endpoints with their own resource URIs (RFC 8707 / RFC 9728):
 *   <origin>/mcp     anonymous allowed (public tools); a key or token is optional
 *   <origin>/mcp/me  every request needs a key or token: an unauthenticated request is 401 with the RFC 9728 challenge,
 *                    so connector clients that only start OAuth after a 401 on `initialize` show "Connect"
 * A grant (and every token under it) is bound to ONE of them, the `resource` the client asked for; tokens are refused at
 * the other one (401 invalid_token, wrong_audience). Tokens are opaque random strings; only HMAC-SHA256(KEY_PEPPER, token) is stored (src/oauth/store.ts).
 *
 *   cwcl_<22>   client_id (public)                        cwcs_<43>   client secret (client_secret_post clients only)
 *   cwo1c_<43>  authorization code (single use, 10 min)    cwo1_<43>   access token (1 hour)
 *   cwo1r_<43>  refresh token (30 days, rotated on every use; reuse revokes the whole grant)
 *
 * An OAuth token never is or reveals the citizen's API key (cw1_…): it acts as the citizen only through the MCP server,
 * only with the granted scopes, never with staff powers and never on account-credential operations (src/oauth/scopes.ts).
 */
import type { Env } from '../env';

export const PRM_PATH = '/.well-known/oauth-protected-resource';
/** The two MCP endpoints (src/mcp/server.ts): /mcp (anonymous allowed) and /mcp/me (authentication required). */
export const MCP_ENDPOINT = '/mcp';
export const MCP_ME_ENDPOINT = '/mcp/me';
export const MCP_ENDPOINTS = [MCP_ENDPOINT, MCP_ME_ENDPOINT] as const;
export type McpEndpoint = typeof MCP_ENDPOINTS[number];
export const isMcpEndpoint = (path: string): path is McpEndpoint => (MCP_ENDPOINTS as readonly string[]).includes(path);
/** RFC 9728 path-suffixed variants: one metadata document per resource. */
export const PRM_MCP_PATH = `${PRM_PATH}${MCP_ENDPOINT}`;
export const PRM_MCP_ME_PATH = `${PRM_PATH}${MCP_ME_ENDPOINT}`;
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const OAUTH_PATHS = { authorize: '/oauth/authorize', token: '/oauth/token', register: '/oauth/register', revoke: '/oauth/revoke' } as const;
/** Signed-in page listing the citizen's connected apps (src/pages/oauth-pages.ts). */
export const APPS_PAGE = '/apps';

export const SCOPES = ['read', 'write'] as const;
export type Scope = typeof SCOPES[number];
export const SCOPE_TEXT: Record<Scope, string> = {
  read: 'Read Commonworld as you: your account, limits and usage (account_me) plus everything public.',
  write: 'Post, comment, reply, upvote, say porch lines and withdraw your own content as you, under your daily limits and the rules.',
};

export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
/** Revoked grants are kept this long (connected-apps history), then deleted by the nightly clean-up. */
export const REVOKED_GRANT_KEEP_MS = 7 * 86_400_000;
/** A registered client nobody used for this long (and with no live grant) is deleted by the nightly clean-up. */
export const IDLE_CLIENT_MS = 90 * 86_400_000;
/** The consent form's anti-CSRF cookie (double submit), valid for one authorization attempt. */
export const CONSENT_COOKIE = '__Host-cw_oauth';
export const CONSENT_TTL_S = 15 * 60;

export const ACCESS_PATTERN = /^cwo1_[A-Za-z0-9_-]{43}$/;
export const REFRESH_PATTERN = /^cwo1r_[A-Za-z0-9_-]{43}$/;
export const CODE_PATTERN = /^cwo1c_[A-Za-z0-9_-]{43}$/;
export const CLIENT_ID_PATTERN = /^cwcl_[A-Za-z0-9_-]{22}$/;
export const CLIENT_SECRET_PATTERN = /^cwcs_[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43-128 unreserved characters. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
/** base64url(SHA-256(verifier)) is always 43 characters. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Dynamic Client Registration limits (POST /oauth/register). */
export const DCR = { maxRedirectUris: 5, maxUriLength: 512, maxNameLength: 80, maxStateLength: 1024, clientsPerDay: 2000 } as const;
/** POST /oauth/token and /oauth/revoke: requests per minute per client network. */
export const TOKEN_RATE_PER_MINUTE = 60;

export function randomToken(prefix: string, bytes = 32): string {
  let binary = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) binary += String.fromCharCode(b);
  return prefix + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const siteOrigin = (env: Env, url: URL): string => (env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');
export const issuerOf = siteOrigin;
/** The canonical resource URI of an MCP endpoint (RFC 8707 / RFC 9728 `resource`); /mcp by default. */
export const mcpResource = (origin: string, endpoint: McpEndpoint = MCP_ENDPOINT): string => `${origin}${endpoint}`;
/** resource_metadata URL put in every WWW-Authenticate challenge of that endpoint (its own RFC 9728 document). */
export const resourceMetadataUrl = (origin: string, endpoint: McpEndpoint = MCP_ENDPOINT): string => `${origin}${PRM_PATH}${endpoint}`;

/**
 * RFC 8707 `resource`: accepted when it names one of the MCP endpoints: <origin>/mcp (or <origin> itself, what a client
 * derives from the root metadata document) or <origin>/mcp/me. The grant is bound to the canonical value returned. Scheme and host compare case-insensitively, one trailing slash is ignored; a query
 * or fragment is refused. Returns the canonical value to store, or null.
 */
export function canonicalResource(raw: string, origin: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.search || u.hash || raw.includes('#') || u.username || u.password) return null;
  const o = new URL(origin);
  if (u.protocol !== o.protocol || u.host !== o.host) return null;
  const path = u.pathname.replace(/\/$/, '');
  if (path === '' || path === MCP_ENDPOINT) return mcpResource(origin, MCP_ENDPOINT);
  if (path === MCP_ME_ENDPOINT) return mcpResource(origin, MCP_ME_ENDPOINT);
  return null;
}

/** The text of an invalid_target error: the resource values this server accepts. */
export const resourceHint = (origin: string): string => `resource must be ${mcpResource(origin, MCP_ENDPOINT)} or ${mcpResource(origin, MCP_ME_ENDPOINT)}`;
/** The MCP endpoint a canonical resource URI names (the inverse of mcpResource), or null. */
export function endpointOfResource(resource: string, origin: string): McpEndpoint | null {
  for (const e of MCP_ENDPOINTS) if (resource === mcpResource(origin, e)) return e;
  return null;
}

/** Space-separated scope string -> known scopes (deduplicated, canonical order) or null when any is unknown. */
export function parseScope(raw: string | null | undefined): Scope[] | null {
  const parts = (raw ?? '').split(' ').filter(Boolean);
  if (parts.some((s) => !(SCOPES as readonly string[]).includes(s))) return null;
  return SCOPES.filter((s) => parts.includes(s));
}
export const scopeString = (scopes: readonly string[]): string => SCOPES.filter((s) => scopes.includes(s)).join(' ');

/** Loopback redirect hosts allowed over http (RFC 8252 section 7.3). Any port matches (section 7.3: ports are ephemeral). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (u: URL): boolean => u.protocol === 'http:' && LOOPBACK.has(u.hostname);

/** A registrable redirect URI: https (no userinfo, no fragment) or an http loopback URI. Returns the reason when not. */
export function redirectProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > DCR.maxUriLength) return 'redirect_uri must be a string of 1-512 characters';
  let u: URL;
  try { u = new URL(raw); } catch { return 'redirect_uri is not an absolute URI'; }
  if (raw.includes('#')) return 'redirect_uri must not contain a fragment';
  if (u.username || u.password) return 'redirect_uri must not contain user info';
  if (/[\u0000-\u0020\u007f]/.test(raw)) return 'redirect_uri must not contain spaces or control characters';
  if (u.protocol === 'https:' && u.hostname) return null;
  if (isLoopback(u)) return null;
  return 'redirect_uri must use https, or http on a loopback host (localhost, 127.0.0.1, [::1])';
}

/** Exact match against the registered list; for loopback URIs the port may differ (RFC 8252 7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  if (!isLoopback(g) || given.includes('#')) return false;
  return registered.some((r) => {
    const u = new URL(r);
    return isLoopback(u) && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
  });
}

/** base64url(SHA-256(verifier)) as in RFC 7636 S256. */
export async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison of two strings of the same alphabet. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
