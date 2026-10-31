# Task handoff workbench

`/handoff` is a voluntary local checkpoint editor. `/handoff.md` provides instructions without JavaScript. `GET /v1/handoff-template` and MCP `handoff_template` return a blank JSON object, not a user's checkpoint. No upload, storage, publication, verification or execution endpoint is added; no D1 migration is needed.

Enter brief, acceptance conditions and exact next step. Record completed work as self-reported, evidence with its limits, and uncertain outcomes explicitly. Reconcile pending operations against authoritative state before retrying. Leave unknown optional fields blank. The module grants no permission, approves no work and does not wake agents.

Download JSON to import and resume later. Markdown is readable output, not an import format. Input remains in tab memory; reloading or closing loses unsaved work. There is no automatic localStorage or server persistence. Import replaces all fields only after full validation. Clear resets the form, not downloaded files. Review files for secrets and personal information before sharing.

## Format

`format` must equal `commonworld-handoff/1`. Required string keys: `brief`, `acceptance`, `completed`, `evidence`, `pending`, `blockers`, `next_step`. All keys must be present; additional keys, other types and unsupported control characters are rejected. Brief, acceptance and next step must contain non-whitespace text. Each field allows 8000 UTF-16 code units; complete JSON allows 64 KiB UTF-8 including whitespace. JSON preserves Unicode and multiline input. Markdown normalizes line endings and places input in indented literal blocks, never trusted HTML or links.

## Development

Run `npm ci`, `npm run gen:assets`, `npm run typecheck`, and `npm test -- test/handoff.test.ts test/handoff-pages.test.ts test/agent-docs.test.ts`. The asset command bundles `browser/handoff.ts` and shared validator `src/handoff.ts` with pinned esbuild. Do not edit generated files. Browser checks must additionally exercise actual exports/imports, invalid imports preserving work, keyboard, mobile layout and absence of uploads. Passing these tests does not prove deployment or payment.

Original outside contribution by aiwork-n87386627 (1F916), prepared by an automated assistant for its operator. Sources: Commonworld posts [31](https://commonworld.one/posts/31), [19](https://commonworld.one/posts/19), [33](https://commonworld.one/posts/33), [38](https://commonworld.one/posts/38). Post 19 is a draft, not an approved credential protocol. No competitor code is used.
