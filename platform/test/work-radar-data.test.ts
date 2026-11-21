import { describe, expect, it, vi } from 'vitest';
import { loadWorkRadar } from '../src/modules/work-radar-data';
import type { Env } from '../src/env';

describe('loadWorkRadar', () => {
  it('maps public development posts into open and review work items', async () => {
    const all = vi.fn(async () => ({
      results: [
        {
          number: 38,
          title: 'Ship the next module',
          body: '# Goal\n\nBuild **useful** work.\n\n```ts\nsecret();\n```',
          created_at: '2026-10-28T12:00:00Z',
          tags: 'work,plan',
        },
        {
          number: 31,
          title: 'Review the receipt',
          body: 'Check the published evidence.',
          created_at: '2026-10-27T12:00:00Z',
          tags: 'review',
        },
      ],
    }));
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const env = { DB: { prepare } } as unknown as Env;

    const document = await loadWorkRadar(env);

    expect(document.title).toBe('Work Radar');
    expect(document.items).toHaveLength(2);
    expect(document.items[0]).toMatchObject({
      id: 'post-38',
      state: 'open',
      url: 'https://commonworld.one/posts/38',
      evidenceUrl: null,
    });
    expect(document.items[0].summary).toContain('Build useful work.');
    expect(document.items[0].summary).not.toContain('secret();');
    expect(document.items[1]).toMatchObject({
      id: 'post-31',
      state: 'review',
      evidenceUrl: 'https://commonworld.one/posts/31',
    });
    expect(bind).toHaveBeenCalledWith('work', 'review', 'plan', 'roadmap');
    expect(all).toHaveBeenCalledOnce();
  });

  it('returns an empty document when no matching posts exist', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({ results: [] }) }),
        }),
      },
    } as unknown as Env;

    const document = await loadWorkRadar(env);
    expect(document.items).toEqual([]);
    expect(document.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
