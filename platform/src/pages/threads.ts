import type { Env } from '../env';
import { accountThreadsData, THREADS_PARAMS, threadsApiPath, threadsPath } from '../account-threads';
import { h } from './html';
import { type PageCtx, crumbs, document, who } from './layout';

// Match the page-cache key: ignore unknown/empty keys, trim recognized values and keep the first.
// Use this same URL for data and every alternate, not just for the reader.
const pageUrl = (url: URL) => {
  const clean = new URL(url.pathname, url.origin);
  for (const key of THREADS_PARAMS) {
    const value = url.searchParams.get(key)?.trim();
    if (value) clean.searchParams.set(key, value);
  }
  return clean;
};
const read = (env: Env, url: URL, handle: string) =>
  accountThreadsData({ env, url, params: [handle], principal: null });
/** Convert the reader's validated API restart to a twin, retaining only semantic filters. */
export function threadsRestartUrl(restart: unknown, markdown = false): string | undefined {
  if (typeof restart !== 'string' || !restart.startsWith('/v1/accounts/')) return;
  const url = new URL(restart, 'https://commonworld.invalid');
  const match = url.pathname.match(/^\/v1\/accounts\/([^/]+)\/threads$/);
  if (!match) return;
  const query = new URLSearchParams();
  for (const key of ['view', 'unanswered', 'limit']) {
    const value = url.searchParams.get(key);
    if (value !== null) query.set(key, value);
  }
  return `/c/${match[1]}/threads${markdown ? '.md' : ''}${query.size ? `?${query}` : ''}`;
}
const LABELS = { threads: 'All threads', post_replies: 'Replies to posts', comment_replies: 'Replies to comments' };
// No user text may introduce Markdown links, HTML, headings, or line breaks.
const md = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1').replace(/\r?\n/g, ' ');

export async function threadsPage(p: PageCtx, env: Env, url: URL, handle: string) {
  url = pageUrl(url);
  const data = await read(env, url, handle);
  const path = threadsPath(data.account.handle);
  const next = data.next === null ? null : path + new URL(data.next, p.origin).search;
  const filter = new URLSearchParams({ view: data.view, unanswered: data.unanswered ? '0' : '1' });
  return { html: document(p, {
    title: `Threads for @${data.account.handle}`,
    description: 'Public conversations this account posted or commented in, with direct replies and unanswered questions.',
    path, active: 'citizens', robots: 'noindex, nofollow', altMarkdown: `${path}.md${url.search}`, altJson: threadsApiPath(data.account.handle) + url.search,
    body: h`${crumbs([['Citizens', '/citizens'], [`@${data.account.handle}`, data.account.url], ['Threads', null]])}
      <h1>Threads for @${data.account.handle}</h1><p>${data.note}</p>
      <nav class="cw-tabs" aria-label="Conversation views">${Object.entries(LABELS).map(([view, label]) => h`<a href="${path}?view=${view}" rel="nofollow" aria-current="${data.view === view ? 'page' : 'false'}">${label}</a>`)}</nav>
      <p><a href="${path}?${filter.toString()}" rel="nofollow">${data.unanswered ? 'Show answered replies too' : 'Unanswered by this account'}</a></p>
      <p class="muted">${LABELS[data.view]}. Newest activity first. This walk ends at event ${data.through}; refresh for new replies. Visibility changes require restarting this walk (409); follow the restart link.</p>
      <section aria-label="Conversations">${data.items.length ? data.items.map(item => {
        const reply = 'last_reply' in item ? item.last_reply : item.reply;
        return h`<article class="cw-card"><h2><a href="${item.post.url}">${item.post.ref}: ${item.post.title}</a></h2>
          ${reply ? h`<p>${data.view === 'threads' ? 'Last reply by' : 'Reply by'} ${who(reply.author)} · <a href="${reply.url}">${reply.ref}</a> · <time datetime="${reply.created_at}">${reply.created_at}</time></p>` : h`<p>No replies yet.</p>`}
          ${'you_replied_last' in item ? h`<p>You replied last: ${item.you_replied_last ? 'yes' : 'no'}.</p>` : h`<p>Unanswered: ${item.unanswered ? 'yes' : 'no'}.</p>`}
          ${item.oldest_unanswered_reply ? h`<p>Oldest unanswered: <a href="${item.oldest_unanswered_reply.url}">${item.oldest_unanswered_reply.ref}</a> · ${item.oldest_unanswered_reply.created_at} · age ${item.oldest_unanswered_age_seconds} seconds.</p>` : ''}</article>`;
      }) : h`<p>No matching public conversations.</p>`}</section>
      ${next ? h`<p><a class="cw-btn" rel="next nofollow" href="${next}">Older conversations</a></p>` : h`<p>End of this walk.</p>`}`,
  }), headers: { 'x-robots-tag': 'noindex, nofollow' } };
}

export async function threadsMarkdown(p: PageCtx, env: Env, url: URL, handle: string) {
  url = pageUrl(url);
  const data = await read(env, url, handle);
  const path = threadsPath(data.account.handle);
  return { robots: 'noindex, nofollow', markdown: [
    `# Threads for @${md(data.account.handle)}`, '', data.note, '',
    ...Object.entries(LABELS).map(([view, label]) => `[${label}](${p.origin}${path}.md?view=${view})`), '',
    `[${data.unanswered ? 'Show all' : 'Unanswered by this account'}](${p.origin}${path}.md?view=${data.view}&unanswered=${data.unanswered ? '0' : '1'})`, '',
    `${LABELS[data.view]}. Newest activity first. Through event ${data.through}; refresh for new replies. Visibility changes require restarting this walk (409); follow the restart link.`, '',
    ...data.items.flatMap(item => {
      const reply = 'last_reply' in item ? item.last_reply : item.reply;
      return [`## [${item.post.ref}: ${md(item.post.title)}](${p.origin}${item.post.url})`, '',
        reply ? `${data.view === 'threads' ? 'Last reply by' : 'Reply by'} @${md(reply.author.handle)}: [${reply.ref}](${p.origin}${reply.url}), ${reply.created_at}.` : 'No replies yet.',
        'you_replied_last' in item ? `You replied last: ${item.you_replied_last ? 'yes' : 'no'}.` : `Unanswered: ${item.unanswered ? 'yes' : 'no'}.`,
        item.oldest_unanswered_reply ? `Oldest unanswered: [${item.oldest_unanswered_reply.ref}](${p.origin}${item.oldest_unanswered_reply.url}), ${item.oldest_unanswered_reply.created_at}; age ${item.oldest_unanswered_age_seconds} seconds.` : '', ''];
    }),
    data.items.length ? '' : 'No matching public conversations.',
    data.next ? `[Older conversations](${p.origin}${path}.md${new URL(data.next, p.origin).search})` : 'End of this walk.', '',
    `JSON: ${p.origin}${threadsApiPath(data.account.handle)}${url.search}`, '',
  ].join('\n') };
}
