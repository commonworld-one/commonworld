import type { Env } from './env';
import { HttpError, nowIso } from './http';
import { bumpContentCacheVersion } from './cache-version';
import { recountStatementsWith } from './counters';

export interface ShieldMode { enabled: boolean; young_account_hours: number; factor: number }
export interface LockMode { enabled: boolean; min_account_age_hours: number }
export interface BrakeMode { enabled: boolean; rate_per_minute: number; trusted_karma_min: number }
export interface KarmaWeights { upvote: number; post: number; comment: number; porch: number }
export interface Announcement { text: string; updated_at: string }

export interface Settings {
  'limits.daily.post': number | null;
  'limits.daily.comment': number | null;
  'limits.daily.vote': number | null;
  'limits.daily.porch': number | null;
  'limits.rate_per_minute': number;
  'limits.register_per_ip_per_hour': number;
  /** Platform-wide cap on new accounts per UTC day (all IPs together). null = no cap. */
  'limits.register_per_day': number | null;
  /** New (never used before) tags one account may create per UTC day. null = no cap. */
  'limits.new_tags_per_day': number | null;
  /** Own posts/comments/porch lines one account may withdraw per UTC day (all three together). null = no cap. */
  'limits.daily.withdraw': number | null;
  /** Section moves (POST /v1/posts/{n}/section) one account may make per UTC day. null = no cap. */
  'limits.daily.move': number | null;
  /** Decisions (POST /v1/posts/{n}/decisions) one account may record per UTC day. null = no cap. */
  'limits.daily.decision': number | null;
  'karma.weights': KarmaWeights;
  'karma.min_voter_age_hours': number;
  'mode.shield': ShieldMode;
  'mode.lock': LockMode;
  'mode.brake': BrakeMode;
  announcement: Announcement | null;
}
export type SettingKey = keyof Settings;

/** Same values as migrations/0004_controls.sql; used when a row is missing. */
export const DEFAULTS: Settings = {
  'limits.daily.post': 3,
  'limits.daily.comment': 50,
  'limits.daily.vote': 50,
  'limits.daily.porch': null,
  'limits.rate_per_minute': 120,
  'limits.register_per_ip_per_hour': 10,
  'limits.register_per_day': 500,
  'limits.new_tags_per_day': 10,
  'limits.daily.withdraw': 5,
  'limits.daily.move': 30,
  'limits.daily.decision': 30,
  'karma.weights': { upvote: 5, post: 3, comment: 2, porch: 1 },
  'karma.min_voter_age_hours': 72,
  'mode.shield': { enabled: false, young_account_hours: 72, factor: 0.5 },
  'mode.lock': { enabled: false, min_account_age_hours: 72 },
  'mode.brake': { enabled: false, rate_per_minute: 10, trusted_karma_min: 100 },
  announcement: null,
};

const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

const nullableDaily = (v: unknown) => v === null || isInt(v, 0, 1_000_000);

/** Own-key check: inherited names (`constructor`, `__proto__`, `toString`) are never settings. */
export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(DEFAULTS, key) && Object.hasOwn(VALIDATORS, key);

export const VALIDATORS: Record<SettingKey, (v: unknown) => boolean> = {
  'limits.daily.post': nullableDaily,
  'limits.daily.comment': nullableDaily,
  'limits.daily.vote': nullableDaily,
  'limits.daily.porch': nullableDaily,
  'limits.rate_per_minute': (v) => isInt(v, 1, 100_000),
  'limits.register_per_ip_per_hour': (v) => isInt(v, 0, 1_000_000),
  'limits.register_per_day': nullableDaily,
  'limits.new_tags_per_day': nullableDaily,
  'limits.daily.withdraw': nullableDaily,
  'limits.daily.move': nullableDaily,
  'limits.daily.decision': nullableDaily,
  'karma.weights': (v) => isObj(v) && exactKeys(v, ['upvote', 'post', 'comment', 'porch']) && Object.values(v).every((x) => isInt(x, 0, 1000)),
  'karma.min_voter_age_hours': (v) => isInt(v, 0, 24 * 365),
  'mode.shield': (v) => isObj(v) && exactKeys(v, ['enabled', 'young_account_hours', 'factor']) && isBool(v.enabled)
    && isInt(v.young_account_hours, 1, 24 * 365) && typeof v.factor === 'number' && v.factor > 0 && v.factor <= 1,
  'mode.lock': (v) => isObj(v) && exactKeys(v, ['enabled', 'min_account_age_hours']) && isBool(v.enabled) && isInt(v.min_account_age_hours, 0, 24 * 365),
  'mode.brake': (v) => isObj(v) && exactKeys(v, ['enabled', 'rate_per_minute', 'trusted_karma_min']) && isBool(v.enabled)
    && isInt(v.rate_per_minute, 1, 100_000) && isInt(v.trusted_karma_min, 0, 1_000_000_000),
  announcement: (v) => v === null || (isObj(v) && exactKeys(v, ['text', 'updated_at']) && typeof v.text === 'string'),
};

let cache: { at: number; values: Settings } | null = null;

export function invalidateSettings(): void { cache = null; }

export async function getSettings(env: Env): Promise<Settings> {
  const ttl = Number(env.SETTINGS_CACHE_MS ?? '5000');
  if (cache && Date.now() - cache.at < ttl) return cache.values;
  const { results } = await env.DB.prepare('SELECT key, value_json FROM settings').all<{ key: string; value_json: string }>();
  const values: Settings = structuredClone(DEFAULTS);
  for (const row of results) {
    if (!isSettingKey(row.key)) continue;
    const key = row.key as SettingKey;
    try {
      const parsed = JSON.parse(row.value_json);
      if (VALIDATORS[key](parsed)) (values as unknown as Record<string, unknown>)[key] = parsed;
      else console.warn(`settings: invalid stored value for ${key}, using default`);
    } catch { console.warn(`settings: unparsable value for ${key}, using default`); }
  }
  cache = { at: Date.now(), values };
  return values;
}

/** Validates and writes settings in one D1 batch, logging the change. */
export async function writeSettings(env: Env, patch: Partial<Record<SettingKey, unknown>>, actorId: string, action: string): Promise<Settings> {
  const entries = Object.entries(patch) as [SettingKey, unknown][];
  if (!entries.length) throw new HttpError(400, 'no_settings_given');
  for (const [key, value] of entries) {
    if (!isSettingKey(key)) throw new HttpError(400, 'unknown_setting', { key });
    if (!VALIDATORS[key](value)) throw new HttpError(400, 'invalid_setting_value', { key });
  }
  const at = nowIso();
  await env.DB.batch([
    ...entries.map(([key, value]) => env.DB.prepare(
      `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(key, JSON.stringify(value), at, actorId)),
    env.DB.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(actorId, action, 'settings', entries.map(([k]) => k).join(','), JSON.stringify(Object.fromEntries(entries)), at),
    // announcement and karma weights are on cached pages and reads
    bumpContentCacheVersion(env.DB),
    // stored karma uses the weights: recount with the new ones (src/counters.ts)
    ...(Object.hasOwn(patch, 'karma.weights') ? recountStatementsWith(env.DB, patch['karma.weights'] as KarmaWeights) : []),
  ]);
  invalidateSettings();
  return getSettings(env);
}
