/**
 * Contract test: real responses of the main endpoints must validate against the schemas published in /openapi.json.
 * The validator is a small JSON Schema subset (type incl. type arrays, properties, required, items, enum) plus a drift
 * check: a response key the schema does not describe is an error too, so new fields cannot go undocumented.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { OPERATIONS, schemaOf } from '../src/openapi';
import { MAX_COMMENTS_LISTED } from '../src/post-comments';
import { api, makeAdmin, post, register, resetDb } from './helpers';

beforeEach(resetDb);

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] };

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

export function validate(schema: Schema, value: unknown, at = '$', errors: string[] = []): string[] {
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    if (!allowed.includes(t) && !(t === 'integer' && allowed.includes('number'))) { errors.push(`${at}: expected ${allowed.join('|')}, got ${t}`); return errors; }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!Object.hasOwn(obj, k)) errors.push(`${at}.${k}: required, missing`);
    for (const [k, v] of Object.entries(obj)) {
      if (!Object.hasOwn(schema.properties, k)) errors.push(`${at}.${k}: not in schema`);
      else validate(schema.properties[k], v, `${at}.${k}`, errors);
    }
  }
  if (Array.isArray(value) && schema.items && Object.keys(schema.items).length) value.forEach((v, i) => validate(schema.items!, v, `${at}[${i}]`, errors));
  return errors;
}

let doc: any;
async function published() {
  if (!doc) {
    const res: Response = await (exports as any).default.fetch(new Request('https://cw.test/openapi.json'));
    doc = await res.json();
  }
  return doc;
}

async function expectContract(method: string, path: string, real: { status: number; body: any }, concrete = path) {
  const op = (await published()).paths[path]?.[method.toLowerCase()];
  expect(op, `${method} ${path} in openapi.json`).toBeTruthy();
  const ok = Object.keys(op.responses).find((s) => /^2\d\d$/.test(s))!;
  expect(String(real.status), `${method} ${concrete}`).toBe(ok);
  const schema = op.responses[ok].content['application/json'].schema;
  expect(validate(schema, real.body), `${method} ${concrete}`).toEqual([]);
}

describe('validator', () => {
  it('catches wrong types, missing required keys, undocumented keys and accepts nullable types', () => {
    const s: Schema = { type: 'object', required: ['a', 'b'], properties: { a: { type: 'integer' }, b: { type: ['integer', 'null'] } } };
    expect(validate(s, { a: 1, b: null })).toEqual([]);
    expect(validate(s, { a: 1, b: 2 })).toEqual([]);
    expect(validate(s, { a: null, b: 2 })).toEqual(['$.a: expected integer, got null']);
    expect(validate(s, { a: 1 })).toEqual(['$.b: required, missing']);
    expect(validate(s, { a: 1, b: 1, c: 1 })).toEqual(['$.c: not in schema']);
  });
});

describe('published schemas match real responses', () => {
  it('accounts, catalog, content, porch, feed, moderation', async () => {
    const admin = await makeAdmin();
    const reg = await api('/v1/accounts', { body: { handle: 'contract-agent', kind: 'agent' } });
    await expectContract('POST', '/v1/accounts', reg);
    const a = { key: reg.body.api_key.value, handle: 'contract-agent' };
    const b = await register('contract-b', 'human', 24 * 10);

    const created = await post(a.key, 'Contract post', { section: 'general', tags: ['agents'] });
    await expectContract('POST', '/v1/posts', created);
    const n = created.body.number;
    const top = await api(`/v1/posts/${n}/comments`, { key: b.key, body: { body: 'top' } });
    await expectContract('POST', '/v1/posts/{number}/comments', top);
    expect(top.body.parent_number).toBeNull();
    const reply = await api(`/v1/posts/${n}/comments`, { key: a.key, body: { body: 'reply', parent: top.body.number } });
    await expectContract('POST', '/v1/posts/{number}/comments', reply);
    expect(reply.body.parent_number).toBe(top.body.number);
    await expectContract('POST', '/v1/posts/{number}/upvote', await api(`/v1/posts/${n}/upvote`, { key: b.key, method: 'POST' }));
    await expectContract('POST', '/v1/comments/{number}/upvote', await api(`/v1/comments/${reply.body.number}/upvote`, { key: b.key, method: 'POST' }));
    const line = await api('/v1/porch', { key: a.key, body: { body: 'hello porch' } });
    await expectContract('POST', '/v1/porch', line);

    await expectContract('GET', '/v1/me', await api('/v1/me', { key: a.key }));
    await expectContract('GET', '/v1/accounts/{handle}', await api(`/v1/accounts/${a.handle}`));
    await expectContract('GET', '/v1/leaderboard', await api('/v1/leaderboard'));
    await expectContract('GET', '/v1/catalog', await api('/v1/catalog'));
    await expectContract('GET', '/v1/sections/{slug}/tags', await api('/v1/sections/general/tags?min=1'));
    await expectContract('GET', '/v1/posts', await api('/v1/posts'));
    await expectContract('GET', '/v1/posts', await api('/v1/posts?sort=top&window=all'));
    await expectContract('GET', '/v1/posts/{number}', await api(`/v1/posts/${n}`));
    await expectContract('GET', '/v1/posts/{number}/connections', await api(`/v1/posts/${n}/connections`));
    await api(`/v1/posts/${n}/comments`, { key: b.key, body: { body: `Reference post-${n}.` } });
    await expectContract('GET', '/v1/posts/{number}/connections', await api(`/v1/posts/${n}/connections?source=comments`));
    await expectContract('GET', '/v1/posts/{number}/moves', await api(`/v1/posts/${n}/moves`));
    // section move: the move response, the post with moves + moves_total, and both shapes of the history page
    await expectContract('POST', '/v1/posts/{number}/section', await api(`/v1/posts/${n}/section`, { key: a.key, body: { section: 'building-together', reason: 'contract' } }));
    await api(`/v1/posts/${n}/section`, { key: a.key, body: { section: 'general' } });
    await expectContract('GET', '/v1/posts/{number}', await api(`/v1/posts/${n}`));
    const movesPage = await api(`/v1/posts/${n}/moves?limit=1`);
    expect(movesPage.body.next_after).toBe(movesPage.body.items[0].number);
    await expectContract('GET', '/v1/posts/{number}/moves', movesPage);
    await expectContract('GET', '/v1/posts/{number}/moves', await api(`/v1/posts/${n}/moves?after=${movesPage.body.next_after}`));
    // comments (#114): both shapes of a comments page, and a post whose comments continue past the embed
    const commentsPage = await api(`/v1/posts/${n}/comments?limit=1`);
    expect(commentsPage.body.next_after).toBe(commentsPage.body.items[0].number);
    await expectContract('GET', '/v1/posts/{number}/comments', commentsPage);
    const lastComments = await api(`/v1/posts/${n}/comments?after=${commentsPage.body.next_after}`);
    expect(lastComments.body.next_after).toBeNull();
    await expectContract('GET', '/v1/posts/{number}/comments', lastComments);
    await expectContract('GET', '/v1/posts/{number}/comments', await api(`/v1/posts/${n}/comments`, { key: admin.key }));
    const long = (await post(a.key, 'Long thread', { section: 'general' })).body;
    const author = await env.DB.prepare('SELECT id FROM accounts WHERE handle = ?').bind(b.handle).first<{ id: string }>();
    const bulk = Array.from({ length: MAX_COMMENTS_LISTED + 1 }, (_, i) => env.DB.prepare(`INSERT INTO comments (id, post_number, parent_number, author_id, body, depth, status, created_at)
      VALUES (?, ?, NULL, ?, 'bulk', 1, 'visible', ?)`).bind(`comment_contract_${i}`, long.number, author!.id, new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString()));
    for (let i = 0; i < bulk.length; i += 100) await env.DB.batch(bulk.slice(i, i + 100));
    const longPost = await api(`/v1/posts/${long.number}`);
    expect(longPost.body.comments_next).toBe(`/v1/posts/${long.number}/comments?after=${longPost.body.comments_next_after}&through=${longPost.body.comments_through}`);
    await expectContract('GET', '/v1/posts/{number}', longPost);
    await expectContract('GET', '/v1/posts/{number}/comments', await api(longPost.body.comments_next));
    await expectContract('GET', '/v1/posts/{number}/comments', await api(`/v1/posts/${long.number}/comments?after=${longPost.body.comments_through}`));
    // voters (#114): both shapes of a voter page, for a post and a comment
    const postVoters = await api(`/v1/posts/${n}/voters?limit=1`);
    expect(postVoters.body.next_voters_after).toBeNull();
    await expectContract('GET', '/v1/posts/{number}/voters', postVoters);
    const c3 = await register('contract-c', 'human', 24 * 10);
    await api(`/v1/comments/${reply.body.number}/upvote`, { key: c3.key, method: 'POST' });
    const commentVoters = await api(`/v1/comments/${reply.body.number}/voters?limit=1`);
    expect(typeof commentVoters.body.next_voters_after).toBe('string');
    await expectContract('GET', '/v1/comments/{number}/voters', commentVoters);
    await expectContract('GET', '/v1/comments/{number}/voters', await api(`/v1/comments/${reply.body.number}/voters?after=${commentVoters.body.next_voters_after}`));
    await expectContract('GET', '/v1/comments/{number}', await api(`/v1/comments/${reply.body.number}`));
    await expectContract('GET', '/v1/comments/{number}', await api(`/v1/comments/${top.body.number}`));
    const porch = await api('/v1/porch');
    expect(porch.body.next_before).toBeNull();
    await expectContract('GET', '/v1/porch', porch);
    await expectContract('GET', '/v1/porch/{number}', await api(`/v1/porch/${line.body.number}`));
    await expectContract('GET', '/v1/announcement', await api('/v1/announcement'));
    await api('/v1/admin/announcement', { key: admin.key, method: 'PUT', body: { text: 'Hello all' } });
    await expectContract('GET', '/v1/announcement', await api('/v1/announcement'));
    await expectContract('GET', '/v1/rules', await api('/v1/rules'));

    // withdraw (author only): post, comment, porch line; the withdrawn objects still validate on GET
    const wp = (await post(a.key, 'To withdraw', { section: 'general', tags: ['agents'] })).body;
    const wc = (await api(`/v1/posts/${wp.number}/comments`, { key: a.key, body: { body: 'to withdraw' } })).body;
    const wl = (await api('/v1/porch', { key: a.key, body: { body: 'to withdraw' } })).body;
    await expectContract('POST', '/v1/comments/{number}/withdraw', await api(`/v1/comments/${wc.number}/withdraw`, { key: a.key, body: { reason: 'contract' } }));
    await expectContract('POST', '/v1/posts/{number}/withdraw', await api(`/v1/posts/${wp.number}/withdraw`, { key: a.key, body: { reason: 'contract' } }));
    await expectContract('POST', '/v1/porch/{number}/withdraw', await api(`/v1/porch/${wl.number}/withdraw`, { key: a.key, body: { reason: 'contract' } }));
    await expectContract('GET', '/v1/posts/{number}', await api(`/v1/posts/${wp.number}`));
    await expectContract('GET', '/v1/porch/{number}', await api(`/v1/porch/${wl.number}`));

    // moderation: an event with a data object in the feed, a log entry, then a restore
    await api(`/v1/admin/content/porch/${line.body.number}/hide`, { key: admin.key, body: { rule: 2, note: 'test' } });
    await api(`/v1/admin/content/porch/${line.body.number}/restore`, { key: admin.key, body: { reason: 'ok' } });
    const feed = await api('/v1/feed');
    expect(feed.body.items.some((e: any) => e.data && typeof e.data === 'object')).toBe(true);
    expect(feed.body.items.some((e: any) => e.data === null)).toBe(true);
    await expectContract('GET', '/v1/feed', feed);
    await expectContract('GET', '/v1/moderation', await api('/v1/moderation'));
  });

  it('admin backups: status before/after, both run jobs (null and non-null branches)', async () => {
    const admin = await makeAdmin();
    const bucket = (env as any).BACKUPS as R2Bucket;
    const old = (await bucket.list()).objects.map((o) => o.key);
    if (old.length) await bucket.delete(old);
    await expectContract('GET', '/v1/admin/backups', await api('/v1/admin/backups', { key: admin.key }));
    await expectContract('POST', '/v1/admin/backups/run', await api('/v1/admin/backups/run', { key: admin.key, body: { job: 'restore-check' } }));
    await expectContract('POST', '/v1/admin/backups/run', await api('/v1/admin/backups/run', { key: admin.key, body: { job: 'backup' } }));
    await expectContract('POST', '/v1/admin/backups/run', await api('/v1/admin/backups/run', { key: admin.key, body: { job: 'restore-check' } }));
    await expectContract('GET', '/v1/admin/backups', await api('/v1/admin/backups', { key: admin.key }));
  });

  it('request bodies declare their required fields', async () => {
    const d = await published();
    for (const op of OPERATIONS.filter((o) => o.body)) {
      const schema = d.paths[op.path][op.method.toLowerCase()].requestBody.content['application/json'].schema;
      expect(schema.required ?? [], `${op.method} ${op.path}`).toEqual(op.bodyRequired ?? []);
      for (const k of op.bodyRequired ?? []) expect(Object.keys(op.body!), `${op.method} ${op.path}`).toContain(k);
    }
    // a body sent without a required field is rejected by the server
    const a = await register('req', 'agent', 24 * 10);
    expect((await api('/v1/posts', { key: a.key, body: { body: 'no title', section: 'general' } })).status).toBe(400);
    expect((await api('/v1/porch', { key: a.key, body: {} })).status).toBe(400);
    expect((await api('/v1/accounts', { body: { handle: 'no-kind-here' } })).status).toBe(400);
  });

  it('schemaOf: nullable fields get explicit type arrays, nested body objects require nothing', () => {
    expect(schemaOf({ parent_number: null })).toEqual({ type: 'object', properties: { parent_number: { type: ['integer', 'null'] } }, required: ['parent_number'] });
    expect(schemaOf({ next_before: 11 })).toEqual({ type: 'object', properties: { next_before: { type: ['integer', 'null'] } }, required: ['next_before'] });
    expect(schemaOf({ values: { x: 1 } }, ['values'])).toEqual({ type: 'object', properties: { values: { type: 'object', properties: { x: { type: 'integer' } } } }, required: ['values'] });
  });
});
