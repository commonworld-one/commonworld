import type { Env } from '../env';
import { sourcesData, sourcesPath, SOURCES_NOTE, type SourcesData } from '../routes/sources';
import { HttpError } from '../http';
import { apiRel, h } from './html';
import { citizenUrl, crumbs, document, timeAgo, type PageCtx } from './layout';
import type { PageOut } from './post';

const data = (p:PageCtx,env:Env,page:URL) => sourcesData({env,url:page,params:[],principal:null});
const line = (s:string) => s.replace(/[\\`*_[\]<>|~]/g,'\\$&').replace(/[\r\n]/g,' ');

export async function sourcesPage(p:PageCtx,env:Env,page:URL):Promise<string | PageOut> {
  const rawDomain = page.searchParams.get('domain');
  let d: SourcesData;
  let invalidMsg: string | null = null;
  try {
    d = await data(p, env, page);
  } catch (err) {
    if (err instanceof HttpError && err.code === 'invalid_source_domain') {
      invalidMsg = 'Type a host only, e.g. github.com';
      d = { items: [], domain: rawDomain, scanned: { posts: 0, comments: 0 }, has_more: false, next_cursor: null, next: null, note: SOURCES_NOTE };
    } else {
      throw err;
    }
  }
  const api = sourcesPath('/v1/sources',d.domain,page.searchParams.get('cursor'));
  const body = h`${crumbs([['Sources',null]])}
<section class="cw-hero cw-hero-sm"><div><div class="kicker">Public evidence discovery</div><h1>Sources</h1>
<p>Find the public posts and comments that cite an external domain.</p></div></section>
<section class="cw-panel"><div class="cw-panel-head"><h2>Cited domains</h2><span class="spacer"></span><a href="${api}"${apiRel(api)}>JSON</a></div>
<div class="cw-panel-body"><form class="search-form-big u-mt0" method="get" action="/sources" role="search"><label class="sr" for="source-domain">Exact domain</label>
<input class="cw-search" id="source-domain" name="domain" type="search" value="${d.domain??''}" placeholder="Exact domain, e.g. github.com" maxlength="253" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="cw-btn cw-btn-primary" type="submit">Find sources</button></form>
<p class="muted u-mt10">${invalidMsg ? h`<b>${invalidMsg}</b>` : SOURCES_NOTE}</p>
${invalidMsg ? '' : d.items.length?d.items.map(x=>h`<article class="cw-card"><h3><a href="${x.url}">${x.ref}</a></h3>
<p><a class="who" href="${citizenUrl(x.author)}">@${x.author}</a> · ${timeAgo(x.created_at,p.now)}</p>
<p>${x.domains.map(host=>h`<a class="chip" rel="nofollow" href="${sourcesPath('/sources',host)}">${host}</a>`)}</p>
${x.domains_truncated?h`<p class="muted">Showing ${x.domains.length} of ${x.domains_total} domains; open the source for the full text.</p>`:''}</article>`):h`<p>No matching domains in this window.</p>`}
<p class="muted">Read ${d.scanned.posts} posts and ${d.scanned.comments} comments.</p>
${d.has_more?h`<a class="cw-btn" rel="next nofollow" href="${sourcesPath('/sources',d.domain,d.next_cursor)}">Older source window →</a>`:''}
</div></section>`;
  const html = document(p,{title:'Sources',description:'Public posts and comments that cite external domains.',path:'/sources',
    active:'sources',altJson:api,robots:page.searchParams.has('domain')||page.searchParams.has('cursor')?'noindex,follow':undefined,body});
  if (invalidMsg) {
    return { html, headers: { 'cache-control': 'no-store' }, status: 400 };
  }
  return html;
}

export async function sourcesMarkdown(p:PageCtx,env:Env,page:URL):Promise<string> {
  const d=await data(p,env,page);
  const out=['# Sources','',SOURCES_NOTE,'',`Exact domain: ${d.domain??'all external domains'}`,'',
    `JSON: ${p.origin}${sourcesPath('/v1/sources',d.domain,page.searchParams.get('cursor'))}`,''];
  for(const x of d.items) out.push(`- [${x.ref}](${p.origin}${x.url}) · @${line(x.author)} · ${line(x.created_at)}`,
    `  Domains: ${x.domains.map(line).join(', ')}${x.domains_truncated?` (showing ${x.domains.length} of ${x.domains_total})`:''}`);
  if(!d.items.length) out.push('No matching domains in this window.');
  out.push('',`Read ${d.scanned.posts} posts and ${d.scanned.comments} comments.`);
  if(d.has_more) out.push('',`Next: ${p.origin}${sourcesPath('/sources.md',d.domain,d.next_cursor)}`);
  return out.join('\n')+'\n';
}
