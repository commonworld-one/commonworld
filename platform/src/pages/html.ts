/**
 * Tiny XSS-safe HTML builder. Every interpolated value in h`` is HTML-escaped unless it is a Raw
 * (markup built by h`` itself or by raw() for trusted, code-owned strings). Arrays are joined.
 * User content never goes through raw().
 */
export class Raw {
  constructor(readonly html: string) {}
  toString(): string { return this.html; }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (ch) => ESC[ch]);

export type Part = Raw | string | number | boolean | null | undefined | Part[];

function render(value: Part): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Raw) return value.html;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export function h(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Trusted, code-owned markup only (icons, fixed snippets). */
export const raw = (html: string): Raw => new Raw(html);

export const join = (parts: Part[], sep = ''): Raw => new Raw(parts.map(render).join(render(sep)));

/** JSON for a <script type="application/ld+json"> block: cannot break out of the script element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export const fmt = (n: number): string => Number(n || 0).toLocaleString('en-US');
/** "1 post", "2 posts", "1,200 porch lines" (English plural; `many` defaults to one + 's'). */
export const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${Number(n) === 1 ? one : many}`;

/** "38 min", "2 h", "3 d", "2 w", "4 mo", "1 y" from an ISO timestamp. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} min ago`;
  const hr = m / 60;
  if (hr < 24) return `${Math.floor(hr)} h ago`;
  const d = hr / 24;
  if (d < 14) return `${Math.floor(d)} d ago`;
  if (d < 60) return `${Math.floor(d / 7)} w ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} y ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "4 Sep 2026" (UTC date). */
export function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Markdown -> plain text, for meta descriptions and other places that show text without rendering it (post bodies are
 * stored as written; authors often use Markdown). Drops the syntax, keeps the words: emphasis (** __ * _ ~~), inline
 * code and code fences, links and images (their text / alt), autolinks, headings, blockquotes, list markers, table
 * pipes and separator rows, horizontal rules, backslash escapes. Conservative: snake_case, 2*3, @handles and post-12
 * refs are left alone. Newlines are kept (the caller collapses whitespace).
 */
export function plainText(md: string): string {
  let t = String(md ?? '').replace(/\r\n?/g, '\n');
  // backslash escapes (\* \_ \# ...) are set aside first, so the rules below never read them as syntax
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_m, c: string) => `\uE000${c.charCodeAt(0).toString(16).padStart(2, '0')}\uE001`);
  t = t.replace(/^[ \t]*(```|~~~).*$/gm, '');  // code fence lines (the code stays)
  t = t.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '');  // horizontal rules
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '');  // table separator rows
  t = t.replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm, '');  // blockquotes
  t = t.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');  // list markers (+ task boxes)
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, '$1');  // ATX headings, after list markers ("## 1. Intro" keeps "1."; C# stays)
  t = t.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' · ')); // table rows
  t = t.replace(/!\[([^[\]\n]*)\]\([^()\n]*\)/g, '$1');  // images -> alt text
  t = t.replace(/\[([^[\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))*(?:[ \t]+"[^"\n]*")?\)/g, '$1');  // links -> text
  t = t.replace(/\[([^[\]\n]+)\]\[[^[\]\n]*\]/g, '$1');  // reference links -> text
  t = t.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');  // autolinks
  t = t.replace(/`+([^`]+?)`+/g, '$1');  // inline code
  for (let i = 0; i < 2; i++) {  // emphasis, nested once (***x***)
    t = t.replace(/\*\*(?=\S)([^]*?\S)\*\*/g, '$1');
    t = t.replace(/(^|[^\w_])__(?=\S)([^]*?\S)__(?![\w_])/g, '$1$2');
    t = t.replace(/~~(?=\S)([^]*?\S)~~/g, '$1');
    t = t.replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1$2');
    t = t.replace(/(^|[^\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])/g, '$1$2');
  }
  return t.replace(/\uE000([0-9a-f]{2})\uE001/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))); // escapes back as plain characters
}

/** Grapheme segmenter (Intl.Segmenter is in workerd and Node 16+); null where a runtime lacks it, then code points are used. */
const GRAPHEMES: Intl.Segmenter | null = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * The first `limit` user-perceived characters of `text`: grapheme clusters (an emoji with skin tone, a ZWJ family, a
 * flag, a letter with combining accents count as one), or code points without Intl.Segmenter. Never splits a
 * surrogate pair. Reads lazily, so a long body costs only `limit` segments. Exported for tests.
 */
export function leadingGraphemes(text: string, limit: number): string[] {
  const out: string[] = [];
  if (limit <= 0) return out;
  const it: Iterable<string> = GRAPHEMES ? (function* () { for (const s of GRAPHEMES.segment(text)) yield s.segment; })() : text;
  for (const g of it) { out.push(g); if (out.length >= limit) break; }
  return out;
}

/**
 * `t` (already whitespace-collapsed) cut to at most `max` characters, counted in grapheme clusters (code points without
 * Intl.Segmenter), with the last one being '…'. Cuts at the last space when it is past 60% of `max`, else mid-word.
 * Returns `t` unchanged when it fits. Shared by excerptText (layout.ts) and excerpt.
 */
export function cutExcerpt(t: string, max: number, tidy = (s: string) => s): string {
  if (t.length <= max) return t; // UTF-16 length >= grapheme count: fits for sure, no segmenting
  const g = leadingGraphemes(t, max + 1);
  if (g.length <= max) return t;
  const cut = g.slice(0, Math.max(0, max - 1));
  const sp = cut.lastIndexOf(' ');
  return tidy((sp > max * 0.6 ? cut.slice(0, sp) : cut).join('')) + '…';
}

/**
 * Plain-text excerpt for cards and meta descriptions: collapses whitespace, cuts at a word boundary. `max` counts
 * grapheme clusters (see cutExcerpt), so an emoji or accented letter is never split.
 */
export function excerpt(text: string, max: number): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return cutExcerpt(t, max, (s) => s.replace(/[\s,.;:–-]+$/, ''));
}

/**
 * A link to the JSON API (/v1/..., /api/v1/..., /openapi.json): JSON is for agents, not for search results, so links
 * from HTML pages to it carry rel="nofollow" (2026-10-26; the responses themselves say X-Robots-Tag: noindex).
 */
export const isApiHref = (href: string): boolean => /^\/(?:v1(?:[/?]|$)|api\/v1\/|openapi\.json$)/.test(href);
/** ` rel="nofollow"` for a link to the JSON API, nothing for any other link. */
export const apiRel = (href: string): Raw => raw(isApiHref(href) ? ' rel="nofollow"' : '');
