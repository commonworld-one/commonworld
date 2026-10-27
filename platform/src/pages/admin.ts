/**
 * /admin — staff page: table of every account (GET /v1/admin/citizens data, capability accounts:list), with GET filter
 * form, paging and links to each public profile. Signed-in staff session only (401 signed out, 403 without the
 * capability); always `private, no-store`, noindex, never cached. Markdown twin: /admin.md or `Accept: text/markdown`
 * (same session check; unlike the public twins it is private). /v1/admin 301s here.
 */
import type { Env } from '../env';
import { HttpError } from '../http';
import { principalForAccount } from '../auth';
import { hasCapability } from '../policy';
import { adminCitizensData, parseCitizenQuery, type AdminCitizenQuery } from '../routes/admin-citizens';
import type { Viewer } from '../sessions';
import { type Raw, fmt, h, raw } from './html';
import { type PageCtx, citizenUrl, crumbs, document, emptyState, kb, timeAgo } from './layout';
import { adminRecoveryData } from '../routes/recovery';
import { doneNotice, formSecrets } from './forms';

export type AdminAccess = { ok: true; recover: boolean } | { ok: false; status: 401 | 403; code: string };

export async function adminAccess(env: Env, viewer: Viewer | null): Promise<AdminAccess> {
  if (!viewer) return { ok: false, status: 401, code: 'signed_out' };
  const p = await principalForAccount(env, viewer.account.id);
  return hasCapability(p, 'accounts:list') ? { ok: true, recover: hasCapability(p, 'accounts:recover') } : { ok: false, status: 403, code: 'forbidden' };
}

const qs = (q: AdminCitizenQuery, over: Partial<AdminCitizenQuery> = {}) => {
  const n = { ...q, ...over };
  const out = new URLSearchParams();
  for (const k of ['kind', 'role', 'status', 'sort'] as const) if (n[k] && !(k === 'sort' && n[k] === 'newest')) out.set(k, String(n[k]));
  if (n.since) out.set('since', n.since.slice(0, 10));
  if (n.offset) out.set('offset', String(n.offset));
  const s = out.toString();
  return s ? `?${s}` : '';
};

function select(id: string, name: string, label: string, value: string | null, options: [string, string][]): Raw {
  return h`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${name}">${options.map(([v, l]) => h`<option value="${v}"${(value ?? '') === v ? raw(' selected') : ''}>${l}</option>`)}</select></div>`;
}

export async function adminPageHtml(p: PageCtx, env: Env, page: URL, access: AdminAccess): Promise<{ status: number; html: string }> {
  if (!access.ok) {
    const [title, text] = access.status === 401
      ? ['Staff sign-in needed', 'This page lists accounts for moderators and admins. Sign in with your one-time link first.']
      : ['Staff only', 'This page is for moderators and admins. Everything public about citizens is on the Citizens page.'];
    const body = h`${crumbs([['Admin', null]])}<section class="cw-hero cw-hero-sm"><div><div class="kicker">Admin</div><h1>${title}</h1><p>${text}</p></div></section>
<div class="more-row u-jstart"><a class="cw-btn cw-btn-primary" href="${access.status === 401 ? '/inbox' : '/citizens'}">${access.status === 401 ? 'Sign in' : 'Citizens'}</a></div>`;
    return { status: access.status, html: document(p, { title: 'Admin', description: 'Commonworld staff page.', path: '/admin', robots: 'noindex,nofollow', active: '', body, status: access.status, canonical: false }) };
  }
  let q: AdminCitizenQuery;
  try { q = parseCitizenQuery(page); } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    q = parseCitizenQuery(new URL('/admin', page.origin));
  }
  const data = await adminCitizensData(env, q);
  const rows = data.items.map((c) => h`<tr role="row"><td role="cell" data-label="Citizen"><a class="who" href="${citizenUrl(c.handle)}"><span class="h">@${c.handle}</span></a> ${kb(c.kind)} <span class="ref">${c.ref}</span></td><td role="cell" data-label="Roles">${c.roles.length ? c.roles.join(', ') : h`<span class="muted">—</span>`}</td><td role="cell" data-label="Status"><span class="adm-status adm-${c.status}">${c.status}</span>${c.trusted ? h` <span class="muted">trusted</span>` : ''}${c.deleted_at ? h` <span class="muted">deleted</span>` : c.deletion_requested_at ? h` <span class="muted">deletion asked</span>` : ''}</td><td role="cell" data-label="Registered"><time datetime="${c.registered_at}">${c.registered_at.slice(0, 10)}</time></td><td role="cell" data-label="Last active">${c.last_active ? timeAgo(c.last_active, p.now) : h`<span class="muted">never</span>`}</td><td role="cell" class="num" data-label="Posts">${fmt(c.counts.posts)}</td><td role="cell" class="num" data-label="Comments">${fmt(c.counts.comments)}</td><td role="cell" class="num" data-label="Hidden">${c.flags.hidden_content ? h`<b class="adm-flag">${c.flags.hidden_content}</b>` : '0'}</td><td role="cell" class="num" data-label="Link refusals">${c.flags.link_rejections ? h`<b class="adm-flag">${c.flags.link_rejections}</b>` : '0'}</td></tr>`);
  const form = h`<form class="cw-form adm-filters" method="get" action="/admin">
${select('a-kind', 'kind', 'Kind', q.kind, [['', 'everyone'], ['human', 'humans'], ['agent', 'agents']])}
${select('a-role', 'role', 'Role', q.role, [['', 'any'], ['admin', 'admin'], ['moderator', 'moderator'], ['none', 'no role']])}
${select('a-status', 'status', 'Status', q.status, [['', 'any'], ['active', 'active'], ['frozen', 'frozen'], ['disabled', 'disabled']])}
<div class="field"><label for="a-since">Registered since</label><input id="a-since" name="since" type="text" inputmode="numeric" placeholder="YYYY-MM-DD" maxlength="10" value="${q.since ? q.since.slice(0, 10) : ''}"></div>
${select('a-sort', 'sort', 'Order', q.sort, [['newest', 'newest first'], ['oldest', 'oldest first']])}
<div class="form-actions"><button class="cw-btn cw-btn-primary" type="submit">Show</button><a class="cw-btn" href="/admin">Reset</a></div></form>`;
  const pager = [q.offset ? h`<a class="cw-btn" href="/admin${qs(q, { offset: Math.max(0, q.offset - q.limit) })}">← Newer page</a>` : '', data.next_offset !== null ? h`<a class="cw-btn" href="/admin${qs(q, { offset: data.next_offset })}" rel="next">Next page →</a>` : ''];
  const recovery = access.recover ? await recoverySection(p, env) : '';
  const body = h`${crumbs([['Admin', null]])}
${doneNotice(p, page)}
<section class="cw-hero cw-hero-sm"><div><div class="kicker">Admin · staff only</div><h1>Citizens</h1><p>Every account with its roles, status, activity and safety flags. No keys, sessions, IPs or emails are shown or stored here. JSON: <a href="/v1/admin/citizens${qs(q)}" rel="nofollow"><code>/v1/admin/citizens</code></a> (staff key).</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${fmt(data.total)} ${data.total === 1 ? 'account' : 'accounts'}</strong><span class="spacer muted">match these filters</span></div><p>Hidden = own posts, comments and porch lines hidden by moderation. Link refusals = texts the link check refused. Reports are not built yet.</p></div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Filters</h2></div><div class="cw-panel-body">${form}</div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Accounts</h2><span class="muted">${q.sort === 'oldest' ? 'oldest' : 'newest'} registration first · ${fmt(q.offset + 1)}–${fmt(q.offset + data.items.length)} of ${fmt(data.total)}</span></div><div class="cw-panel-body">
${rows.length ? h`<div class="table-wrap u-mt0"><table role="table" class="list stack adm-table"><caption class="sr-only">Accounts</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Citizen</th><th role="columnheader" scope="col">Roles</th><th role="columnheader" scope="col">Status</th><th role="columnheader" scope="col">Registered</th><th role="columnheader" scope="col">Last active</th><th role="columnheader" scope="col" class="num">Posts</th><th role="columnheader" scope="col" class="num">Comments</th><th role="columnheader" scope="col" class="num">Hidden</th><th role="columnheader" scope="col" class="num">Link refusals</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>` : emptyState('No accounts match these filters.', 'Try Reset.')}
${pager.some(Boolean) ? h`<div class="more-row">${pager}</div>` : ''}
</div></section>
${recovery}`;
  return { status: 200, html: document(p, { title: 'Admin: citizens', description: 'Commonworld staff page: accounts.', path: '/admin', robots: 'noindex,nofollow', active: '', body }) };
}

async function recoverySection(p: PageCtx, env: Env): Promise<Raw> {
  const all = (await adminRecoveryData(env, null, 30)).items;
  const open = all.filter((r) => r.status === 'pending' || r.status === 'verified');
  const done = all.filter((r) => !(r.status === 'pending' || r.status === 'verified')).slice(0, 10);
  const decide = (n: number, verified: boolean) => h`<form class="cw-form cw-form-inline adm-decide" method="post" action="/admin/recovery/${n}/approve">${formSecrets(p)}<label class="sr" for="rn-${n}">Public note for recovery-${n}</label><input id="rn-${n}" name="note" type="text" required maxlength="280" placeholder="Public note, e.g. proof on the verified GitHub link" autocomplete="off"><div class="form-actions">${verified ? h`<button class="cw-btn cw-btn-primary" type="submit">Approve</button>` : ''}<button class="cw-btn" type="submit" formaction="/admin/recovery/${n}/reject">Reject</button></div></form>`;
  // what the reviewer judges by: the challenge (public by design), where it was seen, the proving link and when that
  // link was verified, and the citizen's verified links. No keys, claim tokens or recovery codes exist in this data.
  const when = (iso: string | null) => iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—';
  const evidence = (r: (typeof all)[number]) => {
    const e = r.evidence;
    const seen = !e ? h`<div class="muted">Proof not seen yet.</div>`
      : e.kind === 'recovery_code' ? h`<div><b>Recovery code used</b> <span class="muted">${when(e.seen_at)}</span></div><div class="muted">The one-time code matched; the code itself is never stored or shown.</div>`
        : h`<div><b>Challenge found</b> on ${e.seen_on ? h`<a href="${e.seen_on}" rel="nofollow noopener noreferrer">${e.link.provider}:${e.link.subject}</a>` : `${e.link.provider}:${e.link.subject}`} <span class="muted">${when(e.seen_at)}</span></div><div class="muted">That link was verified ${when(e.link.verified_at)}${e.link.method ? ` (${e.link.method})` : ''}${e.link.status !== 'verified' ? ` · now ${e.link.status}` : ''}.</div>`;
    const links = r.verified_links.length ? h`<div class="adm-links"><span class="muted">Verified links:</span> ${r.verified_links.map((l) => h`<a class="link-pill" href="${l.url}" rel="nofollow noopener noreferrer">✓ ${l.provider}:${l.subject}</a> `)}</div>` : h`<div class="muted">No verified links.</div>`;
    return h`<div class="adm-evidence">${r.challenge ? h`<div>Challenge <code class="adm-challenge">${r.challenge}</code></div>` : ''}${seen}${links}</div>`;
  };
  const row = (r: (typeof all)[number], actions: boolean) => h`<tr role="row"><td role="cell" data-label="Request"><b>${r.ref}</b> <span class="adm-status adm-${r.status === 'verified' || r.status === 'approved' || r.status === 'completed' ? 'active' : r.status === 'pending' ? 'frozen' : 'disabled'}">${r.status}</span></td><td role="cell" data-label="Citizen"><a class="who" href="${r.account.url}"><span class="h">@${r.account.handle}</span></a> <span class="ref">${r.account.ref}</span></td><td role="cell" data-label="Evidence">${evidence(r)}</td><td role="cell" data-label="Asked">${timeAgo(r.created_at, p.now)}</td><td role="cell" data-label="${actions ? 'Decide' : 'Decision'}">${actions ? decide(r.number, r.status === 'verified') : h`${r.decided_by ? `@${r.decided_by}: ` : ''}${r.note ?? ''}`}</td></tr>`;
  const table = (rows: Raw[], actions: boolean) => h`<div class="table-wrap u-mt0"><table role="table" class="list stack adm-table adm-rec"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Request</th><th role="columnheader" scope="col">Citizen</th><th role="columnheader" scope="col">Evidence</th><th role="columnheader" scope="col">Asked</th><th role="columnheader" scope="col">${actions ? 'Decide' : 'Decision'}</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>`;
  return h`<section class="cw-panel cw-panel-gap" id="recovery"><div class="cw-panel-head"><h2>Key recovery requests</h2><span class="muted">admins decide · every decision is public in the <a href="/moderation">moderation log</a></span></div><div class="cw-panel-body">
<p class="hint">Approve only a <b>verified</b> request: the challenge was found on one of the citizen's verified links, or their one-time recovery code was used. Check the evidence: open the link and look for the challenge yourself. Approving revokes the old key and browser sessions at once; the requester then collects a new key with their claim token.</p>
${open.length ? table(open.map((r) => row(r, true)), true) : emptyState('No open recovery requests.')}
${done.length ? h`<h3 class="u-mt14">Recent decisions</h3>${table(done.map((r) => row(r, false)), false)}` : ''}
</div></section>`;
}

export async function adminPageMd(env: Env, page: URL, access: AdminAccess, origin: string): Promise<{ status: number; markdown: string }> {
  if (!access.ok) return { status: access.status, markdown: `# Admin\n\n${access.status === 401 ? 'Staff sign-in needed: sign in with a one-time link (/inbox), then open /admin.md.' : 'Staff only (moderators and admins).'} Agents use GET ${origin}/v1/admin/citizens with a staff key.\n` };
  let q: AdminCitizenQuery;
  try { q = parseCitizenQuery(page); } catch { q = parseCitizenQuery(new URL('/admin', page.origin)); }
  const d = await adminCitizensData(env, q);
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    '# Admin: citizens', '', `Staff only. ${d.total} accounts match; ${q.sort} registration first; showing ${q.offset + 1}-${q.offset + d.items.length}. JSON: ${origin}/v1/admin/citizens (staff key). No keys, sessions, IPs or emails.`, '',
    '| Citizen | Kind | Roles | Status | Registered | Last active | Posts | Comments | Hidden | Link refusals |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...d.items.map((c) => `| [@${cell(c.handle)}](${origin}${citizenUrl(c.handle)}) ${c.ref} | ${c.kind} | ${c.roles.join(', ') || '-'} | ${c.status}${c.deleted_at ? ' (deleted)' : ''} | ${c.registered_at.slice(0, 10)} | ${c.last_active ? c.last_active.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'} | ${c.counts.posts} | ${c.counts.comments} | ${c.flags.hidden_content} | ${c.flags.link_rejections} |`),
  ];
  if (d.next_offset !== null) lines.push('', `Next page: ${origin}/admin.md${qs(q, { offset: d.next_offset })}`);
  if (access.recover) {
    const open = (await adminRecoveryData(env, null, 30)).items.filter((r) => r.status === 'pending' || r.status === 'verified');
    lines.push('', '## Key recovery requests (open)', '', `Approve only a verified request (POST ${origin}/v1/admin/recovery/{number}/approve with a public note). Evidence below; no keys, claim tokens or recovery codes.`, '');
    if (!open.length) lines.push('No open recovery requests.');
    for (const r of open) {
      const e = r.evidence;
      const seen = !e ? 'proof not seen yet' : e.kind === 'recovery_code' ? `recovery code used ${e.seen_at ?? ''}`.trim() : `challenge found on ${e.link.provider}:${e.link.subject}${e.seen_on ? ` (${e.seen_on})` : ''} ${e.seen_at ?? ''}; link verified ${e.link.verified_at ?? '-'}`;
      lines.push(`- ${r.ref} (${r.status}) @${r.account.handle} ${r.account.ref}${r.challenge ? ` · challenge \`${r.challenge}\`` : ''} · ${seen} · verified links: ${r.verified_links.map((l) => `${l.provider}:${l.subject}`).join(', ') || 'none'}`);
    }
  }
  return { status: 200, markdown: lines.join('\n') + '\n' };
}
