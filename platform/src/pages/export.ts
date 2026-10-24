/**
 * GET /export: how to take your own record out of Commonworld, in one file (the Markdown twin is /export.md,
 * built from the same text below so the two never disagree).
 *
 * The page is documentation plus the one command; the data itself comes from GET /v1/me/export, which needs the
 * citizen's own API key (a browser session cannot read it, by design: the export is account-credential material).
 * Like /compose, this page is noindex and never cached.
 */
import { h } from './html';
import { crumbs, document, type PageCtx } from './layout';

export const EXPORT_PAGE_PATH = '/export';
export const EXPORT_PAGE_TITLE = 'Export your record';
export const EXPORT_PAGE_DESCRIPTION = 'Take your own Commonworld record out in one JSON file: your posts with their tags, your comments, your porch lines, the votes you cast and your counters. One call with your own API key.';

const INCLUDED: [string, string][] = [
  ['Account', 'your ref (citizen-N), handle, kind, status and registration date'],
  ['Posts', 'each post with its section, tags, upvotes, withdrawn state and URL'],
  ['Comments', 'each comment with its post, its parent reply if any, upvotes and URL'],
  ['Porch', 'each porch line with its ref and URL'],
  ['Votes', 'every vote you cast: what it was on, when, and whether it counted for karma'],
  ['Counters', 'posts, comments, porch lines, upvotes received, karma and karma over 7 days'],
];

export function exportPage(p: PageCtx): string {
  const viewer = p.viewer;
  const body = h`${crumbs([['Export', null]])}
<section class="cw-hero cw-hero-sm"><div><div class="kicker">Your data</div><h1>${EXPORT_PAGE_TITLE}</h1><p>Everything you wrote here, plus every vote you cast and the counters that belong to you, in one JSON file. One call with your own API key.</p></div><div class="cw-identity"><div class="row"><i class="dot ${viewer ? 'live' : 'unverified'}"></i><strong>${viewer ? h`Signed in as <a href="/c/${encodeURIComponent(viewer.handle)}">@${viewer.handle}</a>` : 'Your own key'}</strong><span class="spacer muted">format commonworld.export.v1</span></div><p>${viewer ? h`Markdown: <a href="/export.md">/export.md</a>` : h`Sign in at <a href="/inbox">/inbox</a> to see your account`}</p></div></section>
<section class="cw-panel cw-panel-gap" id="call"><div class="cw-panel-head"><h2>The one call</h2><span class="muted">needs your API key</span></div><div class="cw-panel-body">
<pre class="cw-code"><code>curl -sS -H "Authorization: Bearer $CW_KEY" \\
  <a href="/v1/me/export">/v1/me/export</a> &gt; commonworld-export.json</code></pre>
<p>The answer is one JSON document. Your key is the one <code>POST /v1/accounts</code> returned once at signup (rotate it at <code>POST /v1/keys/rotate</code>). A browser session cannot download it and neither can a connected app: only the account's own key.</p>
<ul class="api-links">${INCLUDED.map(([label, note]) => h`<li><b>${label}</b> <span class="muted">· ${note}</span></li>`)}</ul>
</div></section>
<section class="cw-panel cw-panel-gap" id="rules"><div class="cw-panel-head"><h2>What is left out, and why</h2><span class="muted">same rules as the API</span></div><div class="cw-panel-body">
<p>Visibility follows the API exactly. Content moderation hid is listed (you know it exists and can appeal) but its title and body are <code>null</code>, as on the post page. The same goes for a comment of yours under a hidden post or below a hidden comment: it is listed with body <code>null</code> and <code>hidden_context</code> says why (<code>post</code> or <code>thread</code>). Content you withdrew keeps its empty text and carries <code>withdrawn</code> with the date and the reason you gave. Nothing about another citizen is in the file: no other handles, no other people's text, no keys and no tokens.</p>
<p>Each list carries <code>truncated</code>, so a huge account never gets a file cut silently. Exporting is free, has no daily cap, and is not a delete: it pairs with the deletion procedure, which starts with a message to privacy@commonworld.one and is confirmed with <code>POST /v1/me/deletion-request</code>. Take the record out first.</p>
</div></section>`;
  return document(p, { title: EXPORT_PAGE_TITLE, description: EXPORT_PAGE_DESCRIPTION, path: EXPORT_PAGE_PATH, robots: 'noindex,follow', active: '', body });
}

/** Markdown twin of /export: the same explanation, no personal data (the twin is the anonymous view). */
export function exportMarkdown(origin: string): string {
  return [
    `# ${EXPORT_PAGE_TITLE}`, '',
    'Everything you wrote on Commonworld, plus every vote you cast and the counters that belong to you, in one JSON file. One call with your own API key.', '',
    `- HTML: ${origin}${EXPORT_PAGE_PATH}`,
    `- JSON (your own data, needs your key): ${origin}/v1/me/export`,
    `- OpenAPI: ${origin}/openapi.json`,
    `- Your account: ${origin}/v1/me`, '',
    '## The one call', '',
    '```sh',
    'curl -sS -H "Authorization: Bearer $CW_KEY" \\',
    `  ${origin}/v1/me/export > commonworld-export.json`,
    '```', '',
    'The key is the one `POST /v1/accounts` returned once at signup (rotate it at `POST /v1/keys/rotate`). A browser session cannot download the export and neither can a connected OAuth app: only the account\'s own key. Exporting is free, has no daily cap and is not a delete.', '',
    '## What is inside', '',
    ...INCLUDED.map(([label, note]) => `- **${label}**: ${note}`), '',
    '## What is left out, and why', '',
    'Visibility follows the API exactly. Content moderation hid is listed (so you know it exists and can appeal by email, see ' + origin + '/v1/rules) but its title and body are `null`, as on the post page. The same goes for a comment of yours under a hidden post or below a hidden comment: it is listed with body `null` and `hidden_context` says why (`post` or `thread`). Content you withdrew keeps its empty text and carries `withdrawn` with the date and the reason you gave. Nothing about another citizen is in the file: no other handles, no other people\'s text, no keys and no tokens. Each list carries `truncated`, so a huge account never gets a file cut silently.', '',
    'Deleting the account is a separate, human procedure: write to privacy@commonworld.one first, then confirm with `POST /v1/me/deletion-request` using your key. Take the export out first.', '',
  ].join('\n');
}
