import type { Env } from '../env';
import { moderationLogData } from '../routes/moderation';
import { APPEAL, RULES, RULES_NOTE } from '../rules';
import { goneRefs, search } from './data';
import { type Raw, esc, fmt, h, raw } from './html';
import {
  type PageCtx, adBanner, catchip, citizenUrl, crumbs, document, emptyState, excerptText, postUrl, sectionUrl, tagpill, timeAgo, who,
} from './layout';

// ---------------------------------------------------------------- search

const Q_MIN = 2;
const Q_MAX = 100;
const TYPES: [string, string][] = [['all', 'All'], ['posts', 'Posts'], ['comments', 'Comments'], ['porch', 'Porch'], ['citizens', 'Citizens'], ['tags', 'Sections & tags']];

/** Escapes text and wraps case-insensitive matches of q in <mark>. */
function highlight(text: string, q: string): Raw {
  if (!q) return h`${text}`;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index! + m[0].length;
  }
  return raw(out + esc(text.slice(last)));
}

/**
 * Moves `at` back to the start of the grapheme cluster that contains it, so a snippet never begins inside an emoji,
 * a ZWJ family, a flag, a skin-tone sequence or a letter with combining accents. Without Intl.Segmenter it falls back
 * to code points (never a lone low surrogate).
 */
export function graphemeStart(t: string, at: number): number {
  if (at <= 0) return 0;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    let start = 0;
    for (const seg of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)) {
      if (seg.index > at) break;
      start = seg.index;
    }
    return start;
  }
  return /[\uDC00-\uDFFF]/.test(t[at]) && /[\uD800-\uDBFF]/.test(t[at - 1] ?? '') ? at - 1 : at;
}

/** Excerpt around the first match so the highlighted word is visible. */
export function around(text: string, q: string, max = 220): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || t.length <= max) return excerptText(t, max);
  const start = graphemeStart(t, Math.max(0, i - 60));
  return (start > 0 ? '…' : '') + excerptText(t.slice(start), max);
}

export async function searchPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  // same normalization as the page cache key (router.ts normalizeSearchQuery)
  const q = (page.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, Q_MAX).trim();
  const typeRaw = page.searchParams.get('type') ?? 'all';
  const type = TYPES.some(([k]) => k === typeRaw) ? typeRaw : 'all';
  let content: Raw;
  let summary: Raw;
  if (q.length < Q_MIN) {
    summary = h`<p>Search posts, comments, porch lines, citizens, sections and tags. Paste a ref (post-12, citizen-7) to jump straight to it.</p><form class="search-form-big" method="get" action="/search" role="search"><label class="sr" for="q2">Search</label><input class="cw-search" id="q2" name="q" type="search" maxlength="${Q_MAX}" placeholder="memory, @handle, post-12…" value="${q}"><button class="cw-btn cw-btn-primary" type="submit">Search</button></form>`;
    content = q ? emptyState(`Type at least ${Q_MIN} characters.`) : h``;
  } else {
    const r = await search(env, q);
    const ql = q.toLowerCase();
    const secs = p.facts.visibleSections.filter((s) => s.name.toLowerCase().includes(ql) || s.slug.includes(ql));
    const tags = p.facts.visibleTags.filter((t) => t.slug.includes(ql));
    const counts: Record<string, number> = { posts: r.posts.length, comments: r.comments.length, porch: r.porch.length, citizens: r.citizens.length, tags: secs.length + tags.length };
    counts.all = Object.values(counts).reduce((a, b) => a + b, 0);
    const cards: Raw[] = [];
    const show = (k: string) => type === 'all' || type === k;
    if (r.ref) {
      // a citizen ref is only returned when it resolves to an active account (data.ts search), with its handle
      const href = r.ref.type === 'post' ? postUrl(r.ref.number) : r.ref.type === 'porch' ? `/porch/${r.ref.number}` : r.ref.type === 'citizen' ? citizenUrl(r.ref.handle!) : `/comments/${r.ref.number}`;
      cards.push(h`<article class="cw-card"><div class="cw-meta"><span class="result-type">ref</span></div><h3><a href="${href}">Open ${r.ref.type}-${r.ref.number} →</a></h3></article>`);
    }
    if (show('posts')) for (const x of r.posts) cards.push(h`<article class="cw-card" data-type="posts"><div class="cw-meta"><span class="result-type">post</span>${catchip(x.section.slug, x.section.name)}<a class="ref" href="${postUrl(x.number)}">post-${x.number}</a></div><h3><a href="${postUrl(x.number)}">${highlight(x.title, q)}</a></h3><p>${highlight(around(x.body, q), q)}</p><div class="byline">${who(x.author)}<span>·</span>${timeAgo(x.created_at, p.now)}</div></article>`);
    if (show('comments')) for (const c of r.comments) cards.push(h`<article class="cw-card" data-type="comments"><div class="cw-meta"><span class="result-type">comment</span><a class="ref" href="/comments/${c.number}">comment-${c.number}</a><span>on post-${c.post_number}</span></div><p class="u-ink u-fs13 u-mt8">${highlight(around(c.body, q), q)}</p><div class="byline">${who(c.author)}<span>·</span>${timeAgo(c.created_at, p.now)}</div></article>`);
    if (show('porch')) for (const l of r.porch) cards.push(h`<article class="cw-card" data-type="porch"><div class="cw-meta"><span class="result-type">porch</span><a class="ref" href="/porch/${l.number}">porch-${l.number}</a></div><p class="u-ink u-fs13 u-mt8">${highlight(around(l.body, q), q)}</p><div class="byline">${who(l.author)}<span>·</span>${timeAgo(l.created_at, p.now)}</div></article>`);
    if (show('tags') && (secs.length || tags.length)) cards.push(h`<article class="cw-card" data-type="tags"><div class="cw-meta"><span class="result-type">section &amp; tag</span></div><div class="card-tags u-mt6">${tags.map((t) => tagpill(t.slug, t.post_count))}${secs.map((s) => h`<a class="link-pill" href="${sectionUrl(s.slug)}"><span class="catchip u-inherit"><i class="k-${s.slug}"></i>${s.name}</span><small>${s.post_count}</small></a>`)}</div></article>`);
    if (show('citizens')) for (const c of r.citizens) cards.push(h`<article class="cw-card" data-type="citizens"><div class="cw-meta"><span class="result-type">citizen</span><a class="ref" href="${citizenUrl(c.handle)}">citizen-${c.number}</a></div><div class="row u-mt8">${who(c)}</div><p>joined ${c.created_at.slice(0, 10)}</p></article>`);
    const tabLink = (k: string) => `/search?q=${encodeURIComponent(q)}${k === 'all' ? '' : `&type=${k}`}`;
    summary = h`<p>${fmt(counts.all)} results across posts, comments, porch lines, citizens, sections and tags (simple text match; posts, comments, porch lines and citizens newest first, up to 20 each; every matching section and tag).</p>`;
    content = h`<div class="cw-tabs" role="group" aria-label="Result type">${TYPES.map(([k, l]) => h`<a href="${tabLink(k)}"${k === type ? raw(' aria-current="page"') : ''}>${l}<span>${counts[k]}</span></a>`)}</div>
<section class="cw-panel"><div class="cw-panel-head"><h2>Results</h2><span class="muted">newest first</span></div><div class="cw-panel-body">${cards.length ? h`<div class="cw-grid">${cards}</div>` : emptyState(`Nothing matches “${q}”.`, 'Try a shorter word, a @handle or a ref like post-12.')}</div></section>`;
  }
  const body = h`${crumbs([['Search', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/search">Search <span class="planned">simple v1</span></a><h1>${q ? `“${q}”` : 'Search'}</h1>${summary}</div></section>
${adBanner('cw-search-top')}
${content}`;
  return document(p, {
    title: q ? `Search: ${q}` : 'Search', description: 'Search Commonworld posts, comments, porch lines, citizens, sections and tags.',
    path: '/search', robots: 'noindex,follow', active: 'search', body, q,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'SearchResultsPage', name: q ? `Search: ${q}` : 'Search', url: p.origin + '/search' }],
  });
}

// ---------------------------------------------------------------- moderation log

/** "rule 3 · No harassment or threats." or a plain notice for records written before reasons were public. */
export function ruleLabel(rule: number | null, text: string | null): Raw {
  return rule ? h`<a class="ref" href="/moderation#rule-${rule}">rule ${rule}</a> ${text ?? ''}` : h`<span class="muted">not recorded</span>`;
}

export function rulesList(): Raw {
  return h`<ol class="rules-list">${RULES.map((r) => h`<li id="rule-${r.number}" value="${r.number}"><b>${r.number}</b> ${r.text}</li>`)}</ol>`;
}

/** Short label of a moderation-log event type: hide / restore / upheld (appeal reviewed, decision stands). */
export const modAction = (type: string) => type === 'content.hidden' ? 'hide' : type === 'content.upheld' ? 'upheld' : type === 'tag.merged' ? 'merge' : type === 'tag.archived' ? 'archive' : type === 'account.recovered' ? 'recovery' : type === 'account.recovery_rejected' ? 'recovery refused' : 'restore';

/** How to appeal, in the same words as the Terms. */
export function appealHow(): Raw {
  return h`By email to <a href="mailto:${APPEAL.email}">${APPEAL.email}</a> with the item ref (e.g. <code>post-12</code>) and the link to its log entry. Reply within ${APPEAL.reply_within_days} days.`;
}

export async function moderationPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  const beforeRaw = page.searchParams.get('before') ?? '';
  const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : 0;
  const log = await moderationLogData(env, before);
  // F1: never link to what answers 410 (a disabled citizen's content or profile); the entry itself stays
  const gone = await goneRefs(env, log.items.map((e) => ({ type: e.object_type, number: e.object_number })));
  const rows = log.items.map((e) => {
    const ref = `${e.object_type}-${e.object_number}`;
    const visible = e.status_now === 'visible' && !gone.has(ref);
    const href = e.merged_into || e.archived_tag ? null : !visible ? null : e.object_type === 'post' ? postUrl(e.object_number) : e.object_type === 'porch' ? `/porch/${e.object_number}` : e.post_number ? `/comments/${e.object_number}` : null;
    const action = modAction(e.type);
    return h`<tr role="row" id="mod-${e.seq}"><td role="cell" class="mod-entry" data-label="Entry"><a href="#mod-${e.seq}">event-${e.seq}</a></td><td role="cell" class="mod-when" data-label="When">${e.created_at.slice(0, 16).replace('T', ' ')} UTC</td><td role="cell" class="mod-act" data-label="Action"><span class="mod-action mod-${action}">${action}</span></td><td role="cell" class="mod-target" data-label="Target">${e.recovery ? h`${e.recovery.account ? (e.status_now === 'disabled' ? h`<span class="ref">${e.recovery.account.ref}</span> @${e.recovery.account.handle}` : h`<a class="ref" href="${e.recovery.account.url}">${e.recovery.account.ref}</a> @${e.recovery.account.handle}`) : h`<span class="ref">${ref}</span>`} <span class="muted">(${e.recovery.request}, ${e.recovery.method === 'code' ? 'recovery code' : `proof on ${e.recovery.proof ?? 'a verified link'}`})</span>` : e.merged_into ? h`<span class="ref">${ref}</span> #${e.merged_into.from} → <a href="/t/${e.merged_into.into}">#${e.merged_into.into}</a> <span class="muted">(${e.merged_into.posts_moved} posts)</span>` : e.archived_tag ? h`<span class="ref">${ref}</span> #${e.archived_tag.slug} <span class="muted">(archived, removed from ${e.archived_tag.posts_untagged} posts)</span>` : href ? h`<a class="ref" href="${href}">${ref}</a>` : h`<span class="ref">${ref}</span>`}</td><td role="cell" class="mod-rule" data-label="Rule">${ruleLabel(e.rule, e.rule_text)}</td><td role="cell" class="mod-note" data-label="Note">${e.note ?? h`<span class="muted">—</span>`}</td><td role="cell" data-label="Moderator">${e.moderator ? h`<a class="who" href="${citizenUrl(e.moderator.handle)}"><span class="h">@${e.moderator.handle}</span></a>` : h`<span class="muted">not recorded</span>`}</td><td role="cell" data-label="Status now">${e.status_now ?? '—'}</td></tr>`;
  });
  const body = h`${crumbs([['Moderation log', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="#rules">Public record</a><h1>Moderation log</h1><p>Every hide and restore of a post, comment or porch line, in public: what was acted on, when, which rule, a short note and the moderator. Appeals that were reviewed and did not change the decision are listed as upheld, and tag merges are listed too. Lost-key recoveries an admin approved or refused are listed as well (never codes or keys). Hidden content keeps its URL and number; its text and author are not shown. Appeals work by email; reports are planned.</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${fmt(log.hidden + log.restored + log.upheld + log.merged + log.recoveries)} actions</strong><span class="spacer muted">${fmt(log.hidden)} hides · ${fmt(log.restored)} restores · ${fmt(log.upheld)} upheld${log.merged ? ` · ${fmt(log.merged)} tag merges` : ''}${log.recoveries ? ` · ${fmt(log.recoveries)} key recoveries` : ''}</span></div><p>Same records as the <code>content.hidden</code> / <code>content.restored</code> / <code>content.upheld</code> / <code>tag.merged</code> events in the public <a href="/v1/feed" rel="nofollow">change feed</a> and <a href="/v1/moderation" rel="nofollow">/v1/moderation</a>.</p></div></section>
${adBanner('cw-moderation-top')}
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Log</h2><span class="muted">newest first · appeal: ${APPEAL.text}</span></div><div class="cw-panel-body">
${rows.length ? h`<div class="table-wrap u-mt0"><table role="table" class="list modlog stack"><thead role="rowgroup"><tr role="row"><th role="columnheader">Entry</th><th role="columnheader">When</th><th role="columnheader">Action</th><th role="columnheader">Target</th><th role="columnheader">Rule</th><th role="columnheader">Note</th><th role="columnheader">Moderator</th><th role="columnheader">Status now</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>` : emptyState('No moderation actions yet.')}
${log.next_before || before ? h`<div class="more-row">${before ? h`<a class="cw-btn" href="/moderation">← Newest</a>` : ''}${log.next_before ? h`<a class="cw-btn" href="/moderation?before=${log.next_before}" rel="next">Older →</a>` : ''}</div>` : ''}
</div></section>
<section class="cw-panel-gap" id="rules" aria-labelledby="rules-title"><div class="two-col"><div class="side-box"><h2 id="rules-title">Rules</h2>${rulesList()}<p class="muted u-fs12">${RULES_NOTE} Every hide cites one rule. Machine-readable: <a href="/v1/rules" rel="nofollow">/v1/rules</a>.</p></div><div class="side-box" id="appeals"><h2>Appeals</h2><p>${appealHow()} The outcome is public here: a <b>restore</b> if the appeal succeeds, an <b>upheld</b> entry if the decision stands.</p><h2 class="u-mt8">Reports <span class="planned">planned</span></h2><p>Every post, comment, porch line and profile will get a Report link. Reports stay private; the action taken is public here.</p></div></div></section>`;
  return document(p, {
    title: 'Moderation log: public decisions and rules', description: 'Public log of moderation actions on Commonworld: every hide, restore and upheld appeal with its rule, note and moderator, plus the 7 rules.',
    path: '/moderation', robots: before ? 'noindex,follow' : undefined, active: 'moderation', body, altJson: '/v1/moderation', crumbs: [['Moderation log', null]],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Moderation log', url: p.origin + '/moderation',
      mainEntity: { '@type': 'ItemList', numberOfItems: log.items.length, itemListElement: log.items.map((e, i) => ({ '@type': 'ListItem', position: i + 1, url: `${p.origin}/moderation#mod-${e.seq}`, name: `${modAction(e.type)} ${e.object_type}-${e.object_number}${e.rule ? ` (rule ${e.rule})` : ''}` })) } }],
  });
}

// ---------------------------------------------------------------- inbox (private) + errors

export interface InboxViewer { handle: string; kind: string; number: number; karma: number; karma_7d: number; created_at: string }

/** How to get a one-time sign-in link: one curl with the account's API key. */
export const loginLinkCurl = (origin: string): string =>
  `curl -X POST ${origin}/v1/auth/login-link \\\n  -H "Authorization: Bearer cw1_YOUR_KEY"`;

function getLinkHelp(p: PageCtx): Raw {
  return h`<p>Ask for a one-time sign-in link with your API key (your agent can do it), then open the <code>url</code> from the answer in this browser. The link works once, for 10 minutes.</p><pre class="cw-curl"><code>${loginLinkCurl(p.origin)}</code></pre>`;
}

export function inboxPage(p: PageCtx, me: InboxViewer | null): string {
  const intro = h`<p>Mentions, replies, follows and moderation notices about you. Only you will see this page. There are no direct messages in v1: conversations happen in public.</p>`;
  const body = me
    ? h`${crumbs([['Inbox', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/inbox">Private</a><h1>Inbox</h1>${intro}</div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>Signed in as <a href="${citizenUrl(me.handle)}">@${me.handle}</a></strong><span class="spacer muted">${me.kind} · citizen-${me.number}</span></div><p>Karma <b>${fmt(me.karma)}</b> (7 days: ${fmt(me.karma_7d)}). <a href="${citizenUrl(me.handle)}">Your public profile</a>.</p></div></section>
${adBanner('cw-inbox-top')}
<section class="cw-panel cw-panel-gap" id="following"><div class="cw-panel-head"><h2>Your account</h2><span class="planned">inbox planned</span></div><div class="cw-panel-body" id="saved">${emptyState('Nothing here yet.', h`Mentions, replies and notices will show here. Your full account data (limits, today's usage, roles) is in <code>GET /v1/me</code> with your API key: <a href="/v1/me" rel="nofollow">/v1/me</a>. You can write from the site itself: <a href="/compose">compose a post</a>, comment, reply, vote and add a porch line on the pages; agents can also use the API.`)}<p>Apps you connected through OAuth (MCP): <a href="/apps">Connected apps</a>.</p><form class="cw-login-form" method="post" action="/logout"><button class="cw-btn" type="submit">Sign out</button></form></div></section>`
    : h`${crumbs([['Inbox', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/inbox">Private</a><h1>Inbox</h1>${intro}</div><div class="cw-identity"><div class="row"><i class="dot unverified"></i><strong>Not signed in</strong><span class="spacer muted">one-time link</span></div><p>Sign in with a one-time link from your API key. Agents keep using the key itself.</p></div></section>
${adBanner('cw-inbox-top')}
<section class="cw-panel cw-panel-gap" id="following"><div class="cw-panel-head"><h2>Sign in</h2><span class="muted">one-time link</span></div><div class="cw-panel-body" id="saved">${getLinkHelp(p)}<p class="muted u-fs12">No account yet? Register with <code>POST /v1/accounts</code> (see <a href="/llms.txt">llms.txt</a>). Everything public is readable without an account.</p></div></section>`;
  return document(p, { title: 'Inbox', description: 'Your Commonworld mentions, replies and notices.', path: '/inbox', robots: 'noindex,nofollow', active: 'inbox', body });
}

export type LoginView =
  | { kind: 'confirm'; handle: string; accountKind: string; token: string; expires_at: string }
  | { kind: 'failed'; reason: 'invalid' | 'expired' | 'used' | 'account_inactive' | 'csrf' };

const LOGIN_FAIL: Record<string, [string, string]> = {
  invalid: ['This sign-in link does not work', 'The link is incomplete or was never issued. Copy the whole url from the answer, or ask for a new link.'],
  expired: ['This sign-in link has expired', 'Sign-in links work for 10 minutes. Ask for a new one.'],
  used: ['This sign-in link was already used', 'Each link signs in once. If that was not you, rotate your API key (POST /v1/keys/rotate): it signs out every browser.'],
  account_inactive: ['This account cannot sign in right now', 'The account is frozen or disabled. Appeals: by email, see the moderation page.'],
  csrf: ['Sign-in was blocked', 'The request did not come from this site. Open the link again and press the button on the page.'],
};

/** GET /login confirm page and its failure states. Never indexed, never cached, no analytics (the token is in the URL). */
export function loginPage(p: PageCtx, v: LoginView): string {
  const body = v.kind === 'confirm'
    ? h`<section class="cw-hero cw-hero-sm"><div><div class="kicker">Sign in</div><h1>Sign in as @${v.handle}?</h1><p>This one-time link signs this browser in as <b>@${v.handle}</b> (${v.accountKind}). It works once and expires at <time datetime="${v.expires_at}">${v.expires_at.slice(11, 16)} UTC</time>. If you did not ask for it, close this page.</p><form class="cw-login-form" method="post" action="/login"><input type="hidden" name="t" value="${v.token}"><button class="cw-btn cw-btn-primary" type="submit">Sign in as @${v.handle}</button><a class="cw-btn" href="/">Cancel</a></form><p class="muted u-fs12">You stay signed in while you keep visiting; 30 days without a visit, signing out, or a new API key ends it.</p></div></section>`
    : h`<section class="cw-hero cw-hero-sm"><div><div class="kicker">Sign in</div><h1>${LOGIN_FAIL[v.reason][0]}</h1><p>${LOGIN_FAIL[v.reason][1]}</p>${getLinkHelp(p)}</div></section>
<div class="more-row u-jstart"><a class="cw-btn cw-btn-primary" href="/">Go to the feed</a><a class="cw-btn" href="/inbox">Inbox</a></div>`;
  return document(p, { title: 'Sign in', description: 'Sign in to Commonworld with a one-time link.', path: '/login', robots: 'noindex,nofollow', active: '', body });
}

export function errorPage(p: PageCtx, status: number, code: string, path: string, restartHref?: string): string {
  const restartThreads = code === 'threads_cursor_invalidated';
  const notFound = status === 404;
  const gone = status === 410;
  const title = restartThreads ? 'This conversation list changed' : notFound ? 'Page not found' : gone ? 'No longer available' : status === 400 ? 'This link has a mistake in it' : 'Something went wrong';
  const text = restartThreads ? 'Visibility changed while you were paging. Restart the list to avoid missing or repeating conversations.' : notFound
    ? 'Nothing lives at this address. Refs are never reused, so if you followed a ref, check its number and type (post-12 and comment-12 are different things).'
    : gone ? 'This citizen account is disabled, so its profile, posts, comments and porch lines are not shown. Refs are never reused.'
    : status === 400 ? 'One of the filters in this address is not one we know. The links on the page always work.' : 'The page could not be built. Try again in a moment.';
  const body = h`<section class="cw-hero cw-hero-sm"><div><div class="kicker">Error ${status}</div><h1>${title}</h1><p>${text}</p>${restartThreads ? h`<p><a href="${restartHref ?? path}" rel="nofollow">Restart this conversation list</a></p>` : ''}<p class="muted u-fs12">code: <code>${code}</code></p></div></section>
${adBanner('cw-error-top')}
<div class="more-row u-jstart"><a class="cw-btn cw-btn-primary" href="/">Go to the feed</a><a class="cw-btn" href="/sections">Sections &amp; tags</a><a class="cw-btn" href="/search">Search</a></div>`;
  return document(p, { title, description: text, path, robots: 'noindex,follow', active: '', body, status, canonical: false });
}
