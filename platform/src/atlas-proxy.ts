/**
 * Routing option A (owner decision 2026-10-17 01:42): the v1 Worker serves the whole commonworld.one domain and
 * forwards the Atlas paths to the old Cloudflare Pages project (ATLAS_ORIGIN, e.g. https://commonworld.pages.dev).
 * Rollback path only since 2026-10-20: production and staging serve the Atlas from Workers Static Assets
 * (ATLAS_SOURCE = "assets", src/atlas-assets.ts, docs/ATLAS-STATIC-ASSETS.md); ATLAS_SOURCE wins over ATLAS_ORIGIN.
 * Status, headers (incl. the Atlas's own CSP and cache headers) and body are passed through unchanged; a Location
 * that points at the Pages origin is rewritten to a same-host path, so no redirect leaves the domain or loops.
 *
 * Unset ATLAS_ORIGIN (local dev, tests by default) = nothing is proxied; /privacy|terms|about keep their old
 * absolute 301 to https://commonworld.one/... unless that would be the very same URL (src/pages/router.ts).
 *
 * v1 keeps: /, every SSR page, /v1/*, /health, /assets/*, /favicon.ico, /robots.txt (merged), /sitemap.xml (index
 * of /sitemap-v1.xml + /atlas/sitemap.xml), /llms.txt and /llms-full.txt (v1 text + the Atlas text appended),
 * /openapi.json. The Pages landing page at "/" is replaced by the v1 home.
 */
import type { Env } from './env';

export interface AtlasRule { pattern: RegExp; what: string }

/** Atlas paths the Worker hands to the Atlas (Static Assets with ATLAS_SOURCE=assets, else the Pages proxy with ATLAS_ORIGIN). */
export const ATLAS_PATHS: AtlasRule[] = [
  { pattern: /^\/atlas\/.*$/, what: 'Atlas pages, JSON (platforms.json, categories/*.json, earn.json, data/), assets, OG images, badges, /atlas/sitemap.xml' },
  { pattern: /^\/(?:privacy|terms|about)\/$/, what: 'legal pages and About (Atlas-owned)' },
  { pattern: /^\/stats\/(?:index\.md)?$/, what: 'Atlas stats page and its Markdown twin (/stats.json is static)' },
  { pattern: /^\/api\/v1(?:\/.*)?$/, what: 'Atlas static JSON API (index.json, openapi.json, schemas/, atlas/)' },
  { pattern: /^\/\.well-known\/[A-Za-z0-9._-]+$/, what: 'security.txt and other well-known files' },
  { pattern: /^\/[A-Fa-f0-9]{8,128}\.txt$/, what: 'IndexNow key file (hex name at the root)' },
  { pattern: /^\/404\.html$/, what: 'Atlas 404 page' },
];

/** Bare Atlas paths that get a same-host 301 to the trailing-slash form (what Pages itself would do, without the pages.dev host). */
export const ATLAS_SLASH_REDIRECT = /^\/(?:atlas|privacy|terms|about|stats)$/;

export function atlasOrigin(env: Env): string | null {
  const raw = (env.ATLAS_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.pathname === '/' && !u.search ? u.origin : null;
  } catch { return null; }
}

export const isAtlasPath = (path: string): boolean => ATLAS_PATHS.some((r) => r.pattern.test(path));

const FORWARD_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'if-none-match', 'if-modified-since', 'range', 'user-agent'];

/** Fetches the same path + query from the Pages origin and passes the response through. */
export async function proxyAtlas(request: Request, env: Env, url: URL, origin: string): Promise<Response> {
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) { const v = request.headers.get(name); if (v) headers.set(name, v); }
  let upstream: Response;
  try {
    upstream = await fetch(new URL(url.pathname + url.search, origin).toString(), { method, headers, redirect: 'manual' });
  } catch {
    return new Response('502 atlas_unreachable', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const out = new Response(method === 'HEAD' ? null : upstream.body, upstream);
  const location = out.headers.get('location');
  if (location) {
    const to = new URL(location, origin);
    if (to.origin === origin) out.headers.set('location', to.pathname + to.search + to.hash);
  }
  // a temporary redirect (a vanished list page that may come back) is never stored, as on the Static Assets path
  if (out.status === 302) out.headers.set('cache-control', 'no-store');
  out.headers.delete('set-cookie');
  out.headers.set('x-cw-upstream', 'atlas');
  if (env.PAGES_NOINDEX === '1') out.headers.set('x-robots-tag', 'noindex, nofollow');
  return out;
}

/** The Atlas text file (llms.txt / llms-full.txt) to append to the v1 one; null when unset or unreachable. */
export async function atlasText(env: Env, path: string): Promise<string | null> {
  const origin = atlasOrigin(env);
  if (!origin) return null;
  try {
    const r = await fetch(`${origin}${path}`, { headers: { accept: 'text/plain' }, redirect: 'manual' });
    if (r.status !== 200) return null;
    const text = await r.text();
    return text.length > 0 && text.length < 2_000_000 ? text : null;
  } catch { return null; }
}

/**
 * Link fixes for the Atlas llms files as merged into ours (QA 2026-10-17 #12): the Atlas text names the screenshots
 * directory as a bare URL (".../atlas/screens/"), which link checkers follow and which is a 404 (there is no index).
 * It is rewritten as a code template, like the per-entry URLs next to it. To drop once the Atlas source is fixed.
 */
export function cleanAtlasDoc(text: string): string {
  return text.replace(/(?<![`<\w/])(https:\/\/[a-z0-9.-]+\/atlas\/screens\/)(?=[\s),.;]|$)/g, '`$1<id>.webp`');
}
