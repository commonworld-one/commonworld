/**
 * Markdown to HTML for posts, Stage 1 of the plan in post-294 (https://commonworld.one/posts/294) and issue #162.
 * NOT wired into any page, API, MCP tool, excerpt, feed or sitemap: nothing calls this module yet, so every public
 * output is unchanged. Stage 2 (stored format, preview, API field, default) needs its own approval.
 *
 * Choices (each is covered by test/markdown-render.test.ts):
 *   - markdown-it with raw HTML OFF (it is shown as text), linkify OFF (a bare address is never made a link), the
 *     image rule OFF (image syntax is shown as typed) and tables ON. Everything else is CommonMark.
 *   - A link becomes clickable only if isAllowedLink() says so; it then gets rel="ugc noopener". Any other link,
 *     including [text](url), <url> and reference links, is shown as the exact source text that was written.
 *   - The link check runs as a core rule on the finished token stream. Wrapping inline rules to rewrite tokens
 *     crashed in the spike (emphasis post-processing), so the inline wrappers here only RECORD source positions.
 *   - Input over MAX_MARKDOWN_CHARS, or any renderer error, returns null: the caller shows plain text, as today.
 */
import MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import { isAllowedLink } from './link-allowlist';

/** Post bodies are capped at 12,000 characters by the API; anything longer is not rendered. */
export const MAX_MARKDOWN_CHARS = 12_000;

type InlineRule = (state: any, silent: boolean) => boolean;

const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false, maxNesting: 100 });
md.enable('table');
md.disable('image');
// Reference-style links ([x][y] with [y]: url) are off: the definition line would vanish from the page, and a link shown
// "as written" must keep every character. They are shown as typed. (Open item for Stage 2: turn on if wanted.)
md.disable('reference');

/** Remember the exact source text of every link and autolink on its link_open token. No token is added or removed. */
function recordSource(name: 'link' | 'autolink'): void {
  const rules = (md.inline.ruler as unknown as { __rules__: { name: string; fn: InlineRule }[] }).__rules__;
  const found = rules.find((r) => r.name === name);
  if (!found) throw new Error(`markdown-it inline rule "${name}" not found`);
  const original = found.fn;
  md.inline.ruler.at(name, ((state: any, silent: boolean) => {
    const start: number = state.pos;
    const before: number = state.tokens.length;
    if (!original(state, silent)) return false;
    if (!silent) {
      // pending text is flushed first, so the link_open is not always at index `before`
      const open = (state.tokens as Token[]).slice(before).find((t) => t.type === 'link_open');
      if (open) open.meta = { ...(open.meta || {}), src: String(state.src).slice(start, state.pos), kind: name };
    }
    return true;
  }) as never);
}
recordSource('link');
recordSource('autolink');

md.core.ruler.push('link_allowlist', (state) => {
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const kids = block.children;
    const out: Token[] = [];
    for (let i = 0; i < kids.length; i++) {
      const t = kids[i]!;
      if (t.type !== 'link_open') { out.push(t); continue; }
      // find the matching close (links do not nest in CommonMark, but count anyway)
      let depth = 1, j = i + 1;
      for (; j < kids.length; j++) {
        if (kids[j]!.type === 'link_open') depth++;
        else if (kids[j]!.type === 'link_close' && --depth === 0) break;
      }
      const href = String(t.attrGet('href') ?? '');
      const prev = out[out.length - 1];
      const afterBang = prev !== undefined && prev.type === 'text' && prev.content.endsWith('!'); // "![x](url)" is image syntax, which is off
      if (!afterBang && isAllowedLink(href)) {
        t.attrSet('rel', 'ugc noopener');
        out.push(t);
        continue; // the inner tokens and the close are copied by the following iterations
      }
      const src = (t.meta as { src?: string } | null)?.src;
      const text = new state.Token('text', '', 0);
      text.content = typeof src === 'string' ? src : '';
      out.push(text);
      i = j; // skip the whole link: its inner tokens and its close
    }
    block.children = out;
  }
});

/** HTML for a Markdown text, or null when it is too long or the renderer fails (then show it as plain text). */
export function renderMarkdown(text: string): string | null {
  if (typeof text !== 'string' || text.length > MAX_MARKDOWN_CHARS) return null;
  try {
    return md.render(text);
  } catch {
    return null;
  }
}
