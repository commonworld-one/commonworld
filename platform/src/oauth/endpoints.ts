/**
 * OAuth 2.1 endpoints that answer JSON (the consent page is src/pages/oauth-pages.ts):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 Protected Resource Metadata of the MCP server at /mcp
 *   GET  /.well-known/oauth-protected-resource/mcp/me  the same for /mcp/me (authentication required; own resource URI)
 *   GET  /.well-known/oauth-authorization-server        RFC 8414 Authorization Server Metadata (issuer = site origin)
 *   POST /oauth/register                                 RFC 7591 Dynamic Client Registration (public; rate limited per network)
 *   POST /oauth/token                                    authorization_code (PKCE S256 required) and refresh_token (rotated)
 *   POST /oauth/revoke                                   RFC 7009 token revocation (revokes the whole grant)
 *
 * CORS is open (`Access-Control-Allow-Origin: *`, no credentials): browser-based MCP clients call these directly, and
 * none of them reads a cookie. Token responses are `no-store`. No token, code, secret or verifier is ever logged or
 * reflected in an error.
 */
import type { Env } from '../env';
import { HttpError, json, readTextCapped } from '../http';
import { hmacHex } from '../crypto';
import { requirePepper } from '../auth';
import { clientNetwork, enforceRate, DAY_BUCKET_PREFIX } from '../limits';
import { enforceMinuteRate } from '../ratelimit';
import { getSettings } from '../settings';
import {
  AS_METADATA_PATH, CLIENT_ID_PATTERN, CLIENT_SECRET_PATTERN, CODE_PATTERN, DCR, OAUTH_PATHS, PRM_MCP_ME_PATH, PRM_MCP_PATH, PRM_PATH, REFRESH_PATTERN, SCOPES, SCOPE_TEXT,
  TOKEN_RATE_PER_MINUTE, VERIFIER_PATTERN, ACCESS_PATTERN, APPS_PAGE, MCP_ENDPOINT, MCP_ME_ENDPOINT, canonicalResource, issuerOf, mcpResource, parseScope, randomToken, redirectProblem, resourceHint, s256, sameString, scopeString,
  type McpEndpoint,
} from './config';
import { consumeCode, createGrant, findRefresh, getClient, grantOfToken, insertClient, recordCodeReplay, revokeGrant, rotateRefresh, tokenHash, type Client } from './store';

const API_PATHS = new Set<string>([PRM_PATH, PRM_MCP_PATH, PRM_MCP_ME_PATH, AS_METADATA_PATH, OAUTH_PATHS.register, OAUTH_PATHS.token, OAUTH_PATHS.revoke]);
export const isOAuthApiPath = (path: string): boolean => API_PATHS.has(path);

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'WWW-Authenticate, Retry-After',
};
const PREFLIGHT: Record<string, string> = {
  ...CORS,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'access-control-max-age': '86400',
};
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };
const META_CACHE = { 'cache-control': 'public, max-age=300' };

/** OAuth error body (RFC 6749 5.2): {"error", "error_description"}; never echoes a submitted secret. */
class OAuthError extends Error {
  constructor(public status: number, public error: string, public description: string, public headers: Record<string, string> = {}) { super(error); }
}
const oauthJson = (status: number, body: unknown, headers: Record<string, string> = {}) => json(status, body, { ...CORS, ...NO_STORE, ...headers });

/** RFC 9728 document of one MCP endpoint: /mcp (root and /mcp suffix) or /mcp/me (its own resource URI). */
export function protectedResourceMetadata(origin: string, endpoint: McpEndpoint = MCP_ENDPOINT): Record<string, unknown> {
  const me = endpoint === MCP_ME_ENDPOINT;
  return {
    resource: mcpResource(origin, endpoint),
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: me ? 'Commonworld MCP server (sign-in required)' : 'Commonworld MCP server',
    resource_documentation: `${origin}/mcp`,
    'x-commonworld': {
      // /mcp: without a token the public tools keep working; /mcp/me: every request needs a token or key (401 otherwise)
      anonymous_access: me ? `none: every request without a credential is 401 (the same server without sign-in is ${mcpResource(origin, MCP_ENDPOINT)})` : 'public read tools, plus account_register and the recovery tools',
      api_key_alternative: 'Authorization: Bearer cw1_… (your own Commonworld API key) also works',
      token_audience: `A token works only at ${mcpResource(origin, endpoint)}, the resource it was issued for.`,
      scopes: SCOPE_TEXT,
    },
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${OAUTH_PATHS.token}`,
    registration_endpoint: `${origin}${OAUTH_PATHS.register}`,
    revocation_endpoint: `${origin}${OAUTH_PATHS.revoke}`,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: `${origin}/mcp`,
    'x-commonworld': {
      connected_apps: `${origin}${APPS_PAGE}`,
      resources: [mcpResource(origin, MCP_ENDPOINT), mcpResource(origin, MCP_ME_ENDPOINT)],
      token_audience: 'An access token works only at the MCP endpoint named by the resource it was issued for (/mcp or /mcp/me; no resource parameter = /mcp), never at the other one and never directly on /v1.',
    },
  };
}

/** Entry point (src/index.ts) for the paths of isOAuthApiPath. */
export async function handleOAuthApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = issuerOf(env, url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...PREFLIGHT, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
  if (path === PRM_PATH || path === PRM_MCP_PATH || path === PRM_MCP_ME_PATH || path === AS_METADATA_PATH) {
    if (request.method !== 'GET') return json(405, { error: { code: 'method_not_allowed' } }, { ...CORS, allow: 'GET, HEAD, OPTIONS' });
    const doc = path === AS_METADATA_PATH ? authorizationServerMetadata(origin) : protectedResourceMetadata(origin, path === PRM_MCP_ME_PATH ? MCP_ME_ENDPOINT : MCP_ENDPOINT);
    return json(200, doc, { ...CORS, ...META_CACHE });
  }
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return oauthJson(405, { error: 'invalid_request', error_description: 'POST only' }, { allow: 'POST, OPTIONS' });
  }
  try {
    if (path === OAUTH_PATHS.register) return await register(request, env);
    if (path === OAUTH_PATHS.token) return await token(request, env, origin);
    return await revoke(request, env);
  } catch (error) {
    if (error instanceof OAuthError) return oauthJson(error.status, { error: error.error, error_description: error.description }, error.headers);
    if (error instanceof HttpError) {
      // body too large, rate limits: an OAuth-shaped error with the platform code as the description
      const err = error.status === 429 ? 'slow_down' : error.status === 413 ? 'invalid_request' : 'server_error';
      return oauthJson(error.status, { error: err, error_description: error.code, ...(error.status === 429 ? { retry_after_seconds: error.extra.retry_after_seconds } : {}) }, error.headers);
    }
    console.error('oauth endpoint error', path, error instanceof Error ? error.name : 'unknown');
    return oauthJson(500, { error: 'server_error', error_description: 'internal_error' });
  }
}

const netKey = async (env: Env, request: Request, scope: string) =>
  `${scope}:${(await hmacHex(requirePepper(env), clientNetwork(request.headers.get('cf-connecting-ip') || 'local'))).slice(0, 32)}`;

/** Urlencoded (the OAuth format) or JSON form body, at most 8 KB. */
async function readParams(request: Request): Promise<URLSearchParams> {
  const text = await readTextCapped(request, 8192);
  const type = request.headers.get('content-type') ?? '';
  if (/^application\/json\b/i.test(type)) {
    let o: unknown;
    try { o = JSON.parse(text || '{}'); } catch { throw new OAuthError(400, 'invalid_request', 'body is not valid JSON'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new OAuthError(400, 'invalid_request', 'body must be an object');
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string') p.set(k, v);
    return p;
  }
  if (type && !/^application\/x-www-form-urlencoded\b/i.test(type)) throw new OAuthError(400, 'invalid_request', 'use application/x-www-form-urlencoded');
  const p = new URLSearchParams(text);
  for (const k of new Set(p.keys())) if (p.getAll(k).length > 1) throw new OAuthError(400, 'invalid_request', `parameter ${k.slice(0, 32)} repeated`);
  return p;
}

// ---------------------------------------------------------------- RFC 7591 registration

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

async function register(request: Request, env: Env): Promise<Response> {
  // same per-network limit as account sign-ups (limits.register_per_ip_per_hour), counted in its own bucket
  const settings = await getSettings(env);
  await enforceRate(env, await netKey(env, request, 'oauth-reg'), settings['limits.register_per_ip_per_hour'], 3_600_000, 'oauth_registration_ip');
  const text = await readTextCapped(request, 16 * 1024);
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) throw new OAuthError(400, 'invalid_client_metadata', 'Content-Type must be application/json');
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { throw new OAuthError(400, 'invalid_client_metadata', 'body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_client_metadata', 'body must be a JSON object');
  const bad = (d: string): never => { throw new OAuthError(400, 'invalid_client_metadata', d); };

  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > DCR.maxRedirectUris) throw new OAuthError(400, 'invalid_redirect_uri', `redirect_uris must be an array of 1-${DCR.maxRedirectUris} URIs`);
  for (const u of uris) { const p = redirectProblem(u); if (p) throw new OAuthError(400, 'invalid_redirect_uri', p); }

  const rawName = body.client_name === undefined ? 'Unnamed app' : body.client_name;
  if (typeof rawName !== 'string') return bad('client_name must be a string');
  const name = rawName.trim();
  if (!name || name.length > DCR.maxNameLength) return bad(`client_name must be 1-${DCR.maxNameLength} characters`);
  if (CONTROL.test(name)) return bad('client_name must not contain control or direction-changing characters');

  const grants = body.grant_types === undefined ? ['authorization_code', 'refresh_token'] : body.grant_types;
  if (!Array.isArray(grants) || !grants.length || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token') || !grants.includes('authorization_code')) {
    return bad('grant_types must contain authorization_code and may contain refresh_token');
  }
  const responseTypes = body.response_types === undefined ? ['code'] : body.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') return bad('response_types must be ["code"]');
  const method = body.token_endpoint_auth_method === undefined ? 'none' : body.token_endpoint_auth_method;
  if (method !== 'none' && method !== 'client_secret_post') return bad('token_endpoint_auth_method must be none or client_secret_post');
  const scopes = body.scope === undefined ? [...SCOPES] : typeof body.scope === 'string' ? parseScope(body.scope) : null;
  if (!scopes || !scopes.length) return bad(`scope must be a space-separated subset of: ${SCOPES.join(' ')}`);

  // a platform-wide daily ceiling on registrations (a per-network limit alone does not stop a botnet filling the table)
  await enforceRate(env, `${DAY_BUCKET_PREFIX}oauth-reg`, DCR.clientsPerDay, 86_400_000, 'oauth_registration_daily');

  const clientId = randomToken('cwcl_', 16);
  const secret = method === 'client_secret_post' ? randomToken('cwcs_') : null;
  const at = await insertClient(env, { client_id: clientId, client_secret: secret, client_name: name, redirect_uris: uris as string[], grant_types: [...new Set(grants as string[])], token_endpoint_auth_method: method, scope: scopeString(scopes) });
  return oauthJson(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.parse(at) / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name, redirect_uris: uris, grant_types: [...new Set(grants as string[])], response_types: ['code'],
    token_endpoint_auth_method: method, scope: scopeString(scopes),
  });
}

// ---------------------------------------------------------------- client authentication (token, revoke)

async function authenticateClient(env: Env, params: URLSearchParams, request: Request): Promise<Client> {
  if (request.headers.has('authorization')) throw new OAuthError(401, 'invalid_client', 'use client_secret_post (or none for public clients); HTTP Basic is not supported', { 'www-authenticate': 'Basic realm="commonworld"' });
  const id = params.get('client_id') ?? '';
  const client = CLIENT_ID_PATTERN.test(id) ? await getClient(env, id) : null;
  if (!client) throw new OAuthError(401, 'invalid_client', 'unknown client_id');
  if (client.token_endpoint_auth_method === 'client_secret_post') {
    const secret = params.get('client_secret') ?? '';
    if (!CLIENT_SECRET_PATTERN.test(secret) || !client.client_secret_hash || !sameString(await tokenHash(env, secret), client.client_secret_hash)) {
      throw new OAuthError(401, 'invalid_client', 'client authentication failed');
    }
  }
  return client;
}

// ---------------------------------------------------------------- token endpoint

async function token(request: Request, env: Env, origin: string): Promise<Response> {
  await enforceMinuteRate(env, await netKey(env, request, 'oauth-token'), TOKEN_RATE_PER_MINUTE, 'oauth_token');
  const params = await readParams(request);
  const grantType = params.get('grant_type');
  const client = await authenticateClient(env, params, request);
  // RFC 8707: when given, `resource` must name one of the MCP endpoints (and, below, the one the grant is bound to)
  const rawResource = params.get('resource');
  if (rawResource !== null && !canonicalResource(rawResource, origin)) throw new OAuthError(400, 'invalid_target', resourceHint(origin));

  if (grantType === 'authorization_code') {
    const code = params.get('code') ?? '';
    const verifier = params.get('code_verifier') ?? '';
    if (!CODE_PATTERN.test(code)) throw new OAuthError(400, 'invalid_grant', 'invalid authorization code');
    if (!VERIFIER_PATTERN.test(verifier)) throw new OAuthError(400, 'invalid_request', 'code_verifier is required (PKCE S256, 43-128 characters)');
    const { row, reused } = await consumeCode(env, code);
    if (!row) {
      // a second use (OAuth 2.1 4.1.3): recorded atomically, so whatever the first one issued is revoked, and a first
      // exchange still between consumeCode and createGrant (grant_id not attached yet) gets no grant at all
      if (reused && reused.client_id === client.client_id) await recordCodeReplay(env, reused.code_hash, client.client_id);
      throw new OAuthError(400, 'invalid_grant', 'invalid authorization code');
    }
    if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'invalid authorization code');
    if (Date.parse(row.expires_at) <= Date.now()) throw new OAuthError(400, 'invalid_grant', 'authorization code expired');
    const redirect = params.get('redirect_uri');
    if (redirect !== null && redirect !== row.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (!sameString(await s256(verifier), row.code_challenge)) throw new OAuthError(400, 'invalid_grant', 'code_verifier does not match the code_challenge');
    if (rawResource !== null && canonicalResource(rawResource, origin) !== row.resource) throw new OAuthError(400, 'invalid_target', 'resource does not match the authorization request');
    const account = await env.DB.prepare('SELECT status FROM accounts WHERE id = ?').bind(row.account_id).first<{ status: string }>();
    if (account?.status !== 'active') throw new OAuthError(400, 'invalid_grant', 'the account is not active');
    // createGrant re-checks the account and the code inside its own batch: a key rotation, recovery, freeze or deletion
    // that lands after the check above still ends with no grant and no token (null)
    const tokens = await createGrant(env, row, client.grant_types.includes('refresh_token'));
    if (!tokens) throw new OAuthError(400, 'invalid_grant', 'the authorization code was used more than once, or the account is not active or its credentials changed; connect again');
    return oauthJson(200, tokenBody(tokens));
  }

  if (grantType === 'refresh_token') {
    if (!client.grant_types.includes('refresh_token')) throw new OAuthError(400, 'unauthorized_client', 'this client did not register the refresh_token grant');
    const refresh = params.get('refresh_token') ?? '';
    const row = REFRESH_PATTERN.test(refresh) ? await findRefresh(env, refresh) : null;
    if (!row || row.revoked_at || row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'invalid refresh token');
    if (row.used_at) {
      // reuse of a rotated refresh token: someone else may hold it, so the whole family ends (OAuth 2.1 4.3.1)
      await revokeGrant(env, row.grant_id, 'refresh_reuse');
      throw new OAuthError(400, 'invalid_grant', 'refresh token was already used; the app has been disconnected');
    }
    if (Date.parse(row.expires_at) <= Date.now()) throw new OAuthError(400, 'invalid_grant', 'refresh token expired');
    if (row.status !== 'active') throw new OAuthError(400, 'invalid_grant', 'the account is not active');
    // the grant stays bound to its resource: a refresh cannot move the token to the other endpoint
    if (rawResource !== null && canonicalResource(rawResource, origin) !== row.resource) throw new OAuthError(400, 'invalid_target', 'resource does not match the grant');
    const asked = params.get('scope');
    const granted = row.scope.split(' ');
    const scopes = asked === null ? granted : parseScope(asked);
    if (!scopes || !scopes.length || scopes.some((s) => !granted.includes(s))) throw new OAuthError(400, 'invalid_scope', 'scope must be a subset of the granted scope');
    const tokens = await rotateRefresh(env, row, scopeString(scopes));
    if (tokens === 'revoked') throw new OAuthError(400, 'invalid_grant', 'the app has been disconnected');
    if (!tokens) {
      await revokeGrant(env, row.grant_id, 'refresh_reuse');
      throw new OAuthError(400, 'invalid_grant', 'refresh token was already used; the app has been disconnected');
    }
    return oauthJson(200, tokenBody(tokens));
  }
  throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

const tokenBody = (t: { access_token: string; refresh_token: string | null; expires_in: number; scope: string }) => ({
  access_token: t.access_token, token_type: 'Bearer', expires_in: t.expires_in, scope: t.scope, ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
});

// ---------------------------------------------------------------- RFC 7009 revocation

async function revoke(request: Request, env: Env): Promise<Response> {
  await enforceMinuteRate(env, await netKey(env, request, 'oauth-token'), TOKEN_RATE_PER_MINUTE, 'oauth_token');
  const params = await readParams(request);
  const client = await authenticateClient(env, params, request);
  const value = params.get('token');
  if (!value) throw new OAuthError(400, 'invalid_request', 'token is required');
  // unknown, foreign or malformed tokens answer 200 as well (RFC 7009 2.2): nothing to learn from the answer
  if (ACCESS_PATTERN.test(value) || REFRESH_PATTERN.test(value)) {
    const found = await grantOfToken(env, value);
    if (found && found.client_id === client.client_id) await revokeGrant(env, found.grant_id, 'client');
  }
  return oauthJson(200, {});
}
