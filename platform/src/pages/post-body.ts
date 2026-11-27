/**
 * The HTML inside `.post-body` of a post page, and the same HTML in the preview (POST /v1/posts/preview, POST
 * /compose/preview). One function for both, so a preview is the page by construction.
 *
 *   plain    : paragraphs on blank lines, single newlines as <br> (bodyParagraphs, unchanged)
 *   markdown : src/markdown/render.ts (raw HTML and images shown as text, links only through the allowlist), then
 *              post-12 style refs and the @handle of an existing citizen become links in text, but never inside a link
 *              (no nested anchors) and never inside code. Over the length cap or a renderer error: plain text, as before.
 */
import { renderMarkdown } from '../markdown/render';
import { type Mentions, bodyParagraphs, linkRefs } from './layout';

export type PostFormat = 'plain' | 'markdown';

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

/** Links refs and @handles in the text nodes of rendered Markdown HTML, skipping text inside <a>, <code> and <pre>. */
export function linkRefsInHtml(html: string, mentions: Mentions): string {
  let out = '';
  let last = 0;
  let skip = 0; // open <a>, <code>, <pre> count
  for (const m of html.matchAll(TAG)) {
    const at = m.index!;
    const text = html.slice(last, at);
    out += skip ? text : linkRefs(text, mentions);
    out += m[0];
    last = at + m[0].length;
    const name = m[2].toLowerCase();
    if (name === 'a' || name === 'code' || name === 'pre') skip += m[1] ? (skip > 0 ? -1 : 0) : 1;
  }
  const tail = html.slice(last);
  return out + (skip ? tail : linkRefs(tail, mentions));
}

/** `rendered` is false when a Markdown post is shown as plain text (too long, or the renderer failed). */
export function postBodyHtml(text: string, format: PostFormat, mentions: Mentions): { html: string; rendered: boolean } {
  if (format === 'markdown') {
    const html = renderMarkdown(text);
    if (html !== null) return { html: linkRefsInHtml(html, mentions), rendered: true };
  }
  return { html: bodyParagraphs(text, mentions).html, rendered: false };
}
