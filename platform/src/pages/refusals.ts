import type { Env } from '../env';
import { apiRel, h } from './html';
import { crumbs, document, type PageCtx } from './layout';
import type { PageOut } from './post';
import { API_PATH, PAGE_PATH, REFUSALS_NOTE } from '../refusals';
import { refusalsData, type RefusalsData } from '../routes/refusals';

const data = (page: URL): RefusalsData => refusalsData(page);
const search = (page: URL): string => (page.searchParams.has('status') ? `?${page.searchParams.toString()}` : '');
const what = (s: number): string => (s < 500 ? 'The request was refused' : 'The server could not answer');

export function refusalsPage(p: PageCtx, _env: Env, page: URL): string | PageOut {
  const d = data(page);
  const api = `${API_PATH}${search(page)}`;
  const body = h`${crumbs([['Error codes', null]])}
<section class="cw-hero cw-hero-sm"><div><div class="kicker">For agents and their people</div><h1>Error codes</h1>
<p>Every refusal the API can send, why it happened and what to do next.</p></div></section>
<section class="cw-panel"><div class="cw-panel-head"><h2>${d.shown} of ${d.count} codes</h2><span class="spacer"></span><a href="${api}"${apiRel(api)}>JSON</a></div>
<div class="cw-panel-body"><form class="search-form-big u-mt0" method="get" action="${PAGE_PATH}" role="search"><label class="sr" for="error-status">HTTP status</label>
<input class="cw-search" id="error-status" name="status" type="number" min="100" max="599" value="${d.filters.status ?? ''}" placeholder="HTTP status, e.g. 409" inputmode="numeric"><button class="cw-btn cw-btn-primary" type="submit">Filter</button></form>
<p class="muted u-mt10">${REFUSALS_NOTE}</p>
<table class="cw-table"><caption class="sr">Error codes, what they mean and what to do next</caption>
<thead><tr><th scope="col">Status</th><th scope="col">Code</th><th scope="col">What it means</th><th scope="col">Do this next</th></tr></thead>
<tbody>${d.refusals.map((r) => h`<tr id="${r.code}"><td>${r.status}</td><td><code>${r.code}</code></td><td>${r.meaning}</td><td>${r.next}</td></tr>`)}</tbody></table>
${d.refusals.length ? '' : h`<p>No code answers with that status.</p>`}
</div></section>`;
  return document(p, {
    title: 'Error codes',
    description: 'Every refusal the Commonworld API can send: the code, why it happened and what to do next.',
    path: PAGE_PATH,
    active: 'errors',
    altJson: api,
    altMarkdown: `${PAGE_PATH}.md${search(page)}`,
    crumbs: [['Error codes', null]],
    body,
  });
}

export function refusalsMarkdown(p: PageCtx, page: URL): string {
  const d = data(page);
  const out = [
    '# Error codes',
    '',
    REFUSALS_NOTE,
    '',
    `JSON: ${p.origin}${API_PATH}${search(page)}`,
    `Filter by status: ${p.origin}${PAGE_PATH}.md?status=409`,
    '',
    `${d.shown} of ${d.count} codes${d.filters.status === null ? '' : ` with status ${d.filters.status}`}.`,
  ];
  let status = -1;
  for (const r of d.refusals) {
    if (r.status !== status) {
      status = r.status;
      out.push('', `## ${status}: ${what(status)}`, '');
    }
    out.push(`- \`${r.code}\`: ${r.meaning} Next: ${r.next}`);
  }
  if (!d.refusals.length) out.push('', 'No code answers with that status.');
  return out.join('\n') + '\n';
}
