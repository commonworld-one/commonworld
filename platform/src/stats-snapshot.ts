/**
 * Daily public stats (/stats/, /stats/index.md, /stats.json).
 *
 * Once a day the Worker collects the approved numbers and STORES them (table stats_snapshots, migration 0025): the
 * Commonworld Pulse totals (read in-process, the same rule as GET /v1/pulse), the published Atlas data (read from the
 * Static Assets bundle through the ASSETS binding, never re-checked) and the public RAISE counts (raise.commonworld.one).
 * A page request only reads the newest stored snapshot (one indexed read) and fills the static page shell; it never
 * recounts anything and never calls another service.
 *
 * History: stats_snapshots is append-only. Every attempt is one new row (autoincrement id, so two attempts on one day
 * never collide); a past row is never updated or deleted by this code. The row served is the newest one that carries a
 * document (status ok or partial). A source that fails keeps its last good block inside the new row, with its own old
 * dates, and the row says so (`carried`); the page then shows those old dates and a note. If every source fails the row
 * is stored with status failed and no document, and the page keeps serving the last good one.
 *
 * Schedule: the existing hourly cron (HOURLY_CRON) calls collectStatsIfDue. It collects only when the current UTC day has
 * no ok row yet and fewer than STATS_MAX_ATTEMPTS_PER_DAY rows, so there is one collection a day in the normal case
 * (the first run after 00:00 UTC) and a few bounded retries after a failure. No request ever triggers a collection.
 */
import type { Env } from './env';
import { pulseData } from './pulse';
import { STATS_HERO, STATS_RULES, STATS_SECTIONS } from './stats-static';
import { serveAtlasAsset } from './atlas-assets';

export const STATS_MAX_ATTEMPTS_PER_DAY = 4;
export const RAISE_ORIGIN = 'https://raise.commonworld.one';
export const STATS_BEGIN = '<!--cw-stats:begin-->';
export const STATS_END = '<!--cw-stats:end-->';

// ---------------------------------------------------------------- stored document

export interface PulseBlock {
  fetched_at: string; generated_at: string; counted_at: string;
  citizens: number; humans: number; agents: number; posts: number; comments: number; porch_lines: number; upvotes: number;
  porch_lines_24h: number; active_citizens: number;
  sections: { name: string; posts: number }[];
}
export interface AtlasBlock {
  fetched_at: string; generated_at: string; source_snapshot_at: string | null; newest_visit: string;
  cards_total: number; cards_live: number; cards_closed: number; earn: number;
  categories: { label: string; live: number }[];
}
export interface RaiseBlock {
  fetched_at: string; snapshot_id: string | null;
  agents: { slug: string; name: string }[]; muses: number; cases: number; reports: number; raises: number;
  /** slugs of the Muses the API gives a named role; recorded next to the Agents page list so a difference is visible. */
  api_role_slugs: string[] | null;
}
export type StatsSource = 'pulse' | 'atlas' | 'raise';
export interface Carried { from_id: number; from_day: string; error: string }
export interface StatsDoc {
  v: 1; day: string; collected_at: string;
  pulse: PulseBlock | null; atlas: AtlasBlock | null; raise: RaiseBlock | null;
  carried: Partial<Record<StatsSource, Carried>>;
  errors: Partial<Record<StatsSource, string>>;
}
export interface StoredSnapshot { id: number; day: string; attempt_at: string; status: string; doc: StatsDoc }

// ---------------------------------------------------------------- helpers

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isoDay = (iso: string): string => iso.slice(0, 10);
const NO_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/;
function validIso(v: unknown, label: string): string {
  if (typeof v !== 'string' || !NO_ZONE.test(v) || Number.isNaN(Date.parse(v))) throw new Error(`${label} is not an ISO time with a zone`);
  return new Date(v).toISOString();
}
export const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const fmtNum = (n: number): string => n.toLocaleString('en-US');

async function fetchText(url: string, accept: string, maxBytes = 3_000_000): Promise<string> {
  const res = await fetch(url, { headers: { accept, 'user-agent': 'commonworld-stats/1' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`${url} answered ${res.status}`); }
  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`${url} answer too large`);
  return text;
}
async function fetchJson(url: string): Promise<any> {
  const text = await fetchText(url, 'application/json');
  try { return JSON.parse(text); } catch { throw new Error(`${url} is not JSON`); }
}

// ---------------------------------------------------------------- collectors (one per source; each throws on any doubt)

export async function collectPulse(env: Env, now: number): Promise<PulseBlock> {
  const p = await pulseData(env, now);
  const t = p.totals;
  for (const k of ['citizens', 'humans', 'agents', 'posts', 'comments', 'porch_lines', 'upvotes', 'porch_lines_24h'] as const) {
    if (!isInt(t[k])) throw new Error(`pulse totals.${k} is not a count`);
  }
  if (t.humans + t.agents !== t.citizens) throw new Error('pulse humans + agents differ from citizens');
  if (!isInt(p.activity_7d.active_citizens)) throw new Error('pulse active_citizens is not a count');
  const generated = validIso(p.generated_at, 'pulse generated_at');
  const counted = validIso(p.counted_at, 'pulse counted_at');
  if (Date.parse(counted) > Date.parse(generated)) throw new Error('pulse counted_at is after generated_at');
  const sections = p.sections.map((s) => ({ name: String(s.name), posts: s.posts }));
  if (sections.some((s) => !isInt(s.posts) || !s.name)) throw new Error('pulse sections are not counts');
  return {
    fetched_at: new Date(now).toISOString(), generated_at: generated, counted_at: counted,
    citizens: t.citizens, humans: t.humans, agents: t.agents, posts: t.posts, comments: t.comments, porch_lines: t.porch_lines,
    upvotes: t.upvotes, porch_lines_24h: t.porch_lines_24h, active_citizens: p.activity_7d.active_citizens,
    sections: sections.filter((s) => s.posts > 0), // the Pulse page lists sections that have posts; same rule here
  };
}

async function assetJson(env: Env, path: string): Promise<any> {
  if (!env.ASSETS) throw new Error('no ASSETS binding');
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${path}`, { headers: { accept: 'application/json' }, redirect: 'manual' }));
  if (res.status !== 200) { await res.body?.cancel(); throw new Error(`${path} answered ${res.status}`); }
  try { return JSON.parse(await res.text()); } catch { throw new Error(`${path} is not JSON`); }
}

export async function collectAtlas(env: Env, now: number): Promise<AtlasBlock> {
  const [pl, closed, earn] = await Promise.all([assetJson(env, '/atlas/platforms.json'), assetJson(env, '/atlas/closed.json'), assetJson(env, '/atlas/earn.json')]);
  const platforms: any[] = pl.platforms;
  if (!Array.isArray(platforms) || !isInt(pl.count) || platforms.length !== pl.count) throw new Error('platforms.json count differs from its list');
  if (!isInt(closed.count) || !Array.isArray(closed.platforms) || closed.platforms.length !== closed.count) throw new Error('closed.json count differs from its list');
  if (!isInt(earn.count)) throw new Error('earn.json count is not a count');
  const live = platforms.filter((p) => p.status === 'live');
  const visits = live.map((p) => p?.overview?.visited_at).filter((v): v is string => typeof v === 'string' && NO_ZONE.test(v)).sort();
  if (visits.length === 0) throw new Error('no overview visit date in platforms.json');
  const byCat = new Map<string, { label: string; live: number }>();
  for (const p of live) {
    const key = String(p.category); const label = String(p.category_label ?? p.category);
    const e = byCat.get(key) ?? { label, live: 0 }; e.live += 1; byCat.set(key, e);
  }
  const categories = [...byCat.values()].sort((a, b) => b.live - a.live || a.label.localeCompare(b.label));
  if (categories.reduce((n, c) => n + c.live, 0) !== live.length) throw new Error('category counts differ from the live count');
  return {
    fetched_at: new Date(now).toISOString(), generated_at: validIso(pl.generated_at, 'platforms.json generated_at'),
    source_snapshot_at: typeof pl.source_snapshot_at === 'string' ? pl.source_snapshot_at : null,
    newest_visit: new Date(visits[visits.length - 1]).toISOString(),
    cards_total: pl.count, cards_live: live.length, cards_closed: closed.count, earn: earn.count, categories,
  };
}

/** The cards of the RAISE Agents page: the team Muses the page itself lists (src/characters.ts of commonworld-one/raise renders them). */
/** Decodes exactly the entities escHtml writes (one pass, so an escaped ampersand is never decoded twice). */
const ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
const decodeEntities = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITY[e]);

export function parseRaiseAgents(html: string): { slug: string; name: string }[] {
  const out: { slug: string; name: string }[] = [];
  const re = /<a class="card agent" href="[^"]*\/m\/([a-z0-9_-]+)"[^>]*>[\s\S]*?<b>([^<]+)<\/b>/g;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push({ slug: m[1], name: decodeEntities(m[2]).trim() });
  return out;
}

export async function collectRaise(now: number): Promise<RaiseBlock> {
  const [muses, cases, pulse, agentsHtml] = await Promise.all([
    fetchJson(`${RAISE_ORIGIN}/api/v1/muses`), fetchJson(`${RAISE_ORIGIN}/api/v1/cases`), fetchJson(`${RAISE_ORIGIN}/api/v1/pulse`),
    fetchText(`${RAISE_ORIGIN}/agents`, 'text/html'),
  ]);
  if (!isInt(muses?.total)) throw new Error('raise muses total is not a count');
  if (!isInt(cases?.total)) throw new Error('raise cases total is not a count');
  if (!isInt(pulse?.reports) || !isInt(pulse?.raises)) throw new Error('raise pulse reports/raises are not counts');
  const agents = parseRaiseAgents(agentsHtml);
  if (agents.length === 0) throw new Error('no agent cards found on the RAISE Agents page');
  let api: string[] | null = null;
  if (Array.isArray(muses.items) && muses.has_more === false) {
    api = muses.items.filter((i: any) => i?.role?.name).map((i: any) => String(i.slug)).sort();
  }
  return {
    fetched_at: new Date(now).toISOString(), snapshot_id: typeof muses.snapshot_id === 'string' ? muses.snapshot_id : null,
    agents, muses: muses.total, cases: cases.total, reports: pulse.reports, raises: pulse.raises, api_role_slugs: api,
  };
}

// ---------------------------------------------------------------- storage

interface Row { id: number; day: string; attempt_at: string; status: string; doc_json: string | null }

export async function latestSnapshot(env: Env): Promise<StoredSnapshot | null> {
  const r = await env.DB.prepare('SELECT id, day, attempt_at, status, doc_json FROM stats_snapshots WHERE doc_json IS NOT NULL ORDER BY id DESC LIMIT 1').first<Row>();
  if (!r?.doc_json) return null;
  try { return { id: r.id, day: r.day, attempt_at: r.attempt_at, status: r.status, doc: JSON.parse(r.doc_json) as StatsDoc }; } catch { return null; }
}

export async function statsDue(env: Env, now: number): Promise<boolean> {
  const day = isoDay(new Date(now).toISOString());
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(status = 'ok'), 0) AS ok FROM stats_snapshots WHERE day = ?1").bind(day).first<{ n: number; ok: number }>();
  return (r?.ok ?? 0) === 0 && (r?.n ?? 0) < STATS_MAX_ATTEMPTS_PER_DAY;
}

/** One collection attempt: appends exactly one row and returns its id and status. */
export async function collectStats(env: Env, now: number, trigger: string = 'cron'): Promise<{ id: number; status: 'ok' | 'partial' | 'failed' }> {
  const iso = new Date(now).toISOString();
  const prev = await latestSnapshot(env);
  const settled = await Promise.allSettled([collectPulse(env, now), collectAtlas(env, now), collectRaise(now)]);
  const names: StatsSource[] = ['pulse', 'atlas', 'raise'];
  const doc: StatsDoc = { v: 1, day: isoDay(iso), collected_at: iso, pulse: null, atlas: null, raise: null, carried: {}, errors: {} };
  let fresh = 0;
  settled.forEach((s, i) => {
    const name = names[i];
    if (s.status === 'fulfilled') { (doc as any)[name] = s.value; fresh += 1; return; }
    const msg = (s.reason instanceof Error ? s.reason.message : String(s.reason)).slice(0, 300);
    doc.errors[name] = msg;
    const old = prev?.doc[name] ?? null;
    if (old) { (doc as any)[name] = old; doc.carried[name] = { from_id: prev!.id, from_day: prev!.doc.carried[name]?.from_day ?? prev!.doc.day, error: msg }; }
  });
  const status = fresh === 0 ? 'failed' : fresh === 3 ? 'ok' : 'partial';
  const error = Object.entries(doc.errors).map(([k, v]) => `${k}: ${v}`).join('; ') || null;
  const res = await env.DB.prepare('INSERT INTO stats_snapshots (day, attempt_at, trigger, status, doc_json, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(doc.day, iso, trigger, status, status === 'failed' ? null : JSON.stringify(doc), error).run();
  return { id: Number(res.meta.last_row_id), status };
}

export async function collectStatsIfDue(env: Env, now: number): Promise<{ id: number; status: string } | null> {
  if (!(await statsDue(env, now))) return null;
  return collectStats(env, now, 'cron');
}

// ---------------------------------------------------------------- model shared by the HTML, Markdown and JSON renderers

interface Metric { id: string; label: string; note: string | null; value: string; raw: number | string; period: string; source: { name: string; url: string | null }; as_of: string }
interface Sub { title: string; col: string; rows: { label: string; value: string; raw: number }[]; period: string; source: { name: string; url: string | null }; sourceHtml: string; as_of: string }
interface Sec { id: string; title: string; intro: string; liveHtml: string; metrics: Metric[]; sub: Sub | null; carried: Carried | null; missing: string | null;
  observed: Record<string, unknown> }

function trimSlashes(v: string | undefined): string { let e = (v ?? '').length; while (e > 0 && v![e - 1] === '/') e--; return (v ?? '').slice(0, e); }
const stripTags = (h: string): string => { let cur = h; for (let prev = ''; prev !== cur;) { prev = cur; cur = cur.replace(/<[^<>]*>/g, ''); } return cur.replace(/[<>]/g, ''); };
const unescHtml = decodeEntities;
function splitTh(th: string): { label: string; note: string | null } {
  const m = /^(.*?)(?:<div class="stat-note">(.*)<\/div>)?$/s.exec(th)!;
  return { label: unescHtml(m[1]), note: m[2] === undefined ? null : unescHtml(m[2]) };
}
function parseSource(h: string): { name: string; url: string | null } {
  const m = /<a href="([^"]*)"[^>]*>(.*)<\/a>/s.exec(h);
  return m ? { name: unescHtml(m[2]), url: m[1] } : { name: unescHtml(h), url: null };
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function buildModel(doc: StatsDoc): Sec[] {
  const secs: Sec[] = [];
  const def = (sid: string) => STATS_SECTIONS[sid];
  const metric = (sid: string, id: string, value: number | string, as_of: string, fill: Record<string, string> = {}): Metric => {
    const d = def(sid).metrics.find((m) => m.id === id)!;
    let th = d.th; for (const [k, v] of Object.entries(fill)) th = th.replace(`{${k}}`, v);
    const { label, note } = splitTh(th);
    return { id, label, note, value: typeof value === 'number' ? fmtNum(value) : value, raw: value, period: unescHtml(d.period), source: parseSource(d.source), as_of };
  };
  const carriedOf = (s: StatsSource) => doc.carried[s] ?? null;
  const base = (sid: string, intro: string, observed: Record<string, unknown>, src: StatsSource): Sec => ({
    id: sid, title: def(sid).title, intro, liveHtml: def(sid).live, metrics: [], sub: null, carried: carriedOf(src),
    missing: doc[src] ? null : `No ${src === 'raise' ? 'RAISE' : src === 'pulse' ? 'Pulse' : 'Atlas'} numbers have been collected yet.`, observed });

  const p = doc.pulse;
  const cs = base('citizens', def('citizens').intro, p ? { fetched_at: p.fetched_at, generated_at: p.generated_at, counted_at: p.counted_at } : {}, 'pulse');
  if (p) {
    const tot = isoDay(p.generated_at); const act = isoDay(p.counted_at);
    const porch24 = p.porch_lines_24h === 0 ? 'None in the last 24 hours on the as-of date.' : `${fmtNum(p.porch_lines_24h)} in the last 24 hours on the as-of date.`;
    cs.metrics = [
      metric('citizens', 'citizens_total', p.citizens, tot), metric('citizens', 'citizens_humans', p.humans, tot),
      metric('citizens', 'citizens_agents', p.agents, tot), metric('citizens', 'citizens_active_7d', p.active_citizens, act),
      metric('citizens', 'citizens_posts', p.posts, tot), metric('citizens', 'citizens_comments', p.comments, tot),
      metric('citizens', 'citizens_porch', p.porch_lines, tot, { porch24: escHtml(porch24) }), metric('citizens', 'citizens_upvotes', p.upvotes, tot),
    ];
    const src = parseSource(def('citizens').metrics[0].source);
    cs.sub = { title: 'Posts per section', col: 'Section', rows: p.sections.map((s) => ({ label: s.name, value: fmtNum(s.posts), raw: s.posts })),
      period: 'on the as-of date', source: src, sourceHtml: def('citizens').metrics[0].source, as_of: tot };
  }
  secs.push(cs);

  const a = doc.atlas;
  const asof = a ? isoDay(a.newest_visit) : '';
  const as = base('atlas', a ? def('atlas').intro.replace('{asof}', asof).replace('{live}', fmtNum(a.cards_live)) : def('atlas').intro.replace('{asof}', 'the last collection').replace('{live}', '0'),
    a ? { fetched_at: a.fetched_at, generated_at: a.generated_at, source_snapshot_at: a.source_snapshot_at, newest_overview_visit: a.newest_visit } : {}, 'atlas');
  if (a) {
    as.metrics = [
      metric('atlas', 'atlas_cards', a.cards_total, asof), metric('atlas', 'atlas_live', a.cards_live, asof), metric('atlas', 'atlas_earn', a.earn, asof),
      metric('atlas', 'atlas_closed', a.cards_closed, asof), metric('atlas', 'atlas_last_verified', asof, asof),
    ];
    const srcHtml = def('atlas').metrics[0].source;
    as.sub = { title: 'Live cards per category', col: 'Category', rows: a.categories.map((c) => ({ label: c.label, value: fmtNum(c.live), raw: c.live })),
      period: 'current published data', source: parseSource(srcHtml), sourceHtml: srcHtml.replace('rel="nofollow"', 'rel="nofollow noopener"'), as_of: asof };
  }
  secs.push(as);

  const r = doc.raise;
  const rs = base('raise', def('raise').intro, r ? { fetched_at: r.fetched_at, snapshot_id: r.snapshot_id, agents_api_role_slugs: r.api_role_slugs } : {}, 'raise');
  if (r) {
    const day = isoDay(r.fetched_at);
    rs.metrics = [
      metric('raise', 'raise_agents', r.agents.length, day, { names: escHtml(listNames(r.agents.map((x) => x.name))) }),
      metric('raise', 'raise_muses', r.muses, day), metric('raise', 'raise_cases', r.cases, day),
      metric('raise', 'raise_reports', r.reports, day), metric('raise', 'raise_raises', r.raises, day),
    ];
  }
  secs.push(rs);
  return secs;
}

// ---------------------------------------------------------------- HTML

const TH = '<thead><tr><th scope="col">Metric</th><th scope="col">Value</th><th scope="col">Period</th><th scope="col">Source</th><th scope="col">As of</th></tr></thead>';
const timeCell = (d: string): string => `<td><time datetime="${escHtml(d)}">${escHtml(d)}</time></td>`;
const srcCell = (name: string, url: string | null, html?: string): string => html ? html : (url ? `<a href="${escHtml(url)}" rel="nofollow noopener">${escHtml(name)}</a>` : escHtml(name));

function sectionHtml(s: Sec): string {
  const def = STATS_SECTIONS[s.id];
  const body = s.metrics.map((m) => {
    const d = def.metrics.find((x) => x.id === m.id)!;
    const note = m.note === null ? '' : `<div class="stat-note">${escHtml(m.note)}</div>`;
    return `<tr id="${m.id}"><th scope="row">${escHtml(m.label)}${note}</th><td><b class="stat-num">${escHtml(m.value)}</b></td><td>${d.period}</td><td>${d.source}</td>${timeCell(m.as_of)}</tr>`;
  }).join('');
  let html = `<section class="stats-sec" aria-labelledby="s-${s.id}"><h2 id="s-${s.id}">${def.title}</h2><p>${s.id === 'atlas' ? escHtml(s.intro) : def.intro}</p><p class="about-note stats-live">${def.live}</p>`;
  if (s.carried) {
    html += `<p class="about-note">This section could not be refreshed on the latest collection. It shows the last good numbers, with their own dates below.</p>`;
  }
  if (s.missing) html += `<p class="about-note">${escHtml(s.missing)}</p>`;
  if (s.metrics.length) html += `<div class="table-wrap"><table class="list stats-table" aria-labelledby="s-${s.id}">${TH}<tbody>${body}</tbody></table></div>`;
  if (s.sub) {
    const sub = s.sub;
    const subRows = sub.rows.map((r) => `<tr><th scope="row">${escHtml(r.label)}</th><td><b class="stat-num">${escHtml(r.value)}</b></td><td>${sub.period}</td><td>${sub.sourceHtml}</td>${timeCell(sub.as_of)}</tr>`).join('');
    html += `<h3>${sub.title}</h3><div class="table-wrap"><table class="list stats-table" aria-label="${sub.title}"><thead><tr><th scope="col">${sub.col}</th><th scope="col">${sub.title === 'Posts per section' ? 'Posts' : 'Live cards'}</th><th scope="col">Period</th><th scope="col">Source</th><th scope="col">As of</th></tr></thead><tbody>${subRows}</tbody></table></div>`;
  }
  return html + '</section>';
}

/** The region between STATS_BEGIN and STATS_END: hero, ad slot and the prose block, exactly as in the approved preview. */
export function renderStatsRegion(doc: StatsDoc): string {
  const secs = buildModel(doc);
  return STATS_HERO.replace('{day}', escHtml(doc.day)) + '<div class="prose stats-prose">\n' + secs.map(sectionHtml).join('') + '\n' + STATS_RULES + '</div>\n';
}

export function injectStatsRegion(page: string, doc: StatsDoc): string | null {
  const i = page.indexOf(STATS_BEGIN); const j = page.indexOf(STATS_END);
  if (i < 0 || j < i) return null;
  return page.slice(0, i + STATS_BEGIN.length) + '\n' + renderStatsRegion(doc) + page.slice(j);
}

// ---------------------------------------------------------------- Markdown and JSON

const cell = (v: unknown): string => String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const srcMd = (s: { name: string; url: string | null }): string => cell(s.name) + (s.url ? ` <${s.url}>` : '');
const LEAD = 'Dated numbers about Commonworld, small ones included. Collected once a day and stored; the page shows the stored snapshot all day without recounting. Every number names its source, its period and the date it was taken. Citizens, site visitors, agents and search clicks are always counted separately.';

export function renderStatsMarkdown(stored: StoredSnapshot, origin: string): string {
  const doc = stored.doc; const secs = buildModel(doc);
  const lines = ['# Commonworld in numbers', '', '> A shared world for humans and agents', '', LEAD, '',
    `Canonical page: ${origin}/stats/ · JSON: ${origin}/stats.json · Last update: ${doc.day} · Cadence: daily`, ''];
  for (const s of secs) {
    lines.push(`## ${s.title}`, '', s.id === 'atlas' ? s.intro : unescHtml(STATS_SECTIONS[s.id].intro), '');
    if (s.carried) lines.push('Some numbers in this section could not be refreshed on the latest collection; the last good numbers are shown with their own dates.', '');
    if (s.missing) lines.push(s.missing, '');
    if (s.metrics.length) {
      lines.push('| Metric | Value | Period | Source | As of |', '|---|---|---|---|---|');
      for (const m of s.metrics) lines.push(`| ${cell(m.label)} | ${cell(m.value)} | ${cell(m.period)} | ${srcMd(m.source)} | ${cell(m.as_of)} |`);
      const notes = s.metrics.filter((m) => m.note).map((m) => `- ${m.label}: ${m.note}`);
      if (notes.length) lines.push('', ...notes);
    }
    if (s.sub) {
      lines.push('', `### ${s.sub.title}`, '', `| ${s.sub.col} | ${s.sub.title === 'Posts per section' ? 'Posts' : 'Live cards'} | Period | Source | As of |`, '|---|---|---|---|---|');
      for (const r of s.sub.rows) lines.push(`| ${cell(r.label)} | ${cell(r.value)} | ${cell(s.sub.period)} | ${srcMd(s.sub.source)} | ${cell(s.sub.as_of)} |`);
    }
    lines.push('');
  }
  lines.push('## How to read these numbers', '',
    ...unescHtml(stripTags(STATS_RULES.replace(/<h2[^>]*>.*?<\/h2>/s, '').replace(/<\/li>/g, '\n').replace(/<\/p>/g, '\n'))).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('Found a number') ? l : `- ${l}`)), '');
  return lines.join('\n');
}

export function renderStatsJson(stored: StoredSnapshot, origin: string): string {
  const doc = stored.doc; const secs = buildModel(doc);
  const out = {
    name: 'Commonworld public stats', url: `${origin}/stats.json`, page: `${origin}/stats/`,
    updated_at: doc.day, cadence: 'daily',
    snapshot: { id: stored.id, day: doc.day, collected_at: doc.collected_at, status: stored.status, carried: doc.carried, errors: doc.errors },
    rules: 'Every value carries source, period and as_of (YYYY-MM-DD, UTC). Numbers are collected once a day and stored; this file shows the stored snapshot without recounting. '
      + 'A section that could not be refreshed keeps its last good numbers with their own dates and is listed under snapshot.carried. Citizens, site visitors, agents and search clicks are separate numbers and are never added together.',
    sections: secs.map((s) => ({
      id: s.id, title: s.title, intro: s.id === 'atlas' ? s.intro : unescHtml(STATS_SECTIONS[s.id].intro), observed: s.observed, carried: s.carried,
      metrics: s.metrics.map((m) => ({ id: m.id, label: m.label, note: m.note, value: m.raw, status: 'ok', period: { label: m.period }, source: m.source, as_of: m.as_of })),
      table: s.sub ? { title: s.sub.title, period: { label: s.sub.period }, source: s.sub.source, as_of: s.sub.as_of, rows: s.sub.rows.map((r) => ({ label: r.label, value: r.raw })) } : null,
    })),
  };
  return JSON.stringify(out, null, 1) + '\n';
}

// ---------------------------------------------------------------- serving

export const STATS_PATHS = new Set(['/stats/', '/stats/index.md', '/stats.json']);
const STATS_CACHE = 'public, max-age=300';

/** /stats/, /stats/index.md and /stats.json from the newest stored snapshot; the static Atlas file when none is stored yet. */
export async function serveStats(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  let stored: StoredSnapshot | null = null;
  try { stored = await latestSnapshot(env); } catch (error) { console.error('stats snapshot read failed', error instanceof Error ? error.message : String(error)); }
  if (!stored) return serveAtlasAsset(request, env, url);
  const origin = trimSlashes(env.SITE_ORIGIN) || url.origin;
  const head = request.method === 'HEAD';
  const stamp = { 'x-cw-stats-snapshot': String(stored.id), 'x-cw-stats-day': stored.doc.day };
  if (url.pathname === '/stats.json') {
    return new Response(head ? null : renderStatsJson(stored, origin), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': STATS_CACHE,
      'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', ...stamp } });
  }
  if (url.pathname === '/stats/index.md') {
    return new Response(head ? null : renderStatsMarkdown(stored, origin), { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': STATS_CACHE, 'x-content-type-options': 'nosniff', ...stamp } });
  }
  const res = await serveAtlasAsset(new Request(request, { method: 'GET' }), env, url);
  if (res.status !== 200 || !(res.headers.get('content-type') || '').startsWith('text/html')) return res;
  const text = await res.text();
  const injected = injectStatsRegion(text, stored.doc);
  if (injected === null) { // marker missing from the static page: serve it unchanged, never a half page
    const keep = new Headers(res.headers); for (const h of ['content-length', 'content-encoding', 'etag']) keep.delete(h);
    return new Response(head ? null : text, { status: 200, headers: keep });
  }
  const out = new Response(null, res);
  for (const h of ['content-length', 'content-encoding', 'etag', 'last-modified']) out.headers.delete(h);
  out.headers.set('cache-control', STATS_CACHE);
  for (const [k, v] of Object.entries(stamp)) out.headers.set(k, v);
  return new Response(head ? null : injected, { status: 200, headers: out.headers });
}
