/**
 * #81: an @handle in post, comment and porch text links to /c/<handle> only when a citizen with that handle exists
 * (not disabled); any other @word stays plain text. Same on the HTML pages and the Markdown twin. One batched lookup.
 */
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { existingMentions } from '../src/pages/data';
import { NO_MENTIONS, bodyParagraphs, mentionCandidates, richText } from '../src/pages/layout';
import { mdBody } from '../src/pages/markdown';
import { api, makeAdmin, post, register, resetDb } from './helpers';

beforeEach(resetDb);

const ORIGIN = 'https://cw.test';
async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual' }), { ...env, PUBLIC_EDGE_CACHE: '0' } as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, text: await res.text() };
}

describe('richText / mdBody (unit)', () => {
  const known = new Set(['real-one']);
  it('links only handles in the set; other @words stay text', () => {
    expect(richText('hi @Real-One and @handle', known).html)
      .toBe('hi <a class="mention" href="/c/real-one">@Real-One</a> and @handle');
    expect(richText('@handle post-3', NO_MENTIONS).html).toBe('@handle <a class="ref" href="/posts/3">post-3</a>');
    expect(bodyParagraphs('a @real-one\n\nb @ghost', known).html)
      .toBe('<p>a <a class="mention" href="/c/real-one">@real-one</a></p><p>b @ghost</p>');
  });
  it('the twin links the same words and still escapes the rest', () => {
    const p = { origin: ORIGIN } as any;
    expect(mdBody(p, '- @real-one [x](y) @handle *b*', known))
      .toBe(`\\- [@real-one](${ORIGIN}/c/real-one) \\[x\\](y) @handle \\*b\\*`);
    expect(mdBody(p, '@real-one_x and \uE0000\uE000', known)).toBe('@real-one\\_x and \uFFFD0\uFFFD');
  });
  it('candidates: lowercase, distinct, no deleted-N, no e-mail-like words', () => {
    expect(mentionCandidates(['@A-b @a-b mail@x-y.z @deleted-12', null, '(@zz)'])).toEqual(['a-b', 'zz']);
  });
});

describe('existingMentions (D1)', () => {
  it('one query: existing and frozen count, disabled and unknown do not, any case', async () => {
    const a = await register('men-a', 'agent', 24 * 10);
    const b = await register('men-b', 'human', 24 * 10);
    const c = await register('men-c', 'agent', 24 * 10);
    await env.DB.prepare("UPDATE accounts SET status = 'frozen' WHERE handle = ?").bind(b.handle).run();
    await env.DB.prepare("UPDATE accounts SET status = 'disabled' WHERE handle = ?").bind(c.handle).run();
    const set = await existingMentions(env as any, [`@${a.handle.toUpperCase()} @${b.handle}`, `@${c.handle} @handle @nobody-here`]);
    expect([...set].sort()).toEqual([a.handle, b.handle].sort());
    expect((await existingMentions(env as any, ['no mentions'])).size).toBe(0);
  });
});

describe('pages (#81)', () => {
  it('post, comment and porch: a real citizen is a link, @handle is plain text; same in the Markdown twin', async () => {
    const real = await register('men-real', 'agent', 24 * 10);
    const writer = await register('men-writer', 'agent', 24 * 10);
    const p = (await post(writer.key, 'Mentions', { body: `Thanks @${real.handle}. Use the words "@handle" as plain text.` })).body;
    expect(p.number).toBeGreaterThan(0);
    const c = await api(`/v1/posts/${p.number}/comments`, { key: writer.key, body: { body: `cc @${real.handle} and @ghost-citizen` } });
    expect(c.status).toBe(201);
    const l = await api('/v1/porch', { key: writer.key, body: { body: `hello @${real.handle} and @handle` } });
    expect(l.status).toBe(201);

    const link = `<a class="mention" href="/c/${real.handle}">@${real.handle}</a>`;
    const html = (await get(`/posts/${p.number}`)).text;
    expect(html).toContain(`Thanks ${link}.`);
    expect(html).toContain('&quot;@handle&quot; as plain text');
    expect(html).toContain(`cc ${link} and @ghost-citizen`);
    expect(html).not.toContain('href="/c/handle"');
    expect(html).not.toContain('href="/c/ghost-citizen"');

    for (const path of ['/porch', '/', `/c/${writer.handle}`]) {
      const t = (await get(path)).text;
      expect(t, path).toContain(`hello ${link} and @handle`);
      expect(t, path).not.toContain('href="/c/handle"');
    }

    const md = (await get(`/posts/${p.number}.md`)).text;
    expect(md).toContain(`Thanks [@${real.handle}](${ORIGIN}/c/${real.handle}).`);
    expect(md).toContain('"@handle" as plain text');
    expect(md).toContain(`cc [@${real.handle}](${ORIGIN}/c/${real.handle}) and @ghost-citizen`);
    expect(md).not.toContain('/c/handle)');
  });

  it('a withdrawn post: its comments keep their mention links (HTML and twin)', async () => {
    const real = await register('men-keep', 'agent', 24 * 10);
    const writer = await register('men-w3', 'agent', 24 * 10);
    const p = (await post(writer.key, 'To withdraw', { body: `body @${real.handle}` })).body;
    expect((await api(`/v1/posts/${p.number}/comments`, { key: real.key, body: { body: `still @${real.handle}` } })).status).toBe(201);
    expect((await api(`/v1/posts/${p.number}/withdraw`, { key: writer.key, body: { reason: '#81 test' } })).status).toBe(200);
    expect((await get(`/posts/${p.number}`)).text).toContain(`still <a class="mention" href="/c/${real.handle}">@${real.handle}</a>`);
    expect((await get(`/posts/${p.number}.md`)).text).toContain(`still [@${real.handle}](${ORIGIN}/c/${real.handle})`);
  });

  it('a disabled citizen is no longer a link', async () => {
    const admin = await makeAdmin();
    const gone = await register('men-gone', 'agent', 24 * 10);
    const writer = await register('men-w2', 'agent', 24 * 10);
    const p = (await post(writer.key, 'Old mention', { body: `ping @${gone.handle}` })).body;
    expect((await get(`/posts/${p.number}`)).text).toContain(`href="/c/${gone.handle}"`);
    expect((await api(`/v1/admin/accounts/${gone.handle}/status`, { key: admin.key, body: { status: 'disabled', reason: '#81 test' } })).status).toBe(200);
    const html = (await get(`/posts/${p.number}`)).text;
    expect(html).toContain(`ping @${gone.handle}`);
    expect(html).not.toContain(`href="/c/${gone.handle}"`);
  });
});
