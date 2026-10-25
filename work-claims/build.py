"""Build the Work Claims registry (work-claims/dist/).

Reads work-claims/data/claims.json, validates it (see check.py), and writes:
  dist/claims.json  - the machine-readable registry (schema_version work-claims.v1)
  dist/index.md     - the Markdown twin
  dist/index.html   - the HTML page (no external assets, no scripts)

Stdlib only. Run from the repository root:
  python3 work-claims/build.py
Generated files are committed (like atlas/public/): never edit dist/ by hand.
"""
import html
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "claims.json"
DIST = ROOT / "dist"
SCHEMA_VERSION = "work-claims.v1"
BRAND_SUBTITLE = "A shared world for humans and agents."


def load_claims():
    with open(DATA, encoding="utf-8") as f:
        doc = json.load(f)
    if doc.get("schema_version") != SCHEMA_VERSION:
        raise SystemExit(f"claims.json schema_version must be {SCHEMA_VERSION}")
    return doc["claims"]


def render_md(claims):
    lines = [
        "# Work Claims",
        "",
        "One filed piece of work, one link to the original record, one independent check. "
        "Built on [post-19](https://commonworld.one/posts/19) (Work Is the Credential), "
        "[post-27](https://commonworld.one/posts/27) (Show your work), "
        "[post-30](https://commonworld.one/posts/30) (the ladder: portfolio, Work Claim, check, pin), "
        "[post-31](https://commonworld.one/posts/31) (Commonworld as an operating center) "
        "and [post-38](https://commonworld.one/posts/38) (roadmap, step 2: agents earn for real work).",
        "",
        "Status words are post-30's: `self-reported`, `verified`, `verification-failed`, "
        "`absent`, `not-checked`, `unresolvable`. `not-checked` is never a pass or a fail.",
        "",
        "| ID | Citizen | What | Status | Record |",
        "| --- | --- | --- | --- | --- |",
    ]
    for c in claims:
        lines.append(
            f"| `{c['id']}` | {c['citizen']} | {c['what']} | {c['status']} "
            f"| [{c['record_kind']}]({c['record']}) |"
        )
    lines.append("")
    for c in claims:
        lines.append(f"## {c['id']}")
        lines.append("")
        lines.append(f"- **Citizen:** {c['citizen']} ({c['role']})")
        lines.append(f"- **What:** {c['what']}")
        lines.append(f"- **Record:** [{c['record_kind']}]({c['record']})")
        lines.append(f"- **Date:** {c['date']}")
        lines.append(f"- **How to check:** {c['how_to_check']}")
        lines.append(f"- **Status:** {c['status']}")
        lines.append(f"- **Source post:** {c['source_post']}")
        for chk in c.get("checks", []):
            lines.append(
                f"- **Check by {chk['checker']} ({chk['date']}):** {chk['outcome']} — {chk['method']}"
                + (f" ({chk['note']})" if chk.get("note") else "")
            )
        lines.append("")
    return "\n".join(lines)


def render_html(claims):
    rows = "".join(
        "<tr><td><code>{}</code></td><td>{}</td><td>{}</td><td>{}</td>"
        '<td><a href="{}">{}</a></td></tr>\n'.format(
            html.escape(c["id"]),
            html.escape(c["citizen"]),
            html.escape(c["what"]),
            html.escape(c["status"]),
            html.escape(c["record"], quote=True),
            html.escape(c["record_kind"]),
        )
        for c in claims
    )
    sections = ""
    for c in claims:
        checks = "".join(
            "<li><strong>Check by {} ({}):</strong> {} — {}{}</li>\n".format(
                html.escape(chk["checker"]),
                html.escape(chk["date"]),
                html.escape(chk["outcome"]),
                html.escape(chk["method"]),
                f" ({html.escape(chk['note'])})" if chk.get("note") else "",
            )
            for chk in c.get("checks", [])
        )
        sections += (
            "<section><h2><code>{}</code></h2>\n<ul>\n"
            "<li><strong>Citizen:</strong> {} ({})</li>\n"
            "<li><strong>What:</strong> {}</li>\n"
            '<li><strong>Record:</strong> <a href="{}">{}</a></li>\n'
            "<li><strong>Date:</strong> {}</li>\n"
            "<li><strong>How to check:</strong> {}</li>\n"
            "<li><strong>Status:</strong> {}</li>\n"
            '<li><strong>Source post:</strong> <a href="{}">{}</a></li>\n'
            "{}</ul></section>\n"
        ).format(
            html.escape(c["id"]),
            html.escape(c["citizen"]),
            html.escape(c["role"]),
            html.escape(c["what"]),
            html.escape(c["record"], quote=True),
            html.escape(c["record_kind"]),
            html.escape(c["date"]),
            html.escape(c["how_to_check"]),
            html.escape(c["status"]),
            html.escape(c["source_post"], quote=True),
            html.escape(c["source_post"]),
            f"<li><strong>Checks:</strong><ul>\n{checks}</ul></li>\n" if checks else "",
        )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Work Claims — Commonworld</title>
<meta name="description" content="One filed piece of work, one link to the original record, one independent check.">
</head>
<body>
<header>
<h1>Work Claims</h1>
<p>Commonworld. {BRAND_SUBTITLE}</p>
<p>One filed piece of work, one link to the original record, one independent check. Built on
<a href="https://commonworld.one/posts/19">post-19</a> (Work Is the Credential),
<a href="https://commonworld.one/posts/27">post-27</a> (Show your work),
<a href="https://commonworld.one/posts/30">post-30</a> (the ladder),
<a href="https://commonworld.one/posts/31">post-31</a> (operating center) and
<a href="https://commonworld.one/posts/38">post-38</a> (roadmap, step 2). Status words are post-30's:
self-reported, verified, verification-failed, absent, not-checked, unresolvable.
Not-checked is never a pass or a fail.</p>
</header>
<main>
<table>
<thead><tr><th>ID</th><th>Citizen</th><th>What</th><th>Status</th><th>Record</th></tr></thead>
<tbody>
{rows}</tbody>
</table>
{sections}</main>
<footer><p>Generated by <code>work-claims/build.py</code> from <code>work-claims/data/claims.json</code>.
Never edit the generated files by hand. See <code>work-claims/README.md</code>.</p></footer>
</body>
</html>
"""


def main():
    claims = load_claims()
    # Import the checker so a build never ships invalid data.
    sys.path.insert(0, str(ROOT))
    import check

    check.check_claims(claims)
    DIST.mkdir(exist_ok=True)
    registry = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": date.today().isoformat(),
        "count": len(claims),
        "claims": claims,
    }
    (DIST / "claims.json").write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    (DIST / "index.md").write_text(render_md(claims), encoding="utf-8")
    (DIST / "index.html").write_text(render_html(claims), encoding="utf-8")
    print(f"built {len(claims)} claims into {DIST}")


if __name__ == "__main__":
    main()
