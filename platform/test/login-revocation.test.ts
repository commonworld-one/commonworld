/** Regression tests for unused browser credentials at every account revocation boundary. */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeLoginLink, createLoginLink, peekLoginLink } from '../src/sessions';
import { api, makeAdmin, register, resetDb } from './helpers';

beforeEach(resetDb);

async function mint(key: string) {
  const r = await api('/v1/auth/login-link', { key, method: 'POST' });
  expect(r.status).toBe(201);
  return new URL(r.body.url).searchParams.get('t')!;
}
async function login(token: string) {
  return (exports as any).default.fetch(new Request('https://cw.test/login', {
    method: 'POST', redirect: 'manual',
    headers: { origin: 'https://cw.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: token }).toString(),
  })) as Promise<Response>;
}
/** A revoked link is deleted, so POST /login answers exactly like an unknown link: 400 invalid, no cookie. */
async function rejects(token: string) {
  const r = await login(token);
  expect(r.status).toBe(400);
  expect(r.headers.get('set-cookie')).toBeNull();
}
const sessions = async (id: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?').bind(id).first<{ n: number }>())!.n;
const keyId = async (id: string) => (await env.DB.prepare('SELECT id FROM api_keys WHERE account_id = ? AND revoked_at IS NULL').bind(id).first<{ id: string }>())!.id;
async function rotate(key: string) {
  const r = await api('/v1/keys/rotate', { key, method: 'POST' });
  expect(r.status).toBe(200);
  return r.body.api_key.value as string;
}
async function status(adminKey: string, handle: string, value: string) {
  expect((await api(`/v1/admin/accounts/${handle}/status`, { key: adminKey, body: { status: value, reason: 'local regression test' } })).status).toBe(200);
}

/** Run an action immediately before a selected write, without replacing the underlying local D1 behavior. */
function intercept(before: (sql: string) => boolean, action: () => Promise<void>): D1Database {
  const db = env.DB;
  let armed = false;
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (!fired && before(sql)) armed = true;
        return new Proxy(statement, {
          get(s, p) {
            if (p === 'bind') return (...values: unknown[]) => {
              const bound = s.bind(...values);
              return new Proxy(bound, {
                get(b, method) {
                  if (method === 'run') return async () => {
                    if (armed && !fired) { armed = false; fired = true; await action(); }
                    return b.run();
                  };
                  const value = (b as any)[method];
                  return typeof value === 'function' ? value.bind(b) : value;
                },
              });
            };
            const value = (s as any)[p];
            return typeof value === 'function' ? value.bind(s) : value;
          },
        });
      };
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (armed && !fired) { armed = false; fired = true; await action(); }
        return target.batch(statements);
      };
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('browser credential revocation', () => {
  it('rotation revokes every unused link and existing session; fresh credentials still work', async () => {
    const a = await register('rotation');
    const first = await mint(a.key), second = await mint(a.key), used = await mint(a.key);
    expect((await login(used)).status).toBe(303);
    expect(await sessions(a.id)).toBe(1);
    const next = await rotate(a.key);
    expect((await api('/v1/me', { key: a.key })).status).toBe(401);
    await rejects(first); await rejects(second);
    expect(await sessions(a.id)).toBe(0);
    expect((await login(await mint(next))).status).toBe(303);
    expect(await sessions(a.id)).toBe(1);
  });

  it.each(['frozen', 'disabled'])('%s and reactivation do not restore old links', async (value) => {
    const admin = await makeAdmin(), a = await register('suspended');
    const token = await mint(a.key);
    await status(admin.key, a.handle, value);
    await rejects(token);
    await status(admin.key, a.handle, 'active');
    await rejects(token);
    expect(await sessions(a.id)).toBe(0);
    expect((await login(await mint(a.key))).status).toBe(303);
  });

  it('bulk freeze/revert revokes target links, but leaves skipped staff and trusted links alone', async () => {
    const admin = await makeAdmin(), a = await register('bulk-target'), trusted = await register('bulk-trusted');
    await env.DB.prepare('UPDATE accounts SET trusted = 1 WHERE id = ?').bind(trusted.id).run();
    const token = await mint(a.key), adminToken = await mint(admin.key), trustedToken = await mint(trusted.key);
    const freeze = await api('/v1/admin/freezes', { key: admin.key, body: { registered_from: '2020-01-01T00:00:00Z', registered_to: '2100-01-01T00:00:00Z', reason: 'local regression test' } });
    expect(freeze.status).toBe(201);
    expect(freeze.body.affected_count).toBe(1);
    const revert = await api(`/v1/admin/freezes/${freeze.body.id}/revert`, { key: admin.key, method: 'POST' });
    expect(revert.status).toBe(200);
    await rejects(token); expect(await sessions(a.id)).toBe(0);
    expect((await login(adminToken)).status).toBe(303);
    expect((await login(trustedToken)).status).toBe(303);
  });

  it('approved recovery revokes old links; the claimed replacement key can mint a new one', async () => {
    const admin = await makeAdmin(), a = await register('recovered');
    const token = await mint(a.key);
    const code = (await api('/v1/me/recovery-code', { key: a.key, method: 'POST' })).body.recovery_code.value;
    const start = await api('/v1/recovery', { body: { handle: a.handle, method: 'code', recovery_code: code } });
    expect(start.status).toBe(201);
    const approved = await api(`/v1/admin/recovery/${start.body.request.number}/approve`, { key: admin.key, body: { note: 'local regression test' } });
    expect(approved.status).toBe(200);
    await rejects(token); expect(await sessions(a.id)).toBe(0);
    const claim = await api(`/v1/recovery/${start.body.request.number}/claim`, { body: { claim_token: start.body.claim_token } });
    expect(claim.status).toBe(200);
    expect((await login(await mint(claim.body.api_key.value))).status).toBe(303);
  });

  it('rotation does not revoke another account links', async () => {
    const a = await register('rotating'), b = await register('unaffected');
    const token = await mint(b.key);
    await rotate(a.key);
    expect((await login(token)).status).toBe(303);
  });

  it('a request with an already-authenticated old key cannot mint after rotation', async () => {
    const a = await register('mint-race'), id = await keyId(a.id);
    const db = intercept(sql => sql.startsWith('INSERT INTO login_links'), async () => { await rotate(a.key); });
    await expect(createLoginLink({ ...env, DB: db } as any, a.id, Date.now(), id)).rejects.toMatchObject({ status: 401 });
    expect(await sessions(a.id)).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM login_links WHERE account_id = ?').bind(a.id).first<{ n: number }>())!.n).toBe(0);
  });

  it('a link read before rotation cannot create a session after its revocation', async () => {
    const a = await register('consume-race'), token = await mint(a.key);
    const db = intercept(sql => sql.startsWith('UPDATE login_links'), async () => { await rotate(a.key); });
    const result = await consumeLoginLink({ ...env, DB: db } as any, token);
    expect(result.ok).toBe(false);
    expect(await sessions(a.id)).toBe(0);
  });

  it('suspension between credential lookup and mint prevents a new link', async () => {
    const admin = await makeAdmin(), a = await register('suspend-mint'), id = await keyId(a.id);
    const db = intercept(sql => sql.startsWith('INSERT INTO login_links'), async () => { await status(admin.key, a.handle, 'frozen'); });
    await expect(createLoginLink({ ...env, DB: db } as any, a.id, Date.now(), id)).rejects.toMatchObject({ status: 401 });
    expect(await sessions(a.id)).toBe(0);
  });

  it('suspension after link lookup cannot leave a new session', async () => {
    const admin = await makeAdmin(), a = await register('suspend-consume'), token = await mint(a.key);
    const db = intercept(sql => sql.startsWith('UPDATE login_links'), async () => { await status(admin.key, a.handle, 'frozen'); });
    expect((await consumeLoginLink({ ...env, DB: db } as any, token)).ok).toBe(false);
    expect(await sessions(a.id)).toBe(0);
  });

  it('two competing consumes create only one session', async () => {
    const a = await register('single-use'), token = await mint(a.key);
    const result = await Promise.all([consumeLoginLink(env as any, token), consumeLoginLink(env as any, token)]);
    expect(result.filter(r => r.ok)).toHaveLength(1);
    expect(await sessions(a.id)).toBe(1);
  });

  it('a failed session insert rolls back consumption and leaves the valid link usable', async () => {
    const a = await register('rollback'), token = await mint(a.key);
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'batch') return (statements: D1PreparedStatement[]) => target.batch([
          statements[0], target.prepare('INSERT INTO sessions (id) VALUES (NULL)'),
        ]);
        const value = (target as any)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(consumeLoginLink({ ...env, DB: db } as any, token)).rejects.toThrow();
    expect(await peekLoginLink(env as any, token)).toMatchObject({ ok: true });
    expect(await sessions(a.id)).toBe(0);
    expect((await login(token)).status).toBe(303);
  });
});
