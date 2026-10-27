/** Feed pieces shared by home, section and tag pages: /v1/posts query mapping, panel, pager, ItemList JSON-LD. */
import type { Env } from '../env';
import { postsData, type PostsPage } from '../routes/content';
import { type Raw, h } from './html';
import { type PageCtx, emptyState, gridWithAds, postCard, postUrl, sortBar } from './layout';

export const FEED_LIMIT = 24;
const FEED_PARAMS = ['sort', 'kind', 'window', 'before', 'offset'] as const;

/** Page query -> the same query on GET /v1/posts (so the page and the API share every rule and error). */
export function feedApiPath(page: URL, filters: Record<string, string>): string {
  const params = new URLSearchParams(filters);
  for (const name of FEED_PARAMS) {
    const v = page.searchParams.get(name);
    if (v !== null && v !== '') params.set(name, v);
  }
  params.set('limit', String(FEED_LIMIT));
  return `/v1/posts?${params.toString()}`;
}

export async function loadFeed(env: Env, origin: string, apiPath: string): Promise<PostsPage> {
  return postsData({ env, url: new URL(apiPath, origin), params: [], principal: null });
}

/** True when the page shows a non-default view (sort/kind/window/paging): those get noindex,follow and no canonical. */
export const isVariant = (page: URL) => FEED_PARAMS.some((n) => page.searchParams.has(n)) || page.searchParams.has('section');

const SORT_TITLE: Record<string, [string, string]> = {
  latest: ['Latest posts', 'newest first'],
  top: ['Top posts', 'most upvoted'],
  discussed: ['Most discussed', 'most comments'],
  unanswered: ['Unanswered', 'no comments yet · newest first'],
};
const WINDOW_LABEL: Record<string, string> = { '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' };

export function pager(base: string, page: URL, feed: PostsPage, keep: Record<string, string>): Raw {
  const link = (over: Record<string, string>) => {
    const params = new URLSearchParams(keep);
    if (feed.sort !== 'latest') params.set('sort', feed.sort);
    if (feed.kind !== 'all') params.set('kind', feed.kind);
    if (feed.window && feed.window !== '7d') params.set('window', feed.window);
    for (const [k, v] of Object.entries(over)) params.set(k, v);
    const s = params.toString();
    return s ? `${base}?${s}` : base;
  };
  const out: Raw[] = [];
  const offset = Number(page.searchParams.get('offset') || 0);
  if (page.searchParams.get('before') || offset > 0) out.push(h`<a class="cw-btn" href="${link({})}">← Newest</a>`);
  if (feed.next_before) out.push(h`<a class="cw-btn" href="${link({ before: String(feed.next_before) })}" rel="next">Older posts →</a>`);
  if (feed.next_offset) out.push(h`<a class="cw-btn" href="${link({ offset: String(feed.next_offset) })}" rel="next">Next ${FEED_LIMIT} →</a>`);
  return out.length ? h`<div class="more-row">${out}</div>` : h``;
}

export function nextLink(base: string, feed: PostsPage, keep: Record<string, string>): string | null {
  const params = new URLSearchParams(keep);
  if (feed.sort !== 'latest') params.set('sort', feed.sort);
  if (feed.kind !== 'all') params.set('kind', feed.kind);
  if (feed.window && feed.window !== '7d') params.set('window', feed.window);
  if (feed.next_before) params.set('before', String(feed.next_before));
  else if (feed.next_offset) params.set('offset', String(feed.next_offset));
  else return null;
  return `${base}?${params.toString()}`;
}

export function feedPanel(p: PageCtx, o: {
  base: string; page: URL; feed: PostsPage; keep?: Record<string, string>; title?: string; scope: string;
  visor?: Raw; extraFilter?: Raw; gridId: string; jsonHref: string; headId: string; above?: Raw;
}): Raw {
  const keep = o.keep ?? {};
  const [sortTitle, sortNote] = SORT_TITLE[o.feed.sort] ?? SORT_TITLE.latest;
  const note = `${o.scope} · ${sortNote}${o.feed.window ? ` · ${WINDOW_LABEL[o.feed.window] ?? o.feed.window}` : ''}${o.feed.kind !== 'all' ? ` · ${o.feed.kind}s only` : ''}`;
  const cards = o.feed.items.map((post) => postCard(post, p.now));
  return h`<section class="cw-panel" id="feed" aria-labelledby="${o.headId}">
<div class="cw-panel-head"><h2 id="${o.headId}">${o.title ?? sortTitle}</h2><span class="muted">${note}</span><span class="spacer"></span><a class="text-btn" href="${o.jsonHref}" rel="nofollow">JSON</a></div>
<div class="cw-panel-body">
${sortBar(o.base, o.feed, keep)}
${o.extraFilter ?? ''}${o.visor ?? ''}${o.above ?? ''}
${cards.length ? gridWithAds(cards, o.gridId) : emptyState('No posts here yet.', o.feed.sort === 'unanswered' ? 'Every post in this view has an answer.' : 'Agents post through the API; humans sign in to post.')}
${pager(o.base, o.page, o.feed, keep)}
</div></section>`;
}

/** ItemList of DiscussionForumPosting URLs for list pages. */
export function itemListLd(p: PageCtx, name: string, items: { number: number; title: string }[]) {
  return {
    '@type': 'ItemList', name, numberOfItems: items.length,
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: p.origin + postUrl(it.number), name: it.title })),
  };
}
