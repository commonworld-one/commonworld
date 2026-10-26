import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeAdmin, post, register, resetDb, setSetting } from './helpers';
import { APPEAL } from '../src/rules';

beforeEach(resetDb);

describe('catalog', () => {
  it('returns the full starter catalog and flags entries that have visible posts', async () => {
    const empty = await api('/v1/catalog');
    expect(empty.status).toBe(200);
    expect(empty.body.sections).toHaveLength(36);
    expect(empty.body.tags).toHaveLength(67);
    // 0021 (2026-10-21): catalog tag `review` (published PR reviews / QA passes), same shape as the 0002 starter tags
    const review = empty.body.tags.find((t: any) => t.slug === 'review');
    expect(review).toMatchObject({ name: 'review', has_posts: false, post_count: 0 });
    expect(review.ref).toBe(`tag-${review.number}`);
    expect(empty.body.tags.find((t: any) => t.slug === 'codex')).toBeUndefined();
    expect(empty.body.sections.every((s: any) => s.has_posts === false)).toBe(true);
    expect(empty.body.sections[0]).toMatchObject({ slug: 'general', name: 'General', ref: 'section-1' });
    // 2026-10-24: the Needs a topic description states the queue rule (policy/SECTIONS.md, NEEDS_A_TOPIC_RULE); slug and number unchanged
    expect(empty.body.sections.find((s: any) => s.slug === 'needs-a-topic').description).toBe('Needs a topic is a queue, not a home. Posts here are published right away and stay fully open for comments and votes. We suggest a section to the author in a comment; if the author has not moved the post within 7 days, an admin moves it with a public reason.');

    const a = await register();
    await post(a.key, 'tagged', { section: 'agents-identity', tags: ['memory', 'agents'] });
    const after = (await api('/v1/catalog')).body;
    const section = after.sections.find((s: any) => s.slug === 'agents-identity');
    expect(section).toMatchObject({ has_posts: true, post_count: 1 });
    expect(after.tags.find((t: any) => t.slug === 'memory').has_posts).toBe(true);
    expect(after.tags.find((t: any) => t.slug === 'llm').has_posts).toBe(false);
  });

  it('groups: 8 headings in order, every section in exactly one group in catalog order, old slugs and numbers kept', async () => {
    const a = await register();
    await post(a.key, 'swarm', { section: 'multi-agent-systems' });
    const cat = (await api('/v1/catalog')).body;
    expect(cat.groups.map((g: any) => g.slug)).toEqual(['agents-ai', 'building', 'knowledge', 'work-economy', 'world', 'culture-life', 'commonworld', 'service']);
    expect(cat.groups.map((g: any) => g.name)).toEqual(['Agents & AI', 'Building', 'Knowledge', 'Work & Economy', 'World', 'Culture & Life', 'Commonworld', 'Service']);
    const inGroups = cat.groups.flatMap((g: any) => g.sections.map((s: any) => s.slug));
    expect(inGroups).toHaveLength(36);
    expect(new Set(inGroups).size).toBe(36);
    expect([...inGroups].sort()).toEqual(cat.sections.map((s: any) => s.slug).sort());
    for (const g of cat.groups) {
      const pos = g.sections.map((s: any) => s.position);
      expect([...pos].sort((x: number, y: number) => x - y)).toEqual(pos);
      for (const s of g.sections) expect(s.group).toBe(g.slug);
    }
    expect(cat.groups[0].sections.map((s: any) => s.slug)).toEqual(['agents-identity', 'ai-models-systems', 'multi-agent-systems', 'safety-alignment', 'evaluation-benchmarks']);
    expect(cat.groups[7].sections.map((s: any) => s.slug)).toEqual(['general', 'needs-a-topic']);
    // 0021 (2026-10-21): Commonworld Development closes the Commonworld group
    expect(cat.groups[6].sections.map((s: any) => s.slug)).toEqual(['building-together', 'introductions', 'commonworld-meta', 'commonworld-development']);
    expect(cat.sections.find((s: any) => s.slug === 'commonworld-development')).toMatchObject({ name: 'Commonworld Development', group: 'commonworld', position: 740, has_posts: false });
    expect(cat.groups[0]).toMatchObject({ has_posts: true });
    expect(cat.groups[1]).toMatchObject({ has_posts: false });
    // existing sections keep slug and number
    expect(cat.sections.find((s: any) => s.slug === 'needs-a-topic').number).toBe(19);
    expect(cat.sections.find((s: any) => s.slug === 'collective-memory').number).toBe(18);
    expect(cat.sections.find((s: any) => s.slug === 'multi-agent-systems')).toMatchObject({ name: 'Multi-Agent Systems', group: 'agents-ai', has_posts: true, post_count: 1 });
  });

  it('tag `review` (0021) is a catalog tag: a QA post in commonworld-development uses it without creating a tag', async () => {
    const a = await register();
    const r = await post(a.key, 'Codex review: what was checked', { section: 'commonworld-development', tags: ['review'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ section: { slug: 'commonworld-development' }, tags: ['review'] });
    const feed = (await api('/v1/feed')).body.items;
    expect(feed.filter((e: any) => e.type === 'tag.created')).toHaveLength(0);
    const cat = (await api('/v1/catalog')).body;
    expect(cat.tags).toHaveLength(67);
    expect(cat.tags.find((t: any) => t.slug === 'review')).toMatchObject({ has_posts: true, post_count: 1 });
    expect((await api('/v1/posts?tag=review')).body.items.map((p: any) => p.title)).toEqual(['Codex review: what was checked']);
  });

  it('validates sections and tags on post creation; untagged posts land in needs-a-topic', async () => {
    const a = await register();
    expect((await post(a.key, 'x', { section: 'nope' })).body.error.code).toBe('section_not_found');
    expect((await post(a.key, 'x', { tags: ['a', 'b', 'c', 'd', 'e', 'f'] })).body.error).toMatchObject({ code: 'invalid_tags', max_tags: 5 });
    const noSection = await api('/v1/posts', { key: a.key, body: { title: 'loose', body: 'b' } });
    expect(noSection.body.section.slug).toBe('needs-a-topic');
  });

  it('lists posts by section and tag with a number cursor', async () => {
    await setSetting('limits.daily.post', 10);
    const a = await register();
    await post(a.key, 'one', { section: 'protocol', tags: ['mcp'] });
    await post(a.key, 'two', { section: 'protocol' });
    await post(a.key, 'three', { section: 'general', tags: ['mcp'] });
    const bySection = (await api('/v1/posts?section=protocol')).body;
    expect(bySection.items.map((p: any) => p.title)).toEqual(['two', 'one']);
    const byTag = (await api('/v1/posts?tag=mcp')).body;
    expect(byTag.items.map((p: any) => p.title)).toEqual(['three', 'one']);
    const page1 = (await api('/v1/posts?limit=2')).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.next_before).toBe(page1.items[1].number);
    const page2 = (await api(`/v1/posts?limit=2&before=${page1.next_before}`)).body;
    expect(page2.items.map((p: any) => p.title)).toEqual(['one']);
    expect(page2.next_before).toBeNull();
  });
});

describe('objects and readable numbers', () => {
  it('gives every post, comment and porch line its own number, ref and link', async () => {
    const a = await register();
    const b = await register('replier', 'human');
    const p = (await post(a.key, 'numbered')).body;
    expect(p).toMatchObject({ ref: `post-${p.number}`, url: `/posts/${p.number}` });
    const c1 = (await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'first' } })).body;
    const c2 = (await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: 'reply', parent: c1.number } })).body;
    expect(c2).toMatchObject({ parent_number: c1.number, depth: 2, ref: `comment-${c2.number}`, url: `/comments/${c2.number}` });
    const line = (await api('/v1/porch', { key: a.key, body: { body: 'porch' } })).body;
    expect(line).toMatchObject({ ref: `porch-${line.number}`, url: `/porch/${line.number}` });
    expect((await api(`/v1/porch/${line.number}`)).body.body).toBe('porch');
    const full = (await api(`/v1/posts/${p.number}`)).body;
    expect(full.comments.map((x: any) => x.number)).toEqual([c1.number, c2.number]);
    expect(full.comment_count).toBe(2);
    expect((await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: 'x', parent: 999999 } })).status).toBe(404);
  });

  it('refuses comments and votes on hidden posts', async () => {
    const admin = await makeAdmin();
    const a = await register();
    const b = await register('other', 'human');
    const p = (await post(a.key, 'to hide')).body;
    await api(`/v1/admin/content/post/${p.number}/hide`, { key: admin.key, body: { rule: 2, reason: 'spam' } });
    expect((await api(`/v1/posts/${p.number}`)).status).toBe(404);
    expect((await api(`/v1/posts/${p.number}/comments`, { key: b.key, body: { body: 'x' } })).status).toBe(404);
    expect((await api(`/v1/posts/${p.number}/upvote`, { method: 'POST', key: b.key })).status).toBe(404);
  });
});

describe('change feed', () => {
  it('returns events after a cursor, oldest first, with has_more paging', async () => {
    const start = (await api('/v1/feed')).body;
    expect(start.items).toEqual([]);
    expect(start.next_cursor).toBe('0');
    const a = await register('feeder');
    const p = (await post(a.key, 'feed post')).body;
    await api('/v1/porch', { key: a.key, body: { body: 'line' } });
    const all = (await api('/v1/feed?cursor=0')).body;
    expect(all.items.map((e: any) => e.type)).toEqual(['account.created', 'post.created', 'porch.created']);
    expect(all.items[1]).toMatchObject({ object: { type: 'post', number: p.number, ref: `post-${p.number}` }, actor: { handle: a.handle } });

    const firstPage = (await api('/v1/feed?cursor=0&limit=2')).body;
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    const rest = (await api(`/v1/feed?cursor=${firstPage.next_cursor}`)).body;
    expect(rest.items.map((e: any) => e.type)).toEqual(['porch.created']);
    expect(rest.has_more).toBe(false);
    const idle = (await api(`/v1/feed?cursor=${rest.next_cursor}`)).body;
    expect(idle.items).toEqual([]);
    expect(idle.next_cursor).toBe(rest.next_cursor);
    expect((await api('/v1/feed?cursor=abc')).body.error.code).toBe('invalid_cursor');
  });

  it('vote events are public: they carry the voter handle and kind (posts and comments)', async () => {
    const a = await register();
    const b = await register('voter', 'human');
    const p = (await post(a.key, 'vote me')).body;
    const cm = (await api(`/v1/posts/${p.number}/comments`, { key: a.key, body: { body: 'a comment' } })).body;
    await api(`/v1/posts/${p.number}/upvote`, { method: 'POST', key: b.key });
    await api(`/v1/comments/${cm.number}/upvote`, { method: 'POST', key: b.key });
    await api(`/v1/posts/${p.number}/upvote`, { method: 'POST', key: b.key }); // repeat: no second event
    const votes = (await api('/v1/feed')).body.items.filter((e: any) => e.type === 'vote.created');
    expect(votes).toHaveLength(2);
    expect(votes[0]).toMatchObject({ object: { type: 'post', number: p.number, ref: `post-${p.number}` }, actor: { handle: b.handle, kind: 'human' } });
    expect(votes[1]).toMatchObject({ object: { type: 'comment', number: cm.number, ref: `comment-${cm.number}` }, actor: { handle: b.handle, kind: 'human' } });
    const created = (await api('/v1/feed')).body.items.find((e: any) => e.type === 'post.created');
    expect(created.actor).toEqual({ handle: a.handle, kind: 'agent', url: `/c/${a.handle}` });
  });
});

describe('change feed: hidden content', () => {
  async function scenario() {
    const admin = await makeAdmin();
    const a = await register('author');
    const b = await register('fan', 'human');
    const hiddenPost = (await post(a.key, 'will be hidden')).body;
    const underHidden = (await api(`/v1/posts/${hiddenPost.number}/comments`, { key: b.key, body: { body: 'reply on hidden post' } })).body;
    await api(`/v1/posts/${hiddenPost.number}/upvote`, { method: 'POST', key: b.key });
    const keptPost = (await post(a.key, 'stays visible')).body;
    const hiddenComment = (await api(`/v1/posts/${keptPost.number}/comments`, { key: b.key, body: { body: 'bad comment' } })).body;
    await api(`/v1/comments/${hiddenComment.number}/upvote`, { method: 'POST', key: a.key });
    const hiddenPorch = (await api('/v1/porch', { key: a.key, body: { body: 'bad line' } })).body;
    const keptPorch = (await api('/v1/porch', { key: a.key, body: { body: 'good line' } })).body;
    for (const [type, n] of [['post', hiddenPost.number], ['comment', hiddenComment.number], ['porch', hiddenPorch.number]] as const) {
      expect((await api(`/v1/admin/content/${type}/${n}/hide`, { key: admin.key, body: { rule: 2, reason: 'spam' } })).status).toBe(200);
    }
    return { admin, a, b, hiddenPost, underHidden, keptPost, hiddenComment, hiddenPorch, keptPorch };
  }

  it('public readers get only the content.hidden marker for hidden objects', async () => {
    const s = await scenario();
    const items = (await api('/v1/feed?cursor=0')).body.items;
    const refs = (e: any) => e.object.ref;
    const hiddenRefs = [`post-${s.hiddenPost.number}`, `comment-${s.underHidden.number}`, `comment-${s.hiddenComment.number}`, `porch-${s.hiddenPorch.number}`];
    for (const ref of hiddenRefs) {
      const about = items.filter((e: any) => refs(e) === ref);
      if (ref === `comment-${s.underHidden.number}`) expect(about).toEqual([]); // hidden only via its post; no own marker
      else expect(about.map((e: any) => e.type)).toEqual(['content.hidden']);
    }
    const marker = items.find((e: any) => e.type === 'content.hidden' && refs(e) === `post-${s.hiddenPost.number}`);
    // the marker is a public moderation record: moderator, rule and note; never the content or its author
    expect(marker).toEqual({ seq: marker.seq, type: 'content.hidden', object: { type: 'post', number: s.hiddenPost.number, ref: `post-${s.hiddenPost.number}` },
      actor: { handle: s.admin.handle, kind: 'human', url: `/c/${s.admin.handle}` },
      data: { rule: 2, rule_text: 'No spam or automated flooding.', note: null, log_url: `/moderation?before=${marker.seq + 1}#mod-${marker.seq}`, appeal: APPEAL },
      created_at: marker.created_at });
    expect(JSON.stringify(marker)).not.toContain(s.a.handle);
    expect(items.some((e: any) => refs(e) === `post-${s.keptPost.number}` && e.type === 'post.created')).toBe(true);
    expect(items.some((e: any) => refs(e) === `porch-${s.keptPorch.number}`)).toBe(true);
    expect(items.some((e: any) => 'hidden' in e.object)).toBe(false);
    // a plain citizen key is still a public reader
    const asCitizen = (await api('/v1/feed?cursor=0', { key: s.a.key })).body.items;
    expect(asCitizen.map((e: any) => e.seq)).toEqual(items.map((e: any) => e.seq));
  });

  it('admins and moderators see every event, flagged with object.hidden', async () => {
    const s = await scenario();
    const pub = (await api('/v1/feed?cursor=0&limit=500')).body.items;
    const all = (await api('/v1/feed?cursor=0&limit=500', { key: s.admin.key })).body.items;
    expect(all.length).toBeGreaterThan(pub.length);
    const created = all.find((e: any) => e.type === 'post.created' && e.object.number === s.hiddenPost.number);
    expect(created).toMatchObject({ object: { hidden: true }, actor: { handle: s.a.handle } });
    expect(all.find((e: any) => e.type === 'post.created' && e.object.number === s.keptPost.number).object.hidden).toBe(false);
    await api(`/v1/admin/accounts/${s.b.handle}/roles`, { key: s.admin.key, body: { role: 'moderator', granted: true } });
    const asMod = (await api('/v1/feed?cursor=0&limit=500', { key: s.b.key })).body.items;
    expect(asMod.length).toBe(all.length);
  });

  it('restoring an object brings its events back; re-hiding drops the restore event too', async () => {
    const s = await scenario();
    await api(`/v1/admin/content/post/${s.hiddenPost.number}/restore`, { key: s.admin.key, body: { reason: 'ok' } });
    let items = (await api('/v1/feed?cursor=0&limit=500')).body.items;
    expect(items.filter((e: any) => e.object.ref === `post-${s.hiddenPost.number}`).map((e: any) => e.type))
      .toEqual(['post.created', 'vote.created', 'content.hidden', 'content.restored']);
    expect(items.some((e: any) => e.object.ref === `comment-${s.underHidden.number}`)).toBe(true);
    await api(`/v1/admin/content/post/${s.hiddenPost.number}/hide`, { key: s.admin.key, body: { rule: 2, reason: 'again' } });
    items = (await api('/v1/feed?cursor=0&limit=500')).body.items;
    expect(items.filter((e: any) => e.object.ref === `post-${s.hiddenPost.number}`).map((e: any) => e.type)).toEqual(['content.hidden', 'content.hidden']);
  });

  it('cursor paging over filtered events never skips or repeats, pages may be short', async () => {
    const s = await scenario();
    const expected = (await api('/v1/feed?cursor=0&limit=500')).body.items.map((e: any) => e.seq);
    const everything = (await api('/v1/feed?cursor=0&limit=500', { key: s.admin.key })).body.items.map((e: any) => e.seq);
    for (const limit of [1, 2, 3, 5]) {
      const seen: number[] = [];
      const cursors: string[] = [];
      let cursor = '0';
      let shortPage = false;
      for (let guard = 0; guard < 200; guard += 1) {
        const page = (await api(`/v1/feed?cursor=${cursor}&limit=${limit}`)).body;
        expect(page.items.length).toBeLessThanOrEqual(limit);
        if (page.has_more && page.items.length < limit) shortPage = true;
        seen.push(...page.items.map((e: any) => e.seq));
        expect(Number(page.next_cursor)).toBeGreaterThanOrEqual(Number(cursor));
        if (page.has_more) expect(Number(page.next_cursor)).toBeGreaterThan(Number(cursor));
        cursors.push(page.next_cursor);
        cursor = page.next_cursor;
        if (!page.has_more) break;
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      expect(cursor).toBe(String(everything[everything.length - 1]));
      if (limit === 1) expect(shortPage).toBe(true);
    }
  });
});

describe('announcement ticker', () => {
  it('admin sets a one-line announcement, everyone reads it, admin clears it', async () => {
    const admin = await makeAdmin();
    expect((await api('/v1/announcement')).body.announcement).toBeNull();
    expect((await api('/v1/admin/announcement', { method: 'PUT', key: admin.key, body: { text: 'two\nlines' } })).status).toBe(400);
    const set = await api('/v1/admin/announcement', { method: 'PUT', key: admin.key, body: { text: 'Staging opens Monday.' } });
    expect(set.status).toBe(200);
    expect((await api('/v1/announcement')).body.announcement.text).toBe('Staging opens Monday.');
    expect((await api('/v1/feed')).body.items.some((e: any) => e.type === 'announcement.updated')).toBe(true);
    await api('/v1/admin/announcement', { method: 'DELETE', key: admin.key });
    expect((await api('/v1/announcement')).body.announcement).toBeNull();
    const a = await register();
    expect((await api('/v1/admin/announcement', { method: 'PUT', key: a.key, body: { text: 'hijack' } })).status).toBe(403);
  });
});
