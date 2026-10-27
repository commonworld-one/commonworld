/**
 * /posts/{n}/decisions and its Markdown twin /posts/{n}/decisions.md: the decision record of a living post
 * (src/post-decisions.ts). JSON: GET /v1/posts/{n}/decisions. Same read path and visibility rules for all three.
 */
import type { Env } from '../env';
import { decisionsPath, decisionDay, type PostDecision } from '../post-decisions';
import { decisionsData } from '../routes/decisions';
import { h } from './html';
import { type PageCtx, crumbs, document, who } from './layout';

type Data = Awaited<ReturnType<typeof decisionsData>>;
const nextQuery = (data: Data) => new URLSearchParams({ after: String(data.next_after) }).toString();
const statusText = (d: PostDecision) => (d.status === 'current' ? 'Current' : `Superseded by decision-${d.superseded_by}`);

export async function decisionsPage(p: PageCtx, env: Env, page: URL, n: string) {
  const data = await decisionsData(env, page, n);
  const path = decisionsPath(data.post.number);
  const alternate = `${path}.md${page.search}`;
  const html = document(p, {
    title: `Decisions on ${data.post.ref}`, description: 'What was decided on this post and why, oldest first.', path,
    robots: 'noindex,follow', active: '', altMarkdown: alternate, altJson: `/v1${path}${page.search}`,
    body: h`${crumbs([[data.post.ref, data.post.url], ['Decisions', null]])}
      <header class="entry-head"><h1>Decisions on ${data.post.ref}</h1><p><a href="${data.post.url}">${data.post.title}</a></p>
      <p>${data.note}</p><p class="muted">${data.total} decisions, ${data.current} current.</p></header>
      <section aria-label="Decisions">${data.items.length ? data.items.map((d) => h`<article class="cw-card" id="${d.ref}"><h2>${d.ref}: ${d.summary}</h2>
        <div class="byline">${d.actor ? who(d.actor) : h`<span>a disabled account</span>`}<span>as ${d.actor_role}</span><time datetime="${d.created_at}">${decisionDay(d.created_at)}</time></div>
        ${d.why ? h`<p>${d.why}</p>` : ''}
        <p class="muted">${statusText(d)}${d.supersedes ? h`. Supersedes <a href="#decision-${d.supersedes}">decision-${d.supersedes}</a>` : ''}${d.source ? h`. From <a href="${d.source.url}">${d.source.ref}</a>` : ''}.</p></article>`)
        : h`<p>No decisions recorded on this post yet.</p>`}</section>
      ${data.next_after === null ? '' : h`<p><a class="cw-btn" rel="next" href="${path}?${nextQuery(data)}">Later decisions</a></p>`}`,
  });
  return { html, headers: { link: `<${p.origin}${alternate}>; rel="alternate"; type="text/markdown"` } };
}

// User text must remain text in Markdown too, including link-looking text and HTML (same escaper as connections).
const md = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r?\n/g, ' ');

export async function decisionsMarkdown(p: PageCtx, env: Env, page: URL, n: string) {
  const data = await decisionsData(env, page, n);
  const path = decisionsPath(data.post.number);
  return { robots: 'noindex, follow', markdown: [
    `# Decisions on ${data.post.ref}`, '', `[${md(data.post.title)}](${p.origin}${data.post.url})`, '', data.note, '',
    `${data.total} decisions, ${data.current} current.`, '',
    ...data.items.flatMap((d) => [
      `## ${d.ref}: ${md(d.summary)}`, '',
      `${d.actor ? `By [@${md(d.actor.handle)}](${p.origin}${d.actor.url})` : 'By a disabled account'} as ${d.actor_role} on ${decisionDay(d.created_at)}.`, '',
      ...(d.why ? [md(d.why), ''] : []),
      `${statusText(d)}${d.supersedes ? `. Supersedes decision-${d.supersedes}` : ''}${d.source ? `. From [${d.source.ref}](${p.origin}${d.source.url})` : ''}.`, '',
    ]),
    ...(data.items.length ? [] : ['No decisions recorded on this post yet.', '']),
    ...(data.next_after === null ? [] : [`[Later decisions](${p.origin}${path}.md?${nextQuery(data)})`, '']),
    `JSON: ${p.origin}/v1${path}${page.search}`, '',
  ].join('\n') };
}
