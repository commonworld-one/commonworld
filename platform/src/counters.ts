/**
 * Stored counters (migration 0013) so pages and the API stop re-counting whole tables on every request:
 *   site_counters   site totals for the sidebar/stats strip (citizens, humans, agents, posts, comments, porch, upvotes)
 *   sections.post_count / comment_count, tags.post_count   catalog counts (sidebar, /sections, /v1/catalog)
 *   account_stats   all-time posts/comments/porch/upvotes/karma per account (leaderboard, profiles, /v1/me, …)
 *
 * How they stay exact:
 *   - hot writes (sign-up, post, comment, porch line, upvote) add to them in the SAME D1 batch as the write;
 *   - every rare staff action that can change visibility, account status or weights (hide/restore/uphold, tag
 *     merge/archive, status, freeze/revert, roles, settings, account deletion) appends `recountStatements` to its
 *     batch: a full recount with the reference queries (same SQL as before, so results are identical);
 *   - the nightly cron runs the same recount (reconcile), which also repairs drift from races;
 *   - if the counters were never filled (fresh migration), the first read fills them (`ensureCounters`).
 *   - account_stats.karma_7d is added to on every write like karma; the hourly cron (`refreshWindows`) recomputes
 *     karma_7d of the accounts whose items crossed the 7-day boundary since the last run (author indexes, so the cost is
 *     that hour's traffic), then refreshes the stored ranks (rank_all / rank_kind: one ordered pass, changed rows only).
 * The two windowed site numbers (new citizens in 7 days, porch lines in 24 h) work the same way: added to on write,
 * recounted hourly over the recent rows only (created_at indexes).
 * Pulse (src/pulse.ts) keeps its activity windows and moderation totals here too, as `pulse.*` rows, so GET /v1/pulse
 * and /pulse read stored rows only (`pulseStatements`): recounted hourly, by every recount, and reset nightly.
 */
import type { Env } from './env';
import { getSettings, type KarmaWeights } from './settings';
import { karma7Sql, statsSelect } from './stats';
import { EVENT_OBJECT_GONE, EVENT_OBJECT_HIDDEN, countedVoteSql, hiddenAncestorSql, notDisabledSql, shownCommentSql, shownPorchSql, shownPostSql } from './views';
import type { BatchGuard } from './batch-guard';

const RECONCILED = 'reconciled_at';
/** Epoch ms up to which items leaving the 7-day window have been subtracted from karma_7d. */
const K7_EXPIRED = 'k7_expired_at';
export const SITE_COUNTERS = ['citizens', 'humans', 'agents', 'posts', 'comments', 'porch', 'upvotes', 'new7', 'porch24'] as const;
/** Windowed site counters: added to on write, recomputed by the hourly cron (items leave the window) and every recount. */
export const WINDOW_COUNTERS = ['new7', 'porch24'] as const;
export type SiteCounter = typeof SITE_COUNTERS[number];

/** Publicly visible comment (views.ts): visible, no hidden ancestor, on a shown post, neither author disabled (F1). */
const VISIBLE_COMMENT = shownCommentSql;

/** Reference full-count queries for the site counters. */
export const SITE_COUNT_SQL: Record<Exclude<SiteCounter, typeof WINDOW_COUNTERS[number]>, string> = {
  citizens: "SELECT COUNT(*) FROM accounts WHERE status = 'active'",
  humans: "SELECT COUNT(*) FROM accounts WHERE status = 'active' AND kind = 'human'",
  agents: "SELECT COUNT(*) FROM accounts WHERE status = 'active' AND kind = 'agent'",
  posts: `SELECT COUNT(*) FROM posts p WHERE ${shownPostSql('p')}`,
  comments: `SELECT COUNT(*) FROM comments c WHERE ${VISIBLE_COMMENT('c')}`,
  porch: `SELECT COUNT(*) FROM porch_lines l WHERE ${shownPorchSql('l')}`,
  // votes of disabled citizens do not count (F1); rows stay, so re-activation brings them back on the next recount
  upvotes: `SELECT COUNT(*) FROM votes v WHERE ${countedVoteSql('v')}`,
};

/** Windowed counts over the recent rows only (created_at indexes): new citizens in 7 days, porch lines in 24 h. */
export function windowCountStatements(db: D1Database, now: number = Date.now()): D1PreparedStatement[] {
  const since7 = new Date(now - 7 * 86_400_000).toISOString(), since24 = new Date(now - 86_400_000).toISOString();
  return [
    db.prepare(`INSERT OR REPLACE INTO site_counters (name, value) VALUES ('new7', (SELECT COUNT(*) FROM accounts WHERE created_at >= ?1 AND status = 'active'))`).bind(since7),
    db.prepare(`INSERT OR REPLACE INTO site_counters (name, value) VALUES ('porch24', (SELECT COUNT(*) FROM porch_lines l WHERE l.created_at >= ?1 AND ${shownPorchSql('l')}))`).bind(since24),
    ...pulseStatements(db, now),
  ];
}

// ---------------------------------------------------------------- Pulse (src/pulse.ts)

/** Event types that count as a citizen doing something public (the change feed's writing events, moves excluded). */
export const PULSE_ACTIVE_TYPES = ['post.created', 'comment.created', 'porch.created', 'vote.created', 'content.withdrawn'] as const;
/** The moderation log's event types (src/routes/moderation.ts MODERATION_LOG_TYPES; kept here to avoid an import cycle). */
export const PULSE_MOD_TYPES = ['content.hidden', 'content.restored', 'content.upheld', 'tag.merged', 'tag.archived', 'account.recovered', 'account.recovery_rejected'] as const;
const PULSE_WINDOW_KEYS: [string, string][] = [
  ['posts', 'post.created'], ['comments', 'comment.created'], ['porch_lines', 'porch.created'], ['upvotes', 'vote.created'], ['withdrawn', 'content.withdrawn'],
];
/** Per-day keys of the week chart (`pulse.day<i>.<key>`, i = 0 today … 6); new citizens per day come from `accounts`. */
const PULSE_DAY_KEYS: [string, string][] = PULSE_WINDOW_KEYS.filter(([k]) => k !== 'withdrawn');
/** Number of UTC days in `activity_7d.days`. */
export const PULSE_DAYS = 7;
/** The UTC dates (YYYY-MM-DD) of the per-day counts: index 0 is the UTC day of `at`, index 6 six days before. */
export const pulseDayDates = (at: number): string[] =>
  Array.from({ length: PULSE_DAYS }, (_, i) => new Date(at - i * 86_400_000).toISOString().slice(0, 10));
const sqlList = (xs: readonly string[]): string => xs.map((t) => `'${t}'`).join(', ');
/** First event seq inside the 7-day window (watermark, only moves forward). */
const PULSE_SEQ7 = 'pulse.seq7';
/** Highest event seq already added to the moderation totals. */
const PULSE_MOD_SEQ = 'pulse.mod_seq';
export const PULSE_AT = 'pulse.at';

/**
 * Pulse activity windows and moderation totals, stored as `pulse.*` site_counters rows. `events` has no created_at or type
 * index, so nothing here scans it whole:
 *   - the 7-day window starts at a stored seq watermark (`pulse.seq7`) that only moves forward (seq follows created_at), so
 *     the window counts read the last 7 days of events by primary key;
 *   - public visibility is the rule GET /v1/feed applies to public readers: events about objects hidden right now, about a
 *     disabled citizen's content, or written by a disabled citizen are not counted;
 *   - new citizens in 24 h are counted from `accounts` (created_at index) with the same rule as `new7` (active accounts), so
 *     the 7-day "new citizens" is `new7` itself: one source;
 *   - per-UTC-day counts for the week chart (`pulse.day<i>.*`, posts / comments / porch lines / upvotes from the same pass,
 *     new citizens from the same `accounts` read as the 24-hour count) are columns of the same two statements: no extra scan;
 *   - moderation totals are added incrementally past `pulse.mod_seq` (moderation events are never deleted);
 *     `pulseResetStatements` drops them so the nightly recount starts them from zero.
 */
export function pulseStatements(db: D1Database, now: number = Date.now()): D1PreparedStatement[] {
  const since7 = new Date(now - 7 * 86_400_000).toISOString(), since24 = new Date(now - 86_400_000).toISOString();
  const days = pulseDayDates(now);
  const win = [
    ...PULSE_WINDOW_KEYS.flatMap(([k, t]) => [
      `'d1.${k}', COUNT(*) FILTER (WHERE e.type = '${t}' AND e.created_at >= ?2)`,
      `'d7.${k}', COUNT(*) FILTER (WHERE e.type = '${t}')`,
    ]),
    // per UTC day (day0 = today, day6 = six days ago): same pass, same rows, same visibility rule. The oldest day starts at
    // its UTC midnight, which is always inside the rolling 7-day window, so every day is complete. Dates come from
    // toISOString (digits and dashes only), so inlining them is safe.
    ...days.flatMap((date, i) => PULSE_DAY_KEYS.map(([k, t]) => `'day${i}.${k}', COUNT(*) FILTER (WHERE e.type = '${t}' AND substr(e.created_at, 1, 10) = '${date}')`)),
  ].join(', ');
  const dayCitizens = days.map((date, i) => `'day${i}.citizens', COUNT(*) FILTER (WHERE substr(created_at, 1, 10) = '${date}')`).join(', ');
  const mod = `json_object('hidden', COUNT(*) FILTER (WHERE type = 'content.hidden'), 'restored', COUNT(*) FILTER (WHERE type = 'content.restored'),
    'upheld', COUNT(*) FILTER (WHERE type = 'content.upheld'), 'merged', COUNT(*) FILTER (WHERE type = 'tag.merged'),
    'archived', COUNT(*) FILTER (WHERE type = 'tag.archived'), 'recoveries', COUNT(*) FILTER (WHERE type IN ('account.recovered', 'account.recovery_rejected')))`;
  return [
    db.prepare(`INSERT OR REPLACE INTO site_counters (name, value) VALUES ('${PULSE_SEQ7}', COALESCE(
        (SELECT seq FROM events WHERE seq >= COALESCE((SELECT value FROM site_counters WHERE name = '${PULSE_SEQ7}'), 0) AND created_at >= ?1 ORDER BY seq LIMIT 1),
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM events)))`).bind(since7),
    db.prepare(`INSERT OR REPLACE INTO site_counters (name, value)
      SELECT 'pulse.' || key, value FROM json_each((SELECT json_object(${win}, 'd7.active', COUNT(DISTINCT e.actor_id))
        FROM events e LEFT JOIN accounts a ON a.id = e.actor_id
        WHERE e.seq >= (SELECT value FROM site_counters WHERE name = '${PULSE_SEQ7}') AND e.created_at >= ?1
          AND e.type IN (${sqlList(PULSE_ACTIVE_TYPES)})
          AND a.status IS NOT 'disabled' AND NOT (${EVENT_OBJECT_HIDDEN}) AND NOT (${EVENT_OBJECT_GONE})))`).bind(since7, since24),
    // new citizens in 24 h and per UTC day: one read of the recent accounts (created_at index), the same rule as new7
    db.prepare(`INSERT OR REPLACE INTO site_counters (name, value)
      SELECT 'pulse.' || key, value FROM json_each((SELECT json_object('d1.citizens', COUNT(*) FILTER (WHERE created_at >= ?2), ${dayCitizens})
        FROM accounts WHERE created_at >= ?1 AND status = 'active'))`).bind(`${days[PULSE_DAYS - 1]}T00:00:00.000Z`, since24),
    db.prepare(`INSERT INTO site_counters (name, value)
      SELECT 'pulse.mod.' || key, value FROM json_each((SELECT ${mod} FROM events
        WHERE seq > COALESCE((SELECT value FROM site_counters WHERE name = '${PULSE_MOD_SEQ}'), 0) AND type IN (${sqlList(PULSE_MOD_TYPES)})))
      WHERE 1 ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`),
    db.prepare(`INSERT OR REPLACE INTO site_counters (name, value) VALUES ('${PULSE_MOD_SEQ}', (SELECT COALESCE(MAX(seq), 0) FROM events))`),
    db.prepare('INSERT OR REPLACE INTO site_counters (name, value) VALUES (?1, ?2)').bind(PULSE_AT, now),
  ];
}

/** Drops the incremental moderation totals so the next `pulseStatements` recounts them from the whole log (nightly). */
export const pulseResetStatements = (db: D1Database): D1PreparedStatement[] => [
  db.prepare(`DELETE FROM site_counters WHERE name LIKE 'pulse.mod.%' OR name = '${PULSE_MOD_SEQ}'`),
];

/** Every stored counter row (site totals and `pulse.*`) in one read of the small site_counters table. */
export async function readCounterRows(env: Env): Promise<Map<string, number>> {
  await ensureCounters(env);
  const { results } = await env.DB.prepare('SELECT name, value FROM site_counters').all<{ name: string; value: number }>();
  return new Map(results.map((r) => [r.name, r.value]));
}

/** Reference post_count / comment_count of a section (same SQL as the full recount), for `sections.slug = <slug>`. */
const SECTION_COUNTS_SET = `post_count = (SELECT COUNT(*) FROM posts p WHERE p.section_slug = sections.slug AND ${shownPostSql('p')}),
      comment_count = (SELECT COUNT(*) FROM comments c JOIN posts p ON p.number = c.post_number
        WHERE p.section_slug = sections.slug AND ${shownPostSql('p')} AND c.status = 'visible' AND ${notDisabledSql('c.author_id')} AND NOT ${hiddenAncestorSql('c')})`;

/** Statements that recompute every stored counter from the raw tables (reference definitions). */
export function recountStatementsWith(db: D1Database, w: KarmaWeights): D1PreparedStatement[] {
  const since = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const now = new Date().toISOString();
  return [
    // one statement per counter: D1 caps compound SELECTs at a few terms ("too many terms in compound SELECT")
    ...Object.entries(SITE_COUNT_SQL).map(([name, sql]) =>
      db.prepare(`INSERT OR REPLACE INTO site_counters (name, value) VALUES (?1, (${sql}))`).bind(name)),
    ...windowCountStatements(db),
    db.prepare('INSERT OR REPLACE INTO site_counters (name, value) VALUES (?1, ?2)').bind(RECONCILED, Date.now()),
    db.prepare(`UPDATE sections SET ${SECTION_COUNTS_SET}`),
    db.prepare(`UPDATE tags SET post_count = (SELECT COUNT(*) FROM post_tags pt JOIN posts p ON p.number = pt.post_number
      WHERE pt.tag_slug = tags.slug AND ${shownPostSql('p')})`),
    db.prepare('DELETE FROM account_stats'),
    db.prepare(`INSERT INTO account_stats (account_id, account_number, posts, comments, porch, upvotes_received, upvotes_counted, karma, karma_7d, updated_at)
      SELECT id, number, posts, comments, porch, upvotes_received, upvotes_counted, karma, karma_7d, ?6 FROM (${statsSelect('')})`)
      .bind(since, w.upvote, w.post, w.comment, w.porch, now),
    db.prepare('INSERT OR REPLACE INTO site_counters (name, value) VALUES (?1, ?2)').bind(K7_EXPIRED, Date.now()),
    ...rankStatements(db),
  ];
}

/**
 * Recount of the stored counts of the given sections only (a post moved between two of them, src/routes/move.ts).
 * Same reference definition as the full recount, so it is exact whatever happened before; put it in the same batch.
 * With a guard (src/batch-guard.ts) the statement writes nothing unless the guard holds when it runs in the batch.
 */
export function sectionRecountStatement(db: D1Database, slugs: string[], guard?: BatchGuard): D1PreparedStatement {
  const sql = `UPDATE sections SET ${SECTION_COUNTS_SET} WHERE slug IN (SELECT value FROM json_each(?1))`;
  if (!guard) return db.prepare(sql).bind(JSON.stringify(slugs));
  return db.prepare(`${sql} AND (${guard.sql})`).bind(JSON.stringify(slugs), guard.value);
}

/** Stored leaderboard ranks (karma DESC, number ASC among active accounts; overall and per kind). Writes changed rows only. */
export function rankStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE account_stats SET rank_all = r.ra, rank_kind = r.rk
      FROM (SELECT s.account_id AS id,
          ROW_NUMBER() OVER (ORDER BY s.karma DESC, s.account_number) AS ra,
          ROW_NUMBER() OVER (PARTITION BY a.kind ORDER BY s.karma DESC, s.account_number) AS rk
        FROM account_stats s JOIN accounts a ON a.id = s.account_id WHERE a.status = 'active') r
      WHERE account_stats.account_id = r.id AND (account_stats.rank_all IS NOT r.ra OR account_stats.rank_kind IS NOT r.rk)`),
    db.prepare(`UPDATE account_stats SET rank_all = NULL, rank_kind = NULL
      WHERE rank_all IS NOT NULL AND account_id IN (SELECT id FROM accounts WHERE status <> 'active')`),
  ];
}

/**
 * Hourly cron: (1) karma_7d of every account that had an item (post, comment, porch line, or a vote it received) cross
 * the 7-day boundary since the last run is recomputed from its own recent rows; (2) stored ranks are refreshed.
 */
export async function refreshWindows(env: Env, now: number = Date.now()): Promise<{ accounts: number }> {
  await ensureCounters(env);
  const w = (await getSettings(env))['karma.weights'];
  const db = env.DB;
  // no watermark yet (fresh counters): look back two hours (one cron period + slack)
  const last = (await db.prepare('SELECT value FROM site_counters WHERE name = ?').bind(K7_EXPIRED).first<{ value: number }>())?.value ?? now - 2 * 3_600_000;
  const week = 7 * 86_400_000;
  const from = new Date(Math.min(last, now) - week).toISOString(), to = new Date(now - week).toISOString();
  const since = new Date(now - week).toISOString();
  const affected = `SELECT author_id FROM posts WHERE created_at >= ?6 AND created_at < ?7
    UNION SELECT author_id FROM comments WHERE created_at >= ?6 AND created_at < ?7
    UNION SELECT author_id FROM porch_lines WHERE created_at >= ?6 AND created_at < ?7
    UNION SELECT target_author_id FROM votes WHERE created_at >= ?6 AND created_at < ?7`;
  const [upd] = await db.batch([
    db.prepare(`UPDATE account_stats SET karma_7d = ${karma7Sql('account_stats.account_id')}, updated_at = ?8
      WHERE account_id IN (${affected})`).bind(since, w.upvote, w.post, w.comment, w.porch, from, to, new Date(now).toISOString()),
    db.prepare('INSERT OR REPLACE INTO site_counters (name, value) VALUES (?1, ?2)').bind(K7_EXPIRED, now),
    ...windowCountStatements(db, now),
    ...rankStatements(db),
  ]);
  return { accounts: upd.meta.changes ?? 0 };
}

export async function recountStatements(env: Env, weights?: KarmaWeights): Promise<D1PreparedStatement[]> {
  return recountStatementsWith(env.DB, weights ?? (await getSettings(env))['karma.weights']);
}

/** Full recount now (nightly reconcile, first read after the migration, tests after raw SQL inserts). */
export async function recountAll(env: Env): Promise<void> {
  await env.DB.batch([...pulseResetStatements(env.DB), ...await recountStatements(env)]);
  filled = true;
}

let filled = false;
/** Fills the counters once if they were never computed (fresh migration). One indexed read per isolate. */
export async function ensureCounters(env: Env): Promise<void> {
  if (filled) return;
  const row = await env.DB.prepare('SELECT value FROM site_counters WHERE name = ?').bind(RECONCILED).first<{ value: number }>();
  if (!row) await recountAll(env);
  filled = true;
}
/** Tests reset the database between cases. */
export const forgetCountersFilled = (): void => { filled = false; };

export async function readSiteCounters(env: Env): Promise<Record<SiteCounter, number>> {
  await ensureCounters(env);
  const { results } = await env.DB.prepare('SELECT name, value FROM site_counters').all<{ name: string; value: number }>();
  const out = Object.fromEntries(SITE_COUNTERS.map((k) => [k, 0])) as Record<SiteCounter, number>;
  for (const r of results) if ((SITE_COUNTERS as readonly string[]).includes(r.name)) out[r.name as SiteCounter] = Math.max(0, r.value);
  return out;
}

// ---------------------------------------------------------------- hot-path increments (same batch as the write)

export const bumpSite = (db: D1Database, name: SiteCounter, by = 1): D1PreparedStatement =>
  db.prepare('INSERT INTO site_counters (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value').bind(name, by);

/** karma_7d defaults to the karma delta (a new item is inside the 7-day window). */
export interface StatsDelta { posts?: number; comments?: number; porch?: number; upvotes_received?: number; upvotes_counted?: number; karma?: number; karma_7d?: number }

/**
 * Adds to one account's stored stats. `guardSql` (optional) is an SQL boolean that must hold for the change to apply
 * (e.g. "the vote row this request inserted exists"), with its own binds after the delta binds.
 */
export function bumpStats(db: D1Database, accountId: string, d: StatsDelta, guardSql = '1', guardBinds: unknown[] = []): D1PreparedStatement {
  return db.prepare(`INSERT INTO account_stats (account_id, account_number, posts, comments, porch, upvotes_received, upvotes_counted, karma, karma_7d, updated_at)
      SELECT id, number, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 FROM accounts WHERE id = ?1 AND (${guardSql})
      ON CONFLICT(account_id) DO UPDATE SET posts = posts + excluded.posts, comments = comments + excluded.comments, porch = porch + excluded.porch,
        upvotes_received = upvotes_received + excluded.upvotes_received, upvotes_counted = upvotes_counted + excluded.upvotes_counted,
        karma = karma + excluded.karma, karma_7d = karma_7d + excluded.karma_7d, updated_at = excluded.updated_at`)
    .bind(accountId, d.posts ?? 0, d.comments ?? 0, d.porch ?? 0, d.upvotes_received ?? 0, d.upvotes_counted ?? 0, d.karma ?? 0, d.karma_7d ?? d.karma ?? 0,
      new Date().toISOString(), ...guardBinds);
}
