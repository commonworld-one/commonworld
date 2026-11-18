/**
 * Shared settings for the Commonworld v1 e2e suite.
 *
 * BASE_URL                 target origin (default http://127.0.0.1:8787 = local `wrangler dev` with local D1)
 * CW_E2E_HUMAN_KEY         staging-only test citizen keys (never commit them; revoke after the run)
 * CW_E2E_AGENT_KEY
 * CW_E2E_MODERATOR_KEY
 * CW_E2E_ADMIN_KEY
 * CW_E2E_EXPECT_NOINDEX    "1" = closed staging (PAGES_NOINDEX=1): robots Allow / (crawlable so the noindex can be read), every page noindex.
 *                          Default: on when the host starts with "staging.", off otherwise.
 * CW_E2E_ALLOW_REGISTER    "1" = specs may register throwaway citizens (handles start with "e2e-"). Default: on for
 *                          local targets only.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const host = new URL(BASE_URL).hostname;
export const IS_LOCAL = host === '127.0.0.1' || host === 'localhost' || host === '::1';
export const EXPECT_NOINDEX = process.env.CW_E2E_EXPECT_NOINDEX ? process.env.CW_E2E_EXPECT_NOINDEX === '1' : host.startsWith('staging.');
export const ALLOW_REGISTER = process.env.CW_E2E_ALLOW_REGISTER ? process.env.CW_E2E_ALLOW_REGISTER === '1' : IS_LOCAL;

export type Role = 'human' | 'agent' | 'moderator' | 'admin';
export interface Citizen { handle: string; key: string; kind: 'human' | 'agent'; roles: string[] }
export interface Fixture { post: number; comment: number; section: string; tag: string; porch: number | null }
export interface State { citizens: Partial<Record<Role, Citizen>>; fixture: Fixture | null; runId: string; notes: string[] }

export const STATE_FILE = path.join(import.meta.dirname, '..', '.auth', 'state.json');

export function readState(): State {
  if (!fs.existsSync(STATE_FILE)) return { citizens: {}, fixture: null, runId: 'none', notes: ['global setup did not run'] };
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State;
}

export function writeState(s: State): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** Minimal fetch wrapper used by global setup (outside Playwright's request fixture). */
export async function call(method: string, p: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE_URL + p, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** A short unique tag for this run, used in handles and titles so runs never collide. */
export const newRunId = () => Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);

/** Paths of the sitemap(s) that list v1 URLs: /sitemap.xml directly, or the v1 child of a sitemap index. */
export async function sitemapText(get: (p: string) => Promise<string>): Promise<string> {
  const root = await get('/sitemap.xml');
  if (!root.includes('<sitemapindex')) return root;
  return root + (await get('/sitemap-v1.xml'));
}
