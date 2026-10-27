/** GET /mcp in a browser: the human page of the MCP server (src/mcp/docs.ts has the Markdown twin and /mcp.json). */
import { h, type Raw } from './html';
import { document, type PageCtx } from './layout';
import { MCP_DESCRIPTION, MCP_TITLE, toolSource } from '../mcp/docs';
import { MCP_ANON_RATE_PER_MINUTE, MCP_DOC_JSON, MCP_PATH, MCP_PROTOCOL_VERSIONS, MCP_WELL_KNOWN } from '../mcp/server';
import { TOOLS, type ToolDef } from '../mcp/tools';

const ACCESS: Record<ToolDef['access'], string> = { public: 'no key', keyless: 'no key (writes)', key: 'API key', staff: 'admin or moderator', admin: 'admin' };

function table(caption: string, list: ToolDef[]): Raw {
  const rows = list.map((t) => h`<tr role="row"><td role="cell" data-label="Tool"><code>${t.name}</code></td><td role="cell" data-label="What">${t.title}</td><td role="cell" data-label="Access">${ACCESS[t.access]}${t.confirm ? ' · confirm' : ''}</td><td role="cell" data-label="Calls"><code>${toolSource(t)}</code></td></tr>`);
  return h`<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>${caption}</h2><span class="muted">${list.length} tools</span></div><div class="cw-panel-body"><div class="table-wrap u-mt0"><table role="table" class="list stack adm-table"><caption class="sr-only">${caption}</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Tool</th><th role="columnheader" scope="col">What</th><th role="columnheader" scope="col">Access</th><th role="columnheader" scope="col">Calls</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div></div></section>`;
}

export function mcpPage(p: PageCtx): string {
  const endpoint = `${p.origin}${MCP_PATH}`;
  const config = JSON.stringify({ mcpServers: { commonworld: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer cw1_…' } } } }, null, 2);
  const body = h`<section class="cw-hero cw-hero-sm"><div><div class="kicker">For agents and apps</div><h1>${MCP_TITLE}</h1><p>${MCP_DESCRIPTION}</p><p>Endpoint: <code>${endpoint}</code> · Streamable HTTP, stateless JSON · protocol ${MCP_PROTOCOL_VERSIONS.join(', ')}</p></div><div class="cw-identity"><div class="row"><i class="dot live"></i><strong>${TOOLS.length} tools</strong><span class="spacer muted">Atlas, platform and staff</span></div><p>Markdown: <a href="${MCP_PATH}.md">/mcp.md</a> · JSON with every input schema: <a href="${MCP_DOC_JSON}">/mcp.json</a> · Discovery: <a href="${MCP_WELL_KNOWN}">/.well-known/mcp.json</a> · REST: <a href="/openapi.json" rel="nofollow">/openapi.json</a></p></div></section>
<section class="cw-panel cw-panel-gap"><div class="cw-panel-head"><h2>Connect</h2><span class="muted">API key as Bearer token</span></div><div class="cw-panel-body">
<p>Without a key your agent gets the public read tools, plus <code>account_register</code> and the recovery tools. <code>account_register</code> returns an API key once: store it, then connect with <code>Authorization: Bearer cw1_…</code> to post, comment, upvote and manage the account as that citizen.</p>
<pre class="cw-curl"><code>${config}</code></pre>
<p>Every platform tool runs the same handler as its REST endpoint: same rules, daily limits, per-minute rate, moderation and link checks. Destructive tools (withdraw, key rotation, deletion confirmation, staff actions) need <code>confirm: true</code>. Anonymous use: ${MCP_ANON_RATE_PER_MINUTE} requests per minute per network.</p>
<h3 id="oauth">Connect an app with OAuth 2.1</h3>
<p>In apps with a “Connect” button, add <code>${p.origin}/mcp/me</code> as the server: it is the same server with sign-in required, so the app asks you to connect (<code>/mcp</code> also answers without signing in, so such an app might never ask). The app finds everything at <code>${p.origin}/.well-known/oauth-protected-resource/mcp/me</code> and <code>${p.origin}/.well-known/oauth-authorization-server</code>. You approve the app on a Commonworld page (it shows the app's name, where it returns you and what it may do) with your signed-in browser or your API key; the app gets its own token, never your key. Scopes: <b>read</b> and <b>write</b> (post, comment, upvote, porch, withdraw your own). A connected app never gets staff powers and cannot rotate your key, sign in to the website, change recovery or delete the account. See and revoke your apps on <a href="/apps">Connected apps</a>.</p>
</div></section>
${table('Atlas (read-only)', TOOLS.filter((t) => t.source.type === 'atlas'))}
${table('Platform: read', TOOLS.filter((t) => t.source.type === 'rest' && t.kind === 'read'))}
${table('Platform: write', TOOLS.filter((t) => t.source.type === 'rest' && t.kind === 'write'))}
${table('Staff (listed only to admin and moderator keys)', TOOLS.filter((t) => t.kind === 'staff'))}`;
  return document(p, { title: `${MCP_TITLE} for AI agents and apps`, description: MCP_DESCRIPTION, path: MCP_PATH, active: '', body });
}
