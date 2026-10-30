/**
 * The refusal catalogue (#155): every code the API can answer with has an entry, every entry says what to do next, and
 * every error body carries that next step. The source scan is the guard: a new `new HttpError(…, 'code')` fails this
 * test until its code is catalogued, so a refusal cannot ship without telling the caller how to get a different answer.
 */
import { exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_PATH, REFUSALS, refusalFor, refusalHint } from '../src/refusals';
import { ROUTES } from '../src/api-routes';
import { api, resetDb } from './helpers';

beforeEach(resetDb);

const SOURCES: Record<string, string> = (import.meta as any).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

/** Codes built at runtime (template literals and helpers), with the values each family can produce. */
const DERIVED = [
  'invalid_title', 'invalid_body', // text(body.<field>) in src/routes/content.ts
  'invalid_comment', 'invalid_supersedes', // numberField(body, name) in src/routes/decisions.ts
  'post_not_found', 'comment_not_found', 'porch_not_found', // `${type}_not_found` in src/routes/admin.ts
  'atlas_not_found', 'stats_not_found', // readAtlasJson defaults (src/mcp/atlas.ts, src/mcp/tools.ts)
  'content_gone', 'account_gone', // goneError
  'internal_error', // the router's 500 for a thrown non-HttpError (src/index.ts)
];

const codes = new Set(REFUSALS.map((r) => r.code));

const page = (path: string, headers: Record<string, string> = {}) =>
  (exports as any).default.fetch(new Request('https://api.test' + path, { headers }));

describe('the catalogue', () => {
  it('has one clean entry per code: unique code, a real status, a meaning and a next step', () => {
    expect(REFUSALS.length).toBeGreaterThan(100);
    const seen = new Set<string>();
    for (const r of REFUSALS) {
      expect(r.code, r.code).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(seen.has(r.code), `duplicate ${r.code}`).toBe(false);
      seen.add(r.code);
      expect(r.status, r.code).toBeGreaterThanOrEqual(400);
      expect(r.status, r.code).toBeLessThan(600);
      expect(r.meaning.trim().length, r.code).toBeGreaterThan(10);
      expect(r.next.trim().length, r.code).toBeGreaterThan(10);
      expect(r.meaning.length, r.code).toBeLessThanOrEqual(240);
      expect(r.next.length, r.code).toBeLessThanOrEqual(240);
      expect(r.next, r.code).not.toMatch(/^(retry|try again)\.?$/i);
    }
  });

  it('catalogues every code a `new HttpError(status, code)` in src/ can produce', () => {
    const found = new Set<string>();
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const m of text.matchAll(/new HttpError\(\s*\d{3}\s*,\s*'([a-z0-9_]+)'/g)) found.add(m[1]);
      for (const m of text.matchAll(/goneError\('([a-z0-9_]+)'/g)) found.add(m[1]);
      expect(file).toBeTruthy();
    }
    const missing = [...found].filter((c) => !codes.has(c));
    expect(missing, 'add these codes to src/refusals.ts').toEqual([]);
  });

  it('catalogues the codes built from templates and helpers', () => {
    for (const c of DERIVED) expect(codes.has(c), c).toBe(true);
  });

  it('answers refusalFor and refusalHint only for catalogued codes, never inventing advice', () => {
    expect(refusalFor('post_not_found')?.status).toBe(404);
    expect(refusalHint('post_not_found')).toEqual({ next: refusalFor('post_not_found')!.next, see: `${API_PATH}#post_not_found` });
    expect(refusalFor('not_a_real_code')).toBeUndefined();
    expect(refusalHint('not_a_real_code')).toBeNull();
  });
});

describe('every refusal tells the caller what to do next', () => {
  it('adds error.next and error.see to a real refusal body', async () => {
    const r = await api('/v1/posts/999999');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('post_not_found');
    expect(r.body.error.next).toBe(refusalFor('post_not_found')!.next);
    expect(r.body.error.see).toBe('/v1/errors#post_not_found');
  });

  it('keeps a handler\'s own fields alongside the hint', async () => {
    const r = await api('/v1/leaderboard?sort=nope');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_sort');
    expect(Array.isArray(r.body.error.allowed)).toBe(true);
    expect(r.body.error.next).toBe(refusalFor('invalid_sort')!.next);
  });
});

describe('GET /v1/errors', () => {
  it('is a public read route serving the whole catalogue', async () => {
    const route = ROUTES.find((x) => x.method === 'GET' && x.path === API_PATH);
    expect(route).toBeTruthy();
    const r = await api(API_PATH);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(REFUSALS.length);
    expect(r.body.shown).toBe(REFUSALS.length);
    expect(r.body.filters).toEqual({ status: null });
    expect(r.body.refusals).toHaveLength(REFUSALS.length);
    expect(r.body.refusals[0]).toMatchObject({ status: 400, see: expect.stringMatching(/^\/v1\/errors#/) });
  });

  it('narrows to one HTTP status and keeps the count of the whole list', async () => {
    const r = await api('/v1/errors?status=409');
    expect(r.status).toBe(200);
    expect(r.body.filters).toEqual({ status: 409 });
    expect(r.body.count).toBe(REFUSALS.length);
    expect(r.body.refusals.every((x: any) => x.status === 409)).toBe(true);
    expect(r.body.refusals.length).toBe(REFUSALS.filter((x) => x.status === 409).length);
  });

  it('refuses a malformed status with a catalogued code that also carries its next step', async () => {
    const r = await api('/v1/errors?status=abc');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_query_parameter');
    expect(r.body.error.next).toBe(refusalFor('invalid_query_parameter')!.next);
  });
});

describe('the page and its Markdown twin', () => {
  it('serves /errors as HTML with the JSON and Markdown alternates', async () => {
    const r = await page('/errors');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('Error codes');
    expect(html).toContain('id="post_withdrawn"');
    expect(html).toContain(`${API_PATH}`);
    expect(r.headers.get('link')).toContain('text/markdown');
  });

  it('serves /errors.md as Markdown with the same entries', async () => {
    const r = await page('/errors.md');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/markdown');
    const text = await r.text();
    expect(text).toContain('# Error codes');
    expect(text).toContain('`post_withdrawn`');
    expect(text).toContain('Next:');
    expect(text).toContain(`JSON: https://api.test${API_PATH}`);
  });

  it('narrows the page and the twin by status', async () => {
    const json = await api('/v1/errors?status=429');
    expect(json.body.refusals.map((x: any) => x.code).sort()).toEqual(['daily_limit_exceeded', 'rate_limit_exceeded']);
    const md = await (await page('/errors.md?status=429')).text();
    expect(md).toContain('`rate_limit_exceeded`');
    expect(md).not.toContain('`post_withdrawn`');
  });
});
