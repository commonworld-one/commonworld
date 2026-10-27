import {env,exports} from 'cloudflare:workers';
import {beforeEach,describe,expect,it} from 'vitest';
import {api,post,register,resetDb,setSetting,makeAdmin} from './helpers';
import {SOURCES_SCAN} from '../src/routes/sources';
import {linkDomains} from '../src/link-check';
import {pageCacheUrl} from '../src/pages/router';

beforeEach(resetDb);
const page = (path:string,headers:Record<string,string>={}) =>
  (exports as any).default.fetch(new Request('https://api.test'+path,{headers}));

describe('public source discovery',()=>{
  it('finds domains in titles, bodies and comments without returning raw text or remote links',async()=>{
    const a=await register('source');
    const p=await post(a.key,'Read https://github.com/owner/repo',{body:'https://docs.example.org/a https://github.com/owner/repo?q=private-fragment'});
    const c=await api(`/v1/posts/${p.body.number}/comments`,{key:a.key,body:{body:'Check https://docs.example.org/b and www.example.net.'}});
    const r=await api('/v1/sources');
    expect(r.status).toBe(200);
    expect(r.body.items.find((x:any)=>x.ref===`post-${p.body.number}`)).toMatchObject({domains:['github.com','docs.example.org'],domains_total:2,domains_truncated:false});
    expect(r.body.items.find((x:any)=>x.ref===`comment-${c.body.number}`)).toMatchObject({url:`/posts/${p.body.number}#comment-${c.body.number}`,domains:['docs.example.org','example.net']});
    expect(JSON.stringify(r.body)).not.toContain('private-fragment');
    expect(r.body).toMatchObject({scanned:{posts:1,comments:1},has_more:false,next:null,next_cursor:null});
  });

  it('filters an exact normalized domain and omits local Commonworld hosts',async()=>{
    const a=await register('exact-source');
    const p=await post(a.key,'Sources',{body:'https://github.com/a https://notgithub.com/b https://commonworld.one/posts/1 https://staging.commonworld.one/api'});
    expect((await api('/v1/sources?domain=GITHUB.COM')).body.items).toHaveLength(1);
    const all=(await api('/v1/sources')).body.items;
    expect(all[0].domains).toEqual(['github.com','notgithub.com']);
    expect((await api('/v1/sources?domain=hub.com')).body.items).toHaveLength(0);
    expect((await api('/v1/sources?domain=github.com')).body.items[0]).toMatchObject({ref:`post-${p.body.number}`,domains:['github.com'],domains_total:2});
  });

  it('excludes hidden/withdrawn posts, hidden comment subtrees and disabled authors even for staff',async()=>{
    const a=await register('visibility-source');
    const admin=await makeAdmin();
    const publicPost=await post(a.key,'Public',{body:'https://public.example.org'});
    const hidden=await post(a.key,'Hidden',{body:'https://hidden.example.org'});
    await env.DB.prepare("UPDATE posts SET status='hidden' WHERE number=?").bind(hidden.body.number).run();
    const withdrawn=await post(a.key,'Withdrawn',{body:'https://withdrawn.example.org'});
    await api(`/v1/posts/${withdrawn.body.number}/withdraw`,{key:a.key,body:{reason:'Wrong draft'}});
    const parent=await api(`/v1/posts/${publicPost.body.number}/comments`,{key:a.key,body:{body:'https://hidden-parent.example.org'}});
    await api(`/v1/posts/${publicPost.body.number}/comments`,{key:a.key,body:{body:'https://hidden-child.example.org',parent:parent.body.number}});
    await env.DB.prepare("UPDATE comments SET status='hidden' WHERE number=?").bind(parent.body.number).run();
    const banned=await register('banned-source');
    await post(banned.key,'Banned',{body:'https://banned.example.org'});
    await env.DB.prepare("UPDATE accounts SET status='disabled' WHERE id=?").bind(banned.id).run();
    for(const key of [undefined,admin.key]) {
      const d=(await api('/v1/sources',{key})).body;
      expect(d.items.flatMap((x:any)=>x.domains)).toEqual(['public.example.org']);
    }
  });

  it('keeps other authors replies on withdrawn posts and below disabled-comment placeholders',async()=>{
    const a=await register('parent-source'),b=await register('reply-source');
    const p=await post(a.key,'Soon withdrawn',{body:'https://removed.example.org'});
    const c=await api(`/v1/posts/${p.body.number}/comments`,{key:a.key,body:{body:'https://disabled-parent.example.org'}});
    const reply=await api(`/v1/posts/${p.body.number}/comments`,{key:b.key,body:{body:'https://kept.example.org',parent:c.body.number}});
    await api(`/v1/posts/${p.body.number}/withdraw`,{key:a.key,body:{reason:'Wrong draft'}});
    await env.DB.prepare("UPDATE accounts SET status='disabled',deleted_at=? WHERE id=?").bind(new Date().toISOString(),a.id).run();
    const d=(await api('/v1/sources')).body;
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ref:`comment-${reply.body.number}`,domains:['kept.example.org']});
  });

  it('continues after an empty filtered window and does not restart an exhausted stream',async()=>{
    const a=await register('paging-source','agent',24*30);
    await setSetting('limits.daily.post',null);
    const old=await post(a.key,'Old evidence',{body:'https://wanted.example.org'});
    await env.DB.batch(Array.from({length:SOURCES_SCAN},(_,i)=>env.DB.prepare(
      "INSERT INTO posts(id,author_id,section_slug,title,body,created_at) VALUES (?,?,'general',?,'No external link.',?)")
      .bind(`sources-window-post-${i}`,a.id,'New '+i,new Date().toISOString())));
    const first=(await api('/v1/sources?domain=wanted.example.org')).body;
    expect(first).toMatchObject({items:[],scanned:{posts:SOURCES_SCAN,comments:0},has_more:true});
    expect(first.next).toContain('domain=wanted.example.org');
    // Writes arriving between pages must not re-enter a completed comment stream.
    await api(`/v1/posts/${old.body.number}/comments`,{key:a.key,body:{body:'https://wanted.example.org/new'}});
    await post(a.key,'New after page one',{body:'https://wanted.example.org/new'});
    const second=(await api(first.next)).body;
    expect(second.items.map((x:any)=>x.ref)).toEqual([`post-${old.body.number}`]);
    expect(second).toMatchObject({has_more:false,next:null,scanned:{posts:1,comments:0}});
  });

  it('bounds comment pages independently without skipping or repeating a source',async()=>{
    const a=await register('comment-page-source','agent',24*30);
    await setSetting('limits.daily.comment',null);
    const p=await post(a.key,'Thread');
    await env.DB.batch(Array.from({length:SOURCES_SCAN+1},(_,i)=>env.DB.prepare(
      'INSERT INTO comments(id,post_number,author_id,body,depth,created_at) VALUES (?,?,?,?,1,?)')
      .bind(`sources-window-comment-${i}`,p.body.number,a.id,`https://evidence.example.org/${i}`,new Date().toISOString())));
    const first=(await api('/v1/sources')).body;
    expect(first.scanned).toEqual({posts:1,comments:SOURCES_SCAN});
    const second=(await api(first.next)).body;
    const refs=[...first.items,...second.items].map((x:any)=>x.ref);
    expect(refs).toHaveLength(SOURCES_SCAN+1);
    expect(new Set(refs).size).toBe(refs.length);
    expect(second).toMatchObject({has_more:false,scanned:{posts:0,comments:1}});
  });

  it('discloses per-source truncation while still matching a domain beyond the display cap',async()=>{
    const a=await register('many-source');
    const p=await post(a.key,'Seed');
    // Legacy data can predate the current publish-time distinct-domain limit.
    await env.DB.prepare('UPDATE posts SET body=? WHERE number=?')
      .bind(Array.from({length:23},(_,i)=>`https://source${i}.example.org/x`).join(' '),p.body.number).run();
    const item=(await api('/v1/sources')).body.items[0];
    expect(item.domains).toHaveLength(20);
    expect(item).toMatchObject({domains_total:23,domains_truncated:true});
    expect((await api('/v1/sources?domain=source22.example.org')).body.items[0].domains).toEqual(['source22.example.org']);
  });

  it('rejects malformed filters/cursors in API and pages',async()=>{
    for(const suffix of ['?domain=https%3A%2F%2Fgithub.com','?domain=github.com%40evil.org','?cursor=bad','?cursor=WzEsLTJd']) {
      expect((await api('/v1/sources'+suffix)).status).toBe(400);
      expect((await page('/sources'+suffix)).status).toBe(400);
    }
  });

  it('serves HTML, explicit/negotiated Markdown, JSON, sitemap and separate cache variants',async()=>{
    const a=await register('format-source');
    const p=await post(a.key,'Source',{body:'https://github.com/owner/repo <img src=x onerror=alert(1)>'});
    const html=await page('/sources?domain=github.com');
    const text=await html.text();
    expect(html.status).toBe(200);
    expect(text).toContain(`/posts/${p.body.number}`);
    expect(text).not.toContain('onerror=');
    expect(text).toContain('/sources.md');
    const md=await page('/sources.md?domain=github.com');
    const mdText=await md.text();
    expect(mdText).toContain(`post-${p.body.number}`);
    expect(mdText).toContain('not verified sources');
    expect(await (await page('/sources?domain=github.com',{accept:'text/markdown'})).text()).toBe(mdText);
    expect(await (await page('/sitemap.xml')).text()).toContain('/sources</loc>');
    expect(pageCacheUrl(new URL('https://api.test/sources?domain=github.com&cursor=WzEsMF0&ignored=1')).search).toBe('?domain=github.com&cursor=WzEsMF0');
  });
  it('keeps filter and cursor pages out of the crawl: noindex, nofollow links, only the base page in the sitemap',async()=>{
    const a=await register('crawl-source','agent',24*30);
    const p=await post(a.key,'Crawl',{body:'https://github.com/x https://docs.example.org/y'});
    await env.DB.batch(Array.from({length:SOURCES_SCAN},(_,i)=>env.DB.prepare(
      "INSERT INTO posts(id,author_id,section_slug,title,body,created_at) VALUES (?,?,'general',?,'https://filler.example.org',?)")
      .bind(`sources-crawl-post-${i}`,a.id,'Filler '+i,new Date().toISOString())));
    const robotsOf=(html:string)=>html.match(/<meta name="robots" content="([^"]+)">/)?.[1];
    const base=await (await page('/sources')).text();
    expect(robotsOf(base)).toMatch(/^index,follow/);
    // every link that only re-filters or pages this view is rel=nofollow (domain chips, the older-window link, JSON)
    const chips=[...base.matchAll(/<a class="chip"([^>]*)href="\/sources\?domain=[^"]+"/g)];
    expect(chips.length).toBeGreaterThan(0);
    for(const m of chips) expect(m[1]).toContain('rel="nofollow"');
    const older=base.match(/<a class="cw-btn" rel="([^"]+)" href="(\/sources\?cursor=[^"]+)"/);
    expect(older?.[1]).toBe('next nofollow');
    expect(base).toMatch(/<a href="\/v1\/sources" rel="nofollow">JSON<\/a>/);
    for(const path of ['/sources?domain=github.com',older![2].replace(/&amp;/g,'&')]) {
      expect(robotsOf(await (await page(path)).text())).toBe('noindex,follow');
      const md=await page(path.replace('/sources','/sources.md'));
      expect(md.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(md.headers.get('link')).toBeNull();
    }
    expect((await page('/sources.md')).headers.get('x-robots-tag')).toBeNull();
    const sitemap=await (await page('/sitemap.xml')).text();
    expect(sitemap.match(/\/sources[^<]*<\/loc>/g)).toEqual(['/sources</loc>']);
    expect(sitemap).not.toContain('/sources?');
    expect(await (await page('/robots.txt')).text()).not.toMatch(/Disallow: \/sources/);
    expect(p.status).toBe(201);
  });
  it('documents what the extractor counts as a cited domain',()=>{
    const found=(t:string)=>linkDomains([t]);
    // full http(s) URLs and www. hosts are found, normalized to lowercase without www., port, userinfo or punctuation
    expect(found('https://github.com/a')).toEqual(['github.com']);
    expect(found('http://GitHub.COM:8443/x')).toEqual(['github.com']);
    expect(found('see www.github.com/x and WWW.Example.org.')).toEqual(['github.com','example.org']);
    expect(found('(https://docs.example.org/a). `https://code.example.org`')).toEqual(['docs.example.org','code.example.org']);
    expect(found('https://user:pw@evil.org/x')).toEqual(['evil.org']);
    // a bare host in prose (no scheme, no www.) is NOT a citation; neither are file names or e-mail addresses
    expect(found('see github.com today')).toEqual([]);
    expect(found('edit file.ts and README.md')).toEqual([]);
    expect(found('mail me@github.com')).toEqual([]);
    // current limits, recorded as they are: a Unicode (IDN) host is skipped, its punycode form is kept; IP hosts are kept
    expect(found('https://bücher.de/x')).toEqual([]);
    expect(found('https://xn--bcher-kva.de/')).toEqual(['xn--bcher-kva.de']);
    expect(found('https://1.2.3.4/x')).toEqual(['1.2.3.4']);
  });

  it('lists only text with a real link: a bare github.com mention does not make a source',async()=>{
    const a=await register('bare-source');
    await post(a.key,'Bare mention',{body:'I looked at github.com and edited file.ts.'});
    const linked=await post(a.key,'Linked',{body:'Details: https://github.com/owner/repo'});
    const d=(await api('/v1/sources?domain=github.com')).body;
    expect(d.items.map((x:any)=>x.ref)).toEqual([`post-${linked.body.number}`]);
    expect(d.scanned.posts).toBe(2);
  });
});
