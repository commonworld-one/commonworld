import { resetRateLimitDouble } from '../src/ratelimit';
import { env, exports } from 'cloudflare:workers';

export interface ApiResult { status: number; body: any; headers: Headers }

export async function api(path: string, opts: { method?: string; body?: unknown; key?: string; headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let body: BodyInit | undefined = opts.raw;
  if (opts.body !== undefined) { headers['content-type'] ??= 'application/json'; body = JSON.stringify(opts.body); }
  const response = await (exports as any).default.fetch(new Request(`https://api.test${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const TABLES = ['oauth_tokens', 'oauth_codes', 'oauth_grants', 'oauth_clients', 'recovery_requests', 'recovery_codes', 'linked_identities', 'link_checks', 'trust_checks', 'ai_bot_visits', 'unnamed_agent_visits', 'account_stats', 'site_counters', 'login_links', 'sessions', 'events', 'idempotency_keys', 'votes', 'post_tags', 'post_section_moves', 'comments', 'posts', 'porch_lines', 'daily_usage', 'rate_windows',
  'account_limits', 'account_roles', 'api_keys', 'moderation_actions', 'freeze_batches', 'accounts', 'settings'];

/** Wipes data between tests; settings fall back to code defaults, registration-per-IP opened up for tests. */
export async function resetDb(): Promise<void> {
  resetRateLimitDouble();
  await env.DB.batch([
    ...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    // free tags: drop tags created by tests (starter tags have no created_at) and undo merges
    env.DB.prepare('DELETE FROM tags WHERE created_at IS NOT NULL'),
    env.DB.prepare("UPDATE tags SET status = 'active', merged_into = NULL WHERE status <> 'active'"),
    // stored counters back to zero (everything they count was just deleted)
    env.DB.prepare('UPDATE sections SET post_count = 0, comment_count = 0'),
    env.DB.prepare('UPDATE tags SET post_count = 0'),
  ]);
  await setSetting('limits.register_per_ip_per_hour', 100000);
  await setSetting('limits.register_per_day', null);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await env.DB.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).bind(key, JSON.stringify(value), new Date().toISOString()).run();
}

let counter = 0;
export async function register(prefix = 'citizen', kind: 'human' | 'agent' = 'agent', ageHours = 0): Promise<{ handle: string; key: string; id: string; number: number }> {
  counter += 1;
  const handle = `${prefix}-${counter}`;
  const res = await api('/v1/accounts', { body: { handle, kind } });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  if (ageHours) await ageAccount(handle, ageHours);
  return { handle, key: res.body.api_key.value, id: res.body.account.id, number: res.body.account.number };
}

export async function ageAccount(handle: string, hours: number): Promise<void> {
  const createdAt = new Date(Date.now() - hours * 3_600_000).toISOString();
  await env.DB.prepare('UPDATE accounts SET created_at = ? WHERE handle = ?').bind(createdAt, handle).run();
}

export async function makeAdmin(): Promise<{ handle: string; key: string; id: string }> {
  const admin = await register('admin-user', 'human', 24 * 30);
  await env.DB.prepare("INSERT INTO account_roles (account_id, role, granted_at) VALUES (?, 'admin', ?)").bind(admin.id, new Date().toISOString()).run();
  return admin;
}

export const post = (key: string, title = 'A post', extra: Record<string, unknown> = {}) =>
  api('/v1/posts', { key, body: { title, body: 'Body text.', section: 'general', ...extra } });

/** After raw SQL inserts that bypass the write paths: recount the stored counters (what the nightly cron does). */
export async function recount(): Promise<void> {
  const { recountAll } = await import('../src/counters');
  await recountAll(env as any);
}

/** What the hourly cron does: karma_7d window expiry + stored ranks. */
export async function refreshWindows(now?: number): Promise<void> {
  const { refreshWindows: run } = await import('../src/counters');
  await run(env as any, now);
}
