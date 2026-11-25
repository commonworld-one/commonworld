/** Bounded public-link reads. No retries or dropped failures; keep the suite's overall deadline. */
export const LINK_CONCURRENCY = 4;
export const LINK_TIMEOUT_MS = 30_000;

interface LinkResponse { status(): number; dispose(): Promise<void> }
interface LinkRequest {
  get(url: string, options: { failOnStatusCode: false; timeout: number; maxRetries: number }): Promise<LinkResponse>;
}
export interface LinkResult { url: string; status?: number; error?: string }

export async function checkLinks(request: LinkRequest, urls: string[]): Promise<LinkResult[]> {
  const results: LinkResult[] = new Array(urls.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, urls.length) }, async () => {
    while (next < urls.length) {
      const index = next++;
      const url = urls[index];
      try {
        const response = await request.get(url, { failOnStatusCode: false, timeout: LINK_TIMEOUT_MS, maxRetries: 0 });
        try { results[index] = { url, status: response.status() }; }
        finally { await response.dispose(); }
      } catch (error) {
        results[index] = { url, error: String(error) };
      }
    }
  }));
  return results;
}

export function linkFailures(results: LinkResult[]): LinkResult[] {
  return results.filter((result) => result.error !== undefined || result.status === undefined || result.status >= 400);
}
