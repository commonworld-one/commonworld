import { beforeEach, describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { resetDb } from './helpers';
import { handoffTemplate } from '../src/handoff';

beforeEach(resetDb);
const get = (path: string, init: RequestInit = {}): Promise<Response> => (exports as any).default.fetch(new Request(`https://cw.test${path}`, init));

describe('handoff public surfaces', () => {
  it('serves a local-only editor with disabled fallback, labels, script and alternate formats', async () => {
    const response = await get('/handoff');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-inline'");
    const text = await response.text();
    expect(text).toContain('<fieldset disabled>');
    expect(text).toContain('id="handoff-brief"');
    expect(text).toContain('for="handoff-next_step"');
    expect(text).toContain('/handoff.md');
    expect(text).toContain('/v1/handoff-template');
    const script = text.match(/src="([^"]*handoff[^\"]*\.js[^"]*)"/);
    expect(script).not.toBeNull();
    expect((await get(script![1])).status).toBe(200);
  });
  it('serves the Markdown twin by extension and content negotiation', async () => {
    const md = await get('/handoff.md');
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    const text = await md.text();
    expect(text).toContain('commonworld-handoff/1');
    expect(text).toContain('Reconcile uncertain operations');
    const negotiated = await get('/handoff', { headers: { Accept: 'text/markdown' } });
    expect(await negotiated.text()).toBe(text);
  });
  it('serves a blank JSON template, with no checkpoint write endpoint', async () => {
    const response = await get('/v1/handoff-template');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(handoffTemplate());
    const write = await get('/v1/handoff-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(handoffTemplate()) });
    expect(write.status).toBeGreaterThanOrEqual(400);
  });
});
