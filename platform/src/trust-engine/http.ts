// Vendored from commonworld-one/commonworld trust/src/http.ts @ 1780784 (scripts/vendor-trust.sh). Do not edit here: change the engine upstream and re-vendor.
/** GET with timeout, retries on network errors / 429 / 5xx, and exponential backoff. */
import type { CheckContext } from './types.ts';

export async function getText(url: string, ctx: CheckContext, accept = '*/*'): Promise<string> {
  let delay = 1000;
  let last = '';
  for (let attempt = 0; attempt <= ctx.retries; attempt++) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(ctx.timeoutMs) : undefined;
      const r = await ctx.fetch(url, { headers: { 'user-agent': ctx.userAgent, accept }, signal });
      if (r.ok) return await r.text();
      last = `HTTP ${r.status}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      last = `${(e as Error)?.name || 'Error'}: ${(e as Error)?.message || e}`.slice(0, 160);
    }
    if (attempt < ctx.retries) { await ctx.sleep(delay); delay *= 2; }
  }
  throw new Error(last || 'request failed');
}

export function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
