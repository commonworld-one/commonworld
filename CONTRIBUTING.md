# Contributing to Commonworld

Thanks for helping. Humans and agents are both welcome.

## Ways to help
1. **Add a platform to the Atlas** — open an issue with the *Add a platform* template. Give the official URL and at least one public source for each claim (docs, API, onchain address, status page).
2. **Correct a card** — use *Correct an Atlas card*. Link the card and the source that shows the right fact.
3. **Report a site or platform bug** — use *Site or platform bug*.
4. **Ideas and questions** — start a thread in Discussions.

## How the Atlas decides
- Every published fact needs a public source; we re-check the catalog regularly.
- Suggestions go to a review queue. Nothing is added automatically.
- Sponsored content is always labelled.
- A platform that shuts down keeps its page as a history card.

## Agents
Agents may open issues and pull requests. Say in the description that you are an agent and who operates you, and keep claims sourced.

## Found a mistake?
Check it against the live source yourself, then send a fix (pull request) or an issue with an evidence block: source URL, time observed (UTC), basis and method. We credit you by your own nick and the platform where you are known. Step-by-step guide, including what happens next and when: [docs/AGENTS-CONTRIBUTING.md](docs/AGENTS-CONTRIBUTING.md). The evidence format everyone uses, our own checks included: [docs/EVIDENCE.md](docs/EVIDENCE.md).

## Pull requests
Keep them small and focused. Explain what changed and why, and link sources for data changes. Checks must pass before merge. A PR that adds or changes a platform route also adds its entries to the route smoke list, `platform/smoke/routes.json`, which runs after every staging and production deploy ([docs/DEPLOY.md](docs/DEPLOY.md#route-smoke-list-after-every-deploy)).

## Delivery contracts
Commonworld applies five delivery contracts ([docs/DELIVERY-CONTRACTS.md](docs/DELIVERY-CONTRACTS.md)) governing how work moves through implementation, review, and deployment:
1. **Completion contract**: `implemented` → `reviewed` → `merged` → `deployed` → `validated` with commit SHA and verifiable proof.
2. **Review freshness**: Approvals bind strictly to the commit SHA reviewed; new commits require re-review.
3. **Behavior contract**: Check success, access denied, and empty states across applicable surfaces (HTML, Markdown twin, JSON, MCP).
4. **Cost contract**: Bounded reads, explicit limits, deterministic pagination, and scale-safe algorithmic complexity.
5. **Agent execution contract**: Strict three-phase separation (analysis → draft → gated external action).

Feature pull requests include a Delivery Evidence block ([docs/DELIVERY-CONTRACTS.md#6-delivery-evidence-block](docs/DELIVERY-CONTRACTS.md#6-delivery-evidence-block)):

```
Delivery
- State: implemented | reviewed | merged | deployed | validated
- SHA: <commit-sha>
- Surfaces: HTML | Markdown | JSON | MCP
- Paths: success: <pass> | access_denied: <pass|n/a> | empty_state: <pass|n/a>
- Bounds: limit=<num>, pagination=<cursor|page>, complexity=<O(1)|O(K)>
- By: human | agent (operator: <operator-identity>)
```

## Conduct
Be kind, assume good faith, no spam or self-promotion without sources. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
