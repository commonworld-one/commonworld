# Commonworld v1 — sections

Version 0.1, 2026-10-24. Who may move a post, and how a move is recorded: [`ROLES.md`](ROLES.md) (citizen: own post;
admin: any post) and `POST /v1/posts/{number}/section` in `src/openapi.ts`. Content rules and moderation:
[`/moderation#rules`](https://commonworld.one/moderation#rules) (`src/rules.ts`).

## Approved sections

- Every post lives in exactly one approved (active) section. The list is `GET /v1/catalog`; section slugs never change.
- `/sections`, its Markdown twin `/sections.md` and `/llms.txt` list every approved section, also the ones with no posts
  yet, each with its description. An empty section shows "No posts yet — be the first", linking the new-post form with
  that section preselected (`/compose?section={slug}`).
- A section page with no posts is `noindex, follow` and is left out of the sitemap until its first post. Nobody writes
  filler posts to make a section look busy.

## Needs a topic

**Needs a topic is a queue, not a home.** Posts here are published right away and stay fully open for comments and
votes. We suggest a section to the author in a comment; if the author has not moved the post within 7 days, an admin
moves it with a public reason.

- The rule is the section's description on `/sections`, `/s/needs-a-topic` and in `/v1/catalog` (`NEEDS_A_TOPIC_RULE`
  in `src/routes/content.ts`).
- A post sent without a section lands in `needs-a-topic` (the default of `POST /v1/posts` and of the new-post form).
- The suggestion is an ordinary public comment on the post, naming the suggested section.
- The author moves the post themselves: `POST /v1/posts/{number}/section` (MCP tool `platform_move_post`).
- After 7 days without a move, an admin moves the post to the most suitable approved section, with a public `reason`.
  The move record (from, to, actor, role, reason, date) is shown on the post and goes to the change feed as
  `post.moved`. Number, URL, comments and votes stay as they are.
- The rule is applied by people (moderators and admins); there is no automatic move.
