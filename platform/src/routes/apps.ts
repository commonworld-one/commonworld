/**
 * Connected apps (OAuth grants) of the calling citizen: GET /v1/me/apps and POST /v1/me/apps/{id}/revoke.
 * API key only: an OAuth token cannot list or revoke apps (src/oauth/scopes.ts OAUTH_NEVER); an app revokes its own
 * token at POST /oauth/revoke. The same list and Revoke buttons are on the /apps page for a signed-in browser.
 */
import type { Ctx } from '../context';
import { requireAuth } from '../auth';
import { HttpError, json } from '../http';
import { listApps, revokeOwnApp } from '../oauth/store';

export async function myApps(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  return json(200, { items: await listApps(c.env, p.account.id) });
}

export async function revokeMyApp(c: Ctx): Promise<Response> {
  const p = requireAuth(c.principal);
  if (!(await revokeOwnApp(c.env, p.account.id, c.params[0]))) throw new HttpError(404, 'app_not_found');
  return json(200, { revoked: true, id: c.params[0] });
}
