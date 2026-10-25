/**
 * Routing option A3 (owner decision 2026-10-18 13:45): the Atlas is served from this Worker's Static Assets instead of
 * the Cloudflare Pages project. One `wrangler deploy` ships v1 + the Atlas build (atlas/site/dist of cw-public, copied
 * to platform/.atlas-dist by scripts/build-atlas-assets.mjs).
 *
 * Who answers what (wrangler.toml `[assets] run_worker_first`, mirrored in ATLAS_RUN_WORKER_FIRST below):
 * - Atlas static files (CSS, JS, images, OG, screens, badges, JSON, /api/v1, /.well-known/security.txt) are matched by the negative
 *   patterns: Cloudflare serves them straight from Static Assets. No Worker invocation, free and unlimited. Their
 *   headers come from the Atlas's own `_headers` file (Static Assets applies it), redirects from `_redirects`.
 * - Everything else runs the Worker first: v1 pages and API, and the Atlas HTML pages. For Atlas HTML the Worker reads
 *   the file from the ASSETS binding (which applies `_headers` and `_redirects` too) and adds the per-response CSP
 *   nonce that the Pages middleware (cw-public functions/_middleware.js) added before. So an Atlas HTML page is exactly
 *   1 Worker request, like the Pages Function today.
 *
 * Switch: ATLAS_SOURCE = "assets" (staging, production). Unset = the old proxy to ATLAS_ORIGIN (src/atlas-proxy.ts)
 * or nothing. The proxy stays as the rollback path until Pages is retired; then it can be deleted.
 */
import type { Env } from './env';

/**
 * The exact `run_worker_first` list of wrangler.toml (a test checks all environments use it). It mirrors the Pages
 * `_routes.json` of the Atlas build: what Pages served without its Function is served without the Worker here.
 * Differences from `_routes.json`: /robots.txt, /sitemap.xml, /llms.txt, /llms-full.txt, /favicon.ico, /404.html are
 * v1's (merged) and run the Worker; /.well-known/security.txt (the only well-known file the Atlas builds) is static.
 * Every other /.well-known/* path runs the Worker: /.well-known/mcp.json is the Worker's MCP discovery manifest, and an
 * unknown well-known path is answered from Static Assets by the Worker (404 page), one cheap Worker request.
 * `*` matches across `/`; negative patterns win; at most 100 entries.
 */
export const ATLAS_RUN_WORKER_FIRST: readonly string[] = [
  '/*',
  '!/atlas/assets/*',
  '!/atlas/og/*',
  '!/atlas/screens/*',
  '!/atlas/badge/*',
  '!/atlas/data/*',
  '!/atlas/platforms/*.json',
  '!/atlas/categories/*.json',
  '!/atlas/*.json',
  '!/atlas/*.txt',
  '!/atlas/*.xml',
  '!/atlas/*.md',
  '!/stats.json',
  '!/stats/index.md',
  '!/about/index.md',
  '!/privacy/index.md',
  '!/terms/index.md',
  '!/api/*',
  '!/.well-known/security.txt',
];

/** Same semantics as Cloudflare's run_worker_first: `*` = any characters (deep), a matching negative pattern wins. */
export function runsWorkerFirst(path: string, patterns: readonly string[] = ATLAS_RUN_WORKER_FIRST): boolean {
  const re = (p: string) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const pos = patterns.filter((p) => !p.startsWith('!'));
  const neg = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return pos.some((p) => re(p).test(path)) && !neg.some((p) => re(p).test(path));
}

/**
 * Query parameters of the Atlas catalog's filter and search views (atlas/site/static/atlas.js keeps them in the URL; same list
 * in atlas/site/serve.py). Owner decision D1 (2026-10-24): paged list pages are indexable and self-canonical, filter and search
 * views are noindex. The views are the same static file as the plain list, so the noindex travels as a response header.
 */
export const ATLAS_FILTER_PARAMS: readonly string[] = ['q', 'category', 'status', 'type', 'feature', 'tag', 'sort'];

/** True for an Atlas URL that opens a filter or search view (any of ATLAS_FILTER_PARAMS in the query string). */
export function isAtlasFilterView(url: URL): boolean {
  for (const k of url.searchParams.keys()) if (ATLAS_FILTER_PARAMS.includes(k)) return true;
  return false;
}

/** Cache-Control of a temporary (302) Atlas redirect: never stored (same value as build.py VANISHED_PAGE_CACHE). */
export const ATLAS_TEMP_REDIRECT_CACHE = 'no-store';

export const atlasAssetsOn = (env: Env): boolean => env.ATLAS_SOURCE === 'assets' && !!env.ASSETS;

/**
 * Typed 404s (Atlas paging findings, 2026-10-25): a missing JSON page answers a JSON error body and a missing Markdown twin of a
 * list page answers Markdown, never the HTML 404 page. Those files are static (run_worker_first negatives), so Static Assets
 * answers their misses itself with the NEAREST 404.html (not_found_handling "404-page"): the Atlas build writes /api/404.html
 * (JSON) and <list>/page/404.html (Markdown), typed by `_headers` (atlas/site/build.py typed_404_files). The same bodies are
 * here for a JSON or Markdown path that does reach the Worker; HTML misses always get the site 404 page (/404.html), never a
 * nearer typed 404.html. Same texts as atlas/site/api_v1.py (tests/test_atlas_paging.py compares them).
 */
export const ATLAS_NOT_FOUND_JSON_MESSAGE = 'No such file in the Atlas API. List pages are numbered from 1; the number of pages is `pages` on every page '
  + 'and counts.pages in /api/v1/atlas/index.json.';
export const ATLAS_NOT_FOUND_MD = '# Not found\n\nThere is no Markdown page at this address. The Atlas starts at /atlas/index.md; '
  + 'list pages are numbered from 1 (page 1 is the list itself).\n';
/** Cache-Control of a typed 404: the same as the Atlas files (a page number can exist after the next build). */
export const ATLAS_NOT_FOUND_CACHE = 'public, max-age=0, must-revalidate';

/** A typed 404 body file of the Atlas build below the root (/atlas/page/404.html, ...): never served as a page. */
export const isTypedNotFoundFile = (path: string): boolean => /^\/atlas\/(?:.+\/)?page\/404(?:\.html)?$/.test(path);

export function atlasNotFoundKind(path: string): 'json' | 'markdown' | 'html' {
  if (path.startsWith('/api/') || path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  return 'html';
}

/** The JSON or Markdown 404 for `url`, keeping the asset layer's site-wide headers (`base`, from _headers); null for HTML paths. */
export function atlasTypedNotFound(method: string, url: URL, base: Headers = new Headers()): Response | null {
  const kind = atlasNotFoundKind(url.pathname);
  if (kind === 'html') return null;
  const headers = new Headers(base);
  for (const h of ['content-length', 'content-encoding', 'etag', 'last-modified', 'location']) headers.delete(h);
  headers.set('cache-control', ATLAS_NOT_FOUND_CACHE);
  headers.set('x-content-type-options', 'nosniff');
  let body: string;
  if (kind === 'json') {
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('access-control-allow-origin', '*');
    body = JSON.stringify({ error: { code: 'not_found', message: ATLAS_NOT_FOUND_JSON_MESSAGE },
      links: { index: `${url.origin}/api/v1/atlas/index.json`, docs: `${url.origin}/atlas/api/` } }) + '\n';
  } else {
    headers.set('content-type', 'text/markdown; charset=utf-8');
    body = ATLAS_NOT_FOUND_MD;
  }
  return new Response(method === 'HEAD' ? null : body, { status: 404, headers });
}

const MARK = "script-src 'self'";

/** Port of cw-public functions/_middleware.js: a fresh nonce in the Atlas CSP of an HTML response (for Cloudflare's injected script). */
export function withAtlasNonce(res: Response): Response {
  const csp = res.headers.get('content-security-policy');
  const type = res.headers.get('content-type') || '';
  if (!csp || !type.startsWith('text/html') || !csp.includes(MARK)) return res;
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const out = new Response(res.body, res);
  out.headers.set('content-security-policy', csp.replace(MARK, `${MARK} 'nonce-${nonce}'`));
  return out;
}

/**
 * An Atlas path the Worker owns (HTML pages, the IndexNow key file, anything not matched by a negative pattern),
 * answered from the ASSETS binding. Status, body and the `_headers` headers come from Static Assets; the Worker adds
 * the nonce, turns the asset layer's 307 slash/`.html` redirects into Pages' 308, sends `cache-control: no-store` on
 * the temporary 302s of vanished list pages, answers a missing JSON or Markdown file with a typed 404 (atlasTypedNotFound),
 * and marks closed staging noindex.
 */
export async function serveAtlasAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const headers = new Headers();
  for (const name of ['accept', 'accept-encoding', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'user-agent']) {
    const v = request.headers.get(name); if (v) headers.set(name, v);
  }
  // Static Assets applies not_found_handling ("404-page" = the nearest 404.html, status 404) to page navigations.
  headers.set('sec-fetch-mode', 'navigate');
  let res = isTypedNotFoundFile(url.pathname)
    ? new Response(null, { status: 404 }) // a typed 404 body file is not a page: the site 404 below
    : await env.ASSETS!.fetch(new Request(url.toString(), { method: request.method, headers, redirect: 'manual' }));
  if (res.status === 404) {
    // JSON (API) and Markdown paths get a typed 404, never the HTML error page
    const typed = atlasTypedNotFound(request.method, url, res.headers);
    if (typed) {
      await res.body?.cancel();
      typed.headers.delete('set-cookie');
      typed.headers.set('x-cw-upstream', 'atlas-assets');
      if (env.PAGES_NOINDEX === '1') typed.headers.set('x-robots-tag', 'noindex, nofollow');
      return typed;
    }
  }
  if (res.status === 404) {
    // always the site 404 page (/404.html), still with status 404: the nearest 404.html of a list folder is a Markdown body
    const page = await env.ASSETS!.fetch(new Request(new URL('/404', url).toString(), { method: request.method, headers, redirect: 'manual' }));
    if (page.status === 200) { await res.body?.cancel(); res = new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers: page.headers }); }
  }
  let out = new Response(request.method === 'HEAD' ? null : res.body, res);
  if (out.status === 307 && out.headers.has('location')) out = new Response(null, { status: 308, headers: out.headers });
  // A list page that vanished when its list got shorter answers a temporary 302 (atlas/site/build.py paged_redirects): the
  // page may come back, so the redirect is never stored and a page that returns is not shadowed by a remembered redirect.
  // (The Markdown twins and JSON pages are static: _headers gives their 302s the same no-store.)
  if (out.status === 302) out.headers.set('cache-control', ATLAS_TEMP_REDIRECT_CACHE);
  const location = out.headers.get('location');
  if (location) {
    const to = new URL(location, url);
    if (to.origin === url.origin) out.headers.set('location', to.pathname + to.search + to.hash);
  }
  out.headers.delete('set-cookie');
  out.headers.set('x-cw-upstream', 'atlas-assets');
  if (env.PAGES_NOINDEX === '1') out.headers.set('x-robots-tag', 'noindex, nofollow');
  else if (isAtlasFilterView(url) && (out.headers.get('content-type') || '').startsWith('text/html')) out.headers.set('x-robots-tag', 'noindex, follow');
  return withAtlasNonce(out);
}

/** The Atlas's own llms.txt / llms-full.txt from Static Assets, to append to ours; null when missing. */
export async function atlasAssetText(env: Env, path: string): Promise<string | null> {
  if (!env.ASSETS) return null;
  try {
    const r = await env.ASSETS.fetch(new Request(`https://assets.local${path}`, { headers: { accept: 'text/plain' }, redirect: 'manual' }));
    if (r.status !== 200) return null;
    const text = await r.text();
    return text.length > 0 && text.length < 2_000_000 ? text : null;
  } catch { return null; }
}
