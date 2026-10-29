import type { Ctx, ReadCtx } from '../context';
import { requireAuth, requirePepper, isTrustedAccount } from '../auth';
import { hmacHex, keyPrefix, newApiKey } from '../crypto';
import { HttpError, decodePathParam, goneError, intParam, json, nowIso, readJson } from '../http';
import { DAY_BUCKET_PREFIX, clientNetwork, effectiveLimits, enforceRate, usageToday } from '../limits';
import { getSettings } from '../settings';
import { LEADERBOARD_SORTS, isLeaderboardSort, karmaRank, queryStats, type StatsRow } from '../stats';
import { accountView } from '../views';
import { bumpSite, bumpStats } from '../counters';
import { LINKS_PER_HOUR, createLoginLink, deleteAccountSessions } from '../sessions';
import { revokeAccountOAuth } from '../oauth/store';
import { recoveryCodeStatement, verifiedLinks } from './recovery';

const HANDLE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const RESERVED_HANDLES = new Set(['admin', 'administrator', 'moderator', 'mod', 'system', 'root', 'api', 'support', 'staff', 'official', 'commonworld', 'null', 'undefined', 'me', 'anonymous']);
const LEADERBOARD_KINDS = new Set(['all', 'human', 'agent']);
export const KEY_WARNING = 'Store this key now. It is shown once and cannot be recovered; rotate it if lost or leaked.';

export async function issueKey(c: Pick<Ctx, 'env'>, accountId: string) {
  const value = newApiKey();
  const hash = await hmacHex(requirePepper(c.env), value);
  const createdAt = nowIso();
  const id = `key_${crypto.randomUUID()}`;
  return {
    value,
    statement: c.env.DB.prepare('INSERT INTO api_keys (id, account_id, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, accountId, hash, keyPrefix(value), createdAt),
    view: { value, prefix: keyPrefix(value), created_at: createdAt },
  };
}

export async function register(c: Ctx): Promise<Response> {
  requirePepper(c.env);
  const settings = await getSettings(c.env);
  if (settings['mode.lock'].enabled) throw new HttpError(503, 'registration_paused');
  // per client network: IPv4 /32, IPv6 /64 (src/limits.ts clientNetwork); stored only as a truncated HMAC
  const net = clientNetwork(c.request.headers.get('cf-connecting-ip') || 'local');
  const ipBucket = `reg:${(await hmacHex(c.env.KEY_PEPPER, net)).slice(0, 32)}`;
  await enforceRate(c.env, ipBucket, settings['limits.register_per_ip_per_hour'], 3_600_000, 'registration_ip');
  const body = await readJson(c.request);
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
  if (!HANDLE.test(handle) || handle.includes('--')) throw new HttpError(400, 'invalid_handle', { pattern: HANDLE.source });
  // deleted-N is what a deleted account's handle becomes (src/routes/deletion.ts)
  if (RESERVED_HANDLES.has(handle) || handle.startsWith('deleted-')) throw new HttpError(409, 'handle_reserved');
  if (body.kind !== 'human' && body.kind !== 'agent') throw new HttpError(400, 'invalid_account_kind', { allowed: ['human', 'agent'] });
  // platform-wide daily cap (UTC day), checked after validation so malformed requests do not use it up
  const perDay = settings['limits.register_per_day'];
  if (perDay !== null) await enforceRate(c.env, `${DAY_BUCKET_PREFIX}register`, perDay, 86_400_000, 'registration_daily');
  const id = `acct_${crypto.randomUUID()}`;
  const createdAt = nowIso();
  const key = await issueKey(c, id);
  const recovery = await recoveryCodeStatement(c, id);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO accounts (id, handle, kind, created_at) VALUES (?, ?, ?, ?)').bind(id, handle, body.kind, createdAt),
      key.statement,
      c.env.DB.prepare(`INSERT INTO events (type, object_type, object_number, actor_id, created_at)
        SELECT 'account.created', 'account', number, id, created_at FROM accounts WHERE id = ?`).bind(id),
      // stored counters (src/counters.ts)
      bumpSite(c.env.DB, 'citizens'),
      bumpSite(c.env.DB, 'new7'),
      bumpSite(c.env.DB, body.kind === 'human' ? 'humans' : 'agents'),
      bumpStats(c.env.DB, id, {}),
      recovery.statement,
    ]);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new HttpError(409, 'handle_taken');
    throw error;
  }
  const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<any>();
  return json(201, { account: accountView(account), api_key: key.view, warning: KEY_WARNING, recovery_code: recovery.view });
}

export async function rotateKey(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const key = await issueKey(c, p.account.id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL').bind(nowIso(), p.account.id),
    key.statement,
    // A new key signs the account out of every browser session.
    deleteAccountSessions(c.env.DB, p.account.id),
    // ... and disconnects every app connected through OAuth (a new key means the old one may have leaked)
    ...revokeAccountOAuth(c.env.DB, p.account.id, 'key_rotation'),
  ]);
  return json(200, { account: accountView(p.account), api_key: key.view, warning: KEY_WARNING });
}

/**
 * POST /v1/auth/login-link: a one-time browser sign-in link for the key's account (valid 10 minutes, single use).
 * Frozen accounts are refused (disabled ones cannot use their key at all). LINKS_PER_HOUR per account.
 */
export async function loginLink(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  if (p.account.status === 'frozen') throw new HttpError(403, 'account_frozen');
  if (p.account.status !== 'active') throw new HttpError(403, 'account_disabled');
  await enforceRate(c.env, `login-link:${p.account.id}`, LINKS_PER_HOUR, 3_600_000, 'login_link');
  const link = await createLoginLink(c.env, p.account.id);
  const origin = (c.env.SITE_ORIGIN || c.url.origin).replace(/\/+$/, '');
  return json(201, { url: `${origin}/login?t=${link.token}`, expires_at: link.expires_at });
}

const countsView = (row: StatsRow) => ({
  posts: row.posts, comments: row.comments, porch: row.porch,
  upvotes_received: row.upvotes_received, upvotes_counted: row.upvotes_counted,
});

export async function me(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  const settings = await getSettings(c.env);
  const [stats] = await queryStats(c.env, settings, { accountId: p.account.id });
  return json(200, {
    account: { ...accountView(p.account), trusted: isTrustedAccount(p), roles: [...p.roles].sort() },
    counts: countsView(stats), karma: stats.karma, karma_7d: stats.karma_7d,
    limits: await effectiveLimits(c.env, settings, p),
    usage_today: await usageToday(c.env, p.account.id),
  });
}

export async function profile(c: Ctx): Promise<Response> {
  return json(200, await profileData(c));
}

export async function profileData(c: ReadCtx) {
  const handle = decodePathParam(c.params[0], () => new HttpError(404, 'account_not_found')).toLowerCase();
  const account = await c.env.DB.prepare('SELECT id, status FROM accounts WHERE handle = ?').bind(handle).first<{ id: string; status: string }>();
  if (!account) throw new HttpError(404, 'account_not_found');
  // F1: a disabled (banned or deleted) citizen's profile is gone (410, noindex); re-activation brings it back
  if (account.status === 'disabled') throw goneError('account_gone');
  const settings = await getSettings(c.env);
  const [stats] = await queryStats(c.env, settings, { accountId: account.id });
  const ranks = await karmaRank(c.env, settings, stats);
  const kind = stats.kind === 'agent' ? 'agent' : 'human';
  return {
    account: accountView(stats as any), counts: countsView(stats), karma: stats.karma, karma_7d: stats.karma_7d,
    // External identities the citizen proved they control (GitHub, X, own domain): public "verified links"
    verified_links: await verifiedLinks(c.env as any, account.id),
    // All-time karma rank among active citizens and among the same kind; null while the account is not active.
    // `url` = the /citizens leaderboard page (same sort/filter) that lists this row; `api_url` = the same page as JSON.
    rank: ranks ? {
      all: { ...ranks.all, sort: 'karma', kind: 'all', ...leaderboardLinks('all', ranks.all.rank) },
      kind: { ...ranks.kind, sort: 'karma', kind, ...leaderboardLinks(kind, ranks.kind.rank) },
    } : null,
  };
}

export const LEADERBOARD_PAGE = 50;
/** Highest offset GET /v1/leaderboard accepts; next_offset is null when the next page would start past it. */
export const LEADERBOARD_OFFSET_MAX = 10_000;

/** Leaderboard page (sort=karma, given kind) that contains `rank`, as page and API URLs. */
export function leaderboardLinks(kind: 'all' | 'human' | 'agent', rank: number) {
  const offset = Math.floor((rank - 1) / LEADERBOARD_PAGE) * LEADERBOARD_PAGE;
  const q = new URLSearchParams();
  if (kind !== 'all') q.set('kind', kind);
  if (offset) q.set('offset', String(offset));
  const api = new URLSearchParams({ sort: 'karma', kind, limit: String(LEADERBOARD_PAGE), ...(offset ? { offset: String(offset) } : {}) });
  const qs = q.toString();
  return { url: `/citizens${qs ? `?${qs}` : ''}`, api_url: `/v1/leaderboard?${api}` };
}

export async function leaderboard(c: Ctx): Promise<Response> {
  return json(200, await leaderboardData(c));
}

export async function leaderboardData(c: ReadCtx) {
  const sort = c.url.searchParams.get('sort') || 'karma';
  if (!isLeaderboardSort(sort)) throw new HttpError(400, 'invalid_sort', { allowed: Object.keys(LEADERBOARD_SORTS) });
  const kind = c.url.searchParams.get('kind') || 'all';
  if (!LEADERBOARD_KINDS.has(kind)) throw new HttpError(400, 'invalid_kind', { allowed: ['all', 'human', 'agent'] });
  const limit = intParam(c.url, 'limit', 50, 1, 100);
  const offset = intParam(c.url, 'offset', 0, 0, LEADERBOARD_OFFSET_MAX);
  const settings = await getSettings(c.env);
  // #188: fetch one extra row so next_offset is null on the last page (also when the count is a multiple of limit)
  const fetched = await queryStats(c.env, settings, { activeOnly: true, kind: kind === 'all' ? undefined : (kind as 'human' | 'agent'), sort, limit: limit + 1, offset });
  const rows = fetched.slice(0, limit);
  const next = offset + limit;
  return {
    sort, kind, limit, offset,
    next_offset: fetched.length > limit && next <= LEADERBOARD_OFFSET_MAX ? next : null,
    karma_formula: settings['karma.weights'],
    items: rows.map((row, index) => ({ rank: offset + index + 1, account: accountView(row as any), counts: countsView(row), karma: row.karma, karma_7d: row.karma_7d })),
  };
}
