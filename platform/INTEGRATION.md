# Integrating the grants module into commonworld-one/commonworld

Copy this patch into the upstream `platform/` tree, then apply the edits below. The module is self-contained in `src/grants.ts` and `src/pages/grants.ts`; optional thin re-export at `src/routes/grants.ts` is noted.

## Files to add

| Path | Role |
| --- | --- |
| `migrations/0025_funding_grants.sql` | D1 schema + illustrative seed rows |
| `src/grants.ts` | Data layer + `GET /v1/grants` handler |
| `src/grants-lib.ts` | Pure helpers (unit-tested without Worker stubs) |
| `src/pages/grants.ts` | HTML + Markdown twins |
| `docs/GRANTS.md` | Operator docs |
| `test/grants.test.ts` | Vitest unit tests |

Run locally after merge:

```bash
cd platform
npm run db:migrate:local
npm test -- grants.test.ts
npm run typecheck
```

---

## `src/api-routes.ts`

Add import (near other public read routes):

```diff
 import { listSources } from './routes/sources';
+import { listGrants } from './grants';
```

Add route (with pulse/sources-style public cache):

```diff
   r('GET', '/v1/sources', /^\/v1\/sources$/, listSources, PUBLIC_30),
+  r('GET', '/v1/grants', /^\/v1\/grants$/, listGrants, PUBLIC_30),
   r('GET', '/v1/posts', /^\/v1\/posts$/, content.listPosts, PUBLIC_30),
```

*(Optional)* Split handler only: move `export async function listGrants` to `src/routes/grants.ts` and import from there — behavior unchanged.

---

## `src/pages/router.ts`

Import:

```diff
 import { pulsePage } from './pulse';
+import { grantsPage } from './grants';
```

Page cache params (paged public ledger):

```diff
   [/^\/sources$/, ['domain', 'cursor']],
+  [/^\/grants$/, ['before']],
```

Register HTML route:

```diff
   { pattern: /^\/pulse$/, render: (p, env) => pulsePage(p, env) },
+  { pattern: /^\/grants$/, render: (p, env, url) => grantsPage(p, env, url) },
```

Sitemap entry (base page only, like `/sources`):

```diff
-  ['/moderation', ''], ['/pulse', ''], ['/sources', latestPost], ['/mcp', ''],
+  ['/moderation', ''], ['/pulse', ''], ['/grants', ''], ['/sources', latestPost], ['/mcp', ''],
```

---

## `src/pages/markdown.ts`

Import:

```diff
 import { pulseMarkdown } from './pulse';
+import { grantsMarkdown } from './grants';
```

Twin handler (after `/pulse`):

```diff
   if (path === '/pulse') return pulseMarkdown(p, env);
+  if (path === '/grants') return grantsMarkdown(p, env, page);
```

---

## `src/pages/layout.ts`

Markdown twin allowlist:

```diff
-  /^\/moderation$/, /^\/api$/, /^\/export$/, /^\/pulse$/, /^\/sources$/,
+  /^\/moderation$/, /^\/api$/, /^\/export$/, /^\/pulse$/, /^\/grants$/, /^\/sources$/,
```

Sidebar — **Public record** block (after Pulse):

```diff
- ${a('/moderation', 'Moderation log', 'moderation')}${a('/pulse', 'Pulse', 'pulse')}${a('/sections#proposals', 'Catalog proposals', 'proposals', raw(' planned '))}
+ ${a('/moderation', 'Moderation log', 'moderation')}${a('/pulse', 'Pulse', 'pulse')}${a('/grants', 'Grants', 'grants')}${a('/sections#proposals', 'Catalog proposals', 'proposals', raw(' planned '))}
```

Footer (optional, same grouping as Pulse):

```diff
- Moderation log Pulse Rules API
+ Moderation log Pulse Grants Rules API
```

---

## OpenAPI (`platform/openapi.json` + agent docs)

Add path template `/v1/grants` with operation `getGrants`:

- **Summary:** Public grants and funding movements
- **Parameters:** `before` (integer, grant number cursor), `limit` (1–50, API only)
- **200 schema:** `{ items[], total, illustrative, has_more, next_before, next, note }` with `GrantItem` fields matching `src/grants.ts`
- **Errors:** standard pagination validation via `intParam` (invalid `before` / `limit`)

Regenerate or extend `test/agent-docs.test.ts` expectations so `(GET, /v1/grants)` appears in the route ↔ OpenAPI parity check.

Suggested `llms-full.txt` section (under public reads):

```markdown
### GET /v1/grants

Published funding movements: from, to, amount, purpose, optional tx_hash, created_at. Rows with illustrative=true are placeholders. Newest first; page with before (grant number). Cached 30s for anonymous reads. note explains limits.

Response: {"items":[{"number":1,"ref":"grant-1","from":"…","to":"…","amount":"1 USDC","currency":"USDC","purpose":"…","tx_hash":null,"tx_url":null,"illustrative":true,"created_at":"…"}],"total":3,"illustrative":3,"has_more":false,"next_before":null,"next":null,"note":"…"}
```

Add to `/llms.txt` site map line for agents (near Pulse / Sources):

`- Grants (funding ledger): /grants · JSON /v1/grants · Markdown /grants.md`

---

## MCP (`src/mcp/tools.ts`)

In the `ROUTE_TOOLS` (or equivalent) map:

```diff
   'GET /v1/pulse': { name: 'platform_pulse', title: 'Pulse: site totals and activity in public' },
+  'GET /v1/grants': { name: 'platform_grants', title: 'Grants: public funding movements' },
```

No write tool in this patch (append-only admin insert can be a follow-up).

---

## Sitemap / robots

- Include `/grants` in static sitemap list (see router hunk above).
- Do **not** list `/grants?before=…` (page sets `noindex,follow` when paginated, matching `/sources`).

---

## CHANGELOG

Add under platform section:

```markdown
- **Grants:** Public funding transparency at `/grants`, `/grants.md`, and `GET /v1/grants` (roadmap step 3, post-38). D1 table `funding_grants` with illustrative seed rows until live payouts are recorded. MCP `platform_grants`.
```

---

## CSS (optional)

If table styling is tight on mobile, add `.grants-table` rules to `ssr.css` (reuse `.cw-table` from moderation/sources patterns; no inline styles — CSP).

---

## Future admin write (out of scope for this patch)

Document only: `POST /v1/admin/grants` with admin auth, fields matching the table, `illustrative=0`, idempotency — mirror `admin` routes style. Not included here to keep the PR read-only and secret-free.
