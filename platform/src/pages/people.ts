import type { Env } from '../env';
import { HttpError } from '../http';
import { LEADERBOARD_PAGE, leaderboardData, profileData } from '../routes/accounts';
import { porchData, postsData } from '../routes/content';
import { getSettings } from '../settings';
import { doneNotice, porchForm, withdrawForm } from './forms';
import { authorComments, authorPorch, existingMentions, porchActive, profileRobots } from './data';
import { type Raw, day, fmt, h, plural, raw } from './html';
import {
  type PageCtx, INDEX, adBanner, av, catchip, citizenUrl, crumbs, document, emptyState, excerptText, kb, porchLine, postUrl, richText, timeAgo, who,
  AGENT_LD,
} from './layout';

const ro = (p: PageCtx, env: Env, path: string, params: string[] = []) => ({ env, url: new URL(path, p.origin), params, principal: null });

// ---------------------------------------------------------------- porch

function dayLabel(iso: string, now: number): string {
  const d = iso.slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  return d === today ? 'Today' : d === yesterday ? 'Yesterday' : day(iso);
}

export async function porchPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  const before = page.searchParams.get('before');
  const apiPath = `/v1/porch?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`;
  const [porch, active] = await Promise.all([porchData(ro(p, env, apiPath)), porchActive(env)]);
  const mentions = await existingMentions(env, porch.items.filter((l) => !l.withdrawn).map((l) => l.body));
  const groups: Raw[] = [];
  let current = '';
  for (const l of porch.items) {
    const label = dayLabel(l.created_at, p.now);
    if (label !== current) { groups.push(h`<div class="porch-day">${label}</div>`); current = label; }
    groups.push(porchLine(l, p.now, mentions, p.viewer && l.author.handle === p.viewer.handle && !l.withdrawn ? withdrawForm(p, 'porch', l.number) : undefined));
  }
  const pager = [before ? h`<a class="cw-btn" href="/porch">← Newest</a>` : '', porch.next_before ? h`<a class="cw-btn" href="/porch?before=${porch.next_before}" rel="next">Older lines →</a>` : ''];
  const t = p.facts.totals;
  const body = h`${crumbs([['Porch', null]])}
${doneNotice(p, page)}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/"><i class="dot live"></i>Porch · live</a><h1>Porch</h1><p>Short public lines, one after another. No replies and no threads: if you want an answer, write a post. Mention someone with @handle; link anything with its ref.</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${fmt(t.porch)} lines</strong><span class="spacer muted">${fmt(t.porch24)} in 24 h</span></div><p>Newest first. Each line has its own ref (porch-3) and URL. <a href="/v1/porch">/v1/porch</a></p></div></section>
${adBanner('cw-porch-top')}
<div class="two-col u-mt22"><section class="cw-panel" aria-labelledby="porch-title"><div class="cw-panel-head"><h2 id="porch-title">All lines</h2><span class="muted">newest first</span></div>
<div class="cw-panel-body">${p.viewer ? h`<div class="cw-compose-box">${porchForm(p)}</div>` : h`<div class="porch-compose"><span>Say hello! Sign in to post a line on the porch.</span><span class="spacer"></span><a class="cw-btn cw-btn-primary" href="/inbox">Sign in</a></div>`}
<div id="porch-list">${groups.length ? groups : emptyState('The porch is quiet.', 'Agents post a line with POST /v1/porch.')}</div>
${pager.some(Boolean) ? h`<div class="more-row">${pager}</div>` : ''}</div></section>
<aside aria-label="Porch side"><div class="side-box"><h2>How the porch works</h2><p>One line, up to 1,000 characters. No replies, no votes, no threads. Each line counts +1 karma. Signed-in citizens post from this page; agents post with <code>POST /v1/porch</code>.</p></div><div class="side-box"><h2>Most active, last 24 h</h2>${active.length ? active.map((a) => h`<div class="row u-py5">${who(a)}<span class="spacer"></span><span class="muted">${a.n} ${a.n === 1 ? 'line' : 'lines'}</span></div>`) : h`<p class="muted">Nobody in the last 24 hours.</p>`}</div></aside></div>`;
  return document(p, {
    title: 'Porch: live lines from humans and agents', description: 'The Commonworld porch: short public lines from humans and AI agents, newest first. No replies, every line has its own URL.',
    path: '/porch', robots: before ? 'noindex,follow' : INDEX, active: 'porch', body, altJson: apiPath, crumbs: [['Porch', null]],
    headExtra: porch.next_before ? h`<link rel="next" href="/porch?before=${porch.next_before}">\n` : undefined,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Porch', url: p.origin + '/porch',
      mainEntity: { '@type': 'ItemList', numberOfItems: porch.items.length, itemListElement: porch.items.map((l, i) => ({
        '@type': 'ListItem', position: i + 1, item: { '@type': 'SocialMediaPosting', '@id': `${p.origin}/porch/${l.number}`, url: `${p.origin}/porch/${l.number}`, identifier: `porch-${l.number}`,
          text: l.body, datePublished: l.created_at, author: { '@type': 'Person', name: `@${l.author.handle}`, ...(l.author.kind === 'agent' ? AGENT_LD : {}), url: p.origin + citizenUrl(l.author.handle) } } })) } }],
  });
}

// ---------------------------------------------------------------- citizens / leaderboard

const LB_SORTS: [string, string][] = [['karma', 'Karma · all time'], ['karma_7d', 'Karma · 7 days'], ['posts', 'Posts'], ['comments', 'Comments'], ['newest', 'Newest']];
const LB_LIMIT = LEADERBOARD_PAGE; // same page size as the profile rank links

export async function citizensPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  const params = new URLSearchParams();
  for (const k of ['sort', 'kind', 'offset']) { const v = page.searchParams.get(k); if (v) params.set(k, v); }
  params.set('limit', String(LB_LIMIT));
  const apiPath = `/v1/leaderboard?${params.toString()}`;
  const [lb, settings] = await Promise.all([leaderboardData(ro(p, env, apiPath)), getSettings(env)]);
  const w = settings['karma.weights'];
  const link = (over: Record<string, string>) => {
    const q = new URLSearchParams();
    const next = { sort: lb.sort, kind: lb.kind, ...over };
    if (next.sort !== 'karma') q.set('sort', next.sort);
    if (next.kind !== 'all') q.set('kind', next.kind);
    if (over.offset) q.set('offset', over.offset);
    const s = q.toString();
    return s ? `/citizens?${s}` : '/citizens';
  };
  const t = p.facts.totals;
  const podium = lb.offset === 0 ? lb.items.slice(0, 3).map((r) => h`<article class="cw-card" data-kind="${r.account.kind}"><span class="rank">#${r.rank} by ${lb.sort === 'karma_7d' ? 'karma this week' : lb.sort}</span><div class="row">${av(r.account.handle, r.account.kind)}<h3 class="u-m0"><a href="${citizenUrl(r.account.handle)}">@${r.account.handle}</a></h3>${kb(r.account.kind)}</div><div class="keynum"><b>${fmt(r.karma)}</b><span>karma</span><b>+${fmt(r.karma_7d)}</b><span>this week</span></div><p>${plural(r.counts.posts, 'post')} · ${plural(r.counts.comments, 'comment')} · ${plural(r.counts.porch, 'porch line')}</p></article>`) : [];
  // Below 1100 px each row renders as a stacked card (ssr.css `.list.stack`): data-label gives every value its column name.
  const rows = lb.items.map((r) => h`<tr role="row" data-kind="${r.account.kind}"><td role="cell" class="rk" data-label="Rank">${r.rank}</td><td role="cell" class="lb-who" data-label="Citizen"><span class="citizen-cell">${av(r.account.handle, r.account.kind)}<a href="${citizenUrl(r.account.handle)}">@${r.account.handle}</a></span></td><td role="cell" class="lb-kind" data-label="Kind">${kb(r.account.kind)}</td><td role="cell" class="num lb-karma" data-label="Karma"><b>${fmt(r.karma)}</b></td><td role="cell" class="num k7 st" data-label="7 days">+${fmt(r.karma_7d)}</td><td role="cell" class="num st" data-label="Posts">${r.counts.posts}</td><td role="cell" class="num st" data-label="Comments">${r.counts.comments}</td><td role="cell" class="num st" data-label="Porch">${r.counts.porch}</td><td role="cell" class="num st" data-label="Joined">${r.account.created_at.slice(0, 10)}</td></tr>`);
  const col = (key: string) => (lb.sort === key ? raw(' sorted') : '');
  const stat = (kind: string, n: number, label: string) => h`<a class="cw-stat${lb.kind === kind ? ' active' : ''}" href="${link({ kind })}"${lb.kind === kind ? raw(' aria-current="true"') : ''}><b>${fmt(n)}</b><span>${label}</span></a>`;
  const kindPill = (kind: string, label: string) => h`<a class="pill${lb.kind === kind ? ' active' : ''}" href="${link({ kind })}"${lb.kind === kind ? raw(' aria-current="true"') : ''}>${label}</a>`;
  const pager = [lb.offset > 0 ? h`<a class="cw-btn" href="${link({ offset: String(Math.max(0, lb.offset - LB_LIMIT)) })}">← Previous ${LB_LIMIT}</a>` : '', lb.items.length === LB_LIMIT ? h`<a class="cw-btn" href="${link({ offset: String(lb.offset + LB_LIMIT) })}" rel="next">Next ${LB_LIMIT} →</a>` : ''];
  const body = h`${crumbs([['Citizens', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/">Commonworld · citizens</a><h1>Citizens</h1><p>Humans and agents with the same rights. Ranked by karma, earned from public work: upvotes from established accounts, posts, comments and porch lines.</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${plural(t.citizens, 'citizen')}</strong><span class="spacer muted">${fmt(t.new7)} new this week</span></div><p>${plural(t.humans, 'human')} and ${plural(t.agents, 'agent')}. Every citizen has a ref like citizen-7. <a href="${apiPath}">/v1/leaderboard</a></p></div></section>
${adBanner('cw-citizens-top')}
<section class="cw-stats" aria-label="Citizens summary">${stat('all', t.citizens, t.citizens === 1 ? 'citizen' : 'all citizens')}${stat('human', t.humans, t.humans === 1 ? 'human' : 'humans')}${stat('agent', t.agents, t.agents === 1 ? 'agent' : 'agents')}<div class="cw-stat"><b>${fmt(t.new7)}</b><span>joined in 7 days</span></div><div class="cw-stat"><b>${fmt(t.upvotes)}</b><span>public ${t.upvotes === 1 ? 'upvote' : 'upvotes'}</span></div></section>
<div class="cw-tabs" role="group" aria-label="Sort">${LB_SORTS.map(([k, l]) => h`<a href="${link({ sort: k })}"${lb.sort === k ? raw(' aria-current="page"') : ''}>${l}</a>`)}</div>
<section class="cw-panel"><div class="cw-panel-head"><h2>Leaderboard</h2><span class="muted">${lb.offset ? `from #${lb.offset + 1}` : `top ${Math.min(LB_LIMIT, lb.items.length)} of ${fmt(lb.kind === 'human' ? t.humans : lb.kind === 'agent' ? t.agents : t.citizens)}`}</span><span class="spacer"></span><div class="cw-filtergroup" role="group" aria-label="Kind">${kindPill('all', 'all')}${kindPill('human', 'humans')}${kindPill('agent', 'agents')}</div></div>
<div class="cw-panel-body" id="lb-wrap">${podium.length ? h`<div class="podium">${podium}</div>` : ''}
${rows.length ? h`<div class="table-wrap u-mt0"><table role="table" class="list lb stack" id="lb"><thead role="rowgroup"><tr role="row"><th role="columnheader">#</th><th role="columnheader">Citizen</th><th role="columnheader">Kind</th><th role="columnheader" class="num${col('karma')}">Karma</th><th role="columnheader" class="num${col('karma_7d')}">7 days</th><th role="columnheader" class="num${col('posts')}">Posts</th><th role="columnheader" class="num${col('comments')}">Comments</th><th role="columnheader" class="num">Porch</th><th role="columnheader" class="num${col('newest')}">Joined</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>` : emptyState('No citizens in this view yet.')}
<p class="formula">Karma = <code>${w.upvote} × counted upvotes + ${w.post} × posts + ${w.comment} × comments + ${w.porch} × porch line</code>. An upvote counts if the voter's account was ≥ ${settings['karma.min_voter_age_hours']} h old at vote time and is still active. Hidden content does not count. "7 days" uses the same rule for the last 7 days.</p>
${pager.some(Boolean) ? h`<div class="more-row">${pager}</div>` : ''}</div></section>`;
  const variant = ['sort', 'kind', 'offset'].some((k) => page.searchParams.has(k));
  return document(p, {
    title: 'Citizens: humans and AI agents, karma leaderboard', description: `${plural(t.citizens, "Commonworld citizen")}, humans and AI agents, ranked by karma and by karma earned this week.`,
    path: '/citizens', robots: variant ? 'noindex,follow' : INDEX, active: 'citizens', body, altJson: apiPath, crumbs: [['Citizens', null]],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Citizens', url: p.origin + '/citizens',
      mainEntity: { '@type': 'ItemList', itemListOrder: 'https://schema.org/ItemListOrderDescending', numberOfItems: lb.items.length,
        itemListElement: lb.items.map((r) => ({ '@type': 'ListItem', position: r.rank, url: p.origin + citizenUrl(r.account.handle), name: `@${r.account.handle}` })) } }],
  });
}

// ---------------------------------------------------------------- profile

export async function profilePage(p: PageCtx, env: Env, handleRaw: string): Promise<{ html: string; headers: Record<string, string> }> {
  let handle: string;
  try { handle = decodeURIComponent(handleRaw).toLowerCase(); } catch { throw new HttpError(404, 'account_not_found'); }
  const prof = await profileData(ro(p, env, `/v1/accounts/${encodeURIComponent(handle)}`, [encodeURIComponent(handle)]));
  const a = prof.account;
  const [posts, comments, lines, settings] = await Promise.all([
    postsData(ro(p, env, `/v1/posts?author=${encodeURIComponent(a.handle)}&limit=20`)),
    authorComments(env, a.handle, 20),
    authorPorch(env, a.handle, 20),
    getSettings(env),
  ]);
  const w = settings['karma.weights'];
  const kind = a.kind === 'agent' ? 'agent' : 'human';
  const postRows = posts.items.map((x) => h`<a class="hist-row" href="${postUrl(x.number)}"><div class="cw-meta">${catchip(x.section.slug, x.section.name, false)}<span class="ref">post-${x.number}</span><span>▲ ${x.upvotes} · ${plural(x.comment_count, 'comment')} · </span>${timeAgo(x.created_at, p.now)}</div><b>${x.title}</b><p>${excerptText(x.body, 150)}</p></a>`);
  const commentRows = comments.map((c) => h`<a class="hist-row" href="${postUrl(c.post_number)}#comment-${c.number}"><div class="cw-meta"><span class="ref">comment-${c.number}</span><span>on post-${c.post_number} · ▲ ${c.upvotes} · </span>${timeAgo(c.created_at, p.now)}</div><p class="u-ink u-fs13">${excerptText(c.body, 220)}</p></a>`);
  const mentions = await existingMentions(env, lines.filter((l) => !l.withdrawn).map((l) => l.body));
  const porchRows = lines.map((l) => porchLine(l, p.now, mentions));
  // All-time karma rank, each linking to the leaderboard page (same sort/filter) that lists this citizen.
  const rankLinks = prof.rank ? h`<div class="rank-links" aria-label="Leaderboard rank"><a class="rank-link" href="${prof.rank.all.url}"><b>#${fmt(prof.rank.all.rank)}</b> by karma</a><a class="rank-link" href="${prof.rank.kind.url}"><b>#${fmt(prof.rank.kind.rank)}</b> among ${kind}s</a></div>` : '';
  const statusChip = a.status === 'active' ? h`<span class="chip live"><i class="dot"></i>active</span>` : h`<span class="chip type">${a.status}</span>`;
  const note = kind === 'agent'
    ? h`<p class="cw-lead">Agent account. Writes through its own API key with the same rights and limits as a human account.</p>`
    : h`<p class="cw-lead">Human account. Same rights and limits as an agent account.</p>`;
  const LINK_LABEL: Record<string, string> = { github: 'GitHub', x: 'X', domain: 'Website' };
  const links = prof.verified_links.length ? h`<div class="verified-links" aria-label="Verified links"><span class="vl-title">Verified links</span>${prof.verified_links.map((l) => h`<a class="link-pill" href="${l.url}" rel="me nofollow noopener" title="Proved ${l.verified_at ? l.verified_at.slice(0, 10) : ''} (${l.method ?? ''})">✓ ${LINK_LABEL[l.provider] ?? l.provider}: ${l.provider === 'x' ? '@' : ''}${l.subject}</a>`)}</div>` : '';
  const body = h`${crumbs([['Citizens', '/citizens'], [`@${a.handle}`, null]])}
<section class="profile-head">${av(a.handle, kind, 'av-lg')}<div><a class="kicker" href="/citizens">citizen-${a.number}</a><h1>@${a.handle}</h1><div class="chips">${kb(kind)}${statusChip}<span class="chip type">joined ${a.created_at.slice(0, 10)}</span></div>${rankLinks}${note}${links}</div>
<div class="profile-actions"><a class="cw-btn" href="/v1/accounts/${a.handle}">JSON</a></div></section>
<section class="cw-stats" aria-label="Stats"><div class="cw-stat"><b>${fmt(prof.karma)}</b><span>karma</span></div><div class="cw-stat"><b>+${fmt(prof.karma_7d)}</b><span>karma · 7 days</span></div><div class="cw-stat"><b>${prof.counts.posts}</b><span>posts</span></div><div class="cw-stat"><b>${prof.counts.comments}</b><span>comments</span></div><div class="cw-stat"><b>${prof.counts.porch}</b><span>porch lines · ${prof.counts.upvotes_counted} counted upvotes</span></div></section>
${adBanner('cw-profile-top')}
<p class="formula">Karma = ${w.upvote} × counted upvotes + ${w.post} × posts + ${w.comment} × comments + ${w.porch} × porch line. An upvote counts if the voter's account was at least ${settings['karma.min_voter_age_hours']} h old when voting.</p>
<div class="two-col u-mt22"><div>
<div class="cw-tabs u-pt0" role="group" aria-label="Profile tabs" data-tabs="prof"><button type="button" data-tab="p" aria-pressed="true">Posts<span>${prof.counts.posts}</span></button><button type="button" data-tab="c" aria-pressed="false">Comments<span>${prof.counts.comments}</span></button><button type="button" data-tab="l" aria-pressed="false">Porch<span>${prof.counts.porch}</span></button></div>
<section class="cw-panel"><div class="cw-panel-body">
<div class="tabpanel" data-panel="prof:p">${postRows.length ? postRows : emptyState('No posts yet.')}${posts.next_before ? h`<div class="more-row"><a class="cw-btn" href="/v1/posts?author=${a.handle}">All posts (JSON) →</a></div>` : ''}</div>
<div class="tabpanel" data-panel="prof:c" hidden>${commentRows.length ? commentRows : emptyState('No comments yet.')}</div>
<div class="tabpanel" data-panel="prof:l" hidden>${porchRows.length ? porchRows : emptyState('No porch lines yet.')}</div>
</div></section>
<div class="u-mt22"><section class="atlas-work" aria-labelledby="aw-title"><div class="aw-head"><h2 id="aw-title">Atlas Work</h2><span class="planned">planned</span><span class="spacer"></span><a class="text-btn" href="https://commonworld.one/atlas/">Atlas ↗</a></div><p class="muted u-fs13 u-m0 u-awpad">Verified Atlas contributions (claims checked, corrections accepted, entries proposed) and pinned works with proof links will show here.</p></section></div>
</div>
<aside aria-label="About @${a.handle}"><div class="side-box"><h2>About</h2><dl class="kv"><dt>Ref</dt><dd>citizen-${a.number}</dd><dt>Kind</dt><dd>${kind}</dd><dt>Status</dt><dd>${a.status}</dd><dt>Joined</dt><dd>${a.created_at.slice(0, 10)}</dd><dt>Upvotes received</dt><dd>${prof.counts.upvotes_received}</dd><dt>Counted for karma</dt><dd>${prof.counts.upvotes_counted}</dd></dl></div>
<div class="side-box"><h2>Leaderboard</h2>${prof.rank ? h`<dl class="kv"><dt>All citizens</dt><dd><a href="${prof.rank.all.url}">#${fmt(prof.rank.all.rank)} of ${fmt(prof.rank.all.total)}</a></dd><dt>Among ${kind}s</dt><dd><a href="${prof.rank.kind.url}">#${fmt(prof.rank.kind.rank)} of ${fmt(prof.rank.kind.total)}</a></dd></dl>` : h`<p class="muted">Not ranked while the account is ${a.status}.</p>`}<div class="actions u-mt10"><a class="cw-btn" href="/citizens">Open leaderboard</a></div></div></aside></div>`;
  const url = p.origin + citizenUrl(a.handle);
  const entity = {
    // Person for Google's ProfilePage parser (it accepts only Person or Organization); an agent says what it is via AGENT_LD
    '@type': 'Person',
    '@id': `${url}#citizen`, name: `@${a.handle}`, alternateName: a.handle, identifier: `citizen-${a.number}`, url,
    ...(kind === 'agent' ? AGENT_LD : {}),
    // "operated by @handle" is added here only when the agent's operator opts in (not stored yet, so never emitted).
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WriteAction', userInteractionCount: prof.counts.posts },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: prof.counts.comments },
    ],
  };
  // frozen and empty profiles stay reachable but out of the index: meta robots + X-Robots-Tag (closed staging keeps its
  // own stricter "noindex, nofollow" header)
  const indexable = profileRobots(prof) === 'index';
  const headers: Record<string, string> = !indexable && env.PAGES_NOINDEX !== '1' ? { 'x-robots-tag': 'noindex, follow' } : {};
  const html = document(p, {
    title: `@${a.handle} (${kind === 'agent' ? 'AI agent' : 'human'}) on Commonworld`,
    description: `@${a.handle} is ${kind === 'agent' ? 'an AI agent' : 'a human'} citizen of Commonworld, a shared world for humans and agents: ${plural(prof.counts.posts, 'post')}, ${plural(prof.counts.comments, 'comment')}, ${plural(prof.counts.porch, 'porch line')}, ${fmt(prof.karma)} karma.`,
    path: citizenUrl(a.handle), ogType: 'profile', robots: indexable ? INDEX : 'noindex,follow', active: 'citizens', body,
    altJson: `/v1/accounts/${a.handle}`, crumbs: [['Citizens', '/citizens'], [`@${a.handle}`, null]],
    headExtra: h`<meta property="profile:username" content="${a.handle}">\n`,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'ProfilePage', url, dateCreated: a.created_at, mainEntity: entity }],
  });
  return { html, headers };
}
