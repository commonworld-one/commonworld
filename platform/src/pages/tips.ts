/**
 * /tips and its Markdown twin /tips.md: the public record of thank-you payments between citizens (src/tips.ts).
 * JSON: GET /v1/tips. Same read path and visibility rules for all three.
 */
import type { Env } from '../env';
import { tipDay, type Tip } from '../tips';
import { tipsData } from '../routes/tips';
import { h } from './html';
import { type PageCtx, crumbs, document, who } from './layout';

type Data = Awaited<ReturnType<typeof tipsData>>;
// Alternate links carry only the cache-keyed cursor (`after`), never raw page.search (#221).
const viewSearch = (data: Data) => (data.after > 0 ? `?after=${data.after}` : '');
const nextQuery = (data: Data) => new URLSearchParams({ after: String(data.next_after) }).toString();
const tipLine = (t: Tip) =>
  `${t.amount} ${t.token} on ${t.chain}`;

export async function tipsPage(p: PageCtx, env: Env, page: URL) {
  const data = await tipsData(env, page);
  const path = '/tips';
  const alternate = `${path}.md${viewSearch(data)}`;
  const html = document(p, {
    title: 'Tips', description: 'Thank-you payments citizens recorded for work done here, oldest first.', path,
    active: 'tips', altMarkdown: alternate, altJson: `/v1${path}${viewSearch(data)}`,
    body: h`${crumbs([['Tips', null]])}
      <header class="entry-head"><h1>Tips</h1><p>${data.note}</p><p class="muted">${data.total} tips recorded.</p></header>
      <section aria-label="Tips">${data.items.length ? data.items.map((t) => h`<article class="cw-card" id="${t.ref}"><h2>${t.ref}: ${tipLine(t)}</h2>
        <div class="byline">${t.from ? who(t.from) : h`<span>a disabled account</span>`}<span>tipped</span>${t.to ? who(t.to) : h`<span>a disabled account</span>`}<time datetime="${t.created_at}">${tipDay(t.created_at)}</time></div>
        <p class="muted">Transaction <a href="${t.tx_url}" rel="noopener noreferrer nofollow">${t.tx}</a>${t.post ? h`, paying for <a href="${t.post.url}">${t.post.ref}</a>` : ''}.</p>
        ${t.note ? h`<p>${t.note}</p>` : ''}</article>`)
        : h`<p>No tips recorded yet.</p>`}</section>
      ${data.next_after === null ? '' : h`<p><a class="cw-btn" rel="next" href="${path}?${nextQuery(data)}">Later tips</a></p>`}`,
  });
  return { html, headers: { link: `<${p.origin}${alternate}>; rel="alternate"; type="text/markdown"` } };
}

// User text must remain text in Markdown too, including link-looking text and HTML (same escaper as connections).
const md = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r?\n/g, ' ');

export async function tipsMarkdown(p: PageCtx, env: Env, page: URL) {
  const data = await tipsData(env, page);
  const path = '/tips';
  return { robots: null, markdown: [
    `# Tips`, '', data.note, '',
    `${data.total} tips recorded.`, '',
    ...data.items.flatMap((t) => [
      `## ${t.ref}: ${md(tipLine(t))}`, '',
      `${t.from ? `[@${md(t.from.handle)}](${p.origin}${t.from.url})` : 'A disabled account'} tipped ${t.to ? `[@${md(t.to.handle)}](${p.origin}${t.to.url})` : 'a disabled account'} on ${tipDay(t.created_at)}.`, '',
      `Transaction [${t.tx.slice(0, 18)}...](${t.tx_url})${t.post ? `, paying for [${t.post.ref}](${p.origin}${t.post.url})` : ''}.`, '',
      ...(t.note ? [md(t.note), ''] : []),
    ]),
    ...(data.items.length ? [] : ['No tips recorded yet.', '']),
    ...(data.next_after === null ? [] : [`[Later tips](${p.origin}${path}.md?${nextQuery(data)})`, '']),
    `JSON: ${p.origin}/v1${path}${viewSearch(data)}`, '',
  ].join('\n') };
}
