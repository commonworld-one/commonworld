// Vendored from commonworld-one/commonworld trust/src/sources/google-safe-browsing.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
/** Google Safe Browsing site status, read from the public Transparency Report endpoint (no API key; the same lookup as
 * https://transparencyreport.google.com/safe-browsing/search). Polite: at most 4 lookups at a time, timeout, retries. */
import { getText, iso } from '../http.ts';
import type { CheckContext, Source, SourceResult, Verdict } from '../types.ts';

export const GSB_ENDPOINT = 'https://transparencyreport.google.com/transparencyreport/api/v3/safebrowsing/status?site=';
const FLAG_NAMES: Record<number, string> = { 2: 'malware', 3: 'unwanted_software', 4: 'social_engineering', 5: 'flag_5', 6: 'flag_6' };

export function evidenceUrl(domain: string): string {
  return 'https://transparencyreport.google.com/safe-browsing/search?url=' + encodeURIComponent(domain);
}

/** Transparency Report answer -> verdict, code, threats, google_updated_at. Throws on an unexpected body. */
export function parseAnswer(raw: string): { verdict: Verdict; code: number; threats: string[]; google_updated_at: string | null } {
  let body = raw.trimStart();
  if (body.startsWith('<')) throw new Error('HTML answer (rate limit or consent page)');
  if (body.startsWith(")]}'")) body = body.slice(4);
  const row = JSON.parse(body)[0];
  if (!Array.isArray(row) || row[0] !== 'sb.ssr') throw new Error('unexpected answer');
  const code = Number(row[1]);
  const threats: string[] = [];
  for (let i = 2; i < 7; i++) if (row[i] === true) threats.push(FLAG_NAMES[i] ?? `flag_${i}`);
  const upd = typeof row[7] === 'number' && row[7] > 0 ? iso(new Date(row[7])) : null;
  let verdict: Verdict;
  if (threats.length || code === 2 || code === 3) verdict = 'flagged';
  else if (code === 1 || code === 4) verdict = 'clean';  // 1: no unsafe content; 4: large site, no site-wide flag
  else verdict = 'no_data';                              // 6: no available data (and anything unknown)
  return { verdict, code, threats, google_updated_at: upd };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export const googleSafeBrowsing: Source = {
  id: 'google_safe_browsing',
  name: 'Google Safe Browsing',
  covers: 'malware, unwanted software, social engineering (phishing, deceptive pages)',
  url: 'https://transparencyreport.google.com/safe-browsing/search',
  terms: 'Public Transparency Report site status lookup, no key; we publish only our own per-domain verdict with a link to Google\'s page.',
  async check(domains: string[], ctx: CheckContext): Promise<Map<string, SourceResult>> {
    const rows = await pool(domains, 4, async (d): Promise<SourceResult> => {
      const ev = evidenceUrl(d);
      try {
        const a = parseAnswer(await getText(GSB_ENDPOINT + encodeURIComponent(d), ctx, 'application/json'));
        return { name: 'google_safe_browsing', verdict: a.verdict, checked_at: iso(ctx.now()), evidence_url: ev,
          ...(a.threats.length ? { detail: a.threats.join(', ') } : {}),
          data: { code: a.code, threats: a.threats, google_updated_at: a.google_updated_at } };
      } catch (e) {
        return { name: 'google_safe_browsing', verdict: 'no_data', checked_at: iso(ctx.now()), evidence_url: ev, error: String((e as Error).message || e).slice(0, 160) };
      }
    });
    return new Map(domains.map((d, i) => [d, rows[i]]));
  },
};
