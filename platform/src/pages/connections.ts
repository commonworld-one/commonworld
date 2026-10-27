import type { Env } from '../env';
import { connectionsData, connectionsPath } from '../post-connections';
import { h } from './html';
import { type PageCtx, crumbs, document, who } from './layout';

type Data = Awaited<ReturnType<typeof connectionsData>>;
const read = (p: PageCtx, env: Env, page: URL, n: string) => connectionsData({ env, url: page, params: [n], principal: null });
const query = (data: Data) => new URLSearchParams({ source: data.source, after: String(data.next_after), through: String(data.through) }).toString();
const explanation = 'Scans at most 100 source records per page, oldest first. A page with no matches may still have another scan window. Follow the next window until it ends, and check both posts and comments. This is not a total reference count.';
const syntax = 'Matches whole post-N references and HTTPS /posts/N permalinks on this site. Text in quotes or code counts too. No external links are fetched.';

export async function connectionsPage(p: PageCtx, env: Env, page: URL, n: string) {
  const data = await read(p, env, page, n);
  const path = connectionsPath(data.post.number);
  const viewQuery = new URLSearchParams({ source: data.source, after: String(data.after), through: String(data.through) });
  const alternate = `${path}.md?${viewQuery}`;
  const html = document(p, {
    title: `Connections to ${data.post.ref}`, description: 'Public posts and comments explicitly referencing this post.', path,
    robots: 'noindex,nofollow', active: '', altMarkdown: alternate, altJson: `/v1${path}${page.search}`,
    body: h`${crumbs([[data.post.ref, data.post.url], ['Connections', null]])}
      <header class="entry-head"><h1>Connections to ${data.post.ref}</h1><p><a href="${data.post.url}">${data.post.title}</a></p>
      <p>${data.note}</p><p class="muted">${syntax}</p></header>
      <nav class="cw-filtergroup" aria-label="Reference sources"><a class="cw-btn" rel="nofollow" href="${path}?source=posts" aria-current="${data.source === 'posts' ? 'page' : 'false'}">Posts</a><a class="cw-btn" rel="nofollow" href="${path}?source=comments" aria-current="${data.source === 'comments' ? 'page' : 'false'}">Comments</a></nav>
      <p>${explanation}</p><p class="muted">Source: ${data.source}. Scan after ${data.after}, through ${data.through}.</p>
      <section aria-label="Matching references">${data.items.length ? data.items.map((item) => h`<article class="cw-card"><h2><a href="${item.url}">${item.ref}: ${item.title}</a></h2><div class="byline">${who(item.author)}<time datetime="${item.created_at}">${item.created_at.slice(0, 10)}</time></div><p>${item.excerpt}</p></article>`) : h`<p>No references in this scan window.</p>`}</section>
      ${data.next_after === null ? h`<p>End of this ${data.source} scan. New content requires a fresh scan.</p>` : h`<p><a class="cw-btn" rel="next nofollow" href="${path}?${query(data)}">Next scan window</a></p>`}`,
  });
  return { html, headers: {
    link: `<${p.origin}${alternate}>; rel="alternate"; type="text/markdown"`,
    'x-robots-tag': 'noindex, nofollow',
  } };
}

// User text must remain text in Markdown too, including link-looking titles and HTML.
const md = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r?\n/g, ' ');

export async function connectionsMarkdown(p: PageCtx, env: Env, page: URL, n: string) {
  const data = await read(p, env, page, n);
  const path = connectionsPath(data.post.number);
  return { robots: 'noindex, nofollow', markdown: [
    `# Connections to ${data.post.ref}`, '', `[${md(data.post.title)}](${p.origin}${data.post.url})`, '', data.note, '', syntax, '', explanation, '',
    `Sources: [Posts](${p.origin}${path}.md?source=posts) | [Comments](${p.origin}${path}.md?source=comments)`, '',
    `Source: ${data.source}. Scan after ${data.after}, through ${data.through}.`, '',
    ...data.items.flatMap((item) => [`## [${item.ref}: ${md(item.title)}](${p.origin}${item.url})`, '', `By [@${md(item.author.handle)}](${p.origin}${item.author.url}) on ${item.created_at.slice(0, 10)}.`, '', md(item.excerpt), '']),
    ...(data.items.length ? [] : ['No references in this scan window.', '']),
    data.next_after === null ? `End of this ${data.source} scan. New content requires a fresh scan.` : `[Next scan window](${p.origin}${path}.md?${query(data)})`, '',
    `JSON: ${p.origin}/v1${path}${page.search}`, '',
  ].join('\n') };
}
