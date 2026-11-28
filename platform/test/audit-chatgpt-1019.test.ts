/**
 * ChatGPT independent audit of e743430 (2026-10-19):
 *   1. recovery proofs never follow redirects (cross-host, same-host, http downgrade = not verified)
 *   2. strict public-domain validator for domain proofs (every IP spelling and internal names refused)
 *   3. unsafe-domain lists and lookups read under a byte cap; over the cap = failed download, previous memo kept
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capFor, cappedFetchLike, DEFAULT_RESPONSE_CAP, LIST_CAPS, logSafeUrl, OVER_CAP_STATUS, resetCapWarnings } from '../src/capped-fetch';
import { linkCheckFetch, resetLinkCheckMemo } from '../src/link-check';
import { findProof, normalizeSubject, strictPublicDomain } from '../src/recovery';
import { runTrustCheck } from '../src/trust';
import { GSB_ENDPOINT } from '../src/trust-engine/sources/google-safe-browsing.ts';
import { certPolska, metamask, scamsniffer } from '../src/trust-engine/index.ts';
import { resetDb } from './helpers';

beforeEach(() => { resetLinkCheckMemo(); resetCapWarnings(); });
afterEach(() => vi.restoreAllMocks());

const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

describe('1. recovery: redirects are never followed', () => {
  const CODE = 'cw-citizen-7-abcdefghjk';
  function site(wellKnown: () => Response) {
    const calls: { url: string; redirect?: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = urlOf(input);
      calls.push({ url: u, redirect: init?.redirect });
      if (u.startsWith('https://cloudflare-dns.com/')) return new Response('{"Status":0}');
      if (u === 'https://owned.example/.well-known/commonworld-proof.txt') return wellKnown();
      return new Response(`proof ${CODE}`); // any redirect target would "have" the code
    }) as typeof fetch);
    return calls;
  }
  const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });

  it('a direct 200 with the code still verifies, fetched with redirect: manual', async () => {
    const calls = site(() => new Response(`${CODE}\n`));
    expect(await findProof('domain', 'owned.example', CODE)).toMatchObject({ ok: true, method: 'well-known' });
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
  });

  it('cross-domain redirect -> not verified, the target is never fetched', async () => {
    const calls = site(redirect('https://attacker.example/proof.txt'));
    expect((await findProof('domain', 'owned.example', CODE)).ok).toBe(false);
    expect(calls.some((c) => new URL(c.url).hostname === 'attacker.example')).toBe(false);
  });

  it('same-host redirect -> not verified too (strictest rule: the proof must be at the exact URL)', async () => {
    for (const status of [301, 302, 307, 308]) {
      const calls = site(redirect('https://owned.example/proof-elsewhere.txt', status));
      expect((await findProof('domain', 'owned.example', CODE)).ok, String(status)).toBe(false);
      expect(calls.some((c) => c.url === 'https://owned.example/proof-elsewhere.txt')).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it('http downgrade redirect -> not verified, http is never fetched', async () => {
    const calls = site(redirect('http://owned.example/.well-known/commonworld-proof.txt', 301));
    expect((await findProof('domain', 'owned.example', CODE)).ok).toBe(false);
    expect(calls.some((c) => c.url.startsWith('http://'))).toBe(false);
  });

  it('a response that reports it was redirected or came from another host is refused', async () => {
    site(() => { const r = new Response(`${CODE}`); Object.defineProperty(r, 'redirected', { value: true }); return r; });
    expect((await findProof('domain', 'owned.example', CODE)).ok).toBe(false);
    vi.restoreAllMocks();
    site(() => { const r = new Response(`${CODE}`); Object.defineProperty(r, 'url', { value: 'https://attacker.example/x' }); return r; });
    expect((await findProof('domain', 'owned.example', CODE)).ok).toBe(false);
    vi.restoreAllMocks();
    site(() => { const r = new Response(`${CODE}`); Object.defineProperty(r, 'url', { value: 'http://owned.example/.well-known/commonworld-proof.txt' }); return r; });
    expect((await findProof('domain', 'owned.example', CODE)).ok).toBe(false);
  });

  it('the same rule covers the GitHub / FxTwitter lookups (a redirected API answer is not evidence)', async () => {
    const calls: { url: string; redirect?: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = urlOf(input);
      calls.push({ url: u, redirect: init?.redirect });
      if (u.startsWith('https://api.github.com/users/someone') || u.startsWith('https://api.fxtwitter.com/')) return new Response(null, { status: 301, headers: { location: 'https://evil.example/' } });
      return new Response(JSON.stringify({ bio: CODE, user: { description: CODE } }));
    }) as typeof fetch);
    expect((await findProof('github', 'someone', CODE)).ok).toBe(false);
    expect((await findProof('x', 'someone', CODE)).ok).toBe(false);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
    expect(calls.some((c) => new URL(c.url).hostname === 'evil.example')).toBe(false);
  });
});

describe('2. recovery: strict public domain names', () => {
  const sub = (s: string) => normalizeSubject(env as any, 'domain', s);

  it('refuses every IP literal spelling the URL parser accepts', () => {
    for (const s of ['127.0.0.1', '127.1', '0x7f.0.0.1', '0x7f000001', '0177.0.0.1', '192.168.1', '10.1', '2130706433', '017700000001',
      '[::1]', '::1', 'https://[::1]/', '[::ffff:127.0.0.1]', 'https://127.1/', 'http://0x7f.0.0.1/x', '1.2.3.4', '10.0.0.1', '0.0.0.0', '255.255.255.255']) {
      expect(sub(s), s).toBeNull();
    }
  });

  it('refuses internal / reserved names and malformed labels', () => {
    for (const s of ['localhost', 'foo.localhost', 'printer.local', 'db.internal', 'nas.lan', 'router.home.arpa', '1.0.0.127.in-addr.arpa', 'x.invalid', 'a.onion',
      'example', 'example.c', 'example.123', 'example.0x1f', '-bad.example', 'bad-.example', 'a..example', `${'a'.repeat(64)}.example`,
      `${Array(60).fill('abcd').join('.')}.com`, 'under_score.example', 'sp ace.example', 'xn--.com']) {
      expect(sub(s), s).toBeNull();
    }
  });

  it('accepts real domains, punycode included (lower-cased, www. and path stripped as before)', () => {
    expect(sub('Example.org')).toBe('example.org');
    expect(sub('https://Example.org/path')).toBe('example.org');
    expect(sub('www.my-site.co.uk')).toBe('my-site.co.uk');
    expect(sub('xn--e1afmkfd.xn--p1ai')).toBe('xn--e1afmkfd.xn--p1ai');
    expect(sub('sub.xn--bcher-kva.example')).toBe('sub.xn--bcher-kva.example');
    expect(sub('1f916.com')).toBe('1f916.com');
    expect(sub(`${'a'.repeat(63)}.example`)).toBe(`${'a'.repeat(63)}.example`);
    expect(strictPublicDomain('second.example')).toBe('second.example');
  });

  it('one trailing dot is normalized; two or more are refused (bare and with a scheme)', () => {
    expect(sub('example.com.')).toBe('example.com');
    expect(sub('https://example.com./')).toBe('example.com');
    for (const s of ['example.com..', 'example.com...', 'https://example.com../', 'example.com../path', 'www.example.com..']) expect(sub(s), s).toBeNull();
  });

  it('a bare Unicode name is converted to punycode like the same name with a scheme', () => {
    expect(sub('bücher.de')).toBe('xn--bcher-kva.de');
    expect(sub('https://bücher.de/')).toBe('xn--bcher-kva.de');
    expect(sub('BÜCHER.de')).toBe('xn--bcher-kva.de');
    expect(sub('bücher.de.')).toBe('xn--bcher-kva.de');
    expect(sub('www.bücher.de/pfad')).toBe('xn--bcher-kva.de');
    expect(sub('éxample.com')).toBe(sub('https://éxample.com'));
    expect(sub('éxample.com')).toBe('xn--xample-9ua.com');
    for (const s of ['bücher.de..', 'bücher', 'bü cher.de', 'bücher.local']) expect(sub(s), s).toBeNull();
  });

  it('IDNA dot variants (U+3002, U+FF0E, U+FF61) count as dots: one trailing is normalized, two are refused (review round 3)', () => {
    for (const dot of ['\u3002', '\uff0e', '\uff61']) {
      for (const pre of ['', 'https://']) {
        const tail = pre ? '/' : '';
        expect(sub(`${pre}example.com${dot}${tail}`), `${pre}example.com${dot}`).toBe('example.com');
        expect(sub(`${pre}bücher.de${dot}${tail}`), `${pre}bücher.de${dot}`).toBe('xn--bcher-kva.de');
        expect(sub(`${pre}example${dot}com${tail}`), `${pre}example${dot}com`).toBe('example.com');
        for (const bad of [`example.com${dot}${dot}`, `example.com${dot}${dot}${dot}`, `example.com.${dot}`, `example.com${dot}.`, `bücher.de${dot}${dot}`, `www.example.com${dot}${dot}`]) {
          expect(sub(`${pre}${bad}${tail}`), `${pre}${bad}`).toBeNull();
        }
      }
    }
    // a bare name and the same name with a scheme always agree
    for (const s of ['example.com\u3002', 'example.com\uff0e\uff0e', 'bücher.de\uff61', 'bücher.de\u3002\u3002', 'Example.ORG', 'www.bücher.de/pfad'])
      expect(sub(s), s).toBe(sub(`https://${s}`));
  });

  it('our own domains are still refused', () => {
    expect(sub('staging.commonworld.one')).toBeNull();
  });
});

/** Endless body; counts bytes handed out and whether the reader cancelled it. */
function endless(chunk = 64 * 1024) {
  const piece = new Uint8Array(chunk).fill(0x61);
  let pulled = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled += chunk; c.enqueue(piece); }, cancel() { cancelled = true; } });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

describe('3. trust lists: bodies read under a byte cap', () => {
  it('caps: about 4x the real list sizes; 1 MiB for anything else', () => {
    expect(LIST_CAPS[metamask.url]).toBe(12 * 1024 * 1024);
    expect(LIST_CAPS[scamsniffer.url]).toBe(36 * 1024 * 1024);
    expect(LIST_CAPS[certPolska.url]).toBe(10 * 1024 * 1024);
    expect(capFor(GSB_ENDPOINT + 'x.example')).toBe(DEFAULT_RESPONSE_CAP);
    expect(logSafeUrl(GSB_ENDPOINT + 'secret.example')).toBe('https://transparencyreport.google.com/transparencyreport/api/v3/safebrowsing/status');
  });

  it('cappedFetchLike: an endless body -> ok:false 413, stream cancelled at the cap, one warning without the query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = endless();
    const f = cappedFetchLike(async () => new Response(s.stream));
    const url = GSB_ENDPOINT + 'secret.example';
    const r = await f(url);
    expect(r).toMatchObject({ ok: false, status: OVER_CAP_STATUS });
    expect(await r.text()).toBe('');
    expect(s.cancelled()).toBe(true);
    expect(s.pulled()).toBeLessThanOrEqual(DEFAULT_RESPONSE_CAP + 2 * 64 * 1024);
    await cappedFetchLike(async () => new Response(endless().stream))(url);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('secret.example');
    expect(String(warn.mock.calls[0][0])).not.toContain('?');
  });

  it('link check at publish: oversized list never replaces the memo; without a memo the source gets ok:false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let mode: 'good' | 'huge' = 'huge';
    let stream = endless(256 * 1024);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      expect(urlOf(input)).toBe(certPolska.url);
      if (mode === 'good') return new Response('phish.example\n');
      stream = endless(256 * 1024);
      return new Response(stream.stream);
    }) as typeof fetch);

    // no previous copy: over the cap -> failed download, stream cancelled
    const first = await linkCheckFetch(certPolska.url);
    expect(first).toMatchObject({ ok: false, status: OVER_CAP_STATUS });
    expect(stream.cancelled()).toBe(true);
    expect(stream.pulled()).toBeLessThanOrEqual(LIST_CAPS[certPolska.url] + 2 * 256 * 1024);

    // a good copy is memoized
    mode = 'good';
    expect(await (await linkCheckFetch(certPolska.url)).text()).toBe('phish.example\n');

    // memo expired, the new download is over the cap -> the previous copy keeps answering
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    mode = 'huge';
    const stale = await linkCheckFetch(certPolska.url);
    expect(stale.ok).toBe(true);
    expect(await stale.text()).toBe('phish.example\n');
    expect(stream.cancelled()).toBe(true);
  });

  it('hourly own-domain check (default fetch): an oversized list -> that source no_data (HTTP 413), others still answer', async () => {
    await resetDb();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const big = endless(256 * 1024);
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const u = urlOf(input);
      if (u === scamsniffer.url) return new Response(big.stream);
      if (u === metamask.url) return new Response(JSON.stringify({ blacklist: ['drainer.example'] }));
      if (u === certPolska.url) return new Response('phish.example\n');
      if (u.startsWith(GSB_ENDPOINT)) return new Response(`)]}'\n[["sb.ssr",1,false,false,false,false,false,1792259421202,"x",false]]`);
      return new Response('', { status: 404 });
    }) as typeof fetch);
    const run = await runTrustCheck(env as any, Date.now(), { sleep: async () => {} });
    expect(run.flagged).toEqual([]);
    expect(big.cancelled()).toBe(true);
    expect(big.pulled()).toBeLessThanOrEqual(LIST_CAPS[scamsniffer.url] + 2 * 256 * 1024);
    const row = await env.DB.prepare("SELECT status, sources FROM trust_checks WHERE domain = 'commonworld.one'").first<{ status: string; sources: string }>();
    const sources = JSON.parse(row!.sources) as { name: string; verdict: string; error?: string }[];
    expect(sources.find((s) => s.name === 'scamsniffer')).toMatchObject({ verdict: 'no_data', error: 'HTTP 413' });
    expect(sources.find((s) => s.name === 'cert_polska')?.verdict).toBe('clean');
    expect(row!.status).toBe('clean');
  });
});
