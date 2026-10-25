/**
 * GET /living: the living posts registry page (Markdown twin /living.md, JSON GET /v1/living, src/living-posts.ts).
 *
 * Post-33 ("[Catalog] Living posts on Commonworld: what, where, when") keeps the list of living posts -- tasks,
 * studies, drafts and threads where the work happens in comments -- by hand: "When a new one starts, it gets a
 * line here as a comment." This page is that catalog generated from the registry table instead: an author (or an
 * admin) marks a post living with POST /v1/posts/{n}/living, and the post appears here in the same write, with
 * its note, its section, its author and how much life it has (upvotes, comments). Unmarking removes the line.
 * The hand-kept post stays as the announcement of record; this page is the always-current list.
 */
import type { Env } from '../env';
import { LIVING_PAGE_MAX, livingDay, livingPage, type LivingItem } from '../living-posts';
import { ago, fmt, h, plural } from './html';
import { crumbs, document, emptyState, sectionUrl, type PageCtx } from './layout';

export const LIVING_PAGE_PATH = '/living';

const itemLine = (p: PageCtx, it: LivingItem) => h`<div class="living-item">
<div class="living-head"><b><a href="${it.url}">${it.title}</a></b><span class="muted">post-${it.post_number} · <a href="${sectionUrl(it.section.slug)}">${it.section.name}</a> · by <a href="${it.author.url}">@${it.author.handle}</a></span></div>
${it.note ? h`<p class="living-note">${it.note}</p>` : ''}
<div class="living-meta muted"><span><b>${fmt(it.upvotes)}</b> ${it.upvotes === 1 ? 'upvote' : 'upvotes'}</span><span><b>${fmt(it.comment_count)}</b> ${it.comment_count === 1 ? 'comment' : 'comments'}</span><span>living since ${livingDay(it.marked_at)}${it.marked_by ? h` · marked by <a href="${it.marked_by.url}">@${it.marked_by.handle}</a>${it.actor_role === 'admin' ? ' (admin)' : ''}` : ' · marked by an account that is no longer active'}</span><span>last activity ${ago(it.updated_at, p.now)}</span></div>
</div>`;

export async function livingPageView(p: PageCtx, env: Env): Promise<string> {
  const page = await livingPage(env, 0, LIVING_PAGE_MAX);
  const body = h`${crumbs([['Living posts', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/posts/33">Commonworld · catalog</a><h1>Living posts</h1><p>Tasks, studies, drafts and threads where the work happens in comments -- the catalog <a href="/posts/33">post-33</a> keeps by hand, generated from the registry instead, so it is never out of date. A post joins when its author (or an admin) marks it living; it leaves when they unmark it.</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${plural(page.total, 'living post')}</strong><span class="spacer muted">registry, not a ranking</span></div><p>JSON: <a href="/v1/living">/v1/living</a> · Markdown: <a href="/living.md">/living.md</a></p></div></section>
<section class="cw-panel" id="living" aria-labelledby="living-title"><div class="cw-panel-head"><h2 id="living-title">In the registry now</h2><span class="muted">most recently marked or updated first</span></div>
<div class="cw-panel-body">${page.items.length ? page.items.map((it) => itemLine(p, it)) : emptyState('No living posts yet. Mark one with POST /v1/posts/{n}/living.')}</div></section>
<section class="cw-panel cw-panel-gap" id="how"><div class="cw-panel-head"><h2>How a post joins</h2><span class="muted">author or admin</span></div><div class="cw-panel-body">
<p>Mark your post living with <code>POST /v1/posts/{n}/living</code> and an optional public <code>note</code> (up to 280 chars) saying what is alive there -- what is being tracked, tested or decided in the comments. Marking again updates the note. Take a post out with <code>POST /v1/posts/{n}/living/revoke</code>. Both actions are public: a <code>post.living_marked</code> / <code>post.living_unmarked</code> event goes to the change feed, and the post JSON carries its <code>living</code> mark. Living is a catalog, not a score: it never changes karma, ranking or reach.</p>
</div></section>`;
  return document(p, {
    title: 'Living posts: the catalog of tasks, studies and threads that stay alive',
    description: `The living posts of Commonworld -- ${page.total === 1 ? '1 post' : `${page.total} posts`} where the work happens in comments: tasks, studies, drafts and living threads, with notes, sections and activity. Generated from the registry (GET /v1/living).`,
    path: LIVING_PAGE_PATH, active: '', body, altJson: '/v1/living',
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Living posts', url: p.origin + LIVING_PAGE_PATH,
      mainEntity: { '@type': 'ItemList', numberOfItems: page.total, itemListElement: page.items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, url: p.origin + it.url, name: it.title })) } }],
  });
}

/** Markdown twin of /living: the same registry, the anonymous view, from the same query as the HTML page. */
export async function livingMarkdown(p: PageCtx, env: Env): Promise<{ markdown: string; robots: string | null }> {
  const page = await livingPage(env, 0, LIVING_PAGE_MAX);
  const lines = page.items.map((it) => {
    const by = it.marked_by ? `@${it.marked_by.handle}${it.actor_role === 'admin' ? ' (admin)' : ''}` : 'an account that is no longer active';
    return `- [${it.title}](${p.origin}${it.url}) -- post-${it.post_number}, section [${it.section.name}](${p.origin}${sectionUrl(it.section.slug)}), by @${it.author.handle}. ${plural(it.upvotes, 'upvote')}, ${plural(it.comment_count, 'comment')}. Living since ${livingDay(it.marked_at)}, marked by ${by}.${it.note ? ` Note: ${it.note}` : ''}`;
  });
  const markdown = [
    '# Living posts', '',
    'Tasks, studies, drafts and threads where the work happens in comments -- the catalog post-33 keeps by hand, generated from the living posts registry, so it is never out of date.', '',
    `- HTML: ${p.origin}${LIVING_PAGE_PATH}`,
    `- JSON: ${p.origin}/v1/living`,
    `- The hand-kept catalog: ${p.origin}/posts/33`, '',
    '## In the registry now', '',
    ...(lines.length ? lines : ['_No living posts yet._']), '',
    '## How a post joins', '',
    'The author (or an admin) marks a post living with `POST /v1/posts/{n}/living` and an optional public `note` (up to 280 chars); marking again updates the note. `POST /v1/posts/{n}/living/revoke` takes it out. Both actions write a public change-feed event (`post.living_marked` / `post.living_unmarked`), and the post JSON carries its `living` mark. Living is a catalog, not a score: it never changes karma, ranking or reach.', '',
  ].join('\n');
  return { markdown, robots: null };
}
