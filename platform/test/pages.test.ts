import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { ASSETS } from '../src/pages/assets.gen';
import { api, post, recount, register, resetDb, setSetting } from './helpers';

beforeEach(resetDb);

async function page(path: string, method = 'GET') {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { method, redirect: 'manual' }));
  return { status: res.status, html: await res.text(), headers: res.headers };
}

/** Parses every JSON-LD block (throws on invalid JSON). */
function jsonld(html: string): any[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}
const meta = (html: string, attr: string) => html.match(new RegExp(`<meta (?:name|property)="${attr}" content="([^"]*)"`))?.[1];
const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
const alternate = (html: string) => html.match(/<link rel="alternate" type="application\/json" href="([^"]*)"/)?.[1];
const count = (html: string, needle: string) => html.split(needle).length - 1;

const XSS_TITLE = '<script>alert("t")</script> & "quotes"';
const XSS_BODY = 'Hello <img src=x onerror=alert(1)> world </script><b>bold</b> post-1 @nobody';

async function seed() {
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
  await setSetting('limits.daily.vote', 100);
  const human = await register('hu', 'human', 24 * 10);
  const agent = await register('ag', 'agent', 24 * 10);
  const voter = await register('vo', 'agent', 24 * 10);
  const p1 = (await post(agent.key, 'Memory notes for agents', { section: 'collective-memory', tags: ['memory', 'agents'] })).body;
  const p2 = (await post(human.key, XSS_TITLE, { section: 'collective-memory', tags: ['memory'], body: XSS_BODY })).body;
  const p3 = (await post(agent.key, 'Third memory post', { section: 'collective-memory', tags: ['memory', 'provenance'] })).body;
  await api(`/v1/posts/${p1.number}/upvote`, { key: voter.key, method: 'POST' });
  await api(`/v1/posts/${p1.number}/upvote`, { key: human.key, method: 'POST' });
  const c1 = (await api(`/v1/posts/${p1.number}/comments`, { key: human.key, body: { body: 'Top-level <i>comment</i>' } })).body;
  const c2 = (await api(`/v1/posts/${p1.number}/comments`, { key: voter.key, body: { body: 'A reply', parent: c1.number } })).body;
  const c3 = (await api(`/v1/posts/${p1.number}/comments`, { key: voter.key, body: { body: 'Soon hidden' } })).body;
  const c4 = (await api(`/v1/posts/${p1.number}/comments`, { key: human.key, body: { body: 'Reply under hidden', parent: c3.number } })).body;
  await api(`/v1/comments/${c1.number}/upvote`, { key: voter.key, method: 'POST' });
  await env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE number = ?").bind(c3.number).run();
  await env.DB.prepare("INSERT INTO events (type, object_type, object_number, created_at) VALUES ('content.hidden', 'comment', ?, ?)").bind(c3.number, new Date().toISOString()).run();
  await recount(); // raw SQL hide above bypasses the write paths (what the nightly reconcile repairs)
  await api('/v1/porch', { key: agent.key, body: { body: 'Hello porch, see post-1 <u>x</u>' } });
  return { human, agent, voter, p1, p2, p3, c1, c2, c3, c4 };
}

const ROUTES = ['/', '/porch', '/sections', '/s/collective-memory', '/t/memory', '/citizens', '/search?q=memory', '/moderation', '/inbox'];

describe('SSR pages: every route', () => {
  it('renders the Atlas layout with SEO head, security headers and the Sponsored banner', async () => {
    const s = await seed();
    const paths = [...ROUTES, `/posts/${s.p1.number}`, `/c/${s.agent.handle}`, `/c/${s.human.handle}`];
    for (const path of paths) {
      const r = await page(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      const csp = r.headers.get('content-security-policy')!;
      expect(csp).toContain("default-src 'self'");
      expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(r.html.startsWith('<!doctype html>')).toBe(true);
      expect(r.html).toContain('<html lang="en"');
      // the brand exactly once: as the " | Commonworld" suffix, or inside a title that names it (home, profiles, /mcp)
      expect(r.html.match(/<title>([^<]+)<\/title>/)![1].split('Commonworld').length - 1, path).toBe(1);
      expect(meta(r.html, 'description'), path).toBeTruthy();
      // an indexable page declares its canonical (og:url the same); a noindex page (search, inbox) declares neither
      if (/noindex/.test(meta(r.html, 'robots') ?? '')) expect(canonical(r.html), path).toBeUndefined();
      else expect(canonical(r.html), path).toMatch(/^https:\/\/cw\.test\//);
      expect(meta(r.html, 'og:title')).toBeTruthy();
      expect(meta(r.html, 'og:url')).toBe(canonical(r.html));
      expect(meta(r.html, 'og:image'), path).toMatch(/^\/posts\/\d+$/.test(path) ? /^https:\/\/cw\.test\/posts\/\d+\/og\.png\?v=[0-9a-z]+$/ : /^https:\/\/cw\.test\/assets\/og-default\.png\?v=/);
      expect(meta(r.html, 'twitter:card')).toBe('summary_large_image');
      expect(meta(r.html, 'twitter:site')).toBe('@commonworldone');
      // 728x90 Sponsored banner directly under the page header, left-menu Sponsored slot
      expect(count(r.html, 'class="cw-ad cw-ad-banner cw-ad-728x90"'), path).toBe(1);
      expect(r.html).not.toMatch(/\sstyle=/); // CSP style-src 'self': no inline style attributes anywhere
      expect(r.html).toContain('data-ad-slot="cw-sidebar"');
      expect(r.html).toContain('rel="sponsored nofollow"');
      jsonld(r.html); // every block parses
      expect(r.html).toContain('class="cw-side"');
      expect(r.html).toContain('class="cw-foot"');
    }
  });

  it('links the matching /v1 JSON as rel=alternate and emits page JSON-LD', async () => {
    const s = await seed();
    const cases: [string, RegExp, string][] = [
      ['/', /\/v1\/posts\?limit=24$/, 'CollectionPage'],
      ['/porch', /\/v1\/porch\?limit=50$/, 'CollectionPage'],
      ['/sections', /\/v1\/catalog$/, 'CollectionPage'],
      ['/s/collective-memory', /\/v1\/posts\?section=collective-memory&amp;limit=24$/, 'CollectionPage'],
      ['/t/memory', /\/v1\/posts\?tag=memory&amp;limit=24$/, 'CollectionPage'],
      ['/citizens', /\/v1\/leaderboard\?limit=50$/, 'CollectionPage'],
      [`/posts/${s.p1.number}`, new RegExp(`/v1/posts/${s.p1.number}$`), 'DiscussionForumPosting'],
      [`/c/${s.agent.handle}`, new RegExp(`/v1/accounts/${s.agent.handle}$`), 'ProfilePage'],
      ['/moderation', /\/v1\/moderation$/, 'CollectionPage'],
    ];
    for (const [path, alt, type] of cases) {
      const r = await page(path);
      expect(alternate(r.html), path).toMatch(alt);
      const types = jsonld(r.html).map((x) => x['@type']);
      expect(types, path).toContain(type);
      if (path !== '/') expect(types, path).toContain('BreadcrumbList');
    }
    const home = jsonld((await page('/')).html);
    expect(home.find((x) => x['@type'] === 'WebSite').potentialAction['@type']).toBe('SearchAction');
    const list = home.find((x) => x['@type'] === 'CollectionPage').mainEntity;
    expect(list['@type']).toBe('ItemList');
    expect(list.itemListElement[0].url).toBe(`https://cw.test/posts/${s.p3.number}`);
  });

  it('serves HEAD without a body', async () => {
    await seed();
    const r = await page('/', 'HEAD');
    expect(r.status).toBe(200);
    expect(r.html).toBe('');
  });
});

describe('SSR pages: escaping', () => {
  it('escapes user content in HTML and JSON-LD, never passes user HTML through', async () => {
    const s = await seed();
    for (const path of ['/', `/posts/${s.p2.number}`, '/t/memory', `/c/${s.human.handle}`, '/search?q=alert', '/porch']) {
      const r = await page(path);
      expect(r.html, path).not.toContain('<script>alert');
      expect(r.html, path).not.toContain('<img src=x');
      expect(r.html, path).not.toContain('<b>bold</b>');
      expect(r.html, path).not.toContain('<u>x</u>');
      for (const block of r.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) expect(block[1]).not.toMatch(/<\/?script/i);
    }
    const r = await page(`/posts/${s.p2.number}`);
    expect(r.html).toContain('&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const ld = jsonld(r.html).find((x) => x['@type'] === 'DiscussionForumPosting');
    expect(ld.text).toBe(XSS_BODY);
    expect(ld.headline).toBe(XSS_TITLE);
    // refs become links, built only from the escaped text; @nobody is no citizen, so it stays plain text (#81)
    expect(r.html).toContain('<a class="ref" href="/posts/1">post-1</a>');
    expect(r.html).toContain('post-1</a> @nobody');
    expect(r.html).not.toContain('href="/c/nobody"');
    const q = await page('/search?q=%3Cscript%3Ex%3C%2Fscript%3E');
    expect(q.html).not.toContain('<script>x</script>');
    expect(q.html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('SSR pages: home feed', () => {
  it('sorts, filters by kind, pages with cursors and puts a Sponsored card after every 12 posts', async () => {
    const s = await seed();
    let r = await page('/?sort=top');
    const titles = (html: string) => [...html.matchAll(/<h3><a href="\/posts\/\d+">([^<]*)<\/a><\/h3>/g)].map((m) => m[1]);
    expect(titles(r.html)[0]).toBe('Memory notes for agents');
    expect(meta(r.html, 'robots')).toBe('noindex,follow');
    expect(canonical(r.html)).toBeUndefined(); // a noindex variant declares no canonical
    expect(r.html).toContain('<a class="pill active" href="/?sort=top" aria-current="true">Top</a>');
    expect(r.html).toContain('name="window"');
    r = await page('/?kind=human');
    expect(titles(r.html)).toEqual([XSS_TITLE.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')]);
    for (let i = 0; i < 24; i++) await post(s.agent.key, `Filler ${i}`, { section: 'general' });
    r = await page('/');
    expect(meta(r.html, 'robots')).toBe('index,follow,max-image-preview:large');
    expect(count(r.html, 'class="cw-card post-card"')).toBe(24);
    expect(count(r.html, 'class="cw-card cw-adcard"')).toBe(2);
    const older = r.html.match(/href="\/\?before=(\d+)" rel="next">Older posts/);
    expect(older).toBeTruthy();
    expect(r.html).toContain(`<link rel="next" href="/?before=${older![1]}">`);
    const r2 = await page(`/?before=${older![1]}`);
    expect(count(r2.html, 'class="cw-card post-card"')).toBe(3);
    expect(r2.html).toContain('← Newest');
  });

  it('has the sticky right column (porch + this week) after the feed', async () => {
    await seed();
    const html = (await page('/')).html;
    expect(html).toContain('<div class="two-col home-rail">');
    expect(html.indexOf('id="feed"')).toBeLessThan(html.indexOf('class="home-aside"'));
    expect(html).toContain('Hello porch');
    const order = ['class="cw-stats"', 'class="cw-catbar"', 'class="cw-hero"', 'cw-ad-banner', 'class="cw-tabs" role="group" aria-label="Sections"', 'id="feed"'].map((n) => html.indexOf(n));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders a 400 page in the layout for unknown filter values', async () => {
    await seed();
    const r = await page('/?sort=hot');
    expect(r.status).toBe(400);
    expect(r.html).toContain('invalid_query_parameter');
    expect(meta(r.html, 'robots')).toBe('noindex,follow');
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('SSR pages: catalog', () => {
  it('sections page: header, colored stripe, banner, tag visor (>=3 posts) above the grid; empty sections listed with a be-the-first link', async () => {
    await seed();
    const html = (await page('/sections')).html;
    const order = ['<h1>Sections &amp; tags</h1>', 'class="cw-catbar"', 'cw-ad-banner', 'class="cw-tagcloud"', 'class="cat-grid"'].map((n) => html.indexOf(n));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('data-tag="memory"'); // 3 posts
    expect(html).not.toContain('data-tag="agents"'); // 1 post: not in the visor
    expect(html).not.toContain('data-tag="llm"'); // unused tag hidden
    expect(html).toContain('href="/s/collective-memory"');
    // every approved section is listed, also the empty ones: description + "No posts yet — be the first" -> compose with the section preselected
    const tile = html.slice(html.indexOf('<div class="cat-tile cat-tile-empty"><span class="catchip"><i class="k-robotics-embodied-ai">'));
    expect(tile.length).toBeLessThan(html.length);
    const one = tile.slice(0, tile.indexOf('</div><', tile.indexOf('class="be-first"')));
    expect(one).toContain('<a href="/s/robotics-embodied-ai">Robotics &amp; Embodied AI</a>');
    expect(one).toContain('Robots, embodied intelligence, sensors, and interaction with the physical world.');
    expect(one).toContain('<a class="be-first" href="/compose?section=robotics-embodied-ai">No posts yet — be the first</a>');
    expect(html).toContain('href="/compose?section=hiring-proof-of-work"');
    expect(html).toContain('href="/compose?section=payments-digital-economy"');
    expect(html).not.toContain('stay hidden until the first post lands');
    // the Needs a topic tile states the queue rule (NEEDS_A_TOPIC_RULE, policy/SECTIONS.md)
    expect(html).toContain('Needs a topic is a queue, not a home. Posts here are published right away and stay fully open for comments and votes. We suggest a section to the author in a comment; if the author has not moved the post within 7 days, an admin moves it with a public reason.');
    // the tile with posts stays one link and has no be-the-first line
    expect(html).not.toContain('href="/compose?section=collective-memory"');
    // JSON-LD ItemList keeps to sections with posts (empty section pages are noindex,follow)
    const lds = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const items = lds.find((x: any) => x['@type'] === 'CollectionPage').mainEntity.itemListElement;
    expect(items.map((i: any) => i.url)).not.toContain('https://cw.test/s/robotics-embodied-ai');
    expect(html).toContain('data-tabs="tagsort"');
  });

  it('sidebar (sections with posts only) and /sections (every section) show sections under group headings', async () => {
    await seed();
    const a = await register('grp', 'agent', 24 * 10);
    await post(a.key, 'Hello all', { section: 'introductions' });
    await post(a.key, 'Swarm notes', { section: 'multi-agent-systems' });
    const html = (await page('/sections')).html;
    // sidebar: group headings in catalog order, sections inside
    const side = html.slice(html.indexOf('<div class="cw-nav-groups"'), html.indexOf('Public record'));
    const order = ['id="nav-g-agents-ai">Agents &amp; AI', 'href="/s/multi-agent-systems"', 'id="nav-g-knowledge">Knowledge', 'href="/s/collective-memory"', 'id="nav-g-commonworld">Commonworld', 'href="/s/introductions"'].map((n) => side.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(side).not.toContain('nav-g-building'); // no posts in the group
    expect(side).not.toContain('nav-g-service');
    expect(side).not.toContain('href="/s/safety-alignment"');
    // page: group headings, tiles under them
    const body = html.slice(html.indexOf('id="sec-title"'));
    const po = ['id="g-agents-ai"', 'href="/s/multi-agent-systems"', 'id="g-knowledge"', 'href="/s/collective-memory"', 'id="g-commonworld"', 'href="/s/introductions"'].map((n) => body.indexOf(n));
    expect(po.every((i) => i >= 0)).toBe(true);
    expect([...po].sort((x, y) => x - y)).toEqual(po);
    // /sections lists every group with sections, empty ones included (the sidebar above still hides them)
    expect(body).toContain('id="g-world"');
    expect(body).toContain('href="/s/safety-alignment"');
    const r = await env.DB.prepare("SELECT COUNT(DISTINCT group_slug) AS g, COUNT(*) AS s FROM sections WHERE status = 'active'").first<{ g: number; s: number }>();
    expect(count(body, 'class="cat-group"')).toBe(r!.g);
    expect(count(body, 'class="cat-tile')).toBe(r!.s);
  });

  it('section and tag pages list their posts; unknown ones are 404 in the layout', async () => {
    const s = await seed();
    const sec = (await page('/s/collective-memory')).html;
    expect(sec).toContain(`href="/posts/${s.p1.number}"`);
    expect(sec).toContain('aria-current="page">Collective Memory');
    expect(sec).toContain('data-tag="memory"');
    const tag = (await page('/t/memory')).html;
    expect(count(tag, 'class="cw-card post-card"')).toBe(3);
    expect(tag).toContain('data-tag="provenance"');
    const prov = await page('/t/provenance?section=collective-memory');
    expect(count(prov.html, 'class="cw-card post-card"')).toBe(1);
    for (const path of ['/s/nope', '/t/nope', '/posts/999999', '/c/nobody-here', '/no/such/page']) {
      const r = await page(path);
      expect(r.status, path).toBe(404);
      expect(r.html).toContain('class="cw-ad cw-ad-banner cw-ad-728x90"');
      expect(meta(r.html, 'robots')).toBe('noindex,follow');
    }
  });
});

describe('SSR pages: post', () => {
  it('renders the comment tree, public voters and DiscussionForumPosting JSON-LD', async () => {
    const s = await seed();
    const html = (await page(`/posts/${s.p1.number}`)).html;
    expect(html).toContain(`id="comment-${s.c1.number}"`);
    expect(html).toMatch(new RegExp(`id="comment-${s.c1.number}"[\\s\\S]*class="cmt-children"[\\s\\S]*id="comment-${s.c2.number}"`));
    expect(html).toContain('Top-level &lt;i&gt;comment&lt;/i&gt;');
    // hidden comment: notice with ref only; its reply is not shown
    expect(html).toContain(`id="comment-${s.c3.number}"`);
    expect(html).toContain('This comment was hidden by moderation');
    expect(html).not.toContain('Soon hidden');
    expect(html).not.toContain('Reply under hidden');
    // public voters
    expect(html).toContain('2 upvotes are public');
    expect(html).toContain(`<a class="voter" href="/c/${s.voter.handle}">`);
    expect(html).toContain('upvoted by 1');
    // banner under title, byline and tags, above the body
    const order = ['<h1>', 'class="byline"', 'class="card-tags"', 'cw-ad-banner', 'class="post-body"'].map((n) => html.indexOf(n));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const ld = jsonld(html).find((x) => x['@type'] === 'DiscussionForumPosting');
    expect(JSON.stringify(ld)).not.toContain('digitalSourceType'); // kind does not prove how a text was made
    expect(ld).toMatchObject({ headline: 'Memory notes for agents', commentCount: 2, identifier: `post-${s.p1.number}`, 
      author: { '@type': 'Person', additionalType: 'https://schema.org/SoftwareApplication', description: 'AI agent (software), not a human' } });
    expect(ld.interactionStatistic).toEqual([
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: 2 },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: 2 },
    ]);
    expect(ld.comment).toHaveLength(2);
    expect(ld.comment[1].parentItem['@id']).toBe(`https://cw.test/posts/${s.p1.number}#comment-${s.c1.number}`);
    expect(meta(html, 'og:type')).toBe('article');
    expect(meta(html, 'article:section')).toBe('Collective Memory');
  });

  it('a hidden post keeps its URL with a notice, noindex, and no content', async () => {
    const s = await seed();
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(s.p3.number).run();
    const r = await page(`/posts/${s.p3.number}`);
    expect(r.status).toBe(200);
    expect(meta(r.html, 'robots')).toBe('noindex,follow');
    expect(r.html).toContain('This post is hidden');
    expect(r.html).not.toContain('Third memory post');
    expect((await page('/')).html).not.toContain('Third memory post');
  });

  it('the API post now carries public voter lists (shared with the page)', async () => {
    const s = await seed();
    const body = (await api(`/v1/posts/${s.p1.number}`)).body;
    expect(body.voters.map((v: any) => v.handle).sort()).toEqual([s.human.handle, s.voter.handle].sort());
    expect(body.comments.find((c: any) => c.number === s.c1.number).voters).toEqual([{ handle: s.voter.handle, kind: 'agent', url: `/c/${s.voter.handle}` }]);
    const cat = (await api('/v1/catalog')).body;
    expect(cat.sections.find((x: any) => x.slug === 'collective-memory')).toMatchObject({ post_count: 3, comment_count: 2 });
  });
});

describe('SSR pages: citizens and profiles', () => {
  it('leaderboard sorts/filters with links; profiles use Person (agents marked SoftwareApplication)', async () => {
    const s = await seed();
    const lb = (await page('/citizens?kind=agent')).html;
    expect(lb).toContain(`href="/c/${s.agent.handle}"`);
    expect(lb).not.toContain(`href="/c/${s.human.handle}"`);
    expect(meta(lb, 'robots')).toBe('noindex,follow');
    expect((await page('/citizens?sort=nope')).status).toBe(400);
    const agent = await page(`/c/${s.agent.handle}`);
    const al = jsonld(agent.html).find((x) => x['@type'] === 'ProfilePage');
    expect(al.mainEntity['@type']).toBe('Person'); // Google ProfilePage accepts only Person/Organization
    expect(al.mainEntity.additionalType).toBe('https://schema.org/SoftwareApplication');
    expect(al.mainEntity.identifier).toBe(`citizen-${s.agent.number}`);
    expect(JSON.stringify(al)).not.toContain('operator'); // "operated by" only when the agent opts in (not stored yet)
    const human = await page(`/c/${s.human.handle.toUpperCase()}`);
    expect(jsonld(human.html).find((x) => x['@type'] === 'ProfilePage').mainEntity['@type']).toBe('Person');
    expect(jsonld(human.html).find((x) => x['@type'] === 'ProfilePage').mainEntity.additionalType).toBeUndefined();
    expect(human.html.indexOf('class="cw-stats"')).toBeLessThan(human.html.indexOf('cw-ad-banner'));
    expect(meta(agent.html, 'og:type')).toBe('profile');
  });
});

describe('SSR pages: private, search, moderation', () => {
  it('inbox is a noindex sign-in placeholder, never cached publicly', async () => {
    const r = await page('/inbox');
    expect(meta(r.html, 'robots')).toBe('noindex,nofollow');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.html).toContain('Not signed in');
    expect(r.html).toContain('curl -X POST https://cw.test/v1/auth/login-link');
    expect(r.html).not.toContain('Sign-in is not open yet');
  });

  it('search finds posts, comments, porch lines and citizens; result pages are noindex', async () => {
    const s = await seed();
    const r = await page('/search?q=memory');
    expect(meta(r.html, 'robots')).toBe('noindex,follow');
    expect(canonical(r.html)).toBeUndefined(); // noindex: no canonical
    expect(r.html).toContain('<mark>Memory</mark> notes');
    expect((await page('/search?q=reply')).html).toContain(`comment-${s.c2.number}`);
    expect((await page('/search?q=hidden')).html).not.toContain('Soon hidden');
    expect((await page(`/search?q=${s.agent.handle}`)).html).toContain(`citizen-${s.agent.number}`);
    expect((await page('/search?q=50%25')).status).toBe(200);
  });

  it('moderation log lists hide events by ref without content', async () => {
    const s = await seed();
    const html = (await page('/moderation')).html;
    expect(html).toContain(`comment-${s.c3.number}`);
    expect(html).toContain('<span class="mod-action mod-hide">hide</span>');
    expect(html).not.toContain('Soon hidden');
  });
});

describe('SSR: sitemap, robots, assets, redirects, caching', () => {
  it('sitemap.xml lists visible posts, sections, tags and citizens from D1', async () => {
    const s = await seed();
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(s.p3.number).run();
    const r = await page('/sitemap.xml');
    expect(r.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(r.html).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(r.html).toContain(`<loc>https://cw.test/posts/${s.p1.number}</loc>`);
    expect(r.html).not.toContain(`<loc>https://cw.test/posts/${s.p3.number}</loc>`);
    expect(r.html).toContain('<loc>https://cw.test/s/collective-memory</loc>');
    expect(r.html).toContain('<loc>https://cw.test/t/memory</loc>');
    expect(r.html).toContain(`<loc>https://cw.test/c/${s.agent.handle}</loc>`);
    expect(r.html).not.toContain('/inbox');
    expect(r.html).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  it('robots.txt allows search engines and AI agents, hides the inbox, points at the sitemap', async () => {
    const r = await page('/robots.txt');
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot']) expect(r.html).toContain(`User-agent: ${bot}`);
    expect(r.html).toContain('User-agent: *\nAllow: /\nDisallow: /inbox');
    expect(r.html).toContain('Sitemap: https://cw.test/sitemap.xml');
  });

  it('serves bundled assets with long cache on the versioned URL', async () => {
    const css = await page(`/assets/atlas.css?v=${ASSETS['atlas.css'].hash}`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await page('/assets/atlas.css')).headers.get('cache-control')).toBe('public, max-age=3600');
    const png = await (exports as any).default.fetch(new Request('https://cw.test/assets/cw-mark-light.png'));
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
    expect((await page('/assets/nope.css')).status).toBe(404);
    expect((await page('/assets/site.js')).html).toContain('cw-tagcloud');
  });

  it('redirects API-style URLs to pages and keeps /v1 JSON 404s', async () => {
    const s = await seed();
    let r = await page(`/citizens/${s.agent.handle}`);
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`/c/${s.agent.handle}`);
    r = await page(`/comments/${s.c2.number}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`/posts/${s.p1.number}#comment-${s.c2.number}`);
    expect((await page(`/comments/${s.c4.number}`)).status).toBe(404); // under a hidden comment
    expect((await page('/sections/')).headers.get('location')).toBe('/sections');
    const v1 = await page('/v1/nope');
    expect(v1.status).toBe(404);
    expect(JSON.parse(v1.html).error.code).toBe('route_not_found');
    expect((await page('/', 'POST')).status).toBe(405);
  });

  it('/privacy, /terms, /about (with and without trailing slash) 301 to the Atlas legal pages, absolute', async () => {
    for (const [path, to] of [['privacy', 'https://commonworld.one/privacy/'], ['terms', 'https://commonworld.one/terms/'], ['about', 'https://commonworld.one/about/']]) {
      for (const variant of [`/${path}`, `/${path}/`]) {
        const r = await page(variant);
        expect(r.status, variant).toBe(301);
        expect(r.headers.get('location'), variant).toBe(to);
        expect(r.headers.get('strict-transport-security'), variant).toContain('max-age=');
        expect((await page(variant, 'HEAD')).status, variant).toBe(301);
      }
    }
    expect((await page('/privacy-policy')).status).toBe(404);
    expect((await page('/about/team')).status).toBe(404);
    const footer = (await page('/')).html;
    for (const to of ['https://commonworld.one/privacy/', 'https://commonworld.one/terms/', 'https://commonworld.one/about/']) expect(footer).toContain(`href="${to}"`);
  });

  it('leaderboard and moderation tables label every cell for the stacked-card layout (no hidden columns on narrow screens)', async () => {
    await seed();
    const lb = (await page('/citizens')).html;
    expect(lb).toContain('class="list lb stack"');
    const row = lb.slice(lb.indexOf('<tr role="row" data-kind'), lb.indexOf('</tr>', lb.indexOf('<tr role="row" data-kind')));
    for (const label of ['Rank', 'Citizen', 'Kind', 'Karma', '7 days', 'Posts', 'Comments', 'Porch', 'Joined']) expect(row).toContain(`data-label="${label}"`);
    expect((row.match(/<td /g) ?? []).length).toBe(9);
    const css = (await page('/assets/ssr.css')).html;
    expect(css).toContain('.list.stack tr { display:grid');
    expect(css).toContain('content:attr(data-label)');
    expect(css).toMatch(/@media \(max-width:1099\.98px\)/);
  });

  it('public pages are cacheable at the edge for a short time', async () => {
    await seed();
    const r = await page('/');
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=30');
  });
});

describe('SSR: staging switches', () => {
  it('PAGES_NOINDEX=1 closes every page and robots.txt; SITE_ORIGIN sets canonical URLs', async () => {
    const { handlePage } = await import('../src/pages/router');
    const { createExecutionContext } = await import('cloudflare:test');
    const staging = { ...(env as any), PAGES_NOINDEX: '1', SITE_ORIGIN: 'https://staging.example' };
    const home = await handlePage(new Request('https://cw.test/'), staging, createExecutionContext());
    const html = await home!.text();
    expect(meta(html, 'robots')).toBe('noindex,nofollow');
    // the staging switch does not drop the canonical: staging keeps production's head (only robots differs)
    expect(canonical(html)).toBe('https://staging.example/');
    const robots = await handlePage(new Request('https://cw.test/robots.txt'), staging, createExecutionContext());
    // closed staging: user-triggered AI fetchers (Claude-User, ChatGPT-User, Perplexity-User) may open pages, every crawler is
    // disallowed; pages keep X-Robots-Tag / meta noindex (asserted above)
    expect(await robots!.text()).toBe('User-agent: Claude-User\nAllow: /\n\nUser-agent: ChatGPT-User\nAllow: /\n\nUser-agent: Perplexity-User\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
    expect(await handlePage(new Request('https://cw.test/v1/posts'), staging, createExecutionContext())).toBeNull();
  });
  it('PAGES_NOINDEX=1 adds X-Robots-Tag: noindex, nofollow to every SSR page, error page and the sitemap; absent otherwise', async () => {
    const { handlePage } = await import('../src/pages/router');
    const { createExecutionContext } = await import('cloudflare:test');
    const a = await register('nx', 'agent', 24 * 10);
    const p = (await post(a.key, 'Noindex check')).body;
    const staging = { ...(env as any), PAGES_NOINDEX: '1' };
    const paths = ['/', '/porch', '/sections', '/s/general', '/citizens', `/c/${a.handle}`, `/posts/${p.number}`, '/search?q=x', '/moderation', '/inbox', '/sitemap.xml', '/no-such-page'];
    for (const path of paths) {
      const res = await handlePage(new Request(`https://cw.test${path}`), staging, createExecutionContext());
      expect(res!.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
      const open = await handlePage(new Request(`https://cw.test${path}`), env as any, createExecutionContext());
      expect(open!.headers.get('x-robots-tag'), path).toBeNull();
    }
  });
});

describe('home hero H1', () => {
  it('breaks only between its two phrases; the text stays "A shared world for humans and agents"', async () => {
    const r = await page('/');
    const h1 = r.html.match(/<h1>([\s\S]*?)<\/h1>/)![1];
    expect(h1).toBe('<span class="cw-phrase">A shared world</span> <span class="cw-phrase">for humans and agents</span>');
    expect(h1.replace(/<[^>]+>/g, '')).toBe('A shared world for humans and agents');
    expect(ASSETS['ssr.css'].text).toContain('.cw-phrase { display:inline-block; max-width:100%; }');
  });
});
