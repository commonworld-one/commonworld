// Vendored from commonworld-one/commonworld trust/src/sources/list.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
/** Generic blocklist source: download one list file per run, then match every domain against it (exact name, www. form,
 * or a non-shared parent domain; see domain.ts). Being absent from the list is verdict clean; a failed download is
 * no_data with the error, for every domain.
 *
 * Two matchers with identical results: for a handful of domains (the hourly own-domain check inside a Worker, where CPU
 * time is capped) a delimited substring search over the raw text, so a multi-megabyte list is never parsed; for many
 * domains (the Atlas) a Set built once. */
import { candidates, normalizeDomain } from '../domain.ts';
import { getText, iso } from '../http.ts';
import type { CheckContext, Source, SourceResult } from '../types.ts';

export type ListFormat =
  /** JSON array of domain strings, or an array under `key` of a JSON object. */
  | { kind: 'json-array'; key?: string }
  /** One entry per line (domain, or URL when `urls`), `#` comments allowed. */
  | { kind: 'lines'; urls?: boolean };

export interface ListSpec {
  id: string;
  name: string;
  covers: string;
  /** File downloaded each run. */
  url: string;
  /** Human page for the list (evidence link). */
  evidence_url: string;
  terms: string;
  format: ListFormat;
  /** Up to this many domains use the substring matcher. */
  substringMax?: number;
}

/** Part of the text that holds the entries (for `key`: the JSON array after `"key"`), lower-cased. */
function region(text: string, f: ListFormat): string {
  const t = text.toLowerCase();
  if (f.kind === 'json-array' && f.key) {
    const k = t.indexOf(`"${f.key.toLowerCase()}"`);
    if (k < 0) throw new Error(`list has no "${f.key}" array`);
    const open = t.indexOf('[', k);
    const close = t.indexOf(']', open);  // domain strings never contain ']'
    if (open < 0 || close < 0) throw new Error(`"${f.key}" is not an array`);
    return t.slice(open, close + 1);
  }
  if (f.kind === 'json-array') {
    if (!t.trimStart().startsWith('[')) throw new Error('list is not a JSON array');
    return t;
  }
  return '\n' + (t.includes('\r') ? t.replace(/\r/g, '') : t) + '\n';
}

function hostOfLine(line: string, urls: boolean): string {
  const s = line.trim();
  if (!s || s.startsWith('#')) return '';
  if (!urls) return s.replace(/\.$/, '');
  try { return new URL(s.includes('://') ? s : 'http://' + s).hostname.replace(/\.$/, ''); } catch { return ''; }
}

/**
 * Entries not written as a plain ASCII host name (Unicode labels, percent-escapes, IDNA dots such as U+3002), in the
 * normalized form the domains we look up are in (domain.ts: punycode, lower case), so both sides of a match are compared
 * normalized. An entry with a path ('/') is never reduced to its host, so a listing of one page of a shared site never
 * flags the whole site. The lists in use today hold none of these; this keeps a future one from being missed.
 */
export function oddEntries(r: string): Set<string> {
  const out = new Set<string>();
  for (const tok of r.match(/[^\s",[\]]*(?:[^\x00-\x7f]|%[0-9a-f]{2})[^\s",[\]]*/gi) ?? []) {
    if (/[/?#]/.test(tok)) continue;
    const d = normalizeDomain(tok);
    if (d) out.add(d);
  }
  return out;
}

export function buildSet(text: string, f: ListFormat): Set<string> {
  const r = region(text, f);
  let out: Set<string>;
  if (f.kind === 'json-array') {
    const arr = JSON.parse(r);
    if (!Array.isArray(arr)) throw new Error('list is not a JSON array');
    out = new Set(arr.filter((x: unknown) => typeof x === 'string').map((x: string) => x.trim().replace(/\.$/, '')));
  } else {
    out = new Set<string>();
    for (const line of r.split('\n')) { const h = hostOfLine(line, !!f.urls); if (h) out.add(h); }
  }
  for (const d of oddEntries(r)) out.add(d);
  return out;
}

/** Substring matcher: true when `name` appears as a whole entry. */
export function substringHas(r: string, f: ListFormat, name: string): boolean {
  if (f.kind === 'json-array') return r.includes(`"${name}"`) || r.includes(`"${name}."`);
  if (!f.urls) return r.includes(`\n${name}\n`) || r.includes(`\n${name}.\n`);
  // URL lines: the host sits between '://' (or line start) and one of / : ? # or end of line
  let i = r.indexOf(name);
  while (i >= 0) {
    const pre = r.slice(Math.max(0, i - 3), i);
    const startOk = pre === '://' || r[i - 1] === '\n' || r[i - 1] === '@';
    const after = r[i + name.length] ?? '\n';
    if (startOk && '/:?#\r\n'.includes(after)) return true;
    i = r.indexOf(name, i + 1);
  }
  return false;
}

export function listSource(spec: ListSpec): Source {
  return {
    id: spec.id, name: spec.name, covers: spec.covers, url: spec.url, terms: spec.terms,
    async check(domains: string[], ctx: CheckContext): Promise<Map<string, SourceResult>> {
      const out = new Map<string, SourceResult>();
      let text: string;
      try {
        text = await getText(spec.url, ctx);
      } catch (e) {
        const at = iso(ctx.now());
        for (const d of domains) out.set(d, { name: spec.id, verdict: 'no_data', checked_at: at, evidence_url: spec.evidence_url, error: String((e as Error).message || e) });
        return out;
      }
      const at = iso(ctx.now());
      let has: (n: string) => boolean;
      try {
        if (domains.length <= (spec.substringMax ?? 20)) {
          const r = region(text, spec.format);
          if (r.length < 3) throw new Error('list is empty');
          const odd = oddEntries(r);
          has = (n) => substringHas(r, spec.format, n) || odd.has(n);
        } else {
          const set = buildSet(text, spec.format);
          if (set.size === 0) throw new Error('list is empty');
          has = (n) => set.has(n);
        }
      } catch (e) {
        for (const d of domains) out.set(d, { name: spec.id, verdict: 'no_data', checked_at: at, evidence_url: spec.evidence_url, error: `unexpected list format: ${(e as Error).message}`.slice(0, 160) });
        return out;
      }
      for (const d of domains) {
        const hit = candidates(d).find(has);
        out.set(d, hit
          ? { name: spec.id, verdict: 'flagged', checked_at: at, evidence_url: spec.evidence_url, detail: `listed as ${hit}` }
          : { name: spec.id, verdict: 'clean', checked_at: at, evidence_url: spec.evidence_url });
      }
      return out;
    },
  };
}
