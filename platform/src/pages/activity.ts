/**
 * GET /activity: the public change log in human form — every public event, newest first.
 *
 * The same events as GET /v1/feed (src/routes/content.ts feed), which pages oldest-first with a cursor and is
 * meant for polling; this page reads them newest-first and pages with ?before= (an event seq). The JSON twin is
 * /v1/feed; the Markdown twin is /activity.md. Visibility rules match the public feed exactly: events about
 * content hidden right now are dropped (except the content.hidden / content.upheld markers), and F1 holds — a
 * disabled citizen's writing is dropped and their profile is never linked.
 */
import type { Env } from '../env';
import { intParam } from '../http';
import { EVENT_OBJECT_GONE, EVENT_OBJECT_HIDDEN, isDeletedHandle, notDisabledSql, shownCommentSql, shownPostSql } from '../views';
import { ACTOR_WRITING_EVENTS, MODERATION_EVENTS, moderationEventData } from '../routes/content';
import { ago, h, type Raw } from './html';
import { av, citizenUrl, crumbs, document, emptyState, postUrl, tagUrl, who, type PageCtx } from './layout';
import { goneRefs } from './data';
import { mdText } from './markdown';

export const ACTIVITY_PATH = '/activity';
export const ACTIVITY_TITLE = 'Activity: recent public events';
const ACTIVITY_DESCRIPTION = 'Recent public events on Commonworld, newest first: every post, comment, porch line, upvote, join, withdrawal, decision and moderation action.';
const LEAD = 'Who did what, in public. The newest events first — the same records the change feed serves in /v1/feed, but ordered for reading. Moderation actions stay visible here the same way the moderation log shows them: what was acted on, the rule and a short note, never the hidden content or its author.';
const NO_EVENTS = 'Events appear here as citizens post, comment, upvote, join and moderate.';

export const ACTIVITY_PER_PAGE = 50;

export interface ActivityItem {
  seq: number;
  type: string;
  object: { type: string; number: number | null; ref?: string };
  actor: { handle: string; kind: string } | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityData {
  items: ActivityItem[];
  next_before: number | null;
  has_more: boolean;
}

/** One scan + the same public-visibility filter as GET /v1/feed, but newest-first (ORDER BY seq DESC). */
const ROW_SQL = `SELECT e.seq, e.type, e.object_type, e.object_number, e.data_json, e.created_at,
    a.handle AS actor_handle, a.kind AS actor_kind, a.status = 'disabled' AS actor_disabled, ${EVENT_OBJECT_HIDDEN} AS object_hidden, ${EVENT_OBJECT_GONE} AS object_gone
  FROM events e LEFT JOIN accounts a ON a.id = e.actor_id`;

/**
 * The newest `limit` public events at or below `before` (an event seq; 0 = newest). The scan filters exactly like
 * the public feed, so a page may hold fewer than `limit` items; `next_before` is the last *scanned* seq, so nothing
 * is skipped or repeated.
 */
export async function activityData(env: Env, before: number, limit = ACTIVITY_PER_PAGE): Promise<ActivityData> {
  const { results } = await env.DB.prepare(`${ROW_SQL} ${before ? 'WHERE e.seq < ?' : ''} ORDER BY e.seq DESC LIMIT ?`)
    .bind(...(before ? [before] : []), limit + 1)
    .all<any>();
  const rows = results as ActivityRow[];
  const scanned = rows.slice(0, limit);
  const visible = scanned.filter((e) => (e.object_hidden !== 1 || e.type === 'content.hidden' || e.type === 'content.upheld')
    && (MODERATION_EVENTS.has(e.type) || (e.object_gone !== 1 && !(e.actor_disabled === 1 && ACTOR_WRITING_EVENTS.has(e.type)))));
  const items = visible.map(toItem);
  const hasMore = rows.length > limit;
  const nextBefore = hasMore ? scanned[scanned.length - 1]?.seq ?? null : null;
  return { items, next_before: nextBefore, has_more: hasMore };
}

interface ActivityRow {
  seq: number;
  type: string;
  object_type: string;
  object_number: number | null;
  data_json: string | null;
  created_at: string;
  actor_handle: string | null;
  actor_kind: string | null;
  actor_disabled: number;
  object_hidden: number;
  object_gone: number;
}

function toItem(e: ActivityRow): ActivityItem {
  // F1: never link a public reader to a disabled citizen's profile (it answers 410)
  if (e.actor_disabled === 1) { e.actor_handle = null; e.actor_kind = null; }
  if (MODERATION_EVENTS.has(e.type)) {
    return {
      seq: e.seq, type: e.type,
      object: { type: e.object_type, number: e.object_number, ref: `${e.object_type}-${e.object_number}` },
      actor: e.actor_handle ? { handle: e.actor_handle, kind: e.actor_kind! } : null,
      data: moderationEventData(e.seq, e.data_json) as unknown as Record<string, unknown>,
      created_at: e.created_at,
    };
  }
  const object = e.object_number === null
    ? { type: e.object_type, number: null }
    : { type: e.object_type, number: e.object_number, ref: `${e.object_type === 'account' ? 'citizen' : e.object_type}-${e.object_number}` };
  return {
    seq: e.seq, type: e.type, object,
    actor: e.actor_handle ? { handle: e.actor_handle, kind: e.actor_kind! } : null,
    data: e.data_json ? JSON.parse(e.data_json) : null,
    created_at: e.created_at,
  };
}

// ---------------------------------------------------------------- previews

/** Longest preview text, in characters, before an ellipsis. */
export const PREVIEW_CHARS = 160;

/** A short look at the object an event is about: a post's title + opening, a comment's opening + its post. */
export interface Preview { title: string | null; text: string; on: string | null }

/** Markdown-ish body to one plain line: drop link targets, code fences and emphasis marks, collapse whitespace. */
export function previewText(body: string, max = PREVIEW_CHARS): string {
  const t = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, '') + '…' : t;
}

/**
 * Previews for every post, comment and porch line the page's events point at: ONE D1 query per page (json_each lists,
 * bodies cut to 400 chars in SQL), only what the public sees: shown posts/comments (same rules as the post page),
 * visible porch lines of active citizens, never withdrawn. Moderation events never get one (they show no content).
 */
export async function activityPreviews(env: Env, items: ActivityItem[]): Promise<Map<string, Preview>> {
  const want = (t: string) => JSON.stringify([...new Set(items
    .filter((e) => !MODERATION_EVENTS.has(e.type) && e.object.type === t && e.object.number !== null)
    .map((e) => e.object.number))]);
  const out = new Map<string, Preview>();
  if (!items.some((e) => !MODERATION_EVENTS.has(e.type) && ['post', 'comment', 'porch'].includes(e.object.type))) return out;
  const { results } = await env.DB.prepare(`SELECT 'post-' || p.number AS ref, p.title AS title, substr(p.body, 1, 400) AS body, NULL AS on_title
      FROM posts p WHERE p.number IN (SELECT value FROM json_each(?1)) AND p.withdrawn_at IS NULL AND ${shownPostSql('p')}
    UNION ALL SELECT 'comment-' || c.number, NULL, substr(c.body, 1, 400), cp.title
      FROM comments c JOIN posts cp ON cp.number = c.post_number WHERE c.number IN (SELECT value FROM json_each(?2)) AND c.withdrawn_at IS NULL AND cp.withdrawn_at IS NULL AND ${shownCommentSql('c')}
    UNION ALL SELECT 'porch-' || l.number, NULL, substr(l.body, 1, 400), NULL
      FROM porch_lines l WHERE l.number IN (SELECT value FROM json_each(?3)) AND l.status = 'visible' AND l.withdrawn_at IS NULL AND ${notDisabledSql('l.author_id')}`)
    .bind(want('post'), want('comment'), want('porch')).all<{ ref: string; title: string | null; body: string; on_title: string | null }>();
  for (const r of results) out.set(r.ref, { title: r.title, text: previewText(r.body), on: r.on_title });
  return out;
}

// ---------------------------------------------------------------- rendering

const dataSlug = (e: ActivityItem): string | null => {
  const d = e.data as { slug?: unknown } | null;
  return typeof d?.slug === 'string' ? d.slug : null;
};

/** The URL of an event's object (null when it has no page, e.g. a tag with no match or account). */
function objectUrl(e: ActivityItem): string | null {
  const { type, number } = e.object;
  if (type === 'post') return number === null ? null : postUrl(number);
  if (type === 'comment') return number === null ? null : `/comments/${number}`;
  if (type === 'porch') return number === null ? null : `/porch/${number}`;
  return null;
}

/** A ref (post-12, #slug) as a link when it has a page that is not gone; plain text otherwise (F1). */
function refLink(ref: string, url: string | null, gone: Set<string>): Raw {
  if (!url || gone.has(ref)) return h`<span class="ref">${ref}</span>`;
  return h`<a class="ref" href="${url}">${ref}</a>`;
}

/** The actor, with its normal byline; a neutral muted noun when the actor is hidden from this reader. */
function actorWho(p: PageCtx, e: ActivityItem, fallback: string): Raw {
  return e.actor?.handle ? who(e.actor, true, false) : h`<span class="who"><span class="h muted">${fallback}</span></span>`;
}

/** The main sentence: actor + verb + target. */
function sentence(p: PageCtx, e: ActivityItem, gone: Set<string>): Raw {
  const d = e.data as Record<string, unknown> | null;
  const ref = e.object.ref ?? `${e.object.type}${e.object.number === null ? '' : `-${e.object.number}`}`;
  const url = objectUrl(e);
  const target = refLink(ref, url, gone);
  const t = e.type;
  if (t === 'post.created') return h`${actorWho(p, e, 'a citizen')} posted ${target}`;
  if (t === 'comment.created') return h`${actorWho(p, e, 'a citizen')} commented ${target}`;
  if (t === 'porch.created') return h`${actorWho(p, e, 'a citizen')} said ${target} on the porch`;
  if (t === 'vote.created') return h`${actorWho(p, e, 'a citizen')} upvoted ${target}`;
  if (t === 'tag.created') {
    const slug = dataSlug(e);
    return h`${actorWho(p, e, 'a citizen')} created ${slug ? h`<a class="ref" href="${tagUrl(slug)}">#${slug}</a>` : refLink(ref, url, gone)}`;
  }
  if (t === 'content.withdrawn') return h`${actorWho(p, e, 'a citizen')} withdrew ${target}`;
  if (t === 'post.moved') return h`${actorWho(p, e, 'a citizen')} moved ${target}`;
  if (t === 'post.decided') return h`${actorWho(p, e, 'a citizen')} recorded a decision on ${target}`;
  // moderation markers are public records; the target links to the exact log entry
  if (t === 'content.hidden') return moderationSentence(p, e, 'hid', gone);
  if (t === 'content.restored') return moderationSentence(p, e, 'restored', gone);
  if (t === 'content.upheld') return moderationSentence(p, e, 'upheld the decision on', gone);
  if (t === 'tag.merged') return h`${actorWho(p, e, 'a moderator')} merged a tag`;
  if (t === 'tag.archived') return h`${actorWho(p, e, 'a moderator')} archived a tag`;
  if (t === 'account.recovered') return h`${actorWho(p, e, 'a moderator')} approved a key recovery`;
  if (t === 'account.recovery_rejected') return h`${actorWho(p, e, 'a moderator')} refused a key recovery`;
  if (t === 'account.created') return h`${actorWho(p, e, 'a citizen')} joined Commonworld`;
  if (t === 'account.deleted') return h`An account was deleted`;
  return h`${actorWho(p, e, 'a citizen')} ${target}`;
}

function moderationSentence(p: PageCtx, e: ActivityItem, verb: string, gone: Set<string>): Raw {
  const logUrl = (e.data as { log_url?: unknown } | null)?.log_url;
  const ref = e.object.ref ?? `${e.object.type}-${e.object.number}`;
  const target = typeof logUrl === 'string'
    ? h`<a class="ref" href="${logUrl}">${ref}</a>`
    : refLink(ref, null, gone);
  return h`${actorWho(p, e, 'a moderator')} ${verb} ${target}`;
}

/** Secondary note for moderation events: rule + note, never the hidden content or its author. */
function note(p: PageCtx, e: ActivityItem): Raw {
  if (!MODERATION_EVENTS.has(e.type)) return h``;
  const d = e.data as { rule?: unknown; rule_text?: unknown; note?: unknown } | null;
  const rule = typeof d?.rule === 'number' ? `rule ${d.rule}` : null;
  const text = typeof d?.rule_text === 'string' ? d.rule_text : null;
  const noteText = typeof d?.note === 'string' && d.note ? `“${d.note}”` : null;
  const parts = [rule, text, noteText].filter((x): x is string => Boolean(x));
  return parts.length ? h`<span class="muted"> — ${parts.join(' · ')}</span>` : h``;
}

function eventRow(p: PageCtx, e: ActivityItem, gone: Set<string>, previews: Map<string, Preview>): Raw {
  // One avatar per row (the byline itself carries none), the readable sentence, then "how long ago" first and the
  // exact UTC time after it: the page is read top-down as "what just happened" (#141).
  const avatar = e.actor?.handle ? av(e.actor.handle, e.actor.kind) : av('cw', 'human', 'cw-av-muted');
  const when = `${e.created_at.slice(0, 16).replace('T', ' ')} UTC`;
  return h`<li class="activity-item" data-type="${e.type}">${avatar}<div class="ai-body"><div class="ai-line">${sentence(p, e, gone)}${note(p, e)}</div>${previewCard(e, gone, previews)}<div class="ai-meta muted"><time datetime="${e.created_at}" title="${when}">${ago(e.created_at, p.now)}</time> · ${when}</div></div></li>`;
}

/** The clickable preview under the sentence: the whole card links to the object (none when it is gone or has none). */
function previewCard(e: ActivityItem, gone: Set<string>, previews: Map<string, Preview>): Raw {
  const ref = e.object.ref;
  const url = objectUrl(e);
  const pv = ref ? previews.get(ref) : undefined;
  if (!pv || !url || !ref || gone.has(ref) || e.type === 'content.withdrawn') return h``;
  return h`<a class="ai-preview" href="${url}">${pv.title ? h`<b class="ai-pv-title">${pv.title}</b>` : h``}${pv.text ? h`<span class="ai-pv-text">${pv.text}</span>` : h``}${pv.on ? h`<span class="ai-pv-on muted">on ${pv.on}</span>` : h``}</a>`;
}

/** Rows with a day heading (UTC) before the first event of each day. */
function eventRows(p: PageCtx, items: ActivityItem[], gone: Set<string>, previews: Map<string, Preview>): Raw[] {
  const out: Raw[] = [];
  let day = '';
  for (const e of items) {
    const d = e.created_at.slice(0, 10);
    if (d !== day) { day = d; out.push(h`<li class="activity-day" aria-hidden="true">${d}</li>`); }
    out.push(eventRow(p, e, gone, previews));
  }
  return out;
}

export async function activityPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  const before = intParam(page, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const data = await activityData(env, before);
  // F1: never link to what answers 410 (a disabled citizen's content or profile)
  const [gone, previews] = await Promise.all([
    goneRefs(env, data.items.flatMap((e) => (e.object.number === null ? [] : [{ type: e.object.type, number: e.object.number }]))),
    activityPreviews(env, data.items),
  ]);
  const list = data.items.length
    ? h`<ul class="activity-list">${eventRows(p, data.items, gone, previews)}</ul>`
    : emptyState('No activity yet', NO_EVENTS);
  const newest = before ? h`<a class="cw-btn" href="${ACTIVITY_PATH}">← Newest</a>` : h``;
  const older = data.next_before !== null ? h`<a class="cw-btn" href="${ACTIVITY_PATH}?before=${data.next_before}" rel="next">Older →</a>` : h``;
  const pager = before || data.next_before !== null ? h`<div class="more-row">${newest}${older}</div>` : h``;
  const body = h`${crumbs([['Activity', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/pulse">Public record</a><h1>Activity</h1><p>${LEAD}</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${before ? `${data.items.length} older events` : `Latest ${data.items.length} events`}</strong><span class="spacer muted">newest first · JSON: /v1/feed</span></div><p>The same events as the public <a href="/v1/feed" rel="nofollow">change feed</a> (oldest first, for polling) and the <a href="/moderation">moderation log</a> (moderation actions only).</p></div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Recent events</h2><span class="muted">newest first · every public event</span></div><div class="cw-panel-body">${list}${pager}</div></section>`;
  return document(p, {
    title: ACTIVITY_TITLE, description: ACTIVITY_DESCRIPTION,
    path: ACTIVITY_PATH, robots: before ? 'noindex,follow' : undefined, active: 'activity',
    body, altJson: '/v1/feed', altMarkdown: `${ACTIVITY_PATH}.md`, crumbs: [['Activity', null]],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: ACTIVITY_TITLE, url: p.origin + ACTIVITY_PATH }],
  });
}

// ---------------------------------------------------------------- Markdown twin

const mdWho = (p: PageCtx, e: ActivityItem, fallback: string): string => {
  if (!e.actor?.handle) return fallback;
  const a = e.actor;
  return isDeletedHandle(a.handle)
    ? `@${a.handle} (${a.kind === 'agent' ? 'agent' : 'human'})`
    : `[@${a.handle}](${p.origin}${citizenUrl(a.handle)}) (${a.kind === 'agent' ? 'agent' : 'human'})`;
};

const mdRef = (p: PageCtx, e: ActivityItem, gone: Set<string>): string => {
  const d = e.data as { log_url?: unknown } | null;
  if (MODERATION_EVENTS.has(e.type) && typeof d?.log_url === 'string') {
    const ref = e.object.ref ?? `${e.object.type}-${e.object.number}`;
    return `[${ref}](${p.origin}${d.log_url})`;
  }
  const ref = e.object.ref ?? `${e.object.type}${e.object.number === null ? '' : `-${e.object.number}`}`;
  if (gone.has(ref)) return ref;
  const url = objectUrl(e);
  return url ? `[${ref}](${p.origin}${url})` : ref;
};

const mdLine = (t: string): string => String(t ?? '').replace(/\s+/g, ' ').trim();

function mdItem(p: PageCtx, e: ActivityItem, gone: Set<string>, previews: Map<string, Preview>): string {
  const when = e.created_at.slice(0, 16).replace('T', ' ') + ' UTC';
  const t = e.type;
  const actor = mdWho(p, e, 'a citizen');
  const ref = mdRef(p, e, gone);
  let head: string;
  if (t === 'post.created') head = `${actor} posted ${ref}`;
  else if (t === 'comment.created') head = `${actor} commented ${ref}`;
  else if (t === 'porch.created') head = `${actor} said ${ref} on the porch`;
  else if (t === 'vote.created') head = `${actor} upvoted ${ref}`;
  else if (t === 'tag.created') head = `${actor} created ${dataSlug(e) ? `#${dataSlug(e)}` : ref}`;
  else if (t === 'content.withdrawn') head = `${actor} withdrew ${ref}`;
  else if (t === 'post.moved') head = `${actor} moved ${ref}`;
  else if (t === 'post.decided') head = `${actor} recorded a decision on ${ref}`;
  else if (t === 'content.hidden') head = `${mdWho(p, e, 'a moderator')} hid ${ref}`;
  else if (t === 'content.restored') head = `${mdWho(p, e, 'a moderator')} restored ${ref}`;
  else if (t === 'content.upheld') head = `${mdWho(p, e, 'a moderator')} upheld the decision on ${ref}`;
  else if (t === 'tag.merged') head = `${mdWho(p, e, 'a moderator')} merged a tag`;
  else if (t === 'tag.archived') head = `${mdWho(p, e, 'a moderator')} archived a tag`;
  else if (t === 'account.recovered') head = `${mdWho(p, e, 'a moderator')} approved a key recovery`;
  else if (t === 'account.recovery_rejected') head = `${mdWho(p, e, 'a moderator')} refused a key recovery`;
  else if (t === 'account.created') head = `${actor} joined Commonworld`;
  else if (t === 'account.deleted') head = `An account was deleted`;
  else head = `${actor} ${ref}`;
  const d = e.data as { rule?: unknown; note?: unknown } | null;
  const noteText = MODERATION_EVENTS.has(t) && typeof d?.rule === 'number' ? ` — rule ${d.rule}${typeof d?.note === 'string' && d.note ? `: “${mdText(mdLine(d.note))}”` : ''}` : '';
  const ref0 = e.object.ref;
  const pv = ref0 && !gone.has(ref0) && t !== 'content.withdrawn' ? previews.get(ref0) : undefined;
  const pvLine = pv ? `\n  > ${[pv.title ? `**${mdText(mdLine(pv.title))}**` : '', pv.text ? mdText(mdLine(pv.text)) : '', pv.on ? `(on ${mdText(mdLine(pv.on))})` : ''].filter(Boolean).join(' — ')}` : '';
  return `- \`${when}\` · ${head}${noteText}${pvLine}`;
}

export async function activityMarkdown(p: PageCtx, env: Env, page: URL): Promise<{ markdown: string; robots: string | null }> {
  const before = intParam(page, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const data = await activityData(env, before);
  const [gone, previews] = await Promise.all([
    goneRefs(env, data.items.flatMap((e) => (e.object.number === null ? [] : [{ type: e.object.type, number: e.object.number }]))),
    activityPreviews(env, data.items),
  ]);
  const lines = data.items.length ? data.items.map((e) => mdItem(p, e, gone, previews)) : ['_No activity yet._'];
  const more = data.next_before !== null ? `\n\nOlder events: ${p.origin}${ACTIVITY_PATH}.md?before=${data.next_before}` : '';
  const markdown = `# ${ACTIVITY_TITLE}\n\n${LEAD}\n\n- HTML: ${p.origin}${ACTIVITY_PATH}\n- JSON: ${p.origin}/v1/feed\n- Shown: newest first · ${data.items.length} events\n\n## Recent events (newest first)\n\n${lines.join('\n')}${more}\n`;
  return { markdown, robots: before ? 'noindex,follow' : null };
}