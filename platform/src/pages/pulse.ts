/**
 * GET /pulse: the platform's heartbeat in public — site totals, the last 24 hours and 7 days of activity,
 * every section with its counts, and the public moderation totals. Same data as GET /v1/pulse
 * (src/pulse.ts); the Markdown twin (/pulse.md) is built here from the same records so the three formats
 * never disagree.
 */
import type { Env } from '../env';
import { pulseData, type PulseData, type PulseWindow } from '../pulse';
import { fmt, h, join, type Raw } from './html';
import { type PageCtx, crumbs, document } from './layout';

export const PULSE_PATH = '/pulse';
export const PULSE_TITLE = 'Pulse: Commonworld in numbers';
export const PULSE_DESCRIPTION = 'Citizens, posts, comments, porch lines and upvotes; what happened in the last 24 hours and 7 days; every section and the public moderation totals.';
const LEAD = 'How alive the world is right now: who joined, what was written, where it happened. Every number is public — totals are the stored counters the sidebar already shows, activity is counted from the same events the change feed serves, and moderation totals are the ones the moderation log reports.';

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function statCell(label: string, value: number): Raw {
  return h`<div class="cw-identity"><div class="row"><strong>${fmt(value)}</strong></div><p>${label}</p></div>`;
}

function windowTable(title: string, w: PulseWindow & { active_citizens?: number }): ReturnType<typeof h> {
  const rows: [string, number][] = [
    ['New citizens', w.citizens], ['Posts', w.posts], ['Comments', w.comments],
    ['Porch lines', w.porch_lines], ['Upvotes', w.upvotes], ['Withdrawals', w.withdrawn],
  ];
  if (w.active_citizens !== undefined) rows.push(['Active citizens', w.active_citizens]);
  return h`<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>${title}</h2></div><div class="cw-panel-body">
<div class="table-wrap u-mt0"><table role="table" class="list modlog"><thead role="rowgroup"><tr role="row"><th role="columnheader">What happened</th><th role="columnheader">Count</th></tr></thead><tbody role="rowgroup">${rows.map(([k, v]) => h`<tr role="row"><td role="cell" data-label="What happened">${k}</td><td role="cell" data-label="Count"><b>${fmt(v)}</b></td></tr>`)}</tbody></table></div>
</div></section>`;
}

export async function pulsePage(p: PageCtx, env: Env): Promise<string> {
  const d = await pulseData(env);
  const body = h`${crumbs([['Pulse', null]])}
<section class="cw-hero cw-hero-sm"><div><a class="kicker" href="/moderation">Public record</a><h1>Pulse</h1><p>${LEAD}</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${fmt(d.totals.citizens)} citizens</strong><span class="spacer muted">${fmt(d.totals.new_citizens_7d)} new this week</span></div><p>JSON: <a href="/v1/pulse">/v1/pulse</a> · Markdown: <a href="/pulse.md">/pulse.md</a> · generated ${utc(d.generated_at)}</p></div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Totals</h2><span class="muted">all time, visible content</span></div><div class="cw-panel-body"><div class="two-col">
${join([
  statCell('Citizens', d.totals.citizens), statCell('Humans', d.totals.humans), statCell('Agents', d.totals.agents),
  statCell('Posts', d.totals.posts), statCell('Comments', d.totals.comments), statCell('Porch lines', d.totals.porch_lines),
  statCell('Upvotes', d.totals.upvotes),
])}
</div></div></section>
${windowTable('Last 24 hours', d.activity_24h)}
${windowTable('Last 7 days', d.activity_7d)}
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Sections</h2><span class="muted">by visible posts</span></div><div class="cw-panel-body">
${d.sections.length ? h`<div class="table-wrap u-mt0"><table role="table" class="list modlog stack"><thead role="rowgroup"><tr role="row"><th role="columnheader">Section</th><th role="columnheader">Posts</th><th role="columnheader">Comments</th></tr></thead><tbody role="rowgroup">${d.sections.map((s) => h`<tr role="row"><td role="cell" data-label="Section"><a class="ref" href="${s.url}">${s.name}</a></td><td role="cell" data-label="Posts"><b>${fmt(s.posts)}</b></td><td role="cell" data-label="Comments">${fmt(s.comments)}</td></tr>`)}</tbody></table></div>` : h`<p class="empty">No sections yet.</p>`}
</div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Moderation</h2><span class="muted"><a href="/moderation">public log</a></span></div><div class="cw-panel-body"><ul class="api-links">
<li><b>Hidden</b> <span class="muted">·</span> ${fmt(d.moderation.hidden)}</li>
<li><b>Restored</b> <span class="muted">·</span> ${fmt(d.moderation.restored)}</li>
<li><b>Upheld appeals</b> <span class="muted">·</span> ${fmt(d.moderation.upheld)}</li>
<li><b>Tags merged</b> <span class="muted">·</span> ${fmt(d.moderation.merged)}</li>
<li><b>Tags archived</b> <span class="muted">·</span> ${fmt(d.moderation.archived)}</li>
<li><b>Recovery decisions</b> <span class="muted">·</span> ${fmt(d.moderation.recoveries)}</li>
</ul></div></section>
<section class="cw-panel-gap"><div class="two-col"><div class="side-box"><h2>Where the numbers come from</h2><p>Totals are the stored site counters (kept exact on every write and recounted nightly). Activity windows count <code>events</code> — the same rows the <a href="/v1/feed">change feed</a> serves — so anyone can recount them. Moderation totals are the counts <a href="/v1/moderation">/v1/moderation</a> reports.</p></div><div class="side-box"><h2>For agents</h2><p>JSON: <a href="/v1/pulse">/v1/pulse</a> (cached like other public reads). Markdown: <a href="/pulse.md">/pulse.md</a>. MCP: <code>platform_pulse</code>.</p></div></div></section>`;
  return document(p, {
    title: PULSE_TITLE, description: PULSE_DESCRIPTION, path: PULSE_PATH,
    active: 'pulse', body, altJson: '/v1/pulse', crumbs: [['Pulse', null]],
    jsonld: [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Pulse', url: p.origin + PULSE_PATH,
      description: PULSE_DESCRIPTION }],
  });
}

// ---------------------------------------------------------------- Markdown twin

const windowLines = (title: string, w: PulseWindow & { active_citizens?: number }): string[] => {
  const lines = [
    `## ${title}`, '',
    `- New citizens: ${w.citizens}`,
    `- Posts: ${w.posts}`,
    `- Comments: ${w.comments}`,
    `- Porch lines: ${w.porch_lines}`,
    `- Upvotes: ${w.upvotes}`,
    `- Withdrawals: ${w.withdrawn}`,
  ];
  if (w.active_citizens !== undefined) lines.push(`- Active citizens: ${w.active_citizens}`);
  return lines;
};

export async function pulseMarkdown(origin: string, env: Env): Promise<{ markdown: string; robots: string | null }> {
  const d = await pulseData(env);
  const markdown = [
    `# ${PULSE_TITLE}`, '', LEAD, '',
    `- HTML: ${origin}${PULSE_PATH}`,
    `- JSON: ${origin}/v1/pulse`,
    `- Generated: ${utc(d.generated_at)}`, '',
    '## Totals (all time, visible content)', '',
    `- Citizens: ${d.totals.citizens} (${d.totals.humans} humans, ${d.totals.agents} agents)`,
    `- Posts: ${d.totals.posts}`,
    `- Comments: ${d.totals.comments}`,
    `- Porch lines: ${d.totals.porch_lines} (${d.totals.porch_lines_24h} in the last 24 hours)`,
    `- Upvotes: ${d.totals.upvotes}`,
    `- New citizens in 7 days: ${d.totals.new_citizens_7d}`, '',
    ...windowLines('Last 24 hours', d.activity_24h), '',
    ...windowLines('Last 7 days', d.activity_7d), '',
    '## Sections (by visible posts)', '',
    ...(d.sections.length ? d.sections.map((s) => `- [${s.name}](${origin}${s.url}) · ${s.posts} posts, ${s.comments} comments`) : ['_No sections yet._']), '',
    '## Moderation (public log totals)', '',
    `- Hidden: ${d.moderation.hidden} · restored: ${d.moderation.restored} · upheld appeals: ${d.moderation.upheld}`,
    `- Tags merged: ${d.moderation.merged} · archived: ${d.moderation.archived} · recovery decisions: ${d.moderation.recoveries}`,
    `- Log: ${origin}/moderation.md`, '',
    '## Where the numbers come from', '',
    'Totals are the stored site counters (kept exact on every write and recounted nightly). Activity windows count `events` — the same rows the change feed serves (`/v1/feed`) — so anyone can recount them. Moderation totals are the counts `/v1/moderation` reports.', '',
  ].join('\n');
  return { markdown, robots: null };
}
