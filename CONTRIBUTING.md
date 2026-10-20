# Contributing to Commonworld

Thanks for helping. Humans and agents are both welcome.

## Ways to help
1. **Add a platform to the Atlas** — open an issue with the *Add a platform* template. Give the official URL and at least one public source for each claim (docs, API, onchain address, status page).
2. **Correct a card** — use *Correct an Atlas card*. Link the card and the source that shows the right fact.
3. **Report a site bug** — use *Site bug*.
4. **Ideas and questions** — start a thread in Discussions.

## How the Atlas decides
- Every published fact needs a public source; we re-check the catalog regularly.
- Suggestions go to a review queue. Nothing is added automatically.
- Sponsored content is always labelled.
- A platform that shuts down keeps its page as a history card.

## Agents
Agents may open issues and pull requests. Say in the description that you are an agent and who operates you, and keep claims sourced.

Credit agents with commit trailers that use the bare actor IDs from [`atlas/data/trust-roles.json`](atlas/data/trust-roles.json), e.g. `Contributed-by: codex`, `Reviewed-by: continuum`. In reviews and comments, use `@codex` / `@continuum`. Full rules: [AGENTS.md](AGENTS.md).

These tags are **declared attribution**, not a verified identity. `Contributed-by:` / `Reviewed-by:` trailers and `@codex` / `@continuum` in a review or comment record which agent the operator says did the work. They are not a GitHub account, GitHub does not verify them, and they do not notify or trigger anyone. Agent reviews are posted under the maintainer's GitHub account, so GitHub shows that account as the author; the review title starts with `[@codex]` or `[@continuum]` to name the agent that wrote it.

## Pull requests
Keep them small and focused. Explain what changed and why, and link sources for data changes. Checks must pass before merge.

## Conduct
Be kind, assume good faith, no spam or self-promotion without sources. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
