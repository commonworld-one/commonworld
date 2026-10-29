// Vendored from commonworld-one/commonworld trust/src/engine.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
/** Run every source over a list of domains and combine the answers.
 * Rule: a domain is flagged when ANY single source flags it; clean when at least one source answered and none flags it;
 * no_data when no source could answer. */
import { normalizeDomain } from './domain.ts';
import { iso } from './http.ts';
import { DEFAULT_SOURCES } from './sources/index.ts';
import type { CheckContext, DomainResult, EngineReport, SourceResult, Source, Verdict } from './types.ts';

export const ENGINE = 'Commonworld trust engine';
export const ENGINE_VERSION = '0.1.0';
export const USER_AGENT = `CommonworldTrust/${ENGINE_VERSION} (+https://github.com/commonworld-one/commonworld/blob/main/TRUST.md)`;

export function combine(sources: SourceResult[]): Verdict {
  if (sources.some((s) => s.verdict === 'flagged')) return 'flagged';
  if (sources.some((s) => s.verdict === 'clean')) return 'clean';
  return 'no_data';
}

export function defaultContext(over: Partial<CheckContext> = {}): CheckContext {
  return {
    fetch: (u, i) => fetch(u, i as RequestInit),
    now: () => new Date(),
    timeoutMs: 20000,
    retries: 3,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms + Math.random() * 250)),
    userAgent: USER_AGENT,
    ...over,
  };
}

export async function checkDomains(input: string[], opts: { sources?: Source[]; ctx?: Partial<CheckContext> } = {}): Promise<EngineReport> {
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const ctx = defaultContext(opts.ctx);
  const started = iso(ctx.now());
  const domains = [...new Set(input.map(normalizeDomain).filter(Boolean))].sort();
  const per = await Promise.all(sources.map(async (s) => {
    try { return await s.check(domains, ctx); } catch (e) {  // a source must never take the run down
      const at = iso(ctx.now());
      return new Map(domains.map((d): [string, SourceResult] => [d, { name: s.id, verdict: 'no_data', checked_at: at, evidence_url: s.url, error: String((e as Error).message || e).slice(0, 160) }]));
    }
  }));
  const results: Record<string, DomainResult> = {};
  for (const d of domains) {
    const srcs = sources.map((s, i) => per[i].get(d) ?? { name: s.id, verdict: 'no_data' as Verdict, checked_at: iso(ctx.now()), evidence_url: s.url, error: 'no answer' });
    results[d] = { domain: d, status: combine(srcs), sources: srcs };
  }
  const vals = Object.values(results);
  const n = (v: Verdict) => vals.filter((r) => r.status === v).length;
  return {
    engine: ENGINE, engine_version: ENGINE_VERSION, run_started_at: started, run_at: iso(ctx.now()),
    sources: sources.map(({ id, name, covers, url, terms }) => ({ id, name, covers, url, terms })),
    summary: { domains: vals.length, clean: n('clean'), flagged: n('flagged'), no_data: n('no_data'),
      source_errors: vals.reduce((a, r) => a + r.sources.filter((s) => s.error).length, 0) },
    flagged: vals.filter((r) => r.status === 'flagged').map((r) => r.domain),
    results,
  };
}
