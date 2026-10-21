import type { Ctx } from '../context';
import { requireRole, type Principal } from '../auth';
import { HttpError, intParam, json, nowIso, readJson } from '../http';
import { DEFAULTS, VALIDATORS, getSettings, writeSettings, type SettingKey } from '../settings';
import { PUBLIC_NOTE_MAX, RULES, ruleByNumber, ruleText } from '../rules';
import { accountView, citizenPath, moderationLogUrl } from '../views';
import { bumpContentCacheVersion } from '../cache-version';
import { recountStatements } from '../counters';
import { deleteAccountSessions } from '../sessions';
import { revokeAccountOAuth, revokeFreezeBatchOAuth } from '../oauth/store';
import { requireCapability, type Capability } from '../policy';

const admin = (c: Ctx) => requireRole(c.principal, 'admin');
const staff = (c: Ctx) => requireRole(c.principal, 'admin', 'moderator');

function reason(body: Record<string, unknown>, required = true): string | null {
  const value = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!value && required) throw new HttpError(400, 'reason_required');
  if (value.length > 500) throw new HttpError(400, 'reason_too_long', { max_length: 500 });
  return value || null;
}

const logAction = (c: Ctx, p: Principal, action: string, targetType: string, targetRef: string | null, why: string | null, details: unknown = null) =>
  c.env.DB.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(p.account.id, action, targetType, targetRef, why, details === null ? null : JSON.stringify(details), nowIso());

async function accountByHandle(c: Ctx, raw: string) {
  const row = await c.env.DB.prepare('SELECT * FROM accounts WHERE handle = ?').bind(decodeURIComponent(raw).toLowerCase()).first<any>();
  if (!row) throw new HttpError(404, 'account_not_found');
  return row;
}

// ---------- settings ----------

export async function getAdminSettings(c: Ctx): Promise<Response> {
  admin(c);
  return json(200, { settings: await getSettings(c.env), defaults: DEFAULTS });
}

/** PATCH {"values": {"limits.daily.comment": 80, ...}} — applies live, no deploy. */
export async function patchSettings(c: Ctx): Promise<Response> {
  const p = admin(c);
  const body = await readJson(c.request);
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw new HttpError(400, 'values_object_required');
  const values = body.values as Record<string, unknown>;
  if (Object.hasOwn(values, 'announcement')) throw new HttpError(400, 'use_announcement_endpoint');
  const settings = await writeSettings(c.env, values as Partial<Record<SettingKey, unknown>>, p.account.id, 'settings.update');
  return json(200, { settings });
}

// ---------- defensive modes ----------

const MODES = { shield: 'mode.shield', lock: 'mode.lock', brake: 'mode.brake' } as const;

const isMode = (v: string): v is keyof typeof MODES => Object.hasOwn(MODES, v);

export async function getModes(c: Ctx): Promise<Response> {
  staff(c);
  const s = await getSettings(c.env);
  return json(200, { shield: s['mode.shield'], lock: s['mode.lock'], brake: s['mode.brake'] });
}

/** POST /v1/admin/modes/{shield|lock|brake} {"enabled": true, ...thresholds} — one call on/off. */
export async function setMode(c: Ctx): Promise<Response> {
  const p = admin(c);
  const mode = c.params[0];
  if (!isMode(mode)) throw new HttpError(404, 'unknown_mode', { allowed: Object.keys(MODES) });
  const key = MODES[mode];
  const body = await readJson(c.request);
  const current = (await getSettings(c.env))[key] as unknown as Record<string, unknown>;
  for (const field of Object.keys(body)) if (!Object.hasOwn(current, field)) throw new HttpError(400, 'unknown_mode_field', { field, allowed: Object.keys(current) });
  const next = { ...current, ...body };
  if (!VALIDATORS[key](next)) throw new HttpError(400, 'invalid_mode_value');
  const settings = await writeSettings(c.env, { [key]: next }, p.account.id, `mode.${mode}.${next.enabled ? 'on' : 'off'}`);
  return json(200, { mode, value: settings[key] });
}

// ---------- announcement ----------

export async function putAnnouncement(c: Ctx): Promise<Response> {
  const p = admin(c);
  const body = await readJson(c.request);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 280 || /[\r\n]/.test(text)) throw new HttpError(400, 'invalid_announcement', { max_length: 280, single_line: true });
  const value = { text, updated_at: nowIso() };
  await writeSettings(c.env, { announcement: value }, p.account.id, 'announcement.set');
  await c.env.DB.prepare("INSERT INTO events (type, object_type, created_at) VALUES ('announcement.updated', 'announcement', ?)").bind(value.updated_at).run();
  return json(200, { announcement: value });
}

export async function deleteAnnouncement(c: Ctx): Promise<Response> {
  const p = admin(c);
  await writeSettings(c.env, { announcement: null }, p.account.id, 'announcement.clear');
  await c.env.DB.prepare("INSERT INTO events (type, object_type, created_at) VALUES ('announcement.updated', 'announcement', ?)").bind(nowIso()).run();
  return json(200, { announcement: null });
}

// ---------- per-account controls ----------

const OVERRIDE_FIELDS = ['daily_post', 'daily_comment', 'daily_vote', 'daily_porch', 'rate_per_minute'] as const;

const LIMIT_FIELDS = new Set<string>([...OVERRIDE_FIELDS, 'note']);

/** PUT {"daily_post": 30, "rate_per_minute": 600, "note": "core team"} — null/absent = platform default. */
export async function putAccountLimits(c: Ctx): Promise<Response> {
  const p = admin(c);
  const target = await accountByHandle(c, c.params[0]);
  const body = await readJson(c.request);
  const values: Record<string, number | null> = {};
  for (const field of Object.keys(body)) if (!LIMIT_FIELDS.has(field)) throw new HttpError(400, 'unknown_limit_field', { field });
  for (const field of OVERRIDE_FIELDS) {
    const v = body[field] ?? null;
    const min = field === 'rate_per_minute' ? 1 : 0;
    if (v !== null && !(Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= 1_000_000)) throw new HttpError(400, 'invalid_limit_value', { field });
    values[field] = v as number | null;
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO account_limits (account_id, daily_post, daily_comment, daily_vote, daily_porch, rate_per_minute, note, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET daily_post = excluded.daily_post, daily_comment = excluded.daily_comment,
      daily_vote = excluded.daily_vote, daily_porch = excluded.daily_porch, rate_per_minute = excluded.rate_per_minute, note = excluded.note,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .bind(target.id, values.daily_post, values.daily_comment, values.daily_vote, values.daily_porch, values.rate_per_minute, note, nowIso(), p.account.id),
    logAction(c, p, 'account.limits.set', 'account', target.handle, note, values),
  ]);
  return json(200, { handle: target.handle, overrides: { ...values, note } });
}

export async function deleteAccountLimits(c: Ctx): Promise<Response> {
  const p = admin(c);
  const target = await accountByHandle(c, c.params[0]);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM account_limits WHERE account_id = ?').bind(target.id),
    logAction(c, p, 'account.limits.clear', 'account', target.handle, null),
  ]);
  return json(200, { handle: target.handle, overrides: null });
}

export async function setTrusted(c: Ctx): Promise<Response> {
  const p = admin(c);
  const target = await accountByHandle(c, c.params[0]);
  const body = await readJson(c.request);
  if (typeof body.trusted !== 'boolean') throw new HttpError(400, 'trusted_boolean_required');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE accounts SET trusted = ? WHERE id = ?').bind(body.trusted ? 1 : 0, target.id),
    logAction(c, p, body.trusted ? 'account.trust' : 'account.untrust', 'account', target.handle, reason(body, false)),
  ]);
  return json(200, { handle: target.handle, trusted: body.trusted });
}

export async function setRole(c: Ctx): Promise<Response> {
  const p = admin(c);
  const target = await accountByHandle(c, c.params[0]);
  const body = await readJson(c.request);
  if (body.role !== 'admin' && body.role !== 'moderator') throw new HttpError(400, 'invalid_role', { allowed: ['admin', 'moderator'] });
  if (typeof body.granted !== 'boolean') throw new HttpError(400, 'granted_boolean_required');
  if (!body.granted && body.role === 'admin' && target.id === p.account.id) throw new HttpError(409, 'cannot_remove_own_admin');
  await c.env.DB.batch([
    body.granted
      ? c.env.DB.prepare('INSERT OR IGNORE INTO account_roles (account_id, role, granted_at, granted_by) VALUES (?, ?, ?, ?)').bind(target.id, body.role, nowIso(), p.account.id)
      : c.env.DB.prepare('DELETE FROM account_roles WHERE account_id = ? AND role = ?').bind(target.id, body.role),
    logAction(c, p, body.granted ? 'role.grant' : 'role.revoke', 'account', target.handle, reason(body, false), { role: body.role }),
    bumpContentCacheVersion(c.env.DB),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  return json(200, { handle: target.handle, role: body.role, granted: body.granted });
}

const ACCOUNT_STATUSES = new Set(['active', 'frozen', 'disabled']);

/** POST {"status": "active"|"frozen"|"disabled", "reason": "..."} */
export async function setAccountStatus(c: Ctx): Promise<Response> {
  const p = admin(c);
  const target = await accountByHandle(c, c.params[0]);
  const body = await readJson(c.request);
  if (typeof body.status !== 'string' || !ACCOUNT_STATUSES.has(body.status)) throw new HttpError(400, 'invalid_status', { allowed: ['active', 'frozen', 'disabled'] });
  if (target.id === p.account.id) throw new HttpError(409, 'cannot_change_own_status');
  if (target.deleted_at) throw new HttpError(409, 'account_deleted');
  const why = reason(body);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE accounts SET status = ?, frozen_batch_id = NULL WHERE id = ?').bind(body.status, target.id),
    // Frozen or disabled: signed out of every browser session (lookup also refuses non-active accounts).
    body.status === 'active' ? c.env.DB.prepare('SELECT 1') : deleteAccountSessions(c.env.DB, target.id),
    // ... and every connected app (OAuth grant) is disconnected; restoring the status does not reconnect them
    ...(body.status === 'active' ? [] : revokeAccountOAuth(c.env.DB, target.id, 'account')),
    logAction(c, p, `account.status.${body.status}`, 'account', target.handle, why, { from: target.status }),
    bumpContentCacheVersion(c.env.DB),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  return json(200, { account: accountView({ ...target, status: body.status }) });
}

// ---------- bulk freeze by registration window ----------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** POST {"registered_from": ISO, "registered_to": ISO, "reason": "..."} — freezes untrusted, role-less active accounts created in [from, to); staff/trusted are skipped and counted. */
export async function createFreeze(c: Ctx): Promise<Response> {
  const p = admin(c);
  const body = await readJson(c.request);
  const from = String(body.registered_from ?? '');
  const to = String(body.registered_to ?? '');
  if (!ISO.test(from) || !ISO.test(to) || Date.parse(from) >= Date.parse(to)) throw new HttpError(400, 'invalid_window', { format: 'ISO-8601 UTC, from < to' });
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const why = reason(body)!;
  const id = `freeze_${crypto.randomUUID()}`;
  const at = nowIso();
  const db = c.env.DB;
  // Staff (admin/moderator role) and admin-trusted accounts are never bulk-frozen, so a wide
  // window cannot lock the operators out; they are counted and reported as skipped.
  const [skipped, , update] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM accounts
      WHERE status = 'active' AND created_at >= ? AND created_at < ?
        AND (trusted = 1 OR id IN (SELECT account_id FROM account_roles))`).bind(fromIso, toIso),
    db.prepare('INSERT INTO freeze_batches (id, registered_from, registered_to, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, fromIso, toIso, why, p.account.id, at),
    db.prepare(`UPDATE accounts SET status = 'frozen', frozen_batch_id = ?
      WHERE status = 'active' AND trusted = 0 AND created_at >= ? AND created_at < ?
        AND id NOT IN (SELECT account_id FROM account_roles)`).bind(id, fromIso, toIso),
    db.prepare('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE frozen_batch_id = ?)').bind(id),
    // ... and every connected app (OAuth grant) is disconnected, as for a single freeze; reverting does not reconnect them
    ...revokeFreezeBatchOAuth(db, id),
    db.prepare('UPDATE freeze_batches SET affected_count = (SELECT COUNT(*) FROM accounts WHERE frozen_batch_id = ?) WHERE id = ?').bind(id, id),
    logAction(c, p, 'freeze.create', 'freeze_batch', id, why, { registered_from: fromIso, registered_to: toIso }),
    bumpContentCacheVersion(db),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  return json(201, { id, registered_from: fromIso, registered_to: toIso, affected_count: update.meta.changes,
    skipped_staff_or_trusted_count: (skipped.results[0] as { n: number } | undefined)?.n ?? 0, reason: why });
}

export async function revertFreeze(c: Ctx): Promise<Response> {
  const p = admin(c);
  const id = c.params[0];
  const batch = await c.env.DB.prepare('SELECT * FROM freeze_batches WHERE id = ?').bind(id).first<any>();
  if (!batch) throw new HttpError(404, 'freeze_not_found');
  if (batch.reverted_at) throw new HttpError(409, 'freeze_already_reverted');
  const at = nowIso();
  const [update] = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE accounts SET status = 'active', frozen_batch_id = NULL WHERE frozen_batch_id = ? AND status = 'frozen'").bind(id),
    c.env.DB.prepare('UPDATE freeze_batches SET reverted_at = ?, reverted_by = ? WHERE id = ?').bind(at, p.account.id, id),
    logAction(c, p, 'freeze.revert', 'freeze_batch', id, null),
    bumpContentCacheVersion(c.env.DB),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  return json(200, { id, reverted_at: at, restored_count: update.meta.changes });
}

export async function listFreezes(c: Ctx): Promise<Response> {
  admin(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM freeze_batches ORDER BY created_at DESC LIMIT 100').all();
  return json(200, { items: results });
}

// ---------- content moderation ----------

const CONTENT_TABLES = { post: 'posts', comment: 'comments', porch: 'porch_lines' } as const;
const CONTENT_ACTIONS = new Set(['hide', 'restore', 'uphold']);

function publicNote(body: Record<string, unknown>): string | null {
  if (body.note === undefined || body.note === null) return null;
  if (typeof body.note !== 'string') throw new HttpError(400, 'invalid_note');
  const value = body.note.replace(/\s+/g, ' ').trim();
  if (value.length > PUBLIC_NOTE_MAX) throw new HttpError(400, 'note_too_long', { max_length: PUBLIC_NOTE_MAX });
  return value || null;
}

function ruleField(body: Record<string, unknown>, required: boolean): number | null {
  if (body.rule === undefined || body.rule === null) {
    if (required) throw new HttpError(400, 'rule_required', { allowed: RULES.map((r) => r.number) });
    return null;
  }
  if (!ruleByNumber(body.rule)) throw new HttpError(400, 'invalid_rule', { allowed: RULES.map((r) => r.number) });
  return body.rule as number;
}

/**
 * POST /v1/admin/content/{post|comment|porch}/{number}/{hide|restore}
 *   {"rule": 1-7, "note": "short public note", "reason": "private staff note"}
 * hide: `rule` required. restore: `rule` optional, `note` or `reason` required.
 * uphold: an appeal was reviewed and the decision stands — `rule` and `note` required, the object must be hidden;
 *   visibility does not change; writes a public `content.upheld` entry (action log: `content.uphold`).
 * rule, note and the moderator's @handle are public (moderation log, change feed, hidden-content pages);
 * `reason` stays in the staff-only action log.
 */
/** Rule 7: nothing illegal or malicious (malware, phishing, scams). Hides and restores under it carry evidence. */
const SAFETY_RULE = 7;
const CAPABILITY_OF: Record<string, Capability> = { hide: 'safety:hide', restore: 'safety:restore', uphold: 'safety:review' };

/** Optional https link to the evidence (safety report, scanner result, issue). Logged in the staff action log. */
function evidenceField(body: Record<string, unknown>, required: boolean): string | null {
  const raw = typeof body.evidence_url === 'string' ? body.evidence_url.trim() : '';
  if (!raw) {
    if (body.evidence_url !== undefined && body.evidence_url !== null && typeof body.evidence_url !== 'string') throw new HttpError(400, 'invalid_evidence_url');
    if (required) throw new HttpError(400, 'evidence_url_required', { rule: SAFETY_RULE });
    return null;
  }
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'invalid_evidence_url'); }
  if (u.protocol !== 'https:' || raw.length > 500) throw new HttpError(400, 'invalid_evidence_url', { max_length: 500, scheme: 'https' });
  return u.toString();
}

export async function moderateContent(c: Ctx): Promise<Response> {
  const [type, rawNumber, action] = c.params as [string, string, string];
  const p = requireCapability(c.principal, CAPABILITY_OF[action] ?? 'safety:review');
  if (!Object.hasOwn(CONTENT_TABLES, type) || !CONTENT_ACTIONS.has(action)) throw new HttpError(404, 'unknown_content_type');
  const table = CONTENT_TABLES[type as keyof typeof CONTENT_TABLES];
  const number = Number(rawNumber);
  const row = await c.env.DB.prepare(`SELECT status FROM ${table} WHERE number = ?`).bind(number).first<{ status: string }>();
  if (!row) throw new HttpError(404, `${type}_not_found`);
  const body = await readJson(c.request);
  const rule = ruleField(body, action !== 'restore');
  const note = publicNote(body);
  const why = reason(body, false);
  if (action === 'restore' && !note && !why) throw new HttpError(400, 'note_or_reason_required');
  if (action === 'uphold' && !note) throw new HttpError(400, 'note_required', { max_length: PUBLIC_NOTE_MAX });
  if (action === 'uphold' && row.status !== 'hidden') throw new HttpError(409, 'not_hidden', { status: row.status });
  // trust/safety: a hide under rule 7, and a restore of content last hidden under rule 7, carry a reason and an evidence link
  let safety = action === 'hide' && rule === SAFETY_RULE;
  if (action === 'restore' && row.status === 'hidden') {
    const last = await c.env.DB.prepare("SELECT rule FROM moderation_actions WHERE target_ref = ? AND action = 'content.hide' ORDER BY number DESC LIMIT 1").bind(`${type}-${number}`).first<{ rule: number | null }>();
    safety = last?.rule === SAFETY_RULE;
  }
  const evidence = evidenceField(body, safety);
  if (safety && !why) throw new HttpError(400, 'reason_required', { rule: SAFETY_RULE });
  const status = action === 'restore' ? 'visible' : 'hidden';
  if (action !== 'uphold' && row.status === status) return json(200, { target: `${type}-${number}`, status, unchanged: true });
  const at = nowIso();
  const eventType = action === 'hide' ? 'content.hidden' : action === 'restore' ? 'content.restored' : 'content.upheld';
  const [, , event] = await c.env.DB.batch([
    // uphold leaves the object as it is (no-op write keeps the batch shape)
    action === 'uphold' ? c.env.DB.prepare('SELECT 1') : c.env.DB.prepare(`UPDATE ${table} SET status = ? WHERE number = ?`).bind(status, number),
    c.env.DB.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, rule, public_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(p.account.id, `content.${action}`, type, `${type}-${number}`, why, evidence ? JSON.stringify({ evidence_url: evidence, capability: CAPABILITY_OF[action] }) : null, rule, note, at),
    c.env.DB.prepare('INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq')
      .bind(eventType, type, number, p.account.id, JSON.stringify({ rule, note }), at),
    bumpContentCacheVersion(c.env.DB),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  const seq = (event.results[0] as { seq: number }).seq;
  return json(200, {
    target: `${type}-${number}`, status, rule, rule_text: ruleText(rule), note, reason: why,
    moderator: { handle: p.account.handle, kind: p.account.kind, url: citizenPath(p.account.handle) },
    evidence_url: evidence, changed_at: at, event_seq: seq, log_url: moderationLogUrl(seq),
  });
}

export async function listActions(c: Ctx): Promise<Response> {
  staff(c);
  const limit = intParam(c.url, 'limit', 50, 1, 200);
  const before = intParam(c.url, 'before', 0, 0, Number.MAX_SAFE_INTEGER);
  const { results } = await c.env.DB.prepare(`SELECT m.number, m.action, m.target_type, m.target_ref, m.reason, m.rule, m.public_note AS note, m.details_json, m.created_at, a.handle AS actor_handle
    FROM moderation_actions m LEFT JOIN accounts a ON a.id = m.actor_id ${before ? 'WHERE m.number < ?' : ''} ORDER BY m.number DESC LIMIT ?`)
    .bind(...(before ? [before] : []), limit).all<any>();
  return json(200, { items: results.map(({ details_json, ...r }) => ({ ...r, details: details_json ? JSON.parse(details_json) : null })) });
}

// ---------- tags ----------

const TAG_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * POST /v1/admin/tags/{slug}/merge  {"into": "<slug>", "note": "public reason", "reason": "private staff note"}
 * Moves every post_tags row of the source tag to the target (a post that already has the target keeps one row),
 * marks the source `merged` with `merged_into` = target and re-points earlier merges into the source, so chains stay
 * one hop. Old /t/{source} pages 301 to /t/{target}; `?tag={source}` filters and new posts tagged {source} resolve to
 * the target. Public: a `tag.merged` entry in the moderation log and the change feed (note, @moderator, from, into).
 */
export async function mergeTag(c: Ctx): Promise<Response> {
  const p = staff(c);
  const from = decodeURIComponent(c.params[0]).toLowerCase();
  const body = await readJson(c.request);
  const into = typeof body.into === 'string' ? body.into.trim().toLowerCase() : '';
  if (!TAG_SLUG.test(into)) throw new HttpError(400, 'invalid_merge_target');
  if (into === from) throw new HttpError(400, 'invalid_merge_target', { reason: 'same_tag' });
  const note = publicNote(body);
  if (!note) throw new HttpError(400, 'note_required', { max_length: PUBLIC_NOTE_MAX });
  const why = reason(body, false);
  const [src, dst] = await Promise.all([
    c.env.DB.prepare('SELECT number, slug, status, merged_into FROM tags WHERE slug = ?').bind(from).first<{ number: number; slug: string; status: string; merged_into: string | null }>(),
    c.env.DB.prepare('SELECT number, slug, status FROM tags WHERE slug = ?').bind(into).first<{ number: number; slug: string; status: string }>(),
  ]);
  if (!src) throw new HttpError(404, 'tag_not_found', { slug: from });
  if (src.status === 'merged') throw new HttpError(409, 'tag_already_merged', { slug: from, merged_into: src.merged_into });
  if (!dst || dst.status !== 'active') throw new HttpError(404, 'tag_not_found', { slug: into });
  const moved = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM post_tags WHERE tag_slug = ?').bind(from).first<{ n: number }>())?.n ?? 0;
  const at = nowIso();
  const data = { rule: null, note, from, into, from_ref: `tag-${src.number}`, into_ref: `tag-${dst.number}`, posts_moved: moved };
  const db = c.env.DB;
  const [, , , , , event] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO post_tags (post_number, tag_slug) SELECT post_number, ? FROM post_tags WHERE tag_slug = ?').bind(into, from),
    db.prepare('DELETE FROM post_tags WHERE tag_slug = ?').bind(from),
    db.prepare("UPDATE tags SET merged_into = ? WHERE status = 'merged' AND merged_into = ?").bind(into, from),
    db.prepare("UPDATE tags SET status = 'merged', merged_into = ? WHERE slug = ?").bind(into, from),
    db.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, rule, public_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(p.account.id, 'tag.merge', 'tag', `tag-${src.number}`, why, JSON.stringify({ from, into, posts_moved: moved }), null, note, at),
    db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) VALUES ('tag.merged', 'tag', ?, ?, ?, ?) RETURNING seq")
      .bind(src.number, p.account.id, JSON.stringify(data), at),
    bumpContentCacheVersion(db),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  const seq = (event.results[0] as { seq: number }).seq;
  return json(200, {
    tag: { slug: from, ref: `tag-${src.number}`, status: 'merged', merged_into: into }, into: { slug: into, ref: `tag-${dst.number}` },
    posts_moved: moved, note, reason: why,
    moderator: { handle: p.account.handle, kind: p.account.kind, url: citizenPath(p.account.handle) },
    changed_at: at, event_seq: seq, log_url: moderationLogUrl(seq),
  });
}

/**
 * POST /v1/admin/tags/{slug}/archive  {"note": "public reason", "reason": "private staff note"}
 * For spam or abusive tags. Removes the tag from every post (post_tags rows deleted; the posts stay), marks it
 * `archived` so it leaves the catalog, its /t/ page and new posts (a post naming it gets 404 tag_not_found).
 * Not reversible through the API: an archived slug stays taken. Public: a `tag.archived` entry in the moderation log
 * and the change feed (note, @moderator, slug, ref, posts_untagged).
 */
export async function archiveTag(c: Ctx): Promise<Response> {
  const p = staff(c);
  const slug = decodeURIComponent(c.params[0]).toLowerCase();
  const body = await readJson(c.request);
  const note = publicNote(body);
  if (!note) throw new HttpError(400, 'note_required', { max_length: PUBLIC_NOTE_MAX });
  const why = reason(body, false);
  const tag = await c.env.DB.prepare('SELECT number, slug, status FROM tags WHERE slug = ?').bind(slug).first<{ number: number; slug: string; status: string }>();
  if (!tag) throw new HttpError(404, 'tag_not_found', { slug });
  if (tag.status !== 'active') throw new HttpError(409, 'tag_not_active', { slug, status: tag.status });
  const untagged = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM post_tags WHERE tag_slug = ?').bind(slug).first<{ n: number }>())?.n ?? 0;
  const at = nowIso();
  const data = { rule: null, note, slug, ref: `tag-${tag.number}`, posts_untagged: untagged };
  const db = c.env.DB;
  const [, , , event] = await db.batch([
    db.prepare('DELETE FROM post_tags WHERE tag_slug = ?').bind(slug),
    db.prepare("UPDATE tags SET status = 'archived' WHERE slug = ? AND status = 'active'").bind(slug),
    db.prepare('INSERT INTO moderation_actions (actor_id, action, target_type, target_ref, reason, details_json, rule, public_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(p.account.id, 'tag.archive', 'tag', `tag-${tag.number}`, why, JSON.stringify({ slug, posts_untagged: untagged }), null, note, at),
    db.prepare("INSERT INTO events (type, object_type, object_number, actor_id, data_json, created_at) VALUES ('tag.archived', 'tag', ?, ?, ?, ?) RETURNING seq")
      .bind(tag.number, p.account.id, JSON.stringify(data), at),
    bumpContentCacheVersion(db),
    // stored counters: full recount after a visibility/status change (src/counters.ts)
    ...(await recountStatements(c.env)),
  ]);
  const seq = (event.results[0] as { seq: number }).seq;
  return json(200, {
    tag: { slug, ref: `tag-${tag.number}`, status: 'archived' }, posts_untagged: untagged, note, reason: why,
    moderator: { handle: p.account.handle, kind: p.account.kind, url: citizenPath(p.account.handle) },
    changed_at: at, event_seq: seq, log_url: moderationLogUrl(seq),
  });
}
