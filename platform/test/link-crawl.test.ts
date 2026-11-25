import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLinks, LINK_CONCURRENCY, LINK_TIMEOUT_MS, linkFailures } from '../e2e/support/link-crawl';

afterEach(() => vi.useRealTimers());

describe('llms public-link crawl', () => {
  it('checks all 60 links within the unchanged 60s budget under cumulative latency, at most four at once', async () => {
    vi.useFakeTimers();
    const urls = Array.from({ length: 60 }, (_, i) => `https://example.org/${i}`);
    let active = 0, peak = 0;
    const disposed: string[] = [];
    const get = vi.fn(async (url: string) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      active--;
      return { status: () => 200, dispose: async () => { disposed.push(url); } };
    });
    const start = Date.now();
    const pending = checkLinks({ get }, urls);
    await vi.runAllTimersAsync();
    const results = await pending;
    expect(Date.now() - start).toBe(18_000); // serial baseline: 72_000 ms, over the 60_000 ms test deadline
    expect(peak).toBe(LINK_CONCURRENCY);
    expect(results.map((result) => result.url)).toEqual(urls);
    expect(disposed).toHaveLength(60);
    expect(get).toHaveBeenCalledTimes(60);
    expect(linkFailures(results)).toEqual([]);
    for (const [, options] of get.mock.calls as unknown as [string, unknown][]) {
      expect(options).toEqual({ failOnStatusCode: false, timeout: LINK_TIMEOUT_MS, maxRetries: 0 });
    }
  });

  it('keeps 404, 500 and transport/timeout failures visible without retries, and still checks later links', async () => {
    const urls = ['ok', 'missing', 'server', 'timeout', 'after'];
    const get = vi.fn(async (url: string) => {
      if (url === 'timeout') throw new Error('request timed out');
      return { status: () => ({ missing: 404, server: 500 }[url] ?? 200), dispose: async () => {} };
    });
    const results = await checkLinks({ get }, urls);
    expect(get).toHaveBeenCalledTimes(5);
    expect(results.map((result) => result.url)).toEqual(urls);
    expect(linkFailures(results).map((result) => result.url)).toEqual(['missing', 'server', 'timeout']);
    expect(results[3].error).toContain('timed out');
  });

  it('handles an empty list and does not hide missing response state', async () => {
    const get = vi.fn();
    expect(await checkLinks({ get }, [])).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(linkFailures([{ url: 'incomplete' }])).toHaveLength(1);
  });
});
