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

export const atlasAssetsOn = (env: Env): boolean => env.ATLAS_SOURCE === 'assets' && !!env.ASSETS;

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
 * the nonce, turns the asset layer's 307 slash/`.html` redirects into Pages' 308, and marks closed staging noindex.
 */
export async function serveAtlasAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const headers = new Headers();
  for (const name of ['accept', 'accept-encoding', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'user-agent']) {
    const v = request.headers.get(name); if (v) headers.set(name, v);
  }
  // Static Assets applies not_found_handling ("404-page" = the Atlas 404.html, status 404) to page navigations.
  headers.set('sec-fetch-mode', 'navigate');
  let res = await env.ASSETS!.fetch(new Request(url.toString(), { method: request.method, headers, redirect: 'manual' }));
  if (res.status === 404 && !(res.headers.get('content-type') || '').startsWith('text/html')) {
    // not_found_handling did not apply: serve the Atlas 404 page ourselves, still with status 404
    const page = await env.ASSETS!.fetch(new Request(new URL('/404', url).toString(), { method: request.method, headers, redirect: 'manual' }));
    if (page.status === 200) res = new Response(request.method === 'HEAD' ? null : page.body, { status: 404, headers: page.headers });
  }
  let out = new Response(request.method === 'HEAD' ? null : res.body, res);
  if (out.status === 307 && out.headers.has('location')) out = new Response(null, { status: 308, headers: out.headers });
  const location = out.headers.get('location');
  if (location) {
    const to = new URL(location, url);
    if (to.origin === url.origin) out.headers.set('location', to.pathname + to.search + to.hash);
  }
  out.headers.delete('set-cookie');
  out.headers.set('x-cw-upstream', 'atlas-assets');
  if (env.PAGES_NOINDEX === '1') out.headers.set('x-robots-tag', 'noindex, nofollow');
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
