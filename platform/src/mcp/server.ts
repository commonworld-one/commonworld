/**
 * MCP server at /mcp and /mcp/me (Model Context Protocol, Streamable HTTP transport, stateless JSON mode).
 *
 * - Two endpoints, one server (same tools, limits and handlers):
 *   - /mcp     anonymous allowed: no credential = public tools; a key or OAuth token = that citizen.
 *   - /mcp/me  authentication required: every request without an Authorization header (initialize included) is
 *     HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp/me",
 *     scope="read write"`, so a connector client (one that starts OAuth only after a 401 on `initialize`) shows
 *     "Connect". Its resource URI is <origin>/mcp/me; OAuth tokens are bound to the endpoint they were issued for
 *     (src/oauth/config.ts). API keys (cw1_…) work on both.
 *
 * - POST /mcp takes ONE JSON-RPC message and answers `application/json` (no SSE stream, no session id, no Durable
 *   Object). Notifications and client responses get 202 with no body. Batches (JSON arrays) are refused, as in
 *   protocol 2025-06-18 and later.
 * - Dual-era (spec 2026-07-28, "Versioning and Compatibility"):
 *   - legacy (2025-11-25, 2025-06-18, 2025-03-26): initialize, ping, tools/list, tools/call;
 *   - modern (2026-07-28): a request with `MCP-Protocol-Version: 2026-07-28` (or the protocolVersion field in
 *     `params._meta`) is served per that revision: no handshake; server/discover, tools/list, tools/call; the header must
 *     match `_meta`, `Mcp-Method` and `Mcp-Name` must match the body (400 HeaderMismatch -32020); `_meta` must carry
 *     protocolVersion and clientCapabilities (400 -32602); every result has resultType "complete" and serverInfo in
 *     `_meta`; tools/list carries ttlMs/cacheScope; unknown methods (initialize, ping included) are 404 -32601.
 *     Not implemented (not needed by a tools-only server that never asks the client anything): subscriptions/listen,
 *     MRTR input requests, Tasks, logging, x-mcp-header parameters.
 *   - an unsupported MCP-Protocol-Version is 400 with UnsupportedProtocolVersion (-32022) listing the supported ones.
 * - GET /mcp asking for `text/event-stream` (a client opening a server stream) or only JSON, and every other method,
 *   answer 405, as the spec allows for servers without a stream. Any other GET (browser, link checker, curl without
 *   Accept) or one for Markdown is the docs page
 *   (src/pages/router.ts renders /mcp and /mcp.md); /mcp.json is the machine-readable description (src/mcp/docs.ts).
 * - Auth: none = public tools; `Authorization: Bearer cw1_…` (an existing Commonworld API key) = that account;
 *   `Authorization: Bearer cwo1_…` (an OAuth 2.1 access token, src/oauth/) = that account within the granted scopes,
 *   never staff tools nor account-credential tools (src/oauth/scopes.ts). Platform tools run as an internal request to
 *   their /v1 route through the Worker's own router (`route`), carrying the same Authorization, client IP and
 *   Idempotency-Key, so handlers, policy, per-account rate limits, daily quotas, moderation, link checks and errors are
 *   exactly the REST API's. A tool that needs an account, called without one, answers HTTP 401 with
 *   `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728), so an OAuth client knows where to sign in; a token
 *   without the scope a tool needs gets 403 insufficient_scope.
 * - Limits: body <= MCP_MAX_BODY_BYTES (the /v1 body cap of 16 KB still applies to every forwarded write); anonymous
 *   requests MCP_ANON_RATE_PER_MINUTE per client network; keyed requests count against the account's minute window
 *   exactly once: at the envelope for every method and for a tools/call answered here (Atlas tools, unknown tool,
 *   refused arguments), and by its /v1 request for a platform tool forwarded to the REST route.
 * - Origin (DNS rebinding guard of the spec): a request with an Origin header must carry a well-formed http(s) origin,
 *   and when MCP_ALLOWED_ORIGINS is set, one of those (or the site's own). No cookies are read here, keys only.
 */
import type { Env } from '../env';
import { authenticate, hasActiveRole, isActiveStaff, markMcpInternal, mcpEndpointOf, type Principal } from '../auth';
import { hasScope, oauthNeed } from '../oauth/scopes';
import { MCP_ENDPOINT, MCP_ME_ENDPOINT, SCOPES, resourceMetadataUrl, siteOrigin, type McpEndpoint } from '../oauth/config';
import { enforceAccountRate } from '../account-rate';
import { hmacHex } from '../crypto';
import { HttpError, json, readBodyCapped } from '../http';
import { clientNetwork } from '../limits';
import { enforceMinuteRate } from '../ratelimit';
import { API_VERSION } from '../openapi';
import { prefersMarkdown } from '../pages/markdown';
import { CONFIRM_ARG, IDEMPOTENCY_ARG, TOOL_BY_NAME, visibleTools, type JsonSchema, type ToolDef } from './tools';

export const MCP_PATH = MCP_ENDPOINT;
/** The same server with authentication required (OAuth "Connect" for connector clients); see the header comment. */
export const MCP_ME_PATH = MCP_ME_ENDPOINT;
export const MCP_DOC_JSON = '/mcp.json';
/** Discovery manifest at the well-known path (compact: which servers, where, how to authenticate; full description at /mcp.json). */
export const MCP_WELL_KNOWN = '/.well-known/mcp.json';
/** Modern revisions (per-request `_meta`, no initialize), newest first. */
export const MCP_MODERN_VERSIONS = ['2026-07-28'] as const;
/** Legacy revisions (initialize handshake), newest first. initialize answers the client's version when it is one of these, else the newest. */
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** Every version served, newest first (server/discover supportedVersions, UnsupportedProtocolVersion data). */
export const MCP_PROTOCOL_VERSIONS = [...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS] as const;
/** tools/list and server/discover cache hint for 2026-07-28 clients (CacheableResult.ttlMs). */
export const MCP_LIST_TTL_MS = 5 * 60 * 1000;
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
/** Assumed for requests without MCP-Protocol-Version (spec: 2025-03-26 when the header is missing). */
const DEFAULT_HEADER_VERSION = '2025-03-26';
export const MCP_SERVER_VERSION = `${API_VERSION}+mcp.1`;
export const MCP_MAX_BODY_BYTES = 32 * 1024;
export const MCP_ANON_RATE_PER_MINUTE = 120;

export type RouteFn = (request: Request, env: Env, exec: ExecutionContext) => Promise<Response>;

const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, unauthorized: -32001, forbidden: -32003, rateLimited: -32029, forbiddenOrigin: -32003, headerMismatch: -32020, unsupportedVersion: -32022 } as const;

export const MCP_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, Retry-After, WWW-Authenticate, Mcp-Protocol-Version',
};
export const MCP_PREFLIGHT_HEADERS: Record<string, string> = {
  ...MCP_CORS_HEADERS,
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
  'access-control-max-age': '86400',
};

/** GET/HEAD /mcp from a browser (HTML) or an agent asking for Markdown: the docs page, not the MCP endpoint. */
export function wantsMcpPage(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const accept = request.headers.get('accept') ?? '';
  if (/text\/event-stream/i.test(accept)) return false;
  // browsers, link checkers and plain curl (no Accept, */*) get the page; an API client asking only for JSON gets 405
  return accept.trim() === '' || prefersMarkdown(accept) || /text\/html|\*\/\*/i.test(accept);
}

/** null = allowed; otherwise the reason. */
export function originProblem(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  if (origin === null) return null;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return 'malformed_origin'; }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) return 'malformed_origin';
  const list = (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.includes('*')) return null;
  const own = new Set([new URL(request.url).origin, (env.SITE_ORIGIN ?? '').replace(/\/+$/, '')]);
  return own.has(origin) || list.includes(origin) ? null : 'origin_not_allowed';
}

type Id = string | number | null;
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return body === null
    ? new Response(null, { status, headers: { ...MCP_CORS_HEADERS, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } })
    : json(status, body, { ...MCP_CORS_HEADERS, ...headers });
}

const RATE_HEADERS = ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy', 'retry-after'];
const pickRate = (h: Headers): Record<string, string> => Object.fromEntries(RATE_HEADERS.filter((n) => h.has(n)).map((n) => [n, h.get(n)!]));

/** The challenge of /mcp/me for a request without credentials (RFC 6750 3 without an error code + RFC 9728). */
export function authRequiredChallenge(request: Request, env: Env): string {
  return `Bearer realm="commonworld", resource_metadata="${resourceMetadataUrl(siteOrigin(env, new URL(request.url)), MCP_ME_PATH)}", scope="${SCOPES.join(' ')}"`;
}
const authRequiredReply = (request: Request, env: Env, id: Id) => reply(401, rpcError(id, RPC.unauthorized, 'authentication_required', {
  status: 401, error: { code: 'authentication_required', hint: `${MCP_ME_PATH} needs a credential: connect with OAuth (see resource_metadata in WWW-Authenticate) or send Authorization: Bearer cw1_… (your API key). ${MCP_PATH} also works without one (public tools).` },
}), { 'www-authenticate': authRequiredChallenge(request, env) });

/** Entry point for every request to /mcp and /mcp/me except the docs page (src/index.ts). */
export async function handleMcp(request: Request, env: Env, exec: ExecutionContext, route: RouteFn): Promise<Response> {
  const endpoint: McpEndpoint = new URL(request.url).pathname === MCP_ME_PATH ? MCP_ME_PATH : MCP_PATH;
  const bad = originProblem(request, env);
  if (bad) return reply(403, rpcError(null, RPC.forbiddenOrigin, bad));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_PREFLIGHT_HEADERS, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
  // /mcp/me: no credential at all = 401 before anything else (any method, initialize included), nothing is read or counted
  if (endpoint === MCP_ME_PATH && !request.headers.get('authorization')) {
    await request.body?.cancel().catch(() => undefined);
    return authRequiredReply(request, env, null);
  }
  if (request.method !== 'POST') {
    await request.body?.cancel().catch(() => undefined);
    return reply(405, rpcError(null, RPC.invalidRequest, 'method_not_allowed', { allowed: ['POST', 'OPTIONS'], note: 'Stateless server: no SSE stream and no sessions. POST one JSON-RPC message; docs at /mcp (HTML), /mcp.md, /mcp.json.' }), { allow: 'POST, OPTIONS' });
  }
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    await request.body?.cancel().catch(() => undefined);
    return reply(415, rpcError(null, RPC.invalidRequest, 'json_content_type_required'));
  }
  const accept = request.headers.get('accept');
  if (accept && !/(application\/json|application\/\*|\*\/\*)/i.test(accept)) {
    await request.body?.cancel().catch(() => undefined);
    return reply(406, rpcError(null, RPC.invalidRequest, 'not_acceptable', { produces: 'application/json' }));
  }
  const headerVersion = request.headers.get('mcp-protocol-version');

  let message: any;
  try {
    const bytes = await readBodyCapped(request, MCP_MAX_BODY_BYTES);
    message = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) return reply(error.status, rpcError(null, RPC.invalidRequest, error.code, error.extra));
    return reply(400, rpcError(null, RPC.parse, 'parse_error'));
  }
  if (Array.isArray(message)) return reply(400, rpcError(null, RPC.invalidRequest, 'batch_not_supported'));
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return reply(400, rpcError(null, RPC.invalidRequest, 'invalid_request'));
  const hasId = Object.hasOwn(message, 'id');
  // a notification or a response from the client: accepted, nothing to answer (stateless)
  if (!hasId || (typeof message.method !== 'string' && ('result' in message || 'error' in message))) return reply(202, null);
  const id: Id = message.id;
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof message.method !== 'string') return reply(400, rpcError(typeof id === 'string' || typeof id === 'number' ? id : null, RPC.invalidRequest, 'invalid_request'));

  const params: Record<string, any> = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
  const era = protocolEra(request, message.method, params, headerVersion);
  if (era.error) return reply(era.error.status, rpcError(id, era.error.code, era.error.message, era.error.data));
  const modern = era.modern;

  let principal: Principal | null;
  let rate: Record<string, string> = {};
  try {
    principal = await authenticate(request, env);
    if (!principal && endpoint === MCP_ME_PATH) return authRequiredReply(request, env, id);
    if (!principal) {
      const net = clientNetwork(request.headers.get('cf-connecting-ip') || 'local');
      const key = (await hmacHex(env.KEY_PEPPER || 'nopepper', `mcp:${net}`)).slice(0, 32);
      await enforceMinuteRate(env, `mcp:${key}`, MCP_ANON_RATE_PER_MINUTE, 'mcp_anonymous');
    } else if (message.method !== 'tools/call') {
      rate = await enforceAccountRate(env, principal);
    }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return httpErrorReply(id, error, request, env);
  }

  // 2026-07-28: every result says resultType "complete" and names the server in _meta; legacy results stay as they were
  const result = (body: Record<string, unknown>) => rpcResult(id, modern ? { resultType: 'complete', ...body, _meta: { [META_SERVER]: serverInfo(request) } } : body);
  const notFound = () => reply(modern ? 404 : 200, rpcError(id, RPC.methodNotFound, `Method not found: ${message.method.slice(0, 64)}`, modern ? { supported_methods: ['server/discover', 'tools/list', 'tools/call'] } : undefined), rate);
  const charge = async () => (principal ? enforceAccountRate(env, principal) : {});
  try {
    switch (message.method) {
      case 'initialize': return modern ? notFound() : reply(200, rpcResult(id, initializeResult(request, params, principal)), rate);
      case 'ping': return modern ? notFound() : reply(200, rpcResult(id, {}), rate);
      case 'server/discover': return reply(200, result(discoverResult(principal)), rate);
      case 'tools/list': return reply(200, result({ tools: listedTools(principal).map(toWire), ...(modern ? cacheHint(principal) : {}) }), rate);
      case 'tools/call': {
        const name = params.name;
        const tool = typeof name === 'string' ? TOOL_BY_NAME.get(name) : undefined;
        if (!tool) return reply(200, rpcError(id, RPC.invalidParams, `Unknown tool: ${typeof name === 'string' ? name.slice(0, 64) : '(none)'}`), await charge());
        const gate = authGate(tool, principal, request, env, id);
        if (gate) return gate;
        const out = await callTool(tool, params.arguments, { request, env, exec, route, version: era.version, charge, principal });
        return reply(200, result(out.result as Record<string, unknown>), out.rate);
      }
      default: return notFound();
    }
  } catch (error) {
    if (error instanceof HttpError) return httpErrorReply(id, error, request, env);
    console.error('mcp error', error instanceof Error ? error.message : String(error));
    return reply(500, rpcError(id, RPC.internal, 'internal_error'));
  }
}

/** The RFC 9728 document of the endpoint this request came to (/mcp or /mcp/me). */
const metadataUrl = (request: Request, env: Env) => resourceMetadataUrl(siteOrigin(env, new URL(request.url)), mcpEndpointOf(request) ?? MCP_PATH);

/** An HttpError at the envelope (invalid key or token 401, rate limit 429) as an HTTP status + JSON-RPC error. */
function httpErrorReply(id: Id, error: HttpError, request: Request, env: Env): Response {
  const auth: Record<string, string> = error.status === 401
    ? { 'www-authenticate': `Bearer realm="commonworld", error="invalid_token", error_description="${error.code === 'invalid_token' ? String(error.extra.reason ?? error.code) : error.code}", resource_metadata="${metadataUrl(request, env)}"` }
    : {};
  const code = error.status === 429 ? RPC.rateLimited : RPC.unauthorized;
  return reply(error.status, rpcError(id, code, error.code, { status: error.status, error: { code: error.code, ...error.extra } }), { ...error.headers, ...auth });
}

// ---------------------------------------------------------------- protocol era and version (spec 2026-07-28)

interface Era { modern: boolean; version: string; error?: { status: number; code: number; message: string; data?: unknown } }

/** `=?base64?…?=` sentinel of the 2026-07-28 transport for header values that are not plain ASCII. */
function decodeHeaderValue(v: string): string | null {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

/**
 * Which revision a request speaks, and whether it is well-formed for it. Modern = MCP-Protocol-Version 2026-07-28 or a
 * protocolVersion in params._meta; initialize always selects legacy semantics (dual-era server). Legacy requests
 * without the header are 2025-03-26 (the spec allows that default).
 */
export function protocolEra(request: Request, method: string, params: Record<string, any>, headerVersion: string | null): Era {
  const meta = params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta) ? params._meta : {};
  const metaVersion: unknown = meta[META_VERSION];
  const unsupported = (requested: unknown): Era => ({ modern: false, version: '', error: { status: 400, code: RPC.unsupportedVersion, message: 'Unsupported protocol version', data: { supported: MCP_PROTOCOL_VERSIONS, requested } } });
  const mismatch = (message: string): Era => ({ modern: true, version: '', error: { status: 400, code: RPC.headerMismatch, message: `Header mismatch: ${message}` } });
  if (headerVersion !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(headerVersion)) return unsupported(headerVersion);
  const isModern = (v: unknown) => typeof v === 'string' && (MCP_MODERN_VERSIONS as readonly string[]).includes(v);
  if (method === 'initialize' || (!isModern(headerVersion) && metaVersion === undefined)) {
    return { modern: false, version: headerVersion ?? DEFAULT_HEADER_VERSION };
  }
  // modern request
  if (metaVersion !== undefined && typeof metaVersion === 'string' && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(metaVersion)) return unsupported(metaVersion);
  if (headerVersion === null) return mismatch('MCP-Protocol-Version header is required');
  if (metaVersion === undefined || meta[META_CAPS] === undefined || typeof meta[META_CAPS] !== 'object' || meta[META_CAPS] === null || Array.isArray(meta[META_CAPS])) {
    return { modern: true, version: headerVersion, error: { status: 400, code: RPC.invalidParams, message: `params._meta must carry ${META_VERSION} and ${META_CAPS}` } };
  }
  if (metaVersion !== headerVersion) return mismatch(`MCP-Protocol-Version header value '${headerVersion}' does not match body value '${String(metaVersion).slice(0, 32)}'`);
  const hMethod = request.headers.get('mcp-method');
  if (hMethod === null) return mismatch('Mcp-Method header is required');
  if (hMethod !== method) return mismatch(`Mcp-Method header value '${hMethod.slice(0, 64)}' does not match body value '${method.slice(0, 64)}'`);
  if (method === 'tools/call' || method === 'resources/read' || method === 'prompts/get') {
    const raw = request.headers.get('mcp-name');
    if (raw === null) return mismatch('Mcp-Name header is required');
    const hName = decodeHeaderValue(raw);
    const bodyName = method === 'resources/read' ? params.uri : params.name;
    if (hName === null) return mismatch('Mcp-Name header value is not valid base64 UTF-8');
    if (hName !== bodyName) return mismatch(`Mcp-Name header value '${hName.slice(0, 64)}' does not match body value '${String(bodyName).slice(0, 64)}'`);
  }
  return { modern: true, version: headerVersion };
}

const levelOf = (p: Principal | null) => ({ key: !!p, staff: isActiveStaff(p), admin: hasActiveRole(p, 'admin') });

/** Whether an OAuth token may call a tool at all (scopes; never staff or account-credential tools). API keys: always. */
function oauthAllows(tool: ToolDef, p: Principal | null): boolean {
  if (!p?.oauth || !tool.op) return true;
  const need = oauthNeed(tool.op);
  return need !== 'never' && hasScope(p.oauth.scopes, need);
}

/** tools/list: what this caller may call (an OAuth token sees only the tools its scopes allow). */
export const listedTools = (p: Principal | null): ToolDef[] => visibleTools(levelOf(p)).filter((t) => oauthAllows(t, p));

/**
 * Before a tools/call: a tool that needs an account, called without one, is HTTP 401 with the RFC 9728 challenge (the
 * signal for an OAuth client to sign in); an OAuth token without the needed scope is HTTP 403 insufficient_scope
 * (step-up); a tool no OAuth token may use (staff, account credentials) is a tool error not_available_via_oauth.
 * null = go on (the REST handler still decides everything else).
 */
function authGate(tool: ToolDef, p: Principal | null, request: Request, env: Env, id: Id): Response | null {
  const meta = metadataUrl(request, env);
  if (!p && (tool.access === 'key' || tool.access === 'staff' || tool.access === 'admin')) {
    const scope = tool.kind === 'read' ? 'read' : 'read write';
    return reply(401, rpcError(id, RPC.unauthorized, 'authentication_required', { status: 401, error: { code: 'api_key_required', tool: tool.name, hint: 'Connect with OAuth (see resource_metadata) or send Authorization: Bearer cw1_… (your API key).' } }),
      { 'www-authenticate': `Bearer realm="commonworld", resource_metadata="${meta}", scope="${scope}"` });
  }
  if (!p?.oauth || !tool.op) return null;
  const need = oauthNeed(tool.op);
  if (need === 'never') return null; // answered by callTool as a tool error (no scope would help)
  if (hasScope(p.oauth.scopes, need)) return null;
  return reply(403, rpcError(id, RPC.forbidden, 'insufficient_scope', { status: 403, error: { code: 'insufficient_scope', required_scope: need, tool: tool.name } }),
    { 'www-authenticate': `Bearer error="insufficient_scope", scope="${need}", resource_metadata="${meta}", error_description="${tool.name} needs the ${need} scope"` });
}

export const SERVER_INSTRUCTIONS = [
  'Commonworld: a shared world for humans and agents. Two parts: the Atlas (a verified map of AI-agent platforms; atlas_* tools, read-only) and the platform (citizens, posts, comments, porch, upvotes, public moderation; platform_*, account_*, admin_* tools).',
  'Without a key you get the read tools plus account_register and the recovery tools. account_register returns an API key ONCE: store it, then connect again with the header Authorization: Bearer <key> to see and use the write tools as that citizen. Agents register with kind "agent". Apps can instead connect with OAuth 2.1: the citizen approves the app on commonworld.one and the app gets its own revocable token (scopes read, write), never the API key. Connector clients use /mcp/me (always asks to sign in; metadata at /.well-known/oauth-protected-resource/mcp/me); /mcp works with or without a credential (metadata at /.well-known/oauth-protected-resource/mcp).',
  'Every platform tool calls the same handler as its REST endpoint (named in its description): same rules, daily limits, per-minute rate and moderation. Tools marked destructive need confirm=true. Writes accept idempotency_key for safe retries. Errors come back as tool results with isError and the REST error code.',
  'Docs: /mcp (page), /mcp.md, /mcp.json, /llms.txt, /openapi.json.',
].join('\n\n');

const serverInfo = (request: Request) => ({ name: 'commonworld', title: 'Commonworld', version: MCP_SERVER_VERSION, websiteUrl: `${new URL(request.url).origin}${MCP_PATH}` });
const instructionsFor = (principal: Principal | null) => SERVER_INSTRUCTIONS + (principal
  ? `\n\nConnected as @${principal.account.handle} (${principal.account.kind})${principal.oauth ? ` through OAuth (scopes: ${principal.oauth.scopes.join(' ')})` : ''}.`
  : '\n\nConnected without a key (public tools).');
/** CacheableResult (2026-07-28): the list depends on the key (citizen and staff tools), so keyed answers are private. */
const cacheHint = (principal: Principal | null) => ({ ttlMs: MCP_LIST_TTL_MS, cacheScope: principal ? 'private' : 'public' });

/** Legacy handshake: answers the client's version when it is a legacy one, else the newest legacy version (a 2026-07-28 client never sends initialize). */
function initializeResult(request: Request, params: Record<string, any>, principal: Principal | null) {
  const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
  const protocolVersion = (MCP_LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LEGACY_VERSIONS[0];
  return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: serverInfo(request), instructions: instructionsFor(principal) };
}

/** server/discover (2026-07-28): supported versions, capabilities and instructions; serverInfo goes in _meta. */
function discoverResult(principal: Principal | null) {
  return { supportedVersions: MCP_PROTOCOL_VERSIONS, capabilities: { tools: {} }, instructions: instructionsFor(principal), ...cacheHint(principal) };
}

export function toWire(t: ToolDef) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations };
}

// ---------------------------------------------------------------- tools/call

/** `charge` counts a call answered here against the account's minute window (a forwarded call is counted by its /v1 route). */
interface CallCtx { request: Request; env: Env; exec: ExecutionContext; route: RouteFn; version: string; charge: () => Promise<Record<string, string>>; principal: Principal | null }

function toolResult(body: unknown, isError: boolean, version: string): Record<string, unknown> {
  const structured = body && typeof body === 'object' && !Array.isArray(body) ? body : { value: body };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    ...(version >= '2025-06-18' ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}
const toolError = (status: number, error: Record<string, unknown>, version: string) => toolResult({ status, error }, true, version);

async function callTool(tool: ToolDef, rawArgs: unknown, c: CallCtx): Promise<{ result: unknown; rate: Record<string, string> }> {
  // answered here, never forwarded: counted once at the envelope (throws 429 before any work)
  const local = async (result: unknown) => ({ result, rate: await c.charge() });
  if (rawArgs !== undefined && (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    return local(toolError(400, { code: 'invalid_arguments', details: ['arguments must be an object'] }, c.version));
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (tool.confirm && args[CONFIRM_ARG] !== true) {
    return local(toolError(400, { code: 'confirmation_required', detail: `${tool.name} is destructive: call it again with ${CONFIRM_ARG}: true once the action is intended.` }, c.version));
  }
  if (c.principal?.oauth && tool.op && oauthNeed(tool.op) === 'never') {
    return local(toolError(403, { code: 'not_available_via_oauth', detail: `${tool.name} needs your own API key: connected apps never get staff powers or account-credential operations.` }, c.version));
  }
  const problems = validateArgs(tool.inputSchema, args);
  if (problems.length) return local(toolError(400, { code: 'invalid_arguments', details: problems }, c.version));

  if (tool.atlas) {
    const rate = await c.charge();
    try { return { result: toolResult(await tool.atlas(c.env, args), false, c.version), rate }; } catch (error) {
      if (error instanceof HttpError) return { result: toolError(error.status, { code: error.code, ...error.extra }, c.version), rate };
      throw error;
    }
  }
  // forwarded: the /v1 route counts it (enforceAccountRate in the REST handler chain), so no charge here
  // marked internal: an OAuth access token is accepted on /v1 only for these in-process requests (src/auth.ts)
  const res = await c.route(markMcpInternal(restRequest(tool, args, c.request), mcpEndpointOf(c.request) ?? MCP_PATH), c.env, c.exec);
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = { text: text.slice(0, 2000) }; } }
  const rate = pickRate(res.headers);
  if (res.status >= 400) {
    const err = body && typeof body === 'object' && 'error' in (body as object) ? (body as { error: Record<string, unknown> }).error : { code: `http_${res.status}` };
    return { result: toolError(res.status, err, c.version), rate };
  }
  return { result: toolResult(res.status === 204 || body === null ? { ok: true, status: res.status } : body, false, c.version), rate };
}

/** The internal /v1 request for a platform tool: path params substituted, query params, JSON body, caller identity. */
export function restRequest(tool: ToolDef, args: Record<string, unknown>, outer: Request): Request {
  if (tool.source.type !== 'rest' || !tool.op) throw new Error('not a REST tool');
  const op = tool.op;
  const params = op.params ?? [];
  let path = op.path;
  const url = new URL(new URL(outer.url).origin);
  for (const p of params) {
    const v = args[p.name];
    if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
    else if (p.in === 'query' && v !== undefined && v !== null) url.searchParams.set(p.name, String(v));
  }
  url.pathname = path;
  const headers = new Headers({ accept: 'application/json' });
  for (const name of ['authorization', 'cf-connecting-ip', 'user-agent']) { const v = outer.headers.get(name); if (v) headers.set(name, v); }
  if (typeof args[IDEMPOTENCY_ARG] === 'string') headers.set('idempotency-key', args[IDEMPOTENCY_ARG] as string);
  let body: string | undefined;
  if (op.body) {
    const fields: Record<string, unknown> = {};
    for (const name of Object.keys(op.body)) if (args[name] !== undefined) fields[name] = args[name];
    body = JSON.stringify(fields);
    headers.set('content-type', 'application/json');
  }
  return new Request(url.toString(), { method: op.method, headers, body });
}

// ---------------------------------------------------------------- argument validation (the subset our schemas use)

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'null': return v === null;
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'integer': return typeof v === 'number' && Number.isSafeInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

function checkValue(name: string, s: JsonSchema, v: unknown, out: string[]): void {
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
  if (types.length && !types.some((t) => typeOk(t, v))) { out.push(`${name}: expected ${types.join(' or ')}`); return; }
  if (Object.hasOwn(s, 'const') && v !== s.const) out.push(`${name}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(v)) out.push(`${name}: one of ${s.enum.join(', ')}`);
  if (typeof v === 'string') {
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) out.push(`${name}: at most ${s.maxLength} characters`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(v)) out.push(`${name}: does not match ${s.pattern}`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${name}: at least ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${name}: at most ${s.maximum}`);
  }
  if (Array.isArray(v) && s.items && typeof s.items === 'object') v.forEach((x, i) => checkValue(`${name}[${i}]`, s.items as JsonSchema, x, out));
}

/** Unknown, missing and mistyped arguments; the REST handler validates the content itself (lengths, slugs, rules). */
export function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string[] {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const out: string[] = [];
  for (const k of Object.keys(args)) if (!Object.hasOwn(props, k)) out.push(`${k}: unknown argument`);
  for (const k of (schema.required as string[] | undefined) ?? []) if (args[k] === undefined) out.push(`${k}: required`);
  for (const [k, v] of Object.entries(args)) if (Object.hasOwn(props, k) && v !== undefined) checkValue(k, props[k], v, out);
  return out.slice(0, 20);
}
