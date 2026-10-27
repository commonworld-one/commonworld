/**
 * MCP server (/mcp, src/mcp/*): tool/REST parity, transport and routing, auth gating, tool calls through the same
 * /v1 handlers, destructive confirmation, rate limits, docs (page, Markdown twin, JSON, docs/MCP.md, llms.txt).
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { OPERATIONS, schemaOf } from '../src/openapi';
import { REST_EXCLUDED, REST_TOOLS, TOOLS, TOOL_BY_NAME, CONFIRM_ARG, IDEMPOTENCY_ARG, UNTRUSTED_TEXT, ATLAS_PAGE_SIZE, atlasPaged } from '../src/mcp/tools';
import { MCP_LEGACY_VERSIONS, MCP_LIST_TTL_MS, MCP_MAX_BODY_BYTES, MCP_PROTOCOL_VERSIONS, MCP_WELL_KNOWN, validateArgs } from '../src/mcp/server';
import { resetAtlasCache } from '../src/mcp/atlas';
import MCP_DOC from '../docs/MCP.md?raw';
import { api, makeAdmin, register, resetDb, setSetting } from './helpers';

beforeEach(async () => { await resetDb(); resetAtlasCache(); });

const ORIGIN = 'https://api.test';
let seq = 0;

async function raw(init: RequestInit & { path?: string } = {}) {
  const res = await (exports as any).default.fetch(new Request(`${ORIGIN}${init.path ?? '/mcp'}`, init));
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, headers: res.headers, body, text };
}

async function rpc(method: string, params?: unknown, opts: { key?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  return raw({ method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, ...(params !== undefined ? { params } : {}) }) });
}

async function call(name: string, args: Record<string, unknown> = {}, key?: string) {
  const r = await rpc('tools/call', { name, arguments: args }, { key, headers: { 'mcp-protocol-version': '2025-06-18' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const result = r.body.result;
  return { ...result, data: result?.structuredContent, http: r };
}

const toolNames = (r: { body: any }) => (r.body.result.tools as { name: string }[]).map((t) => t.name);

describe('tool / REST parity', () => {
  it('every /v1 operation has exactly one tool or a documented exclusion, and nothing else', () => {
    const keys = OPERATIONS.map((o) => `${o.method} ${o.path}`);
    for (const k of keys) expect(Object.hasOwn(REST_TOOLS, k) !== Object.hasOwn(REST_EXCLUDED, k), k).toBe(true);
    expect(new Set([...Object.keys(REST_TOOLS), ...Object.keys(REST_EXCLUDED)])).toEqual(new Set(keys));
    expect(TOOLS.filter((t) => t.source.type === 'rest')).toHaveLength(keys.length - Object.keys(REST_EXCLUDED).length);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it('each tool schema is the operation: path + query params + body fields, same required set, nothing extra', () => {
    for (const op of OPERATIONS) {
      const spec = REST_TOOLS[`${op.method} ${op.path}`];
      if (!spec) continue;
      const tool = TOOL_BY_NAME.get(spec.name)!;
      const props = tool.inputSchema.properties as Record<string, any>;
      const expected = new Set<string>();
      const required = new Set<string>();
      for (const p of op.params ?? []) {
        const name = p.in === 'header' ? IDEMPOTENCY_ARG : p.name;
        expected.add(name);
        if (p.in === 'path' || p.required) required.add(name);
        if (p.in !== 'header') expect(props[name].type, `${spec.name}.${name}`).toEqual(p.schema.type);
      }
      const body = op.body ? (schemaOf(op.body, op.bodyRequired ?? []) as any) : { properties: {} };
      for (const k of Object.keys(body.properties)) expected.add(k);
      for (const k of op.bodyRequired ?? []) required.add(k);
      if (tool.confirm) { expected.add(CONFIRM_ARG); required.add(CONFIRM_ARG); }
      expect(new Set(Object.keys(props)), spec.name).toEqual(expected);
      expect(new Set((tool.inputSchema.required as string[] | undefined) ?? []), spec.name).toEqual(required);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations.readOnlyHint, spec.name).toBe(op.method === 'GET');
      expect(tool.description).toContain(`REST: ${op.method} ${op.path}`);
      const access = op.auth === 'none' ? (op.method === 'GET' ? 'public' : 'keyless') : op.auth === 'optional' ? 'public' : op.auth;
      expect(tool.access, spec.name).toBe(access);
    }
  });

  it('destructive tools require confirm=true; read tools are never destructive', () => {
    for (const t of TOOLS) {
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.confirm, t.name).toBe(t.annotations.destructiveHint);
      if (t.confirm) expect((t.inputSchema.properties as any)[CONFIRM_ARG]).toMatchObject({ type: 'boolean', const: true });
    }
    for (const n of ['platform_withdraw_post', 'account_rotate_key', 'account_confirm_deletion', 'admin_delete_account', 'admin_moderate_content']) expect(TOOL_BY_NAME.get(n)!.confirm, n).toBe(true);
  });

  it('tools whose output carries citizen or third-party text are openWorldHint: true and say so', () => {
    const untrusted = ['platform_get_profile', 'platform_leaderboard', 'platform_catalog', 'platform_section_tags', 'platform_list_posts',
      'platform_get_post', 'platform_post_connections', 'platform_post_moves', 'platform_post_decisions', 'platform_post_comments', 'platform_post_voters', 'platform_comment_voters', 'platform_get_comment', 'platform_list_porch', 'platform_get_porch_line', 'platform_feed', 'platform_moderation_log',
      'admin_list_citizens', 'admin_list_recovery', 'admin_list_actions', 'atlas_get_platform', 'atlas_list_page', 'atlas_first_tasks', 'account_list_apps'];
    for (const name of untrusted) {
      const t = TOOL_BY_NAME.get(name)!;
      expect(t, name).toBeDefined();
      expect(t.untrustedOutput, name).toBe(true);
      expect(t.annotations.openWorldHint, name).toBe(true);
      expect(t.description, name).toContain(UNTRUSTED_TEXT);
    }
    // open world = untrusted output or an external fetch, nothing else
    const external = ['account_recovery_check', 'account_verify_identity'];
    for (const t of TOOLS) expect(t.annotations.openWorldHint, t.name).toBe(untrusted.includes(t.name) || external.includes(t.name));
  });

  it('argument validation: unknown, missing and mistyped arguments', () => {
    const schema = TOOL_BY_NAME.get('platform_get_post')!.inputSchema;
    expect(validateArgs(schema, { number: 3 })).toEqual([]);
    expect(validateArgs(schema, {})).toEqual(['number: required']);
    expect(validateArgs(schema, { number: '3' })[0]).toMatch(/expected integer/);
    expect(validateArgs(schema, { number: 0 })[0]).toMatch(/at least 1/);
    expect(validateArgs(schema, { number: 1, extra: true })).toEqual(['extra: unknown argument']);
  });
});

describe('transport and routing', () => {
  it('initialize negotiates the protocol version and names the server', async () => {
    const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.body.result.protocolVersion).toBe('2025-06-18');
    expect(r.body.result.serverInfo.name).toBe('commonworld');
    expect(r.body.result.capabilities.tools).toBeDefined();
    expect(r.body.result.instructions).toContain('account_register');
    const other = await rpc('initialize', { protocolVersion: '1999-01-01' });
    expect(other.body.result.protocolVersion).toBe(MCP_LEGACY_VERSIONS[0]);
    expect(r.headers.get('mcp-session-id')).toBeNull();
  });

  it('ping, notifications (202), unknown method, batch, parse errors, content type, version header, body cap', async () => {
    expect((await rpc('ping')).body.result).toEqual({});
    const note = await raw({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    expect(note.text).toBe('');
    expect((await rpc('resources/list')).body.error.code).toBe(-32601);
    const batch = await raw({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) });
    expect(batch.status).toBe(400);
    expect(batch.body.error.message).toBe('batch_not_supported');
    const bad = await raw({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32700);
    expect((await raw({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    const old = await rpc('ping', undefined, { headers: { 'mcp-protocol-version': '2020-01-01' } });
    expect(old.status).toBe(400);
    expect(old.body.error).toMatchObject({ code: -32022, data: { supported: [...MCP_PROTOCOL_VERSIONS], requested: '2020-01-01' } });
    expect((await rpc('ping', undefined, { headers: { accept: 'text/html' } })).status).toBe(406);
    const big = await raw({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(MCP_MAX_BODY_BYTES) } }) });
    expect(big.status).toBe(413);
  });

  it('GET for a server stream and other methods answer 405; OPTIONS is the CORS preflight', async () => {
    const sse = await raw({ method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(sse.status).toBe(405);
    expect(sse.headers.get('allow')).toBe('POST, OPTIONS');
    expect((await raw({ method: 'GET', headers: { accept: 'application/json' } })).status).toBe(405);
    expect((await raw({ method: 'GET', headers: { accept: 'application/json, text/event-stream' } })).status).toBe(405);
    const plain = await raw({ method: 'GET' });
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-type')).toMatch(/^text\/html/);
    expect((await raw({ method: 'DELETE' })).status).toBe(405);
    const pre = await raw({ method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Mcp-Protocol-Version/);
  });

  it('Origin: malformed or "null" is refused; MCP_ALLOWED_ORIGINS narrows the list (own origin always allowed)', async () => {
    expect((await rpc('ping', undefined, { headers: { origin: 'null' } })).status).toBe(403);
    expect((await rpc('ping', undefined, { headers: { origin: 'https://app.example' } })).status).toBe(200);
    const worker = (await import('../src/index')).default;
    const { createExecutionContext } = await import('cloudflare:test');
    const send = async (origin: string) => (await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' }),
      { ...env, MCP_ALLOWED_ORIGINS: 'https://good.example' } as any, createExecutionContext())).status;
    expect(await send('https://good.example')).toBe(200);
    expect(await send(ORIGIN)).toBe(200);
    expect(await send('https://evil.example')).toBe(403);
  });

  it('docs: /mcp in a browser is the page, /mcp.md the Markdown twin, /mcp.json the description', async () => {
    const page = await raw({ method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.text).toContain('Commonworld MCP server');
    expect(page.text).toContain('platform_create_post');
    expect(page.headers.get('link')).toContain('/mcp.md');
    const md = await raw({ method: 'GET', path: '/mcp.md' });
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toMatch(/^text\/markdown/);
    for (const t of TOOLS) expect(md.text, t.name).toContain(`\`${t.name}\``);
    const negotiated = await raw({ method: 'GET', headers: { accept: 'text/markdown' } });
    expect(negotiated.headers.get('content-type')).toMatch(/^text\/markdown/);
    const desc = await raw({ method: 'GET', path: '/mcp.json' });
    expect(desc.status).toBe(200);
    expect(desc.body.endpoint).toBe(`${ORIGIN}/mcp`);
    expect(desc.body.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(desc.body.auth.oauth).toMatch(/^OAuth 2\.1 .*PKCE S256/);
    expect(desc.body.auth.oauth).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  });

  it('/.well-known/mcp.json: compact discovery manifest (servers, bearer auth optional, OAuth metadata), same headers as /mcp.json', async () => {
    expect(MCP_WELL_KNOWN).toBe('/.well-known/mcp.json');
    const wk = await raw({ method: 'GET', path: '/.well-known/mcp.json' });
    const full = await raw({ method: 'GET', path: '/mcp.json' });
    expect(wk.status).toBe(200);
    for (const h of ['content-type', 'access-control-allow-origin', 'cache-control', 'content-security-policy', 'x-content-type-options', 'strict-transport-security']) {
      expect(wk.headers.get(h), h).toBe(full.headers.get(h));
    }
    expect(wk.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(wk.headers.get('access-control-allow-origin')).toBe('*');
    expect(wk.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect(wk.body).toEqual({
      name: 'commonworld',
      title: 'Commonworld MCP server',
      description: expect.stringContaining('Model Context Protocol'),
      homepage: ORIGIN,
      servers: [{
        name: 'commonworld', url: `${ORIGIN}/mcp`, transport: 'streamable-http', protocol_versions: [...MCP_PROTOCOL_VERSIONS],
        auth: {
          type: 'bearer', optional: true, note: expect.stringMatching(/account_register.*no key.*OAuth 2\.1.*Authorization: Bearer cw1_/s),
          oauth: { protected_resource_metadata: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`, resource: `${ORIGIN}/mcp`, authorization_server: ORIGIN, authorization_server_metadata: `${ORIGIN}/.well-known/oauth-authorization-server`, scopes: ['read', 'write'], pkce: 'S256', registration: `${ORIGIN}/oauth/register` },
        },
      }, {
        name: 'commonworld-me', url: `${ORIGIN}/mcp/me`, transport: 'streamable-http', protocol_versions: [...MCP_PROTOCOL_VERSIONS],
        auth: {
          type: 'bearer', optional: false, note: expect.stringMatching(/sign-in required.*HTTP 401.*resource_metadata.*OAuth 2\.1.*Bearer cw1_/s),
          oauth: { protected_resource_metadata: `${ORIGIN}/.well-known/oauth-protected-resource/mcp/me`, resource: `${ORIGIN}/mcp/me`, authorization_server: ORIGIN, authorization_server_metadata: `${ORIGIN}/.well-known/oauth-authorization-server`, scopes: ['read', 'write'], pkce: 'S256', registration: `${ORIGIN}/oauth/register` },
        },
      }],
      links: { oauth_protected_resource: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`, oauth_protected_resource_me: `${ORIGIN}/.well-known/oauth-protected-resource/mcp/me`, oauth_authorization_server: `${ORIGIN}/.well-known/oauth-authorization-server`, self: `${ORIGIN}/.well-known/mcp.json`, mcp_json: `${ORIGIN}/mcp.json`, mcp_md: `${ORIGIN}/mcp.md`, docs: `${ORIGIN}/mcp`, openapi: `${ORIGIN}/openapi.json`, llms_txt: `${ORIGIN}/llms.txt` },
    });
    expect(full.body.docs.well_known).toBe(`${ORIGIN}/.well-known/mcp.json`);
    // every linked document answers
    for (const url of Object.values(wk.body.links) as string[]) {
      const r = await raw({ method: 'GET', path: new URL(url).pathname, headers: url.endsWith('/mcp') ? { accept: 'text/html' } : {} });
      expect(r.status, url).toBe(200);
    }
    // GET/HEAD only, like the other discovery documents
    expect((await raw({ method: 'HEAD', path: '/.well-known/mcp.json' })).status).toBe(200);
    expect((await raw({ method: 'POST', path: '/.well-known/mcp.json', body: '{}' })).status).toBe(405);
  });

  it('/.well-known/mcp.json is listed where agents look: llms.txt, /mcp.md, docs/MCP.md, openapi x-mcp', async () => {
    const llms = await raw({ method: 'GET', path: '/llms.txt' });
    expect(llms.text).toContain(`${ORIGIN}/.well-known/mcp.json`);
    const md = await raw({ method: 'GET', path: '/mcp.md' });
    expect(md.text).toContain(`${ORIGIN}/.well-known/mcp.json`);
    expect(MCP_DOC).toContain('/.well-known/mcp.json');
    const oa = await raw({ method: 'GET', path: '/openapi.json' });
    expect(oa.body['x-mcp'].well_known).toBe(`${ORIGIN}/.well-known/mcp.json`);
  });

  it('docs/MCP.md maps every tool to its REST endpoint; llms.txt and openapi point to /mcp', async () => {
    for (const t of TOOLS) {
      expect(MCP_DOC, t.name).toContain(`\`${t.name}\``);
      if (t.source.type === 'rest') expect(MCP_DOC, t.name).toContain(`${t.source.method} ${t.source.path}`);
    }
    expect(MCP_DOC).toContain(`## Tool map (${TOOLS.length} tools)`);
    const llms = await raw({ method: 'GET', path: '/llms.txt' });
    expect(llms.text).toContain('/mcp');
    const oa = await raw({ method: 'GET', path: '/openapi.json' });
    expect(oa.body['x-mcp'].endpoint).toBe(`${ORIGIN}/mcp`);
  });
});

describe('auth gating', () => {
  it('tools/list: anonymous = public + keyless; a key adds citizen writes; staff tools by role', async () => {
    const anon = toolNames(await rpc('tools/list'));
    expect(anon).toContain('atlas_search_platforms');
    expect(anon).toContain('platform_list_posts');
    expect(anon).toContain('account_register');
    expect(anon).not.toContain('platform_create_post');
    expect(anon.some((n) => n.startsWith('admin_'))).toBe(false);
    const citizen = await register('mcp-cit');
    const mine = toolNames(await rpc('tools/list', undefined, { key: citizen.key }));
    expect(mine).toContain('platform_create_post');
    expect(mine).toContain('account_rotate_key');
    expect(mine.some((n) => n.startsWith('admin_'))).toBe(false);
    const mod = await register('mcp-mod', 'human');
    await env.DB.prepare("INSERT INTO account_roles (account_id, role, granted_at) VALUES (?, 'moderator', ?)").bind(mod.id, new Date().toISOString()).run();
    const modTools = toolNames(await rpc('tools/list', undefined, { key: mod.key }));
    expect(modTools).toContain('admin_moderate_content');
    expect(modTools).not.toContain('admin_delete_account');
    const admin = await makeAdmin();
    const adminTools = toolNames(await rpc('tools/list', undefined, { key: admin.key }));
    expect(adminTools).toEqual(TOOLS.map((t) => t.name));
    const listed = (await rpc('tools/list')).body.result.tools[0];
    expect(Object.keys(listed).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'title']);
  });

  it('an invalid key is 401 with WWW-Authenticate and never echoed', async () => {
    const bogus = 'cw1_' + 'A'.repeat(43);
    const r = await rpc('tools/list', undefined, { key: bogus });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer /);
    expect(r.body.error.message).toBe('invalid_api_key');
    expect(r.text).not.toContain(bogus);
  });

  it('a write without a key is HTTP 401 with the RFC 9728 challenge; a staff tool with a citizen key is refused by the REST handler', async () => {
    const anon = await rpc('tools/call', { name: 'platform_create_post', arguments: { title: 'x', body: 'y' } }, { headers: { 'mcp-protocol-version': '2025-06-18' } });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toBe('Bearer realm="commonworld", resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp", scope="read write"');
    expect(anon.body.error.data).toMatchObject({ status: 401, error: { code: 'api_key_required' } });
    const citizen = await register('mcp-cit');
    const forb = await call('admin_get_modes', {}, citizen.key);
    expect(forb.isError).toBe(true);
    expect(forb.data.status).toBe(403);
    expect(forb.data.error.code).toBe('forbidden');
    expect(JSON.stringify(forb)).not.toContain(citizen.key);
    const admin = await makeAdmin();
    const ok = await call('admin_get_modes', {}, admin.key);
    expect(ok.isError).toBeUndefined();
  });
});

describe('tools/call', () => {
  it('Atlas tools read the static Atlas JSON', async () => {
    const cats = await call('atlas_list_categories');
    expect(cats.data.counts.platforms).toBe(3);
    expect(cats.data.categories.map((c: any) => c.id)).toEqual(['social', 'payments']);
    const found = await call('atlas_search_platforms', { query: 'demo' });
    expect(found.data.total).toBe(1);
    expect(found.data.items[0]).toMatchObject({ id: 'demo', has_first_task: true });
    expect(found.data.items[0].claims).toBeUndefined();
    expect((await call('atlas_search_platforms', { category: 'social', status: 'live' })).data.items.map((p: any) => p.id)).toEqual(['demo']);
    expect((await call('atlas_search_platforms', { tag: 'x402' })).data.items.map((p: any) => p.id)).toEqual(['payhub']);
    // one paging contract (2026-10-24): page, 1-based, 50 per page; offset is an alias (page = floor(offset / 50) + 1); limit is ignored
    const sp1 = (await call('atlas_search_platforms', {})).data;
    expect(sp1).toMatchObject({ page: 1, per_page: 50, pages: 1, has_more: false, next_page: null, page_from: 'default' });
    expect(sp1.items.length).toBe(sp1.total);
    expect((await call('atlas_search_platforms', { limit: 1 })).data.items.length).toBe(sp1.total);
    expect((await call('atlas_search_platforms', { offset: 49 })).data).toMatchObject({ page: 1, page_from: 'offset' });
    expect((await call('atlas_search_platforms', { offset: 50 })).data).toMatchObject({ page: 2, page_from: 'offset', items: [] });
    expect((await call('atlas_search_platforms', { page: 1, offset: 120 })).data).toMatchObject({ page: 1, page_from: 'page' });
    expect((await call('atlas_first_tasks', { offset: 100 })).data).toMatchObject({ page: 3, per_page: 50, page_from: 'offset' });
    const card = await call('atlas_get_platform', { id: 'demo' });
    expect(card.data.claims[0].source_url).toBe('https://demo.example');
    const missing = await call('atlas_get_platform', { id: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatchObject({ status: 404, error: { code: 'platform_not_found' } });
    const badId = await call('atlas_get_platform', { id: '../secrets' });
    expect(badId.data.error.code).toBe('invalid_arguments');
    expect((await call('atlas_first_tasks')).data.items.map((p: any) => p.id)).toEqual(['demo']);
    expect((await call('atlas_earn')).data.rows[0].id).toBe('payhub');
    const p1 = await call('atlas_list_page');
    expect(p1.data).toMatchObject({ page: 1, pages: 1, total: 3, has_more: false, next: null, snapshot_id: '0123456789abcdef' });
    expect(p1.data.platforms.map((p: any) => p.id)).toEqual(['demo', 'payhub', 'oldtown']);
    expect((await call('atlas_list_page', { page: 1, category: 'social' })).data.platforms.map((p: any) => p.id)).toEqual(['demo', 'oldtown']);
    const past = await call('atlas_list_page', { page: 2 });
    expect(past.isError).toBe(true);
    expect(past.data).toMatchObject({ status: 404, error: { code: 'page_not_found' } });
    // page 3 existed before (the fixture _redirects sends it to the last page with a temporary 302, as paged_redirects does
    // when a list shrinks); the tool follows the 302 hop exactly as it followed the 301
    const moved = await call('atlas_list_page', { page: 3 });
    expect(moved.isError).toBeUndefined();
    expect(moved.data).toMatchObject({ page: 1, requested_page: 3, moved_to_last_page: true, snapshot_id: '0123456789abcdef' });
    expect((await call('atlas_list_page', { page: 0 })).data.error.code).toBe('invalid_arguments');
    expect((await call('atlas_list_page', { category: '../x' })).data.error.code).toBe('invalid_arguments');
    expect((await call('commonworld_stats')).data.metrics[0].status).toBe('coming');
    expect(found.content[0].type).toBe('text');
    expect(JSON.parse(found.content[0].text).total).toBe(1);
  });

  it('register, post, read back, upvote and withdraw through MCP = the REST API', async () => {
    const reg = await call('account_register', { handle: 'mcp-agent', kind: 'agent' });
    expect(reg.isError).toBeUndefined();
    const key = reg.data.api_key.value as string;
    expect(key).toMatch(/^cw1_/);
    const me = await call('account_me', {}, key);
    expect(me.data.account.handle).toBe('mcp-agent');
    expect(JSON.stringify(me)).not.toContain(key);
    const created = await call('platform_create_post', { title: 'Hello from MCP', body: 'Written through the MCP server.', section: 'general', tags: ['agents'], idempotency_key: 'mcp-1' }, key);
    expect(created.isError).toBeUndefined();
    const n = created.data.number;
    const again = await call('platform_create_post', { title: 'Hello from MCP', body: 'Written through the MCP server.', section: 'general', tags: ['agents'], idempotency_key: 'mcp-1' }, key);
    expect(again.data.number).toBe(n);
    const rest = await api(`/v1/posts/${n}`);
    expect(rest.body.title).toBe('Hello from MCP');
    expect(rest.body.author.handle).toBe('mcp-agent');
    const viaMcp = await call('platform_get_post', { number: n });
    expect(viaMcp.data.title).toBe(rest.body.title);
    const listed = await call('platform_list_posts', { author: 'mcp-agent' });
    expect(listed.data.items.map((p: any) => p.number)).toEqual([n]);
    const other = await register('mcp-voter');
    expect((await call('platform_upvote_post', { number: n }, other.key)).data.upvoted).toBe(true);
    const self = await call('platform_upvote_post', { number: n }, key);
    expect(self.data.error.code).toBe('self_vote_not_allowed');
    const comment = await call('platform_create_comment', { number: n, body: 'A reply via MCP.' }, other.key);
    expect(comment.data.post_number).toBe(n);
    const noConfirm = await call('platform_withdraw_post', { number: n, reason: 'Test.' }, key);
    expect(noConfirm.isError).toBe(true);
    expect(noConfirm.data.error.code).toBe('confirmation_required');
    expect((await api(`/v1/posts/${n}`)).body.withdrawn).toBeNull();
    const notMine = await call('platform_withdraw_post', { number: n, reason: 'Test.', confirm: true }, other.key);
    expect(notMine.data.error.code).toBe('not_your_content');
    const done = await call('platform_withdraw_post', { number: n, reason: 'Test.', confirm: true }, key);
    expect(done.data.withdrawn.reason).toBe('Test.');
  });

  it('REST validation errors come back as tool errors with the REST code', async () => {
    const c = await register('mcp-val');
    const r = await call('platform_create_post', { title: '', body: 'b' }, c.key);
    expect(r.isError).toBe(true);
    expect(r.data.status).toBe(400);
    expect(r.data.error.code).toBe('invalid_title');
    expect((await call('platform_get_post', { number: 999999 })).data).toMatchObject({ status: 404, error: { code: 'post_not_found' } });
  });

  it('unknown tool is a protocol error; unknown argument and wrong type are tool errors', async () => {
    const r = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    expect(r.body.error.code).toBe(-32602);
    const extra = await call('platform_rules', { surprise: 1 });
    expect(extra.isError).toBe(true);
    expect(extra.data.error.details).toEqual(['surprise: unknown argument']);
  });

  it('the account minute limit of the REST API applies to tool calls (one window, shared)', async () => {
    const c = await register('mcp-rate');
    await setSetting('limits.rate_per_minute', 3);
    expect((await call('account_me', {}, c.key)).isError).toBeUndefined();
    expect((await api('/v1/me', { key: c.key })).status).toBe(200);
    expect((await call('account_me', {}, c.key)).isError).toBeUndefined();
    const over = await call('account_me', {}, c.key);
    expect(over.isError).toBe(true);
    expect(over.data).toMatchObject({ status: 429, error: { code: 'rate_limit_exceeded' } });
    expect(over.http.headers.get('retry-after')).toBeTruthy();
    // non-call methods count too, at the envelope
    const list = await rpc('tools/list', undefined, { key: c.key });
    expect(list.status).toBe(429);
  });

  it('Atlas tool calls (answered here, not forwarded) count against the account minute window', async () => {
    const c = await register('mcp-atlas-rate');
    await setSetting('limits.rate_per_minute', 3);
    for (let i = 0; i < 3; i++) expect((await call('atlas_search_platforms', { query: 'demo' }, c.key)).isError, `call ${i}`).toBeUndefined();
    const over = await rpc('tools/call', { name: 'atlas_search_platforms', arguments: {} }, { key: c.key, headers: { 'mcp-protocol-version': '2025-06-18' } });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: -32029, message: 'rate_limit_exceeded' });
    expect(over.headers.get('retry-after')).toBeTruthy();
    // the same window as the REST API
    expect((await api('/v1/me', { key: c.key })).status).toBe(429);
  });

  it('a forwarded (REST) tool call counts once, an Atlas call once, a refused call once: one shared window', async () => {
    const c = await register('mcp-once');
    await setSetting('limits.rate_per_minute', 5); // a rate tier (src/ratelimit.ts RATE_TIERS)
    expect((await call('account_me', {}, c.key)).isError).toBeUndefined(); // 1 (by the /v1 route only)
    expect((await call('atlas_list_categories', {}, c.key)).isError).toBeUndefined(); // 2 (envelope)
    expect((await call('account_me', { nope: 1 }, c.key)).data.error.code).toBe('invalid_arguments'); // 3 (refused here, envelope)
    expect((await call('account_me', {}, c.key)).isError).toBeUndefined(); // 4
    expect((await call('platform_rules', {}, c.key)).isError).toBeUndefined(); // 5 (public REST tool with a key: the /v1 route)
    const over = await call('account_me', {}, c.key);
    expect(over.data).toMatchObject({ status: 429, error: { code: 'rate_limit_exceeded' } });
  });

  it('structuredContent only for protocol 2025-06-18 and later', async () => {
    const old = await rpc('tools/call', { name: 'platform_rules', arguments: {} }, { headers: { 'mcp-protocol-version': '2025-03-26' } });
    expect(old.body.result.structuredContent).toBeUndefined();
    expect(JSON.parse(old.body.result.content[0].text).rules.length).toBeGreaterThan(0);
    const now = await call('platform_rules');
    expect(now.data.rules.length).toBeGreaterThan(0);
  });
});

describe('protocol 2026-07-28 (stateless, no handshake)', () => {
  const V = '2026-07-28';
  const meta = (extra: Record<string, unknown> = {}) => ({ 'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, ...extra });
  const modern = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}, key?: string) =>
    rpc(method, { ...params, _meta: meta() }, { key, headers: { 'mcp-protocol-version': V, 'mcp-method': method, ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}), ...headers } });

  it('server/discover lists every supported version, the tools capability and the server', async () => {
    const r = await modern('server/discover');
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ resultType: 'complete', supportedVersions: [...MCP_PROTOCOL_VERSIONS], capabilities: { tools: {} }, ttlMs: MCP_LIST_TTL_MS, cacheScope: 'public' });
    expect(r.body.result.supportedVersions[0]).toBe(V);
    expect(r.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('commonworld');
    expect(r.body.result.instructions).toContain('account_register');
  });

  it('tools/list and tools/call without initialize; results carry resultType, serverInfo and cache hints', async () => {
    const list = await modern('tools/list');
    expect(list.status).toBe(200);
    expect(list.body.result).toMatchObject({ resultType: 'complete', ttlMs: MCP_LIST_TTL_MS, cacheScope: 'public' });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain('atlas_search_platforms');
    const c = await register('mcp-modern');
    expect((await modern('tools/list', {}, {}, c.key)).body.result.cacheScope).toBe('private');
    const call = await modern('tools/call', { name: 'atlas_search_platforms', arguments: { query: 'demo' } });
    expect(call.status).toBe(200);
    expect(call.body.result.resultType).toBe('complete');
    expect(call.body.result.structuredContent.total).toBeGreaterThan(0);
    expect(call.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('commonworld');
    const rest = await modern('tools/call', { name: 'platform_rules', arguments: {} });
    expect(rest.body.result.structuredContent.rules.length).toBeGreaterThan(0);
  });

  it('Mcp-Name may use the base64 sentinel', async () => {
    const r = await modern('tools/call', { name: 'platform_rules', arguments: {} }, { 'mcp-name': `=?base64?${btoa('platform_rules')}?=` });
    expect(r.status).toBe(200);
    expect(r.body.result.resultType).toBe('complete');
  });

  it('header mismatches are 400 HeaderMismatch (-32020); missing _meta fields are 400 -32602', async () => {
    const cases: [string, Record<string, unknown>, Record<string, string>][] = [
      ['tools/list', {}, { 'mcp-method': 'tools/call' }],
      ['tools/list', {}, { 'mcp-method': '' }],
      ['tools/call', { name: 'platform_rules', arguments: {} }, { 'mcp-name': 'atlas_earn' }],
      ['tools/call', { name: 'platform_rules', arguments: {} }, { 'mcp-name': '=?base64?***?=' }],
    ];
    for (const [method, params, headers] of cases) {
      const r = await modern(method, params, headers);
      expect(r.status, JSON.stringify(headers)).toBe(400);
      expect(r.body.error.code, JSON.stringify(headers)).toBe(-32020);
    }
    // header missing entirely
    const noMethod = await rpc('tools/list', { _meta: meta() }, { headers: { 'mcp-protocol-version': V } });
    expect(noMethod.status).toBe(400);
    expect(noMethod.body.error.code).toBe(-32020);
    const noName = await rpc('tools/call', { name: 'platform_rules', arguments: {}, _meta: meta() }, { headers: { 'mcp-protocol-version': V, 'mcp-method': 'tools/call' } });
    expect(noName.body.error.code).toBe(-32020);
    // _meta version without the header
    const noVersionHeader = await rpc('tools/list', { _meta: meta() }, { headers: { 'mcp-method': 'tools/list' } });
    expect(noVersionHeader.status).toBe(400);
    expect(noVersionHeader.body.error.code).toBe(-32020);
    // header and _meta disagree
    const disagree = await rpc('tools/list', { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '2025-11-25' }) }, { headers: { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' } });
    expect(disagree.body.error.code).toBe(-32020);
    // modern header, no _meta
    const bare = await rpc('tools/list', {}, { headers: { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' } });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe(-32602);
    // clientCapabilities must be an object, not an array or null
    for (const bad of [[], null, 'x']) {
      const r = await rpc('tools/list', { _meta: meta({ 'io.modelcontextprotocol/clientCapabilities': bad }) }, { headers: { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error.code, JSON.stringify(bad)).toBe(-32602);
    }
    // unsupported version in _meta
    const future = await rpc('tools/list', { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }) }, { headers: { 'mcp-protocol-version': V, 'mcp-method': 'tools/list' } });
    expect(future.status).toBe(400);
    expect(future.body.error).toMatchObject({ code: -32022, data: { requested: '2099-01-01' } });
  });

  it('ping and other removed or unknown methods are 404 -32601 for 2026-07-28; initialize stays the legacy handshake', async () => {
    for (const m of ['ping', 'subscriptions/listen', 'resources/list']) {
      const r = await modern(m);
      expect(r.status, m).toBe(404);
      expect(r.body.error.code, m).toBe(-32601);
    }
    const init = await rpc('initialize', { protocolVersion: V, capabilities: {}, clientInfo: { name: 'x', version: '1' } }, { headers: { 'mcp-protocol-version': V } });
    expect(init.status).toBe(200);
    expect(init.body.result.protocolVersion).toBe(MCP_LEGACY_VERSIONS[0]);
    // legacy requests are unchanged: no resultType, ping works
    expect((await rpc('ping', undefined, { headers: { 'mcp-protocol-version': '2025-11-25' } })).body.result).toEqual({});
    expect((await rpc('tools/list', undefined, { headers: { 'mcp-protocol-version': '2025-11-25' } })).body.result.resultType).toBeUndefined();
  });

  it('a modern tools/call counts once against the account window', async () => {
    const c = await register('mcp-modern-rate');
    await setSetting('limits.rate_per_minute', 2);
    expect((await modern('tools/call', { name: 'atlas_earn', arguments: {} }, {}, c.key)).status).toBe(200);
    expect((await modern('tools/call', { name: 'account_me', arguments: {} }, {}, c.key)).body.result.isError).toBeUndefined();
    expect((await modern('tools/call', { name: 'atlas_earn', arguments: {} }, {}, c.key)).status).toBe(429);
  });
});

describe('Atlas tools: one paging contract (page, 1-based, 50 per page; offset alias)', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  it('page wins, offset maps to floor(offset / 50) + 1, limit is ignored', () => {
    expect(ATLAS_PAGE_SIZE).toBe(50);
    expect(atlasPaged(rows, {})).toMatchObject({ total: 120, page: 1, per_page: 50, pages: 3, has_more: true, next_page: 2, page_from: 'default' });
    expect(atlasPaged(rows, { page: 3 })).toMatchObject({ page: 3, has_more: false, next_page: null, page_from: 'page' });
    expect(atlasPaged(rows, { page: 3 }).items).toEqual(rows.slice(100));
    expect(atlasPaged(rows, { offset: 0 }).page).toBe(1);
    expect(atlasPaged(rows, { offset: 99 }).page).toBe(2);
    expect(atlasPaged(rows, { offset: 100 })).toMatchObject({ page: 3, page_from: 'offset' });
    expect(atlasPaged(rows, { page: 2, offset: 100 })).toMatchObject({ page: 2, page_from: 'page' });
    expect(atlasPaged(rows, { limit: 5 }).items.length).toBe(50);
    expect(atlasPaged(rows, { page: 9 })).toMatchObject({ page: 9, items: [], has_more: false, next_page: null });
  });
});

describe('Atlas JSON redirects the MCP tools follow', () => {
  it('only same-build Atlas JSON paths', async () => {
    const { atlasRedirectPath } = await import('../src/mcp/atlas');
    expect(atlasRedirectPath('/api/v1/atlas/page/7.json')).toBe('/api/v1/atlas/page/7.json');
    expect(atlasRedirectPath('https://commonworld.one/api/v1/atlas/platforms/page/7.json')).toBe('/api/v1/atlas/platforms/page/7.json');
    expect(atlasRedirectPath('https://evil.example/api/v1/atlas/page/7.json')).toBeNull();
    expect(atlasRedirectPath('/atlas/page/7/')).toBeNull();
    expect(atlasRedirectPath('/api/v1/atlas/page/7.json?x=1')).toBeNull();
    expect(atlasRedirectPath(null)).toBeNull();
  });

  it('full cycle 8 pages -> 7 pages -> 8 pages: page 8 is 200, then a 302 to page 7, then 200 again (never shadowed)', async () => {
    // a stand-in for Static Assets of three builds: _redirects first (as Cloudflare applies them), then files
    const build = (pages: number, redirects: Record<string, string>) => ({
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (redirects[path]) return new Response(null, { status: 302, headers: { location: redirects[path], 'cache-control': 'no-store' } });
        const m = path.match(/^\/api\/v1\/atlas\/page\/([0-9]+)\.json$/);
        const n = m ? Number(m[1]) : 0;
        if (n >= 1 && n <= pages) {
          return new Response(JSON.stringify({ snapshot_id: `s${pages}`, page: n, pages, has_more: n < pages, platforms: [] }), { headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
      },
    });
    const tool = TOOL_BY_NAME.get('atlas_list_page')!;
    const read = (assets: unknown, page: number) => tool.atlas!({ ASSETS: assets } as any, { page }) as Promise<any>;
    const eight = build(8, {});
    const seven = build(7, { '/api/v1/atlas/page/8.json': '/api/v1/atlas/page/7.json' });
    // build 1: 8 pages, page 8 is a plain page
    expect(await read(eight, 8)).toEqual({ snapshot_id: 's8', page: 8, pages: 8, has_more: false, platforms: [] });
    resetAtlasCache(); // a deploy starts new isolates
    // build 2: the list shrank to 7 pages, page 8 answers 302 to page 7; the tool follows the 302 exactly as it followed a 301
    expect(await read(seven, 8)).toMatchObject({ page: 7, pages: 7, requested_page: 8, moved_to_last_page: true, snapshot_id: 's7' });
    // build 3: page 8 is back. No cache reset here: the answer of the redirect hop was not kept, so it cannot shadow the page
    const back = await read(eight, 8);
    expect(back).toEqual({ snapshot_id: 's8', page: 8, pages: 8, has_more: false, platforms: [] });
    expect(back.moved_to_last_page).toBeUndefined();
    // a page number that never existed is 404 page_not_found in every build
    for (const assets of [eight, seven]) await expect(read(assets, 9)).rejects.toMatchObject({ status: 404, code: 'page_not_found' });
  });
});
