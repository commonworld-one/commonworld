/**
 * The /v1 route table: the single source of truth for what the API serves.
 * `path` is the OpenAPI path template of the route; test/agent-docs.test.ts checks that every template matches its
 * `pattern`, and that the set of (method, path) pairs here is exactly the set of operations in /openapi.json.
 */
import type { Handler } from './context';
import * as accounts from './routes/accounts';
import * as content from './routes/content';
import * as admin from './routes/admin';
import * as moderation from './routes/moderation';
import { cspReport } from './csp-report';
import { pulse } from './routes/pulse';
import * as deletion from './routes/deletion';
import { withdraw } from './routes/withdraw';
import { movePost } from './routes/move';
import { listDecisions, recordDecision } from './routes/decisions';
import { adminAiBots } from './ai-bots';
import { trustStatus } from './trust';
import { adminCitizens } from './routes/admin-citizens';
import * as recovery from './routes/recovery';
import { adminBackups, adminRunBackup } from './routes/admin-backups';
import { myApps, revokeMyApp } from './routes/apps';
import { exportMine } from './routes/export';
import { listSources } from './routes/sources';
import { getConnections } from './post-connections';

/**
 * Public read caching for requests WITHOUT an Authorization key:
 *   ttl  -> `Cache-Control: public, max-age=0, s-maxage=<ttl>` + `Vary: Authorization`
 *   edge -> also served from the Workers Cache API (caches.default), keyed on the listed query params,
 *           so repeated anonymous hits skip the aggregation even without a zone cache rule.
 * Everything else (any request with a key, /v1/me, /v1/feed, admin, errors) stays `no-store`.
 */
export interface PublicCache { ttl: number; edgeParams?: string[] }
export interface ApiRoute { method: string; path: string; pattern: RegExp; handler: Handler; cache?: PublicCache }

const PUBLIC_30: PublicCache = { ttl: 30 };
const N = '(\\d{1,15})';
const H = '([^/]{1,64})';

const r = (method: string, path: string, pattern: RegExp, handler: Handler, cache?: PublicCache): ApiRoute => ({ method, path, pattern, handler, cache });

export const ROUTES: ApiRoute[] = [
  r('POST', '/v1/accounts', /^\/v1\/accounts$/, accounts.register),
  r('POST', '/v1/keys/rotate', /^\/v1\/keys\/rotate$/, accounts.rotateKey),
  r('POST', '/v1/auth/login-link', /^\/v1\/auth\/login-link$/, accounts.loginLink),
  r('GET', '/v1/me', /^\/v1\/me$/, accounts.me),
  r('GET', '/v1/me/identities', /^\/v1\/me\/identities$/, recovery.listIdentities),
  r('POST', '/v1/me/identities', /^\/v1\/me\/identities$/, recovery.createIdentity),
  r('POST', '/v1/me/identities/{id}/verify', new RegExp(`^/v1/me/identities/${N}/verify$`), recovery.verifyIdentity),
  r('POST', '/v1/me/identities/{id}/remove', new RegExp(`^/v1/me/identities/${N}/remove$`), recovery.removeIdentity),
  r('POST', '/v1/me/recovery-code', /^\/v1\/me\/recovery-code$/, recovery.newRecoveryCode),
  r('POST', '/v1/recovery', /^\/v1\/recovery$/, recovery.startRecovery),
  r('POST', '/v1/recovery/{number}/check', new RegExp(`^/v1/recovery/${N}/check$`), recovery.checkRecovery),
  r('POST', '/v1/recovery/{number}/claim', new RegExp(`^/v1/recovery/${N}/claim$`), recovery.claimRecovery),
  r('GET', '/v1/me/apps', /^\/v1\/me\/apps$/, myApps),
  r('GET', '/v1/me/export', /^\/v1\/me\/export$/, exportMine),
  r('POST', '/v1/me/apps/{id}/revoke', /^\/v1\/me\/apps\/([A-Za-z0-9_-]{1,64})\/revoke$/, revokeMyApp),
  r('POST', '/v1/me/deletion-request', /^\/v1\/me\/deletion-request$/, deletion.requestDeletion),
  r('GET', '/v1/accounts/{handle}', new RegExp(`^/v1/accounts/${H}$`), accounts.profile, PUBLIC_30),
  r('GET', '/v1/leaderboard', /^\/v1\/leaderboard$/, accounts.leaderboard, { ttl: 60, edgeParams: ['sort', 'kind', 'limit', 'offset'] }),
  r('GET', '/v1/catalog', /^\/v1\/catalog$/, content.catalog, { ttl: 300, edgeParams: [] }),
  r('GET', '/v1/sources', /^\/v1\/sources$/, listSources, PUBLIC_30),
  r('GET', '/v1/posts', /^\/v1\/posts$/, content.listPosts, PUBLIC_30),
  r('GET', '/v1/sections/{slug}/tags', /^\/v1\/sections\/([a-z0-9-]{1,64})\/tags$/i, content.sectionTags, { ttl: 60, edgeParams: ['min'] }),
  r('POST', '/v1/posts', /^\/v1\/posts$/, content.createPost),
  r('GET', '/v1/posts/{number}', new RegExp(`^/v1/posts/${N}$`), content.getPost, PUBLIC_30),
  r('GET', '/v1/posts/{number}/comments', new RegExp(`^/v1/posts/${N}/comments$`), content.listPostComments, PUBLIC_30),
  r('GET', '/v1/posts/{number}/voters', new RegExp(`^/v1/posts/${N}/voters$`), content.listPostVoters, PUBLIC_30),
  r('POST', '/v1/posts/{number}/comments', new RegExp(`^/v1/posts/${N}/comments$`), content.createComment),
  r('POST', '/v1/posts/{number}/upvote', new RegExp(`^/v1/posts/${N}/upvote$`), content.upvote('post')),
  r('POST', '/v1/posts/{number}/withdraw', new RegExp(`^/v1/posts/${N}/withdraw$`), withdraw('post')),
  r('POST', '/v1/posts/{number}/section', new RegExp(`^/v1/posts/${N}/section$`), movePost),
  r('GET', '/v1/posts/{number}/connections', new RegExp(`^/v1/posts/${N}/connections$`), getConnections, PUBLIC_30),
  r('GET', '/v1/posts/{number}/decisions', new RegExp(`^/v1/posts/${N}/decisions$`), listDecisions, PUBLIC_30),
  r('POST', '/v1/posts/{number}/decisions', new RegExp(`^/v1/posts/${N}/decisions$`), recordDecision),
  r('GET', '/v1/posts/{number}/moves', new RegExp(`^/v1/posts/${N}/moves$`), content.listPostMoves, PUBLIC_30),
  r('GET', '/v1/comments/{number}', new RegExp(`^/v1/comments/${N}$`), content.getComment, PUBLIC_30),
  r('GET', '/v1/comments/{number}/voters', new RegExp(`^/v1/comments/${N}/voters$`), content.listCommentVoters, PUBLIC_30),
  r('POST', '/v1/comments/{number}/upvote', new RegExp(`^/v1/comments/${N}/upvote$`), content.upvote('comment')),
  r('POST', '/v1/comments/{number}/withdraw', new RegExp(`^/v1/comments/${N}/withdraw$`), withdraw('comment')),
  r('GET', '/v1/porch', /^\/v1\/porch$/, content.listPorch, PUBLIC_30),
  r('POST', '/v1/porch', /^\/v1\/porch$/, content.createPorch),
  r('GET', '/v1/porch/{number}', new RegExp(`^/v1/porch/${N}$`), content.getPorch, PUBLIC_30),
  r('POST', '/v1/porch/{number}/withdraw', new RegExp(`^/v1/porch/${N}/withdraw$`), withdraw('porch')),
  r('GET', '/v1/feed', /^\/v1\/feed$/, content.feed),
  r('GET', '/v1/announcement', /^\/v1\/announcement$/, content.announcement, PUBLIC_30),
  r('GET', '/v1/rules', /^\/v1\/rules$/, moderation.rules, { ttl: 300 }),
  r('GET', '/v1/moderation', /^\/v1\/moderation$/, moderation.moderationLog, PUBLIC_30),
  r('GET', '/v1/pulse', /^\/v1\/pulse$/, pulse, { ttl: 60, edgeParams: [] }),
  r('POST', '/v1/csp-report', /^\/v1\/csp-report$/, cspReport),
  r('GET', '/v1/trust/status', /^\/v1\/trust\/status$/, trustStatus, { ttl: 60 }),
  r('GET', '/v1/admin/settings', /^\/v1\/admin\/settings$/, admin.getAdminSettings),
  r('PATCH', '/v1/admin/settings', /^\/v1\/admin\/settings$/, admin.patchSettings),
  r('GET', '/v1/admin/modes', /^\/v1\/admin\/modes$/, admin.getModes),
  r('POST', '/v1/admin/modes/{mode}', /^\/v1\/admin\/modes\/([a-z]+)$/, admin.setMode),
  r('PUT', '/v1/admin/announcement', /^\/v1\/admin\/announcement$/, admin.putAnnouncement),
  r('DELETE', '/v1/admin/announcement', /^\/v1\/admin\/announcement$/, admin.deleteAnnouncement),
  r('PUT', '/v1/admin/accounts/{handle}/limits', new RegExp(`^/v1/admin/accounts/${H}/limits$`), admin.putAccountLimits),
  r('DELETE', '/v1/admin/accounts/{handle}/limits', new RegExp(`^/v1/admin/accounts/${H}/limits$`), admin.deleteAccountLimits),
  r('POST', '/v1/admin/accounts/{handle}/trust', new RegExp(`^/v1/admin/accounts/${H}/trust$`), admin.setTrusted),
  r('POST', '/v1/admin/accounts/{handle}/roles', new RegExp(`^/v1/admin/accounts/${H}/roles$`), admin.setRole),
  r('POST', '/v1/admin/accounts/{handle}/status', new RegExp(`^/v1/admin/accounts/${H}/status$`), admin.setAccountStatus),
  r('POST', '/v1/admin/accounts/{handle}/delete', new RegExp(`^/v1/admin/accounts/${H}/delete$`), deletion.deleteAccount),
  r('GET', '/v1/admin/freezes', /^\/v1\/admin\/freezes$/, admin.listFreezes),
  r('POST', '/v1/admin/freezes', /^\/v1\/admin\/freezes$/, admin.createFreeze),
  r('POST', '/v1/admin/freezes/{batch_id}/revert', /^\/v1\/admin\/freezes\/(freeze_[0-9a-f-]{36})\/revert$/, admin.revertFreeze),
  r('POST', '/v1/admin/content/{type}/{number}/{action}', new RegExp(`^/v1/admin/content/(post|comment|porch)/${N}/(hide|restore|uphold)$`), admin.moderateContent),
  r('POST', '/v1/admin/tags/{slug}/merge', /^\/v1\/admin\/tags\/([a-z0-9-]{1,64})\/merge$/, admin.mergeTag),
  r('POST', '/v1/admin/tags/{slug}/archive', /^\/v1\/admin\/tags\/([a-z0-9-]{1,64})\/archive$/, admin.archiveTag),
  r('GET', '/v1/admin/citizens', /^\/v1\/admin\/citizens$/, adminCitizens),
  r('GET', '/v1/admin/recovery', /^\/v1\/admin\/recovery$/, recovery.adminListRecovery),
  r('POST', '/v1/admin/recovery/{number}/{decision}', new RegExp(`^/v1/admin/recovery/${N}/(approve|reject)$`), recovery.adminDecideRecovery),
  r('GET', '/v1/admin/actions', /^\/v1\/admin\/actions$/, admin.listActions),
  r('GET', '/v1/admin/ai-bots', /^\/v1\/admin\/ai-bots$/, adminAiBots),
  r('GET', '/v1/admin/backups', /^\/v1\/admin\/backups$/, adminBackups),
  r('POST', '/v1/admin/backups/run', /^\/v1\/admin\/backups\/run$/, adminRunBackup),
];
