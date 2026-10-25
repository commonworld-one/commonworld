/**
 * Bounties: the public record of paid work (GET /v1/bounties, /v1/bounties/{n}, the /bounties pages and their
 * Markdown twins) and the admin writes that feed it. The rules under test: only admins write, every write is public
 * (feed event + staff action log) and lands in one batch, a transaction is recorded once, amounts stay exact.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { api, makeAdmin, post, register, resetDb } from './helpers';
import { formatAtomic } from '../src/bounties';

// numbers restart at 1 in every test (resetDb empties the tables; AUTOINCREMENT keeps its counter otherwise)
beforeEach(async () => {
  await resetDb();
  await env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('bounties', 'bounty_payouts')").run();
});

async function page(path: string, init: RequestInit = {}) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual', ...init }));
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const FUNDER = '0x1D9BEDC96C2A473EEAA2055162294D3E0EB6CACC';
const PAYEE = '0x40f100ccCF51EEA928a3f314fB6ab63Bf8fa51F3';
const TX = '0x' + 'ab'.repeat(32);
const TX2 = '0x' + 'cd'.repeat(32);

const bountyBody = (extra: Record<string, unknown> = {}) => ({
  title: 'Build a new module', task_url: 'https://1f916.ai/api/listings/63', amount_atomic: '1000000', funder_address: FUNDER,
  closes_at: '2026-10-30T22:25:00Z', ...extra,
});
const payoutBody = (extra: Record<string, unknown> = {}) => ({
  payee: 'nathanielc3d (1f916)', payee_address: PAYEE, amount_atomic: '1000000', tx_hash: TX, paid_at: '2026-10-24T12:00:00Z',
  work_url: 'https://github.com/commonworld-one/commonworld/pull/1', ...extra,
});

async function createBounty(key: string, extra: Record<string, unknown> = {}) {
  const res = await api('/v1/admin/bounties', { key, body: bountyBody(extra) });
  expect(res.status).toBe(201);
  return res.body;
}

describe('formatAtomic', () => {
  it('is exact for whole, fractional and tiny amounts', () => {
    expect(formatAtomic('1000000', 6)).toBe('1');
    expect(formatAtomic('1500000', 6)).toBe('1.5');
    expect(formatAtomic('1', 6)).toBe('0.000001');
    expect(formatAtomic('999999999999999', 6)).toBe('999999999.999999');
  });
});

describe('admin writes', () => {
  it('only admins write: no key, a citizen and a moderator are refused', async () => {
    const citizen = await register('bounty-citizen', 'agent', 24 * 10);
    const mod = await register('bounty-mod', 'human', 24 * 10);
    await env.DB.prepare("INSERT INTO account_roles (account_id, role, granted_at) VALUES (?, 'moderator', ?)").bind(mod.id, new Date().toISOString()).run();
    expect((await api('/v1/admin/bounties', { body: bountyBody() })).status).toBe(401);
    expect((await api('/v1/admin/bounties', { key: citizen.key, body: bountyBody() })).status).toBe(403);
    expect((await api('/v1/admin/bounties', { key: mod.key, body: bountyBody() })).status).toBe(403);
    const admin = await makeAdmin();
    const b = await createBounty(admin.key);
    for (const key of [citizen.key, mod.key]) {
      expect((await api(`/v1/admin/bounties/${b.number}/status`, { key, body: { status: 'closed' } })).status).toBe(403);
      expect((await api(`/v1/admin/bounties/${b.number}/payouts`, { key, body: payoutBody() })).status).toBe(403);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bounty_payouts').first<{ n: number }>())!.n).toBe(0);
  });

  it('creates a bounty with defaults (Base USDC), a public event and a staff log entry', async () => {
    const admin = await makeAdmin();
    const author = await register('bounty-author', 'agent', 24 * 10);
    const p = await post(author.key, 'Roadmap');
    const b = await createBounty(admin.key, { post: p.body.number });
    expect(b).toMatchObject({
      number: 1, ref: 'bounty-1', url: '/bounties/1', title: 'Build a new module', status: 'open', task_url: 'https://1f916.ai/api/listings/63',
      announced_in: { number: p.body.number, ref: `post-${p.body.number}`, url: `/posts/${p.body.number}` },
      amount_atomic: '1000000', amount: '1', token: 'USDC', token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6,
      chain: { id: 8453, name: 'Base' }, funder_address: FUNDER.toLowerCase(), funder_url: `https://basescan.org/address/${FUNDER.toLowerCase()}`,
      closes_at: '2026-10-30T22:25:00.000Z', payouts_count: 0, paid_atomic: '0', paid: '0', payouts: [],
      created_by: { handle: admin.handle },
    });
    const feed = (await api('/v1/feed')).body.items.filter((e: any) => e.type === 'bounty.created');
    expect(feed).toHaveLength(1);
    expect(feed[0].object).toEqual({ type: 'bounty', number: 1, ref: 'bounty-1' });
    expect(feed[0].data).toMatchObject({ title: 'Build a new module', amount_atomic: '1000000', token: 'USDC', chain_id: 8453 });
    const log = await env.DB.prepare("SELECT action, target_ref FROM moderation_actions WHERE target_type = 'bounty'").all<any>();
    expect(log.results).toEqual([{ action: 'bounty.create', target_ref: 'bounty-1' }]);
  });

  it('refuses invalid fields with a precise code and writes nothing', async () => {
    const admin = await makeAdmin();
    const author = await register('bounty-hider', 'agent', 24 * 10);
    const hidden = await post(author.key, 'Hidden one');
    await api(`/v1/admin/content/post/${hidden.body.number}/hide`, { key: admin.key, body: { rule: 2, note: 'spam' } });
    const cases: [Record<string, unknown>, string][] = [
      [{ surprise: 1 }, 'unknown_field'],
      [{ title: '' }, 'invalid_title'],
      [{ title: 'x'.repeat(161) }, 'title_too_long'],
      [{ task_url: 'http://example.com' }, 'invalid_task_url'],
      [{ task_url: 'https://user:pw@example.com' }, 'invalid_task_url'],
      [{ amount_atomic: 1000000 }, 'invalid_amount_atomic'],
      [{ amount_atomic: '0' }, 'invalid_amount_atomic'],
      [{ amount_atomic: '1.5' }, 'invalid_amount_atomic'],
      [{ amount_atomic: '1'.repeat(16) }, 'invalid_amount_atomic'],
      [{ funder_address: '0x123' }, 'invalid_funder_address'],
      [{ chain_id: 1 }, 'unsupported_chain'],
      [{ token: 'DAI' }, 'unsupported_token'],
      [{ closes_at: '2026-10-30' }, 'invalid_closes_at'],
      [{ post: 'one' }, 'invalid_post'],
      [{ post: 9999 }, 'post_not_found'],
      [{ post: hidden.body.number }, 'post_not_found'],
    ];
    for (const [extra, code] of cases) {
      const res = await api('/v1/admin/bounties', { key: admin.key, body: bountyBody(extra) });
      expect([400, 404]).toContain(res.status);
      expect(res.body.error.code, JSON.stringify(extra)).toBe(code);
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bounties').first<{ n: number }>())!.n).toBe(0);
    expect((await api('/v1/feed')).body.items.filter((e: any) => e.type.startsWith('bounty.'))).toHaveLength(0);
  });

  it('sets the status (same status is a no-op) and logs the change', async () => {
    const admin = await makeAdmin();
    const b = await createBounty(admin.key);
    const same = await api(`/v1/admin/bounties/${b.number}/status`, { key: admin.key, body: { status: 'open' } });
    expect(same.status).toBe(200);
    const closed = await api(`/v1/admin/bounties/${b.number}/status`, { key: admin.key, body: { status: 'closed', reason: 'deadline passed' } });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect((await api(`/v1/admin/bounties/${b.number}/status`, { key: admin.key, body: { status: 'done' } })).body.error.code).toBe('invalid_status');
    expect((await api('/v1/admin/bounties/99/status', { key: admin.key, body: { status: 'closed' } })).status).toBe(404);
    const events = (await api('/v1/feed')).body.items.filter((e: any) => e.type === 'bounty.status');
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ from: 'open', to: 'closed', reason: 'deadline passed' });
  });

  it('records a payout: bounty becomes paid, totals are exact, the transaction links the explorer', async () => {
    const admin = await makeAdmin();
    const b = await createBounty(admin.key, { amount_atomic: '1500000' });
    const res = await api(`/v1/admin/bounties/${b.number}/payouts`, { key: admin.key, body: payoutBody({ amount_atomic: '1500000', tx_hash: TX.toUpperCase().replace('0X', '0x') }) });
    expect(res.status).toBe(201);
    expect(res.body.payout).toMatchObject({
      number: 1, ref: 'payout-1', url: '/bounties/1#payout-1', bounty: { number: 1, ref: 'bounty-1' }, payee: 'nathanielc3d (1f916)',
      payee_address: PAYEE.toLowerCase(), amount: '1.5', token: 'USDC', tx_hash: TX, tx_url: `https://basescan.org/tx/${TX}`,
      paid_at: '2026-10-24T12:00:00.000Z', recorded_by: { handle: admin.handle },
    });
    expect(res.body.bounty).toMatchObject({ status: 'paid', payouts_count: 1, paid_atomic: '1500000', paid: '1.5' });
    const list = (await api('/v1/bounties')).body;
    expect(list.counts).toEqual({ total: 1, open: 0, closed: 0, paid: 1, cancelled: 0 });
    expect(list.paid_out).toEqual([{ chain: { id: 8453, name: 'Base' }, token: 'USDC', amount_atomic: '1500000', amount: '1.5', payouts: 1, payees: 1 }]);
    const ev = (await api('/v1/feed')).body.items.find((e: any) => e.type === 'bounty.paid');
    expect(ev.data).toMatchObject({ payout: 1, payee: 'nathanielc3d (1f916)', amount_atomic: '1500000', token: 'USDC', chain_id: 8453, tx_hash: TX });
    const log = await env.DB.prepare("SELECT action FROM moderation_actions WHERE target_type = 'bounty' ORDER BY number").all<any>();
    expect(log.results.map((r: any) => r.action)).toEqual(['bounty.create', 'bounty.payout']);
  });

  it('refuses a duplicate transaction, a cancelled bounty, a future date and bad fields', async () => {
    const admin = await makeAdmin();
    const a = await createBounty(admin.key);
    const b = await createBounty(admin.key, { title: 'Second' });
    expect((await api(`/v1/admin/bounties/${a.number}/payouts`, { key: admin.key, body: payoutBody() })).status).toBe(201);
    const dup = await api(`/v1/admin/bounties/${b.number}/payouts`, { key: admin.key, body: payoutBody() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_tx');
    await api(`/v1/admin/bounties/${b.number}/status`, { key: admin.key, body: { status: 'cancelled' } });
    const cancelled = await api(`/v1/admin/bounties/${b.number}/payouts`, { key: admin.key, body: payoutBody({ tx_hash: TX2 }) });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('bounty_cancelled');
    const future = new Date(Date.now() + 3600_000).toISOString();
    const cases: [Record<string, unknown>, string][] = [
      [{ paid_at: future }, 'invalid_paid_at'],
      [{ tx_hash: '0x1234' }, 'invalid_tx_hash'],
      [{ payee_address: 'nope' }, 'invalid_payee_address'],
      [{ payee: '' }, 'invalid_payee'],
      [{ work_url: 'javascript:alert(1)' }, 'invalid_work_url'],
      [{ note: 'x' }, 'unknown_field'],
    ];
    for (const [extra, code] of cases) {
      const res = await api(`/v1/admin/bounties/${a.number}/payouts`, { key: admin.key, body: payoutBody({ tx_hash: TX2, ...extra }) });
      expect(res.status).toBe(400);
      expect(res.body.error.code, JSON.stringify(extra)).toBe(code);
    }
    expect((await api('/v1/admin/bounties/99/payouts', { key: admin.key, body: payoutBody({ tx_hash: TX2 }) })).status).toBe(404);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM bounty_payouts').first<{ n: number }>())!.n).toBe(1);
  });
});

describe('public reads', () => {
  it('lists newest first with status filter and paging; 404 and 400 are precise', async () => {
    const admin = await makeAdmin();
    for (let i = 1; i <= 3; i++) await createBounty(admin.key, { title: `Task ${i}` });
    await api('/v1/admin/bounties/2/status', { key: admin.key, body: { status: 'closed' } });
    const all = (await api('/v1/bounties?limit=2')).body;
    expect(all.items.map((b: any) => b.number)).toEqual([3, 2]);
    expect(all.next_before).toBe(2);
    expect((await api('/v1/bounties?before=2')).body.items.map((b: any) => b.number)).toEqual([1]);
    expect((await api('/v1/bounties?status=closed')).body.items.map((b: any) => b.number)).toEqual([2]);
    const bad = await api('/v1/bounties?status=done');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_query_parameter');
    const missing = await api('/v1/bounties/42');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('bounty_not_found');
    expect((await api('/v1/bounties/1')).body.payouts).toEqual([]);
  });
});

describe('pages and Markdown twins', () => {
  it('renders /bounties and /bounties/{n} with payments, and the same records in Markdown', async () => {
    const admin = await makeAdmin();
    const b = await createBounty(admin.key, { title: 'Ledger <module>' });
    await api(`/v1/admin/bounties/${b.number}/payouts`, { key: admin.key, body: payoutBody() });
    const list = await page('/bounties');
    expect(list.status).toBe(200);
    expect(list.text).toContain('<h1>Bounties</h1>');
    expect(list.text).toContain('href="/bounties/1"');
    expect(list.text).toContain('Ledger &lt;module&gt;');
    expect(list.text).not.toContain('Ledger <module>');
    expect(list.text).toContain('rel="alternate" type="text/markdown"');
    expect(list.text).toContain('aria-label="Public record"');
    const one = await page('/bounties/1');
    expect(one.status).toBe(200);
    expect(one.text).toContain('id="payout-1"');
    expect(one.text).toContain(`https://basescan.org/tx/${TX}`);
    expect(one.text).toContain('1 USDC');
    const md = await page('/bounties.md');
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.text).toContain('[bounty-1](https://cw.test/bounties/1)');
    expect(md.text).toContain('Paid out: 1 USDC on Base (1 payments, 1 payees)');
    const oneMd = await page('/bounties/1.md');
    expect(oneMd.status).toBe(200);
    expect(oneMd.text).toContain(`tx [${TX}](https://basescan.org/tx/${TX})`);
    expect(oneMd.text).toContain('to nathanielc3d (1f916)');
    const viaAccept = await page('/bounties/1', { headers: { accept: 'text/markdown' } });
    expect(viaAccept.headers.get('content-type')).toContain('text/markdown');
  });

  it('answers 404 in every format for a missing bounty, noindex for filtered lists, and lists /bounties in the sitemap', async () => {
    expect((await page('/bounties/7')).status).toBe(404);
    expect((await page('/bounties/7.md')).status).toBe(404);
    const empty = await page('/bounties');
    expect(empty.status).toBe(200);
    expect(empty.text).toContain('No bounties yet.');
    const filtered = await page('/bounties?status=paid');
    expect(filtered.text).toMatch(/<meta name="robots" content="noindex/);
    expect((await page('/sitemap-v1.xml')).text).toContain('https://cw.test/bounties</loc>');
  });
});
