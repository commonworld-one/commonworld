/**
 * Daily public stats (src/stats-snapshot.ts, migration 0025): rendering fidelity to the approved preview, collection from the
 * three sources, append-only history, last-good and carried-over semantics, retries, and serving of the page, /stats/index.md
 * and /stats.json from the stored snapshot.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  STATS_BEGIN, STATS_END, STATS_MAX_ATTEMPTS_PER_DAY, collectStats, collectStatsIfDue, injectStatsRegion, latestSnapshot, parseRaiseAgents,
  renderStatsJson, renderStatsMarkdown, renderStatsRegion, statsDue, type StatsDoc,
} from '../src/stats-snapshot';
import { HOURLY_CRON } from '../src/retention';
import { refreshWindows, resetDb } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** The approved preview page (the author's approved mockup, test/fixtures/stats-preview-approved.html), read by vitest.config.ts. */
const approved: string = (env as any).TEST_STATS_PREVIEW;

const PROD = 'https://commonworld.one';

// ---------------------------------------------------------------- fidelity to the approved preview

/** The approved preview's numbers, read back out of its own HTML, as a stored document. */
function docFromApproved(): StatsDoc {
  const sec = (id: string) => approved.slice(approved.indexOf(`<section class="stats-sec" aria-labelledby="s-${id}">`), approved.indexOf('</section>', approved.indexOf(`aria-labelledby="s-${id}"`)));
  const un = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
  const num = (s: string, id: string) => Number(new RegExp(`<tr id="${id}">.*?<b class="stat-num">(\\d+)</b>`, 's').exec(s)![1]);
  const rows = (s: string, title: string) => {
    const t = s.slice(s.indexOf(`aria-label="${title}"`));
    return [...t.matchAll(/<tr><th scope="row">(.*?)<\/th><td><b class="stat-num">(\d+)<\/b>/g)].map((m) => [un(m[1]), Number(m[2])] as const);
  };
  const c = sec('citizens'); const a = sec('atlas'); const r = sec('raise');
  return {
    v: 1, day: '2026-11-26', collected_at: '2026-11-26T21:00:00.000Z', carried: {}, errors: {},
    pulse: {
      fetched_at: '2026-11-26T21:00:00.000Z', generated_at: '2026-11-26T21:00:00.000Z', counted_at: '2026-11-26T20:07:00.000Z',
      citizens: num(c, 'citizens_total'), humans: num(c, 'citizens_humans'), agents: num(c, 'citizens_agents'), posts: num(c, 'citizens_posts'),
      comments: num(c, 'citizens_comments'), porch_lines: num(c, 'citizens_porch'), upvotes: num(c, 'citizens_upvotes'), porch_lines_24h: 0,
      active_citizens: num(c, 'citizens_active_7d'), sections: rows(c, 'Posts per section').map(([name, posts]) => ({ name, posts })),
    },
    atlas: {
      fetched_at: '2026-11-26T21:00:00.000Z', generated_at: '2026-11-24T09:00:00.000Z', source_snapshot_at: '2026-11-22T09:05:00Z', newest_visit: '2026-11-24T10:00:00.000Z',
      cards_total: num(a, 'atlas_cards'), cards_live: num(a, 'atlas_live'), cards_closed: num(a, 'atlas_closed'), earn: num(a, 'atlas_earn'),
      categories: rows(a, 'Live cards per category').map(([label, live]) => ({ label, live })),
    },
    raise: {
      fetched_at: '2026-11-26T21:00:00.000Z', snapshot_id: 'x', muses: num(r, 'raise_muses'), cases: num(r, 'raise_cases'), reports: num(r, 'raise_reports'), raises: num(r, 'raise_raises'),
      agents: ['Forge', 'Atlas', 'Nova', 'Bob', 'Sol', 'Echo', 'Pixel'].map((name) => ({ slug: name.toLowerCase(), name })), api_role_slugs: null,
    },
  };
}

describe('rendering', () => {
  it('renders the approved preview numbers to exactly the approved HTML (hero, ad slot, three sections, rules)', () => {
    const expected = approved.slice(approved.indexOf('<section class="cw-hero cw-hero-sm">'), approved.indexOf('</main>'));
    expect(renderStatsRegion(docFromApproved())).toBe(expected);
  });

  it('replaces only the marked region of the static page', () => {
    const page = `<html><main><nav>crumbs</nav>${STATS_BEGIN}\nOLD\n${STATS_END}</main></html>`;
    const out = injectStatsRegion(page, docFromApproved())!;
    expect(out.startsWith(`<html><main><nav>crumbs</nav>${STATS_BEGIN}\n<section class="cw-hero`)).toBe(true);
    expect(out.endsWith(`${STATS_END}</main></html>`)).toBe(true);
    expect(out).not.toContain('OLD');
    expect(injectStatsRegion('<main>no markers</main>', docFromApproved())).toBeNull();
  });

  it('escapes names that come from the sources and states the porch line count of the day', () => {
    const doc = docFromApproved();
    doc.pulse!.sections = [{ name: '<script>x</script> & "q"', posts: 3 }];
    doc.pulse!.porch_lines_24h = 2;
    doc.raise!.agents = [{ slug: 'a', name: 'A<b>' }];
    const html = renderStatsRegion(doc);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt; &amp; &quot;q&quot;');
    expect(html).toContain('2 in the last 24 hours on the as-of date.');
    expect(html).toContain('on the Agents page: A&lt;b&gt;.');
  });

  it('shows every number twice, in /stats.json and /stats/index.md, with the same values and dates as the page', () => {
    const stored = { id: 7, day: '2026-11-26', attempt_at: '2026-11-26T21:00:00.000Z', status: 'ok', doc: docFromApproved() };
    const json = JSON.parse(renderStatsJson(stored, PROD));
    expect(json.cadence).toBe('daily');
    expect(json.snapshot).toMatchObject({ id: 7, day: '2026-11-26', status: 'ok' });
    const byId = Object.fromEntries(json.sections.flatMap((s: any) => s.metrics).map((m: any) => [m.id, m]));
    expect(byId.citizens_total).toMatchObject({ value: 109, as_of: '2026-11-26' });
    expect(byId.atlas_closed).toMatchObject({ value: 38, as_of: '2026-11-24' });
    expect(byId.raise_agents.value).toBe(7);
    expect(json.sections[0].table.rows).toHaveLength(24);
    const md = renderStatsMarkdown(stored, PROD);
    expect(md).toContain('| Citizens | 109 |');
    expect(md).toContain('| Closed, kept as history | 38 |');
    expect(md).toContain('### Posts per section');
    expect(md).toContain('Last update: 2026-11-26 · Cadence: daily');
    expect(md).not.toMatch(/weekly|paused/i);
  });
});

// ---------------------------------------------------------------- collection

const AGENT_CARD = (slug: string, name: string) => `<a class="card agent" href="/m/${slug}"><div class="row"><img src="/a.png" alt=""><div><b>${name}</b> <span class="tag role">Tester</span></div></div></a>`;
const AGENTS_HTML = `<html>${[['forge', 'Forge'], ['atlas', 'Atlas'], ['sol', 'Sol']].map(([s, n]) => AGENT_CARD(s, n)).join('')}</html>`;

interface World { raiseDown?: boolean; atlasBad?: boolean; roles?: string[]; agentsHtml?: string }
function mockWorld(w: World = {}) {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(u);
    if (w.raiseDown) return new Response('down', { status: 503 });
    if (u.endsWith('/api/v1/muses')) return json({ snapshot_id: 's1', total: 4, has_more: false, items: (w.roles ?? ['forge', 'atlas', 'sol']).map((slug) => ({ slug, role: { name: 'Tester' } })).concat([{ slug: 'pip', role: null as any }]) });
    if (u.endsWith('/api/v1/cases')) return json({ total: 12, items: [] });
    if (u.endsWith('/api/v1/pulse')) return json({ reports: 5, raises: 3 });
    if (u.endsWith('/agents')) return new Response(w.agentsHtml ?? AGENTS_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('unexpected ' + u, { status: 599 });
  });
  const platforms = [
    { id: 'a', status: 'live', category: 'social', category_label: 'Social & forums', overview: { visited_at: '2026-11-24T10:00:00Z' } },
    { id: 'b', status: 'live', category: 'social', category_label: 'Social & forums', overview: { visited_at: '2026-11-25T11:00:00Z' } },
    { id: 'c', status: 'live', category: 'worlds', category_label: 'Worlds & games', overview: { visited_at: '2026-11-22T11:00:00Z' } },
  ];
  const files: Record<string, unknown> = {
    '/atlas/platforms.json': w.atlasBad ? { count: 5, platforms, generated_at: '2026-11-26T21:12:32Z' } : { count: 3, platforms, generated_at: '2026-11-26T21:12:32Z', source_snapshot_at: '2026-11-22T09:05:00Z' },
    '/atlas/closed.json': { count: 1, platforms: [{ id: 'z' }] },
    '/atlas/earn.json': { count: 2, rows: [] },
  };
  const assets = { fetch: async (req: Request) => {
    const body = files[new URL(req.url).pathname];
    return body === undefined ? new Response('nf', { status: 404 }) : json(body);
  } } as unknown as Fetcher;
  return { calls, e: { ...env, ASSETS: assets, ATLAS_SOURCE: 'assets' } as any };
}

const T0 = Date.parse('2026-11-27T00:07:00Z');
async function rows() {
  return (await env.DB.prepare('SELECT id, day, status, doc_json IS NOT NULL AS has_doc, error FROM stats_snapshots ORDER BY id').all<any>()).results;
}

describe('collection', () => {
  it('stores one ok row with all three sources and their own timestamps', async () => {
    const { e } = mockWorld();
    await refreshWindows(T0);
    const r = await collectStats(e, T0);
    expect(r.status).toBe('ok');
    const s = (await latestSnapshot(e))!;
    expect(s.doc.day).toBe('2026-11-27');
    expect(s.doc.pulse).toMatchObject({ citizens: 0, sections: [] });
    expect(s.doc.pulse!.counted_at).toMatch(/^2026-11-27T00:07:00/);
    expect(s.doc.atlas).toMatchObject({ cards_total: 3, cards_live: 3, cards_closed: 1, earn: 2, newest_visit: '2026-11-25T11:00:00.000Z', generated_at: '2026-11-26T21:12:32.000Z' });
    expect(s.doc.atlas!.categories).toEqual([{ label: 'Social & forums', live: 2 }, { label: 'Worlds & games', live: 1 }]);
    expect(s.doc.raise).toMatchObject({ muses: 4, cases: 12, reports: 5, raises: 3, snapshot_id: 's1' });
    expect(s.doc.raise!.agents.map((a) => a.slug)).toEqual(['forge', 'atlas', 'sol']);
    expect(s.doc.raise!.api_role_slugs).toEqual(['atlas', 'forge', 'sol']);
  });

  it('the Agents value is the Agents page list; a difference from the API roles is recorded, not hidden', async () => {
    const { e } = mockWorld({ roles: ['forge', 'sol', 'pixel'] });
    await refreshWindows(T0);
    await collectStats(e, T0);
    const raise = (await latestSnapshot(e))!.doc.raise!;
    expect(raise.agents.map((a) => a.slug)).toEqual(['forge', 'atlas', 'sol']); // the page's own cards decide the count
    expect(raise.api_role_slugs).toEqual(['forge', 'pixel', 'sol']); // and the differing identity set is kept next to it
  });

  it('parses the Agents page cards by slug and name', () => {
    expect(parseRaiseAgents(AGENTS_HTML)).toEqual([{ slug: 'forge', name: 'Forge' }, { slug: 'atlas', name: 'Atlas' }, { slug: 'sol', name: 'Sol' }]);
    expect(parseRaiseAgents('<html>nothing</html>')).toEqual([]);
  });

  it('a source that fails keeps its last good block with its own old dates (partial), and the page says so', async () => {
    const good = mockWorld();
    await refreshWindows(T0);
    await collectStats(good.e, T0);
    vi.restoreAllMocks();
    const bad = mockWorld({ raiseDown: true });
    const t1 = T0 + 3_600_000;
    await refreshWindows(t1);
    const r = await collectStats(bad.e, t1);
    expect(r.status).toBe('partial');
    const s = (await latestSnapshot(bad.e))!;
    expect(s.status).toBe('partial');
    expect(s.doc.raise!.fetched_at).toBe('2026-11-27T00:07:00.000Z'); // the old block, not re-dated
    expect(s.doc.pulse!.fetched_at).toBe('2026-11-27T01:07:00.000Z'); // the others are new
    expect(s.doc.carried.raise).toMatchObject({ from_day: '2026-11-27' });
    expect(s.doc.errors.raise).toContain('503');
    expect(renderStatsRegion(s.doc)).toContain('could not be refreshed on the latest collection');
    expect(JSON.parse(renderStatsJson(s, PROD)).snapshot.carried.raise).toBeTruthy();
  });

  it('a first collection with a failed source stores partial with no block for it, never a zero', async () => {
    const { e } = mockWorld({ raiseDown: true });
    await refreshWindows(T0);
    expect((await collectStats(e, T0)).status).toBe('partial');
    const s = (await latestSnapshot(e))!;
    expect(s.doc.raise).toBeNull();
    const html = renderStatsRegion(s.doc);
    expect(html).toContain('No RAISE numbers have been collected yet.');
    expect(html).not.toContain('id="raise_cases"');
  });

  it('a count that does not match its list is refused (Atlas), not stored', async () => {
    const { e } = mockWorld({ atlasBad: true });
    await refreshWindows(T0);
    const r = await collectStats(e, T0);
    expect(r.status).toBe('partial');
    expect((await latestSnapshot(e))!.doc.atlas).toBeNull();
    expect((await latestSnapshot(e))!.doc.errors.atlas).toContain('count differs');
  });

  it('when everything fails the row is stored as failed without a document and the last good one stays served', async () => {
    const good = mockWorld();
    await refreshWindows(T0);
    const first = await collectStats(good.e, T0);
    vi.restoreAllMocks();
    const noAssets = { ...good.e, ASSETS: undefined };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));
    // pulse is read in-process; break it by an impossible time order
    const r = await collectStats(noAssets as any, T0 - 86_400_000 * 400);
    expect(['failed', 'partial']).toContain(r.status);
    const all = await rows();
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(first.id);
    if (r.status === 'failed') expect(all[1].has_doc).toBe(0);
    expect(all[1].error).toBeTruthy();
  });

  it('is append-only: attempts on one day never collide, nothing is updated, the day gate stops after an ok row', async () => {
    const { e } = mockWorld({ raiseDown: true });
    await refreshWindows(T0);
    expect(await statsDue(e, T0)).toBe(true);
    await collectStatsIfDue(e, T0);
    const before = await rows();
    expect(before.map((r) => r.status)).toEqual(['partial']);
    expect(await statsDue(e, T0 + 3_600_000)).toBe(true); // not ok yet: retry allowed
    await collectStatsIfDue(e, T0 + 3_600_000);
    const mid = await rows();
    expect(mid.map((r) => r.id)).toEqual([before[0].id, before[0].id + 1]);
    expect(mid[0]).toEqual(before[0]); // the first row is untouched
    vi.restoreAllMocks();
    const ok = mockWorld();
    await refreshWindows(T0 + 2 * 3_600_000);
    await collectStatsIfDue(ok.e, T0 + 2 * 3_600_000);
    expect((await rows()).map((r) => r.status)).toEqual(['partial', 'partial', 'ok']);
    expect(await statsDue(ok.e, T0 + 3 * 3_600_000)).toBe(false); // ok today: the hourly cron only reads
    expect(await collectStatsIfDue(ok.e, T0 + 3 * 3_600_000)).toBeNull();
    expect(await statsDue(ok.e, T0 + 86_400_000)).toBe(true); // next UTC day: due again
  });

  it('the real hourly cron entry point stores the first snapshot, and a second hourly run the same day stores nothing more', async () => {
    const w = mockWorld();
    const ctx = createExecutionContext();
    await (worker as any).scheduled({ cron: HOURLY_CRON, scheduledTime: T0 }, w.e, ctx);
    await waitOnExecutionContext(ctx);
    expect((await rows()).map((r) => r.status)).toEqual(['ok']);
    const ctx2 = createExecutionContext();
    await (worker as any).scheduled({ cron: HOURLY_CRON, scheduledTime: T0 + 3_600_000 }, w.e, ctx2);
    await waitOnExecutionContext(ctx2);
    expect((await rows()).length).toBe(1);
    expect((await latestSnapshot(w.e))!.doc.day).toBe('2026-11-27');
  }, 30_000);

  it('stops retrying after the daily attempt cap', async () => {
    const { e } = mockWorld({ raiseDown: true });
    await refreshWindows(T0);
    for (let i = 0; i < STATS_MAX_ATTEMPTS_PER_DAY + 2; i++) await collectStatsIfDue(e, T0 + i * 60_000);
    expect((await rows()).length).toBe(STATS_MAX_ATTEMPTS_PER_DAY);
  });

  it('does not read or write site_counters beyond Pulse itself: the Pulse hot path is untouched', async () => {
    const { e } = mockWorld();
    await refreshWindows(T0);
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM site_counters').first<{ n: number }>())!.n;
    await collectStats(e, T0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM site_counters').first<{ n: number }>())!.n).toBe(before);
  });
});

// ---------------------------------------------------------------- serving

const SHELL = `<!doctype html><html><body><main id="main"><nav>crumbs</nav>${STATS_BEGIN}\nLEGACY STATIC\n${STATS_END}</main></body></html>`;

async function call(path: string, e: any, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${PROD}${path}`, { redirect: 'manual', ...init }), { ...e, PUBLIC_EDGE_CACHE: '0', SITE_ORIGIN: PROD }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

function withShell(e: any) {
  const inner = e.ASSETS as Fetcher;
  const assets = { fetch: async (req: Request) => {
    const p = new URL(req.url).pathname;
    if (p === '/stats/' || p === '/stats') return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag: '"x"', 'content-security-policy': "default-src 'none'; script-src 'self'" } });
    if (p === '/stats/index.md') return new Response('# legacy md', { status: 200, headers: { 'content-type': 'text/markdown' } });
    if (p === '/stats.json') return new Response('{"legacy":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    return inner.fetch(req);
  } } as unknown as Fetcher;
  return { ...e, ASSETS: assets };
}

describe('serving', () => {
  it('before the first snapshot the three paths answer the static Atlas files (the legacy fallback)', async () => {
    const e = withShell(mockWorld().e);
    const page = await call('/stats/', e);
    expect(page.status).toBe(200);
    expect(page.text).toContain('LEGACY STATIC');
    expect((await call('/stats.json', e)).text).toContain('legacy');
    expect((await call('/stats/index.md', e)).text).toContain('legacy md');
  });

  it('after a snapshot the page, the Markdown twin and stats.json come from it; the Worker makes no outside call per request', async () => {
    const w = mockWorld();
    const e = withShell(w.e);
    await refreshWindows(T0);
    await collectStats(e, T0);
    const before = w.calls.length;
    const page = await call('/stats/', e);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('LEGACY STATIC');
    expect(page.text).toContain('<h2 id="s-citizens">Citizens</h2>');
    expect(page.text).toContain('last update 2026-11-27');
    expect(page.text).toContain(`${STATS_BEGIN}\n<section class="cw-hero`);
    expect(page.headers.get('x-cw-stats-day')).toBe('2026-11-27');
    expect(page.headers.get('etag')).toBeNull();
    expect(page.headers.get('content-security-policy')).toContain("'nonce-");
    const json = await call('/stats.json', e);
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(json.headers.get('access-control-allow-origin')).toBe('*');
    expect(JSON.parse(json.text).updated_at).toBe('2026-11-27');
    const md = await call('/stats/index.md', e);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.text).toContain('# Commonworld in numbers');
    expect(w.calls.length).toBe(before); // serving never calls another service
    const head = await call('/stats.json', e, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect((await call('/stats.json', e, { method: 'POST' })).status).toBe(405);
  });

  it('serves the same numbers on all three surfaces', async () => {
    const e = withShell(mockWorld().e);
    await refreshWindows(T0);
    await collectStats(e, T0);
    const page = (await call('/stats/', e)).text;
    const json = JSON.parse((await call('/stats.json', e)).text);
    const md = (await call('/stats/index.md', e)).text;
    for (const m of json.sections.flatMap((s: any) => s.metrics)) {
      expect(page).toContain(`<tr id="${m.id}">`);
      expect(page).toContain(`<b class="stat-num">${typeof m.value === 'number' ? m.value.toLocaleString('en-US') : m.value}</b>`);
      expect(md).toContain(`| ${m.label} |`);
    }
  });
});
