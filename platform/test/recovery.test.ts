/**
 * Linked identities (GitHub, X, own domain) and lost-key recovery (src/recovery.ts, src/routes/recovery.ts).
 * External sources are mocked through globalThis.fetch.
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, makeAdmin, register, resetDb } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

/** Fake public web: url prefix -> body (string or object as JSON). */
function web(pages: Record<string, unknown>) {
  const calls: string[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.startsWith('https://api.test') || u.startsWith('https://cw.test')) return real(input as any, init);
    calls.push(u);
    const hit = Object.keys(pages).find((k) => u.startsWith(k));
    if (!hit) return new Response('not found', { status: 404 });
    const v = pages[hit];
    return new Response(typeof v === 'string' ? v : JSON.stringify(v));
  }) as typeof fetch);
  return calls;
}

async function link(key: string, provider: string, subject: string) {
  const r = await api('/v1/me/identities', { key, body: { provider, subject } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: number; challenge: string; instructions: string };
}

describe('linked identities', () => {
  it('GitHub bio: challenge tied to the citizen number, verify reads the bio, profile shows the verified link', async () => {
    const a = await register('linker', 'agent', 24 * 30);
    const l = await link(a.key, 'github', '@Linker-GH');
    expect(l.challenge).toMatch(new RegExp(`^cw-citizen-${a.number}-[a-z2-9]{10}$`));
    expect(l.instructions).toContain('GitHub bio');
    web({ 'https://api.github.com/users/linker-gh/gists': [], 'https://api.github.com/users/linker-gh': { bio: 'hello' } });
    const miss = await api(`/v1/me/identities/${l.id}/verify`, { key: a.key, method: 'POST' });
    expect(miss.status).toBe(422);
    expect(miss.body.error.code).toBe('proof_not_found');
    vi.restoreAllMocks();
    web({ 'https://api.github.com/users/linker-gh': { bio: `I am on Commonworld ${l.challenge}` } });
    const ok = await api(`/v1/me/identities/${l.id}/verify`, { key: a.key, method: 'POST' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'verified', method: 'bio', proof_url: 'https://github.com/linker-gh', provider: 'github', subject: 'linker-gh' });
    expect(ok.body.challenge).toBeUndefined();
    const prof = await api(`/v1/accounts/${a.handle}`);
    expect(prof.body.verified_links).toEqual([expect.objectContaining({ provider: 'github', subject: 'linker-gh', url: 'https://github.com/linker-gh' })]);
    const page = await (exports as any).default.fetch(new Request(`https://cw.test/c/${a.handle}`));
    expect(await page.text()).toContain('✓ GitHub: linker-gh');
  });

  it('GitHub gist, X bio via FxTwitter, domain via DNS TXT and via .well-known', async () => {
    const a = await register('multi', 'human', 24 * 30);
    const gh = await link(a.key, 'github', 'gister');
    const xx = await link(a.key, 'x', '@Multi_X');
    const d1 = await link(a.key, 'domain', 'https://Example.org/path');
    const d2 = await link(a.key, 'domain', 'second.example');
    const calls = web({
      'https://api.github.com/users/gister/gists': [{ description: 'notes', html_url: 'https://gist.github.com/gister/1', files: { 'a.txt': { raw_url: 'https://gist.githubusercontent.com/gister/1/raw/a.txt', size: 40 } } }],
      'https://gist.githubusercontent.com/gister/1/raw/a.txt': `proof: ${gh.challenge}`,
      'https://api.github.com/users/gister': { bio: null },
      'https://api.fxtwitter.com/multi_x': { user: { description: `bio ${xx.challenge}` } },
      'https://cloudflare-dns.com/dns-query?name=_commonworld.example.org': { Answer: [{ data: `"${d1.challenge}"` }] },
      'https://second.example/.well-known/commonworld-proof.txt': `${d2.challenge}\n`,
    });
    const v = async (id: number) => (await api(`/v1/me/identities/${id}/verify`, { key: a.key, method: 'POST' })).body;
    expect(await v(gh.id)).toMatchObject({ status: 'verified', method: 'gist', proof_url: 'https://gist.github.com/gister/1' });
    expect(await v(xx.id)).toMatchObject({ status: 'verified', method: 'bio', subject: 'multi_x', proof_url: 'https://x.com/multi_x' });
    expect(await v(d1.id)).toMatchObject({ status: 'verified', method: 'dns', subject: 'example.org' });
    expect(await v(d2.id)).toMatchObject({ status: 'verified', method: 'well-known', proof_url: 'https://second.example/.well-known/commonworld-proof.txt' });
    expect(calls.some((u) => u.startsWith('https://api.fxtwitter.com/'))).toBe(true);
  });

  it('validation: bad provider/subject, own domains refused, one identity proves one account, remove unlinks', async () => {
    const a = await register('one', 'agent', 24 * 30);
    const b = await register('two', 'agent', 24 * 30);
    expect((await api('/v1/me/identities', { key: a.key, body: { provider: 'mastodon', subject: 'x' } })).body.error.code).toBe('invalid_provider');
    for (const [provider, subject] of [['github', '-bad-'], ['x', 'way_too_long_handle_123'], ['domain', 'localhost'], ['domain', 'staging.commonworld.one'], ['domain', '10.0.0.1']]) {
      expect((await api('/v1/me/identities', { key: a.key, body: { provider, subject } })).status, `${provider} ${subject}`).toBe(400);
    }
    expect((await api('/v1/me/identities', { body: { provider: 'x', subject: 'abc' } })).status).toBe(401);
    const la = await link(a.key, 'x', 'shared');
    web({ 'https://api.fxtwitter.com/shared': { user: { description: la.challenge } } });
    expect((await api(`/v1/me/identities/${la.id}/verify`, { key: a.key, method: 'POST' })).status).toBe(200);
    expect((await api('/v1/me/identities', { key: b.key, body: { provider: 'x', subject: 'shared' } })).body.error.code).toBe('identity_taken');
    expect((await api(`/v1/me/identities/${la.id}/verify`, { key: b.key, method: 'POST' })).status).toBe(404);
    expect((await api(`/v1/me/identities/${la.id}/remove`, { key: a.key, method: 'POST' })).body.status).toBe('removed');
    expect((await api(`/v1/accounts/${a.handle}`)).body.verified_links).toEqual([]);
    expect((await api('/v1/me/identities', { key: a.key })).body.items).toEqual([]);
  });
});

describe('recovery code', () => {
  it('registration returns it once; only a hash is stored; a new one replaces it', async () => {
    const r = await api('/v1/accounts', { body: { handle: 'coder', kind: 'agent' } });
    const code = r.body.recovery_code.value as string;
    expect(code).toMatch(/^cwr_[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare('SELECT * FROM recovery_codes').first<any>();
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
    const fresh = await api('/v1/me/recovery-code', { key: r.body.api_key.value, method: 'POST' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.recovery_code.value).not.toBe(code);
    expect((await api('/v1/recovery', { body: { handle: 'coder', method: 'code', recovery_code: code } })).status).toBe(403);
  });
});

async function approve(adminKey: string, n: number, note = 'checked the proof') {
  return api(`/v1/admin/recovery/${n}/approve`, { key: adminKey, body: { note } });
}

describe('lost-key recovery', () => {
  it('with the recovery code: verified at once -> admin approves (old key + sessions revoked, public log) -> new key claimed once', async () => {
    const admin = await makeAdmin();
    const reg = await api('/v1/accounts', { body: { handle: 'lost-one', kind: 'human' } });
    const oldKey = reg.body.api_key.value as string;
    const start = await api('/v1/recovery', { body: { handle: 'lost-one', method: 'code', recovery_code: reg.body.recovery_code.value } });
    expect(start.status).toBe(201);
    expect(start.body.request.status).toBe('verified');
    const claim = start.body.claim_token as string;
    expect(claim).toMatch(/^cwc_/);
    const n = start.body.request.number;
    // the code works once
    expect((await api('/v1/recovery', { body: { handle: 'lost-one', method: 'code', recovery_code: reg.body.recovery_code.value } })).status).toBe(403);
    // not approved yet
    const early = await api(`/v1/recovery/${n}/claim`, { body: { claim_token: claim } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('recovery_not_approved');
    // a moderator cannot approve; an admin can
    const list = await api('/v1/admin/recovery?status=verified', { key: admin.key });
    expect(list.body.items[0]).toMatchObject({ ref: `recovery-${n}`, method: 'code', proof: 'recovery code', account: { handle: 'lost-one' } });
    expect(JSON.stringify(list.body)).not.toMatch(/cwc_|cwr_|claim/);
    const ok = await approve(admin.key, n, 'Recovery code used; owner confirmed by email.');
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await api('/v1/me', { key: oldKey })).status).toBe(401);
    // wrong claim token, then the right one
    expect((await api(`/v1/recovery/${n}/claim`, { body: { claim_token: 'cwc_' + 'A'.repeat(43) } })).status).toBe(403);
    const got = await api(`/v1/recovery/${n}/claim`, { body: { claim_token: claim } });
    expect(got.status).toBe(200);
    expect(got.body.handle).toBe('lost-one');
    const me = await api('/v1/me', { key: got.body.api_key.value });
    expect(me.status).toBe(200);
    expect((await api(`/v1/recovery/${n}/claim`, { body: { claim_token: claim } })).status).toBe(409);
    // public record without secrets
    const log = await api('/v1/moderation');
    const entry = log.body.items.find((x: any) => x.type === 'account.recovered');
    expect(entry).toMatchObject({ note: 'Recovery code used; owner confirmed by email.', recovery: { request: `recovery-${n}`, method: 'code', proof: 'recovery_code' }, object: { type: 'account', ref: expect.stringMatching(/^citizen-\d+$/) } });
    expect(entry.moderator.handle).toBe(admin.handle);
    expect(log.body.counts.recoveries).toBe(1);
    expect(JSON.stringify(log.body)).not.toMatch(/cwc_|cwr_|cw1_/);
    const page = await (exports as any).default.fetch(new Request('https://cw.test/moderation'));
    expect(await page.text()).toContain('recovery-' + n);
  });

  it('with a verified link: challenge -> check finds it (auto-verify) -> approve -> claim', async () => {
    const admin = await makeAdmin();
    const a = await register('linked', 'agent', 24 * 30);
    const l = await link(a.key, 'github', 'linked-gh');
    web({ 'https://api.github.com/users/linked-gh': { bio: l.challenge } });
    await api(`/v1/me/identities/${l.id}/verify`, { key: a.key, method: 'POST' });
    vi.restoreAllMocks();
    const start = await api('/v1/recovery', { body: { handle: a.handle, method: 'proof' } });
    expect(start.status).toBe(201);
    const { number: n, challenge, post_it_on } = start.body.request;
    expect(challenge).toMatch(new RegExp(`^cw-citizen-${a.number}-`));
    expect(post_it_on[0]).toMatchObject({ provider: 'github', subject: 'linked-gh' });
    const claim = start.body.claim_token;
    web({ 'https://api.github.com/users/linked-gh/gists': [], 'https://api.github.com/users/linked-gh': { bio: 'old bio' } });
    const notYet = await api(`/v1/recovery/${n}/check`, { body: { claim_token: claim } });
    expect(notYet.body.status).toBe('pending');
    // approve before proof: refused
    expect((await approve(admin.key, n)).body.error.code).toBe('invalid_recovery_state');
    vi.restoreAllMocks();
    web({ 'https://api.github.com/users/linked-gh': { bio: `recovering ${challenge}` } });
    const seen = await api(`/v1/recovery/${n}/check`, { body: { claim_token: claim } });
    expect(seen.body.status).toBe('verified');
    expect(seen.body.proof_url).toBe('https://github.com/linked-gh');
    // the reviewer sees the challenge and the verified-link evidence, never secrets
    const review = (await api('/v1/admin/recovery?status=verified', { key: admin.key })).body.items[0];
    expect(review).toMatchObject({ number: n, challenge, evidence: { kind: 'linked_identity', seen_on: 'https://github.com/linked-gh', link: { provider: 'github', subject: 'linked-gh', status: 'verified', method: 'bio' } }, verified_links: [expect.objectContaining({ provider: 'github', subject: 'linked-gh' })] });
    expect(review.evidence.link.verified_at).toBeTruthy();
    expect(JSON.stringify(review)).not.toMatch(/cwc_|cwr_|cw1_|claim_hash|code_hash/);
    expect((await approve(admin.key, n)).status).toBe(200);
    expect((await api(`/v1/recovery/${n}/claim`, { body: { claim_token: claim } })).status).toBe(200);
    expect((await api('/v1/me', { key: a.key })).status).toBe(401);
  });

  it('refusals: unknown handle, no verified links, bad method, planned signing_key hook, reject is public, own account', async () => {
    const admin = await makeAdmin();
    const a = await register('plain', 'agent', 24 * 30);
    expect((await api('/v1/recovery', { body: { handle: 'nobody-here', method: 'proof' } })).status).toBe(404);
    expect((await api('/v1/recovery', { body: { handle: a.handle, method: 'proof' } })).body.error.code).toBe('no_verified_links');
    expect((await api('/v1/recovery', { body: { handle: a.handle, method: 'magic' } })).body.error.code).toBe('invalid_method');
    const hook = await api('/v1/recovery', { body: { handle: a.handle, method: 'signing_key' } });
    expect(hook.status).toBe(400);
    expect(hook.body.error).toMatchObject({ code: 'method_not_available', planned: true });
    const code = (await api('/v1/me/recovery-code', { key: a.key, method: 'POST' })).body.recovery_code.value;
    const start = await api('/v1/recovery', { body: { handle: a.handle, method: 'code', recovery_code: code } });
    const n = start.body.request.number;
    expect((await api(`/v1/admin/recovery/${n}/reject`, { key: admin.key, body: {} })).body.error.code).toBe('note_required');
    expect((await api(`/v1/admin/recovery/${n}/reject`, { key: admin.key, body: { note: 'Could not confirm the owner.' } })).body.status).toBe('rejected');
    expect((await api('/v1/moderation')).body.items[0]).toMatchObject({ type: 'account.recovery_rejected', note: 'Could not confirm the owner.' });
    expect((await api('/v1/me', { key: a.key })).status).toBe(200); // reject revokes nothing
  });

  it('an admin cannot decide their own recovery; moderators cannot decide at all', async () => {
    const admin = await makeAdmin();
    const own = (await api('/v1/me/recovery-code', { key: admin.key, method: 'POST' })).body.recovery_code.value;
    const mine = await api('/v1/recovery', { body: { handle: admin.handle, method: 'code', recovery_code: own } });
    expect((await approve(admin.key, mine.body.request.number)).body.error.code).toBe('cannot_decide_own_recovery');
    // moderators cannot decide (capability accounts:recover is admin only)
    const mod = await register('mod', 'human', 24 * 30);
    await env.DB.prepare("INSERT INTO account_roles (account_id, role, granted_at) VALUES (?, 'moderator', ?)").bind(mod.id, new Date().toISOString()).run();
    const no = await approve(mod.key, mine.body.request.number);
    expect(no.status).toBe(403);
    expect(no.body.error.required_capability).toBe('accounts:recover');
  });

  it('rate limits: 5 per network per hour (wrong codes cost only that), 3 matching-code requests per account per day', async () => {
    const a = await register('busy', 'agent', 24 * 30);
    const bad = { handle: a.handle, method: 'code', recovery_code: 'cwr_' + 'x'.repeat(43) };
    for (let i = 0; i < 5; i++) expect((await api('/v1/recovery', { body: bad })).status).toBe(403);
    const net = await api('/v1/recovery', { body: bad });
    expect(net.status).toBe(429);
    expect(net.body.error.scope).toBe('recovery_ip');
    // the account cap counts only requests with a matching code; a capped request does not burn the code
    const from = (n: number) => ({ 'cf-connecting-ip': `198.51.100.${n}` });
    for (let i = 0; i < 3; i++) {
      const code = (await api('/v1/me/recovery-code', { key: a.key, method: 'POST' })).body.recovery_code.value;
      expect((await api('/v1/recovery', { body: { ...bad, recovery_code: code }, headers: from(i) })).status).toBe(201);
    }
    const code = (await api('/v1/me/recovery-code', { key: a.key, method: 'POST' })).body.recovery_code.value;
    const capped = await api('/v1/recovery', { body: { ...bad, recovery_code: code }, headers: from(9) });
    expect(capped.status).toBe(429);
    expect(capped.body.error.scope).toBe('recovery_account');
    expect((await env.DB.prepare('SELECT used_at FROM recovery_codes WHERE account_id = ?').bind(a.id).first<{ used_at: string | null }>())!.used_at).toBeNull();
  });

  it('staff page shows open requests with approve/reject forms; deciding from the page uses the same handler', async () => {
    const admin = await makeAdmin();
    const a = await register('pagey', 'agent', 24 * 30);
    const code = (await api('/v1/me/recovery-code', { key: a.key, method: 'POST' })).body.recovery_code.value;
    const n = (await api('/v1/recovery', { body: { handle: a.handle, method: 'code', recovery_code: code } })).body.request.number;
    const SAME = { origin: 'https://cw.test', 'sec-fetch-site': 'same-origin' };
    const link = await api('/v1/auth/login-link', { key: admin.key, method: 'POST' });
    const login = await (exports as any).default.fetch(new Request('https://cw.test/login', { method: 'POST', redirect: 'manual', headers: { ...SAME, 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${new URL(link.body.url).searchParams.get('t')}` }));
    const cookie = `__Host-cw_session=${login.headers.get('set-cookie')!.match(/^__Host-cw_session=([^;]*)/)![1]}`;
    const page = await (await (exports as any).default.fetch(new Request('https://cw.test/admin', { headers: { cookie } }))).text();
    expect(page).toContain(`action="/admin/recovery/${n}/approve"`);
    expect(page).toContain('Recovery code used');
    expect(page).not.toMatch(/cwc_|cwr_[A-Za-z0-9_-]{43}|cw1_/);
    const md = await (await (exports as any).default.fetch(new Request('https://cw.test/admin.md', { headers: { cookie } }))).text();
    expect(md).toContain('## Key recovery requests (open)');
    expect(md).toContain(`recovery-${n} (verified) @${a.handle}`);
    expect(md).toContain('recovery code used');
    expect(md).not.toMatch(/cwc_|cwr_[A-Za-z0-9_-]{43}|cw1_/);
    const csrf = page.match(/name="_csrf" value="([0-9a-f]{64})"/)![1];
    const res = await (exports as any).default.fetch(new Request(`https://cw.test/admin/recovery/${n}/approve`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, note: 'code used' }).toString() }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin?done=recovery#recovery');
    expect((await api('/v1/admin/recovery?status=approved', { key: admin.key })).body.items[0].number).toBe(n);
  });
});
