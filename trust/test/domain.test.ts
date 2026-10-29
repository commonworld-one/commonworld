import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSet, candidates, checkDomains, hostOf, listSource, metamask, normalizeDomain, oddEntries, substringHas, type FetchLike } from '../src/index.ts';

// Host normalization must give the name a browser resolves: a link that a browser takes to a listed host must be
// looked up under that host's name, never skipped.

test('normalizeDomain: IDNA label separators and percent-encoded dots become dots', () => {
  for (const sep of ['\u3002', '\uff0e', '\uff61', '%2E', '%2e', '%E3%80%82']) {
    assert.equal(normalizeDomain(`https://listed-host${sep}example/`), 'listed-host.example', JSON.stringify(sep));
    assert.equal(normalizeDomain(`listed-host${sep}example`), 'listed-host.example', `bare ${JSON.stringify(sep)}`);
  }
  assert.equal(normalizeDomain('https://sub\u3002listed-host\uff0eexample\uff61/x'), 'sub.listed-host.example');
});

test('normalizeDomain: case, trailing dots, userinfo, port, www, scheme forms', () => {
  assert.equal(normalizeDomain('HTTPS://LISTED-HOST.EXAMPLE/'), 'listed-host.example');
  assert.equal(normalizeDomain('https://listed-host.example./'), 'listed-host.example');
  assert.equal(normalizeDomain('https://listed-host.example../'), 'listed-host.example');
  assert.equal(normalizeDomain('https://listed-host.example\u3002/'), 'listed-host.example');
  assert.equal(normalizeDomain('https://user:pass@listed-host.example/'), 'listed-host.example');
  assert.equal(normalizeDomain('user:pass@listed-host.example:8443/p'), 'listed-host.example');
  assert.equal(normalizeDomain('https://listed-host.example:8443/p?q#f'), 'listed-host.example');
  assert.equal(normalizeDomain('ftp://Listed-Host.Example/'), 'listed-host.example', 'any scheme reads the host the same way');
  assert.equal(normalizeDomain('https://www.www.listed-host.example/'), 'listed-host.example');
  assert.equal(normalizeDomain('www.com'), 'www.com', 'www. is only dropped while a dot remains');
  // a backslash ends the host in a browser (special schemes), so the host is the part before it, not after the '@'
  assert.equal(normalizeDomain('listed-host.example\\@good.example'), 'listed-host.example');
  assert.equal(normalizeDomain('https://\uff4c\uff49\uff53\uff54\uff45\uff44-host.example/'), 'listed-host.example', 'full-width letters');
});

test('normalizeDomain: Unicode host -> punycode; underscore hosts are kept (blocklists list them)', () => {
  assert.equal(normalizeDomain('https://bücher.de/'), 'xn--bcher-kva.de');
  assert.equal(normalizeDomain('BÜCHER.de'), 'xn--bcher-kva.de');
  assert.equal(normalizeDomain('https://xn--bcher-kva.de/'), 'xn--bcher-kva.de');
  assert.equal(normalizeDomain('https://login_wallet.example/'), 'login_wallet.example');
});

test('normalizeDomain is idempotent', () => {
  for (const s of ['https://www.www.a.example', 'www.a.example', 'bücher.de', 'A\u3002Example.', 'www.com', 'x_y.example']) {
    const once = normalizeDomain(s);
    assert.equal(normalizeDomain(once), once, s);
  }
});

test('hostOf tells an unreadable host from a name that is not a domain', () => {
  assert.deepEqual(hostOf('https://listed-host%2Eexample/'), { domain: 'listed-host.example', status: 'domain' });
  assert.equal(hostOf('').status, 'empty');
  assert.equal(hostOf('localhost').status, 'not_a_domain');
  assert.equal(hostOf('http://intranet:3000/').status, 'not_a_domain');
  assert.equal(hostOf('https://[::1]:8080/').status, 'not_a_domain');
  for (const bad of ['bad domain.com', 'good.example%40listed-host.example', 'listed-host.example%00', '%', 'xn--zz', 'a!b.example',
    'listed-host\uff0cexample', '.listed-host.example', 'a..listed-host.example', '*.listed-host.example']) {
    assert.deepEqual(hostOf(bad), { domain: '', status: 'unreadable' }, JSON.stringify(bad));
    assert.equal(normalizeDomain(bad), '', JSON.stringify(bad));
  }
});

test('candidates read the normalized name', () => {
  assert.deepEqual(candidates('app\u3002listed-host%2Eexample'), ['app.listed-host.example', 'www.app.listed-host.example', 'listed-host.example']);
  assert.deepEqual(candidates('a!b.example'), []);
});

test('blocklist entries are compared normalized: Unicode, percent and IDNA-dot spellings, trailing dot', () => {
  const json = JSON.stringify(['Bücher.de', 'listed-host\u3002example', 'Pct%2Eexample', 'trailing.example.', 'sites.google.com/view/%e5%a6%82']);
  const f = { kind: 'json-array' } as const;
  const set = buildSet(json, f);
  for (const d of ['xn--bcher-kva.de', 'listed-host.example', 'pct.example', 'trailing.example']) assert.ok(set.has(d), d);
  assert.ok(!set.has('sites.google.com'), 'an entry with a path is never reduced to its host');
  const r = json.toLowerCase();
  assert.ok(substringHas(r, f, 'trailing.example'));
  assert.deepEqual([...oddEntries(r)].sort(), ['listed-host.example', 'pct.example', 'xn--bcher-kva.de']);
});

test('a listing written in Unicode flags the punycode lookup through both matchers', async () => {
  const body = JSON.stringify({ blacklist: ['bücher-wallet.example', 'plain.example'] });
  const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => body });
  const src = listSource({ id: 'mm', name: 'mm', covers: '', url: 'u', evidence_url: 'e', terms: '', format: { kind: 'json-array', key: 'blacklist' }, substringMax: 1 });
  const ctx = { fetch, now: () => new Date(0), sleep: async () => {}, retries: 0 };
  const puny = normalizeDomain('bücher-wallet.example');
  // one domain: substring matcher; three domains: Set matcher (substringMax 1)
  const few = await checkDomains([puny], { sources: [src], ctx });
  assert.equal(few.results[puny].status, 'flagged');
  const many = await checkDomains([puny, 'plain.example', 'fine.example'], { sources: [src], ctx });
  assert.equal(many.results[puny].status, 'flagged');
  assert.equal(many.results['plain.example'].status, 'flagged');
  assert.equal(many.results['fine.example'].status, 'clean');
  assert.ok(metamask.url);
});

test('checkDomains keys results by the normalized name of each input', async () => {
  const body = JSON.stringify({ blacklist: ['listed-host.example'] });
  const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => body });
  const src = listSource({ id: 'mm', name: 'mm', covers: '', url: 'u', evidence_url: 'e', terms: '', format: { kind: 'json-array', key: 'blacklist' } });
  const r = await checkDomains(['https://listed-host\u3002example/', 'listed-host%2Eexample'], { sources: [src], ctx: { fetch, now: () => new Date(0), sleep: async () => {}, retries: 0 } });
  assert.deepEqual(Object.keys(r.results), ['listed-host.example']);
  assert.equal(r.results['listed-host.example'].status, 'flagged');
});
