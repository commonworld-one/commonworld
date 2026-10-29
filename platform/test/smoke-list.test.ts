// Route smoke list (platform/smoke/routes.json) and its runner logic (platform/smoke/lib.mjs). The live run happens in
// the deploy workflows (docs/DEPLOY.md, "Route smoke list after every deploy"); here: the list is valid and read-only,
// and the checks judge responses correctly. No network: fetch is a stub.
import { describe, expect, it } from 'vitest';
import routesText from '../smoke/routes.json?raw';
import { discover, environmentFor, evaluate, expand, readOnlyRefusal, runEntry, validateList, type SmokeEntry, type SmokeList } from '../smoke/lib.mjs';

const list = JSON.parse(routesText) as SmokeList;
const vars = { base: 'https://staging.commonworld.one', environment: 'staging', post: 17 };
const entry = (e: Partial<SmokeEntry>): SmokeEntry => ({ id: 'x', path: '/', status: 200, added_by: '#1', ...e });
const res = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, body, headers: new Headers(headers) });

describe('smoke list', () => {
  it('is valid', () => {
    expect(validateList(list)).toEqual([]);
    expect(list.checks.length).toBeGreaterThan(20);
  });

  it('is read-only: GET or HEAD only, no credentials', () => {
    for (const e of list.checks) {
      expect(['GET', 'HEAD']).toContain(e.method ?? 'GET');
      expect(Object.keys(e.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
    }
  });

  it('keeps the basic health routes and an entry for each PR of the 2026-10-29 release', () => {
    const paths = new Set(list.checks.map((e) => e.path));
    for (const p of ['/health', '/', '/citizens', '/v1/feed', '/llms.txt', '/v1/openapi.json']) expect(paths).toContain(p);
    const prs = new Set(list.checks.flatMap((e) => e.added_by.split(' ')));
    for (const pr of ['#224', '#225', '#229', '#231', '#232', '#217', '#218']) expect(prs).toContain(pr);
  });

  it('never hard-codes a post number (posts differ between staging and production)', () => {
    for (const e of list.checks) expect(e.path).not.toMatch(/^\/posts\/\d/);
  });

  it('every skipped entry says why', () => {
    for (const e of list.checks.filter((c) => 'skip' in c)) expect(e.skip!.length).toBeGreaterThan(20);
  });
});

describe('validateList', () => {
  const one = (e: object) => validateList({ version: 1, checks: [e] });
  it('refuses writes, unknown keys, placeholders and missing provenance', () => {
    expect(one(entry({ method: 'POST' as 'GET' }))[0]).toMatch(/GET or HEAD/);
    expect(one({ ...entry({}), expect: 200 })[0]).toMatch(/unknown key "expect"/);
    expect(one(entry({ path: '/posts/{id}' }))[0]).toMatch(/unknown placeholder \{id\}/);
    expect(one(entry({ added_by: 'PR 224' }))[0]).toMatch(/added_by/);
    expect(one(entry({ headers: { Authorization: 'Bearer x' } }))[0]).toMatch(/no credentials/);
    expect(one(entry({ redirect: '/x' }))[0]).toMatch(/3xx/);
    expect(one(entry({ path: '//evil.example/' }))[0]).toMatch(/path/);
    expect(validateList({ version: 1, checks: [entry({}), entry({})] })[0]).toMatch(/duplicate id/);
  });
  it('reports malformed nested shapes as validation errors instead of throwing (CLI exit 2, not 1)', () => {
    const bad = (e: object) => { let r: string[] = []; expect(() => { r = one({ ...entry({}), ...e }); }).not.toThrow(); return r; };
    expect(bad({ headers: null })).toEqual(['checks[0] (x): "headers" must map names to strings']);
    expect(bad({ headers: ['accept'] })[0]).toMatch(/"headers" must map names to strings/);
    expect(bad({ header_contains: null })[0]).toMatch(/"header_contains" must map header names to strings/);
    expect(bad({ json_contains: 'x' })).toEqual(['checks[0] (x): "json_contains" must be a list of {pointer, contains}']);
    expect(bad({ json_contains: { pointer: '/a', contains: 'b' } })[0]).toMatch(/"json_contains" must be a list/);
    expect(bad({ json_contains: [null] })[0]).toMatch(/"json_contains" must be a list/);
    expect(bad({ body_contains: null })[0]).toMatch(/"body_contains" must be a list/);
  });
  it('refuses credential headers in any letter case', () => {
    for (const h of ['authorization', 'COOKIE', 'X-Api-Key', 'Proxy-Authorization', 'X-Auth-Token']) {
      expect(one(entry({ headers: { [h]: 'x' } })), h).toContain('checks[0] (x): no credentials in the smoke list');
    }
  });
  it('treats JSON pointers as literal ({slug} in an OpenAPI path is not a placeholder)', () => {
    expect(one(entry({ json_contains: [{ pointer: '/paths/~1v1~1sections~1{slug}~1tags', contains: 'x' }] }))).toEqual([]);
  });
});

describe('evaluate', () => {
  it('status, headers and body', () => {
    const e = entry({ header_contains: { link: '<{base}/s/general.md?sort=top>' }, body_contains: ['"environment":"{environment}"'], body_not_contains: ['oops'] });
    expect(evaluate(e, res(200, '{"environment":"staging"}', { link: '<https://staging.commonworld.one/s/general.md?sort=top>; rel="alternate"' }), vars)).toEqual([]);
    const fails = evaluate(e, res(404, 'oops', {}), vars);
    expect(fails.join(' | ')).toMatch(/status 404, expected 200.*header link missing.*body lacks.*body has "oops"/);
  });
  it('redirect: relative and absolute Location compare equal', () => {
    const e = entry({ status: 301, redirect: '/t/target.md' });
    expect(evaluate(e, res(301, '', { location: '/t/target.md' }), vars)).toEqual([]);
    expect(evaluate(e, res(301, '', { location: 'https://staging.commonworld.one/t/target.md' }), vars)).toEqual([]);
    expect(evaluate(e, res(301, '', { location: '/t/other.md' }), vars)[0]).toMatch(/redirect to \/t\/other\.md/);
  });
  it('JSON pointers', () => {
    const e = entry({ json_contains: [{ pointer: '/paths/~1v1~1porch/get/description', contains: 'invalid_query_parameter' }, { pointer: '/head_seq', contains: '' }] });
    expect(evaluate(e, res(200, JSON.stringify({ head_seq: 0, paths: { '/v1/porch': { get: { description: 'Error codes: invalid_query_parameter.' } } } })), vars)).toEqual([]);
    expect(evaluate(e, res(200, '{"paths":{}}'), vars).join(' | ')).toMatch(/missing.*missing/);
    expect(evaluate(e, res(200, '<html>'), vars)).toContain('body is not JSON');
  });
  it('expand needs a value for every placeholder', () => {
    expect(expand('/posts/{post}.md', vars)).toBe('/posts/17.md');
    expect(() => expand('/posts/{post}', { base: vars.base })).toThrow(/no value for \{post\}/);
  });
  it('environment from the host', () => {
    expect(environmentFor('https://commonworld.one')).toBe('production');
    expect(environmentFor('https://staging.commonworld.one')).toBe('staging');
    expect(environmentFor('http://localhost:8787')).toBeUndefined();
  });
});

describe('runEntry', () => {
  it('PASS, FAIL with retries, SKIP, and FAIL when {post} could not be found', async () => {
    let calls = 0;
    const flaky = async () => { calls++; return new Response('ok', { status: calls < 3 ? 503 : 200 }); };
    expect((await runEntry(entry({}), vars, flaky, { retries: 2, delayMs: 0 })).result).toBe('PASS');
    expect(calls).toBe(3);
    const down = async () => new Response('', { status: 500 });
    const r = await runEntry(entry({ id: 'down' }), vars, down, { retries: 1, delayMs: 0 });
    expect(r.result).toBe('FAIL');
    expect(r.line).toMatch(/^FAIL down GET \/ \[#1\] -> 500: status 500, expected 200$/);
    expect((await runEntry(entry({ skip: 'no fixture on either environment' }), vars, down)).result).toBe('SKIP');
    const v = await discover({ base: vars.base }, async () => new Response('{"items":[]}', { status: 200 }));
    const noPost = await runEntry(entry({ path: '/posts/{post}' }), v, down);
    expect(noPost.result).toBe('FAIL');
    expect(noPost.line).toMatch(/no value for \{post\}.*no post number/);
  });
  it('sends no redirect-following request and only the listed method', async () => {
    const seen: RequestInit[] = [];
    const spy = async (_u: string, init?: RequestInit) => { seen.push(init ?? {}); return new Response(null, { status: 301, headers: { location: '/t/b' } }); };
    expect((await runEntry(entry({ status: 301, redirect: '/t/b', method: 'HEAD' }), vars, spy)).result).toBe('PASS');
    expect(seen[0]).toMatchObject({ method: 'HEAD', redirect: 'manual' });
  });
  it('is read-only on its own: refuses a write method or credential headers without making a request', async () => {
    let calls = 0;
    const spy = async () => { calls++; return new Response('ok', { status: 200 }); };
    const post = await runEntry(entry({ method: 'POST' as 'GET', headers: { Authorization: 'Bearer x' } }), vars, spy);
    expect(post.result).toBe('FAIL');
    expect(post.line).toMatch(/refused, method POST is not GET or HEAD/);
    for (const h of ['Authorization', 'cookie', 'X-API-KEY', 'proxy-authorization']) {
      const r = await runEntry(entry({ headers: { [h]: 'secret' } }), vars, spy);
      expect(r.result, h).toBe('FAIL');
      expect(r.line, h).toMatch(/refused, credential header/);
    }
    expect((await runEntry(entry({ method: 'DELETE' as 'GET', skip: 'skipped writes are refused too' }), vars, spy)).result).toBe('FAIL');
    expect((await runEntry(entry({ headers: null as unknown as Record<string, string> }), vars, spy)).line).toMatch(/refused, "headers" must map/);
    expect(calls).toBe(0);
    expect(readOnlyRefusal(entry({ method: 'HEAD', headers: { accept: 'text/markdown' } }))).toBeNull();
    expect(readOnlyRefusal(entry({}))).toBeNull();
  });
  it('discovers the newest post', async () => {
    const v = await discover({ base: vars.base }, async (u) => { expect(u).toBe('https://staging.commonworld.one/v1/posts?limit=1'); return Response.json({ items: [{ number: 159 }] }); });
    expect(v.post).toBe(159);
  });
});
