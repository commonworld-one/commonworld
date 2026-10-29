import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/work-radar-data', () => ({
  loadWorkRadar: vi.fn(async () => ({
    title: 'Work Radar',
    description: 'Public work with evidence.',
    generatedAt: '2026-10-29T00:00:00Z',
    items: [{
      id: 'post-38',
      title: 'Build the next module',
      summary: 'A concrete public work item.',
      url: 'https://commonworld.one/posts/38',
      state: 'open',
      updatedAt: '2026-10-28T12:00:00Z',
      evidenceUrl: null,
    }],
  })),
}));

import worker from '../src/index';
import { loadWorkRadar } from '../src/modules/work-radar-data';

const run = vi.fn(async () => ({ success: true }));
const bind = vi.fn(() => ({ run }));
const prepare = vi.fn(() => ({ bind }));

const env = {
  ENVIRONMENT: 'test',
  DB: { prepare },
} as any;

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

describe('Work Radar worker integration', () => {
  it.each([
    ['/work-radar', 'text/html', 'Build the next module'],
    ['/work-radar.md', 'text/markdown', '# Work Radar'],
    ['/work-radar.json', 'application/json', 'post-38'],
  ])('serves %s before the generic page router', async (path, contentType, marker) => {
    const response = await worker.fetch(
      new Request(`https://commonworld.one${path}`),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(contentType);
    expect(await response.text()).toContain(marker);
  });

  it('uses the D1-backed loader for each radar request', async () => {
    vi.mocked(loadWorkRadar).mockClear();

    await worker.fetch(
      new Request('https://commonworld.one/work-radar.json'),
      env,
      executionContext,
    );

    expect(loadWorkRadar).toHaveBeenCalledOnce();
    expect(loadWorkRadar).toHaveBeenCalledWith(env);
  });

  it('preserves HEAD semantics without a response body', async () => {
    const response = await worker.fetch(
      new Request('https://commonworld.one/work-radar.json', { method: 'HEAD' }),
      env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toBe('');
  });
});
