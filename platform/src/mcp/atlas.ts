/**
 * Read access to the Atlas for the MCP tools (src/mcp/tools.ts). The Atlas is a static build: its JSON API lives at
 * /api/v1/atlas/ (index, platforms, one card per platform, categories, list pages, earn) and /stats.json. In staging and production
 * those files are this Worker's Static Assets (routing option A3, src/atlas-assets.ts), so they are read from the ASSETS
 * binding without a network hop. Without the binding, the Pages origin (ATLAS_ORIGIN, rollback path) is used; with
 * neither, the tools answer 503 atlas_unavailable. Locally (tests, wrangler dev) ASSETS is the small fixture build.
 *
 * Nothing here writes, and nothing is invented: the tools return the Atlas JSON as published (cards carry their own
 * sources and observation times), filtered and trimmed only.
 */
import type { Env } from '../env';
import { HttpError } from '../http';
import { atlasOrigin } from '../atlas-proxy';

/** Atlas JSON files the MCP tools read (paths of the static build). */
export const ATLAS_FILES = {
  index: '/api/v1/atlas/index.json',
  platforms: '/api/v1/atlas/platforms.json',
  platform: (id: string) => `/api/v1/atlas/platforms/${id}.json`,
  earn: '/api/v1/atlas/earn.json',
  /** One page of the list (50 records, the order of /atlas/page/N/), whole Atlas or one category (schema_version 1.8.0). */
  page: (n: number, category?: string) => (category ? `/api/v1/atlas/categories/${category}/page/${n}.json` : `/api/v1/atlas/page/${n}.json`),
  stats: '/stats.json',
} as const;

/** Atlas IDs are permanent readable slugs (atlas/PROTOCOL.md). Anything else is refused before a file is read. */
export const ATLAS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Largest Atlas file we parse (platforms.json is ~0.6 MB with 334 cards); a bigger body is refused, not parsed. */
const MAX_ATLAS_BYTES = 8_000_000;
/** Parsed files are kept per isolate for this long (the Atlas changes only with a deploy). */
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();
export const resetAtlasCache = (): void => cache.clear();

async function fetchAtlas(env: Env, path: string): Promise<Response | null> {
  if (env.ASSETS) return env.ASSETS.fetch(new Request(`https://assets.local${path}`, { headers: { accept: 'application/json' }, redirect: 'manual' }));
  const origin = atlasOrigin(env);
  if (origin) return fetch(`${origin}${path}`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  return null;
}

/** The path of a same-build Atlas JSON redirect target (/api/v1/atlas/...json, relative or on the assets / Atlas host), else null. */
export function atlasRedirectPath(location: string | null): string | null {
  if (!location) return null;
  let u: URL;
  try { u = new URL(location, 'https://assets.local'); } catch { return null; }
  if (u.search || u.hash || !/^\/api\/v1\/atlas\/[a-z0-9/-]+\.json$/.test(u.pathname)) return null;
  if (u.hostname !== 'assets.local' && !/^(www\.)?commonworld\.one$/.test(u.hostname) && !u.hostname.endsWith('.workers.dev')) return null;
  return u.pathname;
}

/** One Atlas JSON file, parsed; 404 atlas_not_found when the build has no such file. */
export async function readAtlasJson<T = any>(env: Env, path: string, notFound = 'atlas_not_found'): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  let res: Response | null;
  try { res = await fetchAtlas(env, path); } catch { throw new HttpError(503, 'atlas_unavailable'); }
  if (!res) throw new HttpError(503, 'atlas_unavailable');
  // A list page that was published before but is past the end now answers a temporary 302 to that list's last page
  // (atlas/site/build.py paged_redirects, owner decision Q8; 302 since 2026-10-24 because the page may come back; it was 301
  // before, and any 3xx is still accepted). Follow exactly one such hop, only to another Atlas JSON file of the same build.
  const to = res.status >= 301 && res.status <= 308 ? atlasRedirectPath(res.headers.get('location')) : null;
  // the answer of a redirect hop is not kept: the redirect is temporary, and a page that comes back must be read again
  const keep = !to;
  if (to) {
    await res.body?.cancel();
    try { res = await fetchAtlas(env, to); } catch { throw new HttpError(503, 'atlas_unavailable'); }
    if (!res) throw new HttpError(503, 'atlas_unavailable');
  }
  if (res.status === 404) { await res.body?.cancel(); throw new HttpError(404, notFound); }
  if (res.status !== 200 || !(res.headers.get('content-type') ?? 'application/json').includes('json')) { await res.body?.cancel(); throw new HttpError(503, 'atlas_unavailable'); }
  const text = await res.text();
  if (text.length > MAX_ATLAS_BYTES) throw new HttpError(503, 'atlas_unavailable');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(503, 'atlas_unavailable'); }
  if (cache.size > 64) cache.clear();
  if (keep) cache.set(path, { at: Date.now(), value });
  return value as T;
}

/** The fields of a platform row that search results carry (the full card comes from atlas_get_platform). */
const ROW_FIELDS = ['id', 'name', 'url', 'json_url', 'website', 'category', 'category_label', 'type', 'status', 'summary', 'tags', 'has_money_flow', 'key_number', 'verified_at', 'evidence_level', 'disclosure'] as const;

export function slimRow(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ROW_FIELDS) if (Object.hasOwn(p, k)) out[k] = p[k];
  out.has_first_task = p.first_task !== null && p.first_task !== undefined;
  return out;
}

export interface AtlasQuery {
  query?: string; category?: string; status?: string; tag?: string; has_money_flow?: boolean; has_first_task?: boolean;
  limit?: number; offset?: number;
}

/** Text match: every word of the query must appear in the id, name, summary, website, category or tags (case-insensitive). */
export function searchPlatforms(rows: Record<string, any>[], q: AtlasQuery): { total: number; items: Record<string, unknown>[] } {
  const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  const tag = q.tag?.toLowerCase();
  const matched = rows.filter((p) => {
    if (q.category && p.category !== q.category) return false;
    if (q.status && p.status !== q.status) return false;
    if (tag && !(Array.isArray(p.tags) && p.tags.map((t: unknown) => String(t).toLowerCase()).includes(tag))) return false;
    if (q.has_money_flow !== undefined && !!p.has_money_flow !== q.has_money_flow) return false;
    if (q.has_first_task !== undefined && (p.first_task !== null && p.first_task !== undefined) !== q.has_first_task) return false;
    if (!words.length) return true;
    const hay = [p.id, p.name, p.summary, p.website, p.category, p.category_label, ...(Array.isArray(p.tags) ? p.tags : [])].map((x) => String(x ?? '')).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 20;
  return { total: matched.length, items: matched.slice(offset, offset + limit).map(slimRow) };
}
