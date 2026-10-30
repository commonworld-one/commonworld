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
import { EVENT_OBJECT_GONE, EVENT_OBJECT_HIDDEN, isDeletedHandle } from '../views';
import { ACTOR_WRITING_EVENTS, MODERATION_EVENTS, moderationEventData } from '../routes/content';
import { ago, h, type Raw } from './html';
import { av, citizenUrl, crumbs, document, emptyState, postUrl, tagUrl, who, type PageCtx } from './layout';
import { goneRefs } from './data';

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
  if (type === 'porch') return number === null ? null : `/porch#porch-${number}`;
  return null;
}

/** A ref (post-12, #slug) as a link when it has a page that is not gone; plain text otherwise (F1). */
function refLink(ref: string, url: string | null, gone: Set<string>): Raw {
  if (!url || gone.has(ref)) return h`<span class="ref">${ref}</span>`;
  return h`<a class="ref" href="${url}">${ref}</a>`;
}

/** The actor, with its normal byline; a neutral muted noun when the actor is hidden from this reader. */
function actorWho(p: PageCtx, e: ActivityItem, fallback: string): Raw {
  return e.actor?.handle ? who(e.actor) : h`<span class="who"><span class="h muted">${fallback}</span></span>`;
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
  if (t === 'content.upheld') return moderationSentence(p, e, 'upheld an appeal on', gone);
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

function eventRow(p: PageCtx, e: ActivityItem, gone: Set<string>): Raw {
  const star = e.actor?.handle ? av(e.actor.handle, e.actor.kind) : av('cw', 'human', 'cw-av-muted');
  return h`<li class="activity-item" data-type="${e.type}">${star}<div class="ai-body"><div class="ai-line">${sentence(p, e, gone)}${note(p, e)}</div><div class="ai-meta muted">${e.created_at.slice(0, 16).replace('T', ' ')} UTC · ${ago(e.created_at, p.now)}</div></div></li>`;
}

// ---------------------------------------------------------------- page

export async function activityPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  const before = intParam(page, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const data = await activityData(env, before);
  // F1: never link to what answers 410 (a disabled citizen's content or profile)
  const gone = await goneRefs(env, data.items.flatMap((e) => (e.object.number === null ? [] : [{ type: e.object.type, number: e.object.number }])));
  const list = data.items.length
    ? h`<ol class="list activity">${data.items.map((e) => eventRow(p, e, gone)).join('')}</ol>`
    : emptyState('No activity yet', NO_EVENTS);
  const pager = data.next_before !== null
    ? h`<div class="more-row"><a class="cw-btn" href="${ACTIVITY_PATH}?before=${data.next_before}" rel="next">Older →</a></div>`
    : h``;
  const body = h`${crumbs([['Activity', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/pulse">Public record</a><h1>Activity</h1><p>${LEAD}</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${data.items.length} events</strong><span class="spacer muted">newest first · JSON: /v1/feed</span></div><p>The same events as the public <a href="/v1/feed" rel="nofollow">change feed</a> (oldest first, for polling) and the <a href="/moderation">moderation log</a> (moderation actions only).</p></div></section>
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

function mdItem(p: PageCtx, e: ActivityItem, gone: Set<string>): string {
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
  else if (t === 'content.upheld') head = `${mdWho(p, e, 'a moderator')} upheld an appeal on ${ref}`;
  else if (t === 'tag.merged') head = `${mdWho(p, e, 'a moderator')} merged a tag`;
  else if (t === 'tag.archived') head = `${mdWho(p, e, 'a moderator')} archived a tag`;
  else if (t === 'account.recovered') head = `${mdWho(p, e, 'a moderator')} approved a key recovery`;
  else if (t === 'account.recovery_rejected') head = `${mdWho(p, e, 'a moderator')} refused a key recovery`;
  else if (t === 'account.created') head = `${actor} joined Commonworld`;
  else if (t === 'account.deleted') head = `An account was deleted`;
  else head = `${actor} ${ref}`;
  const d = e.data as { rule?: unknown; note?: unknown } | null;
  const noteText = MODERATION_EVENTS.has(t) && typeof d?.rule === 'number' ? ` — rule ${d.rule}${typeof d?.note === 'string' && d.note ? `: “${mdLine(d.note)}”` : ''}` : '';
  return `- \`${when}\` · ${head}${noteText}`;
}

export async function activityMarkdown(p: PageCtx, env: Env, page: URL): Promise<{ markdown: string; robots: string | null }> {
  const before = intParam(page, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const data = await activityData(env, before);
  const gone = await goneRefs(env, data.items.flatMap((e) => (e.object.number === null ? [] : [{ type: e.object.type, number: e.object.number }])));
  const lines = data.items.length ? data.items.map((e) => mdItem(p, e, gone)) : ['_No activity yet._'];
  const more = data.next_before !== null ? `\n\nOlder events: ${p.origin}${ACTIVITY_PATH}.md?before=${data.next_before}` : '';
  const markdown = `# ${ACTIVITY_TITLE}\n\n${LEAD}\n\n- HTML: ${p.origin}${ACTIVITY_PATH}\n- JSON: ${p.origin}/v1/feed\n- Shown: newest first · ${data.items.length} events\n\n## Recent events (newest first)\n\n${lines.join('\n')}${more}\n`;
  return { markdown, robots: before ? 'noindex,follow' : null };
}