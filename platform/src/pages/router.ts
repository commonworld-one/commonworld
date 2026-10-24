/**
 * Public server-rendered pages (GET/HEAD, no auth). Everything outside /v1/* and /health lands here.
 * Pages read through the same data functions as the /v1 API and always render the public (anonymous) view.
 */
import type { Env } from '../env';
import { HttpError, goneError } from '../http';
import { getSettings } from '../settings';
import { ASSETS, BOOT_SCRIPT_SHA256 } from './assets.gen';
import { sectionPage, sectionsPage, tagPage } from './catalog';
import { commentLocation, contentGone, porchVisible, postOgData, siteFacts, sitemapRows } from './data';
import { ogVersion, renderPostOg } from './og';
import { homePage } from './home';
import { esc } from './html';
import { ABOUT_URL, NONCE_PLACEHOLDER, PRIVACY_URL, TERMS_URL, type PageCtx, hasMarkdownTwin, markdownPath } from './layout';
import { markdownError, markdownTarget, prefersMarkdown, renderMarkdown } from './markdown';
import { adminAccess, adminPageHtml, adminPageMd } from './admin';
import { errorPage, inboxPage, loginPage, moderationPage, searchPage, type LoginView } from './misc';
import { citizensPage, porchPage, profilePage } from './people';
import { type PageOut, postPage } from './post';
import { LLMS_PATHS, llmsFullTxt, llmsTxt } from './agent-docs';
import { openapiDoc } from '../openapi';
import { mcpPage } from './mcp-page';
import { API_PAGE_PATH, apiPage } from './api-page';
import { mcpDescription, mcpWellKnown } from '../mcp/docs';
import { MCP_DOC_JSON, MCP_WELL_KNOWN } from '../mcp/server';
import { versionedCacheKey, withoutSharedCache } from '../cache-version';
import { ATLAS_SLASH_REDIRECT, atlasOrigin, atlasText, cleanAtlasDoc, isAtlasPath, proxyAtlas } from '../atlas-proxy';
import { atlasAssetText, atlasAssetsOn, serveAtlasAsset } from '../atlas-assets';
import { queryStats } from '../stats';
import { assertSameOrigin, clearSessionCookie, consumeLoginLink, csrfToken, hasSessionCookie, peekLoginLink, readForm, resolveSession, revokeSession, sessionCookie, type Viewer } from '../sessions';
import { composePage, handleWrite, isWritePath } from './writes';
import { exportPage } from './export';
import { handleOAuthPage, isOAuthPagePath } from './oauth-pages';

/** Validated analytics config from env: an invalid value is ignored (no tag, no CSP host), never echoed. */
export function analyticsConfig(env: Env): { ga4: string | null; beacon: string | null } {
  const ga4 = (env.GA4_ID ?? '').trim();
  const beacon = (env.CF_BEACON_TOKEN ?? '').trim();
  return { ga4: /^G-[A-Z0-9]{4,20}$/.test(ga4) ? ga4 : null, beacon: /^[A-Za-z0-9_-]{8,128}$/.test(beacon) ? beacon : null };
}

const GA_HOSTS = 'https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com';

/**
 * Strict page CSP. No 'unsafe-inline' for scripts or styles. Scripts: 'self' (covers /cdn-cgi/challenge-platform/*,
 * Cloudflare's same-origin JS Detection script), the theme boot script by its sha256, and a per-response nonce:
 * Cloudflare reads `'nonce-…'` from this header and puts it on the inline scripts it injects (JS Detection), and our
 * own inline script carries it too. Pages carry no style="" attributes (code-owned values are classes in ssr.css).
 * Third-party hosts:
 *   Cloudflare Web Analytics (cookieless; the zone may inject it automatically): script static.cloudflareinsights.com,
 *     beacon to cloudflareinsights.com. Always allowed (owner decision 2026-10-17); our own beacon tag still needs CF_BEACON_TOKEN.
 *   GA4_ID -> Google Analytics 4, loaded by site.js only after the visitor clicks Accept (Consent Mode v2)
 * Turnstile (later): https://challenges.cloudflare.com goes into script-src/frame-src ONLY on the signup/signin pages,
 * never site-wide.
 * `nonce` omitted = the documented form (llms-full.txt) with a placeholder.
 */
export const CF_INSIGHTS_SCRIPT = 'https://static.cloudflareinsights.com';
export const CF_INSIGHTS_CONNECT = 'https://cloudflareinsights.com';
export function contentSecurityPolicy(env: Env, nonce?: string): string {
  const a = analyticsConfig(env);
  const script = ["'self'", `'sha256-${BOOT_SCRIPT_SHA256}'`, nonce ? `'nonce-${nonce}'` : "'nonce-<random, new on every response>'", CF_INSIGHTS_SCRIPT, a.ga4 ? 'https://www.googletagmanager.com' : ''];
  const img = ["'self'", 'data:', a.ga4 ? GA_HOSTS : ''];
  const connect = ["'self'", CF_INSIGHTS_CONNECT, a.ga4 ? GA_HOSTS : ''];
  const list = (xs: string[]) => xs.filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src ${list(script)}`,
    "style-src 'self'",
    `img-src ${list(img)}`,
    "font-src 'self'",
    `connect-src ${list(connect)}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'report-uri /v1/csp-report',
    'report-to csp',
  ].join('; ');
}

/** 128-bit random nonce, base64 (CSP nonce-source). */
export function newNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b));
}

/**
 * Puts a fresh nonce on an HTML response: CSP header + our own `<script nonce>` tags. Applied to every HTML response we
 * send, fresh or from the Workers cache, so a cached page never repeats a nonce: the cache stores the copy from before
 * this step, and each hit gets a new nonce here. Pages are small (tens of KB), so the body is read whole.
 * Strict stamping: only the exact attribute our layout emits, `nonce="${NONCE_PLACEHOLDER}"`, is replaced. Any other
 * nonce attribute in the body (a `<script nonce="x">` that is not ours) keeps its value and never gets the fresh nonce,
 * so it stays blocked even if escaping ever failed. User text is escaped by h`` and cannot contain the placeholder
 * attribute either (its quotes become &quot;).
 */
export const NONCE_ATTR = `nonce="${NONCE_PLACEHOLDER}"`;
export function stampNonce(html: string, nonce: string): string {
  return html.split(NONCE_ATTR).join(`nonce="${nonce}"`);
}
export async function withFreshNonce(res: Response, env: Env): Promise<Response> {
  if (!(res.headers.get('content-type') ?? '').startsWith('text/html') || !res.headers.has('content-security-policy')) return res;
  const nonce = newNonce();
  const headers = new Headers(res.headers);
  // a page may widen form-action (the OAuth consent page: its POST answers 303 to the app's redirect URI); keep that
  const formAction = res.headers.get('content-security-policy')?.match(/form-action [^;]+/)?.[0];
  const csp = contentSecurityPolicy(env, nonce);
  headers.set('content-security-policy', formAction ? csp.replace(/form-action [^;]+/, formAction) : csp);
  const body = res.body ? stampNonce(await res.text(), nonce) : null;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/** On every page, asset and redirect response (A+ on securityheaders.com). */
export const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': [
    'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'encrypted-media=()', 'geolocation=()', 'gyroscope=()',
    'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'publickey-credentials-get=()',
    'screen-wake-lock=()', 'serial=()', 'usb=()', 'xr-spatial-tracking=()', 'browsing-topics=()', 'interest-cohort=()',
  ].join(', '),
};

const PAGE_TTL = 30;
const PUBLIC_PAGE_CACHE = `public, max-age=0, s-maxage=${PAGE_TTL}`;
/** Agent docs (/llms.txt, /llms-full.txt, /openapi.json): change only with a deploy or a settings change; 5 minutes is fresh enough. */
/** Same OpenAPI document also at /v1/openapi.json (the Atlas keeps its spec under its API prefix, /api/v1/openapi.json). Canonical: /openapi.json. */
export const OPENAPI_V1_ALIAS = '/v1/openapi.json';
export const DOC_CACHE = 'public, max-age=300, s-maxage=300';
const EDGE_CACHEABLE = new Set([PUBLIC_PAGE_CACHE, DOC_CACHE]);

/**
 * Headers for the agent docs. Same security headers as pages; a document-free CSP (they are never rendered as HTML);
 * CORS open like the Atlas llms files. On closed staging (PAGES_NOINDEX=1) they are still served, but marked
 * `X-Robots-Tag: noindex, nofollow` (robots.txt there already disallows everything).
 */
function docHeaders(env: Env, contentType: string): Record<string, string> {
  return {
    'content-type': contentType, 'cache-control': DOC_CACHE, 'access-control-allow-origin': '*',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    ...noindexHeader(env),
  };
}

/**
 * Page cache key = path + only the query params that route actually reads (others are ignored by the renderer, so
 * they must not split the cache: `/?x=<random>` would otherwise force a full render + D1 reads on every request).
 * Values are normalized the way the renderer reads them (trimmed, empty dropped, fixed order); `/search?q=` is
 * whitespace-collapsed and cut to the 100-char limit, exactly as searchPage reads it.
 */
const FEED_KEYS = ['sort', 'kind', 'window', 'before', 'offset'];
export const PAGE_CACHE_PARAMS: [RegExp, string[]][] = [
  [/^\/$/, FEED_KEYS],
  [/^\/s\/[^/]+$/, FEED_KEYS],
  [/^\/t\/[^/]+$/, [...FEED_KEYS, 'section']],
  [/^\/porch$/, ['before']],
  [/^\/citizens$/, ['sort', 'kind', 'offset']],
  [/^\/posts\/\d+$/, ['order']],
  [/^\/search$/, ['q', 'type']],
  [/^\/moderation$/, ['before']],
];

export function normalizeSearchQuery(q: string): string {
  return q.replace(/\s+/g, ' ').trim().slice(0, 100).trim();
}

/** The URL a public page is cached under (before the content version is added). */
export function pageCacheUrl(url: URL): URL {
  const out = new URL(url.pathname, url.origin);
  const keys = PAGE_CACHE_PARAMS.find(([re]) => re.test(url.pathname))?.[1] ?? [];
  for (const k of keys) {
    let v = (url.searchParams.get(k) ?? '').trim();
    if (k === 'q') v = normalizeSearchQuery(v);
    if (v !== '') out.searchParams.set(k, v);
  }
  return out;
}

type Rendered = string | PageOut;
type Render = (p: PageCtx, env: Env, url: URL, m: RegExpMatchArray, viewer: Viewer | null) => Promise<Rendered> | Rendered;
interface PageRoute { pattern: RegExp; render: Render; private?: boolean }

const PAGES: PageRoute[] = [
  { pattern: /^\/$/, render: (p, env, url) => homePage(p, env, url) },
  { pattern: /^\/porch$/, render: (p, env, url) => porchPage(p, env, url) },
  { pattern: /^\/compose$/, render: (p, env, url) => composePage(p, env, url) },
  { pattern: /^\/export$/, render: (p) => exportPage(p) },
  { pattern: /^\/sections$/, render: (p, env) => sectionsPage(p, env) },
  { pattern: /^\/s\/([a-z0-9-]{1,64})$/, render: (p, env, url, m) => sectionPage(p, env, url, m[1]) },
  { pattern: /^\/t\/([a-z0-9-]{1,64})$/, render: (p, env, url, m) => tagPage(p, env, url, m[1]) },
  { pattern: /^\/posts\/(\d{1,15})$/, render: (p, env, url, m) => postPage(p, env, url, m[1]) },
  { pattern: /^\/citizens$/, render: (p, env, url) => citizensPage(p, env, url) },
  { pattern: /^\/c\/([^/]{1,96})$/, render: (p, env, _url, m) => profilePage(p, env, m[1]) },
  { pattern: /^\/search$/, render: (p, env, url) => searchPage(p, env, url) },
  { pattern: /^\/moderation$/, render: (p, env, url) => moderationPage(p, env, url) },
  { pattern: /^\/mcp$/, render: (p) => mcpPage(p) },
  { pattern: /^\/api$/, render: (p) => apiPage(p) },
  { pattern: /^\/inbox$/, render: (p, env, _url, _m, viewer) => inboxView(p, env, viewer), private: true },
];

async function inboxView(p: PageCtx, env: Env, viewer: Viewer | null): Promise<string> {
  if (!viewer) return inboxPage(p, null);
  const [stats] = await queryStats(env, await getSettings(env), { accountId: viewer.account.id });
  return inboxPage(p, { handle: viewer.account.handle, kind: viewer.account.kind, number: viewer.account.number, karma: stats?.karma ?? 0, karma_7d: stats?.karma_7d ?? 0, created_at: viewer.account.created_at });
}

/** Old / API-style URLs that resolve to a page. `/c/{handle}` is the canonical profile path everywhere (pages and API `url` fields). */
/** Legal/about pages live on the Atlas site; the Worker 301s its own copies of those paths there (absolute, same on staging and prod). */
export const ATLAS_PAGE_REDIRECTS: Record<string, string> = { privacy: PRIVACY_URL, terms: TERMS_URL, about: ABOUT_URL };

async function redirectFor(env: Env, path: string): Promise<string | null> {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/(privacy|terms|about)\/?$/))) return ATLAS_PAGE_REDIRECTS[m[1]];
  if ((m = path.match(/^\/sections\/([a-z0-9-]{1,64})\/?$/))) return `/s/${m[1]}`;
  if ((m = path.match(/^\/tags\/([a-z0-9-]{1,64})\/?$/))) return `/t/${m[1]}`;
  if ((m = path.match(/^\/citizens\/([^/]{1,96})\/?$/))) return `/c/${m[1]}`;
  if ((m = path.match(/^\/comments\/(\d{1,15})$/))) {
    const post = await commentLocation(env, Number(m[1]));
    return post === null ? null : `/posts/${post}#comment-${m[1]}`;
  }
  if ((m = path.match(/^\/porch\/(\d{1,15})$/))) {
    const n = Number(m[1]);
    return (await porchVisible(env, n)) ? `/porch?before=${n + 1}#porch-${n}` : null;
  }
  if (path.length > 1 && path.endsWith('/') && !path.startsWith('/v1/')) return path.replace(/\/+$/, '') || '/';
  return null;
}

function respond(method: string, status: number, body: string | ArrayBuffer | Uint8Array, headers: Record<string, string>): Response {
  return new Response(method === 'HEAD' ? null : body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/** Closed staging (PAGES_NOINDEX=1): every SSR page, error page and sitemap also says noindex in a header, not only in <meta>. */
const noindexHeader = (env: Env): Record<string, string> => (env.PAGES_NOINDEX === '1' ? { 'x-robots-tag': 'noindex, nofollow' } : {});

const htmlHeaders = (env: Env, url: URL, cache: string) => ({
  // the nonce is set per response by withFreshNonce (respond() and cache hits)
  'content-type': 'text/html; charset=utf-8', 'content-security-policy': contentSecurityPolicy(env),
  'reporting-endpoints': `csp="${url.origin}/v1/csp-report"`, 'cache-control': cache, ...noindexHeader(env),
});

function assetResponse(method: string, name: string, version: string | null): Response {
  const a = Object.hasOwn(ASSETS, name) ? ASSETS[name] : null;
  if (!a) return respond(method, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  const body = a.text !== undefined ? a.text : Uint8Array.from(atob(a.base64!), (ch) => ch.charCodeAt(0));
  const cache = version === a.hash ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  // SVGs are documents when opened directly: no script, nothing loaded, only their own inline <style> (favicon dark mode)
  const svg: Record<string, string> = a.type.startsWith('image/svg') ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } : {};
  return respond(method, 200, body, { 'content-type': a.type, 'cache-control': cache, etag: `"${a.hash}"`, ...svg });
}

async function pageCtx(env: Env, url: URL, viewer: Viewer | null = null): Promise<PageCtx> {
  const [facts, settings] = await Promise.all([siteFacts(env), getSettings(env)]);
  return {
    origin: (env.SITE_ORIGIN || url.origin).replace(/\/+$/, ''),
    facts, announcement: settings.announcement, forceNoindex: env.PAGES_NOINDEX === '1', now: Date.now(), analytics: analyticsConfig(env),
    viewer: viewer ? { handle: viewer.account.handle, kind: viewer.account.kind, csrf: await csrfToken(env, viewer.sessionId) } : null,
  };
}

/** Private (never cached, never indexed) page headers; used by /login and /logout. Referrer-Policy no-referrer: the link token is in the URL. */
const privateHtml = (env: Env, url: URL, extra: Record<string, string> = {}) => ({
  ...htmlHeaders(env, url, 'no-store'), 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', ...extra,
});

const LOGIN_STATUS: Record<string, number> = { invalid: 400, expired: 410, used: 410, account_inactive: 403, csrf: 403 };

/**
 * /login and /logout. GET /login only shows the confirm page (prefetch-safe); POST /login uses the link and opens a
 * session; POST /logout ends the current one. POSTs must be same-origin (Origin / Sec-Fetch-Site).
 * The login page renders without analytics: its URL carries the token.
 */
async function authPage(request: Request, env: Env, url: URL): Promise<Response> {
  const method = request.method;
  const path = url.pathname;
  const allow = path === '/login' ? 'GET, HEAD, POST' : 'POST';
  if (!allow.split(', ').includes(method)) return respond(method, 405, 'method not allowed', { 'content-type': 'text/plain; charset=utf-8', allow, 'cache-control': 'no-store' });
  const loginCtx = async (): Promise<PageCtx> => ({ ...(await pageCtx(env, url)), analytics: { ga4: null, beacon: null } });
  const fail = async (reason: Extract<LoginView, { kind: 'failed' }>['reason'], extra: Record<string, string> = {}) =>
    respond(method, LOGIN_STATUS[reason], loginPage(await loginCtx(), { kind: 'failed', reason }), privateHtml(env, url, extra));

  if (method !== 'POST') {
    const token = url.searchParams.get('t') ?? '';
    const state = await peekLoginLink(env, token);
    if (!state.ok) return fail(state.reason);
    return respond(method, 200, loginPage(await loginCtx(), { kind: 'confirm', handle: state.account.handle, accountKind: state.account.kind, token, expires_at: state.expires_at }), privateHtml(env, url));
  }
  try { assertSameOrigin(request, env); } catch { return fail('csrf'); }
  if (path === '/logout') {
    const { viewer } = await resolveSession(env, request);
    if (viewer) await revokeSession(env, viewer.sessionId);
    return respond(method, 303, '', { location: '/', 'cache-control': 'no-store', 'set-cookie': clearSessionCookie() });
  }
  const form = await readForm(request);
  const result = await consumeLoginLink(env, form.get('t') ?? '');
  if (!result.ok) return fail(result.reason);
  return respond(method, 303, '', { location: '/inbox', 'cache-control': 'no-store', 'set-cookie': sessionCookie(result.session), 'referrer-policy': 'no-referrer' });
}

/** User-triggered AI fetchers allowed on closed staging (robots.txt); every other crawler is disallowed there. */
export const STAGING_USER_FETCHERS = ['Claude-User', 'ChatGPT-User', 'Perplexity-User'];

/** Private paths no crawler may fetch. Every user-agent group in robots.txt repeats this whole set: a crawler obeys only
 * the most specific group that names it, so a named group without these lines would ignore the `*` group's Disallows. */
export const ROBOTS_DISALLOW = ['/inbox', '/login', '/admin', '/oauth/', '/apps'] as const;
/** AI crawlers and agents named in their own robots.txt group (policy/ai-bots.json lists every bot we count). */
export const ROBOTS_AI_AGENTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User',
  'Google-Extended', 'Applebot-Extended', 'CCBot', 'meta-externalagent', 'Amazonbot', 'DuckAssistBot', 'MistralAI-User'] as const;

export function robotsTxt(env: Env, origin: string): string {
  // Closed staging: no crawler may crawl, but user-triggered AI fetchers (a person asked an assistant to open a page) may.
  // Pages stay noindex,nofollow (meta + X-Robots-Tag), so nothing gets indexed either way.
  if (env.PAGES_NOINDEX === '1') return `${STAGING_USER_FETCHERS.map((a) => `User-agent: ${a}\nAllow: /\n`).join('\n')}\nUser-agent: *\nDisallow: /\n`;
  const rules = ['Allow: /', ...ROBOTS_DISALLOW.map((d) => `Disallow: ${d}`)].join('\n');
  return `# Commonworld: public pages are open to search engines and AI agents.
# Guide for agents: ${origin}${LLMS_PATHS.llms} (full reference: ${origin}${LLMS_PATHS.llmsFull})
# API description (OpenAPI 3.1): ${origin}${LLMS_PATHS.openapi}
# Machine-readable data: ${origin}/v1/catalog, ${origin}/v1/posts, ${origin}/v1/feed

User-agent: *
${rules}

${ROBOTS_AI_AGENTS.map((a) => `User-agent: ${a}`).join('\n')}
${rules}

Sitemap: ${origin}/sitemap.xml
`;
}

/** Sitemap index (routing option A): the v1 sitemap and the Atlas sitemap under one /sitemap.xml. */
export function sitemapIndexXml(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${esc(origin)}/sitemap-v1.xml</loc></sitemap>
<sitemap><loc>${esc(origin)}/atlas/sitemap.xml</loc></sitemap>
</sitemapindex>
`;
}

async function sitemapXml(env: Env, origin: string, withAtlasRoot = false): Promise<string> {
  const rows = await sitemapRows(env);
  const d = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
  const latestPost = rows.posts.reduce((m, r) => (r.lastmod > m ? r.lastmod : m), '');
  const urls: [string, string][] = [
    ['/', latestPost], ['/porch', ''], ['/sections', latestPost], ['/citizens', ''], ['/moderation', ''], ['/mcp', ''], [API_PAGE_PATH, ''],
    ...rows.sections.map((s): [string, string] => [`/s/${s.slug}`, s.lastmod]),
    ...rows.tags.map((t): [string, string] => [`/t/${t.slug}`, t.lastmod]),
    ...rows.posts.map((p): [string, string] => [`/posts/${p.number}`, p.lastmod]),
    ...rows.citizens.map((c): [string, string] => [`/c/${encodeURIComponent(c.handle)}`, '']),
    // Atlas-owned root pages served through the proxy (the rest of the Atlas is in /atlas/sitemap.xml). Not on closed
    // staging, where these paths 301 to production (QA 2026-10-17 #9).
    ...(withAtlasRoot ? (['/about/', '/privacy/', '/terms/', '/stats/'] as const).map((path): [string, string] => [path, '']) : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([path, lm]) => `<url><loc>${esc(origin + path)}</loc>${lm ? `<lastmod>${d(lm)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

/**
 * Returns a response for page paths, or null when the path belongs to the API (/v1/*, /health).
 * Every HTML response of ours (fresh, error or from the Workers cache) gets a fresh CSP nonce on the way out; the cache
 * holds the copy before this step. Atlas pages proxied from Pages keep their own headers.
 */
export async function handlePage(request: Request, env: Env, exec: ExecutionContext): Promise<Response | null> {
  const res = await handlePageInner(request, env, exec);
  // Atlas responses (proxy or Static Assets) keep the Atlas's own headers; the assets path already added its nonce.
  if (!res || (res.headers.get('x-cw-upstream') ?? '').startsWith('atlas')) return res;
  return withFreshNonce(res, env);
}

async function handlePageInner(request: Request, env: Env, exec: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  // /v1/admin (an API-style path for the staff page) -> /admin; /v1/admin/* stays the API
  if (path === '/v1/admin' && (method === 'GET' || method === 'HEAD')) return respond(method, 301, '', { location: `/admin${url.search}`, 'cache-control': 'public, max-age=86400' });
  if (path === '/health' || path === '/v1' || (path.startsWith('/v1/') && path !== OPENAPI_V1_ALIAS)) return null;
  // Atlas on the same domain: from this Worker's Static Assets (option A3, ATLAS_SOURCE=assets, src/atlas-assets.ts) or,
  // as the rollback path, proxied to the Pages project (option A, ATLAS_ORIGIN, src/atlas-proxy.ts).
  const assetsOn = atlasAssetsOn(env);
  const proxyOrigin = assetsOn ? null : atlasOrigin(env);
  const atlas = assetsOn || !!proxyOrigin;
  if (atlas) {
    if (ATLAS_SLASH_REDIRECT.test(path)) {
      return respond(method, 301, '', { location: `${path}/${url.search}`, 'cache-control': 'public, max-age=86400' });
    }
    // /.well-known/mcp.json is the Worker's own (MCP discovery); every other /.well-known/* file belongs to the Atlas
    if (isAtlasPath(path) && path !== MCP_WELL_KNOWN) return assetsOn ? serveAtlasAsset(request, env, url) : proxyAtlas(request, env, url, proxyOrigin!);
  }
  if (path === '/login' || path === '/logout') {
    try { return await authPage(request, env, url); } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('auth page error', path, error);
      return respond(method, status, `${status} ${error instanceof HttpError ? error.code : 'internal_error'}`, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
  }
  // OAuth consent page and connected apps (src/pages/oauth-pages.ts): private, never cached, never indexed.
  if (isOAuthPagePath(path)) {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return respond(method, 405, 'method not allowed', { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD, POST', 'cache-control': 'no-store' });
    try {
      const out = await handleOAuthPage(request, env, url, (viewer) => pageCtx(env, url, viewer));
      const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };
      const res = 'location' in out
        ? respond(method, 303, '', { ...headers, location: out.location })
        : respond(method, out.status, out.html, {
          ...htmlHeaders(env, url, 'no-store'), ...headers,
          ...(out.formAction ? { 'content-security-policy': contentSecurityPolicy(env).replace("form-action 'self'", `form-action 'self' ${out.formAction}`) } : {}),
        });
      for (const c of out.cookies ?? []) res.headers.append('set-cookie', c);
      return res;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('oauth page error', path, error instanceof Error ? error.name : 'unknown');
      return respond(method, status, `${status} ${error instanceof HttpError ? error.code : 'internal_error'}`, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
  }
  // Website writes (src/pages/writes.ts): POST forms that call the same handlers as the /v1 API.
  if (method === 'POST' && isWritePath(path)) {
    try {
      const w = await handleWrite(request, env, exec, url, (viewer) => pageCtx(env, url, viewer));
      if (w) {
        const cookie: Record<string, string> = w.setCookie ? { 'set-cookie': w.setCookie } : {};
        if (w.out.location) return respond(method, 303, '', { location: w.out.location, 'cache-control': 'no-store', ...cookie });
        return respond(method, w.out.status, w.out.html ?? '', { ...htmlHeaders(env, url, 'no-store'), 'x-robots-tag': 'noindex, nofollow', ...cookie });
      }
    } catch (error) {
      console.error('write error', path, error);
      return respond(method, 500, '500 internal_error', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return respond(method, 405, 'method not allowed', { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD', 'cache-control': 'no-store' });
  }

  // Staff page (src/pages/admin.ts): private, never cached; its markdown twin needs the same staff session.
  if (path === '/admin' || path === '/admin.md') {
    const { viewer, setCookie } = await resolveSession(env, request);
    const access = await adminAccess(env, viewer);
    const cookie: Record<string, string> = setCookie ? { 'set-cookie': setCookie } : {};
    const priv = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow', vary: 'Accept, Cookie', ...cookie };
    if (path === '/admin.md' || prefersMarkdown(request.headers.get('accept'))) {
      const out = await adminPageMd(env, url, access, (env.SITE_ORIGIN || url.origin).replace(/\/+$/, ''));
      return respond(method, out.status, out.markdown, { 'content-type': 'text/markdown; charset=utf-8', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", ...priv });
    }
    const out = await adminPageHtml(await pageCtx(env, url, viewer), env, url, access);
    return respond(method, out.status, out.html, { ...htmlHeaders(env, url, 'private, no-store'), ...priv, link: `<${(env.SITE_ORIGIN || url.origin).replace(/\/+$/, '')}/admin.md>; rel="alternate"; type="text/markdown"` });
  }

  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/assets\/([a-z0-9.-]{1,64})$/))) return assetResponse(method, m[1], url.searchParams.get('v'));
  if ((m = path.match(POST_OG_PATH))) return postOgResponse(request, env, exec, url, Number(m[1]));
  if (path === '/favicon.ico') return assetResponse(method, 'favicon.ico', null);

  // Markdown twins for agents (src/pages/markdown.ts): `.md` paths or `Accept: text/markdown` preferred over HTML.
  let md: { path: string } | null = null;
  try { md = markdownTarget(request, url); } catch (error) {
    return markdownResponse(method, env, url, '/', 404, markdownError(404, error instanceof HttpError ? error.code : 'page_not_found'), null, {}, false);
  }
  if (md) return markdownPage(request, env, exec, url, md.path);

  // A request with a VALID session never reads or fills the shared cache: signed-in pages are personal (header, inbox)
  // and go out `private, no-store`. A missing, junk, expired or unknown cookie gets the shared anonymous copy (plus a
  // clearing Set-Cookie), so a random cookie value cannot be used to bypass the cache.
  const session = hasSessionCookie(request) ? await resolveSession(env, request) : { viewer: null, setCookie: null };
  const signedIn = session.viewer !== null;
  const sessionHeaders: Record<string, string> = session.setCookie ? { 'set-cookie': session.setCookie } : {};
  const withSession = (res: Response): Response => {
    if (!session.setCookie) return res;
    const out = new Response(res.body, res);
    out.headers.append('set-cookie', session.setCookie);
    return out;
  };
  const edge = env.PUBLIC_EDGE_CACHE !== '0' && method === 'GET' && !signedIn;
  // Keyed on path + allow-listed params + content cache version: a hide/restore/freeze bumps the version, so
  // pre-change copies are never served.
  const cacheKey = edge ? await versionedCacheKey(env, pageCacheUrl(url)) : null;
  // edge cache on but the version lookup failed: every response below goes out no-store (done), not public
  const versionUnknown = edge && cacheKey === null;
  if (cacheKey) {
    const hit = await caches.default.match(cacheKey);
    if (hit) { const out = new Response(hit.body, hit); out.headers.set('x-cw-cache', 'HIT'); return withSession(out); }
  }

  const done = (res: Response): Response => {
    if (versionUnknown) return withoutSharedCache(res);
    if (cacheKey && res.status === 200 && EDGE_CACHEABLE.has(res.headers.get('cache-control') ?? '') && !res.headers.has('set-cookie')) exec.waitUntil(caches.default.put(cacheKey, res.clone()).catch(() => undefined));
    return res;
  };

  if (path === '/robots.txt') {
    const origin = (env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');
    return done(respond(method, 200, robotsTxt(env, origin), { 'content-type': 'text/plain; charset=utf-8', 'cache-control': PUBLIC_PAGE_CACHE }));
  }
  if (path === '/sitemap.xml' || path === '/sitemap-v1.xml') {
    const origin = (env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');
    // With the Atlas behind the same domain, /sitemap.xml is an index of the v1 sitemap and the Atlas sitemap.
    const xml = path === '/sitemap.xml' && atlas ? sitemapIndexXml(origin) : await sitemapXml(env, origin, atlas && env.PAGES_NOINDEX !== '1');
    return done(respond(method, 200, xml, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': PUBLIC_PAGE_CACHE, ...noindexHeader(env) }));
  }

  if (path === MCP_DOC_JSON || path === MCP_WELL_KNOWN) {
    const origin = (env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');
    const doc = path === MCP_DOC_JSON ? mcpDescription(origin) : mcpWellKnown(origin);
    return done(respond(method, 200, JSON.stringify(doc, null, 1) + '\n', docHeaders(env, 'application/json; charset=utf-8')));
  }
  if (path === LLMS_PATHS.llms || path === LLMS_PATHS.llmsFull || path === LLMS_PATHS.openapi || path === OPENAPI_V1_ALIAS) {
    const origin = (env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');
    if (path === LLMS_PATHS.openapi || path === OPENAPI_V1_ALIAS) {
      return done(respond(method, 200, JSON.stringify(openapiDoc(origin), null, 1) + '\n', docHeaders(env, 'application/json; charset=utf-8')));
    }
    const [own, atlasDoc] = await Promise.all([
      path === LLMS_PATHS.llms ? llmsTxt(env, origin) : llmsFullTxt(env, origin, contentSecurityPolicy(env), SECURITY_HEADERS),
      assetsOn ? atlasAssetText(env, path) : atlasText(env, path),
    ]);
    // merged agent docs: the v1 text first, then the Atlas file as served by the Pages project
    const text = atlasDoc ? `${own.trimEnd()}\n\n---\n\n<!-- The Atlas (${origin}/atlas/) — same domain, separate static site. -->\n\n${cleanAtlasDoc(atlasDoc)}` : own;
    return done(respond(method, 200, text, docHeaders(env, 'text/plain; charset=utf-8')));
  }

  const route = PAGES.find((r) => (m = path.match(r.pattern)));
  let p: PageCtx | null = null;
  try {
    if (!route) {
      const target = await redirectFor(env, path);
      // never redirect to the URL that was asked for (B2: /privacy/ -> https://commonworld.one/privacy/ on that host)
      const to = target && new URL(target, url).origin + new URL(target, url).pathname !== url.origin + path ? target : null;
      if (to) {
        // /citizens/{handle} -> /c/{handle} (and /sections/, /tags/, /privacy|terms|about -> Atlas) are permanent 301s, kept forever; comment/porch refs are 302 (they move with visibility).
        // only /comments/{n} and /porch/{n} are temporary; the trailing-slash strip (/porch/, /comments/) is a permanent 301 (F2)
        const temporary = /^\/(comments|porch)\/\d{1,15}$/.test(path);
        return done(respond(method, temporary ? 302 : 301, '', { location: to + (to.includes('#') ? '' : url.search), 'cache-control': temporary ? 'public, max-age=300' : 'public, max-age=86400' }));
      }
      // F1: a comment or porch line of a disabled citizen (or on their post) is gone, not missing
      const ref = path.match(/^\/(comments|porch)\/(\d{1,15})$/);
      if (ref && (await contentGone(env, ref[1] === 'porch' ? 'porch' : 'comment', Number(ref[2])))) throw goneError('content_gone', { ref: `${ref[1] === 'porch' ? 'porch' : 'comment'}-${ref[2]}` });
      throw new HttpError(404, 'page_not_found');
    }
    // a merged tag's page moves to its target for good
    const tm = path.match(/^\/t\/([a-z0-9-]{1,64})$/);
    if (tm) {
      const merged = await env.DB.prepare("SELECT merged_into FROM tags WHERE slug = ? AND status = 'merged'").bind(tm[1]).first<{ merged_into: string }>();
      if (merged) return done(respond(method, 301, '', { location: `/t/${merged.merged_into}${url.search}`, 'cache-control': 'public, max-age=86400' }));
    }
    p = await pageCtx(env, url, session.viewer);
    const out = await route.render(p, env, url, m!, session.viewer);
    const html = typeof out === 'string' ? out : out.html;
    const extra = typeof out === 'string' ? {} : out.headers;
    // pages with a markdown twin: the same URL answers text/markdown to `Accept: text/markdown`, so caches must key on Accept
    const twin: Record<string, string> = hasMarkdownTwin(path) ? { vary: 'Accept', link: `<${p.origin}${markdownPath(path)}>; rel="alternate"; type="text/markdown"` } : {};
    return withSession(done(respond(method, 200, html, { ...htmlHeaders(env, url, route.private || signedIn ? 'private, no-store' : PUBLIC_PAGE_CACHE), ...twin, ...extra })));
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : 'internal_error';
    if (status === 500) console.error('page error', path, error);
    try {
      p ??= await pageCtx(env, url, session.viewer);
      // 410 (F1) carries X-Robots-Tag: noindex; closed staging's noindex, nofollow (htmlHeaders) wins over it
      const robots: Record<string, string> = error instanceof HttpError && error.headers['x-robots-tag'] ? { 'x-robots-tag': error.headers['x-robots-tag'] } : {};
      return respond(method, status, errorPage(p, status, code, path), { ...robots, ...htmlHeaders(env, url, 'no-store'), ...sessionHeaders });
    } catch {
      return respond(method, status, `${status} ${code}`, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    }
  }
}

// ---------------------------------------------------------------- per-post Open Graph image

export const POST_OG_PATH = /^\/posts\/(\d{1,15})\/og\.png$/;
/** The current ?v= (the URL the post page links): kept a day by browsers and link-preview caches, edge copy keyed on the
 *  content version too, so a hide or withdraw drops it at once. Any other ?v= (old or missing): 5 minutes. */
export const OG_CACHE_CURRENT = 'public, max-age=86400, s-maxage=86400';
export const OG_CACHE_OTHER = 'public, max-age=300, s-maxage=300';

/**
 * GET /posts/{n}/og.png: the post's 1200x630 PNG (src/pages/og.ts). Anonymous and the same for everyone, so a session
 * cookie is not read. 404 (no-store) when the post has no image of its own (missing, hidden, gone, withdrawn): its page
 * then uses /assets/og-default.png. A render error redirects to that default image (302, no-store) instead of a 500.
 */
async function postOgResponse(request: Request, env: Env, exec: ExecutionContext, url: URL, n: number): Promise<Response> {
  const method = request.method;
  const v = (url.searchParams.get('v') ?? '').slice(0, 32);
  let cacheKey: Request | null = null;
  let versionUnknown = false;
  if (env.PUBLIC_EDGE_CACHE !== '0' && method === 'GET') {
    const keyUrl = new URL(url.pathname, url.origin);
    if (v) keyUrl.searchParams.set('v', v);
    cacheKey = await versionedCacheKey(env, keyUrl);
    versionUnknown = cacheKey === null;
    const hit = cacheKey ? await caches.default.match(cacheKey) : undefined;
    if (hit) { const out = new Response(hit.body, hit); out.headers.set('x-cw-cache', 'HIT'); return out; }
  }
  const notFound = () => respond(method, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...noindexHeader(env) });
  try {
    const post = await postOgData(env, n);
    if (!post) return notFound();
    const host = new URL(env.SITE_ORIGIN || url.origin).host;
    const png = await renderPostOg(post, host);
    const res = respond(method, 200, png, {
      'content-type': 'image/png',
      'cache-control': v === ogVersion(post) ? OG_CACHE_CURRENT : OG_CACHE_OTHER,
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'access-control-allow-origin': '*', ...noindexHeader(env),
    });
    if (versionUnknown) return withoutSharedCache(res);
    if (cacheKey) exec.waitUntil(caches.default.put(cacheKey, res.clone()).catch(() => undefined));
    return res;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return notFound();
    console.error('post og image error', n, error instanceof Error ? error.message : 'unknown');
    return respond(method, 302, '', { location: `/assets/og-default.png?v=${ASSETS['og-default.png'].hash}`, 'cache-control': 'no-store' });
  }
}

// ---------------------------------------------------------------- markdown twins

/** Rough token count (≈ 4 chars per token), as an `X-Markdown-Tokens` hint for agents budgeting context. */
const tokenEstimate = (text: string) => String(Math.ceil(text.length / 4));

function markdownResponse(method: string, env: Env, url: URL, htmlPath: string, status: number, body: string, robots: string | null,
  extra: Record<string, string>, canonical = true): Response {
  const origin = (env.SITE_ORIGIN || url.origin).replace(/\/+$/, '');
  // same robots rule as the HTML page: staging is noindex everywhere; error and variant twins say noindex too
  const xRobots = env.PAGES_NOINDEX === '1' ? 'noindex, nofollow' : status !== 200 ? 'noindex, follow' : robots;
  return respond(method, status, body, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'cache-control': status === 200 ? PUBLIC_PAGE_CACHE : 'no-store',
    vary: 'Accept',
    'x-markdown-tokens': tokenEstimate(body),
    // a twin that is noindex by itself declares no canonical, like its HTML page (the staging switch is not counted)
    ...(canonical && !/\bnoindex\b/i.test(robots ?? '') ? { link: `<${origin}${htmlPath}>; rel="canonical"` } : {}),
    ...(xRobots ? { 'x-robots-tag': xRobots } : {}),
    ...extra,
  });
}

/** Markdown twin of a public page: always the anonymous view, cached like pages under its own key (`__fmt=md`). */
async function markdownPage(request: Request, env: Env, exec: ExecutionContext, url: URL, htmlPath: string): Promise<Response> {
  const method = request.method;
  const page = new URL(htmlPath + url.search, url.origin);
  let cacheKey: Request | null = null;
  let versionUnknown = false;
  if (env.PUBLIC_EDGE_CACHE !== '0' && method === 'GET') {
    const keyUrl = pageCacheUrl(page);
    keyUrl.searchParams.set('__fmt', 'md');
    cacheKey = await versionedCacheKey(env, keyUrl);
    versionUnknown = cacheKey === null;
    const hit = cacheKey ? await caches.default.match(cacheKey) : undefined;
    if (hit) { const out = new Response(hit.body, hit); out.headers.set('x-cw-cache', 'HIT'); return out; }
  }
  try {
    const p = await pageCtx(env, url);
    const out = await renderMarkdown(p, env, page, htmlPath);
    const res = markdownResponse(method, env, url, htmlPath, out.status ?? 200, out.markdown, out.robots, out.headers ?? {});
    if (versionUnknown) return withoutSharedCache(res); // version unknown: no edge cache, no shared copy downstream
    if (cacheKey && res.status === 200) exec.waitUntil(caches.default.put(cacheKey, res.clone()).catch(() => undefined));
    return res;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'tag_merged') {
      const moved = respond(method, 301, '', { location: markdownPath(`/t/${String(error.extra.into)}`), 'cache-control': 'public, max-age=86400', vary: 'Accept' });
      return versionUnknown ? withoutSharedCache(moved) : moved;
    }
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error('markdown page error', htmlPath, error);
    return markdownResponse(method, env, url, htmlPath, status, markdownError(status, error instanceof HttpError ? error.code : 'internal_error'), null, {}, false);
  }
}
