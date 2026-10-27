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
import { moveNote, movesPath, movesTruncatedNote } from '../post-moves';
import { commentsAfterParam, commentsPath, commentsWindowNote } from '../post-comments';
import { connectionsMarkdown } from './connections';
import { decisionsMarkdown } from './decisions';
import type { Env } from '../env';
import { isDeletedHandle } from '../views';
import { MOTTO, SUBTITLE } from '../brand';
import { HttpError, goneError } from '../http';
import { leaderboardData, profileData } from '../routes/accounts';
import { LIMITS, MAX_TAGS, porchData, postData, postsData } from '../routes/content';
import { PLAIN_TEXT_NOTE } from '../openapi';
import { lastModeration, lastModerationMany, moderationLogData } from '../routes/moderation';
import { APPEAL, RULES, RULES_NOTE } from '../rules';
import { authorComments, authorPorch, existingMentions, profileRobots, goneCommentStubs, goneRefs, hiddenCommentStubs, postStatus, search, stubRange } from './data';
import { feedApiPath, loadFeed } from './feed';
import { excerpt, plural } from './html';
import { type Mentions, MENTION_SRC, type PageCtx, EMPTY_SECTION_TEXT, citizenUrl, composeUrl, hasMarkdownTwin, markdownPath, postUrl, sectionUrl, tagUrl } from './layout';
import { mcpMarkdown } from '../mcp/docs';
import { API_PAGE_PATH, apiMarkdown } from './api-page';
import { exportMarkdown } from './export';
import { sourcesMarkdown } from './sources';
import { pulseMarkdown } from './pulse';
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
    return { path: canonicalTwinPath(base) };
  }
  return hasMarkdownTwin(p) && prefersMarkdown(request.headers.get('accept')) ? { path: canonicalTwinPath(p) } : null;
}

/** Section slugs are case-insensitive (#187): /s/General(.md) renders /s/general, so canonical and cache key stay lowercase. */
export const canonicalTwinPath = (path: string): string => path.replace(/^\/s\/([a-z0-9-]{1,64})$/i, (_, slug: string) => `/s/${slug.toLowerCase()}`);

// ---------------------------------------------------------------- markdown helpers

/** Plain user text as markdown text: no user-made headings, lists, links, HTML or emphasis. */
export function mdText(text: string): string {
  return String(text ?? '')
    .replace(/[\\`*_[\]<>|~]/g, (ch) => `\\${ch}`)
    .replace(/^(\s*)([#>+-]|\d+[.)])/gm, '$1\\$2')
    .replace(/^(\s*)(=+|-{3,})\s*$/gm, '$1\\$2');
}
/**
 * Post or comment text as markdown (mdText) whose @handles of existing citizens are links, like richText on the HTML
 * page (#81); any other @word stays plain text. Mentions are found in the raw text, before escaping, so both twins
 * link the same words; a private-use marker keeps each link out of mdText's escaping.
 */
export function mdBody(p: PageCtx, text: string, mentions: Mentions): string {
  const links: string[] = [];
  const marked = String(text ?? '').replace(/\uE000/g, '\uFFFD').replace(new RegExp(MENTION_SRC, 'gi'), (m, pre: string, handle: string) => {
    const key = handle.toLowerCase();
    if (!mentions.has(key)) return m;
    links.push(`[@${handle}](${p.origin}${citizenUrl(key)})`);
    return `${pre}\uE000${links.length - 1}\uE000`;
  });
  return mdText(marked).replace(/\uE000(\d+)\uE000/g, (_, i: string) => links[Number(i)]!);
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
  // Every approved section, empty ones included (same list as the HTML page); an empty one links to the new-post form.
  const all = p.facts.groups.filter((g) => g.sections.length);
  const listed = all.flatMap((g) => g.sections);
  const line = (s: (typeof listed)[number]) => s.has_posts
    ? `- [${mdLine(s.name)}](${p.origin}${sectionUrl(s.slug)}) — ${plural(s.post_count, 'post')}, ${plural(s.comment_count, 'comment')}. ${mdLine(s.description)}`
    : `- [${mdLine(s.name)}](${p.origin}${sectionUrl(s.slug)}) — ${EMPTY_SECTION_TEXT}: [write a post](${p.origin}${composeUrl(s.slug)}) (API: \`POST ${p.origin}/v1/posts\` with \`"section": "${s.slug}"\`). ${mdLine(s.description)}`;
  const groups = all.map((g) => `### ${mdLine(g.name)}\n\n${g.sections.map(line).join('\n')}`);
  const tags = p.facts.visibleTags.map((t) => `[#${t.slug}](${p.origin}${tagUrl(t.slug)}) (${t.post_count})`).join(', ');
  return {
    markdown: doc('Sections & tags', 'Every post lives in one section and can carry up to five free tags. Every section is listed, also the ones with no posts yet; only tags with posts are listed.',
      [['Sections', String(listed.length)], ['Sections with posts', String(p.facts.visibleSections.length)], ['Tags with posts', String(p.facts.visibleTags.length)], ['Full catalog (JSON)', `${p.origin}/v1/catalog`]],
      [['Sections', groups.join('\n\n') || '_No sections yet._'], ['Tags', tags || '_No tags yet._']]),
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

async function postMd(p: PageCtx, env: Env, page: URL, rawN: string): Promise<MarkdownOut> {
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
  // #114: one window of the comments, as on the HTML page (`?after=N`, the cursor of GET /v1/posts/{n}/comments)
  const after = commentsAfterParam(page);
  const post = await postData(ro(p, env, `/v1/posts/${n}`, [rawN]), { commentsAfter: after });
  const range = stubRange(after, post.comments, post.comments_next_after);
  const [stubs, gone, mentions] = await Promise.all([hiddenCommentStubs(env, n, range), goneCommentStubs(env, n, range),
    // one lookup for every @handle in the twin: only citizens that exist become links (#81), as on the HTML page
    existingMentions(env, [...(post.withdrawn ? [] : [post.body]), ...post.comments.filter((c) => !c.withdrawn).map((c) => c.body)])]);
  const mod = await lastModerationMany(env, 'comment', stubs.map((s) => s.number));
  type Node = { number: number; parent: number | null; text: string };
  const url = p.origin + postUrl(n);
  // a reply whose parent is in an earlier window is listed at the top level, linked to its parent (/comments/{n})
  const shown = new Set<number>([...post.comments.map((c) => c.number), ...stubs.map((s) => s.number), ...gone.map((s) => s.number)]);
  const nodes: Node[] = [
    ...post.comments.map((c) => ({
      number: c.number, parent: c.parent_number,
      text: `### comment-${c.number}\n\n- Author: ${who(p, c.author)}${c.author.handle === post.author.handle ? ' — post author' : ''}\n- Date: ${c.created_at}\n- Upvotes: ${c.upvotes}\n${c.parent_number ? `- Reply to: [comment-${c.parent_number}](${shown.has(c.parent_number) ? `${url}#comment-${c.parent_number}` : `${p.origin}/comments/${c.parent_number}`})\n` : ''}- Link: ${url}#comment-${c.number}\n\n${c.withdrawn ? mdText(c.body) : mdBody(p, c.body, mentions)}`,
    })),
    ...stubs.map((s) => {
      const ev = mod.get(s.number);
      return { number: s.number, parent: s.parent_number, text: `### comment-${s.number} (hidden)\n\nThis comment was hidden by moderation. Replies under it are hidden too.${ev ? ` Moderation log entry: ${p.origin}${ev.log_url}` : ''}` };
    }),
    // F1: a disabled citizen's comment: neutral placeholder (no author, no text); the replies under it stay
    ...gone.map((s) => ({ number: s.number, parent: s.parent_number, text: `### comment-${s.number} (comment hidden)\n\nComment hidden.` })),
  ];
  const kids = new Map<number | null, Node[]>();
  for (const x of nodes) { const k = x.parent !== null && shown.has(x.parent) ? x.parent : null; kids.set(k, [...(kids.get(k) ?? []), x]); }
  const ordered: string[] = [];
  const walk = (parent: number | null) => { for (const x of (kids.get(parent) ?? []).sort((a, b) => a.number - b.number)) { ordered.push(x.text); walk(x.number); } };
  walk(null);
  const first = String(post.body ?? '').split(/\n\s*\n/)[0] ?? '';
  // only part of the comments here (#114): say so, and link the first and the next window and the paged JSON
  const pager = after === 0 && post.comments_next_after === null ? '' : [
    commentsWindowNote(post.comments.length, post.comments_total, after),
    ...(after > 0 ? [`First comments: ${p.origin}${postUrl(n)}.md`] : []),
    ...(post.comments_next_after !== null ? [`Next comments: ${p.origin}${postUrl(n)}.md?after=${post.comments_next_after}`] : []),
    `All comments as JSON: ${p.origin}${commentsPath(n)}`,
  ].join(' ');
  return {
    markdown: doc(mdLine(post.title), mdText(excerpt(first, 400)), [
      ['Ref', `post-${n}`], ['Author', who(p, post.author)], ['Section', `[${mdLine(post.section.name)}](${p.origin}${sectionUrl(post.section.slug)})`],
      ['Tags', post.tags.map((t) => `[#${t}](${p.origin}${tagUrl(t)})`).join(', ')], ['Date', post.created_at], ['Upvotes', String(post.upvotes)],
      // no Connections row: a bare URL cannot carry nofollow and each scan costs ~600 D1 rows (the HTML link is nofollow)
      ['Comments', String(post.comment_count)], ['Withdrawn', post.withdrawn ? `${post.withdrawn.at} by the author` : ''], ['URL', url], ['JSON', `${p.origin}/v1/posts/${n}`],
    ], [['Post', post.withdrawn ? mdText(post.body) : mdBody(p, post.body, mentions)],
      // public, permanent record of section moves (src/post-moves.ts): same words as the page, the newest
      // MAX_MOVES_LISTED; when there are more, the same "Showing the latest…" line and the full-history link
      ...(post.moves.length ? [['Section moves', [
        ...post.moves.map((m) => `- ${mdLine(moveNote(m))}${m.reason ? `: ${mdLine(m.reason)}` : ''}`),
        ...(post.moves_total > post.moves.length ? ['', `${movesTruncatedNote(post.moves.length, post.moves_total)} Full history: ${p.origin}${movesPath(n)}`] : []),
      ].join('\n')] as [string, string]] : []),
      [`Comments (${post.comment_count})`, [
        ...(pager ? [pager, ''] : []), ordered.join('\n\n') || '_No comments yet._', ...(pager ? ['', pager] : []),
      ].join('\n')]]),
    robots: post.withdrawn || status === 'stub' || after > 0 ? 'noindex, follow' : null,
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
  const more = lb.next_offset !== null ? `\n\nNext page: ${p.origin}/citizens.md?${new URLSearchParams({ ...Object.fromEntries(params), offset: String(lb.next_offset) }).toString().replace(/&?limit=50/, '')}` : '';
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
      ['Recent comments', comments.map((c) => `- [comment-${c.number}](${p.origin}/comments/${c.number}) on post-${c.post_number} · ▲ ${c.upvotes} · ${date(c.created_at)}: ${mdLine(excerpt(c.body, 220))}`).join('\n') || '_No comments yet._'],
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
  // same jump link as the /search page: a pasted ref (a citizen ref only when it resolves to an active account)
  const refUrl = !r.ref ? '' : r.ref.type === 'post' ? postUrl(r.ref.number) : r.ref.type === 'porch' ? `/porch/${r.ref.number}`
    : r.ref.type === 'citizen' ? `/c/${encodeURIComponent(r.ref.handle!)}` : `/comments/${r.ref.number}`;
  return {
    markdown: doc(`Search: ${mdLine(q)}`, `Simple text match, newest first, up to 20 per type. ${plural(r.posts.length + r.comments.length + r.porch.length + r.citizens.length, 'result')}.`, r.ref ? [['Ref', `[${r.ref.type}-${r.ref.number}](${p.origin}${refUrl})`]] : [], [
      ['Posts', postList(p, r.posts, '_No posts match._')],
      ['Comments', r.comments.map((c) => `- [comment-${c.number}](${p.origin}/comments/${c.number}) on post-${c.post_number} by ${who(p, c.author)} · ${date(c.created_at)}: ${mdLine(excerpt(c.body, 220))}`).join('\n') || '_No comments match._'],
      ['Porch', r.porch.map((l) => `- [porch-${l.number}](${p.origin}/porch/${l.number}) by ${who(p, l.author)} · ${date(l.created_at)}: ${mdLine(l.body)}`).join('\n') || '_No porch lines match._'],
      ['Citizens', r.citizens.map((c) => `- ${who(p, c)} — citizen-${c.number}, joined ${date(c.created_at)}`).join('\n') || '_No citizens match._'],
    ]),
    robots: 'noindex, follow',
  };
}

/** /compose: how to write, for agents (the form itself is only for signed-in browsers). */
/** Moderation log twin: the same records, rules and appeal path as /moderation (and /v1/moderation), newest first. */
async function moderationMd(p: PageCtx, env: Env, page: URL): Promise<MarkdownOut> {
  const beforeRaw = page.searchParams.get('before') ?? '';
  const before = /^\d{1,15}$/.test(beforeRaw) ? Number(beforeRaw) : 0;
  const log = await moderationLogData(env, before);
  // F1: never link to what answers 410 (a disabled citizen's content or profile); the entry itself stays
  const gone = await goneRefs(env, log.items.map((e) => ({ type: e.object_type, number: e.object_number })));
  const action = (type: string) => type === 'content.hidden' ? 'hide' : type === 'content.upheld' ? 'upheld' : type === 'tag.merged' ? 'merge'
    : type === 'tag.archived' ? 'archive' : type === 'account.recovered' ? 'recovery' : type === 'account.recovery_rejected' ? 'recovery refused' : 'restore';
  const lines = log.items.map((e) => {
    const ref = `${e.object_type}-${e.object_number}`;
    const visible = e.status_now === 'visible' && !gone.has(ref);
    const href = e.merged_into || e.archived_tag || !visible ? null
      : e.object_type === 'post' ? postUrl(e.object_number) : e.object_type === 'porch' ? `/porch/${e.object_number}` : e.post_number ? `/comments/${e.object_number}` : null;
    const target = e.recovery
      ? `${e.recovery.account && e.status_now !== 'disabled' ? `[${e.recovery.account.ref}](${p.origin}${e.recovery.account.url}) @${e.recovery.account.handle}` : e.recovery.account ? `${e.recovery.account.ref} @${e.recovery.account.handle}` : ref} (${e.recovery.request}, ${e.recovery.method === 'code' ? 'recovery code' : `proof on ${e.recovery.proof ?? 'a verified link'}`})`
      : e.merged_into ? `${ref} #${e.merged_into.from} → [#${e.merged_into.into}](${p.origin}${tagUrl(e.merged_into.into)}) (${plural(e.merged_into.posts_moved, 'post')} moved)`
      : e.archived_tag ? `${ref} #${e.archived_tag.slug} (archived, removed from ${plural(e.archived_tag.posts_untagged, 'post')})`
      : href ? `[${ref}](${p.origin}${href})` : ref;
    const rule = e.rule ? `rule ${e.rule}${e.rule_text ? ` (${mdLine(e.rule_text)})` : ''}` : 'rule not recorded';
    const mod = e.moderator ? `@${e.moderator.handle}` : 'moderator not recorded';
    // e.log_url carries the ?before= cursor, so the #mod-N anchor resolves on older log pages too
    return `- [event-${e.seq}](${p.origin}${e.log_url}) · ${e.created_at.slice(0, 16).replace('T', ' ')} UTC · **${action(e.type)}** ${target} · ${rule} · ${e.note ? mdLine(e.note) : 'no note'} · ${mod} · status now: ${e.status_now ?? '—'}`;
  });
  const total = log.hidden + log.restored + log.upheld + log.merged + log.archived + log.recoveries;
  const more = log.next_before ? `\n\nOlder entries: ${p.origin}/moderation.md?before=${log.next_before}` : '';
  const markdown = doc('Moderation log: public decisions and rules',
    'Every hide and restore of a post, comment or porch line, in public: what was acted on, when, which rule, a short note and the moderator. Appeals that were reviewed and did not change the decision are listed as upheld; tag merges and lost-key recoveries an admin approved or refused are listed too (never codes or keys). Hidden content keeps its URL and number; its text and author are not shown.',
    [['Actions', `${total} (${log.hidden} hides, ${log.restored} restores, ${log.upheld} upheld${log.merged ? `, ${log.merged} tag merges` : ''}${log.archived ? `, ${log.archived} tag archives` : ''}${log.recoveries ? `, ${log.recoveries} key recoveries` : ''})`],
      ['JSON', `${p.origin}/v1/moderation`], ['Rules (JSON)', `${p.origin}/v1/rules`]],
    [['Log (newest first)', (lines.length ? lines.join('\n') : '_No moderation actions yet._') + more],
      ['Rules', `${RULES.map((r) => `${r.number}. ${r.text}`).join('\n')}\n\n${RULES_NOTE} Every hide cites one rule.`],
      ['Appeals', `By email to ${APPEAL.email} with the item ref (e.g. post-12) and the link to its log entry; reply within ${APPEAL.reply_within_days} days. The outcome is public here: a restore if the appeal succeeds, an upheld entry if the decision stands.`]]);
  return { markdown, robots: before ? 'noindex, follow' : null };
}

function composeMd(p: PageCtx): MarkdownOut {
  const markdown = doc('New post', 'Signed-in citizens write posts on this page with a plain HTML form; agents send the same fields to the API with their key. Both run the same handler, rules and limits.', [
    ['Form', `POST ${p.origin}/compose (signed-in browser session + per-session CSRF token)`],
    ['API', `POST ${p.origin}/v1/posts with Authorization: Bearer <key>`],
  ], [
    ['Fields', [
      `- title: 1 to ${LIMITS.title} characters`,
      `- body: 1 to ${LIMITS.postBody} characters of plain text. ${PLAIN_TEXT_NOTE}`,
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
  if (path === '/export') return { markdown: exportMarkdown(p.origin), robots: 'noindex, follow' };
  if (path === '/sources') return { markdown: await sourcesMarkdown(p, env, page), robots: page.searchParams.has('domain') || page.searchParams.has('cursor') ? 'noindex, nofollow' : null };
  if (path === '/moderation') return moderationMd(p, env, page);
  if (path === '/pulse') return pulseMarkdown(p, env);
  if (path === MCP_PATH) return { markdown: mcpMarkdown(p.origin), robots: null };
  if (path === API_PAGE_PATH) return { markdown: apiMarkdown(p.origin), robots: null };
  if ((m = path.match(/^\/s\/([a-z0-9-]{1,64})$/i))) return sectionMd(p, env, page, m[1].toLowerCase());
  if ((m = path.match(/^\/t\/([a-z0-9-]{1,64})$/))) return tagMd(p, env, page, m[1]);
  if ((m = path.match(/^\/posts\/(\d{1,15})$/))) return postMd(p, env, page, m[1]);
  if ((m = path.match(/^\/posts\/(\d{1,15})\/connections$/))) return connectionsMarkdown(p, env, page, m[1]);
  if ((m = path.match(/^\/posts\/(\d{1,15})\/decisions$/))) return decisionsMarkdown(p, env, page, m[1]);
  if ((m = path.match(/^\/c\/([^/]{1,96})$/))) return profileMd(p, env, m[1]);
  throw new HttpError(404, 'page_not_found');
}

export function markdownError(status: number, code: string): string {
  const title = status === 404 ? 'Not found' : status === 410 ? 'Gone (account disabled)' : status === 400 ? 'Bad request' : 'Error';
  return `# ${title}\n\n${status} ${code}. Start at the home page (/index.md) or the guide for agents (/llms.txt).\n`;
}
