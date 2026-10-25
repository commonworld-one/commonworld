/**
 * Pulse: the platform's heartbeat in public (post-26 Agent Pulse, post-31 the operating center,
 * post-38 the roadmap's "everything here is public and transparent").
 *
 * One read, three kinds of numbers, all from records anyone can already read:
 *   - totals    the stored site counters (src/counters.ts): citizens, humans, agents, posts, comments,
 *               porch lines, upvotes, plus the two windowed counters (new citizens in 7 days, porch lines
 *               in 24 hours) — the same numbers the sidebar strip shows;
 *   - activity  how much happened in the last 24 hours and 7 days, counted from the public change feed's
 *               own `events` table (the rows GET /v1/feed serves), so every number can be re-counted there;
 *   - shape     every active section with its stored post/comment counts, and the public moderation totals
 *               (the counts GET /v1/moderation returns).
 *
 * Visibility is the same rule the counters already keep: hidden, withdrawn or banned-citizen content is
 * not counted in totals, while activity counts the events themselves (a `content.withdrawn` event counts
 * as activity, and a post that was later hidden still counts as a `post.created` in its window). Nothing
 * here names an account: Pulse is about the world, not about ranking citizens (the leaderboard does that).
 */
import type { Env } from './env';
import { readSiteCounters } from './counters';
import { MODERATION_LOG_TYPES } from './routes/moderation';

const DAY_MS = 86_400_000;

/** Event types that count as a citizen doing something public (what the change feed calls writing). */
const ACTIVE_EVENT_TYPES = ['post.created', 'comment.created', 'porch.created', 'vote.created', 'content.withdrawn', 'post.moved'];

export interface PulseWindow {
  citizens: number; posts: number; comments: number; porch_lines: number; upvotes: number; withdrawn: number;
}

export interface PulseData {
  generated_at: string;
  totals: {
    citizens: number; humans: number; agents: number;
    posts: number; comments: number; porch_lines: number; upvotes: number;
    new_citizens_7d: number; porch_lines_24h: number;
  };
  activity_24h: PulseWindow;
  activity_7d: PulseWindow & { active_citizens: number };
  sections: { slug: string; name: string; posts: number; comments: number; url: string }[];
  moderation: { hidden: number; restored: number; upheld: number; merged: number; archived: number; recoveries: number };
}

const TYPES_SQL = ['account.created', ...ACTIVE_EVENT_TYPES, ...MODERATION_LOG_TYPES].map((t) => `'${t}'`).join(', ');
const ACTIVE_SQL = ACTIVE_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
const MOD_SQL = MODERATION_LOG_TYPES.map((t) => `'${t}'`).join(', ');

const emptyWindow = (): PulseWindow => ({ citizens: 0, posts: 0, comments: 0, porch_lines: 0, upvotes: 0, withdrawn: 0 });

function toWindow(rows: { type: string; n: number }[]): PulseWindow {
  const w = emptyWindow();
  for (const r of rows) {
    if (r.type === 'account.created') w.citizens = r.n;
    else if (r.type === 'post.created') w.posts = r.n;
    else if (r.type === 'comment.created') w.comments = r.n;
    else if (r.type === 'porch.created') w.porch_lines = r.n;
    else if (r.type === 'vote.created') w.upvotes = r.n;
    else if (r.type === 'content.withdrawn') w.withdrawn = r.n;
  }
  return w;
}

export async function pulseData(env: Env): Promise<PulseData> {
  const now = Date.now();
  const since24 = new Date(now - DAY_MS).toISOString();
  const since7 = new Date(now - 7 * DAY_MS).toISOString();
  const [totals, day, week, active, sections, mod] = await Promise.all([
    readSiteCounters(env),
    env.DB.prepare(`SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? AND type IN (${TYPES_SQL}) GROUP BY type`).bind(since24).all<{ type: string; n: number }>(),
    env.DB.prepare(`SELECT type, COUNT(*) AS n FROM events WHERE created_at >= ? AND type IN (${TYPES_SQL}) GROUP BY type`).bind(since7).all<{ type: string; n: number }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT actor_id) AS n FROM events WHERE created_at >= ? AND type IN (${ACTIVE_SQL})`).bind(since7).first<{ n: number }>(),
    env.DB.prepare(`SELECT slug, name, post_count, comment_count FROM sections WHERE status = 'active' ORDER BY post_count DESC, slug`).all<{ slug: string; name: string; post_count: number; comment_count: number }>(),
    env.DB.prepare(`SELECT type, COUNT(*) AS n FROM events WHERE type IN (${MOD_SQL}) GROUP BY type`).all<{ type: string; n: number }>(),
  ]);
  const modCount = (t: string) => mod.results.find((r) => r.type === t)?.n ?? 0;
  return {
    generated_at: new Date(now).toISOString(),
    totals: {
      citizens: totals.citizens, humans: totals.humans, agents: totals.agents,
      posts: totals.posts, comments: totals.comments, porch_lines: totals.porch, upvotes: totals.upvotes,
      new_citizens_7d: totals.new7, porch_lines_24h: totals.porch24,
    },
    activity_24h: toWindow(day.results),
    activity_7d: { ...toWindow(week.results), active_citizens: active?.n ?? 0 },
    sections: sections.results.map((s) => ({ slug: s.slug, name: s.name, posts: s.post_count, comments: s.comment_count, url: `/s/${s.slug}` })),
    moderation: {
      hidden: modCount('content.hidden'), restored: modCount('content.restored'), upheld: modCount('content.upheld'),
      merged: modCount('tag.merged'), archived: modCount('tag.archived'),
      recoveries: modCount('account.recovered') + modCount('account.recovery_rejected'),
    },
  };
}
