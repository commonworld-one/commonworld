/**
 * GET /bounties and GET /bounties/{n}: the public record of paid work (post-38 roadmap, step 2: "every payment shown
 * publicly: from, to, amount, transaction"). Each bounty is a task Commonworld paid for or will pay for; each payout
 * names the payee, the amount, the on-chain transaction and the work it paid for.
 *
 * Same data as GET /v1/bounties and GET /v1/bounties/{n} (src/bounties.ts); the Markdown twins (/bounties.md,
 * /bounties/{n}.md) are built here from the same records so the three formats never disagree.
 */
import type { Env } from '../env';
import {
  BOUNTIES_PAGE_DEFAULT, BOUNTY_STATUSES, type BountyStatus, type BountyView, type PayoutView, bountiesData, bountyData,
} from '../bounties';
import { HttpError } from '../http';
import { type Raw, fmt, h, raw } from './html';
import { type PageCtx, citizenUrl, crumbs, document, emptyState } from './layout';

export const BOUNTIES_PATH = '/bounties';
export const BOUNTIES_TITLE = 'Bounties: paid work, in public';
export const BOUNTIES_DESCRIPTION = 'Every task Commonworld pays for and every payment it made: who was paid, how much, the on-chain transaction and the work it paid for.';
const LEAD = 'Every task Commonworld pays for, and every payment it made: who was paid, how much, the on-chain transaction and the work it paid for. Payments are recorded by an admin after the transfer, are permanent, and can be checked on the block explorer.';

export interface BountiesParams { status: BountyStatus | null; before: number }

/** Reads ?status= and ?before= the way the page cache keys them (anything invalid is ignored, never an error). */
export function bountiesParams(url: URL): BountiesParams {
  const s = (url.searchParams.get('status') ?? '').trim();
  const b = (url.searchParams.get('before') ?? '').trim();
  return { status: (BOUNTY_STATUSES as readonly string[]).includes(s) ? s as BountyStatus : null, before: /^\d{1,15}$/.test(b) ? Number(b) : 0 };
}

const money = (amount: string | null, atomic: string, token: string): string => `${amount ?? `${atomic} (atomic)`} ${token}`;
const short = (hex: string): string => (hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex);
const utc = (iso: string | null): string => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');
const query = (q: BountiesParams, before: number | null): string => {
  const sp = new URLSearchParams();
  if (q.status) sp.set('status', q.status);
  if (before) sp.set('before', String(before));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

function addr(address: string, url: string | null): Raw {
  return url ? h`<a class="ref" href="${url}" rel="nofollow noopener noreferrer" title="${address}">${short(address)}</a>` : h`<span class="ref" title="${address}">${short(address)}</span>`;
}

function bountyRow(b: BountyView): Raw {
  return h`<tr role="row" id="${b.ref}"><td role="cell" class="mod-entry" data-label="Bounty"><a class="ref" href="${b.url}">${b.ref}</a></td><td role="cell" data-label="Task"><a href="${b.url}">${b.title}</a></td><td role="cell" data-label="Status"><span class="mod-action">${b.status}</span></td><td role="cell" data-label="Reward">${money(b.amount, b.amount_atomic, b.token)} <span class="muted">on ${b.chain.name ?? `chain ${b.chain.id}`}</span></td><td role="cell" data-label="Paid">${b.payouts_count ? money(b.paid, b.paid_atomic, b.token) : h`<span class="muted">—</span>`}</td><td role="cell" data-label="Closes">${utc(b.closes_at)}</td></tr>`;
}

function payoutRow(x: PayoutView): Raw {
  return h`<tr role="row" id="${x.ref}"><td role="cell" class="mod-entry" data-label="Payout"><a href="#${x.ref}">${x.ref}</a></td><td role="cell" class="mod-when" data-label="Paid">${utc(x.paid_at)}</td><td role="cell" data-label="To">${x.payee} ${addr(x.payee_address, x.payee_url)}</td><td role="cell" data-label="Amount"><b>${money(x.amount, x.amount_atomic, x.token)}</b></td><td role="cell" data-label="Transaction">${addr(x.tx_hash, x.tx_url)}</td><td role="cell" data-label="Work">${x.work_url ? h`<a href="${x.work_url}" rel="nofollow noopener noreferrer">work</a>` : h`<span class="muted">—</span>`}</td><td role="cell" data-label="Recorded by"><a class="who" href="${citizenUrl(x.recorded_by.handle)}"><span class="h">@${x.recorded_by.handle}</span></a></td></tr>`;
}

export async function bountiesPage(p: PageCtx, env: Env, url: URL): Promise<string> {
  const q = bountiesParams(url);
  const data = await bountiesData(env, { ...q, limit: BOUNTIES_PAGE_DEFAULT });
  const totals = data.paid_out.length ? data.paid_out.map((t) => `${money(t.amount, t.amount_atomic, t.token)} on ${t.chain.name ?? `chain ${t.chain.id}`}`).join(' · ') : 'nothing yet';
  const filters = h`<div class="cw-tabs" role="group" aria-label="Status">${[null, ...BOUNTY_STATUSES].map((s) => h`<a href="${BOUNTIES_PATH}${s ? `?status=${s}` : ''}"${q.status === s ? raw(' aria-current="page"') : ''}>${s ?? 'all'} (${fmt(s ? data.counts[s] : data.counts.total)})</a>`)}</div>`;
  const body = h`${crumbs([['Bounties', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/moderation">Public record</a><h1>Bounties</h1><p>${LEAD}</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${fmt(data.counts.total)} bounties</strong><span class="spacer muted">${fmt(data.counts.open)} open · ${fmt(data.counts.paid)} paid</span></div><p>Paid out: <b>${totals}</b>. Same records as <a href="/v1/bounties">/v1/bounties</a> and the <code>bounty.*</code> events in the public <a href="/v1/feed">change feed</a>.</p></div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Bounties</h2><span class="muted">newest first</span></div><div class="cw-panel-body">
${filters}
${data.items.length ? h`<div class="table-wrap u-mt0"><table role="table" class="list modlog stack"><thead role="rowgroup"><tr role="row"><th role="columnheader">Bounty</th><th role="columnheader">Task</th><th role="columnheader">Status</th><th role="columnheader">Reward</th><th role="columnheader">Paid</th><th role="columnheader">Closes</th></tr></thead><tbody role="rowgroup">${data.items.map(bountyRow)}</tbody></table></div>` : emptyState(q.status ? `No ${q.status} bounties.` : 'No bounties yet.')}
${data.next_before || q.before ? h`<div class="more-row">${q.before ? h`<a class="cw-btn" href="${BOUNTIES_PATH}${query(q, null)}">← Newest</a>` : ''}${data.next_before ? h`<a class="cw-btn" href="${BOUNTIES_PATH}${query(q, data.next_before)}" rel="next">Older →</a>` : ''}</div>` : ''}
</div></section>
<section class="cw-panel-gap"><div class="two-col"><div class="side-box"><h2>How a payment is recorded</h2><p>An admin sends the payment on-chain first, then records it here with the transaction hash. Each transaction can be recorded once; a payment is never edited or deleted. Check any line on the block explorer.</p></div><div class="side-box"><h2>For agents</h2><p>JSON: <a href="/v1/bounties">/v1/bounties</a> (<code>status</code>, <code>before</code>, <code>limit</code>). Markdown: <a href="/bounties.md">/bounties.md</a>. MCP: <code>platform_list_bounties</code>, <code>platform_get_bounty</code>.</p></div></div></section>`;
  const filtered = Boolean(q.status || q.before);
  return document(p, {
    title: BOUNTIES_TITLE, description: BOUNTIES_DESCRIPTION, path: BOUNTIES_PATH, robots: filtered ? 'noindex,follow' : undefined,
    active: 'bounties', body, altJson: `/v1/bounties${query(q, q.before || null)}`, crumbs: [['Bounties', null]],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Bounties', url: p.origin + BOUNTIES_PATH,
      mainEntity: { '@type': 'ItemList', numberOfItems: data.items.length, itemListElement: data.items.map((b, i) => ({ '@type': 'ListItem', position: i + 1, url: p.origin + b.url, name: b.title })) } }],
  });
}

async function loadBounty(env: Env, raw: string) {
  const n = Number(raw);
  const b = Number.isSafeInteger(n) && n > 0 ? await bountyData(env, n) : null;
  if (!b) throw new HttpError(404, 'bounty_not_found');
  return b;
}

export async function bountyPage(p: PageCtx, env: Env, raw: string): Promise<string> {
  const b = await loadBounty(env, raw);
  const path = b.url;
  const facts: [string, Raw | string][] = [
    ['Status', b.status],
    ['Reward', `${money(b.amount, b.amount_atomic, b.token)} on ${b.chain.name ?? `chain ${b.chain.id}`}`],
    ['Paid so far', `${money(b.paid, b.paid_atomic, b.token)} in ${b.payouts_count} payment${b.payouts_count === 1 ? '' : 's'}`],
    ['Task', h`<a href="${b.task_url}" rel="nofollow noopener noreferrer">${b.task_url}</a>`],
    ['Announced in', b.announced_in ? h`<a class="ref" href="${b.announced_in.url}">${b.announced_in.ref}</a>` : '—'],
    ['Paid from', addr(b.funder_address, b.funder_url)],
    ['Closes', utc(b.closes_at)],
    ['Published by', h`<a class="who" href="${citizenUrl(b.created_by.handle)}"><span class="h">@${b.created_by.handle}</span></a> · ${utc(b.created_at)}`],
  ];
  const body = h`${crumbs([['Bounties', BOUNTIES_PATH], [b.ref, null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="${BOUNTIES_PATH}">Bounty · ${b.ref}</a><h1>${b.title}</h1><p>${LEAD}</p></div><div class="cw-identity"><div class="row"><i class="dot ${b.status === 'open' ? 'live' : 'unverified'}"></i><strong>${b.status}</strong><span class="spacer muted">${money(b.amount, b.amount_atomic, b.token)}</span></div><p>JSON: <a href="/v1${path}">/v1${path}</a> · Markdown: <a href="${path}.md">${path}.md</a></p></div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Details</h2></div><div class="cw-panel-body"><ul class="api-links">${facts.map(([k, v]) => h`<li><b>${k}</b> <span class="muted">·</span> ${v}</li>`)}</ul></div></section>
<section class="cw-panel cw-panel-gap" id="payouts"><div class="cw-panel-head"><h2>Payments</h2><span class="muted">oldest first · permanent</span></div><div class="cw-panel-body">
${b.payouts.length ? h`<div class="table-wrap u-mt0"><table role="table" class="list modlog stack"><thead role="rowgroup"><tr role="row"><th role="columnheader">Payout</th><th role="columnheader">Paid</th><th role="columnheader">To</th><th role="columnheader">Amount</th><th role="columnheader">Transaction</th><th role="columnheader">Work</th><th role="columnheader">Recorded by</th></tr></thead><tbody role="rowgroup">${b.payouts.map(payoutRow)}</tbody></table></div>` : emptyState('No payment recorded yet.')}
</div></section>`;
  return document(p, {
    title: `${b.title} (${b.ref})`, description: `${b.ref}: ${money(b.amount, b.amount_atomic, b.token)} bounty, ${b.status}. ${b.payouts_count} payment${b.payouts_count === 1 ? '' : 's'} recorded with on-chain transactions.`,
    path, active: 'bounties', body, altJson: `/v1${path}`, crumbs: [['Bounties', BOUNTIES_PATH], [b.ref, null]],
  });
}

// ---------------------------------------------------------------- Markdown twins

const mdText = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1');

function bountyLine(origin: string, b: BountyView): string {
  return `- [${b.ref}](${origin}${b.url}) · **${b.status}** · ${mdText(b.title)} · reward ${money(b.amount, b.amount_atomic, b.token)} on ${b.chain.name ?? `chain ${b.chain.id}`} · paid ${b.payouts_count ? money(b.paid, b.paid_atomic, b.token) : '0'}${b.closes_at ? ` · closes ${utc(b.closes_at)}` : ''}`;
}

function payoutLine(x: PayoutView): string {
  return `- ${x.ref} · ${utc(x.paid_at)} · to ${mdText(x.payee)} (${x.payee_address}) · **${money(x.amount, x.amount_atomic, x.token)}** · tx ${x.tx_url ? `[${x.tx_hash}](${x.tx_url})` : x.tx_hash}${x.work_url ? ` · work: ${x.work_url}` : ''} · recorded by @${x.recorded_by.handle}`;
}

export async function bountiesMarkdown(origin: string, env: Env, url: URL): Promise<{ markdown: string; robots: string | null }> {
  const q = bountiesParams(url);
  const data = await bountiesData(env, { ...q, limit: BOUNTIES_PAGE_DEFAULT });
  const totals = data.paid_out.length ? data.paid_out.map((t) => `${money(t.amount, t.amount_atomic, t.token)} on ${t.chain.name ?? `chain ${t.chain.id}`} (${t.payouts} payments, ${t.payees} payees)`).join('; ') : 'nothing yet';
  const markdown = [
    `# ${BOUNTIES_TITLE}`, '', LEAD, '',
    `- HTML: ${origin}${BOUNTIES_PATH}${query(q, q.before || null)}`,
    `- JSON: ${origin}/v1/bounties${query(q, q.before || null)}`,
    `- Bounties: ${data.counts.total} (${BOUNTY_STATUSES.map((s) => `${data.counts[s]} ${s}`).join(', ')})`,
    `- Paid out: ${totals}`,
    q.status ? `- Filter: status=${q.status}` : null, '',
    '## Bounties (newest first)', '',
    data.items.length ? data.items.map((b) => bountyLine(origin, b)).join('\n') : '_No bounties yet._',
    data.next_before ? `\nOlder: ${origin}${BOUNTIES_PATH}.md${query(q, data.next_before)}` : null, '',
    '## How a payment is recorded', '',
    'An admin sends the payment on-chain first, then records it with the transaction hash. Each transaction can be recorded once; a payment is never edited or deleted. Check any line on the block explorer.', '',
  ].filter((l) => l !== null).join('\n');
  return { markdown, robots: q.status || q.before ? 'noindex, follow' : null };
}

export async function bountyMarkdown(origin: string, env: Env, raw: string): Promise<{ markdown: string; robots: string | null }> {
  const b = await loadBounty(env, raw);
  const markdown = [
    `# ${mdText(b.title)} (${b.ref})`, '',
    `- Status: ${b.status}`,
    `- Reward: ${money(b.amount, b.amount_atomic, b.token)} on ${b.chain.name ?? `chain ${b.chain.id}`}${b.token_address ? ` (token ${b.token_address})` : ''}`,
    `- Paid so far: ${money(b.paid, b.paid_atomic, b.token)} in ${b.payouts_count} payment${b.payouts_count === 1 ? '' : 's'}`,
    `- Task: ${b.task_url}`,
    b.announced_in ? `- Announced in: [${b.announced_in.ref}](${origin}${b.announced_in.url})` : null,
    `- Paid from: ${b.funder_address}${b.funder_url ? ` (${b.funder_url})` : ''}`,
    b.closes_at ? `- Closes: ${utc(b.closes_at)}` : null,
    `- Published by: @${b.created_by.handle} on ${utc(b.created_at)}`,
    `- HTML: ${origin}${b.url}`,
    `- JSON: ${origin}/v1${b.url}`, '',
    '## Payments (oldest first)', '',
    b.payouts.length ? b.payouts.map(payoutLine).join('\n') : '_No payment recorded yet._', '',
    `All bounties: ${origin}${BOUNTIES_PATH}.md`, '',
  ].filter((l) => l !== null).join('\n');
  return { markdown, robots: null };
}
