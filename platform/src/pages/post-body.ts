/**
 * The HTML inside `.post-body` of a post page, and the same HTML in the preview (POST /v1/posts/preview, POST
 * /compose/preview). One function for both, so a preview is the page by construction.
 *
 *   plain    : paragraphs on blank lines, single newlines as <br> (bodyParagraphs, unchanged)
 *   markdown : src/markdown/render.ts (raw HTML and images shown as text, links only through the allowlist), then
 *              post-12 style refs and the @handle of an existing citizen become links in text, but never inside a link
 *              (no nested anchors) and never inside code. Over the length cap or a renderer error: plain text, as before.
 */
import { markdownLinkTargets, renderMarkdown } from '../markdown/render';
export { markdownLinkTargets };
import { type Mentions, bodyParagraphs, linkRefs, richText } from './layout';

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
    // The site CSP has no style attributes (style-src 'self'): table alignment becomes a class (ssr.css .md-left/.md-center/.md-right).
    if (html !== null) return { html: linkRefsInHtml(html.replace(/ style="text-align:(left|center|right)"/g, ' class="md-$1"'), mentions), rendered: true };
  }
  return { html: bodyParagraphs(text, mentions).html, rendered: false };
}

/**
 * A Markdown comment or porch line as `<div class="cw-md">…</div>` (scoped styles in ssr.css, smaller headings than a post),
 * or null when it is not rendered as Markdown (a plain row, or a text over the length cap or a renderer error): the caller
 * then shows it as plain text exactly as before. Same renderer, link rules and ref linking as a post.
 */
export function markdownBlock(text: string, format: string | null | undefined, mentions: Mentions): string | null {
  if (format !== 'markdown') return null;
  const { html, rendered } = postBodyHtml(text, 'markdown', mentions);
  return rendered ? `<div class="cw-md">${html}</div>` : null;
}

/**
 * The body HTML of a comment or a porch line, exactly as its page shows it (the page and both previews call this):
 * Markdown rows are a `cw-md` block; plain rows keep the old rendering (comment: richText with every line break kept as
 * <br>; porch line: one paragraph of richText). `rendered` is false for plain text.
 */
export function commentBodyHtml(text: string, format: string | null | undefined, mentions: Mentions, kind: 'comment' | 'porch'): { html: string; rendered: boolean } {
  const md = markdownBlock(text, format, mentions);
  if (md !== null) return { html: md, rendered: true };
  const rich = richText(text, mentions).html;
  return { html: kind === 'comment' ? rich.replace(/\r\n?|\n/g, '<br>') : `<p>${rich}</p>`, rendered: false };
}
