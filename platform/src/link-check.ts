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
 * What counts as a link: `http://` / `https://` URLs and `www.` hosts anywhere in the text (markdown links included).
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
import { checkDomains, DEFAULT_SOURCES, normalizeDomain, type FetchLike, type SourceResult } from './trust-engine/index.ts';

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

const URL_HOST = /\bhttps?:\/\/(?:[^\s/?#@<>"'`()[\]{}]*@)?([^\s/?#:<>"'`()[\]{}|\\^]+)/gi;
const WWW_HOST = /(?:^|[^a-z0-9.@/-])(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/** Distinct normalized domains of the links in `texts` (http(s) URLs and www. hosts), first-seen order. */
export function linkDomains(texts: string[]): string[] {
  const out: string[] = [];
  const add = (host: string) => {
    const d = normalizeDomain(host.replace(/[.,;:!?]+$/, ''));
    if (d && !out.includes(d)) out.push(d);
  };
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(URL_HOST)) add(m[1]);
    for (const m of String(t ?? '').matchAll(WWW_HOST)) add(m[1]);
  }
  return out;
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

/**
 * Throws 422 link_flagged (and records the rejection) when any source flags a linked domain; records allowed checks.
 * Call after validation and before quota reservation, so a refused text costs nothing.
 */
export async function assertLinksSafe(env: Env, accountId: string, object: LinkObject, texts: string[]): Promise<void> {
  const own = new Set(trustDomains(env).map(normalizeDomain));
  const domains = linkDomains(texts).filter((d) => !own.has(d) && ![...own].some((o) => d.endsWith(`.${o}`)));
  if (!domains.length) return;
  if (domains.length > MAX_LINK_DOMAINS) throw new HttpError(400, 'too_many_link_domains', { max_domains: MAX_LINK_DOMAINS, domains: domains.length });
  let verdicts: DomainVerdict[];
  if (offline(env)) {
    verdicts = domains.map((domain) => ({ domain, status: 'no_data', sources: [] }));
  } else {
    const report = await checkDomains(domains, { sources: DEFAULT_SOURCES, ctx: { fetch: cachedFetch, timeoutMs: LOOKUP_TIMEOUT_MS, retries: 0, sleep: async () => {} } });
    verdicts = domains.map((domain) => {
      const r = report.results[domain];
      return { domain, status: r?.status ?? 'no_data', sources: (r?.sources ?? []).map(({ data: _data, ...s }) => s) };
    });
  }
  const flagged = verdicts.filter((v) => v.status === 'flagged');
  const outcome = flagged.length ? 'rejected' : 'allowed';
  await env.DB.prepare(`INSERT INTO link_checks (checked_at, account_id, object_type, outcome, decided_by, domains_json, flagged_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(nowIso(), accountId, RECORDED_AS[object], outcome, LINK_CHECK_ACTOR, JSON.stringify(verdicts),
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
