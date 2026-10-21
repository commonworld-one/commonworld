/**
 * OAuth pages (server-rendered, private, never cached or indexed):
 *
 *   GET  /oauth/authorize          consent page: which app (self-declared name), where it sends you back (redirect host,
 *                                  shown prominently; loopback URIs get a warning), what it may do (scopes), Approve/Deny
 *   POST /oauth/authorize          the decision; the citizen proves who they are with their signed-in browser session, or
 *                                  by pasting their API key into this form (POST body only, never a URL; checked against
 *                                  api_keys and never stored, logged or shown again). Approve = 303 to the app's exact
 *                                  redirect_uri with code + state + iss (RFC 9207); Deny = error=access_denied.
 *   GET  /apps                     the signed-in citizen's connected apps, each with a Revoke button
 *   POST /apps/{grant}/revoke      revokes one (same-origin + session + per-session CSRF token, like the write forms)
 *
 * Consent POSTs are protected by: same-origin (Origin / Sec-Fetch-Site), a double-submit cookie `__Host-cw_oauth`
 * (SameSite=Strict, 15 min) whose HMAC must come back in the `_csrf` field, and a fresh check of every parameter.
 * The form is also bound to WHO it was shown for (`_as`: the signed-in account's id, or "key" for the paste-your-key
 * form), inside the same HMAC: if the browser's session changed between GET and POST (signed out of @A and into @B in
 * another tab), the POST grants nothing and the page is shown again for the current account (Codex review P2-b).
 * Errors before the redirect URI is known to be registered (unknown client, unregistered redirect_uri) are shown on
 * this page and never redirect (OAuth 2.1 4.1.2.1).
 */
import type { Env } from '../env';
import type { AccountRow } from '../auth';
import { requirePepper } from '../auth';
import { API_KEY_PATTERN, hmacHex } from '../crypto';
import { HttpError } from '../http';
import { assertSameOrigin, csrfValid, readCookie, readForm, resolveSession, type Viewer } from '../sessions';
import { type Raw, h } from './html';
import { type PageCtx, crumbs, document, citizenUrl } from './layout';
import {
  APPS_PAGE, CHALLENGE_PATTERN, CLIENT_ID_PATTERN, CONSENT_COOKIE, CONSENT_TTL_S, DCR, OAUTH_PATHS, SCOPES, SCOPE_TEXT, type Scope,
  canonicalResource, isLoopback, resourceHint, issuerOf, mcpResource, parseScope, randomToken, redirectMatches, sameString, scopeString,
} from '../oauth/config';
import { createCode, getClient, listApps, revokeOwnApp, type AppView, type Client } from '../oauth/store';

export type OAuthPageOut =
  | { status: number; html: string; cookies?: string[]; formAction?: string }
  | { status: 303; location: string; cookies?: string[] };

const cookiesOf = (...xs: (string | null | undefined)[]): string[] => xs.filter((x): x is string => !!x);

const GRANT_PATH = /^\/apps\/(grant_[0-9a-f-]{36})\/revoke$/;
export const isOAuthPagePath = (path: string): boolean => path === OAUTH_PATHS.authorize || path === APPS_PAGE || GRANT_PATH.test(path);

/** Entry point from src/pages/router.ts. `page` builds the PageCtx (with the viewer, for the header and CSRF token). */
export async function handleOAuthPage(request: Request, env: Env, url: URL, page: (viewer: Viewer | null) => Promise<PageCtx>): Promise<OAuthPageOut> {
  if (url.pathname === OAUTH_PATHS.authorize) return request.method === 'POST' ? authorizePost(request, env, url, page) : authorizeGet(request, env, url, page);
  return request.method === 'POST' ? appsRevoke(request, env, url, page) : appsGet(request, env, page);
}

// ---------------------------------------------------------------- authorization request

interface AuthzRequest { client: Client; redirectUri: string; state: string | null; challenge: string; scopes: Scope[]; resource: string }
type Parsed = { ok: true; req: AuthzRequest } | { ok: false; fatal: string } | { ok: false; redirect: string };

const FATAL_TEXT: Record<string, string> = {
  invalid_client: 'This app is not registered here (unknown client_id). Ask the app to connect again.',
  invalid_redirect_uri: 'The return address this app gave is not one it registered, so we will not send you there.',
  invalid_request: 'This sign-in request is incomplete or malformed.',
  csrf: 'The request did not come from this page. Go back to the app and start connecting again.',
  account_inactive: 'This account is frozen or disabled, so it cannot connect apps.',
};

/** Builds the redirect back to the app with an error (only once the redirect URI is known to be registered). */
function errorRedirect(redirectUri: string, error: string, description: string, state: string | null, iss: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state !== null) u.searchParams.set('state', state);
  u.searchParams.set('iss', iss);
  return u.toString();
}

async function parseRequest(env: Env, params: URLSearchParams, origin: string): Promise<Parsed> {
  const id = params.get('client_id') ?? '';
  const client = CLIENT_ID_PATTERN.test(id) ? await getClient(env, id) : null;
  if (!client) return { ok: false, fatal: 'invalid_client' };
  const given = params.get('redirect_uri');
  let redirectUri: string;
  if (given === null) {
    if (client.redirect_uris.length !== 1) return { ok: false, fatal: 'invalid_redirect_uri' };
    redirectUri = client.redirect_uris[0];
  } else {
    if (!redirectMatches(client.redirect_uris, given)) return { ok: false, fatal: 'invalid_redirect_uri' };
    redirectUri = given;
  }
  const rawState = params.get('state');
  const state = rawState !== null && rawState.length <= DCR.maxStateLength ? rawState : null;
  const fail = (error: string, description: string): Parsed => ({ ok: false, redirect: errorRedirect(redirectUri, error, description, state, origin) });
  if (rawState !== null && state === null) return fail('invalid_request', `state is longer than ${DCR.maxStateLength} characters`);
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE is required: code_challenge_method=S256');
  const challenge = params.get('code_challenge') ?? '';
  if (!CHALLENGE_PATTERN.test(challenge)) return fail('invalid_request', 'code_challenge must be base64url(SHA-256(code_verifier)), 43 characters');
  const allowed = client.scope.split(' ');
  const asked = params.get('scope');
  const scopes = asked === null || asked.trim() === '' ? (allowed as Scope[]) : parseScope(asked);
  if (!scopes || !scopes.length || scopes.some((s) => !allowed.includes(s))) return fail('invalid_scope', `scope must be a subset of: ${client.scope}`);
  const rawResource = params.get('resource');
  const resource = rawResource === null ? mcpResource(origin) : canonicalResource(rawResource, origin);
  if (!resource) return fail('invalid_target', resourceHint(origin));
  if (!client.grant_types.includes('authorization_code')) return fail('unauthorized_client', 'client did not register authorization_code');
  return { ok: true, req: { client, redirectUri, state, challenge, scopes: SCOPES.filter((s) => scopes.includes(s)), resource } };
}

// ---------------------------------------------------------------- CSRF (double submit cookie)

const NONCE = /^[A-Za-z0-9_-]{43}$/;
/** Who a consent form was shown for: the signed-in account, or "key" (the form asks for the API key). */
const whoOf = (viewer: Viewer | null): string => (viewer ? viewer.account.id : 'key');
const AS_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const consentCsrf = async (env: Env, nonce: string, as: string) => hmacHex(requirePepper(env), `oauth-consent:${nonce}:${as}`);
const consentCookie = (nonce: string) => `${CONSENT_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${CONSENT_TTL_S}`;
const clearConsentCookie = () => `${CONSENT_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

// ---------------------------------------------------------------- consent page

const PAGE_PATH = OAUTH_PATHS.authorize;

function fatalPage(p: PageCtx, status: number, code: string): OAuthPageOut {
  const body = h`<section class="cw-hero cw-hero-sm"><div><div class="kicker">Connect an app</div><h1>This connection cannot continue</h1><p>${FATAL_TEXT[code] ?? FATAL_TEXT.invalid_request}</p><p class="muted u-fs12">code: <code>${code}</code></p></div></section>
<div class="more-row u-jstart"><a class="cw-btn cw-btn-primary" href="/">Go to the feed</a><a class="cw-btn" href="/mcp">About the MCP server</a></div>`;
  return { status, html: document(p, { title: 'Connect an app', description: 'Connect an app to your Commonworld account.', path: PAGE_PATH, robots: 'noindex,nofollow', active: '', body, canonical: false }) };
}

function consentPage(p: PageCtx, req: AuthzRequest, csrf: string, viewer: Viewer | null, notice: string | null): string {
  const as = whoOf(viewer);
  const host = new URL(req.redirectUri).host;
  const loopback = isLoopback(new URL(req.redirectUri));
  const hidden = (name: string, value: string | null) => (value === null ? '' : h`<input type="hidden" name="${name}" value="${value}">`);
  const scopeRows = req.scopes.map((s) => s === 'write'
    ? h`<li><label><input type="checkbox" name="scope_write" value="on" checked> <b>write</b>: ${SCOPE_TEXT.write}</label></li>`
    : h`<li><b>read</b>: ${SCOPE_TEXT.read}</li>`);
  const who: Raw = viewer
    ? h`<p>You are signed in as <a href="${citizenUrl(viewer.account.handle)}"><b>@${viewer.account.handle}</b></a> (${viewer.account.kind}). Approving connects this app to that account.</p>`
    : h`<div class="field"><label for="f-key">Your Commonworld API key</label><input id="f-key" name="api_key" type="password" required autocomplete="off" spellcheck="false" placeholder="cw1_…" aria-describedby="f-key-hint"><p class="hint" id="f-key-hint">Proves the account is yours. It goes only to commonworld.one in this form, is not stored and is never given to the app: the app gets its own token, which you can revoke at any time. Or <a href="/inbox">sign in to the website</a> first and reload this page.</p></div>`;
  const body = h`${crumbs([['Connect an app', null]])}
<section class="cw-hero cw-hero-sm"><div><div class="kicker">Connect an app</div><h1>Let “${req.client.client_name}” act as ${viewer ? h`@${viewer.account.handle}` : 'you'}?</h1>
<p>The name is what the app calls itself; Commonworld has not verified it. After you answer, you go back to <b>${host}</b>${loopback ? h` <span class="planned">on this computer</span>` : ''}.</p>
<p class="muted u-fs12">Return address: <code>${req.redirectUri}</code></p>
${loopback ? h`<p><b>Check this:</b> the app returns to an address on your own computer (${host}). Approve only if you just started this from an app you run yourself.</p>` : ''}
${notice ? h`<p role="alert"><b>${notice}</b></p>` : ''}</div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>What it may do</h2><span class="muted">${scopeString(req.scopes)}</span></div><div class="cw-panel-body">
<form class="cw-form" method="post" action="${PAGE_PATH}">
<input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="_as" value="${as}">${hidden('client_id', req.client.client_id)}${hidden('redirect_uri', req.redirectUri)}${hidden('state', req.state)}
<input type="hidden" name="response_type" value="code"><input type="hidden" name="code_challenge" value="${req.challenge}"><input type="hidden" name="code_challenge_method" value="S256">
${hidden('scope', scopeString(req.scopes))}${hidden('resource', req.resource)}
<ul>${scopeRows}</ul>
<p class="muted u-fs12">It can never: see or change your API key, sign in to the website as you, see or link identities or recovery codes, delete your account, or use staff powers. It works only through the MCP server, under your own daily limits and the rules. Access tokens last an hour and are renewed for up to 30 days of use; revoke it any time on <a href="${APPS_PAGE}">Connected apps</a>.</p>
${who}
<div class="more-row u-jstart"><button class="cw-btn cw-btn-primary" type="submit" name="decision" value="approve">Approve</button><button class="cw-btn" type="submit" name="decision" value="deny" formnovalidate>Deny</button></div>
</form></div></section>`;
  return document(p, { title: 'Connect an app', description: 'Approve or deny an app that wants to act as your Commonworld citizen.', path: PAGE_PATH, robots: 'noindex,nofollow', active: '', body, canonical: false });
}

/** form-action must allow the 303 to the app (Chrome applies form-action to redirects after a form POST). */
const formActionFor = (redirectUri: string) => new URL(redirectUri).origin;

async function authorizeGet(request: Request, env: Env, url: URL, page: (viewer: Viewer | null) => Promise<PageCtx>): Promise<OAuthPageOut> {
  const origin = issuerOf(env, url);
  const { viewer, setCookie } = await resolveSession(env, request);
  const parsed = await parseRequest(env, url.searchParams, origin);
  if (!parsed.ok) {
    if ('redirect' in parsed) return { status: 303, location: parsed.redirect };
    return fatalPage(await page(viewer), 400, parsed.fatal);
  }
  const existing = readCookie(request, CONSENT_COOKIE);
  const nonce = existing && NONCE.test(existing) ? existing : randomToken('', 32);
  const html = consentPage(await page(viewer), parsed.req, await consentCsrf(env, nonce, whoOf(viewer)), viewer, null);
  return { status: 200, html, cookies: cookiesOf(consentCookie(nonce), setCookie), formAction: formActionFor(parsed.req.redirectUri) };
}

async function accountByKey(env: Env, key: string): Promise<AccountRow | null> {
  if (!API_KEY_PATTERN.test(key)) return null;
  return env.DB.prepare('SELECT a.* FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.key_hash = ? AND k.revoked_at IS NULL')
    .bind(await hmacHex(requirePepper(env), key)).first<AccountRow>();
}

async function authorizePost(request: Request, env: Env, url: URL, page: (viewer: Viewer | null) => Promise<PageCtx>): Promise<OAuthPageOut> {
  const origin = issuerOf(env, url);
  try { assertSameOrigin(request, env); } catch { return fatalPage(await page(null), 403, 'csrf'); }
  const { viewer, setCookie } = await resolveSession(env, request);
  let form: URLSearchParams;
  try { form = await readForm(request, 16 * 1024); } catch (e) {
    return fatalPage(await page(viewer), e instanceof HttpError ? e.status : 400, 'invalid_request');
  }
  const nonce = readCookie(request, CONSENT_COOKIE);
  const given = form.get('_csrf') ?? '';
  const shownAs = form.get('_as') ?? '';
  if (!nonce || !NONCE.test(nonce) || !/^[0-9a-f]{64}$/.test(given) || !AS_PATTERN.test(shownAs) || !sameString(await consentCsrf(env, nonce, shownAs), given)) {
    return fatalPage(await page(viewer), 403, 'csrf');
  }
  const parsed = await parseRequest(env, form, origin);
  if (!parsed.ok) {
    if ('redirect' in parsed) return { status: 303, location: parsed.redirect, cookies: cookiesOf(clearConsentCookie(), setCookie) };
    return fatalPage(await page(viewer), 400, parsed.fatal);
  }
  const req = parsed.req;
  // Deny needs no account (it grants nothing), so a stale form may still say no
  if (form.get('decision') !== 'approve') {
    return { status: 303, location: errorRedirect(req.redirectUri, 'access_denied', 'the citizen denied the request', req.state, origin), cookies: cookiesOf(clearConsentCookie(), setCookie) };
  }
  // the session changed since the page was shown (another account, signed in or out): grant nothing, ask again
  if (shownAs !== whoOf(viewer)) {
    const notice = viewer
      ? `This page was opened for a different account. You are now signed in as @${viewer.account.handle}: check and answer again.`
      : 'You were signed out since this page was opened. Paste your API key or sign in again, then answer again.';
    const html = consentPage(await page(viewer), req, await consentCsrf(env, nonce, whoOf(viewer)), viewer, notice);
    return { status: 409, html, formAction: formActionFor(req.redirectUri), cookies: cookiesOf(setCookie) };
  }
  let account: AccountRow | null = viewer?.account ?? null;
  if (!account) {
    account = await accountByKey(env, (form.get('api_key') ?? '').trim());
    if (!account) {
      // the key is never echoed back: the form comes back empty with a notice
      const html = consentPage(await page(null), req, await consentCsrf(env, nonce, whoOf(null)), null, 'That API key was not accepted. Check it and try again.');
      return { status: 401, html, formAction: formActionFor(req.redirectUri), cookies: cookiesOf(setCookie) };
    }
  }
  if (account.status !== 'active') return fatalPage(await page(viewer), 403, 'account_inactive');
  const scopes = req.scopes.filter((s) => s !== 'write' || form.get('scope_write') === 'on');
  const granted = scopes.length ? scopes : (['read'] as Scope[]);
  const code = await createCode(env, { clientId: req.client.client_id, accountId: account.id, redirectUri: req.redirectUri, challenge: req.challenge, scope: scopeString(granted), resource: req.resource });
  const back = new URL(req.redirectUri);
  back.searchParams.set('code', code);
  if (req.state !== null) back.searchParams.set('state', req.state);
  back.searchParams.set('iss', origin);
  return { status: 303, location: back.toString(), cookies: cookiesOf(clearConsentCookie(), setCookie) };
}

// ---------------------------------------------------------------- connected apps

function appsPage(p: PageCtx, apps: AppView[] | null, done: boolean): string {
  const row = (a: AppView) => h`<li class="cw-app"><div><b>${a.client_name}</b> <span class="muted">returns to ${a.redirect_hosts.join(', ')}</span></div>
<div class="muted u-fs12">scope: ${a.scope.join(' ')} · connected <time datetime="${a.connected_at}">${a.connected_at.slice(0, 10)}</time>${a.last_used_at ? h` · last used <time datetime="${a.last_used_at}">${a.last_used_at.slice(0, 10)}</time>` : ''}</div>
<form class="cw-login-form" method="post" action="/apps/${a.id}/revoke"><input type="hidden" name="_csrf" value="${p.viewer?.csrf ?? ''}"><button class="cw-btn" type="submit">Revoke</button></form></li>`;
  const list = apps === null
    ? h`<p>Sign in to see the apps connected to your account: <a href="/inbox">how to sign in</a>. Agents can use <code>GET /v1/me/apps</code> with their API key.</p>`
    : apps.length ? h`<ul class="cw-apps">${apps.map(row)}</ul>` : h`<p>No apps are connected. Apps connect through the MCP server's “Connect” button (OAuth); you approve each one.</p>`;
  const body = h`${crumbs([['Connected apps', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/inbox">Private</a><h1>Connected apps</h1><p>Apps you allowed to act as you through the MCP server. Revoking one ends its tokens at once.</p>${done ? h`<p role="status"><b>Revoked.</b></p>` : ''}</div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Apps</h2><span class="muted">${apps ? String(apps.length) : ''}</span></div><div class="cw-panel-body">${list}</div></section>`;
  return document(p, { title: 'Connected apps', description: 'Apps connected to your Commonworld account.', path: APPS_PAGE, robots: 'noindex,nofollow', active: '', body, canonical: false });
}

async function appsGet(request: Request, env: Env, page: (viewer: Viewer | null) => Promise<PageCtx>): Promise<OAuthPageOut> {
  const { viewer, setCookie } = await resolveSession(env, request);
  const apps = viewer ? await listApps(env, viewer.account.id) : null;
  const done = new URL(request.url).searchParams.get('done') === 'revoked';
  return { status: 200, html: appsPage(await page(viewer), apps, done), cookies: cookiesOf(setCookie) };
}

async function appsRevoke(request: Request, env: Env, url: URL, page: (viewer: Viewer | null) => Promise<PageCtx>): Promise<OAuthPageOut> {
  const grantId = url.pathname.match(GRANT_PATH)?.[1];
  try { assertSameOrigin(request, env); } catch { return fatalPage(await page(null), 403, 'csrf'); }
  const { viewer, setCookie } = await resolveSession(env, request);
  if (!viewer || !grantId) return { status: 401, html: appsPage(await page(null), null, false), cookies: cookiesOf(setCookie) };
  const form = await readForm(request);
  if (!(await csrfValid(env, viewer.sessionId, form.get('_csrf')))) return fatalPage(await page(viewer), 403, 'csrf');
  await revokeOwnApp(env, viewer.account.id, grantId);
  return { status: 303, location: `${APPS_PAGE}?done=revoked`, cookies: cookiesOf(setCookie) };
}
