/**
 * #88: a malformed percent-encoding in a path parameter (`%`, `%2`, `%zz`, a cut UTF-8 sequence) made
 * `decodeURIComponent` throw `URIError`, which the router answered as 500 `internal_error`. The API now answers it
 * like a segment that names nothing: 404 `account_not_found` (accounts, admin, deletion) or `tag_not_found` (tags).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { HttpError, decodePathParam } from '../src/http';
import { api, makeAdmin, register, resetDb } from './helpers';

beforeEach(async () => {
  await resetDb();
});

const MALFORMED = ['%', '%2', '%zz', 'abc%', '%E0%A4%A'];

describe('decodePathParam', () => {
  const nf = () => new HttpError(404, 'account_not_found');

  it('decodes valid escapes', () => {
    expect(decodePathParam('alice', nf)).toBe('alice');
    expect(decodePathParam('a%2Db', nf)).toBe('a-b');
    expect(decodePathParam('%C3%A9', nf)).toBe('é');
  });

  it('turns URIError into the given not-found error', () => {
    for (const raw of MALFORMED) {
      let caught: unknown;
      try { decodePathParam(raw, nf); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(404);
      expect((caught as HttpError).code).toBe('account_not_found');
    }
  });
});

describe('malformed percent-encoding in API paths (#88)', () => {
  it('GET /v1/accounts/{handle} answers 404 account_not_found, not 500', async () => {
    for (const raw of MALFORMED) {
      const r = await api(`/v1/accounts/${raw}`);
      expect(r.status, raw).toBe(404);
      expect(r.body.error.code, raw).toBe('account_not_found');
    }
    // control: a well-formed escape of an existing handle still resolves
    const who = await register('decode');
    const ok = await api(`/v1/accounts/${encodeURIComponent(who.handle).replace('-', '%2D')}`);
    expect(ok.status).toBe(200);
  });

  it('admin account routes answer 404 account_not_found, not 500', async () => {
    const admin = await makeAdmin();
    for (const raw of MALFORMED) {
      const limits = await api(`/v1/admin/accounts/${raw}/limits`, { method: 'PUT', key: admin.key, body: { daily_post: 5 } });
      expect(limits.status, raw).toBe(404);
      expect(limits.body.error.code, raw).toBe('account_not_found');
      const del = await api(`/v1/admin/accounts/${raw}/limits`, { method: 'DELETE', key: admin.key });
      expect(del.status, raw).toBe(404);
      expect(del.body.error.code, raw).toBe('account_not_found');
      const status = await api(`/v1/admin/accounts/${raw}/status`, { key: admin.key, body: { status: 'active', reason: 'test' } });
      expect(status.status, raw).toBe(404);
      expect(status.body.error.code, raw).toBe('account_not_found');
    }
  });

  it('POST /v1/admin/accounts/{handle}/delete answers 404 account_not_found, not 500', async () => {
    const admin = await makeAdmin();
    for (const raw of MALFORMED) {
      const r = await api(`/v1/admin/accounts/${raw}/delete`, { key: admin.key, body: { confirm_handle: raw } });
      expect(r.status, raw).toBe(404);
      expect(r.body.error.code, raw).toBe('account_not_found');
    }
  });

  it('admin tag routes never answer 500 for a malformed slug', async () => {
    const admin = await makeAdmin();
    for (const raw of MALFORMED) {
      for (const action of ['merge', 'archive']) {
        const r = await api(`/v1/admin/tags/${raw}/${action}`, { key: admin.key, body: { into: 'memory', note: 'n' } });
        expect(r.status, `${action} ${raw}`).toBe(404);
      }
    }
  });
});
