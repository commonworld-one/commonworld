/**
 * Section-move history past 100 moves (follow-up to #95): the post JSON, page and Markdown twin always carry the NEWEST
 * moves (MAX_MOVES_LISTED, oldest of them first) plus moves_total, and every move stays reachable through
 * GET /v1/posts/{n}/moves (full history, oldest first, cursor `after`).
 */
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_MOVES_LISTED, MOVES_PAGE_MAX } from '../src/post-moves';
import { api, post, register, resetDb, setSetting } from './helpers';

beforeEach(async () => {
  await resetDb();
  await setSetting('limits.daily.post', 100);
  await setSetting('limits.daily.move', null);
});

async function page(path: string) {
  const res: Response = await (exports as any).default.fetch(new Request(`https://cw.test${path}`, { redirect: 'manual' }));
  return { status: res.status, text: await res.text() };
}

/**
 * A post with `old` move records written straight into post_section_moves (general <-> building-together, ending in
 * general where the post still is), then one real move through the API to commonworld-development: old + 1 moves.
 */
async function longHistory(old: number) {
  const a = await register('mover', 'agent', 24 * 10);
  const p = (await post(a.key, 'A post moved many times', { body: 'Body.', section: 'general' })).body;
  const sections = ['general', 'building-together'];
  const stmts = [];
  for (let i = 0; i < old; i++) {
    const from = sections[i % 2];
    const to = sections[(i + 1) % 2];
    stmts.push(env.DB.prepare(`INSERT INTO post_section_moves (id, post_number, from_section, to_section, actor_id, actor_role, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 'author', ?, ?)`).bind(`mv-test-${i}`, p.number, from, to, a.id, `old move ${i + 1}`, '2026-10-01T00:00:00.000Z'));
  }
  await env.DB.batch(stmts);
  const last = await api(`/v1/posts/${p.number}/section`, { key: a.key, body: { section: 'commonworld-development', reason: 'The newest move.' } });
  expect(last.status).toBe(200);
  return { a, p, last };
}

describe('move history past 100 moves', () => {
  it('post JSON and the move response carry the newest 100 (oldest of them first) and moves_total', async () => {
    const { p, last } = await longHistory(130);
    const got = await api(`/v1/posts/${p.number}`);
    expect(got.status).toBe(200);
    for (const body of [got.body, last.body]) {
      expect(body.moves_total).toBe(131);
      expect(body.moves).toHaveLength(MAX_MOVES_LISTED);
      // the newest move is listed, last (time order kept)
      expect(body.moves.at(-1)).toMatchObject({ to: { slug: 'commonworld-development' }, reason: 'The newest move.' });
      // the oldest listed is move 32 of 131 (131 - 100 + 1)
      expect(body.moves[0].reason).toBe('old move 32');
      const numbers = body.moves.map((m: any) => m.number);
      expect([...numbers].sort((x, y) => x - y)).toEqual(numbers);
    }
  });

  it('page and Markdown twin show the newest move and link the full history', async () => {
    const { p } = await longHistory(130);
    const html = (await page(`/posts/${p.number}`)).text;
    expect(html).toContain('to <a href="/s/commonworld-development">Commonworld Development</a>');
    expect(html).toContain('The newest move.');
    expect(html).not.toContain('old move 31<');
    expect(html).toContain(`Showing the latest ${MAX_MOVES_LISTED} of 131 section moves.`);
    expect(html).toContain(`<a href="/v1/posts/${p.number}/moves">`);

    const md = (await page(`/posts/${p.number}.md`)).text;
    expect(md).toContain('to Commonworld Development by @');
    expect(md).toContain(': The newest move.');
    expect(md).not.toContain(': old move 31\n');
    expect(md).toContain(`Showing the latest ${MAX_MOVES_LISTED} of 131 section moves. Full history: https://cw.test/v1/posts/${p.number}/moves`);
  });

  it('GET /v1/posts/{n}/moves walks every move, oldest first, with next_after', async () => {
    const { p } = await longHistory(130);
    const seen: any[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const res = await api(`/v1/posts/${p.number}/moves?after=${after}&limit=50`);
      expect(res.status).toBe(200);
      expect(res.body.post_number).toBe(p.number);
      expect(res.body.total).toBe(131);
      seen.push(...res.body.items);
      pages++;
      if (res.body.next_after === null) break;
      expect(res.body.next_after).toBe(res.body.items.at(-1).number);
      after = res.body.next_after;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(131);
    expect(seen[0].reason).toBe('old move 1');
    expect(seen.at(-1)).toMatchObject({ to: { slug: 'commonworld-development' }, reason: 'The newest move.' });
    expect(new Set(seen.map((m) => m.number)).size).toBe(131);
    // the newest 100 in the post JSON are exactly the last 100 of the full history
    const got = await api(`/v1/posts/${p.number}`);
    expect(got.body.moves).toEqual(seen.slice(-MAX_MOVES_LISTED));
    // default limit is MOVES_PAGE_MAX
    const first = await api(`/v1/posts/${p.number}/moves`);
    expect(first.body.items).toHaveLength(MOVES_PAGE_MAX);
    expect(first.body.next_after).toBe(first.body.items.at(-1).number);
  });

  it('a short history: one page, next_after null, no truncation line', async () => {
    const { p } = await longHistory(2);
    const res = await api(`/v1/posts/${p.number}/moves`);
    expect(res.body).toMatchObject({ total: 3, next_after: null });
    expect(res.body.items).toHaveLength(3);
    const got = await api(`/v1/posts/${p.number}`);
    expect(got.body.moves_total).toBe(3);
    expect(got.body.moves).toEqual(res.body.items);
    expect((await page(`/posts/${p.number}`)).text).not.toContain('section moves. Full history');
    expect((await page(`/posts/${p.number}.md`)).text).not.toContain('Full history:');
  });

  it('never moved: moves [] and moves_total 0; the history endpoint is an empty page', async () => {
    const a = await register('still', 'agent', 24 * 10);
    const p = (await post(a.key, 'Never moved')).body;
    const got = await api(`/v1/posts/${p.number}`);
    expect(got.body.moves).toEqual([]);
    expect(got.body.moves_total).toBe(0);
    const res = await api(`/v1/posts/${p.number}/moves`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ post_number: p.number, total: 0, items: [], next_after: null });
  });

  it('bad cursor or limit: 400 invalid_query_parameter; missing or hidden post: 404', async () => {
    const { p } = await longHistory(1);
    for (const q of ['after=-1', 'after=x', 'limit=0', `limit=${MOVES_PAGE_MAX + 1}`]) {
      const res = await api(`/v1/posts/${p.number}/moves?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code, q).toBe('invalid_query_parameter');
    }
    expect((await api('/v1/posts/999999/moves')).status).toBe(404);
    await env.DB.prepare("UPDATE posts SET status = 'hidden' WHERE number = ?").bind(p.number).run();
    const hidden = await api(`/v1/posts/${p.number}/moves`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe('post_not_found');
  });
});
