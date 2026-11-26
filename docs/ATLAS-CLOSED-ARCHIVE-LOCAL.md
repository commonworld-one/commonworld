# Historical stage record

This file preserves an earlier stage and its counts. It is not the current contract or a claim about deployment. Read [ATLAS-CURRENT-CONTRACT.md](ATLAS-CURRENT-CONTRACT.md) for the current349/38/71model.

## Current contract,24November2026

Read [ATLAS-CURRENT-CONTRACT.md](ATLAS-CURRENT-CONTRACT.md) first for current behavior:349current cards,39closed records,71earning entries; one overview+matching screenshot package, optional trials, same current data for people and agents. Raw inputs and historical sections below do not define current membership or export fields. Their348/18/20counts, bounded-note model, compatibility fields and automated reopening descriptions are historical. This repository change does not establish that a deployment occurred or activate any external workflow.

## Historical and implementation reference

# Closed archive local candidate, 24 November 2026

Local implementation for review only. No push, CI, deploy, workflow activation or release approval.

## Boundary

Closed cards retain permanent URLs, names, descriptions, dated evidence and original historical source values in the input catalogue. Published history represents external addresses as inert text. Existing screenshot files are reused unchanged. There are currently 20 closed cards. Two, IssueHunt and Clawsino, retain historical captures recovered from the pinned screenshot branch with original metadata from the published manifest. The other 18 have no available capture. The earlier claim that all 20 had no capture was wrong, because the 348-entry manifest omitted these two existing images. The 348 supplied full-size captures are byte-identical after building.

Closed HTML retains the historical card body, adds an archive notice and removes external anchors in its main content. Site navigation and site-level footer links are separate from card history. Markdown and machine-readable records have no active external historical URLs. Event log entries for closed IDs use the same inert representation in published JSON/Markdown; original event logs are not edited.

Closed machine records carry `archive.kind=closed_history`, `archive.external_links=disabled`, and `archive.history`. The history preserves every original non-private source field plus last observation and existing capture metadata. `closed_recorded_at` is null if no explicit closure event exists. An observation date is not invented as a closure date.

Closed records do not carry active website, safety, reachability, task, replication or badge fields. MCP search carries only the archive marker and stable identity; full history remains on the permanent per-ID JSON endpoint. Schemas describe this intentional closed-only shape change, not a backwards-compatible optional-field addition. Non-closed records retain their existing contract. The wider general API/UI migration remains separate.

Current-only safety extraction skips all closed IDs. Removal processing skips closed IDs in both catalogue-preserving and legacy mutation modes, even when a provider report groups a closed ID with a live ID on one host. Published safety reports omit closed IDs. Retained historical closure wording does not promise future checks or automatic reopening.

## Validation

- Build and full static checker pass against the pinned capture package.
- Python: 657 tests, 5 skips. Includes fifteen new archive regressions and safety v2 tests.
- Platform typecheck passes. Relevant MCP/Atlas tests: 83 pass across four files.
- An attempted full platform run hit the execution timeout without a final suite result. Do not claim a full platform pass from this candidate.
- No private-terms validation was run.
- Existing catalogue JSON files are byte-identical to the safety v2 review input; the closed-only archive-captures directory adds the two original images and provenance metadata; 348 full-size screenshot bytes are unchanged.
- 20 closed IDs excluded from safety input; current union is 380 hosts, versus 399 before the closed exclusion.
- Desktop and mobile IssueHunt/Clawsino/ClawNews pages and the archive list rendered. No main-content outbound anchors, horizontal overflow or JavaScript errors on inspected closed pages.

Known separate work: current-only general storefront listings/counters and the general 348-card API/UI migration are not completed by this closed-only patch. Historical source files and raw append-only logs remain source evidence, not live card links.

## Independent-review corrections

- Preserved IssueHunt capture 2026-10-17T00:28:22Z, SHA256 18df0b4acaf1b06d03c2358d1fe0a4f08d0958ec5e9b209026cd57dc3d57399c, and Clawsino capture 2026-10-19T18:50:05Z, SHA256 31ad0b910a04218cdd386e582524b81a1d2ace016448c59d7910f151627697aa. Both match exact bytes in pinned commit 05ae69ab103a273b6f8a0de2fac68d0ef1eebabb. Metadata recovery URL is recorded in archive-captures/manifest.json. No new visit, capture or confirmation time.
- Published 350 full images and 350 thumbnails. Archive capture metadata remains inert; screenshot anchors cannot leave the card. Markdown includes the historical screenshot and original date.
- Removed external arrow from disabled former-site text. QA, observation date and claim count are explicitly historical in HTML and Markdown.
- Legacy no-catalogue safety extraction excludes closed before snapshot and curation traversal. Real current union is 380 hosts. The real github.com canonical shared host retains six active IDs while excluding polar-issue-funding. A deliberately stale report containing active and closed IDs removes only the active ID and leaves closed/source input untouched.
- Browser DOM navigation inspected for all 20 closed pages, including bare-host autolink behavior: zero active main-content external anchors. Site chrome remains separate.

## Bare-domain correction

Closed public text now disables scheme-less domains and IPv4 addresses as well as external URL schemes. Nested archived URLs have every scheme disabled, and already-defanged addresses remain unchanged on a second pass. Closed display names and descriptions use the same projection on list/search rows, including Shellmates' domain-bearing name. Historical source JSON and active cards are unchanged. Site schema.org context and internal permanent Commonworld URLs are structural links, not historical project destinations.

The uniform audit checks closed record projections throughout generated JSON, events and compact search plus all twenty per-ID Markdown pages. Two new regressions cover bare domains, partly defanged and nested URLs, and fixed-point consistency. No external renderer is trusted to refrain from auto-linking bare domains.

## Absolute DNS-name correction

The bare-host matcher no longer enumerates DNS suffixes. It matches multi-label DNS names with any alphabetic suffix, including an optional terminal root dot. Known file suffixes are left as filenames, not classified as web addresses. Two regressions cover absolute resolver authority names and corpus-derived candidates. The source corpus yields 73 hostname candidates, including moltx.io., merlin.ns.cloudflare.com. and dns.cloudflare.com. All three absolute names are inert in every generated text output. Uniform audits still cover all closed JSON/events/search/Markdown projections. No raw source edits.

## Final projection path corrections

R2 was not a missing qa_value traversal: qa_value was already recursively projected. The root cause was the filename-suffix exemption, which wrongly treated polar.sh as a file. All suffix exemptions are now removed. In historical display text, ambiguous filenames such as skill.md are shown as skill[.]md too. This is a deliberate visible tradeoff to avoid silently exempting real domains; source text remains exact in the input. No TLD allowlist is used.

R3 was an A-Z table renderer using the raw name instead of display_name. That renderer now uses the same closed display name projection. An all-HTML scan verifies the raw Shellmates name is absent across all 447 generated HTML files. Main text nodes of all twenty closed pages are fixed points (3,752 nodes); recursive closed JSON/events/search/MD projection audits pass. Exemptions are structural, not guessed filename suffixes: actual Commonworld internal destinations, executable script bodies, and schema.org context. Historical free-text filenames are not exempt.

JavaScript is explicitly not treated as historical prose: a regression ensures document.documentElement and window properties remain executable, while nearby historical text is inert. Actual browser rerun reports no JavaScript errors and zero main-content external navigation. No new active-card transformation or history-input edit.

## 2026-11-25 addition: 16 more historical captures

- `archive-captures/` now holds 19 images: the first three plus agent-almanac, agent-room-agentmessageboards, botbeat, clawbench, clawcard, common-room, commonlog, moltcities, opentask, public-agent-lounge, snail, substrate-journal, the-door, the-spawn, the-wire-qualium and vynly.
- Each file is the exact byte copy from `atlas-screens` at pin 05ae69ab103a273b6f8a0de2fac68d0ef1eebabb and matches the sha256 and size in the 2026-11-05 published manifest (commit e0f4e1ab38c36bd71b1af3e7c5937dc51bd2f17a). Original captured_at dates are kept (2026-10-17 to 2026-10-27); confirmed_at stays null. No new visit or capture.
- For the other 19 archived cards no screenshot was found in the checked public repository history; they stay without one. That does not prove none ever existed.
