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
  /** Compact search rows of every card (atlas_search_platforms), one file or a manifest + shards (atlas/site/build.py mcp_files). */
  mcpIndex: '/api/v1/atlas/mcp-index.json',
  /** Cards with a first task, only the fields atlas_first_tasks returns; one file or a manifest + shards. */
  firstTasks: '/api/v1/atlas/first-tasks.json',
  /** One page of the list (50 records, the order of /atlas/page/N/), whole Atlas or one category (schema_version 1.8.0). */
  page: (n: number, category?: string) => (category ? `/api/v1/atlas/categories/${category}/page/${n}.json` : `/api/v1/atlas/page/${n}.json`),
  stats: '/stats.json',
} as const;

/** Atlas IDs are permanent readable slugs (atlas/PROTOCOL.md). Anything else is refused before a file is read. */
export const ATLAS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Largest Atlas file we read, in bytes: a bigger body is refused (503 atlas_unavailable) before it is parsed, by its
 * Content-Length when the answer has one, else by counting while the stream is read (reading stops at the limit). The
 * tools no longer read the full platforms.json (~0.9 MB with 375 cards): search and first tasks read the compact files
 * (ATLAS_FILES.mcpIndex, .firstTasks), which the build keeps under 1,000,000 bytes each and shards past that; the build
 * (atlas/site/check.py MCP_MAX_BYTES) fails when any file a tool reads is over this limit.
 */
export const MAX_ATLAS_BYTES = 2_000_000;
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

/** The body as UTF-8 text, at most `max` bytes: a larger Content-Length is refused unread, and a stream that runs past the limit is cancelled. */
export async function readLimited(res: Response, max: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && declared.trim() !== '') {
    const n = Number(declared);
    if (!Number.isFinite(n) || n < 0 || n > max) { await res.body?.cancel(); throw new HttpError(503, 'atlas_unavailable'); }
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); throw new HttpError(503, 'atlas_unavailable'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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
  const text = await readLimited(res, MAX_ATLAS_BYTES);
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

/** The filter of a search: every word of the query must appear in the id, name, summary, website, category or tags (case-insensitive). */
function matcher(q: AtlasQuery, hasFirstTask: (p: Record<string, any>) => boolean): (p: Record<string, any>) => boolean {
  const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  const tag = q.tag?.toLowerCase();
  return (p) => {
    if (q.category && p.category !== q.category) return false;
    if (q.status && p.status !== q.status) return false;
    if (tag && !(Array.isArray(p.tags) && p.tags.map((t: unknown) => String(t).toLowerCase()).includes(tag))) return false;
    if (q.has_money_flow !== undefined && !!p.has_money_flow !== q.has_money_flow) return false;
    if (q.has_first_task !== undefined && hasFirstTask(p) !== q.has_first_task) return false;
    if (!words.length) return true;
    const hay = [p.id, p.name, p.summary, p.website, p.category, p.category_label, ...(Array.isArray(p.tags) ? p.tags : [])].map((x) => String(x ?? '')).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
}

/** Search over full platform records (platforms.json): the reference the compact index is checked against (test/mcp-compact.test.ts). */
export function searchPlatforms(rows: Record<string, any>[], q: AtlasQuery): { total: number; items: Record<string, unknown>[] } {
  const matched = rows.filter(matcher(q, (p) => p.first_task !== null && p.first_task !== undefined));
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 20;
  return { total: matched.length, items: matched.slice(offset, offset + limit).map(slimRow) };
}

/**
 * The same search over the rows of the compact index (ATLAS_FILES.mcpIndex): each row already is slimRow() of its record
 * (atlas/site/build.py mcp_row, checked by check.py), so the filter reads has_first_task and the items are copies of the rows.
 */
export function searchIndexRows(rows: Record<string, any>[], q: AtlasQuery): { total: number; items: Record<string, unknown>[] } {
  const matched = rows.filter(matcher(q, (p) => p.has_first_task === true));
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 20;
  return { total: matched.length, items: matched.slice(offset, offset + limit).map((p) => ({ ...p })) };
}

/** Formats of the compact files (atlas/site/build.py MCP_INDEX_FORMAT, MCP_FIRST_TASKS_FORMAT); a shard adds "-shard". */
export const COMPACT_FORMATS: Record<string, string> = {
  [ATLAS_FILES.mcpIndex]: 'commonworld-atlas-mcp-index/1',
  [ATLAS_FILES.firstTasks]: 'commonworld-atlas-first-tasks/1',
};
/** At most this many shards are read for one compact file (the build cuts shards only where the first letter changes: 27 letters). */
const MAX_SHARDS = 64;

/**
 * A compact file as one list: its rows, or, once the build sharded it, the manifest's shards (contiguous slices in list
 * order, under <file>/<n>-<a>-<z>.json) read in parallel and joined. Fails closed with 503 atlas_unavailable on anything
 * unexpected: wrong format, a shard path outside the file's folder, a missing shard, a shard of another build
 * (snapshot_id) or a count that does not add up. Returns the manifest (generated_at, licence, snapshot_id) and the rows.
 */
export async function readCompactAtlas(env: Env, path: string): Promise<{ doc: Record<string, any>; rows: Record<string, any>[] }> {
  const format = COMPACT_FORMATS[path];
  const bad = (): never => { throw new HttpError(503, 'atlas_unavailable'); };
  if (!format) bad();
  const doc = await readAtlasJson<Record<string, any>>(env, path).catch((e) => { throw e instanceof HttpError && e.status === 404 ? new HttpError(503, 'atlas_unavailable') : e; });
  if (!doc || typeof doc !== 'object' || doc.format !== format || !Number.isInteger(doc.total)) bad();
  let rows: Record<string, any>[];
  if (Array.isArray(doc.rows)) {
    rows = doc.rows;
  } else {
    if (!Array.isArray(doc.shards) || doc.shards.length < 1 || doc.shards.length > MAX_SHARDS) bad();
    const dir = path.slice(0, -'.json'.length) + '/';
    const parts = await Promise.all((doc.shards as any[]).map(async (sh) => {
      const sp = typeof sh?.path === 'string' ? sh.path : '';
      if (!sp.startsWith(dir) || !/^[0-9]{1,3}-[a-z0]-[a-z0]\.json$/.test(sp.slice(dir.length))) bad();
      const d = await readAtlasJson<Record<string, any>>(env, sp).catch((e) => { throw e instanceof HttpError && e.status === 404 ? new HttpError(503, 'atlas_unavailable') : e; });
      if (!d || d.format !== `${format}-shard` || d.snapshot_id !== doc.snapshot_id || !Array.isArray(d.rows) || d.rows.length !== d.count || d.count !== sh.count) bad();
      return d.rows as Record<string, any>[];
    }));
    rows = parts.flat();
  }
  if (rows.length !== doc.total) bad();
  return { doc, rows };
}
