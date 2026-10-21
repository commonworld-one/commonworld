/**
 * OAuth 2.1 for the MCP server (src/oauth/*, src/pages/oauth-pages.ts): discovery metadata, Dynamic Client
 * Registration, consent with PKCE, token exchange, refresh rotation with reuse detection, revocation, scopes, no staff
 * powers, audience binding (MCP only), account status, CSRF on consent, and that no secret is ever logged or reflected.
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, makeAdmin, register, resetDb, setSetting } from './helpers';
import { s256 } from '../src/oauth/config';
import { consumeCode, createGrant, findRefresh, pruneOAuth, rotateRefresh } from '../src/oauth/store';
import { oauthProblem } from '../src/oauth/scopes';
import { createLoginLink, consumeLoginLink } from '../src/sessions';

const ORIGIN = 'https://api.test';
const REDIRECT = 'https://client.example/callback';
const RESOURCE = `${ORIGIN}/mcp`;
let seq = 0;

beforeEach(async () => { await resetDb(); });

async function fetchRaw(path: string, init: RequestInit = {}) {
  const res = await (exports as any).default.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init }));
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, headers: res.headers as Headers, body, text };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function registerClient(meta: Record<string, unknown> = {}, ip = '203.0.113.7') {
  return fetchRaw('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ client_name: 'Test MCP client', redirect_uris: [REDIRECT], ...meta }) });
}

function pkce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge: s256(verifier) };
}

interface Authz { client_id: string; redirect_uri?: string; state?: string; scope?: string; resource?: string; code_challenge: string; code_challenge_method?: string; response_type?: string }
const authzQuery = (a: Authz) => new URLSearchParams({ response_type: 'code', code_challenge_method: 'S256', redirect_uri: REDIRECT, resource: RESOURCE, state: 'st-123', ...a } as Record<string, string>).toString();

async function consentGet(a: Authz, cookie?: string) {
  const r = await fetchRaw(`/oauth/authorize?${authzQuery(a)}`, { headers: cookie ? { cookie } : {} });
  const csrf = r.text.match(/name="_csrf" value="([0-9a-f]{64})"/)?.[1] ?? '';
  const nonce = (r.headers.get('set-cookie') ?? '').match(/__Host-cw_oauth=([A-Za-z0-9_-]{43})/)?.[1] ?? '';
  const as = r.text.match(/name="_as" value="([A-Za-z0-9_-]{1,64})"/)?.[1] ?? '';
  return { ...r, csrf, nonce, as };
}

/** GET the consent page, then POST the decision as the browser would. Returns the POST response. */
async function consent(a: Authz, opts: { key?: string; decision?: 'approve' | 'deny'; write?: boolean; session?: string; origin?: string; csrf?: string; noCookie?: boolean } = {}) {
  const page = await consentGet(a, opts.session ? `__Host-cw_session=${opts.session}` : undefined);
  expect(page.status, page.text.slice(0, 300)).toBe(200);
  const cookies = [opts.noCookie ? '' : `__Host-cw_oauth=${page.nonce}`, opts.session ? `__Host-cw_session=${opts.session}` : ''].filter(Boolean).join('; ');
  const fields: Record<string, string> = {
    _csrf: opts.csrf ?? page.csrf, _as: page.as, client_id: a.client_id, redirect_uri: a.redirect_uri ?? REDIRECT, state: a.state ?? 'st-123', response_type: 'code',
    code_challenge: a.code_challenge, code_challenge_method: 'S256', scope: a.scope ?? 'read write', resource: a.resource ?? RESOURCE, decision: opts.decision ?? 'approve',
  };
  if (opts.key) fields.api_key = opts.key;
  if (opts.write !== false) fields.scope_write = 'on';
  return fetchRaw('/oauth/authorize', { method: 'POST', headers: { ...FORM, origin: opts.origin ?? ORIGIN, ...(cookies ? { cookie: cookies } : {}) }, body: form(fields) });
}

async function token(fields: Record<string, string>) {
  return fetchRaw('/oauth/token', { method: 'POST', headers: FORM, body: form(fields) });
}

/** Full flow up to tokens for a citizen. */
async function connect(key: string, opts: { write?: boolean; scope?: string; resource?: string } = {}) {
  const client = (await registerClient()).body;
  const { verifier, challenge } = await pkceAsync();
  const resource = opts.resource ?? RESOURCE;
  const post = await consent({ client_id: client.client_id, code_challenge: challenge, resource, ...(opts.scope ? { scope: opts.scope } : {}) }, { key, write: opts.write });
  expect(post.status, post.text.slice(0, 400)).toBe(303);
  const loc = new URL(post.headers.get('location')!);
  const code = loc.searchParams.get('code')!;
  const tok = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource });
  expect(tok.status, JSON.stringify(tok.body)).toBe(200);
  return { client, verifier, code, tokens: tok.body as { access_token: string; refresh_token: string; scope: string; expires_in: number; token_type: string } };
}

async function pkceAsync() { const p = pkce(); return { verifier: p.verifier, challenge: await p.challenge }; }

async function mcp(method: string, params: unknown, bearer?: string, path = '/mcp') {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-06-18' };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return fetchRaw(path, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
}
const ME = '/mcp/me';
const ME_RESOURCE = `${ORIGIN}${ME}`;
const ME_PRM = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/me`;
const ME_CHALLENGE = `Bearer realm="commonworld", resource_metadata="${ME_PRM}", scope="read write"`;
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'connector', version: '1' } };
const toolNames = (r: { body: any }) => (r.body.result.tools as { name: string }[]).map((t) => t.name);

// ---------------------------------------------------------------- discovery

describe('discovery metadata', () => {
  it('protected resource metadata (root and /mcp) names the MCP resource and this site as its authorization server', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await fetchRaw(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.body.resource).toBe(RESOURCE);
      expect(r.body.authorization_servers).toEqual([ORIGIN]);
      expect(r.body.scopes_supported).toEqual(['read', 'write']);
      expect(r.body.bearer_methods_supported).toEqual(['header']);
    }
  });

  it('authorization server metadata (RFC 8414): endpoints, PKCE S256 only, public clients, iss in responses', async () => {
    const r = await fetchRaw('/.well-known/oauth-authorization-server');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`, revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
    });
    const pre = await fetchRaw('/oauth/token', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('/.well-known/mcp.json and /mcp.json advertise OAuth', async () => {
    const wk = await fetchRaw('/.well-known/mcp.json');
    expect(wk.body.servers[0].auth.oauth).toMatchObject({ protected_resource_metadata: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`, authorization_server: ORIGIN });
    const doc = await fetchRaw('/mcp.json');
    expect(doc.body.auth.oauth).toContain('/.well-known/oauth-protected-resource');
  });
});

// ---------------------------------------------------------------- registration

describe('dynamic client registration', () => {
  it('registers a public client with defaults', async () => {
    const r = await registerClient();
    expect(r.status).toBe(201);
    expect(r.body.client_id).toMatch(/^cwcl_[A-Za-z0-9_-]{22}$/);
    expect(r.body).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'read write', redirect_uris: [REDIRECT] });
    expect(r.body.client_secret).toBeUndefined();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts https and loopback redirect URIs only, rejects bad names', async () => {
    for (const u of ['http://client.example/cb', 'javascript:alert(1)', 'https://client.example/cb#frag', 'https://user:pw@client.example/cb', 'cursor://cb', 'ftp://client.example/cb']) {
      const r = await registerClient({ redirect_uris: [u] });
      expect(r.status, u).toBe(400);
      expect(r.body.error, u).toBe('invalid_redirect_uri');
    }
    for (const u of ['http://localhost:3000/cb', 'http://127.0.0.1:9999/callback', 'http://[::1]/cb']) expect((await registerClient({ redirect_uris: [u] })).status, u).toBe(201);
    expect((await registerClient({ client_name: 'x'.repeat(81) })).body.error).toBe('invalid_client_metadata');
    expect((await registerClient({ client_name: 'Evil\u202eppa' })).body.error).toBe('invalid_client_metadata');
    expect((await registerClient({ redirect_uris: [] })).status).toBe(400);
    expect((await registerClient({ grant_types: ['client_credentials'] })).status).toBe(400);
    expect((await registerClient({ scope: 'admin' })).status).toBe(400);
  });

  it('is rate limited per client network like sign-ups', async () => {
    await setSetting('limits.register_per_ip_per_hour', 2);
    expect((await registerClient({}, '198.51.100.9')).status).toBe(201);
    expect((await registerClient({}, '198.51.100.9')).status).toBe(201);
    const third = await registerClient({}, '198.51.100.9');
    expect(third.status).toBe(429);
    expect(third.body.error).toBe('slow_down');
    expect((await registerClient({}, '198.51.100.10')).status).toBe(201);
  });

  it('client_secret_post clients get a secret once and must send it', async () => {
    const r = await registerClient({ token_endpoint_auth_method: 'client_secret_post' });
    expect(r.body.client_secret).toMatch(/^cwcs_/);
    const bad = await token({ grant_type: 'refresh_token', refresh_token: 'cwo1r_' + 'A'.repeat(43), client_id: r.body.client_id, client_secret: 'cwcs_' + 'B'.repeat(43) });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('invalid_client');
    expect(bad.text).not.toContain('B'.repeat(43));
  });
});

// ---------------------------------------------------------------- the flow

describe('authorization code + PKCE flow', () => {
  it('happy path: register -> consent -> token -> citizen tools via MCP -> refresh rotation -> revoke', async () => {
    const citizen = await register('oauth-cit', 'agent', 100);
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();

    const page = await consentGet({ client_id: client.client_id, code_challenge: challenge });
    expect(page.status).toBe(200);
    expect(page.text).toContain('Test MCP client');
    expect(page.text).toContain('client.example');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self' https://client.example");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const post = await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key });
    expect(post.status).toBe(303);
    const back = new URL(post.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st-123');
    expect(back.searchParams.get('iss')).toBe(ORIGIN);
    const code = back.searchParams.get('code')!;
    expect(code).toMatch(/^cwo1c_/);

    const tok = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT, resource: RESOURCE });
    expect(tok.status).toBe(200);
    expect(tok.headers.get('cache-control')).toBe('no-store');
    expect(tok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    expect(tok.body.access_token).toMatch(/^cwo1_[A-Za-z0-9_-]{43}$/);
    expect(tok.body.refresh_token).toMatch(/^cwo1r_/);
    expect(JSON.stringify(tok.body)).not.toContain(citizen.key);

    // only hashes are stored
    const stored = await env.DB.prepare('SELECT token_hash FROM oauth_tokens').all<{ token_hash: string }>();
    for (const r of stored.results) { expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/); expect(r.token_hash).not.toContain(tok.body.access_token); }

    const list = await mcp('tools/list', {}, tok.body.access_token);
    expect(list.status).toBe(200);
    const names = toolNames(list);
    expect(names).toContain('account_me');
    expect(names).toContain('platform_create_post');
    expect(names.some((n) => n.startsWith('admin_'))).toBe(false);
    for (const never of ['account_rotate_key', 'account_login_link', 'account_new_recovery_code', 'account_link_identity', 'account_confirm_deletion', 'account_list_apps', 'account_revoke_app', 'account_register']) expect(names, never).not.toContain(never);

    const me = await mcp('tools/call', { name: 'account_me', arguments: {} }, tok.body.access_token);
    expect(me.body.result.structuredContent.account.handle).toBe(citizen.handle);
    const created = await mcp('tools/call', { name: 'platform_create_post', arguments: { title: 'Via OAuth', body: 'Posted through a connected app.', section: 'general' } }, tok.body.access_token);
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeUndefined();
    expect(created.body.result.structuredContent.author.handle).toBe(citizen.handle);

    // refresh: a new pair, the old refresh token is spent
    const ref = await token({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: client.client_id });
    expect(ref.status).toBe(200);
    expect(ref.body.refresh_token).not.toBe(tok.body.refresh_token);
    expect((await mcp('tools/list', {}, ref.body.access_token)).status).toBe(200);

    // the citizen sees the app, then the app revokes itself
    const apps = await api('/v1/me/apps', { key: citizen.key });
    expect(apps.status).toBe(200);
    expect(apps.body.items).toHaveLength(1);
    expect(apps.body.items[0]).toMatchObject({ client_id: client.client_id, client_name: 'Test MCP client', redirect_hosts: ['client.example'], scope: ['read', 'write'] });
    const rev = await fetchRaw('/oauth/revoke', { method: 'POST', headers: FORM, body: form({ token: ref.body.refresh_token, client_id: client.client_id }) });
    expect(rev.status).toBe(200);
    expect((await mcp('tools/list', {}, ref.body.access_token)).status).toBe(401);
    expect((await api('/v1/me/apps', { key: citizen.key })).body.items).toHaveLength(0);
  });

  it('a wrong code_verifier is refused and burns the code', async () => {
    const citizen = await register('oauth-v');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const post = await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key });
    const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: client.client_id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
    const right = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(right.body.error).toBe('invalid_grant');
  });

  it('a reused code is refused and revokes what the first exchange issued', async () => {
    const citizen = await register('oauth-r');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const code = new URL((await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key })).headers.get('location')!).searchParams.get('code')!;
    const first = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(first.status).toBe(200);
    const again = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(again.body.error).toBe('invalid_grant');
    expect((await mcp('tools/list', {}, first.body.access_token)).status).toBe(401);
  });

  it('P1 (code replay race): a replay seen before the first exchange attached its grant leaves no grant and no token', async () => {
    const citizen = await register('oauth-replay1');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const code = new URL((await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key })).headers.get('location')!).searchParams.get('code')!;
    const counts = async () => ({
      grants: (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_grants').first<{ n: number }>())!.n,
      tokens: (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').first<{ n: number }>())!.n,
    });
    // the first exchange has consumed the code (used_at set, grant_id still null) and is running its checks ...
    const first = await consumeCode(env as any, code);
    expect(first.row).not.toBeNull();
    expect(first.row!.grant_id).toBeNull();
    // ... when a second exchange presents the same code: refused, and the replay is recorded on the code
    const replay = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    const marked = await env.DB.prepare('SELECT replayed_at, grant_id FROM oauth_codes WHERE code_hash = ?').bind(first.row!.code_hash).first<{ replayed_at: string | null; grant_id: string | null }>();
    expect(marked?.replayed_at).toBeTruthy();
    expect(marked?.grant_id).toBeNull();
    // the first exchange now reaches createGrant: refused, nothing usable exists
    expect(await createGrant(env as any, first.row!, true)).toBeNull();
    expect(await counts()).toEqual({ grants: 0, tokens: 0 });
  });

  it('P1 (code replay race): a replay seen after the grant was attached revokes it and deletes its tokens', async () => {
    const citizen = await register('oauth-replay2');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const code = new URL((await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key })).headers.get('location')!).searchParams.get('code')!;
    const first = await consumeCode(env as any, code);
    const issued = await createGrant(env as any, first.row!, true);
    expect(issued).not.toBeNull();
    expect((await mcp('tools/list', {}, issued!.access_token)).status).toBe(200);
    const replay = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(replay.body.error).toBe('invalid_grant');
    const grant = await env.DB.prepare('SELECT g.revoked_at, g.revoke_reason FROM oauth_grants g JOIN oauth_codes c ON c.grant_id = g.id WHERE c.code_hash = ?').bind(first.row!.code_hash).first<{ revoked_at: string | null; revoke_reason: string | null }>();
    expect(grant?.revoked_at).toBeTruthy();
    expect(grant?.revoke_reason).toBe('code_reuse');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').first<{ n: number }>())!.n).toBe(0);
    expect((await mcp('tools/list', {}, issued!.access_token)).status).toBe(401);
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: issued!.refresh_token!, client_id: client.client_id });
    expect(refresh.body.error).toBe('invalid_grant');
  });

  it('P1 (code replay race): a single exchange still issues a working pair; a replay by another client marks nothing', async () => {
    const citizen = await register('oauth-replay3');
    const { client, code, tokens } = await connect(citizen.key);
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(200);
    const row = await env.DB.prepare('SELECT replayed_at, grant_id FROM oauth_codes WHERE grant_id IS NOT NULL').first<{ replayed_at: string | null; grant_id: string | null }>();
    expect(row?.replayed_at).toBeNull();
    expect(row?.grant_id).toBeTruthy();
    // a different client presenting the code is refused but cannot revoke this client's grant
    const other = (await registerClient({}, '203.0.113.8')).body;
    const foreign = await token({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: other.client_id });
    expect(foreign.body.error).toBe('invalid_grant');
    expect((await env.DB.prepare('SELECT replayed_at FROM oauth_codes WHERE grant_id IS NOT NULL').first<{ replayed_at: string | null }>())?.replayed_at).toBeNull();
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(200);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(refreshed.status).toBe(200);
  });

  it('redirect_uri must match exactly: an unregistered one gets an error page (no redirect); a different one at the token endpoint is refused', async () => {
    const citizen = await register('oauth-m');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    for (const u of ['https://evil.example/callback', `${REDIRECT}/extra`, `${REDIRECT}?x=1`]) {
      const r = await consentGet({ client_id: client.client_id, code_challenge: challenge, redirect_uri: u });
      expect(r.status, u).toBe(400);
      expect(r.headers.get('location'), u).toBeNull();
      expect(r.text).toContain('invalid_redirect_uri');
    }
    const unknown = await consentGet({ client_id: 'cwcl_' + 'Z'.repeat(22), code_challenge: challenge });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('invalid_client');
    const code = new URL((await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key })).headers.get('location')!).searchParams.get('code')!;
    const r = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: 'https://client.example/other' });
    expect(r.body.error).toBe('invalid_grant');
  });

  it('loopback redirect URIs match with any port (RFC 8252)', async () => {
    const client = (await registerClient({ redirect_uris: ['http://127.0.0.1/callback'] })).body;
    const { challenge } = await pkceAsync();
    const r = await consentGet({ client_id: client.client_id, code_challenge: challenge, redirect_uri: 'http://127.0.0.1:53111/callback' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('on your own computer');
  });

  it('PKCE S256 is mandatory and the resource must be this MCP server', async () => {
    const citizen = await register('oauth-p');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const plain = await consentGet({ client_id: client.client_id, code_challenge: challenge, code_challenge_method: 'plain' });
    expect(plain.status).toBe(303);
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    const evil = await consentGet({ client_id: client.client_id, code_challenge: challenge, resource: 'https://evil.example/mcp' });
    const loc = new URL(evil.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_target');
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('iss')).toBe(ORIGIN);
    const badScope = await consentGet({ client_id: client.client_id, code_challenge: challenge, scope: 'read admin' });
    expect(new URL(badScope.headers.get('location')!).searchParams.get('error')).toBe('invalid_scope');
    // resource = the origin itself (root metadata) is the same server
    expect((await consentGet({ client_id: client.client_id, code_challenge: challenge, resource: ORIGIN })).status).toBe(200);
    const code = new URL((await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key })).headers.get('location')!).searchParams.get('code')!;
    const r = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, resource: 'https://other.example/mcp' });
    expect(r.body.error).toBe('invalid_target');
  });

  it('deny sends access_denied back with state and iss', async () => {
    const client = (await registerClient()).body;
    const { challenge } = await pkceAsync();
    const r = await consent({ client_id: client.client_id, code_challenge: challenge }, { decision: 'deny' });
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('P2-b: the consent form is bound to the account it was shown for; a session switch in another tab grants nothing', async () => {
    const a = await register('oauth-sa');
    const b = await register('oauth-sb');
    const sessionOf = async (id: string) => { const l = await createLoginLink(env as any, id); const s = await consumeLoginLink(env as any, l.token); if (!s.ok) throw new Error('no session'); return s.session; };
    const sa = await sessionOf(a.id);
    const sb = await sessionOf(b.id);
    const client = (await registerClient()).body;
    const { challenge } = await pkceAsync();
    const req = { client_id: client.client_id, code_challenge: challenge };
    const page = await consentGet(req, `__Host-cw_session=${sa}`);
    expect(page.text).toContain(`@${a.handle}`);
    expect(page.as).toBe(a.id);
    const fields = (csrf: string, as: string) => form({ _csrf: csrf, _as: as, client_id: client.client_id, redirect_uri: REDIRECT, state: 'st-123', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write', resource: RESOURCE, decision: 'approve', scope_write: 'on' });
    const postAs = (session: string | null, body: string) => fetchRaw('/oauth/authorize', { method: 'POST', headers: { ...FORM, origin: ORIGIN, cookie: [`__Host-cw_oauth=${page.nonce}`, session ? `__Host-cw_session=${session}` : ''].filter(Boolean).join('; ') }, body });
    // signed out of A and into B in another tab, then the old "as @A" form is submitted: no code, the page asks again as @B
    const stale = await postAs(sb, fields(page.csrf, page.as));
    expect(stale.status).toBe(409);
    expect(stale.headers.get('location')).toBeNull();
    expect(stale.text).toContain(`@${b.handle}`);
    expect(stale.text).toContain('opened for a different account');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first<{ n: number }>())!.n).toBe(0);
    // signed out entirely: the "as @A" form does not fall back to anything; the key form is shown
    const out = await postAs(null, fields(page.csrf, page.as));
    expect(out.status).toBe(409);
    expect(out.text).toContain('name="api_key"');
    // forging _as for B with A's token is a CSRF failure
    expect((await postAs(sb, fields(page.csrf, b.id))).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first<{ n: number }>())!.n).toBe(0);
    // the re-shown page (bound to B) works for B, and the code belongs to B
    const csrfB = stale.text.match(/name="_csrf" value="([0-9a-f]{64})"/)![1];
    const asB = stale.text.match(/name="_as" value="([A-Za-z0-9_-]{1,64})"/)![1];
    expect(asB).toBe(b.id);
    const ok = await postAs(sb, fields(csrfB, asB));
    expect(ok.status).toBe(303);
    expect((await env.DB.prepare('SELECT account_id FROM oauth_codes').first<{ account_id: string }>())!.account_id).toBe(b.id);
    // Deny from a stale form needs no account and still just says no
    const page2 = await consentGet(req, `__Host-cw_session=${sa}`);
    const deny = await fetchRaw('/oauth/authorize', { method: 'POST', headers: { ...FORM, origin: ORIGIN, cookie: `__Host-cw_oauth=${page2.nonce}; __Host-cw_session=${sb}` }, body: form({ _csrf: page2.csrf, _as: page2.as, client_id: client.client_id, redirect_uri: REDIRECT, state: 'st-123', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read', resource: RESOURCE, decision: 'deny' }) });
    expect(deny.status).toBe(303);
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('a signed-in browser session approves without pasting the key', async () => {
    const citizen = await register('oauth-s');
    const link = await createLoginLink(env as any, citizen.id);
    const s = await consumeLoginLink(env as any, link.token);
    if (!s.ok) throw new Error('no session');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const page = await consentGet({ client_id: client.client_id, code_challenge: challenge }, `__Host-cw_session=${s.session}`);
    expect(page.text).toContain(`@${citizen.handle}`);
    expect(page.text).not.toContain('name="api_key"');
    const post = await consent({ client_id: client.client_id, code_challenge: challenge }, { session: s.session });
    expect(post.status).toBe(303);
    const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id })).status).toBe(200);
  });
});

// ---------------------------------------------------------------- refresh, expiry, status

describe('tokens', () => {
  it('reusing a rotated refresh token revokes the whole family', async () => {
    const citizen = await register('oauth-f');
    const { client, tokens } = await connect(citizen.key);
    const next = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(next.status).toBe(200);
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await mcp('tools/list', {}, next.body.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: next.body.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    const grant = await env.DB.prepare('SELECT revoke_reason FROM oauth_grants').first<{ revoke_reason: string }>();
    expect(grant?.revoke_reason).toBe('refresh_reuse');
  });

  it('an expired access token is 401 invalid_token with the resource_metadata challenge', async () => {
    const citizen = await register('oauth-e');
    const { tokens } = await connect(citizen.key);
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'access'").run();
    const r = await mcp('tools/list', {}, tokens.access_token);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(r.text).not.toContain(tokens.access_token);
  });

  it('frozen or disabled accounts: tokens stop working, freezing disconnects the apps', async () => {
    const citizen = await register('oauth-z');
    const { client, tokens } = await connect(citizen.key);
    // status changed without the admin route (e.g. a bulk freeze): the lookup refuses it
    await env.DB.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").bind(citizen.id).run();
    const r = await mcp('tools/list', {}, tokens.access_token);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('account_frozen');
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(citizen.id).run();
    // the admin route revokes every grant
    const admin = await makeAdmin();
    expect((await api(`/v1/admin/accounts/${citizen.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: 'test' } })).status).toBe(200);
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(citizen.id).run();
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(401);
  });

  it('a bulk freeze disconnects every app of the frozen accounts; reverting it does not bring the old tokens back (Codex HOLD P1)', async () => {
    const citizen = await register('oauth-bf');
    const bystander = await register('oauth-bf2');
    const { client, tokens } = await connect(citizen.key);
    const other = await connect(bystander.key);
    // a pending authorization code of the frozen account dies too
    await env.DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, account_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
      SELECT 'pending-code', client_id, ?, ?, 'x', 'read', ?, '2026-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z' FROM oauth_clients LIMIT 1`).bind(citizen.id, REDIRECT, RESOURCE).run();
    const admin = await makeAdmin();
    // window = the citizen's registration second only, so the bystander stays active
    const at = (await env.DB.prepare('SELECT created_at FROM accounts WHERE id = ?').bind(citizen.id).first<{ created_at: string }>())!.created_at;
    const from = new Date(Date.parse(at)).toISOString();
    const to = new Date(Date.parse(at) + 1).toISOString();
    await env.DB.prepare('UPDATE accounts SET created_at = ? WHERE id = ?').bind(new Date(Date.parse(at) - 3_600_000).toISOString(), bystander.id).run();
    const freeze = await api('/v1/admin/freezes', { key: admin.key, body: { registered_from: from, registered_to: to, reason: 'qa' } });
    expect(freeze.status, JSON.stringify(freeze.body)).toBe(201);
    expect(freeze.body.affected_count).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes WHERE account_id = ?').bind(citizen.id).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT revoke_reason FROM oauth_grants WHERE account_id = ?').bind(citizen.id).first<{ revoke_reason: string }>())!.revoke_reason).toBe('account');
    expect((await api(`/v1/admin/freezes/${freeze.body.id}/revert`, { key: admin.key, body: { reason: 'qa' } })).status).toBe(200);
    expect((await env.DB.prepare('SELECT status FROM accounts WHERE id = ?').bind(citizen.id).first<{ status: string }>())!.status).toBe('active');
    // the account is active again, but its old access and refresh tokens stay dead
    const access = await mcp('tools/list', {}, tokens.access_token);
    expect(access.status).toBe(401);
    expect(access.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    // an account outside the window keeps its app
    expect((await mcp('tools/list', {}, other.tokens.access_token)).status).toBe(200);
    expect((await token({ grant_type: 'refresh_token', refresh_token: other.tokens.refresh_token, client_id: other.client.client_id })).status).toBe(200);
    // the API key itself is untouched by the freeze
    expect((await api('/v1/me', { key: citizen.key })).status).toBe(200);
  });

  it('P2-a: a key rotation, recovery-style revocation or freeze landing between the code check and the grant issues nothing', async () => {
    const citizen = await register('oauth-race');
    const client = (await registerClient()).body;
    const getCode = async () => {
      const { challenge } = await pkceAsync();
      const post = await consent({ client_id: client.client_id, code_challenge: challenge }, { key: citizen.key });
      return new URL(post.headers.get('location')!).searchParams.get('code')!;
    };
    const counts = async () => ({
      grants: (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_grants').first<{ n: number }>())!.n,
      tokens: (await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').first<{ n: number }>())!.n,
    });
    // 1. the token endpoint has consumed the code and checked the account (active) ...
    const c1 = await consumeCode(env as any, await getCode());
    expect(c1.row).not.toBeNull();
    // ... then the key is rotated (revokeAccountOAuth: codes deleted, grants revoked) before createGrant runs
    const rot = await api('/v1/keys/rotate', { key: citizen.key, method: 'POST' });
    expect(rot.status).toBe(200);
    const key2 = rot.body.api_key.value as string;
    expect(await createGrant(env as any, c1.row!, true)).toBeNull();
    expect(await counts()).toEqual({ grants: 0, tokens: 0 });
    // 2. the account is frozen in between (status changes even without the code being deleted)
    const c2 = await consumeCode(env as any, await (async () => { const { challenge } = await pkceAsync(); const post = await consent({ client_id: client.client_id, code_challenge: challenge }, { key: key2 }); return new URL(post.headers.get('location')!).searchParams.get('code')!; })());
    await env.DB.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").bind(citizen.id).run();
    expect(await createGrant(env as any, c2.row!, true)).toBeNull();
    expect(await counts()).toEqual({ grants: 0, tokens: 0 });
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(citizen.id).run();
    // 3. without a race the same path issues the pair, bound to the code
    const { challenge, verifier } = await pkceAsync();
    const post = await consent({ client_id: client.client_id, code_challenge: challenge }, { key: key2 });
    const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
    const tok = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(tok.status).toBe(200);
    expect(await counts()).toEqual({ grants: 1, tokens: 2 });
    // 4. refresh rotation: the refresh token was found (grant live), then the key is rotated before it is used
    const row = await findRefresh(env as any, tok.body.refresh_token);
    expect(row).not.toBeNull();
    const rot2 = await api('/v1/keys/rotate', { key: key2, method: 'POST' });
    expect(rot2.status).toBe(200);
    expect(await rotateRefresh(env as any, row!, 'read write')).toBe('revoked');
    expect((await counts()).tokens).toBe(0);
    // 5. the revocation lands after the refresh token was marked used but before the new pair is written: the
    //    conditional INSERTs (grant live + account active, checked inside the batch) write nothing
    const again = await connect(rot2.body.api_key.value as string);
    const row2 = await findRefresh(env as any, again.tokens.refresh_token);
    await env.DB.prepare("UPDATE oauth_grants SET revoked_at = ?, revoke_reason = 'key_rotation' WHERE id = ?").bind(new Date().toISOString(), row2!.grant_id).run();
    const before = (await counts()).tokens;
    expect(await rotateRefresh(env as any, row2!, 'read write')).toBe('revoked');
    expect((await counts()).tokens).toBe(before);
  });

  it('P1 (confirmed): reverting a single freeze or a bulk freeze never revives old tokens', async () => {
    const citizen = await register('oauth-rv');
    const { client, tokens } = await connect(citizen.key);
    const admin = await makeAdmin();
    expect((await api(`/v1/admin/accounts/${citizen.handle}/status`, { key: admin.key, body: { status: 'frozen', reason: 'qa' } })).status).toBe(200);
    expect((await api(`/v1/admin/accounts/${citizen.handle}/status`, { key: admin.key, body: { status: 'active', reason: 'qa' } })).status).toBe(200);
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(401);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id })).body.error).toBe('invalid_grant');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').first<{ n: number }>())!.n).toBe(0);
  });

  it('rotating the API key disconnects every app', async () => {
    const citizen = await register('oauth-k');
    const { tokens } = await connect(citizen.key);
    expect((await api('/v1/keys/rotate', { key: citizen.key, method: 'POST' })).status).toBe(200);
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(401);
  });

  it('an access token is for the MCP server only: straight to /v1 it is 401', async () => {
    const citizen = await register('oauth-a');
    const { tokens } = await connect(citizen.key);
    const r = await api('/v1/me', { key: tokens.access_token });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatchObject({ code: 'invalid_token', reason: 'token_audience_is_mcp' });
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

// ---------------------------------------------------------------- /mcp/me: authentication required (connector "Connect")

describe('/mcp/me: the same MCP server with authentication required', () => {
  it('unauthenticated initialize (and any other request) is 401 with the /mcp/me resource_metadata challenge; /mcp stays anonymous', async () => {
    const init = await mcp('initialize', INIT, undefined, ME);
    expect(init.status).toBe(401);
    expect(init.headers.get('www-authenticate')).toBe(ME_CHALLENGE);
    expect(init.headers.get('access-control-allow-origin')).toBe('*');
    expect(init.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
    expect(init.headers.get('cache-control')).toBe('no-store');
    expect(init.body.error).toMatchObject({ code: -32001, message: 'authentication_required', data: { status: 401, error: { code: 'authentication_required' } } });
    for (const method of ['tools/list', 'ping', 'tools/call']) {
      const r = await mcp(method, method === 'tools/call' ? { name: 'atlas_search_platforms', arguments: {} } : {}, undefined, ME);
      expect(r.status, method).toBe(401);
      expect(r.headers.get('www-authenticate'), method).toBe(ME_CHALLENGE);
    }
    // modern (2026-07-28) request, a body that is not even JSON, and a GET for the event stream: all 401 first
    const modern = await fetchRaw(ME, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    expect(modern.status).toBe(401);
    expect((await fetchRaw(ME, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status).toBe(401);
    const sse = await fetchRaw(ME, { headers: { accept: 'text/event-stream' } });
    expect(sse.status).toBe(401);
    expect(sse.headers.get('www-authenticate')).toBe(ME_CHALLENGE);
    // CORS preflight needs no credential
    const pre = await fetchRaw(ME, { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization');
    // a browser opening /mcp/me lands on the docs
    const page = await fetchRaw(ME, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/mcp#oauth');
    // /mcp is unchanged: anonymous initialize and public tools work
    const anon = await mcp('initialize', INIT);
    expect(anon.status).toBe(200);
    expect(anon.body.result.serverInfo.name).toBe('commonworld');
  });

  it('a bad or malformed credential on /mcp/me is 401 invalid_token pointing at the /mcp/me metadata', async () => {
    for (const bearer of ['cw1_' + 'x'.repeat(43), 'cwo1_' + 'y'.repeat(43), 'nonsense']) {
      const r = await mcp('initialize', INIT, bearer, ME);
      expect(r.status, bearer).toBe(401);
      expect(r.headers.get('www-authenticate'), bearer).toContain('error="invalid_token"');
      expect(r.headers.get('www-authenticate'), bearer).toContain(`resource_metadata="${ME_PRM}"`);
    }
  });

  it('protected resource metadata for /mcp/me names its own resource; the challenge URL answers it', async () => {
    const r = await fetchRaw(new URL(ME_PRM).pathname);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.body).toMatchObject({ resource: ME_RESOURCE, authorization_servers: [ORIGIN], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] });
    expect(r.body['x-commonworld'].anonymous_access).toMatch(/^none/);
    // the root and /mcp documents still describe /mcp
    expect((await fetchRaw('/.well-known/oauth-protected-resource')).body.resource).toBe(RESOURCE);
    expect((await fetchRaw('/.well-known/oauth-protected-resource/mcp')).body.resource).toBe(RESOURCE);
    const as = await fetchRaw('/.well-known/oauth-authorization-server');
    expect(as.body['x-commonworld'].resources).toEqual([RESOURCE, ME_RESOURCE]);
  });

  it('works with an OAuth token issued for /mcp/me: same tools, same handlers, writes as the citizen', async () => {
    const citizen = await register('oauth-me', 'agent', 100);
    const { tokens } = await connect(citizen.key, { resource: ME_RESOURCE });
    const grant = await env.DB.prepare('SELECT resource FROM oauth_grants').first<{ resource: string }>();
    expect(grant!.resource).toBe(ME_RESOURCE);
    const init = await mcp('initialize', INIT, tokens.access_token, ME);
    expect(init.status).toBe(200);
    expect(init.body.result.instructions).toContain(`Connected as @${citizen.handle}`);
    const meList = toolNames(await mcp('tools/list', {}, tokens.access_token, ME));
    // the same tool list as a /mcp token with the same scopes
    const other = await connect(citizen.key);
    expect(meList).toEqual(toolNames(await mcp('tools/list', {}, other.tokens.access_token)));
    expect(meList).toContain('platform_create_post');
    const me = await mcp('tools/call', { name: 'account_me', arguments: {} }, tokens.access_token, ME);
    expect(me.body.result.structuredContent.account.handle).toBe(citizen.handle);
    const created = await mcp('tools/call', { name: 'platform_create_post', arguments: { title: 'Via /mcp/me', body: 'Posted through a connector.', section: 'general' } }, tokens.access_token, ME);
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeUndefined();
    expect(created.body.result.structuredContent.author.handle).toBe(citizen.handle);
    // never-tools and staff limits are the same as on /mcp
    const rot = await mcp('tools/call', { name: 'account_rotate_key', arguments: { confirm: true } }, tokens.access_token, ME);
    expect(rot.body.result.isError).toBe(true);
    expect(rot.body.result.structuredContent.error.code).toBe('not_available_via_oauth');
    // a refresh keeps the binding
    const ref = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: (await env.DB.prepare('SELECT client_id FROM oauth_grants WHERE resource = ?').bind(ME_RESOURCE).first<{ client_id: string }>())!.client_id, resource: ME_RESOURCE });
    expect(ref.status, JSON.stringify(ref.body)).toBe(200);
    expect((await mcp('tools/list', {}, ref.body.access_token, ME)).status).toBe(200);
  });

  it('works with the citizen\'s own API key (cw1_…), staff tools included for staff keys', async () => {
    const citizen = await register('oauth-mekey');
    const r = await mcp('initialize', INIT, citizen.key, ME);
    expect(r.status).toBe(200);
    const names = toolNames(await mcp('tools/list', {}, citizen.key, ME));
    expect(names).toContain('account_rotate_key');
    const me = await mcp('tools/call', { name: 'account_me', arguments: {} }, citizen.key, ME);
    expect(me.body.result.structuredContent.account.handle).toBe(citizen.handle);
    const admin = await makeAdmin();
    expect(toolNames(await mcp('tools/list', {}, admin.key, ME)).some((n) => n.startsWith('admin_'))).toBe(true);
  });

  it('tokens are bound to one resource: a /mcp/me token is refused at /mcp and on /v1, a /mcp token at /mcp/me', async () => {
    const citizen = await register('oauth-aud');
    const meTok = (await connect(citizen.key, { resource: ME_RESOURCE })).tokens.access_token;
    const mcpTok = (await connect(citizen.key)).tokens.access_token;
    const a = await mcp('tools/list', {}, meTok);
    expect(a.status).toBe(401);
    expect(a.body.error.data.error).toMatchObject({ code: 'invalid_token', reason: 'wrong_audience' });
    expect(a.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const b = await mcp('tools/list', {}, mcpTok, ME);
    expect(b.status).toBe(401);
    expect(b.body.error.data.error).toMatchObject({ code: 'invalid_token', reason: 'wrong_audience' });
    expect(b.headers.get('www-authenticate')).toContain(`resource_metadata="${ME_PRM}"`);
    const v1 = await api('/v1/me', { key: meTok });
    expect(v1.status).toBe(401);
    expect(v1.body.error).toMatchObject({ code: 'invalid_token', reason: 'token_audience_is_mcp' });
    // each still works where it belongs
    expect((await mcp('tools/list', {}, meTok, ME)).status).toBe(200);
    expect((await mcp('tools/list', {}, mcpTok)).status).toBe(200);
  });

  it('resource mismatch at the token endpoint is refused (code for /mcp/me exchanged for /mcp, refresh moved, unknown path)', async () => {
    const citizen = await register('oauth-mis');
    const client = (await registerClient()).body;
    const { verifier, challenge } = await pkceAsync();
    const post = await consent({ client_id: client.client_id, code_challenge: challenge, resource: ME_RESOURCE }, { key: citizen.key });
    const code = new URL(post.headers.get('location')!).searchParams.get('code')!;
    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, resource: RESOURCE });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_target');
    // an unknown path on this origin is not a resource of this server
    const other = await consentGet({ client_id: client.client_id, code_challenge: challenge, resource: `${ORIGIN}/mcp/other` });
    expect(new URL(other.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    // a refresh cannot move a /mcp/me grant to /mcp
    const { client: c2, tokens } = await connect(citizen.key, { resource: ME_RESOURCE });
    const moved = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: c2.client_id, resource: RESOURCE });
    expect(moved.status).toBe(400);
    expect(moved.body.error).toBe('invalid_target');
  });
});

// ---------------------------------------------------------------- scopes and powers

describe('scopes and powers', () => {
  it('a read-only grant lists no write tools; calling one is 403 insufficient_scope (step-up)', async () => {
    const citizen = await register('oauth-ro');
    const { tokens } = await connect(citizen.key, { write: false });
    expect(tokens.scope).toBe('read');
    const names = toolNames(await mcp('tools/list', {}, tokens.access_token));
    expect(names).toContain('account_me');
    expect(names).not.toContain('platform_create_post');
    const r = await mcp('tools/call', { name: 'platform_create_post', arguments: { title: 't', body: 'b', section: 'general' } }, tokens.access_token);
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toMatch(/error="insufficient_scope", scope="write", resource_metadata="https:\/\/api\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM posts').first<{ n: number }>())!.n).toBe(0);
  });

  it('staff powers never pass through OAuth, even for an admin', async () => {
    const admin = await makeAdmin();
    const { tokens } = await connect(admin.key);
    const names = toolNames(await mcp('tools/list', {}, tokens.access_token));
    expect(names.some((n) => n.startsWith('admin_'))).toBe(false);
    const r = await mcp('tools/call', { name: 'admin_get_modes', arguments: {} }, tokens.access_token);
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
    expect(r.body.result.structuredContent.error.code).toBe('not_available_via_oauth');
    const set = await mcp('tools/call', { name: 'admin_set_mode', arguments: { mode: 'lock', enabled: true, confirm: true } }, tokens.access_token);
    expect(set.body.result.isError).toBe(true);
    const modes = await api('/v1/admin/modes', { key: admin.key });
    expect(modes.body.lock?.enabled ?? modes.body.modes?.lock?.enabled ?? false).toBe(false);
  });

  it('account-credential tools are refused for OAuth tokens (no key, no sign-in link, no recovery code)', async () => {
    const citizen = await register('oauth-n');
    const { tokens } = await connect(citizen.key);
    for (const [name, args] of [['account_rotate_key', { confirm: true }], ['account_login_link', {}], ['account_new_recovery_code', { confirm: true }]] as const) {
      const r = await mcp('tools/call', { name, arguments: args }, tokens.access_token);
      expect(r.body.result.isError, name).toBe(true);
      expect(r.body.result.structuredContent.error.code, name).toBe('not_available_via_oauth');
    }
    expect((await api('/v1/me', { key: citizen.key })).status).toBe(200); // key still valid: nothing rotated
  });

  it('the identity list (pending challenge codes = recovery data) is never available through OAuth, read or write (Codex HOLD P0)', async () => {
    const citizen = await register('oauth-id');
    const link = await api('/v1/me/identities', { key: citizen.key, body: { provider: 'github', subject: 'oauth-id-login' } });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const challenge = link.body.challenge ?? link.body.identity?.challenge ?? link.body.item?.challenge;
    expect(typeof challenge).toBe('string');
    for (const write of [false, true]) {
      const { tokens } = await connect(citizen.key, { write });
      expect(toolNames(await mcp('tools/list', {}, tokens.access_token)), `write=${write}`).not.toContain('account_list_identities');
      const r = await mcp('tools/call', { name: 'account_list_identities', arguments: {} }, tokens.access_token);
      expect(r.body.result.isError, `write=${write}`).toBe(true);
      expect(r.body.result.structuredContent.error.code).toBe('not_available_via_oauth');
      expect(r.text).not.toContain(challenge);
      // REST: straight to /v1 the token is refused (audience), and the router rule for forwarded calls says never
      const rest = await api('/v1/me/identities', { key: tokens.access_token });
      expect(rest.status).toBe(401);
      expect(JSON.stringify(rest.body)).not.toContain(challenge);
    }
    const principal = { account: {} as any, roles: new Set<string>(), keyId: 'oauth:g', oauth: { grantId: 'g', clientId: 'c', scopes: ['read', 'write'] } };
    expect(oauthProblem(principal as any, 'GET', '/v1/me/identities')).toEqual({ need: 'never' });
    expect(oauthProblem(principal as any, 'GET', '/v1/me')).toBeNull();
    expect(oauthProblem({ ...principal, oauth: undefined } as any, 'GET', '/v1/me/identities')).toBeNull();
    // the citizen's own API key still lists them, over REST and over MCP
    const own = await api('/v1/me/identities', { key: citizen.key });
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(challenge);
    const byKey = await mcp('tools/call', { name: 'account_list_identities', arguments: {} }, citizen.key);
    expect(byKey.body.result.isError).toBeUndefined();
    expect(byKey.text).toContain(challenge);
    expect(toolNames(await mcp('tools/list', {}, citizen.key))).toContain('account_list_identities');
  });

  it('public reads without a token are unchanged', async () => {
    const anon = await mcp('tools/list', {});
    expect(anon.status).toBe(200);
    const names = toolNames(anon);
    expect(names).toContain('platform_list_posts');
    expect(names).not.toContain('account_me');
    const r = await mcp('tools/call', { name: 'platform_list_posts', arguments: {} });
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBeUndefined();
    expect((await api('/v1/posts')).status).toBe(200);
  });
});

// ---------------------------------------------------------------- CSRF, secrecy, apps page, clean-up

describe('consent CSRF and secrecy', () => {
  it('consent POST needs same origin, the consent cookie and its matching token', async () => {
    const citizen = await register('oauth-c');
    const client = (await registerClient()).body;
    const { challenge } = await pkceAsync();
    const a = { client_id: client.client_id, code_challenge: challenge };
    expect((await consent(a, { key: citizen.key, origin: 'https://evil.example' })).status).toBe(403);
    expect((await consent(a, { key: citizen.key, noCookie: true })).status).toBe(403);
    expect((await consent(a, { key: citizen.key, csrf: 'a'.repeat(64) })).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first<{ n: number }>())!.n).toBe(0);
  });

  it('a wrong key re-shows the form without echoing it; no key or token is ever logged', async () => {
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m));
    try {
      const client = (await registerClient()).body;
      const { challenge } = await pkceAsync();
      const wrongKey = 'cw1_' + 'Q'.repeat(43);
      const r = await consent({ client_id: client.client_id, code_challenge: challenge }, { key: wrongKey });
      expect(r.status).toBe(401);
      expect(r.text).toContain('was not accepted');
      expect(r.text).not.toContain(wrongKey);
      const citizen = await register('oauth-l');
      const { tokens, code, verifier } = await connect(citizen.key);
      await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'cwcl_' + 'Y'.repeat(22) });
      await mcp('tools/list', {}, tokens.access_token);
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
      for (const secret of [citizen.key, wrongKey, tokens.access_token, tokens.refresh_token, code, verifier]) expect(logged).not.toContain(secret);
    } finally { for (const s of spies) s.mockRestore(); }
  });
});

describe('connected apps page and clean-up', () => {
  it('/apps lists apps for a signed-in citizen and revokes with the session CSRF token', async () => {
    const citizen = await register('oauth-g');
    const { tokens } = await connect(citizen.key);
    const out = await fetchRaw('/apps');
    expect(out.status).toBe(200);
    expect(out.text).toContain('Sign in');
    const link = await createLoginLink(env as any, citizen.id);
    const s = await consumeLoginLink(env as any, link.token);
    if (!s.ok) throw new Error('no session');
    const page = await fetchRaw('/apps', { headers: { cookie: `__Host-cw_session=${s.session}` } });
    expect(page.text).toContain('Test MCP client');
    const action = page.text.match(/action="(\/apps\/grant_[0-9a-f-]{36}\/revoke)"/)![1];
    const csrf = page.text.match(/name="_csrf" value="([0-9a-f]{64})"/)![1];
    const bad = await fetchRaw(action, { method: 'POST', headers: { ...FORM, origin: ORIGIN, cookie: `__Host-cw_session=${s.session}` }, body: form({ _csrf: 'b'.repeat(64) }) });
    expect(bad.status).toBe(403);
    const ok = await fetchRaw(action, { method: 'POST', headers: { ...FORM, origin: ORIGIN, cookie: `__Host-cw_session=${s.session}` }, body: form({ _csrf: csrf }) });
    expect(ok.status).toBe(303);
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(401);
  });

  it('POST /v1/me/apps/{id}/revoke with the key disconnects the app; an OAuth token may not use it', async () => {
    const citizen = await register('oauth-h');
    const { tokens } = await connect(citizen.key);
    const id = (await api('/v1/me/apps', { key: citizen.key })).body.items[0].id;
    expect((await api(`/v1/me/apps/${id}/revoke`, { key: citizen.key, method: 'POST' })).status).toBe(200);
    expect((await api(`/v1/me/apps/${id}/revoke`, { key: citizen.key, method: 'POST' })).status).toBe(404);
    expect((await mcp('tools/list', {}, tokens.access_token)).status).toBe(401);
  });

  it('nightly clean-up deletes expired codes and tokens and old revoked grants', async () => {
    const citizen = await register('oauth-p2');
    await connect(citizen.key);
    const later = Date.now() + 40 * 86_400_000;
    const r = await pruneOAuth(env as any, later);
    expect(r.codes).toBe(1);
    expect(r.tokens).toBe(2);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_grants').first<{ n: number }>())!.n).toBe(0);
  });
});
