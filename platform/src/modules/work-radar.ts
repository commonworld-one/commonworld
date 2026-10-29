export type WorkRadarState = "open" | "claimed" | "review" | "done";

export interface WorkRadarItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  state: WorkRadarState;
  updatedAt: string;
  owner?: string | null;
  evidenceUrl?: string | null;
}

export interface WorkRadarDocument {
  title: string;
  description: string;
  generatedAt: string;
  items: WorkRadarItem[];
}

export type WorkRadarFormat = "html" | "markdown" | "json";

const STATE_ORDER: Record<WorkRadarState, number> = {
  open: 0,
  claimed: 1,
  review: 2,
  done: 3,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function orderedItems(items: WorkRadarItem[]): WorkRadarItem[] {
  return [...items].sort((left, right) => {
    const stateDifference = STATE_ORDER[left.state] - STATE_ORDER[right.state];
    if (stateDifference !== 0) return stateDifference;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function workRadarFormat(pathname: string): WorkRadarFormat | null {
  if (pathname === "/work-radar" || pathname === "/work-radar/") return "html";
  if (pathname === "/work-radar.md") return "markdown";
  if (pathname === "/work-radar.json") return "json";
  return null;
}

export function renderWorkRadarMarkdown(document: WorkRadarDocument): string {
  const lines = [
    `# ${document.title}`,
    "",
    document.description,
    "",
    `Generated: ${document.generatedAt}`,
    "",
  ];

  const items = orderedItems(document.items);
  if (items.length === 0) {
    lines.push("No public work items are currently listed.", "");
    return lines.join("\n");
  }

  for (const item of items) {
    const owner = item.owner ? ` · owner: ${item.owner}` : "";
    lines.push(
      `## [${item.title}](${item.url})`,
      "",
      `Status: **${item.state}**${owner} · updated: ${item.updatedAt}`,
      "",
      item.summary,
      "",
    );
    if (item.evidenceUrl) lines.push(`[Evidence](${item.evidenceUrl})`, "");
  }
  return lines.join("\n");
}

export function renderWorkRadarHtml(document: WorkRadarDocument): string {
  const cards = orderedItems(document.items).map((item) => {
    const itemUrl = safeHttpUrl(item.url);
    const evidenceUrl = item.evidenceUrl ? safeHttpUrl(item.evidenceUrl) : null;
    const title = escapeHtml(item.title);
    const heading = itemUrl
      ? `<a href="${escapeHtml(itemUrl)}">${title}</a>`
      : title;
    const owner = item.owner
      ? `<span>Owner: ${escapeHtml(item.owner)}</span>`
      : "";
    const evidence = evidenceUrl
      ? `<a class="evidence" href="${escapeHtml(evidenceUrl)}">Evidence</a>`
      : "";
    return `<article class="work-card" data-state="${item.state}">
  <div class="work-meta"><span class="state">${item.state}</span>${owner}<time datetime="${escapeHtml(item.updatedAt)}">${escapeHtml(item.updatedAt)}</time></div>
  <h2>${heading}</h2>
  <p>${escapeHtml(item.summary)}</p>
  ${evidence}
</article>`;
  }).join("\n");

  const body = cards || '<p class="empty">No public work items are currently listed.</p>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(document.title)}</title>
<style>
:root{color-scheme:light dark;--paper:#f5f1e8;--ink:#171713;--accent:#b74422;--line:#77725f}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
main{width:min(900px,calc(100% - 2rem));margin:3rem auto}header{border-bottom:2px solid var(--ink);margin-bottom:2rem}h1{font-size:clamp(2rem,6vw,4.5rem);line-height:.95;margin:0 0 1rem}a{color:inherit;text-decoration-thickness:2px}.twins{display:flex;gap:1rem;margin:1rem 0 1.5rem}.work-card{border-top:1px solid var(--line);padding:1.4rem 0}.work-card h2{margin:.5rem 0;font-size:1.25rem}.work-meta{display:flex;flex-wrap:wrap;gap:.75rem;color:#514e43;font-size:.82rem;text-transform:uppercase}.state{color:var(--accent);font-weight:700}.evidence{display:inline-block;margin-top:.3rem}.empty{padding:3rem 0}footer{border-top:2px solid var(--ink);margin-top:3rem;padding-top:1rem;font-size:.8rem}
@media(prefers-color-scheme:dark){:root{--paper:#171713;--ink:#f5f1e8;--accent:#ff805c;--line:#85806e}.work-meta{color:#bbb5a3}}
</style>
</head>
<body><main>
<header><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.description)}</p><nav class="twins" aria-label="Alternate representations"><a href="/work-radar.md">Markdown</a><a href="/work-radar.json">JSON</a></nav></header>
<section aria-label="Public work items">${body}</section>
<footer>Generated <time datetime="${escapeHtml(document.generatedAt)}">${escapeHtml(document.generatedAt)}</time></footer>
</main></body></html>`;
}

export function workRadarResponse(
  format: WorkRadarFormat,
  document: WorkRadarDocument,
): Response {
  if (format === "json") {
    return Response.json({ ...document, items: orderedItems(document.items) }, {
      headers: { "cache-control": "public, max-age=60" },
    });
  }
  if (format === "markdown") {
    return new Response(renderWorkRadarMarkdown(document), {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  }
  return new Response(renderWorkRadarHtml(document), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}
