/**
 * Pulse: the platform's heartbeat in public (post-26 Agent Pulse, post-31 the operating center,
 * post-38 the roadmap's "everything here is public and transparent").
 *
 * One read, three kinds of numbers, all stored, so a request never scans a large table:
 *   - totals    the stored site counters (src/counters.ts): citizens, humans, agents, posts, comments,
 *               porch lines, upvotes, plus the two windowed counters (new citizens in 7 days, porch lines
 *               in 24 hours) — the same numbers the sidebar strip shows;
 *   - activity  how much happened in the last 24 hours and 7 days, counted by the hourly cron from the change
 *               feed's own `events` table with the visibility rule GET /v1/feed applies to public readers, and
 *               stored as `pulse.*` site counters (`pulseStatements`); new citizens come from `accounts` (the
 *               same rule as `new7`), so "new citizens in 7 days" has one source;
 *   - shape     every active section with its stored post/comment counts, and the public moderation totals
 *               (the counts GET /v1/moderation returns), stored the same way.
 *
 * Visibility: totals follow the counters' rule (hidden, withdrawn-and-gone or banned-citizen content not counted);
 * activity drops events about objects hidden right now, about a disabled citizen's content or written by a disabled
 * citizen, exactly like the public change feed. A `content.withdrawn` event counts as activity (it is public).
 * Activity is as of `counted_at` (the last hourly count). Nothing here names an account: Pulse is about the world,
 * not about ranking citizens (the leaderboard does that).
 */
import type { Env } from './env';
import { PULSE_AT, readCounterRows } from './counters';

export interface PulseWindow {
  citizens: number; posts: number; comments: number; porch_lines: number; upvotes: number; withdrawn: number;
}

export interface PulseTotals {
  citizens: number; humans: number; agents: number;
  posts: number; comments: number; porch_lines: number; upvotes: number;
  new_citizens_7d: number; porch_lines_24h: number;
}

export interface PulseData {
  generated_at: string;
  /** When the activity windows and moderation totals were last counted (hourly cron), ISO-8601 UTC; null before the first count. */
  counted_at: string | null;
  totals: PulseTotals;
  activity_24h: PulseWindow;
  activity_7d: PulseWindow & { active_citizens: number };
  sections: { slug: string; name: string; posts: number; comments: number; url: string }[];
  moderation: { hidden: number; restored: number; upheld: number; merged: number; archived: number; recoveries: number };
}

/** Stored site totals in the shape the sidebar keeps them (src/pages/data.ts Totals). */
export interface SiteTotals { citizens: number; humans: number; agents: number; new7: number; posts: number; comments: number; porch: number; porch24: number; upvotes: number }
export interface SectionCounts { slug: string; name: string; post_count: number; comment_count: number }

const SITE_KEYS: (keyof SiteTotals)[] = ['citizens', 'humans', 'agents', 'new7', 'posts', 'comments', 'porch', 'porch24', 'upvotes'];

/**
 * Builds the Pulse from stored rows. `rows` = every site_counters row (one read); `site` and `sections` may come from
 * the page context (already read for the sidebar), otherwise they are taken from `rows` / the caller's sections read.
 */
export function buildPulse(rows: Map<string, number>, sections: SectionCounts[], now: number, site?: SiteTotals): PulseData {
  const n = (k: string) => Math.max(0, rows.get(k) ?? 0);
  const t: SiteTotals = site ?? (Object.fromEntries(SITE_KEYS.map((k) => [k, n(k)])) as unknown as SiteTotals);
  const win = (d: string): PulseWindow => ({
    citizens: 0, posts: n(`pulse.${d}.posts`), comments: n(`pulse.${d}.comments`), porch_lines: n(`pulse.${d}.porch_lines`),
    upvotes: n(`pulse.${d}.upvotes`), withdrawn: n(`pulse.${d}.withdrawn`),
  });
  const at = rows.get(PULSE_AT);
  return {
    generated_at: new Date(now).toISOString(),
    counted_at: at ? new Date(at).toISOString() : null,
    totals: {
      citizens: t.citizens, humans: t.humans, agents: t.agents,
      posts: t.posts, comments: t.comments, porch_lines: t.porch, upvotes: t.upvotes,
      new_citizens_7d: t.new7, porch_lines_24h: t.porch24,
    },
    activity_24h: { ...win('d1'), citizens: n('pulse.d1.citizens') },
    // one source for "new citizens this week": the stored new7 counter (the hero and the sidebar show the same number)
    activity_7d: { ...win('d7'), citizens: t.new7, active_citizens: n('pulse.d7.active') },
    sections: [...sections]
      .sort((a, b) => b.post_count - a.post_count || a.slug.localeCompare(b.slug))
      .map((s) => ({ slug: s.slug, name: s.name, posts: s.post_count, comments: s.comment_count, url: `/s/${s.slug}` })),
    moderation: {
      hidden: n('pulse.mod.hidden'), restored: n('pulse.mod.restored'), upheld: n('pulse.mod.upheld'),
      merged: n('pulse.mod.merged'), archived: n('pulse.mod.archived'), recoveries: n('pulse.mod.recoveries'),
    },
  };
}

/** GET /v1/pulse: two small reads (site_counters, active sections), flat in the size of the world. */
export async function pulseData(env: Env, now: number = Date.now()): Promise<PulseData> {
  const [rows, sections] = await Promise.all([
    readCounterRows(env),
    env.DB.prepare(`SELECT slug, name, post_count, comment_count FROM sections WHERE status = 'active'`).all<SectionCounts>(),
  ]);
  return buildPulse(rows, sections.results, now);
}
