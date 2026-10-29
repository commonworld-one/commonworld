/**
 * MCP Atlas search and first tasks read compact files (scale review 2026-10-25), not the full platforms.json:
 * - over the REAL Atlas build (CI builds it, CW_REQUIRE_ATLAS_DIST=1): the old path (platforms.json + searchPlatforms, as the
 *   tools read it before) and the new path (the tools as they are, over mcp-index.json / first-tasks.json) give byte-identical
 *   results for a set of queries and every page, and the new path never reads platforms.json;
 * - sharded files (manifest + shards) give the same results as one file; anything unexpected in them fails closed (503);
 * - an Atlas file over MAX_ATLAS_BYTES is refused by its Content-Length before reading, and a stream is cut at the limit.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ATLAS_FILES, MAX_ATLAS_BYTES, readAtlasJson, readLimited, resetAtlasCache, searchPlatforms } from '../src/mcp/atlas';
import { TOOL_BY_NAME, atlasPaged } from '../src/mcp/tools';

beforeEach(() => resetAtlasCache());

type Files = Record<string, string>;

/** A stand-in for the ASSETS binding over a set of files; records every path read. */
function assets(files: Files) {
  const reads: string[] = [];
  return {
    reads,
    fetch: async (req: Request) => {
      const p = new URL(req.url).pathname;
      reads.push(p);
      if (!Object.hasOwn(files, p)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
      return new Response(files[p], { headers: { 'content-type': 'application/json' } });
    },
  };
}

const search = TOOL_BY_NAME.get('atlas_search_platforms')!;
const firstTasks = TOOL_BY_NAME.get('atlas_first_tasks')!;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

/** The tools exactly as they were before this change: read platforms.json, filter the full records. */
function oldSearch(list: any, a: Record<string, unknown>) {
  const res = searchPlatforms(Array.isArray(list.platforms) ? list.platforms : [], { query: str(a.query), category: str(a.category), status: str(a.status), tag: str(a.tag), has_money_flow: bool(a.has_money_flow), has_first_task: bool(a.has_first_task), limit: Number.MAX_SAFE_INTEGER, offset: 0 });
  return { ...atlasPaged(res.items, a), generated_at: list.generated_at, licence: list.licence };
}
function oldFirstTasks(list: any, a: Record<string, unknown>) {
  const rows = (Array.isArray(list.platforms) ? list.platforms : []).filter((p: any) => p.first_task && (!a.category || p.category === a.category));
  return atlasPaged(rows.map((p: any) => ({ id: p.id, name: p.name, url: p.url, category: p.category, status: p.status, first_task: p.first_task })), a);
}

/** Every query of the comparison: filters alone and combined, then every page of each (and one past the end). */
function searchQueries(list: any): Record<string, unknown>[] {
  const ps: any[] = list.platforms;
  const cats = [...new Set(ps.map((p) => p.category))];
  const tags = [...new Set(ps.flatMap((p) => (Array.isArray(p.tags) ? p.tags : [])))].slice(0, 25);
  const base: Record<string, unknown>[] = [
    {}, { query: '' }, { query: 'mcp' }, { query: 'x402' }, { query: 'agent' }, { query: 'Agents PAY' }, { query: 'zzzz-no-such-word' },
    { status: 'closed' }, { status: 'live' }, { has_money_flow: true }, { has_money_flow: false }, { has_first_task: true }, { has_first_task: false },
    { tag: 'mcp' }, { tag: 'x402' }, { tag: 'MCP' }, { query: 'mcp', status: 'live', has_money_flow: false },
    ...cats.map((category) => ({ category })), ...cats.map((category) => ({ category, status: 'closed' })), ...cats.map((category) => ({ category, has_first_task: true })),
    ...tags.map((tag) => ({ tag })),
  ];
  const out: Record<string, unknown>[] = [];
  for (const q of base) {
    const total = oldSearch(list, q).total;
    const last = Math.max(1, Math.ceil(total / 50));
    for (let page = 1; page <= last + 1; page++) out.push({ ...q, page });
    out.push({ ...q, offset: 50 }, { ...q, limit: 3 });
  }
  return out;
}

const real: Files = env.TEST_ATLAS_MCP_FILES ? JSON.parse(env.TEST_ATLAS_MCP_FILES) : {};
const hasReal = Object.hasOwn(real, ATLAS_FILES.platforms) && Object.hasOwn(real, ATLAS_FILES.mcpIndex);

describe('real Atlas build: old path (platforms.json) vs new path (compact files)', () => {
  it.skipIf(!hasReal)('atlas_search_platforms: identical results for every query and page, platforms.json never read', async () => {
    const list = JSON.parse(real[ATLAS_FILES.platforms]);
    expect(list.platforms.length).toBeGreaterThan(50); // more than one page, so paging is really compared
    const a = assets(real);
    let n = 0;
    for (const q of searchQueries(list)) {
      const now = await search.atlas!({ ASSETS: a } as any, q);
      expect(JSON.stringify(now), JSON.stringify(q)).toBe(JSON.stringify(oldSearch(list, q)));
      n++;
    }
    expect(n).toBeGreaterThan(100);
    expect(a.reads).not.toContain(ATLAS_FILES.platforms);
    expect(a.reads.every((p) => p === ATLAS_FILES.mcpIndex || p.startsWith('/api/v1/atlas/mcp-index/'))).toBe(true);
  });

  it.skipIf(!hasReal)('atlas_first_tasks: identical results for every category and page, platforms.json never read', async () => {
    const list = JSON.parse(real[ATLAS_FILES.platforms]);
    const a = assets(real);
    const cats = [undefined, ...new Set(list.platforms.map((p: any) => p.category))];
    for (const category of cats) {
      for (let page = 1; page <= 3; page++) {
        const q = { ...(category ? { category } : {}), page };
        expect(JSON.stringify(await firstTasks.atlas!({ ASSETS: a } as any, q)), JSON.stringify(q)).toBe(JSON.stringify(oldFirstTasks(list, q)));
      }
    }
    expect(a.reads).not.toContain(ATLAS_FILES.platforms);
  });

  it.skipIf(!hasReal)('the compact files are much smaller than platforms.json and under the read limit', () => {
    const size = (p: string) => new TextEncoder().encode(real[p]).byteLength;
    const compact = Object.keys(real).filter((p) => p === ATLAS_FILES.mcpIndex || p === ATLAS_FILES.firstTasks || /\/(mcp-index|first-tasks)\//.test(p));
    for (const p of compact) expect(size(p), p).toBeLessThan(MAX_ATLAS_BYTES);
    expect(size(ATLAS_FILES.mcpIndex)).toBeLessThan(size(ATLAS_FILES.platforms) / 2);
  });
});

// ------------------------------------------------------------------ sharded files (a tiny budget in the build)

/** The fixture data split the way build.py compact_files does once over budget: a manifest + shards of contiguous rows. */
function shard(doc: any, dir: string, cuts: number[]): Files {
  const { rows, ...head } = doc;
  const files: Files = {};
  const shards: any[] = [];
  let from = 0;
  cuts.concat(rows.length).forEach((to, i) => {
    const rs = rows.slice(from, to);
    const sp = `${dir}/${i + 1}-${String(rs[0]?.name ?? 'a')[0].toLowerCase()}-${String(rs[rs.length - 1]?.name ?? 'z')[0].toLowerCase()}.json`;
    files[sp] = JSON.stringify({ format: `${doc.format}-shard`, snapshot_id: doc.snapshot_id, first: 'A', last: 'Z', count: rs.length, rows: rs });
    shards.push({ path: sp, first: 'A', last: 'Z', count: rs.length });
    from = to;
  });
  return { ...files, [`${dir}.json`]: JSON.stringify({ ...head, shards }) };
}

/** A synthetic Atlas of 130 cards (three pages) as the build writes it: platforms.json + one-file compact index. */
function synthetic(): { list: any; index: any; tasks: any } {
  const cats = ['social', 'work', 'payments'];
  const platforms = Array.from({ length: 130 }, (_, i) => {
    const id = `${String.fromCharCode(97 + (i % 26))}card-${i}`;
    return {
      id, name: `${id[0].toUpperCase()}${id.slice(1)}`, url: `https://commonworld.one/atlas/platforms/${id}/`, json_url: `https://commonworld.one/api/v1/atlas/platforms/${id}.json`,
      website: `https://${id}.example`, category: cats[i % 3], category_label: cats[i % 3], type: 'platform', status: i % 7 ? 'live' : 'closed',
      summary: i % 5 ? 'An agent market' : 'MCP server for agents', tags: i % 4 ? ['mcp'] : ['x402', 'api-registration'], has_money_flow: i % 2 === 0, money_flow: [],
      key_number: i % 9 ? null : { value: i }, verified_at: '2026-10-25T00:00:00Z', last_checked: '2026-10-25T00:00:00Z', claims_count: 2, disclosure: null,
      md_url: 'x', evidence_level: { level: 1 }, keys_and_books: {}, first_task: i % 6 ? null : { title: `Task ${i}`, steps: [] },
    };
  });
  const head = { snapshot_id: 'feedfacefeedface', generated_at: '2026-10-25T00:00:00Z', licence: 'CC BY 4.0' };
  const F = ['id', 'name', 'url', 'json_url', 'website', 'category', 'category_label', 'type', 'status', 'summary', 'tags', 'has_money_flow', 'key_number', 'verified_at', 'evidence_level', 'disclosure'];
  const rows = platforms.map((p: any) => ({ ...Object.fromEntries(F.filter((k) => Object.hasOwn(p, k)).map((k) => [k, p[k]])), has_first_task: p.first_task !== null }));
  const trows = platforms.filter((p) => p.first_task !== null).map((p) => ({ id: p.id, name: p.name, url: p.url, category: p.category, status: p.status, first_task: p.first_task }));
  return {
    list: { ...head, platforms },
    index: { format: 'commonworld-atlas-mcp-index/1', note: 'n', ...head, total: rows.length, rows },
    tasks: { format: 'commonworld-atlas-first-tasks/1', note: 'n', ...head, total: trows.length, rows: trows },
  };
}

describe('sharded compact files', () => {
  const { list, index, tasks } = synthetic();
  const sharded: Files = { ...shard(index, '/api/v1/atlas/mcp-index', [40, 90]), ...shard(tasks, '/api/v1/atlas/first-tasks', [10]) };

  it('a manifest + shards gives the same results as the full list, read in order', async () => {
    const a = assets(sharded);
    for (const q of [{}, { query: 'mcp' }, { tag: 'x402' }, { status: 'closed' }, { has_first_task: true }, { has_money_flow: false, category: 'work' }, { page: 2 }, { page: 3 }, { page: 4 }]) {
      expect(JSON.stringify(await search.atlas!({ ASSETS: a } as any, q)), JSON.stringify(q)).toBe(JSON.stringify(oldSearch(list, q)));
    }
    for (const q of [{}, { category: 'social' }, { page: 2 }]) {
      expect(JSON.stringify(await firstTasks.atlas!({ ASSETS: a } as any, q))).toBe(JSON.stringify(oldFirstTasks(list, q)));
    }
    expect(a.reads.filter((p) => p.startsWith('/api/v1/atlas/mcp-index/')).sort()).toEqual(Object.keys(sharded).filter((p) => p.startsWith('/api/v1/atlas/mcp-index/')).sort());
  });

  const broken: [string, (f: Files) => void][] = [
    ['a shard of another build', (f) => { const k = Object.keys(f).find((p) => p.startsWith('/api/v1/atlas/mcp-index/'))!; f[k] = JSON.stringify({ ...JSON.parse(f[k]), snapshot_id: 'other' }); }],
    ['a missing shard', (f) => { delete f[Object.keys(f).find((p) => p.startsWith('/api/v1/atlas/mcp-index/'))!]; }],
    ['a shard path outside the folder', (f) => { const m = JSON.parse(f[ATLAS_FILES.mcpIndex]); m.shards[0].path = '/api/v1/atlas/platforms.json'; f[ATLAS_FILES.mcpIndex] = JSON.stringify(m); }],
    ['counts that do not add up', (f) => { const m = JSON.parse(f[ATLAS_FILES.mcpIndex]); m.total += 1; f[ATLAS_FILES.mcpIndex] = JSON.stringify(m); }],
    ['a wrong format', (f) => { const m = JSON.parse(f[ATLAS_FILES.mcpIndex]); m.format = 'something-else/1'; f[ATLAS_FILES.mcpIndex] = JSON.stringify(m); }],
    ['no manifest at all', (f) => { delete f[ATLAS_FILES.mcpIndex]; }],
  ];
  for (const [what, breakIt] of broken) {
    it(`fails closed (503 atlas_unavailable) on ${what}`, async () => {
      resetAtlasCache();
      const f = { ...sharded };
      breakIt(f);
      await expect(search.atlas!({ ASSETS: assets(f) } as any, {})).rejects.toMatchObject({ status: 503, code: 'atlas_unavailable' });
    });
  }
});

// ------------------------------------------------------------------ the read limit

describe('Atlas read limit', () => {
  it('is 2,000,000 bytes', () => expect(MAX_ATLAS_BYTES).toBe(2_000_000));

  it('refuses a body whose Content-Length is over the limit without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('{}')); c.close(); } });
    const res = new Response(body, { headers: { 'content-length': String(MAX_ATLAS_BYTES + 1), 'content-type': 'application/json' } });
    await expect(readLimited(res, MAX_ATLAS_BYTES)).rejects.toMatchObject({ status: 503, code: 'atlas_unavailable' });
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's first automatic pull; never read through
  });

  it('stops reading a stream without Content-Length once it passes the limit', async () => {
    let chunks = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({ pull(c) { chunks++; c.enqueue(chunk); }, cancel() { cancelled = true; } });
    await expect(readLimited(new Response(endless), 1_000_000)).rejects.toMatchObject({ status: 503, code: 'atlas_unavailable' });
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThan(20); // 1,000,000 / 65,536 = 16 chunks, then it stopped
  });

  it('reads a body at the limit, multi-byte text intact', async () => {
    const text = JSON.stringify({ s: 'Ātlas ✓ ' + 'x'.repeat(100) });
    expect(await readLimited(new Response(text), new TextEncoder().encode(text).byteLength)).toBe(text);
    await expect(readLimited(new Response(text), new TextEncoder().encode(text).byteLength - 1)).rejects.toMatchObject({ status: 503 });
  });

  it('readAtlasJson answers 503 for an Atlas file over the limit (Content-Length or streamed)', async () => {
    const big = { fetch: async () => new Response('{"a":1}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_ATLAS_BYTES + 10) } }) };
    await expect(readAtlasJson({ ASSETS: big } as any, ATLAS_FILES.index)).rejects.toMatchObject({ status: 503, code: 'atlas_unavailable' });
    resetAtlasCache();
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const streamed = { fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(chunk); } }), { headers: { 'content-type': 'application/json' } }) };
    await expect(readAtlasJson({ ASSETS: streamed } as any, ATLAS_FILES.earn)).rejects.toMatchObject({ status: 503, code: 'atlas_unavailable' });
  });
});
