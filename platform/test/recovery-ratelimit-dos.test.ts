/**
 * Denial of recovery (defensive verification 2026-10-28): requests with an INVALID claim token or recovery code,
 * sent by someone who is not the owner, must not use up the legitimate owner's recovery quota.
 *   - check/claim: the per-request bucket recovery-claim:{number} is charged only for a valid claim token;
 *     invalid tokens are charged to the sender's network (recovery_claim_ip).
 *   - start: a bad recovery code never touches the per-account day bucket; proof requests are capped per account and
 *     client network (3/day) under a higher per-account ceiling (20/day), so one network cannot lock the owner out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, register, resetDb } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const ip = (n: number) => ({ 'cf-connecting-ip': `203.0.113.${n}` });
const randomClaim = () => 'cwc_' + Array.from({ length: 43 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)]).join('');

describe('denial of recovery', () => {
  it('invalid claim tokens from other networks do not use up the owner\'s check/claim quota', async () => {
    const owner = await register('victim-claim', 'agent', 24 * 30);
    const code = (await api('/v1/me/recovery-code', { key: owner.key, method: 'POST' })).body.recovery_code.value;
    const start = await api('/v1/recovery', { body: { handle: owner.handle, method: 'code', recovery_code: code }, headers: ip(1) });
    expect(start.status).toBe(201);
    const n = start.body.request.number as number;
    // attacker: 10 guesses from 10 different networks (request numbers are sequential and public-ish)
    for (let i = 0; i < 10; i++) {
      const r = await api(`/v1/recovery/${n}/check`, { body: { claim_token: randomClaim() }, headers: ip(100 + i) });
      expect(r.status).toBe(403);
    }
    // the owner, from their own network, with the real token
    const mine = await api(`/v1/recovery/${n}/check`, { body: { claim_token: start.body.claim_token }, headers: ip(1) });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.status).toBe('verified');
  });

  it('invalid claim tokens are limited per client network', async () => {
    const owner = await register('victim-claim2', 'agent', 24 * 30);
    const code = (await api('/v1/me/recovery-code', { key: owner.key, method: 'POST' })).body.recovery_code.value;
    const n = (await api('/v1/recovery', { body: { handle: owner.handle, method: 'code', recovery_code: code }, headers: ip(1) })).body.request.number;
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await api(`/v1/recovery/${n}/claim`, { body: { claim_token: randomClaim() }, headers: ip(50) })).status;
    expect(last).toBe(429);
    const r = await api(`/v1/recovery/${n}/claim`, { body: { claim_token: randomClaim() }, headers: ip(50) });
    expect(r.body.error.scope).toBe('recovery_claim_ip');
  });

  it('bad recovery codes for someone else\'s handle do not block the owner\'s valid code', async () => {
    const owner = await register('victim-start', 'agent', 24 * 30);
    const code = (await api('/v1/me/recovery-code', { key: owner.key, method: 'POST' })).body.recovery_code.value;
    const bad = { handle: owner.handle, method: 'code', recovery_code: 'cwr_' + 'x'.repeat(43) };
    for (let i = 0; i < 3; i++) expect((await api('/v1/recovery', { body: bad, headers: ip(7) })).status).toBe(403);
    // 4th from the attacker's network: still a plain refusal, nothing account-wide
    expect((await api('/v1/recovery', { body: bad, headers: ip(7) })).status).toBe(403);
    const mine = await api('/v1/recovery', { body: { handle: owner.handle, method: 'code', recovery_code: code }, headers: ip(8) });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.request.status).toBe('verified');
  });

  it('proof requests from one network cannot lock the owner out; a per-account ceiling still holds', async () => {
    const owner = await register('victim-proof', 'agent', 24 * 30);
    const { env } = await import('cloudflare:workers');
    await env.DB.prepare("INSERT INTO linked_identities (account_id, provider, subject, challenge, status, created_at, verified_at) VALUES (?, 'github', 'victim-gh', 'x', 'verified', ?, ?)")
      .bind(owner.id, new Date().toISOString(), new Date().toISOString()).run();
    const proof = { handle: owner.handle, method: 'proof' };
    for (let i = 0; i < 3; i++) expect((await api('/v1/recovery', { body: proof, headers: ip(9) })).status).toBe(201);
    const capped = await api('/v1/recovery', { body: proof, headers: ip(9) });
    expect(capped.status).toBe(429);
    expect(capped.body.error.scope).toBe('recovery_account_network');
    // the owner on another network still gets a challenge
    expect((await api('/v1/recovery', { body: proof, headers: ip(10) })).status).toBe(201);
    // ceiling: 20 per account per day across networks
    let status = 0;
    for (let k = 0; k < 6; k++) for (let i = 0; i < 3; i++) status = (await api('/v1/recovery', { body: proof, headers: ip(20 + k) })).status;
    expect(status).toBe(429);
    const over = await api('/v1/recovery', { body: proof, headers: ip(40) });
    expect(over.body.error.scope).toBe('recovery_account');
  });
  it('proof requests do not use up the owner\'s daily budget for a valid recovery code', async () => {
    const owner = await register('victim-mixed', 'agent', 24 * 30);
    const code = (await api('/v1/me/recovery-code', { key: owner.key, method: 'POST' })).body.recovery_code.value;
    const { env } = await import('cloudflare:workers');
    await env.DB.prepare("INSERT INTO linked_identities (account_id, provider, subject, challenge, status, created_at, verified_at) VALUES (?, 'github', 'victim-mixed-gh', 'x', 'verified', ?, ?)")
      .bind(owner.id, new Date().toISOString(), new Date().toISOString()).run();
    // attacker: 3 unauthenticated proof requests from one network
    for (let i = 0; i < 3; i++) expect((await api('/v1/recovery', { body: { handle: owner.handle, method: 'proof' }, headers: ip(60) })).status).toBe(201);
    // the owner, from another network, with the valid code
    const mine = await api('/v1/recovery', { body: { handle: owner.handle, method: 'code', recovery_code: code }, headers: ip(61) });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(mine.body.request.status).toBe('verified');
  });
});
