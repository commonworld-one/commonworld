/**
 * What an OAuth access token may do. One rule, used by the /v1 router (src/index.ts, the single enforcement point:
 * every MCP platform tool is forwarded there) and by the MCP server for tools/list and an early, spec-shaped 403.
 *
 *   GET operations                          scope `read` (`write` includes `read`)
 *   other operations                        scope `write`
 *   staff and admin operations              never (OAuth principals also carry no roles at all: src/auth.ts)
 *   OAUTH_NEVER (account credentials)       never: only the citizen's own API key (or the website session) may rotate the
 *                                           key, mint a sign-in link or recovery code, list or link identities (they can recover
 *                                           the account; a pending link carries its challenge code), request deletion, register
 *                                           or recover accounts, or manage connected apps
 */
import type { Principal } from '../auth';
import { HttpError } from '../http';
import { OPERATIONS, type Operation } from '../openapi';
import type { Scope } from './config';

export const OAUTH_NEVER: ReadonlySet<string> = new Set([
  'POST /v1/accounts',
  'POST /v1/keys/rotate',
  'POST /v1/auth/login-link',
  'POST /v1/me/deletion-request',
  // recovery data: pending links carry their challenge code (Codex HOLD P0); verified links stay public on the profile
  'GET /v1/me/identities',
  'POST /v1/me/identities',
  'POST /v1/me/identities/{id}/verify',
  'POST /v1/me/identities/{id}/remove',
  'POST /v1/me/recovery-code',
  'POST /v1/recovery',
  'POST /v1/recovery/{number}/check',
  'POST /v1/recovery/{number}/claim',
  'GET /v1/me/apps',
  'POST /v1/me/apps/{id}/revoke',
  'GET /v1/me/export',
  'POST /v1/csp-report',
]);

const OP_BY_KEY = new Map(OPERATIONS.map((op) => [`${op.method} ${op.path}`, op]));

export type OAuthNeed = Scope | 'never';

export function oauthNeed(op: Pick<Operation, 'method' | 'path' | 'auth'>): OAuthNeed {
  if (op.auth === 'staff' || op.auth === 'admin' || OAUTH_NEVER.has(`${op.method} ${op.path}`)) return 'never';
  return op.method === 'GET' ? 'read' : 'write';
}

export const hasScope = (granted: readonly string[], need: Scope): boolean => granted.includes(need) || (need === 'read' && granted.includes('write'));

/** null = allowed for this OAuth principal; otherwise what is missing. */
export function oauthProblem(principal: Principal, method: string, path: string): { need: OAuthNeed } | null {
  if (!principal.oauth) return null;
  const op = OP_BY_KEY.get(`${method} ${path}`);
  const need: OAuthNeed = op ? oauthNeed(op) : 'never';
  if (need === 'never' || !hasScope(principal.oauth.scopes, need)) return { need };
  return null;
}

/** 403 for a /v1 route an OAuth token may not use (RFC 6750 3.1 insufficient_scope with the scope that would do). */
export function oauthRouteError(need: OAuthNeed, resourceMetadata: string): HttpError {
  if (need === 'never') {
    return new HttpError(403, 'not_available_via_oauth', { detail: 'Connected apps never get staff powers or account-credential operations; use your own API key for this.' });
  }
  return new HttpError(403, 'insufficient_scope', { required_scope: need },
    { 'www-authenticate': `Bearer error="insufficient_scope", scope="${need}", resource_metadata="${resourceMetadata}"` });
}
