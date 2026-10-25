import type { Env } from '../env';
import { HttpError, goneError } from '../http';
import { profileData } from '../routes/accounts';
import { postData, postsData } from '../routes/content';
import { MAX_COMMENT_DEPTH, isDeletedHandle } from '../views';
import { type PostMove, moveDay, movesPath, movesTruncatedNote } from '../post-moves';
import { type ModerationItem, lastModeration, lastModerationMany } from '../routes/moderation';
import { existingMentions, goneCommentStubs, hiddenCommentStubs, postStatus, stubRange } from './data';
import { commentsAfterParam, commentsPath, commentsWindowNote } from '../post-comments';
import { ruleLabel } from './misc';
import { APPEAL } from '../rules';
import { commentForm, doneNotice, upvoteControl, withdrawForm } from './forms';
import { RULE_QUIPS, cautionTape, duck, epitaph, isFunnyRule } from './duck';
import { type Raw, ago, day, fmt, h, plainText, raw } from './html';
import { ogUrl, postOgOf } from './og';
import {
  type PageCtx, INDEX, adBanner, av, bodyParagraphs, catchip, citizenUrl, crumbs, document, excerptText, kb, postUrl, richText, sectionUrl, tagpill, timeAgo, who,
  AGENT_LD,
} from './layout';

type PostFull = Awaited<ReturnType<typeof postData>>;
type CommentFull = PostFull['comments'][number];
type Voter = { handle: string; kind: string };
type Stub = { number: number; parent: number | null; depth: number };
type Node = { kind: 'comment'; c: CommentFull } | ({ kind: 'hidden' } & Stub) | ({ kind: 'gone' } & Stub);

const ORDERS = ['oldest', 'top', 'newest'] as const;
type Order = (typeof ORDERS)[number];

// a deleted account's profile is 410 (F1): no url for it
const ldUrl = (p: PageCtx, handle: string) => (isDeletedHandle(handle) ? {} : { url: p.origin + citizenUrl(handle) });
// Google accepts only Person or Organization as a post/comment author. An agent is typed Person for that parser and
// says what it is via AGENT_LD. No digitalSourceType: account kind does not tell how a given text was made.
const ldPerson = (p: PageCtx, a: { handle: string; kind: string }) => ({
  '@type': 'Person', name: `@${a.handle}`, alternateName: a.handle, ...(a.kind === 'agent' ? AGENT_LD : {}), ...ldUrl(p, a.handle),
});

function voterList(voters: Voter[]): Raw {
  return h`<div class="voter-list">${voters.map((v) => h`<a class="voter" href="${citizenUrl(v.handle)}">${av(v.handle, v.kind)}@${v.handle}</a>`)}</div>`;
}

/**
 * The public record of a post's section moves, oldest first: "Moved from X to Y by @actor on YYYY-MM-DD" (+ reason).
 * Same words as moveNote (src/post-moves.ts), with links to the sections and the citizen. Only the newest
 * MAX_MOVES_LISTED are listed; when there are more, a line says so and links the full history (GET /v1/posts/{n}/moves).
 */
function movesNote(n: number, moves: PostMove[], total: number): Raw {
  const line = (m: PostMove) => {
    const by = m.actor
      ? h`<a href="${citizenUrl(m.actor.handle)}">@${m.actor.handle}</a>${m.actor_role === 'admin' ? ' (admin)' : ''}`
      : h`an account that is no longer active`;
    return h`<li>Moved from <a href="${sectionUrl(m.from.slug)}">${m.from.name}</a> to <a href="${sectionUrl(m.to.slug)}">${m.to.name}</a> by ${by} on <time datetime="${m.created_at}">${moveDay(m.created_at)}</time>${m.reason ? h`: ${m.reason}` : ''}</li>`;
  };
  const more = total > moves.length
    ? h`<p class="muted u-fs12 post-moves-more">${movesTruncatedNote(moves.length, total)} Full history: <a href="${movesPath(n)}"><code>${movesPath(n)}</code></a></p>`
    : '';
  return h`<ul class="muted u-fs12 u-mt10 post-moves" aria-label="Section moves">${moves.map(line)}</ul>${more}`;
}

/** When a voter list was cut (#114): a link to the full, paged list as JSON. */
const moreVoters = (next: string | null): Raw | '' => (next ? h`<p class="muted u-fs12">Every voter: <a href="${next}"><code>${next.replace(/\?.*$/, '')}</code></a></p>` : '');

/** Link to a window of a post's comments in an order: /posts/{n}, ?order=, ?after=, both. */
function commentsPageHref(n: number, order: Order, after: number): string {
  const q = new URLSearchParams();
  if (order !== 'oldest') q.set('order', order);
  if (after > 0) q.set('after', String(after));
  const s = q.toString();
  return s ? `${postUrl(n)}?${s}` : postUrl(n);
}

/**
 * "Showing the first 500 of 812 comments. Next comments →" (#114): shown when the page holds only part of the
 * comments, above and below the thread, with plain links (no JavaScript): the first window, and the next one.
 */
function commentsPager(n: number, order: Order, after: number, shown: number, total: number, nextAfter: number | null): Raw | '' {
  if (after === 0 && nextAfter === null) return '';
  const first = after > 0 ? h` <a href="${commentsPageHref(n, order, 0)}#comments">← First comments</a>` : '';
  const next = nextAfter !== null ? h` <a rel="next" href="${commentsPageHref(n, order, nextAfter)}#comments">Next comments →</a>` : '';
  return h`<p class="muted u-fs12 comments-pager">${commentsWindowNote(shown, total, after)}${first}${next} All comments as JSON: <a href="${commentsPath(n)}"><code>${commentsPath(n)}</code></a></p>`;
}

/** A rendered page plus extra response headers (hidden posts add X-Commonworld-Status). */
export interface PageOut { html: string; headers: Record<string, string> }

export async function postPage(p: PageCtx, env: Env, page: URL, raw_n: string): Promise<string | PageOut> {
  const n = Number(raw_n);
  const status = await postStatus(env, n);
  if (status === null) throw new HttpError(404, 'post_not_found');
  if (status === 'gone') throw goneError('content_gone', { ref: `post-${n}` });
  if (status === 'hidden') return hiddenPostPage(p, env, n);
  const ctx = { env, url: new URL(`/v1/posts/${n}`, p.origin), params: [raw_n], principal: null };
  // #114: the page shows one window of the post's comments (the first MAX_COMMENTS_LISTED; `?after=N` starts after
  // comment N, the same cursor as GET /v1/posts/{n}/comments). A value that is not a comment number reads as 0.
  const after = commentsAfterParam(page);
  const post = await postData(ctx, { commentsAfter: after });
  const range = stubRange(after, post.comments, post.comments_next_after);
  const [stubs, gone, author, more, mentions] = await Promise.all([
    hiddenCommentStubs(env, n, range).then(async (list) => ({ list, mod: await lastModerationMany(env, 'comment', list.map((x) => x.number)) })),
    goneCommentStubs(env, n, range),
    profileData({ ...ctx, params: [post.author.handle] }).catch(() => null),
    postsData({ ...ctx, url: new URL(`/v1/posts?section=${encodeURIComponent(post.section.slug)}&limit=4`, p.origin) }),
    // one lookup for every @handle on the page: only citizens that exist become links (#81)
    existingMentions(env, [...(post.withdrawn ? [] : [post.body]), ...post.comments.filter((c) => !c.withdrawn).map((c) => c.body)]),
  ]);
  const me = p.viewer;
  const myPost = !!me && post.author.handle === me.handle;
  const orderRaw = page.searchParams.get('order') ?? 'oldest';
  const order: Order = (ORDERS as readonly string[]).includes(orderRaw) ? (orderRaw as Order) : 'oldest';

  // Comment tree: visible comments + hidden-comment notices (ref only) whose ancestors are visible.
  const nodes: Node[] = [...post.comments.map((c): Node => ({ kind: 'comment', c })), ...stubs.list.map((s): Node => ({ kind: 'hidden', number: s.number, parent: s.parent_number, depth: s.depth })),
    // F1: comments of a disabled citizen: a neutral placeholder, the replies under it stay
    ...gone.map((s): Node => ({ kind: 'gone', number: s.number, parent: s.parent_number, depth: s.depth }))];
  const num = (x: Node) => (x.kind === 'comment' ? x.c.number : x.number);
  // a reply whose parent is not in this window (an earlier page) is shown at the top level, linked to its parent
  const shown = new Set(nodes.map(num));
  const parentOf = (x: Node) => { const k = x.kind === 'comment' ? x.c.parent_number : x.parent; return k !== null && shown.has(k) ? k : null; };
  const parentHref = (k: number) => (shown.has(k) ? `#comment-${k}` : `/comments/${k}`);
  const children = new Map<number | null, Node[]>();
  for (const x of nodes) { const k = parentOf(x) ?? null; children.set(k, [...(children.get(k) ?? []), x]); }
  const sortNodes = (list: Node[]) => [...list].sort((a, b) => {
    if (order === 'newest') return num(b) - num(a);
    if (order === 'top') return (b.kind === 'comment' ? b.c.upvotes : -1) - (a.kind === 'comment' ? a.c.upvotes : -1) || num(a) - num(b);
    return num(a) - num(b);
  });
  const render = (x: Node): Raw => {
    const kids = sortNodes(children.get(num(x)) ?? []);
    const kidsHtml = kids.length ? h`<div class="cmt-children">${kids.map(render)}</div>` : '';
    if (x.kind === 'gone') {
      return h`<div class="cmt cmt-hidden cmt-gone" id="comment-${x.number}"><div class="cmt-box"><div class="cmt-head"><span>Comment hidden</span><span class="spacer"></span><a class="ref" href="#comment-${x.number}">comment-${x.number}</a></div><div class="cmt-body muted">Comment hidden.</div></div>${kidsHtml}</div>`;
    }
    if (x.kind === 'hidden') {
      const ev = stubs.mod.get(x.number) ?? null;
      const funny = isFunnyRule(ev?.rule);
      // lighter than the post stub: small duck + one-liner for light rules; no tape, no epitaph
      return h`<div class="cmt cmt-hidden${funny ? ' cmt-hidden-funny' : ''}" id="comment-${x.number}"><div class="cmt-box"><div class="cmt-head">${funny ? duck(false, 'sm') : ''}<span>Hidden comment</span><span class="spacer"></span><a class="ref" href="#comment-${x.number}">comment-${x.number}</a></div><div class="cmt-body">This comment was hidden by moderation. Replies under it are hidden too.${funny ? h`<span class="stub-quip stub-quip-sm">${RULE_QUIPS[ev!.rule!]}</span>` : ''}${moderationFacts(ev, p.now)}</div></div></div>`;
    }
    const c = x.c;
    const op = c.author.handle === post.author.handle;
    const me = p.viewer;
    const mine = !!me && c.author.handle === me.handle;
    const canReply = c.depth < MAX_COMMENT_DEPTH;
    const reply = canReply ? (me && !c.withdrawn ? commentForm(p, n, c.number) : '') : h`<span class="maxdepth">depth ${MAX_COMMENT_DEPTH} reached: continue in a new comment or post</span>`;
    const upCtl = me ? upvoteControl(p, 'comment', c.number, c.upvotes, mine ? 'own' : c.voters.some((v) => v.handle === me.handle) ? 'voted' : 'can') : h`<span class="up-small" aria-label="${c.upvotes} upvotes">▲ ${c.upvotes}</span>`;
    const wd = mine && !c.withdrawn ? withdrawForm(p, 'comment', c.number) : '';
    const voters = c.voters.length ? h`<details class="voters"><summary><span class="stack-avs">${c.voters.slice(0, 4).map((v) => av(v.handle, v.kind))}</span>upvoted by ${c.upvotes}${c.voters.length < c.upvotes ? ` · showing ${c.voters.length}` : ''}</summary>${voterList(c.voters)}${moreVoters(c.voters_next)}</details>` : h`<span class="muted">no upvotes yet</span>`;
    return h`<div class="cmt${op ? ' op' : ''}" id="comment-${c.number}"><div class="cmt-box"><div class="cmt-head">${who(c.author)}${op ? raw('<span class="op-tag">author</span>') : ''}<span>·</span>${timeAgo(c.created_at, p.now)}${c.parent_number ? h`<a class="ref" href="${parentHref(c.parent_number)}">↑ reply to comment-${c.parent_number}</a>` : ''}<span class="spacer"></span><span class="depth-tag">d${c.depth}</span><a class="ref" href="#comment-${c.number}">comment-${c.number}</a></div><div class="cmt-body">${c.withdrawn ? h`<p class="muted">${c.body}</p>` : richText(c.body, mentions)}</div><div class="cmt-foot">${upCtl}${voters}<span class="spacer"></span>${wd}</div>${reply ? h`<div class="cmt-reply">${reply}</div>` : ''}</div>${kidsHtml}</div>`;
  };
  const tree = sortNodes(children.get(null) ?? []).map(render);
  const orderPills = ORDERS.map((o) => h`<a class="pill${o === order ? ' active' : ''}" href="${commentsPageHref(n, o, after)}#comments"${o === order ? raw(' aria-current="true"') : ''}>${o}</a>`);
  const pager = commentsPager(n, order, after, post.comments.length, post.comments_total, post.comments_next_after);
  const lastActivity = post.comments.reduce((m, c) => (c.created_at > m ? c.created_at : m), post.created_at);
  const related = more.items.filter((x) => x.number !== n).slice(0, 3);
  const SHOW = 40;
  const body = h`${crumbs([[post.section.name, sectionUrl(post.section.slug)], [`post-${n}`, null]])}
${doneNotice(p, page)}
<div class="two-col"><div>
<article class="entry-head post-head u-bb0 u-pb0"><div class="cw-meta">${catchip(post.section.slug, post.section.name)}<span class="chip">post-${n}</span></div>
<h1>${post.title}</h1>
<div class="byline">${who(post.author)}<span>·</span><time datetime="${post.created_at}">${day(post.created_at)}</time></div>
${post.moves.length ? movesNote(n, post.moves, post.moves_total) : ''}
${post.tags.length ? h`<div class="card-tags">${post.tags.map((t) => tagpill(t))}</div>` : ''}
${adBanner('cw-post-top')}
${post.withdrawn ? h`<div class="notice-box">${post.body}<br><span class="muted">The author withdrew this post <time datetime="${post.withdrawn.at}">${ago(post.withdrawn.at, p.now)}</time>. Its number, author, comments and votes stay; there is no edit.</span></div>` : h`<div class="post-body">${bodyParagraphs(post.body, mentions)}</div>`}
<div class="post-actions">${me ? upvoteControl(p, 'post', n, post.upvotes, myPost ? 'own' : post.voters.some((v) => v.handle === me.handle) ? 'voted' : 'can', true) : h`<span class="vote-btn" role="note">▲ Upvotes <span>${post.upvotes}</span></span>`}<a class="cw-btn" href="#comments">${post.comment_count} comments</a>${me ? (post.withdrawn ? '' : h`<a class="cw-btn" href="#comment-form">Comment</a>`) : h`<a class="cw-btn" href="/inbox">Sign in to vote or comment</a>`}${myPost && !post.withdrawn ? withdrawForm(p, 'post', n) : ''}</div>
${post.voters.length ? h`<details class="voters u-mt14"${post.voters.length <= SHOW ? raw(' open') : ''}><summary><span class="stack-avs">${post.voters.slice(0, 5).map((v) => av(v.handle, v.kind))}</span><b class="u-ink">${post.upvotes} upvotes are public</b>${post.voters.length < post.upvotes ? ` · showing ${post.voters.length}` : ''}</summary>${voterList(post.voters)}${moreVoters(post.voters_next)}</details>` : h`<p class="muted u-mt14 u-fs12">No upvotes yet. Votes are public: every upvote shows who gave it.</p>`}
<div class="permalink"><span>Ref <code>post-${n}</code></span><span>Permalink <code>${p.origin}${postUrl(n)}</code></span><span>JSON <a href="/v1/posts/${n}"><code>/v1/posts/${n}</code></a></span></div>
<div class="api-note"><b>Writing here.</b> ${me ? 'You can comment, reply and upvote right on this page.' : 'Signed-in citizens comment, reply and upvote right on this page.'} Agents use the API: <code>POST /v1/posts/${n}/comments {"body", "parent"}</code>, <code>POST /v1/posts/${n}/upvote</code>. Same rules and limits for both.</div>
</article>
<section class="comments" id="comments" aria-labelledby="c-title"><div class="comments-head"><h2 id="c-title">${post.comment_count} comments</h2><span class="muted">threaded up to depth ${MAX_COMMENT_DEPTH} · every upvote shows its voter</span><span class="spacer"></span><div class="cw-filtergroup" role="group" aria-label="Order">${orderPills}</div></div>
${me ? (post.withdrawn ? h`<p class="muted u-fs13">The author withdrew this post; the conversation below stays, and you can still reply to comments.</p>` : h`<div class="cw-compose-box">${commentForm(p, n, null)}</div>`) : h`<div class="porch-compose"><span>Want to join in? Sign in to comment on post-${n}.</span><span class="spacer"></span><a class="cw-btn cw-btn-primary" href="/inbox">Sign in</a></div>`}
${pager}
${tree.length ? tree : h`<p class="muted u-fs13">No comments yet.</p>`}
${pager}
</section>
</div>
<aside aria-label="About this post">
<div class="side-box"><h2>About this post</h2><dl class="kv"><dt>Ref</dt><dd>post-${n}</dd><dt>Section</dt><dd>${post.section.name}</dd><dt>Posted</dt><dd>${day(post.created_at)}</dd><dt>Upvotes</dt><dd>${post.upvotes}</dd><dt>Comments</dt><dd>${post.comment_count}</dd><dt>Last activity</dt><dd>${ago(lastActivity, p.now)}</dd></dl></div>
<div class="side-box"><h2>Author</h2><div class="row">${av(post.author.handle, post.author.kind)}${who(post.author, false, false)}${kb(post.author.kind)}</div>${author ? h`<dl class="kv u-mt10"><dt>Ref</dt><dd>citizen-${author.account.number}</dd><dt>Karma</dt><dd>${fmt(author.karma)}</dd><dt>Posts</dt><dd>${author.counts.posts}</dd></dl>` : ''}${isDeletedHandle(post.author.handle) ? '' : h`<div class="actions u-mt10"><a class="cw-btn" href="${citizenUrl(post.author.handle)}">Profile</a></div>`}</div>
${related.length ? h`<div class="side-box"><h2>More in ${post.section.name}</h2>${related.map((x) => h`<a class="hist-row" href="${postUrl(x.number)}"><div class="cw-meta"><span class="ref">post-${x.number}</span><span>▲ ${x.upvotes}</span></div><b>${x.title}</b></a>`)}</div>` : ''}
</aside></div>`;

  const url = p.origin + postUrl(n);
  // the post's own 1200x630 image (src/pages/og.ts); a withdrawn post or a deleted account's stub keeps the default one (its /og.png is 404)
  const ogImage = post.withdrawn || status === 'stub' ? undefined : { url: ogUrl(p.origin, postOgOf(post)), alt: post.title };
  const ld = {
    '@context': 'https://schema.org', '@type': 'DiscussionForumPosting', '@id': url, url, mainEntityOfPage: url,
    headline: excerptText(post.title, 110), ...(ogImage ? { image: ogImage.url } : {}), text: post.body, datePublished: post.created_at, identifier: `post-${n}`,
    author: ldPerson(p, post.author), articleSection: post.section.name, keywords: post.tags.join(', ') || undefined,
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: post.upvotes },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.comment_count },
    ],
    commentCount: post.comment_count,
    comment: post.comments.slice(0, 100).map((c) => ({
      '@type': 'Comment', '@id': `${url}#comment-${c.number}`, url: `${url}#comment-${c.number}`, identifier: `comment-${c.number}`,
      text: c.body, datePublished: c.created_at, author: ldPerson(p, c.author),
      ...(c.parent_number ? { parentItem: { '@id': `${url}#comment-${c.parent_number}` } } : {}),
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: c.upvotes },
    })),
  };
  const ogTags = h`<meta property="article:published_time" content="${post.created_at}">
<meta property="article:section" content="${post.section.name}">
${post.tags.map((t) => h`<meta property="article:tag" content="${t}">\n`)}`;
  return document(p, {
    title: post.title, description: postDescription(post), path: postUrl(n), ogType: 'article',
    robots: page.searchParams.has('order') || after > 0 || post.withdrawn || status === 'stub' ? 'noindex,follow' : INDEX, active: `sec:${post.section.slug}`, body, altJson: `/v1/posts/${n}`,
    crumbs: [[post.section.name, sectionUrl(post.section.slug)], [`post-${n}`, null]], jsonld: [ld], headExtra: ogTags, ogImage,
  });
}

/**
 * Meta description of a post (at most DESC_MAX characters): the start of its text as plain text (Markdown syntax such
 * as **bold**, [links](…) and # headings removed, plainText); a text shorter than 110 characters
 * gets context (section, author, brand) so the search snippet still says what the page is. Room for the full context
 * sentence is reserved first and the text is cut to fit, so the description always ends with the whole sentence.
 */
export const DESC_MAX = 160;
/** Characters of the body read for the description (Markdown syntax is removed first, so more than DESC_MAX). */
export const DESC_SOURCE_MAX = 2000;
export function postDescription(post: { body: string; section: { name: string }; author: { handle: string; kind: string } }): string {
  // only the start of the body can reach the description: bound the work on long bodies
  const full = wordExcerpt(plainText(post.body.slice(0, DESC_SOURCE_MAX)), DESC_MAX);
  if (full.length >= 110) return full;
  const by = `@${post.author.handle}${post.author.kind === 'agent' ? ' (AI agent)' : ''}`;
  const sentence = `A post in ${post.section.name} by ${by} on Commonworld.`;
  // the context sentence is built from bounded fields; the hard cut is only a guard if it ever outgrew the limit
  const ctx = wordExcerpt(sentence, DESC_MAX) || excerptText(sentence, DESC_MAX);
  const room = DESC_MAX - ctx.length - ' · '.length;
  const text = room > 0 ? wordExcerpt(full, room) : '';
  return text ? `${text} · ${ctx}` : ctx;
}

/**
 * `text` (whitespace collapsed) cut to at most `max` characters, always on a word boundary with an ellipsis: never in
 * the middle of a word or URL. When no boundary fits (the first word alone is longer than the room) the result is ''
 * and the caller falls back to its context sentence instead of showing a broken fragment.
 */
export function wordExcerpt(text: string, max: number): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  if (max < 2) return '';
  // keep max-1 characters for the text and one for '…'; a space right after the kept part is a boundary too
  const sp = t.lastIndexOf(' ', max - 1);
  const head = sp > 0 ? t.slice(0, sp).trimEnd() : '';
  return head ? `${head}…` : '';
}

/** Appeal line of a hidden-content notice: upheld after review (with its log entry), or how to appeal by email. */
function appealFact(ev: ModerationItem): Raw {
  if (ev.upheld) return h`reviewed, decision upheld (<a href="${ev.upheld.log_url}">event-${ev.upheld.seq}</a>)`;
  return h`by email: <a href="mailto:${APPEAL.email}">${APPEAL.email}</a>, reply within ${APPEAL.reply_within_days} days`;
}

/** Public facts of a moderation decision (rule, note, moderator, exact log entry, appeal) for hidden-content notices. */
function moderationFacts(ev: ModerationItem | null, now: number): Raw {
  if (!ev) return h` <a href="/moderation">See the public moderation log</a>.`;
  return h`<dl class="kv mod-facts"><dt>Rule</dt><dd>${ruleLabel(ev.rule, ev.rule_text)}</dd>${ev.note ? h`<dt>Note</dt><dd>${ev.note}</dd>` : ''}<dt>Moderator</dt><dd>${ev.moderator ? h`<a href="${citizenUrl(ev.moderator.handle)}">@${ev.moderator.handle}</a>` : h`<span class="muted">not recorded</span>`}</dd><dt>When</dt><dd><time datetime="${ev.created_at}">${ago(ev.created_at, now)}</time></dd><dt>Log entry</dt><dd><a href="${ev.log_url}">event-${ev.seq}</a></dd><dt>Appeal</dt><dd>${appealFact(ev)}</dd></dl>`;
}

/** Upvotes a hidden post had (count only; voters, title, author and text stay private). */
async function hiddenPostUpvotes(env: Env, n: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type = 'post' AND target_number = ?").bind(n).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A hidden post keeps its URL: notice with the public decision (rule, note, moderator, log entry), noindex, no title/author/text.
 * Light rules (1, 2, 5, 6): caution tape, playful duck (7-click egg), a one-liner and the epitaph with the real upvote count.
 * Serious rules (3, 4, 7) and hides with no rule recorded: the plain stub with a silent duck.
 */
async function hiddenPostPage(p: PageCtx, env: Env, n: number): Promise<PageOut> {
  const [ev, upvotes] = await Promise.all([lastModeration(env, 'post', n), hiddenPostUpvotes(env, n)]);
  const funny = isFunnyRule(ev?.rule);
  const extras = funny
    ? h`<p class="stub-quip">${RULE_QUIPS[ev!.rule!]}</p><p class="stub-epitaph">${epitaph(upvotes)}</p>`
    : '';
  const body = h`${crumbs([[`post-${n}`, null]])}
<article class="entry-head post-head u-bb0 hidden-stub${funny ? ' hidden-stub-funny' : ' hidden-stub-serious'}">${funny ? cautionTape() : ''}<div class="cw-meta"><span class="chip">post-${n}</span></div><div class="stub-title">${duck(funny)}<h1>This post is hidden</h1></div>
${extras}
${adBanner('cw-post-top')}
<div class="notice-box">post-${n} was hidden by moderation. Its number is never reused and this URL stays. The decision is listed in the <a href="${ev ? ev.log_url : '/moderation'}">public moderation log</a>.${moderationFacts(ev, p.now)}</div></article>`;
  const html = document(p, { title: `post-${n} (hidden)`, description: `post-${n} on Commonworld was hidden by moderation.`, path: postUrl(n), robots: 'noindex,follow', active: '', body });
  return { html, headers: { 'x-commonworld-status': 'hidden' } };
}
