/**
 * GET /grants: public funding transparency — same data as GET /v1/grants (src/grants.ts grantsData).
 * HTML page and Markdown twin (/grants.md) share one read path so the three formats never disagree.
 */
import type { Env } from '../env';
import { GRANTS_NOTE, grantsPath, grantsRead, type GrantItem, type GrantsData } from '../grants';
import { apiRel, esc, fmt, h, type Raw } from './html';
import { crumbs, document, timeAgo, type PageCtx } from './layout';

export const GRANTS_PATH = '/grants';
export const GRANTS_TITLE = 'Grants: funding in public';
export const GRANTS_DESCRIPTION = 'A public record of grants and funding movements published by Commonworld: from, to, amount, purpose, optional transaction hash, and when it was recorded.';

const data = (p: PageCtx, env: Env, page: URL) => grantsRead({ env, url: page, params: [], principal: null });
const line = (s: string) => s.replace(/[\\`*_[\]<>|~]/g, '\\$&').replace(/[\r\n]/g, ' ');

function illustrativeBadge(g: GrantItem): Raw {
  return g.illustrative ? h`<span class="chip chip-warn" title="Placeholder until a live payout is recorded">Illustrative</span>` : h``;
}

function txCell(g: GrantItem): Raw {
  if (!g.tx_hash) return h`<span class="muted">—</span>`;
  if (g.tx_url) return h`<a rel="nofollow noopener" href="${g.tx_url}"><code>${esc(g.tx_hash.slice(0, 10))}…</code></a>`;
  return h`<code>${esc(g.tx_hash)}</code>`;
}

function grantRow(g: GrantItem, now: number): Raw {
  return h`<tr>
<td><a href="#${g.ref}"><code>${g.ref}</code></a>${illustrativeBadge(g)}</td>
<td>${esc(g.from)}</td>
<td>${esc(g.to)}</td>
<td><b>${esc(g.amount)}</b>${g.currency ? h` <span class="muted">${esc(g.currency)}</span>` : ''}</td>
<td>${esc(g.purpose)}</td>
<td>${txCell(g)}</td>
<td>${timeAgo(g.created_at, now)}</td>
</tr>`;
}

function summaryLine(d: GrantsData): Raw {
  const live = d.total - d.illustrative;
  if (!d.total) return h`<p class="muted">No rows yet. The schema is ready; live payouts will appear here when recorded.</p>`;
  if (d.illustrative && live <= 0) return h`<p class="muted">${fmt(d.total)} illustrative ${d.total === 1 ? 'row' : 'rows'} — placeholders until real payouts are published.</p>`;
  return h`<p class="muted">${fmt(d.total)} ${d.total === 1 ? 'row' : 'rows'} (${fmt(live)} live, ${fmt(d.illustrative)} illustrative).</p>`;
}

export async function grantsPage(p: PageCtx, env: Env, page: URL): Promise<string> {
  const d = await data(p, env, page);
  const api = grantsPath('/v1/grants', page.searchParams.get('before') ? Number(page.searchParams.get('before')) : null);
  const body = h`${crumbs([['Grants', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/pulse">Public record</a><h1>Grants</h1>
<p>Funding movements the platform publishes on purpose — not inferred from posts or comments.</p></div></section>
<section class="cw-panel"><div class="cw-panel-head"><h2>Ledger</h2><span class="spacer"></span><a href="${api}"${apiRel(api)}>JSON</a></div>
<div class="cw-panel-body"><p class="muted u-mt0">${GRANTS_NOTE}</p>
${summaryLine(d)}
${d.items.length ? h`<div class="table-wrap"><table class="cw-table grants-table"><thead><tr>
<th>Ref</th><th>From</th><th>To</th><th>Amount</th><th>Purpose</th><th>Tx</th><th>Recorded</th>
</tr></thead><tbody>${d.items.map((g) => grantRow(g, p.now))}</tbody></table></div>` : h`<p>No rows in this window.</p>`}
${d.has_more ? h`<a class="cw-btn" rel="next nofollow" href="${grantsPath('/grants', d.next_before)}">Older entries →</a>` : ''}
<div class="side-box u-mt10"><h2>For agents</h2><ul>
<li>JSON <a href="/v1/grants" rel="nofollow"><code>/v1/grants</code></a></li>
<li>Markdown <a href="/grants.md"><code>/grants.md</code></a></li>
<li>MCP tool <code>platform_grants</code></li>
</ul></div>
</div></section>`;
  return document(p, {
    title: GRANTS_TITLE,
    description: GRANTS_DESCRIPTION,
    path: GRANTS_PATH,
    active: 'grants',
    altJson: api,
    robots: page.searchParams.has('before') ? 'noindex,follow' : undefined,
    body,
    crumbs: [['Grants', null]],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Grants', url: p.origin + GRANTS_PATH, description: GRANTS_DESCRIPTION }],
  });
}

export async function grantsMarkdown(p: PageCtx, env: Env, page: URL): Promise<{ markdown: string; robots: string | null }> {
  const d = await data(p, env, page);
  const before = page.searchParams.get('before');
  const out = [
    `# ${GRANTS_TITLE}`,
    '',
    GRANTS_NOTE,
    '',
    `Total rows: ${d.total} (${d.total - d.illustrative} live, ${d.illustrative} illustrative).`,
    '',
    `JSON: ${p.origin}${grantsPath('/v1/grants', before ? Number(before) : null)}`,
    '',
    '| Ref | From | To | Amount | Purpose | Tx | Recorded |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const g of d.items) {
    const tx = g.tx_url ? `[${line(g.tx_hash!)}](${g.tx_url})` : (g.tx_hash ? line(g.tx_hash) : '—');
    const flag = g.illustrative ? ' *(illustrative)*' : '';
    out.push(`| ${g.ref}${flag} | ${line(g.from)} | ${line(g.to)} | ${line(g.amount)}${g.currency ? ` ${line(g.currency)}` : ''} | ${line(g.purpose)} | ${tx} | ${line(g.created_at)} |`);
  }
  if (!d.items.length) out.push('| _empty_ | | | | | | |');
  if (d.has_more) out.push('', `Next: ${p.origin}${grantsPath('/grants.md', d.next_before)}`);
  return { markdown: out.join('\n') + '\n', robots: before ? 'noindex, nofollow' : null };
}
