/**
 * Issue #78 (reported by den924330-code): /search?type=citizens found a citizen by bare handle but not by "@handle" or
 * by a citizen-N ref, though the search page advertises both. For citizens only, a leading "@" is dropped and citizen-N
 * also resolves the account by number, with the same visibility rule (active accounts only). Posts, comments and porch
 * lines still match the text as typed. Same behavior on the HTML page and on the markdown twin (/search.md).
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { search } from '../src/pages/data';
import { post, register, resetDb, setSetting } from './helpers';

beforeEach(resetDb);

const ORIGIN = 'https://cw.test';
async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual' }), { ...env, PUBLIC_EDGE_CACHE: '0' } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text() };
}
const html = (q: string) => get(`/search?q=${encodeURIComponent(q)}&type=citizens`);
const md = (q: string) => get(`/search.md?q=${encodeURIComponent(q)}`);
const profileLink = (handle: string) => `href="/c/${handle}"`;

describe('search: citizen lookup by @handle and citizen-N (#78)', () => {
  it('finds a citizen by bare handle (unchanged)', async () => {
    const a = await register('pore-hunt', 'agent', 24);
    const r = await html(a.handle);
    expect(r.status).toBe(200);
    expect(r.text).toContain(`citizen-${a.number}</a>`);
    expect(r.text).toContain(profileLink(a.handle));
    expect((await search(env as any, a.handle)).citizens.map((c) => c.number)).toEqual([a.number]);
  });

  it('finds a citizen by @handle (leading @ dropped for the citizen match only)', async () => {
    const a = await register('pore-hunt', 'agent', 24);
    const r = await html(`@${a.handle}`);
    expect(r.text).toContain(`citizen-${a.number}</a>`);
    expect(r.text).toContain(profileLink(a.handle));
    expect(r.text).not.toContain('Nothing matches');
    const m = await md(`@${a.handle}`);
    expect(m.text).toContain(`citizen-${a.number}, joined`);
    // the uppercase form works too (ASCII lowercasing as before)
    expect((await search(env as any, `@${a.handle.toUpperCase()}`)).citizens.map((c) => c.number)).toEqual([a.number]);
  });

  it('keeps the original text for posts, comments and porch lines', async () => {
    await setSetting('limits.daily.post', 100);
    const a = await register('pore-hunt', 'agent', 24 * 10);
    const p = (await post(a.key, 'Ping for a citizen', { section: 'general', body: 'Thanks @mentioned-one for the notes.' })).body;
    const withAt = await search(env as any, '@mentioned-one');
    expect(withAt.posts.map((x) => x.number)).toEqual([p.number]);
    // the post body has no "@pore-hunt", so the post does not match that query, but the citizen does
    const r = await search(env as any, `@${a.handle}`);
    expect(r.posts).toEqual([]);
    expect(r.citizens.map((c) => c.number)).toEqual([a.number]);
  });

  it('resolves a valid citizen-N ref: result card plus a jump link, on the page and on the markdown twin', async () => {
    const a = await register('pore-hunt', 'agent', 24);
    const b = await register('other-one', 'human', 24);
    const ref = `citizen-${a.number}`;
    const r = await html(ref);
    expect(r.text).toContain(`Open ${ref} →`);
    expect(r.text).toContain(profileLink(a.handle));
    expect(r.text).not.toContain(profileLink(b.handle));
    expect(r.text).not.toContain('Nothing matches');
    // case-insensitive ref, as for post-N
    expect((await html(`CITIZEN-${a.number}`)).text).toContain(profileLink(a.handle));
    const m = await md(ref);
    expect(m.text).toContain(`- Ref: [${ref}](${ORIGIN}/c/${a.handle})`);
    expect(m.text).toContain(`citizen-${a.number}, joined`);
    const d = await search(env as any, ref);
    expect(d.ref).toEqual({ type: 'citizen', number: a.number, handle: a.handle });
    expect(d.citizens[0].number).toBe(a.number);
  });

  it('a citizen-N ref for a missing account finds nothing and shows no jump link', async () => {
    await register('pore-hunt', 'agent', 24);
    const r = await html('citizen-999999');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('Open citizen-999999');
    expect(r.text).toContain('Nothing matches');
    const m = await md('citizen-999999');
    expect(m.text).not.toContain('- Ref:');
    expect(m.text).toContain('_No citizens match._');
    const d = await search(env as any, 'citizen-999999');
    expect(d.ref).toBeNull();
    expect(d.citizens).toEqual([]);
  });

  it('frozen and disabled accounts stay out of citizen results by handle, @handle and citizen-N', async () => {
    const frozen = await register('pore-frozen', 'agent', 24);
    const disabled = await register('pore-gone', 'agent', 24);
    await env.DB.prepare("UPDATE accounts SET status = 'frozen' WHERE number = ?").bind(frozen.number).run();
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE number = ?").bind(disabled.number).run();
    for (const a of [frozen, disabled]) {
      for (const q of [a.handle, `@${a.handle}`, `citizen-${a.number}`]) {
        const d = await search(env as any, q);
        expect(d.citizens, q).toEqual([]);
        expect(d.ref, q).toBeNull();
        const r = await html(q);
        expect(r.text, q).not.toContain(profileLink(a.handle));
        expect(r.text, q).not.toContain(`Open citizen-${a.number}`);
        expect((await md(q)).text, q).toContain('_No citizens match._');
      }
    }
  });

  it('post-N refs still get their jump link (no change)', async () => {
    const r = await html('post-12');
    expect(r.text).toContain('Open post-12 →');
    expect((await md('post-12')).text).toContain(`- Ref: [post-12](${ORIGIN}/posts/12)`);
  });

  it('includes sections and tags in search markdown twin (#200)', async () => {
    const a = await register('pore-tags', 'agent', 24 * 10);
    await post(a.key, 'Test post for section and tag search', { section: 'general', body: 'Hello world', tags: ['twin-tag'] });
    const m = await md('general');
    expect(m.status).toBe(200);
    expect(m.text).toContain('## Sections');
    expect(m.text).toContain(`[General](${ORIGIN}/s/general)`);

    const mTag = await md('twin-tag');
    expect(mTag.status).toBe(200);
    expect(mTag.text).toContain('## Tags');
    expect(mTag.text).toContain(`[#twin-tag](${ORIGIN}/t/twin-tag)`);
  });
});
