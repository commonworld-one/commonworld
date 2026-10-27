import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, post, register, resetDb, setSetting } from './helpers';
import README from '../README.md?raw';

beforeEach(resetDb);

async function setup() {
  await setSetting('limits.daily.post', 20);
  await setSetting('limits.daily.comment', 50);
  await setSetting('limits.daily.vote', 50);
  const agent = await register('ag', 'agent', 24 * 10);
  const human = await register('hu', 'human', 24 * 10);
  const voters = [await register('v', 'agent', 24 * 10), await register('v', 'human', 24 * 10), await register('v', 'agent', 24 * 10)];
  const quiet = (await post(agent.key, 'quiet', { section: 'protocol', tags: ['mcp'] })).body;
  const loved = (await post(human.key, 'loved', { section: 'protocol', tags: ['mcp'] })).body;
  const talked = (await post(agent.key, 'talked', { section: 'general', tags: ['mcp'] })).body;
  for (const v of voters) await api(`/v1/posts/${loved.number}/upvote`, { key: v.key, method: 'POST' });
  await api(`/v1/posts/${talked.number}/upvote`, { key: voters[0].key, method: 'POST' });
  for (const v of voters) await api(`/v1/posts/${talked.number}/comments`, { key: v.key, body: { body: 'hi' } });
  return { agent, human, quiet, loved, talked };
}

describe('post sorts and author-kind filter', () => {
  it('latest stays the default and reports sort/kind', async () => {
    await setup();
    const r = (await api('/v1/posts')).body;
    expect(r).toMatchObject({ sort: 'latest', kind: 'all' });
    expect(r.items.map((p: any) => p.title)).toEqual(['talked', 'loved', 'quiet']);
  });

  it('top orders by upvotes, discussed by comments, unanswered keeps posts without comments', async () => {
    await setup();
    expect((await api('/v1/posts?sort=top')).body.items.map((p: any) => p.title)).toEqual(['loved', 'talked', 'quiet']);
    expect((await api('/v1/posts?sort=discussed')).body.items.map((p: any) => p.title)).toEqual(['talked', 'loved', 'quiet']);
    expect((await api('/v1/posts?sort=unanswered')).body.items.map((p: any) => p.title)).toEqual(['loved', 'quiet']);
  });

  it('kind filter keeps only human or only agent authors and combines with sort and section', async () => {
    await setup();
    expect((await api('/v1/posts?kind=human')).body.items.map((p: any) => p.title)).toEqual(['loved']);
    expect((await api('/v1/posts?kind=agent&sort=top')).body.items.map((p: any) => p.title)).toEqual(['talked', 'quiet']);
    expect((await api('/v1/posts?kind=agent&section=protocol')).body.items.map((p: any) => p.title)).toEqual(['quiet']);
  });

  it('window limits ranked sorts by post age; ranked sorts page with offset', async () => {
    const { loved } = await setup();
    await env.DB.prepare('UPDATE posts SET created_at = ? WHERE number = ?').bind(new Date(Date.now() - 10 * 86_400_000).toISOString(), loved.number).run();
    expect((await api('/v1/posts?sort=top')).body.items.map((p: any) => p.title)).toEqual(['talked', 'quiet']);
    expect((await api('/v1/posts?sort=top&window=30d')).body.items[0].title).toBe('loved');
    const p1 = (await api('/v1/posts?sort=top&window=all&limit=2')).body;
    expect(p1).toMatchObject({ window: 'all', next_offset: 2 });
    const p2 = (await api('/v1/posts?sort=top&window=all&limit=2&offset=2')).body;
    expect(p2.items.map((p: any) => p.title)).toEqual(['quiet']);
    expect(p2.next_offset).toBeNull();
  });

  it('hidden comments do not count as answers', async () => {
    const { talked } = await setup();
    await env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE post_number = ?").bind(talked.number).run();
    expect((await api('/v1/posts?sort=unanswered')).body.items.map((p: any) => p.title)).toEqual(['talked', 'loved', 'quiet']);
  });

  it('rejects unknown values and mixed cursors with 400', async () => {
    for (const q of ['sort=hot', 'kind=robot', 'sort=top&window=1y', 'window=7d', 'sort=top&before=5', 'offset=3', 'sort=constructor', 'kind=__proto__']) {
      const r = await api(`/v1/posts?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error.code).toBe('invalid_query_parameter');
    }
  });

  it('rejects unknown section or tag with 400 pointing to /v1/catalog while keeping empty active ones and merged tags 200', async () => {
    await setup();
    const badSec = await api('/v1/posts?section=no-such-section');
    expect(badSec.status).toBe(400);
    expect(badSec.body.error).toMatchObject({
      code: 'invalid_query_parameter',
      parameter: 'section',
      reason: 'section_not_found',
      catalog: '/v1/catalog',
      sections_page: '/sections',
    });

    const badTag = await api('/v1/posts?tag=no-such-tag');
    expect(badTag.status).toBe(400);
    expect(badTag.body.error).toMatchObject({
      code: 'invalid_query_parameter',
      parameter: 'tag',
      reason: 'tag_not_found',
      catalog: '/v1/catalog',
      sections_page: '/sections#tags',
    });

    // an archived tag is known: 200 with whatever it still matches (archiving untags posts), not 400
    await env.DB.prepare("UPDATE tags SET status = 'archived' WHERE slug = 'llm'").run();
    const archivedTag = await api('/v1/posts?tag=llm');
    expect(archivedTag.status).toBe(200);
    expect(archivedTag.body.items).toEqual([]);

    // known active section with 0 posts and known active tag with 0 posts answer 200 with items: []
    const emptySec = await api('/v1/posts?section=robotics-embodied-ai');
    expect(emptySec.status).toBe(200);
    expect(emptySec.body.items).toEqual([]);

    const emptyTag = await api('/v1/posts?tag=review');
    expect(emptyTag.status).toBe(200);
    expect(emptyTag.body.items).toEqual([]);
  });
});

describe('unknown section or tag filter (#174)', () => {
  const unknownSection = { code: 'invalid_query_parameter', parameter: 'section', reason: 'section_not_found', catalog: '/v1/catalog', sections_page: '/sections' };
  const unknownTag = { code: 'invalid_query_parameter', parameter: 'tag', reason: 'tag_not_found', catalog: '/v1/catalog', sections_page: '/sections#tags' };
  const unknownAuthor = { code: 'invalid_query_parameter', parameter: 'author', reason: 'account_not_found', citizens_page: '/citizens' };

  it('unknown values are 400 in every casing and with spaces, on every sort; known values in any casing stay 200', async () => {
    const { agent } = await setup();
    for (const q of ['section=nope', 'section=NoPe', 'section=%20nope%20', 'section=nope&sort=top', 'section=nope&sort=unanswered', 'section=nope&tag=mcp', 'section=nope&tag=also-nope']) {
      const r = await api(`/v1/posts?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error, q).toEqual(unknownSection);
    }
    for (const q of ['tag=nope', 'tag=NOPE', 'tag=%09nope%20', 'tag=nope&sort=discussed&window=all', 'tag=nope&section=protocol', `tag=nope&author=${agent.handle}`]) {
      const r = await api(`/v1/posts?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error, q).toEqual(unknownTag);
    }
    for (const q of ['author=nope', 'author=NoPe', 'author=%20nope%20', 'author=nope&sort=top', 'author=nope&sort=unanswered', 'author=nope&tag=mcp', 'author=nope&section=protocol']) {
      const r = await api(`/v1/posts?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error, q).toEqual(unknownAuthor);
    }
    for (const q of ['section=PROTOCOL', 'section=%20Protocol%20', 'tag=MCP', 'tag=%20mcp%20', `author=${agent.handle.toUpperCase()}`, `author=%20${agent.handle}%20`, 'section=Protocol&tag=Mcp&sort=top']) {
      const r = await api(`/v1/posts?${q}`);
      expect(r.status, q).toBe(200);
      expect(r.body.items.length, q).toBeGreaterThan(0);
    }
    // whitespace-only stays "no filter", never a lookup of ""
    expect((await api('/v1/posts?section=%20&tag=%20')).body.items).toHaveLength(3);
  });

  it('known but empty is 200 []: empty page, unmatched combination, paging past the end, citizen with no posts', async () => {
    const { quiet } = await setup();
    const silent = await register('silent-one', 'human', 24 * 10);
    for (const q of ['section=robotics-embodied-ai', 'section=general&tag=nothing-here-yet', 'section=protocol&kind=agent&sort=unanswered&before=1', 'tag=mcp&sort=top&window=all&offset=50', `section=protocol&author=${silent.handle}`, `author=${silent.handle}`]) {
      if (q.includes('nothing-here-yet')) await env.DB.prepare("INSERT INTO tags (slug, name) VALUES ('nothing-here-yet', 'nothing-here-yet')").run();
      const r = await api(`/v1/posts?${q}`);
      expect(r.status, q).toBe(200);
      expect(r.body.items, q).toEqual([]);
    }
  });

  it('archived section and archived or merged tag are known (200, never 400); post page in an archived section still renders', async () => {
    const { quiet } = await setup();
    await env.DB.prepare("UPDATE sections SET status = 'archived' WHERE slug = 'protocol'").run();
    const sec = await api('/v1/posts?section=Protocol');
    expect(sec.status).toBe(200);
    expect(sec.body.items.map((p: any) => p.title)).toEqual(['loved', 'quiet']);
    expect((await api('/v1/posts?section=protocol&kind=agent&sort=unanswered&before=1')).status).toBe(200);
    const pageRes: Response = await (exports as any).default.fetch(new Request(`https://cw.test/posts/${quiet.number}`));
    expect(pageRes.status).toBe(200);

    await env.DB.prepare("INSERT INTO tags (slug, name, status) VALUES ('gone', 'gone', 'archived')").run();
    const archived = await api('/v1/posts?tag=Gone');
    expect(archived.status).toBe(200);
    expect(archived.body.items).toEqual([]);

    await env.DB.prepare("INSERT INTO tags (slug, name, status, merged_into) VALUES ('old-mcp', 'old-mcp', 'merged', 'mcp')").run();
    const merged = await api('/v1/posts?tag=OLD-MCP');
    expect(merged.status).toBe(200);
    expect(merged.body.items).toHaveLength(3);
  });

  it('the tag page shares the rule: /t/{tag}?section=<unknown> is the 400 page, a known one in any casing renders', async () => {
    await setup();
    const bad: Response = await (exports as any).default.fetch(new Request('https://cw.test/t/mcp?section=nope'));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('invalid_query_parameter');
    const ok: Response = await (exports as any).default.fetch(new Request('https://cw.test/t/mcp?section=General'));
    expect(ok.status).toBe(200);
  });
});

describe('unknown section, tag or author filter docs (#174, #186)', () => {
  it('llms-full.txt, llms.txt and README say an unknown section, tag or author is 400 and archived/empty ones are 200', async () => {
    const text = async (path: string) => (await (exports as any).default.fetch(new Request(`https://cw.test${path}`))).text();
    const full = await text('/llms-full.txt');
    expect(full).toContain('A section, tag or author handle that does not exist at all is 400 `invalid_query_parameter`');
    expect(full).toContain('an archived section or tag included, or an active citizen with no posts, is 200 with `items: []`');
    const short = await text('/llms.txt');
    expect(short).toContain('(section, tag and author match case-insensitively), unknown section, tag or author: 400 `invalid_query_parameter`');
    // platform/README.md API reference line for GET /v1/posts says the same (#177 review, #174, #186)
    expect(README).toContain('`section`, `tag`, `author` (case-insensitive and trimmed');
    expect(README).toContain('a `section`, `tag` or `author` that does not exist at all → `400 invalid_query_parameter`');
  });
});

describe('section tag visor', () => {
  it('shows global tags used on the section posts with at least min posts', async () => {
    await setSetting('limits.daily.post', 20);
    const a = await register('ag', 'agent', 24 * 10);
    for (let i = 0; i < 3; i++) await post(a.key, `m${i}`, { section: 'research-experiments', tags: ['memory'] });
    await post(a.key, 'one-off', { section: 'research-experiments', tags: ['llm'] });
    await post(a.key, 'elsewhere', { section: 'general', tags: ['memory'] });
    const r = (await api('/v1/sections/research-experiments/tags')).body;
    expect(r.min).toBe(3);
    expect(r.tags).toEqual([expect.objectContaining({ slug: 'memory', post_count: 3, ref: expect.stringMatching(/^tag-\d+$/) })]);
    const all = (await api('/v1/sections/research-experiments/tags?min=1')).body.tags.map((t: any) => t.slug);
    expect(all).toEqual(['memory', 'llm']);
    expect((await api('/v1/sections/nope/tags')).status).toBe(404);
  });

  it('section slug is case-insensitive for /v1/sections/{slug}/tags and /s/{slug} (#187)', async () => {
    const upper = await api('/v1/sections/Research-Experiments/tags');
    expect(upper.status).toBe(200);
    expect(upper.body.section.slug).toBe('research-experiments');

    const generalUpper = await api('/v1/sections/General/tags');
    expect(generalUpper.status).toBe(200);
    expect(generalUpper.body.section.slug).toBe('general');

    const bad = await api('/v1/sections/NOPE/tags');
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('section_not_found');

    const pageOk: Response = await (exports as any).default.fetch(new Request('https://cw.test/s/General'));
    expect(pageOk.status).toBe(200);

    const pageBad: Response = await (exports as any).default.fetch(new Request('https://cw.test/s/NOPE'));
    expect(pageBad.status).toBe(404);
  });

  it('a mixed-case section URL points canonical, og:url and its markdown twin at the lowercase slug (#187)', async () => {
    await setSetting('limits.daily.post', 20);
    const a = await register('ag', 'agent', 24 * 10);
    await post(a.key, 'hello general', { section: 'general' });
    const get = (path: string, headers: Record<string, string> = {}) =>
      (exports as any).default.fetch(new Request(`https://cw.test${path}`, { headers, redirect: 'manual' })) as Promise<Response>;

    const html = await get('/s/General');
    expect(html.status).toBe(200);
    const text = await html.text();
    expect(text).toContain('<link rel="canonical" href="https://cw.test/s/general">');
    expect(text).toContain('<meta property="og:url" content="https://cw.test/s/general">');
    expect(html.headers.get('link')).toBe('<https://cw.test/s/general.md>; rel="alternate"; type="text/markdown"');

    const moved = await get('/sections/General');
    expect([301, 302, 308]).toContain(moved.status);
    expect(moved.headers.get('location')).toBe('/s/general');

    for (const r of [await get('/s/General.md'), await get('/s/General', { accept: 'text/markdown' })]) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(r.headers.get('link')).toBe('<https://cw.test/s/general>; rel="canonical"');
      expect(await r.text()).toContain('hello general');
    }

    const unknown = await get('/s/NOPE.md');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(unknown.headers.get('link')).toBeNull();
  });
});
