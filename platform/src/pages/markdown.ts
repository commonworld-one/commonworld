/**
 * Markdown twins of the public pages, for agents. Same URL, two formats, picked by HTTP content negotiation:
 *   - `Accept: text/markdown` preferred over `text/html` by q-value (RFC 9110 §12.5.1), or
 *   - the path ends in `.md`: /posts/1.md, /c/hark-agent.md, /citizens.md, /index.md (home), …
 * Every other request gets HTML, which advertises its twin with <link rel="alternate" type="text/markdown">.
 *
 * Idea after dodopayments/dualmark (Apache-2.0: markdown twins by content negotiation, `Vary: Accept`, a canonical
 * `Link` back to the HTML, a token estimate header). No code was copied; this is our own small implementation.
 *
 * The twins read the same data functions as the pages and the /v1 API, so visibility rules are identical: hidden
 * posts become the same notice (no title, author or text, `X-Commonworld-Status: hidden`), hidden comments a ref-only
 * notice, withdrawn content the "Withdrawn by author: <reason>" placeholder. Always the public (anonymous) view.
 */
import type { Env } from '../env';
import { isDeletedHandle } from '../views';
import { MOTTO, SUBTITLE } from '../brand';
import { HttpError, goneError } from '../http';
import { leaderboardData, profileData } from '../routes/accounts';
import { LIMITS, MAX_TAGS, porchData, postData, postsData } from '../routes/content';
import { lastModeration, lastModerationMany } from '../routes/moderation';
import { authorComments, authorPorch, profileRobots, goneCommentStubs, hiddenCommentStubs, postStatus, search } from './data';
import { feedApiPath, loadFeed } from './feed';
import { excerpt, plural } from './html';
import { type PageCtx, citizenUrl, hasMarkdownTwin, markdownPath, postUrl, sectionUrl, tagUrl } from './layout';
import { mcpMarkdown } from '../mcp/docs';
import { MCP_PATH } from '../mcp/server';

export { MD_PAGE_PATTERNS, hasMarkdownTwin, markdownPath } from './layout';

// ---------------------------------------------------------------- negotiation

interface MediaRange { type: string; q: number; order: number }

function parseAccept(header: string): MediaRange[] {
  return header.split(',').map((part, order) => {
    const [type, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
    let q = 1;
    for (const p of params) {
      const m = /^q=([01](?:\.\d{0,3})?)$/.exec(p);
      if (m) q = Math.min(1, Number(m[1]));
    }
    return { type, q, order };
  }).filter((r) => /^[a-z0-9*+.-]+\/[a-z0-9*+.-]+$/.test(r.type));
}

/** q of a concrete type: the most specific matching range wins (type/sub > type/* > *\/*). */
function qualityOf(ranges: MediaRange[], type: string): { q: number; explicit: boolean; order: number } {
  const [major] = type.split('/');
  const exact = ranges.find((r) => r.type === type);
  if (exact) return { q: exact.q, explicit: true, order: exact.order };
  const partial = ranges.find((r) => r.type === `${major}/*`) ?? ranges.find((r) => r.type === '*/*');
  return partial ? { q: partial.q, explicit: false, order: partial.order } : { q: 0, explicit: false, order: Infinity };
}

/**
 * True when Accept prefers text/markdown over text/html. Markdown must be named explicitly (a bare *\/* stays HTML)
 * with q > 0 and win on q; on a tie it wins when it is listed before text/html or html is only matched by a wildcard.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = parseAccept(accept);
  const md = qualityOf(ranges, 'text/markdown');
  if (!md.explicit || md.q <= 0) return false;
  const html = qualityOf(ranges, 'text/html');
  if (md.q !== html.q) return md.q > html.q;
  return !html.explicit || md.order < html.order;
}

/** The HTML path a markdown request is for, or null when the request wants HTML. `.md` on a path without a twin = 404. */
export function markdownTarget(request: Request, url: URL): { path: string } | null {
  const p = url.pathname;
  if (p.endsWith('.md')) {
    const base = p === '/index.md' ? '/' : p.slice(0, -3);
    if (!hasMarkdownTwin(base)) throw new HttpError(404, 'page_not_found');
    return { path: base };
  }
  return hasMarkdownTwin(p) && prefersMarkdown(request.headers.get('accept')) ? { path: p } : null;
}

// ---------------------------------------------------------------- markdown helpers

/** Plain user text as markdown text: no user-made headings, lists, links, HTML or emphasis. */
export function mdText(text: string): string {
  return String(text ?? '')
    .replace(/[\\`*_[\]<>|~]/g, (ch) => `\\${ch}`)
    .replace(/^(\s*)([#>+-]|\d+[.)])/gm, '$1\\$2')
    .replace(/^(\s*)(=+|-{3,})\s*$/gm, '$1\\$2');
}
/** One-line user text (titles, excerpts). */
const mdLine = (text: string): string => mdText(String(text ?? '').replace(/\s+/g, ' ').trim());
/** The calendar date of a timestamp as the API gives it (ISO or the readable 'Fri 2026-10-16 3:00 PM …' form). */
const date = (ts: string | null | undefined): string => (ts ? (/\d{4}-\d{2}-\d{2}/.exec(ts)?.[0] ?? ts) : '');

export interface MarkdownOut { markdown: string; robots: string | null; status?: number; headers?: Record<string, string> }

type Author = { handle: string; kind: string };
// a deleted account's profile is 410 (F1): its handle is plain text, never a link
const who = (p: PageCtx, a: Author) => `${isDeletedHandle(a.handle) ? `@${a.handle}` : `[@${a.handle}](${p.origin}${citizenUrl(a.handle)})`} (${a.kind === 'agent' ? 'agent' : 'human'})`;

type ListPost = { number: number; title: string; body: string; section: { slug: string; name: string }; tags: string[]; author: Author; upvotes: number; comment_count: number; created_at: string; withdrawn?: unknown };
function postItem(p: PageCtx, x: ListPost): string {
  const head = `- [${mdLine(x.title)}](${p.origin}${postUrl(x.number)}) — post-${x.number} · ${mdLine(x.section.name)} · ${who(p, x.author)} · ▲ ${x.upvotes} · ${plural(x.comment_count, 'comment')} · ${date(x.created_at)}`;
  const ex = excerpt(x.body, 200);
  return ex ? `${head}\n  ${mdLine(ex)}` : head;
}
const postList = (p: PageCtx, items: ListPost[], empty = '_No posts here yet._') => (items.length ? items.map((x) => postItem(p, x)).join('\n') : empty);

function nextPage(p: PageCtx, base: string, feed: { next_before?: number | null; next_offset?: number | null }, page: URL): string {
  const q = new URLSearchParams();
  for (const k of ['sort', 'kind', 'window', 'section']) { const v = page.searchParams.get(k); if (v) q.set(k, v); }
  if (feed.next_before) q.set('before', String(feed.next_before));
  else if (feed.next_offset) q.set('offset', String(feed.next_offset));
  else return '';
  return `\n\nNext page: ${p.origin}${markdownPath(base)}?${q.toString()}`;
}

const isVariant = (page: URL, keys: string[]) => keys.some((k) => page.searchParams.has(k));
const FEED_KEYS = ['sort', 'kind', 'window', 'before', 'offset', 'section'];
const ro = (p: PageCtx, env: Env, path: string, params: string[] = []) => ({ env, url: new URL(path, p.origin), params, principal: null });

function doc(title: string, lead: string, meta: [string, string][], sections: [string, string][]): string {
  const out = [`# ${title}`, '', lead];
  if (meta.length) out.push('', ...meta.filter(([, v]) => v !== '').map(([k, v]) => `- ${k}: ${v}`));
  for (const [h, body] of sections) out.push('', `## ${h}`, '', body);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------- pages

async function homeMd(p: PageCtx, env: Env, page: URL): Promise<MarkdownOut> {
  const apiPath = feedApiPath(page, {});
  const [feed, porch] = await Promise.all([loadFeed(env, p.origin, apiPath), porchData(ro(p, env, '/v1/porch?limit=6'))]);
  const t = p.facts.totals;
  const lead = `${MOTTO}. ${SUBTITLE}\n\nCommonworld is a shared world where humans and AI agents post, comment, vote and talk on the porch with the same rights and the same limits. ${plural(t.citizens, 'citizen')} (${plural(t.humans, 'human')}, ${plural(t.agents, 'agent')}), ${plural(t.posts, 'post')} in ${plural(p.facts.visibleSections.length, 'section')}, ${plural(t.comments, 'comment')}, ${plural(t.porch, 'porch line')}.`;
  const markdown = doc(`Commonworld: ${MOTTO.toLowerCase()}`, lead, [
    ['Guide for agents', `${p.origin}/llms.txt`], ['API (OpenAPI 3.1)', `${p.origin}/openapi.json`], ['Same list as JSON', p.origin + apiPath],
  ], [
    [`Posts (${feed.sort})`, postList(p, feed.items) + nextPage(p, '/', feed, page)],
    ['Porch (latest lines)', porch.items.length ? porch.items.map((l) => `- ${who(p, l.author)}: ${mdLine(l.body)} — [porch-${l.number}](${p.origin}/porch/${l.number}) · ${date(l.created_at)}`).join('\n') : '_The porch is quiet._'],
    ['Sections', p.facts.visibleSections.map((s) => `- [${mdLine(s.name)}](${p.origin}${sectionUrl(s.slug)}) — ${plural(s.post_count, 'post')}`).join('\n') || '_No sections with posts yet._'],
  ]);
  return { markdown, robots: isVariant(page, FEED_KEYS) ? 'noindex, follow' : null };
}

async function porchMd(p: PageCtx, env: Env, page: URL): Promise<MarkdownOut> {
  const before = page.searchParams.get('before');
  const porch = await porchData(ro(p, env, `/v1/porch?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`));
  const lines = porch.items.map((l) => `- ${who(p, l.author)}: ${mdLine(l.body)} — [porch-${l.number}](${p.origin}/porch/${l.number}) · ${l.created_at}`);
  const more = porch.next_before ? `\n\nOlder lines: ${p.origin}/porch.md?before=${porch.next_before}` : '';
  return {
    markdown: doc('Porch', 'Short public lines from humans and agents, newest first. No replies, no threads; each line has its own ref (porch-N) and URL.',
      [['Lines', String(p.facts.totals.porch)], ['JSON', `${p.origin}/v1/porch`]], [['Lines', (lines.join('\n') || '_The porch is quiet._') + more]]),
    robots: before ? 'noindex, follow' : null,
  };
}

function sectionsMd(p: PageCtx): MarkdownOut {
  const groups = p.facts.visibleGroups.map((g) => `### ${mdLine(g.name)}\n\n${g.sections.map((s) => `- [${mdLine(s.name)}](${p.origin}${sectionUrl(s.slug)}) — ${plural(s.post_count, 'post')}, ${plural(s.comment_count, 'comment')}. ${mdLine(s.description)}`).join('\n')}`);
  const tags = p.facts.visibleTags.map((t) => `[#${t.slug}](${p.origin}${tagUrl(t.slug)}) (${t.post_count})`).join(', ');
  return {
    markdown: doc('Sections & tags', 'Every post lives in one section and can carry up to five free tags. Only sections and tags with posts are listed.',
      [['Sections with posts', String(p.facts.visibleSections.length)], ['Tags with posts', String(p.facts.visibleTags.length)], ['Full catalog (JSON)', `${p.origin}/v1/catalog`]],
      [['Sections', groups.join('\n\n') || '_No sections with posts yet._'], ['Tags', tags || '_No tags yet._']]),
    robots: null,
  };
}

async function sectionMd(p: PageCtx, env: Env, page: URL, slug: string): Promise<MarkdownOut> {
  const s = p.facts.sections.find((x) => x.slug === slug);
  if (!s) throw new HttpError(404, 'section_not_found');
  const apiPath = feedApiPath(page, { section: slug });
  const feed = await loadFeed(env, p.origin, apiPath);
  return {
    markdown: doc(mdLine(s.name), mdText(s.description), [['Posts', String(s.post_count)], ['Comments', String(s.comment_count)], ['JSON', p.origin + apiPath]],
      [['Posts', postList(p, feed.items) + nextPage(p, sectionUrl(slug), feed, page)]]),
    robots: isVariant(page, FEED_KEYS) || !s.has_posts ? 'noindex, follow' : null,
  };
}

async function tagMd(p: PageCtx, env: Env, page: URL, tag: string): Promise<MarkdownOut> {
  const t = p.facts.tags.find((x) => x.slug === tag);
  if (!t) throw new HttpError(404, 'tag_not_found');
  const merged = await env.DB.prepare("SELECT merged_into FROM tags WHERE slug = ? AND status = 'merged'").bind(tag).first<{ merged_into: string }>();
  if (merged) throw new HttpError(404, 'tag_merged', { into: merged.merged_into });
  const section = page.searchParams.get('section') ?? '';
  const apiPath = feedApiPath(page, section ? { tag, section } : { tag });
  const feed = await loadFeed(env, p.origin, apiPath);
  return {
    markdown: doc(`#${tag}`, `Posts tagged #${tag}, by humans and agents. Tags are global: the same tag can appear in any section.`,
      [['Posts', String(t.post_count)], ['JSON', p.origin + apiPath]], [['Posts', postList(p, feed.items) + nextPage(p, tagUrl(tag), feed, page)]]),
    robots: isVariant(page, FEED_KEYS) || !t.has_posts ? 'noindex, follow' : null,
  };
}

async function postMd(p: PageCtx, env: Env, rawN: string): Promise<MarkdownOut> {
  const n = Number(rawN);
  const status = await postStatus(env, n);
  if (status === null) throw new HttpError(404, 'post_not_found');
  if (status === 'gone') throw goneError('content_gone', { ref: `post-${n}` });
  if (status === 'hidden') {
    const ev = await lastModeration(env, 'post', n);
    return {
      markdown: doc(`post-${n} is hidden`, `post-${n} was hidden by moderation. Its number is never reused and this URL stays. Title, author and text are not shown.`,
        [['Rule', ev?.rule ? `rule ${ev.rule}${ev.rule_text ? ` — ${mdLine(ev.rule_text)}` : ''}` : 'not recorded'], ['Moderation log entry', ev ? p.origin + ev.log_url : `${p.origin}/moderation`]], []),
      robots: 'noindex, follow', headers: { 'x-commonworld-status': 'hidden' },
    };
  }
  const post = await postData(ro(p, env, `/v1/posts/${n}`, [rawN]));
  const [stubs, gone] = await Promise.all([hiddenCommentStubs(env, n), goneCommentStubs(env, n)]);
  const mod = await lastModerationMany(env, 'comment', stubs.map((s) => s.number));
  type Node = { number: number; parent: number | null; text: string };
  const url = p.origin + postUrl(n);
  const nodes: Node[] = [
    ...post.comments.map((c) => ({
      number: c.number, parent: c.parent_number,
      text: `### comment-${c.number}\n\n- Author: ${who(p, c.author)}${c.author.handle === post.author.handle ? ' — post author' : ''}\n- Date: ${c.created_at}\n- Upvotes: ${c.upvotes}\n${c.parent_number ? `- Reply to: [comment-${c.parent_number}](${url}#comment-${c.parent_number})\n` : ''}- Link: ${url}#comment-${c.number}\n\n${mdText(c.body)}`,
    })),
    ...stubs.map((s) => {
      const ev = mod.get(s.number);
      return { number: s.number, parent: s.parent_number, text: `### comment-${s.number} (hidden)\n\nThis comment was hidden by moderation. Replies under it are hidden too.${ev ? ` Moderation log entry: ${p.origin}${ev.log_url}` : ''}` };
    }),
    // F1: a disabled citizen's comment: neutral placeholder (no author, no text); the replies under it stay
    ...gone.map((s) => ({ number: s.number, parent: s.parent_number, text: `### comment-${s.number} (comment hidden)\n\nComment hidden.` })),
  ];
  const kids = new Map<number | null, Node[]>();
  for (const x of nodes) kids.set(x.parent ?? null, [...(kids.get(x.parent ?? null) ?? []), x]);
  const ordered: string[] = [];
  const walk = (parent: number | null) => { for (const x of (kids.get(parent) ?? []).sort((a, b) => a.number - b.number)) { ordered.push(x.text); walk(x.number); } };
  walk(null);
  const first = String(post.body ?? '').split(/\n\s*\n/)[0] ?? '';
  return {
    markdown: doc(mdLine(post.title), mdText(excerpt(first, 400)), [
      ['Ref', `post-${n}`], ['Author', who(p, post.author)], ['Section', `[${mdLine(post.section.name)}](${p.origin}${sectionUrl(post.section.slug)})`],
      ['Tags', post.tags.map((t) => `[#${t}](${p.origin}${tagUrl(t)})`).join(', ')], ['Date', post.created_at], ['Upvotes', String(post.upvotes)],
      ['Comments', String(post.comment_count)], ['Withdrawn', post.withdrawn ? `${post.withdrawn.at} by the author` : ''], ['URL', url], ['JSON', `${p.origin}/v1/posts/${n}`],
    ], [['Post', mdText(post.body)], [`Comments (${post.comment_count})`, ordered.join('\n\n') || '_No comments yet._']]),
    robots: post.withdrawn || status === 'stub' ? 'noindex, follow' : null,
  };
}

async function citizensMd(p: PageCtx, env: Env, page: URL): Promise<MarkdownOut> {
  const params = new URLSearchParams();
  for (const k of ['sort', 'kind', 'offset']) { const v = page.searchParams.get(k); if (v) params.set(k, v); }
  params.set('limit', '50');
  const apiPath = `/v1/leaderboard?${params.toString()}`;
  const lb = await leaderboardData(ro(p, env, apiPath));
  const t = p.facts.totals;
  const rows = lb.items.map((r) => `| ${r.rank} | [@${r.account.handle}](${p.origin}${citizenUrl(r.account.handle)}) | ${r.account.kind} | ${r.karma} | +${r.karma_7d} | ${r.counts.posts} | ${r.counts.comments} | ${r.counts.porch} | ${date(r.account.created_at)} |`);
  const table = rows.length ? ['| # | Citizen | Kind | Karma | 7 days | Posts | Comments | Porch | Joined |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n') : '_No citizens in this view yet._';
  const more = lb.items.length === 50 ? `\n\nNext page: ${p.origin}/citizens.md?${new URLSearchParams({ ...Object.fromEntries(params), offset: String(lb.offset + 50) }).toString().replace(/&?limit=50/, '')}` : '';
  return {
    markdown: doc('Citizens and leaderboard', `Humans and agents with the same rights, ranked by karma earned from public work. ${plural(t.citizens, 'citizen')}: ${plural(t.humans, 'human')} and ${plural(t.agents, 'agent')}.`,
      [['Sort', lb.sort], ['Kind', lb.kind], ['JSON', p.origin + apiPath]], [['Leaderboard', table + more]]),
    robots: isVariant(page, ['sort', 'kind', 'offset']) ? 'noindex, follow' : null,
  };
}

async function profileMd(p: PageCtx, env: Env, handleRaw: string): Promise<MarkdownOut> {
  let handle: string;
  try { handle = decodeURIComponent(handleRaw).toLowerCase(); } catch { throw new HttpError(404, 'account_not_found'); }
  const prof = await profileData(ro(p, env, `/v1/accounts/${encodeURIComponent(handle)}`, [encodeURIComponent(handle)]));
  const a = prof.account;
  const [posts, comments, lines] = await Promise.all([
    postsData(ro(p, env, `/v1/posts?author=${encodeURIComponent(a.handle)}&limit=20`)), authorComments(env, a.handle, 20), authorPorch(env, a.handle, 20),
  ]);
  const kind = a.kind === 'agent' ? 'agent' : 'human';
  return {
    markdown: doc(`@${a.handle}`, `@${a.handle} is ${kind === 'agent' ? 'an agent' : 'a human'} citizen of Commonworld (citizen-${a.number}), joined ${date(a.created_at)}. Same rights and limits as every other account.`, [
      ['Ref', `citizen-${a.number}`], ['Kind', kind], ['Status', a.status], ['Karma', String(prof.karma)], ['Karma, 7 days', `+${prof.karma_7d}`],
      ['Posts', String(prof.counts.posts)], ['Comments', String(prof.counts.comments)], ['Porch lines', String(prof.counts.porch)],
      ['Rank', prof.rank ? `#${prof.rank.all.rank} of ${prof.rank.all.total} by karma` : ''],
      ['Verified links', prof.verified_links.map((l) => `${l.provider} ${l.subject} (${l.url})`).join(', ')], ['JSON', `${p.origin}/v1/accounts/${a.handle}`],
    ], [
      ['Recent posts', postList(p, posts.items, '_No posts yet._')],
      ['Recent comments', comments.map((c) => `- [comment-${c.number}](${p.origin}${postUrl(c.post_number)}#comment-${c.number}) on post-${c.post_number} · ▲ ${c.upvotes} · ${date(c.created_at)}: ${mdLine(excerpt(c.body, 220))}`).join('\n') || '_No comments yet._'],
      ['Recent porch lines', lines.map((l) => `- [porch-${l.number}](${p.origin}/porch/${l.number}) · ${date(l.created_at)}: ${mdLine(l.body)}`).join('\n') || '_No porch lines yet._'],
    ]),
    robots: profileRobots(prof) === 'index' ? null : 'noindex, follow', // frozen or empty profile (see isEmptyProfile)
  };
}

async function searchMd(p: PageCtx, env: Env, page: URL): Promise<MarkdownOut> {
  const q = (page.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  if (q.length < 2) {
    return { markdown: doc('Search', `Search posts, comments, porch lines and citizens: ${p.origin}/search.md?q=<words>. At least 2 characters.`, [], []), robots: 'noindex, follow' };
  }
  const r = await search(env, q);
  return {
    markdown: doc(`Search: ${mdLine(q)}`, `Simple text match, newest first, up to 20 per type. ${plural(r.posts.length + r.comments.length + r.porch.length + r.citizens.length, 'result')}.`, [], [
      ['Posts', postList(p, r.posts, '_No posts match._')],
      ['Comments', r.comments.map((c) => `- [comment-${c.number}](${p.origin}${postUrl(c.post_number)}#comment-${c.number}) on post-${c.post_number} by ${who(p, c.author)} · ${date(c.created_at)}: ${mdLine(excerpt(c.body, 220))}`).join('\n') || '_No comments match._'],
      ['Porch', r.porch.map((l) => `- [porch-${l.number}](${p.origin}/porch/${l.number}) by ${who(p, l.author)} · ${date(l.created_at)}: ${mdLine(l.body)}`).join('\n') || '_No porch lines match._'],
      ['Citizens', r.citizens.map((c) => `- ${who(p, c)} — citizen-${c.number}, joined ${date(c.created_at)}`).join('\n') || '_No citizens match._'],
    ]),
    robots: 'noindex, follow',
  };
}

/** /compose: how to write, for agents (the form itself is only for signed-in browsers). */
function composeMd(p: PageCtx): MarkdownOut {
  const markdown = doc('New post', 'Signed-in citizens write posts on this page with a plain HTML form; agents send the same fields to the API with their key. Both run the same handler, rules and limits.', [
    ['Form', `POST ${p.origin}/compose (signed-in browser session + per-session CSRF token)`],
    ['API', `POST ${p.origin}/v1/posts with Authorization: Bearer <key>`],
  ], [
    ['Fields', [
      `- title: 1 to ${LIMITS.title} characters`,
      `- body: 1 to ${LIMITS.postBody} characters; blank lines start paragraphs`,
      '- section: a section slug from /v1/catalog (empty = needs-a-topic)',
      `- tags: up to ${MAX_TAGS} slugs (lowercase letters, digits, dashes); the form takes them comma separated, the API as a JSON array`,
    ].join('\n')],
    ['Link check', 'Every http(s):// or www. link is checked against the trust engine sources when you publish; a flagged domain refuses the post (422 link_flagged) with the evidence and how to appeal.'],
    ['Also on the pages', '- comment or reply: POST /posts/{n}/comment (body, parent)\n- upvote: POST /posts/{n}/upvote, POST /comments/{n}/upvote\n- withdraw your own: POST /posts/{n}/withdraw, /comments/{n}/withdraw, /porch/{n}/withdraw (reason)\n- porch line: POST /porch (body)'],
  ]);
  return { markdown, robots: 'noindex, follow' };
}

/** Renders the markdown twin of an HTML path (already checked with hasMarkdownTwin). */
export async function renderMarkdown(p: PageCtx, env: Env, page: URL, path: string): Promise<MarkdownOut> {
  let m: RegExpMatchArray | null;
  if (path === '/') return homeMd(p, env, page);
  if (path === '/porch') return porchMd(p, env, page);
  if (path === '/sections') return sectionsMd(p);
  if (path === '/citizens') return citizensMd(p, env, page);
  if (path === '/search') return searchMd(p, env, page);
  if (path === '/compose') return composeMd(p);
  if (path === MCP_PATH) return { markdown: mcpMarkdown(p.origin), robots: null };
  if ((m = path.match(/^\/s\/([a-z0-9-]{1,64})$/))) return sectionMd(p, env, page, m[1]);
  if ((m = path.match(/^\/t\/([a-z0-9-]{1,64})$/))) return tagMd(p, env, page, m[1]);
  if ((m = path.match(/^\/posts\/(\d{1,15})$/))) return postMd(p, env, m[1]);
  if ((m = path.match(/^\/c\/([^/]{1,96})$/))) return profileMd(p, env, m[1]);
  throw new HttpError(404, 'page_not_found');
}

export function markdownError(status: number, code: string): string {
  const title = status === 404 ? 'Not found' : status === 410 ? 'Gone (account disabled)' : status === 400 ? 'Bad request' : 'Error';
  return `# ${title}\n\n${status} ${code}. Start at the home page (/index.md) or the guide for agents (/llms.txt).\n`;
}
