import type { Env } from './env';
import type { Ctx, Handler } from './context';
import { authenticate, mcpEndpointOf } from './auth';
import { enforceAccountRate } from './account-rate';
import { HttpError, MAX_BODY_BYTES, errorResponse, json } from './http';
import { ROUTES, type PublicCache } from './api-routes';
import { handlePage } from './pages/router';
import { versionedCacheKey } from './cache-version';
import { CLEANUP_CRON, HOURLY_CRON, pruneOldRecords } from './retention';
import { BACKUP_CRON, RESTORE_CHECK_CRON, logBackup, logCheck, runBackup, runRestoreCheck } from './backup';
import { pruneTrustChecks, runTrustCheck } from './trust';
import { pruneLinkChecks } from './link-check';
import { recountAll, refreshWindows } from './counters';
import { logAiBotVisit, pruneAiBotVisits } from './ai-bots';
import { MCP_ME_PATH, MCP_PATH, handleMcp, wantsMcpPage } from './mcp/server';
import { canonicalHostRedirect } from './hosts';
import { handleOAuthApi, isOAuthApiPath } from './oauth/endpoints';
import { oauthProblem, oauthRouteError } from './oauth/scopes';
import { resourceMetadataUrl, siteOrigin } from './oauth/config';
import { pruneOAuth } from './oauth/store';

async function handle(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  // Public SSR pages, assets, robots.txt and sitemap.xml: everything outside /v1/* and /health.
  // These run before the /v1 Content-Length check below; every body they read goes through the streaming byte-counting
  // readers in src/http.ts (readBodyCapped / readTextCapped: /login and /logout 4 KB, write forms 128 KB).
  // MCP server (src/mcp/server.ts): POST /mcp; a browser or Markdown GET of /mcp is the docs page (src/pages/router.ts)
  if (url.pathname === MCP_PATH && !wantsMcpPage(request)) return handleMcp(request, env, exec, route);
  // /mcp/me: the same server, authentication required on every request (401 + RFC 9728 challenge without a credential).
  // A browser or Markdown GET of it is sent to the docs page.
  if (url.pathname === MCP_ME_PATH) {
    if (wantsMcpPage(request)) return new Response(null, { status: 302, headers: { location: `${MCP_PATH}#oauth`, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
    return handleMcp(request, env, exec, route);
  }
  // OAuth 2.1 for the MCP server (src/oauth/): metadata documents, client registration, token and revocation endpoints.
  // The consent page (/oauth/authorize) and the connected-apps page (/apps) are SSR pages (src/pages/oauth-pages.ts).
  if (isOAuthApiPath(url.pathname)) return handleOAuthApi(request, env);
  const page = await handlePage(request, env, exec);
  if (page) return page;
  if (request.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, service: 'commonworld-v1', environment: env.ENVIRONMENT ?? 'local' });
  if (Number(request.headers.get('content-length') || '0') > MAX_BODY_BYTES) throw new HttpError(413, 'request_body_too_large', { max_bytes: MAX_BODY_BYTES });

  let matched: { handler: Handler; params: string[]; cache?: PublicCache; path: string } | null = null;
  const allowed: string[] = [];
  for (const { method, path, pattern, handler, cache } of ROUTES) {
    const m = url.pathname.match(pattern);
    if (!m) continue;
    allowed.push(method);
    if (method === request.method) { matched = { handler, params: m.slice(1), cache, path }; break; }
  }
  if (!matched) {
    if (!allowed.length) throw new HttpError(404, 'route_not_found');
    // RFC 9110: a 405 lists the methods the path does serve (GET also answers HEAD)
    const allow = [...new Set(allowed.flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m])))].join(', ');
    throw new HttpError(405, 'method_not_allowed', { allowed: allow.split(', ') }, { allow });
  }

  // Every request carrying a key is authenticated and rate limited per account
  // (one active key per account; rotation does not reset the window).
  const principal = await authenticate(request, env);
  // An OAuth access token (MCP only) may call only what its scopes allow, never staff or account-credential routes.
  const problem = principal ? oauthProblem(principal, request.method, matched.path) : null;
  if (problem) throw oauthRouteError(problem.need, resourceMetadataUrl(siteOrigin(env, url), mcpEndpointOf(request) ?? undefined));
  const rateHeaders: Record<string, string> = principal ? await enforceAccountRate(env, principal) : {};
  try {
    return withHeaders(await dispatch(request, env, exec, url, matched, principal), rateHeaders);
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(error.status, error.code, error.extra, { ...rateHeaders, ...error.headers });
    throw error;
  }
}

async function dispatch(request: Request, env: Env, exec: ExecutionContext, url: URL,
  matched: { handler: Handler; params: string[]; cache?: PublicCache }, principal: Awaited<ReturnType<typeof authenticate>>): Promise<Response> {

  const ctx: Ctx = { request, env, exec, url, params: matched.params, principal };
  const cache = matched.cache;
  if (!cache) return matched.handler(ctx);
  if (principal || request.headers.has('authorization')) return withHeaders(await matched.handler(ctx), { vary: 'Authorization' });
  return anonymousPublicRead(ctx, matched.handler, cache);
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

const edgeCacheEnabled = (env: Env) => env.PUBLIC_EDGE_CACHE !== '0';

/** Anonymous GET of a public read: cacheable headers on 200s, optional Workers Cache API layer. */
async function anonymousPublicRead(c: Ctx, handler: Handler, cache: PublicCache): Promise<Response> {
  const cacheable = { 'cache-control': `public, max-age=0, s-maxage=${cache.ttl}`, vary: 'Authorization' };
  let key: Request | null = null;
  let versionUnknown = false;
  if (cache.edgeParams && edgeCacheEnabled(c.env)) {
    const keyUrl = new URL(c.url.pathname, c.url.origin);
    for (const name of cache.edgeParams) {
      const value = c.url.searchParams.get(name);
      if (value !== null) keyUrl.searchParams.set(name, value);
    }
    key = await versionedCacheKey(c.env, keyUrl);
    versionUnknown = key === null;
    const hit = key ? await caches.default.match(key) : undefined;
    if (hit) return withHeaders(hit, { ...cacheable, 'x-cw-cache': 'HIT' });
  }
  const response = await handler(c);
  // cache version unknown (D1 lookup failed): no edge cache and no shared copy downstream either
  if (versionUnknown) return withHeaders(response, { 'cache-control': 'no-store', vary: 'Authorization' });
  if (response.status !== 200) return withHeaders(response, { vary: 'Authorization' });
  const out = withHeaders(response, cacheable);
  if (!key) return out;
  c.exec.waitUntil(caches.default.put(key, out.clone()).catch(() => undefined));
  return withHeaders(out, { 'x-cw-cache': 'MISS' });
}

/**
 * CORS on the /v1 API (owner decision 2026-10-17): any origin may call every /v1 operation, reads and writes.
 * `Access-Control-Allow-Origin: *` and never `Allow-Credentials`, so browsers send no cookies with these calls (and /v1
 * ignores cookies anyway: keys only). Auth and limits do not look at Origin: keys, per-account minute limits, daily
 * quotas and per-network registration limits are the same with or without it. Pages, /login, /logout and /inbox
 * (cookie-based) get no CORS headers.
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, Retry-After, ETag, X-Cw-Cache, X-Commonworld-Status',
};
const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
  'access-control-max-age': '86400',
};
const isApiPath = (path: string) => path === '/v1' || path.startsWith('/v1/');
function withCors(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

async function route(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  try {
    // HEAD = GET without a body (uptime monitors use HEAD; matching only exact methods gave 405).
    if (request.method === 'HEAD') {
      const res = await handle(new Request(request, { method: 'GET' }), env, exec);
      return new Response(null, res);
    }
    return await handle(request, env, exec);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    console.error('unhandled', error);
    return json(500, { error: { code: 'internal_error' } });
  }
}

async function serve(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!isApiPath(path)) return route(request, env, exec);
  // CORS preflight for any /v1 path: answered before auth, routing and limits (it carries no key and does nothing)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS_PREFLIGHT_HEADERS, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
  }
  return withCors(await route(request, env, exec));
}

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    // www.commonworld.one -> commonworld.one, same path and query, permanent (one canonical origin for people, agents and search engines)
    const wwwRedirect = canonicalHostRedirect(request);
    if (wwwRedirect) return wwwRedirect;
    const response = await serve(request, env, exec);
    // AI crawler / agent visit log (src/ai-bots.ts): counts only, after the response, never for ordinary visitors
    logAiBotVisit(request, response, env, exec);
    return response;
  },
  /**
   * Cron Triggers (wrangler.toml `[triggers] crons`): nightly CLEANUP_CRON = retention clean-up (src/retention.ts) +
   * full counters reconcile; hourly HOURLY_CRON = karma_7d window expiry + stored ranks (src/counters.ts) and the trust
   * check of our own domains (src/trust.ts, GET /v1/trust/status); BACKUP_CRON = daily D1 backup to R2, RESTORE_CHECK_CRON =
   * weekly restore check of the newest backup (src/backup.ts, GET /v1/admin/backups). An unknown cron does nothing.
   */
  async scheduled(controller: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    if (controller.cron === HOURLY_CRON) {
      exec.waitUntil(refreshWindows(env, controller.scheduledTime).then(
        (r) => console.log('windows refreshed', JSON.stringify(r)), (error) => console.error('windows refresh failed', error)));
      exec.waitUntil(runTrustCheck(env, controller.scheduledTime).then(
        (r) => console.log('trust check', JSON.stringify(r)), (error) => console.error('trust check failed', error)));
      return;
    }
    if (controller.cron === BACKUP_CRON) {
      exec.waitUntil(runBackup(env, controller.scheduledTime).then(logBackup, (error) => console.error('d1 backup FAILED', error instanceof Error ? error.message : String(error))));
      return;
    }
    if (controller.cron === RESTORE_CHECK_CRON) {
      exec.waitUntil(runRestoreCheck(env, controller.scheduledTime).then(logCheck, (error) => console.error('d1 restore check FAILED', error instanceof Error ? error.message : String(error))));
      return;
    }
    if (controller.cron !== CLEANUP_CRON) { console.error('unknown cron', controller.cron); return; }
    exec.waitUntil(pruneOldRecords(env, controller.scheduledTime).then(
      (deleted) => console.log('retention cleanup', JSON.stringify(deleted)),
      (error) => console.error('retention cleanup failed', error),
    ));
    // AI crawler visit log keeps AI_BOT_RETENTION_DAYS (400) days (src/ai-bots.ts)
    exec.waitUntil(pruneAiBotVisits(env, controller.scheduledTime).then(
      (n) => console.log('ai-bot log pruned', n), (error) => console.error('ai-bot log prune failed', error)));
    exec.waitUntil(pruneTrustChecks(env, controller.scheduledTime).then(
      (n) => console.log('trust checks pruned', n), (error) => console.error('trust checks prune failed', error)));
    // allowed link checks at publish after 90 days (src/link-check.ts); rejections stay
    exec.waitUntil(pruneLinkChecks(env, controller.scheduledTime).then(
      (n) => console.log('link checks pruned', n), (error) => console.error('link checks prune failed', error)));
    // OAuth (src/oauth/store.ts): expired codes and tokens, old revoked grants, idle registered clients
    exec.waitUntil(pruneOAuth(env, controller.scheduledTime).then(
      (r) => console.log('oauth pruned', JSON.stringify(r)), (error) => console.error('oauth prune failed', error)));
    // nightly reconcile of the stored counters (src/counters.ts): repairs any drift from concurrent writes
    exec.waitUntil(recountAll(env).then(() => console.log('counters reconciled'), (error) => console.error('counters reconcile failed', error)));
  },
} satisfies ExportedHandler<Env>;
