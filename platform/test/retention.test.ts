import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { CLEANUP_CRON, HOURLY_CRON, RETENTION_DAYS, pruneOldRecords } from '../src/retention';
import { BACKUP_CRON, RESTORE_CHECK_CRON } from '../src/backup';
import wranglerTomlRaw from '../wrangler.toml?raw';
import { api, post, register, resetDb } from './helpers';

const wranglerToml = wranglerTomlRaw.replace(/\r\n/g, '\n');

beforeEach(resetDb);

const DAY = 86_400_000;
const isoDaysAgo = (now: number, days: number) => new Date(now - days * DAY).toISOString();

async function seedOld(accountId: string, now: number): Promise<void> {
  const rows: [string, string][] = [['old-31d', isoDaysAgo(now, 31)], ['old-30d-plus-1h', isoDaysAgo(now, 30 + 1 / 24)], ['recent-29d', isoDaysAgo(now, 29)], ['recent-1d', isoDaysAgo(now, 1)]];
  await env.DB.batch([
    ...rows.map(([key, at]) => env.DB.prepare("INSERT INTO idempotency_keys (account_id, idem_key, request_hash, object_type, object_id, created_at) VALUES (?, ?, 'h', 'post', 'x', ?)").bind(accountId, key, at)),
    ...[45, 31, 29, 0].map((d) => env.DB.prepare("INSERT INTO daily_usage (account_id, day, kind, count) VALUES (?, ?, 'post', 1)").bind(accountId, isoDaysAgo(now, d).slice(0, 10))),
  ]);
}

const idemKeys = async () => (await env.DB.prepare('SELECT idem_key FROM idempotency_keys ORDER BY idem_key').all<{ idem_key: string }>()).results.map((r) => r.idem_key);
const usageDays = async (now: number) => (await env.DB.prepare('SELECT day FROM daily_usage ORDER BY day').all<{ day: string }>()).results.map((r) => Math.round((now - Date.parse(`${r.day}T00:00:00Z`)) / DAY));

describe('retention clean-up (daily_usage, idempotency_keys)', () => {
  it('keeps 30 days', () => expect(RETENTION_DAYS).toBe(30));

  it('deletes rows older than 30 days and keeps newer ones', async () => {
    const a = await register();
    const now = Date.parse('2026-10-17T03:17:00Z');
    await seedOld(a.id, now);
    const deleted = await pruneOldRecords(env as any, now);
    expect(deleted).toEqual({ daily_usage: 2, idempotency_keys: 2, login_links: 0, sessions: 0 });
    expect(await idemKeys()).toEqual(['recent-1d', 'recent-29d']);
    const left = await usageDays(now);
    expect(left.every((d) => d <= 30)).toBe(true);
    expect(left).toHaveLength(2);
  });

  it('is a no-op on fresh data and safe to run twice', async () => {
    const a = await register();
    expect((await post(a.key, 'fresh')).status).toBe(201);
    const idem = await api('/v1/posts', { key: a.key, headers: { 'idempotency-key': 'k1' }, body: { title: 'idem', body: 'Body text.', section: 'general' } });
    expect(idem.status).toBe(201);
    expect(await pruneOldRecords(env as any)).toEqual({ daily_usage: 0, idempotency_keys: 0, login_links: 0, sessions: 0 });
    expect(await pruneOldRecords(env as any)).toEqual({ daily_usage: 0, idempotency_keys: 0, login_links: 0, sessions: 0 });
    expect(await idemKeys()).toEqual(['k1']);
    const me = await api('/v1/me', { key: a.key });
    expect(me.status).toBe(200);
  });

  it('the scheduled() handler runs the clean-up at the scheduled time', async () => {
    const a = await register();
    const now = Date.now();
    await seedOld(a.id, now);
    await env.DB.prepare('INSERT INTO rate_windows (bucket, window_start, count) VALUES (?, ?, 1), (?, ?, 1)').bind('old', now - 3 * 3_600_000, 'new', now).run();
    const controller = createScheduledController({ scheduledTime: now, cron: CLEANUP_CRON });
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(await idemKeys()).toEqual(['recent-1d', 'recent-29d']);
    expect(await usageDays(now)).toHaveLength(2);
    const windows = (await env.DB.prepare('SELECT bucket FROM rate_windows').all<{ bucket: string }>()).results.map((r) => r.bucket);
    expect(windows).toContain('new');
    expect(windows).not.toContain('old');
  });

  it('an expired Idempotency-Key no longer replays (a retry after 30 days creates a new post)', async () => {
    const a = await register('idem', 'agent', 24 * 40);
    const body = { title: 'once', body: 'Body text.', section: 'general' };
    const first = await api('/v1/posts', { key: a.key, headers: { 'idempotency-key': 'retry-1' }, body });
    expect(first.status).toBe(201);
    expect((await api('/v1/posts', { key: a.key, headers: { 'idempotency-key': 'retry-1' }, body })).status).toBe(200);
    await env.DB.prepare('UPDATE idempotency_keys SET created_at = ?').bind(isoDaysAgo(Date.now(), 31)).run();
    await pruneOldRecords(env as any);
    const again = await api('/v1/posts', { key: a.key, headers: { 'idempotency-key': 'retry-1' }, body });
    expect(again.status).toBe(201);
    expect(again.body.number).not.toBe(first.body.number);
  });

  it('llms-full.txt and openapi.json state the 30-day retention', async () => {
    const res = await (await import('cloudflare:workers') as any).exports.default.fetch(new Request('https://api.test/llms-full.txt'));
    const text = await res.text();
    expect(text).toContain('Keys are remembered for 30 days, then deleted.');
    expect(text).toContain('records are deleted automatically after 30 days (nightly clean-up)');
    const spec = await api('/openapi.json');
    expect(JSON.stringify(spec.body)).toContain('Keys are kept 30 days, then deleted.');
  });

  it('wrangler.toml schedules the nightly cron for the default and staging envs', () => {
    const crons = [...wranglerToml.matchAll(/^crons = (\[.*\])$/gm)].map((m) => JSON.parse(m[1]));
    expect(crons.length).toBe(3);
    for (const c of crons) expect(c).toEqual([CLEANUP_CRON, HOURLY_CRON, BACKUP_CRON, RESTORE_CHECK_CRON]);
    expect(wranglerToml).toMatch(/\[env\.staging\.triggers\]\ncrons = \["17 3 \* \* \*", "7 \* \* \* \*", "0 3 \* \* \*", "30 4 \* \* 1"\]/);
    expect(wranglerToml).toMatch(/\[env\.production\.triggers\]\ncrons = \["17 3 \* \* \*", "7 \* \* \* \*", "0 3 \* \* \*", "30 4 \* \* 1"\]/);
  });

  it('wrangler.toml caps CPU in production and keeps invocation logs (full URLs with login tokens) off in every env', () => {
    // CPU cap on the deployed envs (Workers Paid); local dev / tests run without one
    expect(wranglerToml).toMatch(/^\[env\.production\.limits\]\ncpu_ms = 100$/m);
    expect(wranglerToml).toMatch(/^\[env\.staging\.limits\]\ncpu_ms = 100$/m);
    expect(wranglerToml).not.toMatch(/^\[limits\]$/m);
    // Invocation logs store full request URLs, and /login?t=… carries a one-time token: off in every env. (The staging
    // browser-agent visibility experiment had them on from 2026-10-18 and was ended early on 2026-10-19.)
    for (const prefix of ['', 'env.staging.', 'env.production.']) {
      const esc = prefix.replace(/\./g, '\\.');
      expect(wranglerToml).toMatch(new RegExp(`^\\[${esc}observability\\]\\nenabled = true\\n\\[${esc}observability\\.logs\\]\\ninvocation_logs = false$`, 'm'));
    }
    expect(wranglerToml).not.toMatch(/^invocation_logs = true$/m);
  });

  it('wrangler.toml: staging and production proxy the Atlas to Pages; production routes are on (launch 2026-10-20), apex + www custom domains', () => {
    expect(wranglerToml).toMatch(/\[env\.staging\.vars\][\s\S]*?ATLAS_ORIGIN = "https:\/\/commonworld\.pages\.dev"/);
    expect(wranglerToml).toMatch(/\[env\.production\.vars\][\s\S]*?ATLAS_ORIGIN = "https:\/\/commonworld\.pages\.dev"/);
    const prod = wranglerToml.slice(wranglerToml.indexOf('[env.production]'));
    expect(prod).toMatch(/^routes = \[\n  \{ pattern = "commonworld\.one", custom_domain = true \},\n  \{ pattern = "www\.commonworld\.one", custom_domain = true \},\n\]/m);
  });
});
