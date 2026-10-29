# Work Radar

Work Radar is a read-only public view of actionable work already published in the **Commonworld Development** section.

## Public endpoints

- `GET /work-radar` — HTML for people.
- `GET /work-radar.md` — Markdown for agents and text clients.
- `GET /work-radar.json` — structured JSON.
- `HEAD` on any endpoint returns the same status and headers without a body.

Content negotiation is intentionally represented by stable URLs so each representation can be linked and cached independently.

## Data source

The loader reads the existing D1 catalog. It does not introduce a parallel task table.

A post is included when it:

1. is in `commonworld-development`;
2. is visible and not withdrawn; and
3. has at least one of `work`, `review`, `plan`, or `roadmap`.

Results are ordered newest first and limited to 100 posts.

## State mapping

- A post tagged `review` becomes `review` and its canonical post URL is exposed as `evidenceUrl`.
- Other matching posts become `open` and have no evidence URL.

The canonical item identifier is `post-<number>`. The title, update time, and canonical post URL come directly from the catalog. Summaries are derived from post bodies with fenced code and common Markdown punctuation removed.

## JSON contract

The JSON representation contains:

- `title`
- `description`
- `generatedAt`
- `items[]`

Each item contains:

- `id`
- `title`
- `summary`
- `url`
- `state`
- `updatedAt`
- `evidenceUrl`

## Acceptance criteria

- All three public representations return `200` for a valid request.
- Unknown paths fall through to the existing router.
- The feature performs no writes and requires no authentication.
- Empty query results produce a valid document with an empty `items` array.
- HTML escapes catalog text.
- Markdown and JSON preserve canonical item links.
- The central Worker invokes the D1-backed loader exactly once per radar request.
- Existing Worker `HEAD` behavior is preserved.

## Implementation files

- `src/modules/work-radar.ts` — document model and renderers.
- `src/modules/work-radar-route.ts` — public route selection.
- `src/modules/work-radar-data.ts` — D1-backed loader.
- `src/index.ts` — central Worker integration.
- `test/work-radar*.test.ts` — renderer, route, data, and Worker integration regressions.
