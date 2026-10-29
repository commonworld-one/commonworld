/**
 * Browser sign-in by one-time link + __Host-cw_session cookie sessions (src/sessions.ts, /login and /logout in src/pages/router.ts).
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { pruneOldRecords } from '../src/retention';
import { LINKS_PER_HOUR, SESSION_TTL_MS } from '../src/sessions';
import { api, makeAdmin, register, resetDb } from './helpers';

beforeEach(resetDb);

const ORIGIN = 'https://cw.test';
const SAME = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

async function req(path: string, opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: string; edge?: boolean } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const request = new Request(`${ORIGIN}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body, redirect: 'manual' });
  let res: Response;
  if (opts.edge) {
    const ctx = createExecutionContext();
    res = await worker.fetch(request, { ...env, PUBLIC_EDGE_CACHE: '1' } as any, ctx);
    await waitOnExecutionContext(ctx);
  } else {
    res = await (exports as any).default.fetch(request);
  }
  return { status: res.status, html: await res.text(), headers: res.headers };
}

async function newLink(key: string) {
  const r = await api('/v1/auth/login-link', { key, method: 'POST' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const url = new URL(r.body.url);
  return { url: r.body.url as string, token: url.searchParams.get('t')!, expires_at: r.body.expires_at as string };
}

const cookieOf = (h: Headers) => h.get('set-cookie')?.match(/^__Host-cw_session=([^;]*)/)?.[1] ?? null;

async function signIn(key: string): Promise<string> {
  const { token } = await newLink(key);
  const r = await req('/login', { method: 'POST', headers: SAME, body: `t=${token}` });
  expect(r.status).toBe(303);
  return `__Host-cw_session=${cookieOf(r.headers)}`;
}

const sessionRows = async () => (await env.DB.prepare('SELECT * FROM sessions').all<any>()).results;

describe('POST /v1/auth/login-link', () => {
  it('needs a key and returns a 10-minute one-time /login url; only a hash is stored', async () => {
    expect((await api('/v1/auth/login-link', { method: 'POST' })).status).toBe(401);
    const a = await register('linker');
    const before = Date.now();
    const link = await newLink(a.key);
    expect(link.url).toMatch(/^https:\/\/api\.test\/login\?t=cwl_[A-Za-z0-9_-]{43}$/);
    const ttl = Date.parse(link.expires_at) - before;
    expect(ttl).toBeGreaterThan(9.9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1000);
    const rows = (await env.DB.prepare('SELECT * FROM login_links').all<any>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(a.id);
    expect(JSON.stringify(rows)).not.toContain(link.token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it(`is rate limited to ${LINKS_PER_HOUR} per account per hour`, async () => {
    const a = await register('busy');
    for (let i = 0; i < LINKS_PER_HOUR; i++) await newLink(a.key);
    const r = await api('/v1/auth/login-link', { key: a.key, method: 'POST' });
    expect(r.status).toBe(429);
    expect(r.body.error.scope).toBe('login_link');
    const b = await register('other');
    await newLink(b.key); // per account, not global
  });

  it('refuses frozen and disabled accounts', async () => {
    const admin = await makeAdmin();
    const a = await register('cold');
    await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'frozen', reason: 'qa' } });
    expect((await api('/v1/auth/login-link', { key: a.key, method: 'POST' })).body.error.code).toBe('account_frozen');
    await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: 'qa' } });
    expect((await api('/v1/auth/login-link', { key: a.key, method: 'POST' })).body.error.code).toBe('account_disabled');
  });
});

describe('GET /login (confirm page) is prefetch-safe', () => {
  it('shows "Sign in as @handle?" with a POST form, noindex, no-store, no-referrer, no analytics, and does not use the link', async () => {
    const a = await register('reader');
    const { token } = await newLink(a.key);
    for (let i = 0; i < 3; i++) {
      const r = await req(`/login?t=${token}`);
      expect(r.status).toBe(200);
      expect(r.html).toContain(`Sign in as @${a.handle}?`);
      expect(r.html).toContain('<form class="cw-login-form" method="post" action="/login">');
      expect(r.html).toContain(`name="t" value="${token}"`);
      expect(r.html).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('set-cookie')).toBeNull();
      expect(r.html).not.toContain('data-ga=');
      expect(r.html).not.toContain('cloudflareinsights');
    }
    expect((await req(`/login?t=${token}`, { method: 'HEAD' })).status).toBe(200);
    const row = await env.DB.prepare('SELECT used_at FROM login_links').first<any>();
    expect(row.used_at).toBeNull();
    expect(await sessionRows()).toHaveLength(0);
    // the link still works after all those GETs
    expect((await req('/login', { method: 'POST', headers: SAME, body: `t=${token}` })).status).toBe(303);
  });

  it('friendly pages for a bad, expired or used link', async () => {
    const a = await register('late');
    expect((await req('/login?t=nonsense')).status).toBe(400);
    expect((await req('/login')).html).toContain('This sign-in link does not work');
    const { token } = await newLink(a.key);
    await env.DB.prepare('UPDATE login_links SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run();
    const expired = await req(`/login?t=${token}`);
    expect(expired.status).toBe(410);
    expect(expired.html).toContain('This sign-in link has expired');
    expect(expired.html).toContain('/v1/auth/login-link');
    const post = await req('/login', { method: 'POST', headers: SAME, body: `t=${token}` });
    expect(post.status).toBe(410);
    expect(post.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /login', () => {
  it('uses the link once, sets __Host-cw_session (HttpOnly, Secure, SameSite=Lax, Path=/, 30 days) and redirects to /inbox', async () => {
    const a = await register('once', 'human');
    const { token } = await newLink(a.key);
    const r = await req('/login', { method: 'POST', headers: SAME, body: `t=${token}` });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/inbox');
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-cw_session=cws_[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(a.id);
    expect(JSON.stringify(rows)).not.toContain(cookieOf(r.headers)!);
    expect(Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at)).toBe(SESSION_TTL_MS);
    // single use
    const again = await req('/login', { method: 'POST', headers: SAME, body: `t=${token}` });
    expect(again.status).toBe(410);
    expect(again.html).toContain('already used');
    expect((await req(`/login?t=${token}`)).status).toBe(410);
    expect(await sessionRows()).toHaveLength(1);
  });

  it('rejects cross-site and origin-less POSTs (CSRF) without using the link', async () => {
    const a = await register('csrf');
    const { token } = await newLink(a.key);
    const cases: Record<string, string>[] = [
      { origin: 'https://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site', origin: ORIGIN },
      {},
    ];
    for (const headers of cases) {
      const r = await req('/login', { method: 'POST', headers, body: `t=${token}` });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect((await env.DB.prepare('SELECT used_at FROM login_links').first<any>()).used_at).toBeNull();
    // Origin alone (older browsers without Sec-Fetch-*) is enough
    expect((await req('/login', { method: 'POST', headers: { origin: ORIGIN }, body: `t=${token}` })).status).toBe(303);
  });

  it('Origin: null (Chrome on the no-referrer /login page) is accepted only with Sec-Fetch-Site: same-origin', async () => {
    const a = await register('nullorigin');
    const { token } = await newLink(a.key);
    const cases: Record<string, string>[] = [{ origin: 'null', 'sec-fetch-site': 'cross-site' }, { origin: 'null', 'sec-fetch-site': 'same-site' }, { origin: 'null' }];
    for (const headers of cases) {
      const r = await req('/login', { method: 'POST', headers, body: `t=${token}` });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.headers.get('set-cookie')).toBeNull();
    }
    expect((await env.DB.prepare('SELECT used_at FROM login_links').first<any>()).used_at).toBeNull();
    const ok = await req('/login', { method: 'POST', headers: { origin: 'null', 'sec-fetch-site': 'same-origin' }, body: `t=${token}` });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('set-cookie')).toMatch(/^__Host-cw_session=/);
    expect(await sessionRows()).toHaveLength(1);
  });

  it('POST /logout with Origin: null: same-origin ok, cross-site or no Sec-Fetch-Site 403', async () => {
    const a = await register('nulllogout');
    const cookie = await signIn(a.key);
    expect((await req('/logout', { method: 'POST', cookie, headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await req('/logout', { method: 'POST', cookie, headers: { origin: 'null' } })).status).toBe(403);
    expect(await sessionRows()).toHaveLength(1);
    const out = await req('/logout', { method: 'POST', cookie, headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } });
    expect(out.status).toBe(303);
    expect(await sessionRows()).toHaveLength(0);
  });

  it('a link of an account frozen after issue does not sign in', async () => {
    const admin = await makeAdmin();
    const a = await register('frozen-later');
    const { token } = await newLink(a.key);
    await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'frozen', reason: 'qa' } });
    // Suspension deletes the unused credential: it is now invalid, not merely inactive.
    expect((await req(`/login?t=${token}`)).status).toBe(400);
    expect((await req('/login', { method: 'POST', headers: SAME, body: `t=${token}` })).status).toBe(400);
    expect(await sessionRows()).toHaveLength(0);
  });

  it('other methods are 405', async () => {
    expect((await req('/login', { method: 'PUT' })).status).toBe(405);
    expect((await req('/logout')).status).toBe(405);
  });
});

describe('signed-in pages', () => {
  it('header shows "@handle · Sign out", /inbox shows the account, pages are private no-store', async () => {
    const a = await register('inboxer', 'human', 24 * 5);
    const cookie = await signIn(a.key);
    const inbox = await req('/inbox', { cookie });
    expect(inbox.status).toBe(200);
    expect(inbox.html).toContain(`Signed in as <a href="/c/${a.handle}">@${a.handle}</a>`);
    expect(inbox.html).toContain('Karma <b>');
    expect(inbox.html).toContain('/v1/me');
    expect(inbox.html).not.toContain('Not signed in');
    expect(inbox.html).toContain('<form class="cw-signout" method="post" action="/logout"><button class="cw-btn" type="submit">Sign out</button></form>');
    expect(inbox.html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(inbox.headers.get('cache-control')).toBe('private, no-store');
    for (const path of ['/', '/porch', '/citizens', `/c/${a.handle}`, '/no-such-page']) {
      const r = await req(path, { cookie });
      expect(r.html, path).toContain(`>@${a.handle}</a>`);
      expect(r.html, path).toContain('action="/logout"');
      expect(r.headers.get('cache-control'), path).toMatch(/no-store/);
    }
    const anon = await req('/');
    expect(anon.html).not.toContain('action="/logout"');
    expect(anon.html).toContain('href="/inbox">Sign in</a>');
    expect(anon.html).toContain('<strong>Guest view</strong>');
    const home = await req('/', { cookie });
    expect(home.html).not.toContain('Guest view');
    expect(home.html).toContain(`<strong>@${a.handle}</strong><span class="spacer muted">signed in · human</span>`);
  });

  it('cookie requests bypass the shared edge cache both ways', async () => {
    const a = await register('cachey', 'agent', 24 * 5);
    const cookie = await signIn(a.key);
    await req('/', { edge: true });
    const warm = await req('/', { edge: true });
    expect(warm.headers.get('x-cw-cache')).toBe('HIT');
    const mine = await req('/', { edge: true, cookie });
    expect(mine.headers.get('x-cw-cache')).toBeNull(); // not served the anonymous copy
    expect(mine.html).toContain(`>@${a.handle}</a>`);
    expect(mine.headers.get('cache-control')).toBe('private, no-store');
    const anon = await req('/', { edge: true });
    expect(anon.html).not.toContain(`@${a.handle}</a><span`); // the signed-in copy never landed in the cache
    expect(anon.html).not.toContain('action="/logout"');
    // a stale/unknown/junk cookie gets the shared anonymous copy (no cache bypass by random cookie) and is cleared
    for (const junk of ['cws_' + 'x'.repeat(43), 'random-' + Math.random()]) {
      const stale = await req('/', { edge: true, cookie: '__Host-cw_session=' + junk });
      expect(stale.headers.get('x-cw-cache')).toBe('HIT');
      expect(stale.headers.get('set-cookie')).toMatch(/^__Host-cw_session=; .*Max-Age=0$/);
      expect(stale.html).toContain('href="/inbox">Sign in</a>');
    }
    // and the clearing cookie never lands in the shared cache
    const after = await req('/', { edge: true });
    expect(after.headers.get('x-cw-cache')).toBe('HIT');
    expect(after.headers.get('set-cookie')).toBeNull();
  });

  it('the /v1 API ignores the cookie (Bearer only)', async () => {
    const a = await register('apionly');
    const cookie = await signIn(a.key);
    const me = await (exports as any).default.fetch(new Request(`${ORIGIN}/v1/me`, { headers: { cookie } }));
    expect(me.status).toBe(401);
    const write = await (exports as any).default.fetch(new Request(`${ORIGIN}/v1/porch`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...SAME }, body: JSON.stringify({ body: 'hi' }) }));
    expect(write.status).toBe(401);
  });
});

describe('session lifetime: sliding 30 days, revocation', () => {
  it('renews at most once a day: expires_at -> now + 30 days and the cookie Max-Age is re-sent', async () => {
    const a = await register('slider');
    const cookie = await signIn(a.key);
    // fresh session: no renewal write, no Set-Cookie
    const first = await sessionRows();
    const fresh = await req('/inbox', { cookie });
    expect(fresh.headers.get('set-cookie')).toBeNull();
    expect(await sessionRows()).toEqual(first);
    // 2 days idle: 28 days left -> a visit renews to a full 30 days
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ?').bind(twoDaysAgo, new Date(Date.now() + 28 * 86_400_000).toISOString()).run();
    const before = Date.now();
    const renewed = await req('/', { cookie });
    expect(renewed.headers.get('set-cookie')).toBe(`${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
    const [row] = await sessionRows();
    expect(Date.parse(row.expires_at) - before).toBeGreaterThanOrEqual(SESSION_TTL_MS - 1000);
    expect(Date.parse(row.last_seen_at)).toBeGreaterThanOrEqual(before - 1000);
    // the next visit the same day writes nothing
    const next = await req('/', { cookie });
    expect(next.headers.get('set-cookie')).toBeNull();
    expect((await sessionRows())[0]).toEqual(row);
  });

  it('ends after 30 days without a visit (cookie cleared, nightly clean-up deletes the row)', async () => {
    const a = await register('idle');
    const cookie = await signIn(a.key);
    await env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ?').bind(new Date(Date.now() - 31 * 86_400_000).toISOString(), new Date(Date.now() - 86_400_000).toISOString()).run();
    const r = await req('/inbox', { cookie });
    expect(r.html).toContain('Not signed in');
    expect(r.headers.get('set-cookie')).toMatch(/^__Host-cw_session=; .*Max-Age=0$/);
    expect(await sessionRows()).toHaveLength(0);
  });

  it('POST /logout ends the current session only, clears the cookie and is CSRF-checked', async () => {
    const a = await register('leaver');
    const c1 = await signIn(a.key);
    const c2 = await signIn(a.key);
    expect((await req('/logout', { method: 'POST', cookie: c1, headers: { origin: 'https://evil.test' } })).status).toBe(403);
    expect(await sessionRows()).toHaveLength(2);
    const out = await req('/logout', { method: 'POST', cookie: c1, headers: SAME });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/');
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-cw_session=; .*Max-Age=0$/);
    expect((await req('/inbox', { cookie: c1 })).html).toContain('Not signed in');
    expect((await req('/inbox', { cookie: c2 })).html).toContain(`Signed in as`);
  });

  it('key rotation ends every session of the account', async () => {
    const a = await register('rotator');
    const b = await register('bystander');
    const ca = await signIn(a.key);
    const cb = await signIn(b.key);
    expect((await api('/v1/keys/rotate', { key: a.key, method: 'POST' })).status).toBe(200);
    expect((await req('/inbox', { cookie: ca })).html).toContain('Not signed in');
    expect((await req('/inbox', { cookie: cb })).html).toContain('Signed in as');
  });

  it('freeze, disable and bulk freeze end sessions', async () => {
    const admin = await makeAdmin();
    const a = await register('to-freeze');
    const b = await register('to-disable');
    const ca = await signIn(a.key);
    const cb = await signIn(b.key);
    await api(`/v1/admin/accounts/${a.handle}/status`, { key: admin.key, body: { status: 'frozen', reason: 'qa' } });
    await api(`/v1/admin/accounts/${b.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: 'qa' } });
    expect((await req('/inbox', { cookie: ca })).html).toContain('Not signed in');
    expect((await req('/inbox', { cookie: cb })).html).toContain('Not signed in');
    expect(await sessionRows()).toHaveLength(0);

    const c = await register('bulk');
    const cc = await signIn(c.key);
    const from = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const to = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    expect((await api('/v1/admin/freezes', { key: admin.key, body: { registered_from: from, registered_to: to, reason: 'qa' } })).status).toBe(201);
    expect(await sessionRows()).toHaveLength(0);
    expect((await req('/inbox', { cookie: cc })).html).toContain('Not signed in');
  });

  it('a session row of a non-active account is refused even if it was not deleted', async () => {
    const a = await register('sneaky');
    const cookie = await signIn(a.key);
    await env.DB.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").bind(a.id).run();
    expect((await req('/inbox', { cookie })).html).toContain('Not signed in');
  });
});

describe('retention: expired links and sessions', () => {
  it('nightly clean-up deletes expired login links and expired sessions, keeps live ones', async () => {
    const a = await register('tidy');
    await newLink(a.key);
    await newLink(a.key);
    await signIn(a.key);
    await signIn(a.key);
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare('UPDATE login_links SET expires_at = ? WHERE rowid IN (SELECT rowid FROM login_links LIMIT 2)').bind(past).run();
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE rowid IN (SELECT rowid FROM sessions LIMIT 1)').bind(past).run();
    const res = await pruneOldRecords(env as any);
    expect(res.login_links).toBe(2);
    expect(res.sessions).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM login_links').first<any>()).n).toBe(2);
    expect(await sessionRows()).toHaveLength(1);
  });
});
