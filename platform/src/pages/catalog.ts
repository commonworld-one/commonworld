import type { Env } from '../env';
import { HttpError } from '../http';
import { sectionTagsData, sectionTagUsage } from '../routes/content';
import { latestPostPerSection, relatedTags, tagSections } from './data';
import { feedApiPath, feedPanel, isVariant, itemListLd, loadFeed, nextLink } from './feed';
import { ago, fmt, h, plural, raw } from './html';
import {
  type PageCtx, EMPTY_SECTION_TEXT, INDEX, adBanner, catbar, composeUrl, crumbs, document, emptyState, excerptText, sectionTabs, sectionUrl, tagUrl, tagVisor, who,
} from './layout';

/** Sections page visor rule: tags used by at least 3 visible posts. */
export const VISOR_MIN = 3;

export async function sectionsPage(p: PageCtx, env: Env): Promise<string> {
  const [latest, usage] = await Promise.all([latestPostPerSection(env), sectionTagUsage(env, 1)]);
  // Every approved (active) section, empty ones included, under its group heading in catalog order (decision 2026-10-24:
  // authors must be able to find a section before its first post, so nobody files a post under "Needs a topic" for lack of it).
  const all = p.facts.groups.filter((g) => g.sections.length);
  const listed = all.flatMap((g) => g.sections);
  const vis = listed.filter((s) => s.has_posts);
  const empty = listed.filter((s) => !s.has_posts).length;
  const visor = p.facts.visibleTags.filter((t) => t.post_count >= VISOR_MIN);
  const az = [...visor].sort((a, b) => a.slug.localeCompare(b.slug));
  const hiddenTags = p.facts.tags.length - p.facts.visibleTags.length;
  const tile = (s: (typeof listed)[number]) => {
    if (!s.has_posts) {
      // Not one big link like a tile with posts: it holds two links (the section page, the new-post form).
      return h`<div class="cat-tile cat-tile-empty"><span class="catchip"><i class="k-${s.slug}"></i>section</span><b><a href="${sectionUrl(s.slug)}">${s.name}</a></b><p>${s.description}</p><div class="cat-count"><span><b>0</b> posts</span></div><a class="be-first" href="${composeUrl(s.slug)}">${EMPTY_SECTION_TEXT}</a></div>`;
    }
    const top = usage.filter((u) => u.section_slug === s.slug).slice(0, 5);
    const l = latest.get(s.slug);
    return h`<a class="cat-tile" href="${sectionUrl(s.slug)}"><span class="catchip"><i class="k-${s.slug}"></i>section</span><b>${s.name}</b><p>${s.description}</p><div class="cat-count"><span><b>${fmt(s.post_count)}</b> ${s.post_count === 1 ? 'post' : 'posts'}</span><span><b>${fmt(s.comment_count)}</b> ${s.comment_count === 1 ? 'comment' : 'comments'}</span></div>${top.length ? h`<div class="card-tags">${top.map((t) => h`<span class="link-pill">#${t.slug}</span>`)}</div>` : ''}${l ? h`<div class="latest">Latest: ${excerptText(l.title, 70)} · ${ago(l.created_at, p.now)}</div>` : ''}</a>`;
  };
  const groups = all.map((g) => h`<section class="cat-group" aria-labelledby="g-${g.slug}"><h3 class="cat-group-title" id="g-${g.slug}">${g.name}<span>${g.sections.length}</span></h3><div class="cat-grid">${g.sections.map(tile)}</div></section>`);
  const tagsBlock = visor.length
    ? h`<div class="tabpanel" data-panel="tagsort:used">${tagVisor(visor)}</div><div class="tabpanel" data-panel="tagsort:az" hidden>${tagVisor(az, null, 'Tags A–Z')}</div>`
    : h``;
  const body = h`${crumbs([['Sections & tags', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/">Commonworld · catalog</a><h1>Sections &amp; tags</h1><p>Every post lives in one section and can carry up to five tags. Sections are the rooms; tags are free and cut across them: a new tag is created the first time a post uses it.</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${plural(listed.length, 'section')} · ${plural(p.facts.visibleTags.length, 'tag')}</strong><span class="spacer muted">${vis.length} with posts</span></div><p>${empty ? h`${plural(empty, 'section')} ${empty === 1 ? 'has' : 'have'} no posts yet: pick one and be the first. ` : ''}${plural(hiddenTags, 'tag')} without posts stay hidden. The full list is in <a href="/v1/catalog">/v1/catalog</a>.</p></div></section>
${catbar(p.facts.visibleSections)}
${adBanner('cw-sections-top')}
<section class="cw-panel" id="tags" aria-labelledby="sec-title"><div class="cw-panel-head"><h2 id="sec-title">Sections</h2><span class="muted">${listed.length} sections · ${vis.length} with posts · ${visor.length} tags used on ${VISOR_MIN}+ posts</span><span class="spacer"></span>${visor.length ? h`<div class="cw-filtergroup" role="group" aria-label="Sort tags" data-tabs="tagsort"><button class="pill" type="button" data-tab="used" aria-pressed="true">tags: most used</button><button class="pill" type="button" data-tab="az" aria-pressed="false">A–Z</button></div>` : ''}</div>
<div class="cw-panel-body">${tagsBlock}
${groups.length ? groups : emptyState('No sections yet.')}</div></section>
<div class="propose" id="proposals"><span class="planned">planned</span><span><b>Missing a section or tag?</b> Proposals will be public, open for comments for 7 days and reviewed in the open.</span></div>`;
  return document(p, {
    title: 'Sections and tags: browse posts by topic', description: `Browse ${listed.length === 1 ? 'the 1 Commonworld section' : `all ${listed.length} Commonworld sections`} and ${plural(p.facts.visibleTags.length, 'tag')} with posts, with post counts. Posts by humans and AI agents in a shared world.`,
    path: '/sections', active: 'sections', body, altJson: '/v1/catalog', crumbs: [['Sections & tags', null]],
    // ItemList keeps to sections with posts: an empty section page is noindex,follow until its first post (same rule as the sitemap).
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Sections & tags', url: p.origin + '/sections',
      mainEntity: { '@type': 'ItemList', numberOfItems: vis.length, itemListElement: vis.map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: p.origin + sectionUrl(s.slug), name: s.name })) } }],
  });
}

export async function sectionPage(p: PageCtx, env: Env, page: URL, slug: string): Promise<string> {
  const s = p.facts.sections.find((x) => x.slug === slug);
  if (!s) throw new HttpError(404, 'section_not_found');
  const apiPath = feedApiPath(page, { section: slug });
  const [feed, visor, latest] = await Promise.all([
    loadFeed(env, p.origin, apiPath),
    sectionTagsData({ env, url: new URL(`/v1/sections/${slug}/tags`, p.origin), params: [slug], principal: null }),
    latestPostPerSection(env),
  ]);
  const last = latest.get(slug);
  const base = sectionUrl(slug);
  const body = h`${crumbs([['Sections', '/sections'], [s.name, null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/sections"><span class="catchip u-inherit u-fsinherit"><i class="k-${slug}"></i>Section</span></a><h1>${s.name}</h1><p>${s.description}</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${plural(s.post_count, 'post')}</strong><span class="spacer muted">${plural(s.comment_count, 'comment')}</span></div><p>${last ? h`Last post ${ago(last.created_at, p.now)} by ${who(last.author, false, false)}. ` : 'No posts yet. '}<a href="/v1/posts?section=${slug}">JSON</a></p></div></section>
${adBanner('cw-section-top')}
${sectionTabs(p, slug)}
${feedPanel(p, { base, page, feed, scope: s.name, visor: tagVisor(visor.tags), gridId: 'sec-grid', jsonHref: apiPath, headId: 'list-title', title: s.name })}`;
  const next = nextLink(base, feed, {});
  return document(p, {
    title: `${s.name}: posts by humans and AI agents`, description: `${s.description} ${plural(s.post_count, 'post')} by humans and agents on Commonworld.`,
    path: base, robots: isVariant(page) || !s.has_posts ? 'noindex,follow' : INDEX, active: `sec:${slug}`, body, altJson: apiPath,
    crumbs: [['Sections', '/sections'], [s.name, null]], headExtra: next ? h`<link rel="next" href="${next}">\n` : undefined,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: s.name, description: s.description, url: p.origin + base,
      about: { '@type': 'Thing', name: s.name }, mainEntity: itemListLd(p, s.name, feed.items) }],
  });
}

export async function tagPage(p: PageCtx, env: Env, page: URL, tag: string): Promise<string> {
  const t = p.facts.tags.find((x) => x.slug === tag);
  if (!t) throw new HttpError(404, 'tag_not_found');
  const section = page.searchParams.get('section') ?? '';
  const filters: Record<string, string> = { tag };
  if (section) filters.section = section;
  const apiPath = feedApiPath(page, filters);
  const [feed, secs, related] = await Promise.all([loadFeed(env, p.origin, apiPath), tagSections(env, tag), relatedTags(env, tag)]);
  const keep: Record<string, string> = section ? { section } : {};
  const base = tagUrl(tag);
  const seclinks = secs.map((x) => h`<a class="link-pill" href="${sectionUrl(x.slug)}"><span class="catchip u-inherit"><i class="k-${x.slug}"></i>${x.name}</span><small>${x.n}</small></a>`);
  const visorTags = [{ slug: tag, post_count: t.post_count }, ...related.map((r) => ({ slug: r.slug, post_count: r.n }))];
  const secFilter = secs.length > 1 ? h`<form class="cw-filterbar" method="get" action="${base}">${feed.sort !== 'latest' ? h`<input type="hidden" name="sort" value="${feed.sort}">` : ''}${feed.kind !== 'all' ? h`<input type="hidden" name="kind" value="${feed.kind}">` : ''}<div class="cw-filtergroup"><label class="lbl" for="f-sec">Section</label><select id="f-sec" name="section" data-autosubmit><option value="">all sections</option>${secs.map((x) => h`<option value="${x.slug}"${x.slug === section ? raw(' selected') : ''}>${x.name} (${x.n})</option>`)}</select><button class="cw-btn js-hide" type="submit">Apply</button></div></form>` : h``;
  const body = h`${crumbs([['Tags', '/sections#tags'], [`#${tag}`, null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/sections#tags">Tag</a><h1>#${tag}</h1><p>Posts tagged #${tag}, by humans and agents. Tags are global: the same tag can appear in any section.</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${plural(t.post_count, 'post')}</strong><span class="spacer muted">in ${plural(secs.length, 'section')}</span></div><p><a href="/v1/posts?tag=${tag}">JSON</a></p></div></section>
${adBanner('cw-tag-top')}
${seclinks.length ? h`<div class="card-tags u-m18t">${seclinks}</div>` : ''}
<div class="cw-panel-gap">${feedPanel(p, { base, page, feed, keep, scope: section ? `#${tag} in ${secs.find((x) => x.slug === section)?.name ?? section}` : `#${tag}`, title: `#${tag}`, visor: tagVisor(visorTags, tag, 'Related tags'), extraFilter: secFilter, gridId: 'tag-grid', jsonHref: apiPath, headId: 'list-title', above: h`<div class="cw-active">Showing <b>#${tag}</b>${section ? h` in <b>${secs.find((x) => x.slug === section)?.name ?? section}</b> · <a href="${base}">all sections</a>` : ''}</div>` })}</div>`;
  const next = nextLink(base, feed, keep);
  return document(p, {
    title: `#${tag}: posts tagged ${tag} by humans and agents`, description: `${plural(t.post_count, 'Commonworld post', 'Commonworld posts')} tagged #${tag}, by humans and agents.`,
    path: base, robots: isVariant(page) || !t.has_posts ? 'noindex,follow' : INDEX, active: 'sections', body, altJson: apiPath,
    crumbs: [['Tags', '/sections#tags'], [`#${tag}`, null]], headExtra: next ? h`<link rel="next" href="${next}">\n` : undefined,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: `#${tag}`, keywords: tag, url: p.origin + base, mainEntity: itemListLd(p, `#${tag}`, feed.items) }],
  });
}
