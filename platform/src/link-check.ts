/**
 * Link check at publish (trust standard, "Links in posts and comments: when they are published"):
 * https://github.com/commonworld-one/commonworld/blob/main/TRUST.md
 *
 * Every create of a post, comment or porch line (the /v1 API and the website forms run the SAME handlers in
 * src/routes/content.ts, so both are covered) extracts the domains of the links in its text and asks the vendored trust
 * engine (src/trust-engine/, every default source: Google Safe Browsing, MetaMask eth-phishing-detect, ScamSniffer,
 * CERT Polska) about them before anything is written or any quota is used:
 *
 *   - any source flags any domain  -> 422 link_flagged, nothing is published; the answer names each flagged domain with
 *                                     every source's verdict + evidence link and how to appeal
 *   - more than MAX_LINK_DOMAINS   -> 400 too_many_link_domains (a long list cannot hide a bad link past the cap)
 *   - clean / no_data              -> published (TRUST.md rule: flagged only when a source says so; a source that cannot
 *                                     answer never blocks)
 *
 * What counts as a link: `http(s):` URLs (any run of '/' or '\' after the scheme, as a browser reads it) and `www.` hosts
 * anywhere in the text (markdown links included); a text with character references (`&#58;`) is also read decoded.
 * Hosts are read the way a browser reads them (trust engine hostOf: IDNA dots such as U+3002, percent-decoding,
 * punycode, case, userinfo, port). A link host that cannot be read as a domain name is refused as unsafe (fail closed,
 * 422 link_flagged with source `link_check`, recorded like any rejection); it is never skipped. Names that are not
 * domains (localhost, an intranet name, an IP literal in brackets) are skipped as before: no blocklist lists them.
 * Our own domains (TRUST_DOMAINS, checked hourly) are skipped. A text without links does no lookup at all.
 *
 * History: every check that looked at least one domain up is one row in D1 `link_checks` (migration 0019):
 * when, which account wrote it, object type, outcome (allowed / rejected), decided_by `hark` (automatic decision,
 * as the standard says), and per domain the combined status with every source's verdict, time and evidence link.
 * Never the text itself. Allowed rows are pruned after LINK_CHECK_RETENTION_DAYS; rejected rows are kept as the record.
 *
 * Sources are fetched through the Cloudflare cache (cf.cacheTtl) and blocklists are kept in the isolate for
 * LIST_MEMO_MS, so a publish costs one small lookup per domain, not three multi-megabyte downloads. Every body is read
 * under a size cap (src/capped-fetch.ts); a list over its cap is not used and the previous copy keeps answering.
 */
import type { Env } from './env';
import { cappedFetchLike } from './capped-fetch';
import { HttpError, nowIso } from './http';
import { trustDomains, TRUST_STANDARD_URL } from './trust';
import { checkDomains, DEFAULT_SOURCES, hostOf, normalizeDomain, type FetchLike, type SourceResult } from './trust-engine/index.ts';

export const MAX_LINK_DOMAINS = 20;
export const LINK_CHECK_RETENTION_DAYS = 90;
export const LINK_CHECK_ACTOR = 'hark';
export const LINK_APPEAL = {
  text: 'If you think a domain was flagged by mistake, open an issue titled "Appeal: your-domain" or write to nerd27dk@commonworld.one. We reply within 7 days.',
  issues: 'https://github.com/commonworld-one/commonworld/issues',
  email: 'nerd27dk@commonworld.one',
  reply_within_days: 7,
  standard: TRUST_STANDARD_URL,
} as const;
const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_TTL_S = 600;
const LIST_MEMO_MS = 10 * 60_000;

export type LinkObject = 'post' | 'comment' | 'porch' | 'decision';
/**
 * What link_checks.object_type records. Its CHECK (migration 0019) allows post | comment | porch only, and widening a
 * SQLite CHECK means rebuilding the table (a destructive migration), so a decision on a post (src/routes/decisions.ts)
 * is recorded as 'post': its summary and why are public text of that post's record.
 */
const RECORDED_AS: Record<LinkObject, 'post' | 'comment' | 'porch'> = { post: 'post', comment: 'comment', porch: 'porch', decision: 'post' };

/** http(s) URLs wherever "http(s):" starts, also right after a word character ("_https://x_" is Markdown italics).
 * The scheme may be followed by any number of '/' or '\' (none included): a browser reads "https:/x", "https:\x" and
 * "https:x" as https://x/ for this scheme, so a Markdown reader that keeps such a destination links the host.
 * Userinfo and host are read in a lookahead, so only the scheme and its slashes are consumed: a URL that starts inside
 * the previous one's host (text without spaces, "https://a.example\u3001https://b.example") is found too, and a host
 * ends where the next "http(s):/" begins. */
const URL_HOST = /https?:[\/\\]*(?=(?:[^\s/?#@<>"'`()[\]{}]*@)?((?:(?!https?:[\/\\])[^\s/?#:<>"'`()[\]{}|\\^])+))/gi;
/** www. hosts; the label separator may also be an IDNA dot (U+3002, U+FF0E, U+FF61) or a percent-encoded dot. */
const WWW_HOST = /(?:^|[^a-z0-9.@/-])(www(?:\.|[\u3002\uff0e\uff61]|%2e)[a-z0-9-]+(?:(?:\.|[\u3002\uff0e\uff61]|%2e)[a-z0-9-]+)+)/gi;
/** What may follow a link and is not part of its host: sentence punctuation (ASCII, typographic quotes, dashes and the
 * ellipsis, the full-width / CJK forms; the IDNA dots among them only ever end the name, as a trailing dot does) and
 * Markdown emphasis (**, _, ~~). */
const TRAILING_PUNCT = /[.,;:!?*_~\u2026\u2013\u2014\u2018\u2019\u201c\u201d\u00ab\u00bb\u2039\u203a\u3001\u3002\uff0c\uff0e\uff61\uff1b\uff1a\uff01\uff1f\u300d\u300f\u3011\u3009\u300b\uff09]+$/;
/** A wildcard label written before a name ("*.example.com") is looked up as that name. */
const WILDCARD_LABELS = /^(?:\*\.)+/;
/** Longest leading run of plain host characters: a link written as "listed.example" + non-ASCII text may be cut there
 * by a reader's autolinker, so that prefix is looked up too. */
const ASCII_PREFIX = /^[a-z0-9_.-]+/i;
/** Longest host recorded for an unreadable link (the record never holds the text, and a host is capped in DNS anyway). */
const MAX_RECORDED_HOST = 253;

/** Named character references that can spell a URL's punctuation; numeric references are decoded generally. */
const NAMED_REFS: Record<string, string> = { colon: ':', sol: '/', bsol: '\\', period: '.', commat: '@', amp: '&', percnt: '%', num: '#', quest: '?' };

/** HTML / CommonMark character references decoded (&#58; &#x3a; &colon; ...); unknown or invalid ones stay as written. */
export function decodeCharRefs(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));/gi, (m, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return Object.hasOwn(NAMED_REFS, name) ? NAMED_REFS[name]! : m; // names are case-sensitive
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

export interface LinkHosts {
  /** Distinct normalized domains to look up, first-seen order. */
  domains: string[];
  /** Distinct link hosts that cannot be read as a domain name (as written, capped): refused, never skipped. */
  unreadable: string[];
}

/** Every link host in `texts`: normalized domains to look up, and hosts that cannot be read as a domain name. */
export function linkHosts(texts: string[]): LinkHosts {
  const domains: string[] = [];
  const unreadable: string[] = [];
  const push = (list: string[], v: string) => { if (!list.includes(v)) list.push(v); };
  const add = (raw: string) => {
    const host = raw.replace(TRAILING_PUNCT, '').replace(WILDCARD_LABELS, '');
    if (!host) return;
    const h = hostOf(host);
    if (h.status === 'domain') push(domains, h.domain);
    else if (h.status === 'unreadable') push(unreadable, host.slice(0, MAX_RECORDED_HOST));
    if (h.status !== 'unreadable' && /[^\x00-\x7f]|%/.test(host)) {
      const prefix = normalizeDomain((host.match(ASCII_PREFIX)?.[0] ?? '').replace(/\.+$/, ''));
      if (prefix) push(domains, prefix);
    }
  };
  for (const t of texts) {
    const text = String(t ?? '');
    // a Markdown reader decodes character references in link text and destinations ("https&#58;//x", "x&#46;example"),
    // so a text with references is also read decoded
    for (const v of text.includes('&') ? [text, decodeCharRefs(text)] : [text]) {
      for (const m of v.matchAll(URL_HOST)) add(m[1]);
      for (const m of v.matchAll(WWW_HOST)) add(m[1]);
    }
  }
  return { domains, unreadable };
}

/** Distinct normalized domains of the links in `texts` (http(s) URLs and www. hosts), first-seen order. */
export function linkDomains(texts: string[]): string[] {
  return linkHosts(texts).domains;
}

const listMemo = new Map<string, { at: number; text: string }>();
const LIST_URLS = new Set(DEFAULT_SOURCES.map((s) => s.url));

/** Cloudflare-cached subrequests, every body read under its size cap (src/capped-fetch.ts). */
const cfCappedFetch = cappedFetchLike((u, init) =>
  globalThis.fetch(u, { headers: init?.headers, signal: init?.signal, cf: { cacheTtl: CACHE_TTL_S, cacheEverything: true } } as RequestInit));

/**
 * Engine fetch: the big blocklists memoized in this isolate. A list over its cap (or any failed download) never replaces
 * the memo: the previous copy keeps answering (its time is not refreshed, so the next publish tries again); with no
 * previous copy the source answers no_data, as for a network error.
 */
const cachedFetch: FetchLike = async (u, init) => {
  const isList = LIST_URLS.has(u);
  const hit = isList ? listMemo.get(u) : undefined;
  if (hit && Date.now() - hit.at < LIST_MEMO_MS) return { ok: true, status: 200, text: async () => hit.text };
  const res = await cfCappedFetch(u, init);
  if (!isList) return res;
  if (!res.ok) return hit ? { ok: true, status: 200, text: async () => hit.text } : res;
  const text = await res.text();
  listMemo.set(u, { at: Date.now(), text });
  return { ok: true, status: res.status, text: async () => text };
};
export const resetLinkCheckMemo = (): void => listMemo.clear();
/** For tests: the engine fetch used at publish (memo + caps). */
export const linkCheckFetch: FetchLike = cachedFetch;

/** Offline switch for local development and tests only: honoured only when ENVIRONMENT is "local". */
const offline = (env: Env) => env.LINK_CHECK_OFFLINE === '1' && (env.ENVIRONMENT ?? 'local') === 'local';

interface DomainVerdict { domain: string; status: string; sources: Omit<SourceResult, 'data'>[] }

/** Verdict of the link check itself for a link host that cannot be read as a domain name (fail closed). */
export const UNREADABLE_SOURCE = (at: string): Omit<SourceResult, 'data'> => ({
  name: 'link_check', verdict: 'flagged', checked_at: at, evidence_url: TRUST_STANDARD_URL,
  detail: 'the host name of this link cannot be read as a domain name, so it cannot be checked',
});

/**
 * Throws 422 link_flagged (and records the rejection) when any source flags a linked domain; records allowed checks.
 * Call after validation and before quota reservation, so a refused text costs nothing.
 */
export async function assertLinksSafe(env: Env, accountId: string, object: LinkObject, texts: string[]): Promise<void> {
  const own = trustDomains(env).map(normalizeDomain).filter(Boolean);
  const isOwn = (d: string) => own.some((o) => d === o || d.endsWith(`.${o}`));
  const hosts = linkHosts(texts);
  const domains = hosts.domains.filter((d) => !isOwn(d));
  if (!domains.length && !hosts.unreadable.length) return;
  if (domains.length + hosts.unreadable.length > MAX_LINK_DOMAINS) {
    throw new HttpError(400, 'too_many_link_domains', { max_domains: MAX_LINK_DOMAINS, domains: domains.length + hosts.unreadable.length });
  }
  const at = nowIso();
  // fail closed: a host that cannot be read as a domain name is refused, never skipped
  const unreadable: DomainVerdict[] = hosts.unreadable.map((domain) => ({ domain, status: 'flagged', sources: [UNREADABLE_SOURCE(at)] }));
  let verdicts: DomainVerdict[];
  if (!domains.length) {
    verdicts = [];
  } else if (offline(env)) {
    verdicts = domains.map((domain) => ({ domain, status: 'no_data', sources: [] }));
  } else {
    const report = await checkDomains(domains, { sources: DEFAULT_SOURCES, ctx: { fetch: cachedFetch, timeoutMs: LOOKUP_TIMEOUT_MS, retries: 0, sleep: async () => {} } });
    verdicts = domains.map((domain) => {
      const r = report.results[domain];
      // every domain here is already normalized, so the engine answers under the same name; a missing answer would
      // mean a lookup under another name, which must not pass as no_data
      if (!r) return { domain, status: 'flagged', sources: [UNREADABLE_SOURCE(at)] };
      return { domain, status: r.status, sources: r.sources.map(({ data: _data, ...s }) => s) };
    });
  }
  verdicts = [...unreadable, ...verdicts];
  const flagged = verdicts.filter((v) => v.status === 'flagged');
  const outcome = flagged.length ? 'rejected' : 'allowed';
  await env.DB.prepare(`INSERT INTO link_checks (checked_at, account_id, object_type, outcome, decided_by, domains_json, flagged_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(at, accountId, RECORDED_AS[object], outcome, LINK_CHECK_ACTOR, JSON.stringify(verdicts),
    JSON.stringify(flagged.map((v) => v.domain))).run();
  if (!flagged.length) return;
  throw new HttpError(422, 'link_flagged', {
    message: 'A link in this text points to a domain that a safety source lists as unsafe, so it was not published.',
    domains: flagged.map((v) => ({
      domain: v.domain,
      sources: v.sources.filter((s) => s.verdict === 'flagged').map((s) => ({ name: s.name, detail: s.detail ?? null, evidence_url: s.evidence_url, checked_at: s.checked_at })),
    })),
    appeal: LINK_APPEAL,
  });
}

/** Nightly: drop allowed link checks older than LINK_CHECK_RETENTION_DAYS (rejections stay as the record). */
export async function pruneLinkChecks(env: Env, now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - LINK_CHECK_RETENTION_DAYS * 86_400_000).toISOString();
  const r = await env.DB.prepare("DELETE FROM link_checks WHERE outcome = 'allowed' AND checked_at < ?").bind(cutoff).run();
  return r.meta.changes ?? 0;
}
