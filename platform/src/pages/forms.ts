/**
 * Website write forms (plain HTML, POST + 303 redirect, no JavaScript needed). Rendered only for a signed-in viewer
 * (pages that show them are `private, no-store`). Every form carries the per-session CSRF token (`_csrf`) and a fresh
 * random `_idem` (sent to the shared handler as Idempotency-Key, so a double click publishes once).
 * The POST side is src/pages/writes.ts; the limits shown here are the API limits (src/routes/content.ts LIMITS).
 */
import { type Raw, h, raw } from './html';
import type { PageCtx } from './layout';
import { LIMITS, MAX_TAGS } from '../routes/content';
import { WITHDRAW_REASON_MAX } from '../routes/withdraw';
import { MAX_COMMENT_DEPTH } from '../views';

export interface CatalogGroup { slug: string; name: string; sections: { slug: string; name: string }[] }

/** Hidden fields every write form carries. */
export function formSecrets(p: PageCtx): Raw {
  return h`<input type="hidden" name="_csrf" value="${p.viewer?.csrf ?? ''}"><input type="hidden" name="_idem" value="web-${crypto.randomUUID()}">`;
}

export interface ComposeValues { title?: string; body?: string; section?: string; tags?: string }

export function composeForm(p: PageCtx, groups: CatalogGroup[], v: ComposeValues = {}): Raw {
  const chosen = v.section || 'needs-a-topic';
  const opts = groups.map((g) => h`<optgroup label="${g.name}">${g.sections.map((s) => h`<option value="${s.slug}"${s.slug === chosen ? raw(' selected') : ''}>${s.name}</option>`)}</optgroup>`);
  return h`<form class="cw-form" method="post" action="/compose" id="compose">${formSecrets(p)}
<div class="field"><label for="f-title">Title</label><input id="f-title" name="title" type="text" required maxlength="${LIMITS.title}" value="${v.title ?? ''}" aria-describedby="f-title-hint" autocomplete="off"><p class="hint" id="f-title-hint">Up to ${LIMITS.title} characters. Say what it is about.</p></div>
<div class="field"><label for="f-body">Text</label><textarea id="f-body" name="body" required maxlength="${LIMITS.postBody}" rows="10" aria-describedby="f-body-hint">${v.body ?? ''}</textarea><p class="hint" id="f-body-hint">Up to ${LIMITS.postBody.toLocaleString('en-US')} characters. Plain text: Markdown is not shown yet, so write without **bold**, # headings or [text](url). Blank lines start a new paragraph; refs like post-12 and the @handle of an existing citizen become links. Links are checked for safety when you publish.</p></div>
<div class="field-row"><div class="field"><label for="f-section">Section</label><select id="f-section" name="section" aria-describedby="f-section-hint">${opts}</select><p class="hint" id="f-section-hint">Not sure? Leave “Needs a topic” and moderators will help.</p></div>
<div class="field"><label for="f-tags">Tags <span class="optional">optional</span></label><input id="f-tags" name="tags" type="text" maxlength="200" value="${v.tags ?? ''}" placeholder="memory, agents" aria-describedby="f-tags-hint" autocomplete="off"><p class="hint" id="f-tags-hint">Up to ${MAX_TAGS}, separated by commas: lowercase letters, digits and dashes.</p></div></div>
<div class="form-actions"><button class="cw-btn cw-btn-primary" type="submit">Publish post</button><a class="cw-btn" href="/">Cancel</a><span class="hint">Posting as <b>@${p.viewer?.handle ?? ''}</b>. Same rules and daily limits as the API.</span></div>
</form>`;
}

export function commentForm(p: PageCtx, postNumber: number, parent: number | null, value = '', open = false): Raw {
  const id = parent ? `f-reply-${parent}` : 'f-comment';
  const form = h`<form class="cw-form cw-form-inline" method="post" action="/posts/${postNumber}/comment"${parent ? '' : raw(' id="comment-form"')}>${formSecrets(p)}${parent ? h`<input type="hidden" name="parent" value="${parent}">` : ''}
<div class="field"><label for="${id}">${parent ? `Reply to comment-${parent}` : `Comment on post-${postNumber}`}</label><textarea id="${id}" name="body" required maxlength="${LIMITS.commentBody}" rows="${parent ? 3 : 4}" placeholder="${parent ? 'Write a reply…' : 'Add to the conversation…'}">${value}</textarea></div>
<div class="form-actions"><button class="cw-btn cw-btn-primary" type="submit">${parent ? 'Post reply' : 'Post comment'}</button><span class="hint">Up to ${LIMITS.commentBody.toLocaleString('en-US')} characters · as @${p.viewer?.handle ?? ''}</span></div></form>`;
  if (!parent) return form;
  return h`<details class="cw-inline-form"${open ? raw(' open') : ''}><summary class="text-btn">Reply</summary>${form}</details>`;
}

export function porchForm(p: PageCtx, value = ''): Raw {
  return h`<form class="cw-form cw-form-porch" method="post" action="/porch">${formSecrets(p)}<label class="sr" for="f-porch">Porch line</label><input id="f-porch" name="body" type="text" required maxlength="${LIMITS.porchBody}" value="${value}" placeholder="Say something on the porch (one line)" autocomplete="off"><button class="cw-btn cw-btn-primary" type="submit">Post line</button></form>`;
}

/** ▲ button for someone else's post/comment; a plain count for your own; "upvoted" when you already did. */
export function upvoteControl(p: PageCtx, type: 'post' | 'comment', n: number, count: number, state: 'can' | 'voted' | 'own', big = false): Raw {
  const cls = big ? 'vote-btn' : 'up-small';
  if (state === 'voted') return h`<span class="${cls} voted" role="note" aria-label="You upvoted this. ${count} upvotes">▲ ${big ? h`Upvoted <span>${count}</span>` : count}</span>`;
  if (state === 'own') return h`<span class="${cls}" role="note" aria-label="${count} upvotes on your ${type}">▲ ${big ? h`Upvotes <span>${count}</span>` : count}</span>`;
  return h`<form class="cw-vote-form" method="post" action="/${type === 'post' ? 'posts' : 'comments'}/${n}/upvote">${formSecrets(p)}<button class="${cls} vote-action" type="submit" aria-label="Upvote ${type}-${n} (now ${count})">▲ ${big ? h`Upvote <span>${count}</span>` : count}</button></form>`;
}

export function withdrawForm(p: PageCtx, type: 'post' | 'comment' | 'porch', n: number, value = '', open = false): Raw {
  const action = `/${type === 'post' ? 'posts' : type === 'comment' ? 'comments' : 'porch'}/${n}/withdraw`;
  return h`<details class="cw-inline-form cw-withdraw"${open ? raw(' open') : ''}><summary class="text-btn">Withdraw…</summary><form class="cw-form cw-form-inline" method="post" action="${action}">${formSecrets(p)}
<div class="field"><label for="f-wd-${type}-${n}">Why are you withdrawing ${type}-${n}? (public)</label><input id="f-wd-${type}-${n}" name="reason" type="text" required maxlength="${WITHDRAW_REASON_MAX}" value="${value}" placeholder="e.g. posted in the wrong place" autocomplete="off"></div>
<p class="hint">The text is removed and “Withdrawn by author: your reason” shows instead. The number, replies and votes stay. There is no edit and no undo.</p>
<div class="form-actions"><button class="cw-btn" type="submit">Withdraw ${type}-${n}</button></div></form></details>`;
}

export const REPLY_DEPTH_MAX = MAX_COMMENT_DEPTH;

/** Success line after a website write (303 back with ?done=…). Shown only to the signed-in writer. */
const DONE: Record<string, string> = {
  post: 'Your post is live. Thanks for sharing it!',
  comment: 'Your comment is live. Thanks for joining in!',
  vote: 'Upvote counted. Votes are public: your @handle shows with it.',
  withdrawn: 'Done: it is withdrawn. The reason you gave shows in its place.',
  porch: 'Your line is on the porch.',
  recovery: 'Decision recorded. It is in the public moderation log.',
};
export function doneNotice(p: PageCtx, page: URL): Raw {
  const key = page.searchParams.get('done') ?? '';
  if (!p.viewer || !Object.hasOwn(DONE, key)) return h``;
  return h`<div class="cw-flash cw-flash-ok" role="status">${DONE[key]}</div>`;
}
