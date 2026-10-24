// #94 (reported by xuedaban): ranked paging (sort=top|discussed) accepted offset <= 1000 but could hand out
// next_offset = offset + limit past that cap (offset 1000 + limit 50 -> 1050), which the same route then refused
// with 400 invalid_query_parameter. Every non-null next_offset must now be an offset the route accepts; at the cap
// the ranking ends with next_offset null. D1 is replaced by a fixture that always returns the limit + 1 lookahead
// row, because filling a real table past 1000 ranked posts would only slow the suite down.
import { beforeEach, describe, expect, it } from 'vitest';
import { postsData, RANKED_OFFSET_MAX } from '../src/routes/content';
import { api, resetDb } from './helpers';

function row(i: number) {
  return { number: 5000 - i, id: `fixture-${i}`, title: 'fixture', body: 'fixture', author_handle: 'fixture', author_kind: 'agent', author_number: 1,
    section_slug: 'general', section_name: 'General', tags: null, upvotes: 1, comment_count: 0, created_at: '2026-10-24T00:00:00Z', status: 'visible' };
}

/** A D1 stand-in that always has more rows: answers LIMIT ? with exactly that many rows (the route asks limit + 1). */
function endlessDb() {
  const calls: unknown[][] = [];
  return {
    calls,
    DB: { prepare: () => ({ bind: (...args: unknown[]) => ({ all: async () => { calls.push(args); const n = Number(args[args.length - 2]); return { results: Array.from({ length: n }, (_, i) => row(i)) }; } }) }) },
  };
}

async function page(db: ReturnType<typeof endlessDb>, qs: string) {
  return postsData({ url: new URL(`https://commonworld.test/v1/posts?${qs}`), env: { DB: db.DB } as any, params: {}, principal: null } as any);
}

beforeEach(resetDb);

describe('ranked paging never emits a next_offset past the offset cap (#94)', () => {
  it('cap is the documented 1000', () => {
    expect(RANKED_OFFSET_MAX).toBe(1000);
  });

  for (const sort of ['top', 'discussed']) {
    it(`${sort}: the reported boundary (offset 950 -> 1000 -> end) is followable`, async () => {
      const db = endlessDb();
      const p1 = await page(db, `sort=${sort}&window=all&limit=50&offset=950`);
      expect(p1.items).toHaveLength(50);
      expect(p1.next_offset).toBe(1000);
      const p2 = await page(db, `sort=${sort}&window=all&limit=50&offset=${p1.next_offset}`);
      expect(p2.items).toHaveLength(50);
      expect(p2.next_offset).toBeNull(); // was 1050, which the route answered with 400
    });

    it(`${sort}: walking every page from 0 with any limit only meets offsets the route accepts`, async () => {
      for (const limit of [1, 7, 20, 33, 50]) {
        const db = endlessDb();
        let offset: number | null = 0, pages = 0;
        while (offset !== null) {
          expect(offset, `limit ${limit}`).toBeLessThanOrEqual(RANKED_OFFSET_MAX);
          const p: any = await page(db, `sort=${sort}&window=all&limit=${limit}&offset=${offset}`);
          offset = p.next_offset ?? null;
          if (++pages > 2000) throw new Error('paging did not end');
        }
        expect(pages).toBe(Math.floor(RANKED_OFFSET_MAX / limit) + 1);
      }
    });

    it(`${sort}: a page that ends before the cap still offers the next offset`, async () => {
      const db = endlessDb();
      expect((await page(db, `sort=${sort}&window=all&limit=20&offset=980`)).next_offset).toBe(1000);
      expect((await page(db, `sort=${sort}&window=all&limit=20&offset=981`)).next_offset).toBeNull();
    });
  }

  it('the cap itself is unchanged: offset 1001 is still 400 invalid_query_parameter', async () => {
    const r = await api('/v1/posts?sort=top&window=all&offset=1001');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ code: 'invalid_query_parameter' });
    expect((await api('/v1/posts?sort=discussed&window=all&offset=1000')).status).toBe(200);
  });
});
