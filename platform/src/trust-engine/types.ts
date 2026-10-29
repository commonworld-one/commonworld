// Vendored from commonworld-one/commonworld trust/src/types.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
/** Commonworld trust engine: shared types. Plain TypeScript (no enums, no runtime deps) so it runs under Node's type
 * stripping (`node src/cli.ts`), under vitest and inside a Cloudflare Worker (vendored copy in the v1 app). */

export type Verdict = 'clean' | 'flagged' | 'no_data';

/** What one source said about one domain. */
export interface SourceResult {
  /** Source id, e.g. `google_safe_browsing`. */
  name: string;
  verdict: Verdict;
  /** ISO 8601 UTC time of the lookup (or of the list download it was matched against). */
  checked_at: string;
  /** Public page where anyone can see the evidence (a lookup page or the list file). */
  evidence_url: string;
  /** Short human detail: the threat type, or the list entry that matched. */
  detail?: string;
  /** Set when the source could not answer (network error, bad answer); verdict is then no_data. */
  error?: string;
  /** Source-specific raw fields (e.g. Safe Browsing code and threats). */
  data?: Record<string, unknown>;
}

/** Combined result for one domain. status: flagged if ANY source flags it; clean if at least one source answered and
 * none flags it; no_data if no source could answer. */
export interface DomainResult {
  domain: string;
  status: Verdict;
  sources: SourceResult[];
}

export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CheckContext {
  fetch: FetchLike;
  /** Current time (injectable for tests). */
  now: () => Date;
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Retries per request on network errors, 429 and 5xx. */
  retries: number;
  /** Sleep between retries (injectable so tests run instantly). */
  sleep: (ms: number) => Promise<void>;
  userAgent: string;
}

/** A plugin source. `check` answers for every domain it is given (one entry per domain, never throws). */
export interface Source {
  id: string;
  name: string;
  /** What the source covers, one line. */
  covers: string;
  /** Where the data comes from (list file or lookup endpoint documentation). */
  url: string;
  /** Licence / terms page and the reason we may use it. */
  terms: string;
  check(domains: string[], ctx: CheckContext): Promise<Map<string, SourceResult>>;
}

export interface SourceInfo {
  id: string;
  name: string;
  covers: string;
  url: string;
  terms: string;
}

export interface EngineReport {
  engine: string;
  engine_version: string;
  run_started_at: string;
  run_at: string;
  sources: SourceInfo[];
  summary: { domains: number; clean: number; flagged: number; no_data: number; source_errors: number };
  flagged: string[];
  results: Record<string, DomainResult>;
}
