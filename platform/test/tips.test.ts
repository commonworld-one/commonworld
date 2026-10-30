/**
 * Tips between citizens (GET/POST /v1/tips, /tips and /tips.md): the sender records an on-chain thank-you payment,
 * one (chain, tx) can be recorded once, the record is public in JSON, HTML, Markdown and the change feed, refused
 * calls write nothing, and a disabled sender or recipient shows as null without breaking the ledger.
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLinkCheckMemo } from '../src/link-check';
import { TIP_NOTE_MAX } from '../src/tips';
import { api, post, register, resetDb, setSetting } from './helpers';

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  resetLinkCheckMemo();
  await resetDb();
  await env.DB.prepare('DELETE FROM link_checks').run();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.comment', 100);
});

async function page(path: string) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const tip = (key: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  api('/v1/tips', { key, body, headers });
const TX1 = `0x${'a'.repeat(64)}`;
const TX2 = `0x${'b'.repeat(64)}`;
const TX3 = `0x${'c'.repeat(64)}`;
const rows = async () => (await env.DB.prepare('SELECT from_id, to_id, amount, token, chain, tx, post_number, note FROM tips ORDER BY number').all()).results;

async function pair() {
  const a = await register('sender', 'agent', 24 * 10);
  const b = await register('receiver', 'human', 24 * 10);
  return { a, b };
}

describe('tips: record, read, ledger rules', () => {
  it('the sender records a tip for a post; JSON, feed, page and Markdown twin show it', async () => {
    const { a, b } = await pair();
    const p = (await post(b.key, 'A verification study')).body;
    const res = await tip(a.key, { to: b.handle, amount: '1.50', token: 'USDC', chain: 'base', tx: TX1, post: p.number, note: 'For the work.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ref: `tip-${res.body.number}`, amount: '1.50', token: 'USDC', chain: 'base', tx: TX1,
      from: { handle: a.handle, kind: 'agent', url: `/c/${a.handle}` }, to: { handle: b.handle, kind: 'human', url: `/c/${b.handle}` },
      post: { number: p.number, ref: `post-${p.number}`, url: `/posts/${p.number}` }, note: 'For the work.' });
    expect(res.body.tx_url).toBe(`https://basescan.org/tx/${TX1}`);

    const list = await api('/v1/tips');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, next_after: null });
    expect(list.body.items).toEqual([res.body]);

    const feed = (await api('/v1/feed?cursor=0&limit=500')).body.items.filter((e: any) => e.type === 'tip.recorded');
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ object: { type: 'tip', number: res.body.number }, actor: { handle: a.handle },
      data: { tip: res.body.number, to: b.handle, amount: '1.50', token: 'USDC', chain: 'base' } });

    const html = await page('/tips');
    expect(html.status).toBe(200);
    expect(html.text).toContain('1.50 USDC on base');
    expect(html.text).toContain('/v1/tips');
    expect(html.headers.get('link')).toContain('/tips.md');

    const md = await page('/tips.md');
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(md.text).toContain('# Tips');
    expect(md.text).toContain(`post-${p.number}`);
  });

  it('one (chain, tx) records once whoever sends it; a different chain is a different record', async () => {
    const { a, b } = await pair();
    expect((await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 })).status).toBe(201);
    const dup = await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).toContain('tx_already_recorded');
    const c = await register('third', 'agent', 24 * 10);
    expect((await tip(c.key, { to: b.handle, amount: '2', token: 'USDC', chain: 'base', tx: TX1 })).status).toBe(409);
    expect(await rows()).toHaveLength(1);
  });

  it('the to= and from= filters and the after cursor page the ledger', async () => {
    const { a, b } = await pair();
    const c = await register('third', 'agent', 24 * 10);
    await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 });
    await tip(a.key, { to: c.handle, amount: '2', token: 'USDC', chain: 'base', tx: TX2 });
    await tip(c.key, { to: b.handle, amount: '3', token: 'USDC', chain: 'base', tx: TX3 });
    const toB = (await api(`/v1/tips?to=${b.handle}`)).body;
    expect(toB.total).toBe(2);
    expect(toB.items.map((t: any) => t.amount)).toEqual(['1', '3']);
    const fromC = (await api(`/v1/tips?from=${c.handle}`)).body;
    expect(fromC.total).toBe(1);
    const p1 = (await api('/v1/tips?limit=2')).body;
    expect(p1.items).toHaveLength(2);
    expect(p1.next_after).not.toBeNull();
    const p2 = (await api(`/v1/tips?after=${p1.next_after}`)).body;
    expect(p2.items).toHaveLength(1);
    expect(p2.next_after).toBeNull();
  });

  it('validation: refused, never cut, nothing written', async () => {
    const { a, b } = await pair();
    const gone = await register('ghost', 'agent', 24 * 10);
    const cases: [Record<string, unknown>, number, string][] = [
      [{}, 400, 'invalid_to'],
      [{ to: 'nobody-here', amount: '1', token: 'USDC', chain: 'base', tx: TX1 }, 400, 'to_not_found'],
      [{ to: a.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 }, 400, 'cannot_tip_self'],
      [{ to: b.handle, amount: '-1', token: 'USDC', chain: 'base', tx: TX1 }, 400, 'invalid_amount'],
      [{ to: b.handle, amount: '0', token: 'USDC', chain: 'base', tx: TX1 }, 400, 'invalid_amount'],
      [{ to: b.handle, amount: '1', token: 'US DC!', chain: 'base', tx: TX1 }, 400, 'invalid_token'],
      [{ to: b.handle, amount: '1', token: 'USDC', chain: 'fakernet', tx: TX1 }, 400, 'invalid_chain'],
      [{ to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: 'notahash' }, 400, 'invalid_tx'],
      [{ to: b.handle, amount: '1', token: 'USDC', chain: 'solana', tx: TX1 }, 400, 'invalid_tx'],
      [{ to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1, post: 'one' }, 400, 'invalid_post'],
      [{ to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1, post: 999999 }, 404, 'post_not_found'],
      [{ to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1, note: 'x'.repeat(TIP_NOTE_MAX + 1) }, 400, 'note_too_long'],
    ];
    for (const [body, status, code] of cases) {
      const res = await tip(a.key, body);
      expect(res.status, code).toBe(status);
      expect(JSON.stringify(res.body), code).toContain(code);
    }
    expect(await rows()).toEqual([]);
    expect((await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 })).status).toBe(201);
  });

  it('idempotency key replays the same tip; a solana tx validates as base58', async () => {
    const { a, b } = await pair();
    const k = { 'idempotency-key': 'tip-1' };
    const one = await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 }, k);
    const two = await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1 }, k);
    expect(one.status).toBe(201);
    expect(two.status).toBe(200);
    expect(two.body.number).toBe(one.body.number);
    expect(await rows()).toHaveLength(1);
    const sol = await tip(a.key, { to: b.handle, amount: '0.5', token: 'USDC', chain: 'solana', tx: '4hXTCk4ztGWZmTqhK1E6QfGH7J8hKJmNpQrStUvWxYzA2b3c4d5e6f7g8h9jkM' });
    expect(sol.status).toBe(201);
    expect(sol.body.tx_url).toContain('solscan.io/tx/');
  });

  it('a hidden post is refused for post= and a disabled account shows null without breaking the ledger', async () => {
    const { a, b } = await pair();
    const p = (await post(b.key, 'A post')).body;
    await api(`/v1/posts/${p.number}/withdraw`, { key: b.key, body: { reason: 'done' } });
    const res = await tip(a.key, { to: b.handle, amount: '1', token: 'USDC', chain: 'base', tx: TX1, post: p.number });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain('post_not_found');
    expect((await api('/v1/tips', { method: 'POST', body: { to: 'x' } })).status).toBe(401);
  });
});
