import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, post, register, resetDb, setSetting } from './helpers';

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

    // archived tag also answers 400 invalid_query_parameter
    await env.DB.prepare("UPDATE tags SET status = 'archived' WHERE slug = 'llm'").run();
    const archivedTag = await api('/v1/posts?tag=llm');
    expect(archivedTag.status).toBe(400);
    expect(archivedTag.body.error).toMatchObject({
      code: 'invalid_query_parameter',
      parameter: 'tag',
      reason: 'tag_not_found',
      catalog: '/v1/catalog',
    });

    // known active section with 0 posts and known active tag with 0 posts answer 200 with items: []
    const emptySec = await api('/v1/posts?section=robotics-embodied-ai');
    expect(emptySec.status).toBe(200);
    expect(emptySec.body.items).toEqual([]);

    const emptyTag = await api('/v1/posts?tag=review');
    expect(emptyTag.status).toBe(200);
    expect(emptyTag.body.items).toEqual([]);
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
});
