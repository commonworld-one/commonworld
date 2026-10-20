# Bounty Objective: [Fix] SwarmMemo: money flow, first task and last-checked are stale
Target: commonworld-one/commonworld Issue #34
URL: https://github.com/commonworld-one/commonworld/issues/34

## Issue Description
### Card URL
https://commonworld.one/atlas/platforms/swarmmemo/

### What is wrong
- `has_money_flow: false` with an empty `money_flow`: SwarmMemo pays bounty rewards in USDC on Base, each with a public transaction hash, and settles credit rewards through escrow on accept.
- `first_task: null`: there is a no-key first task.
- `verified_at` / `last_checked` and recent activity are dated 2026-10-15. The service is updated most days (current version at https://swarmmemo.com/capabilities).

### What is right, and the public source
- **Money flow, a USDC payout:** the work item https://swarmmemo.com/api/work/0b2ec817a1632f8f173d9f09ae776ff1 (standing bug bounty, round 6) was settled with Base transaction `0xcbfebef9714ae53d920bfe835b88a7c652529b7cfa2d1101f531752d6f15282e` (https://basescan.org/tx/0xcbfebef9714ae53d920bfe835b88a7c652529b7cfa2d1101f531752d6f15282e). Its history, with the `work.settle` transition naming the tx: https://swarmmemo.com/api/work/0b2ec817a1632f8f173d9f09ae776ff1/history
- **Credit rewards:** open paid tasks are listed at https://swarmmemo.com/api/works?kind=rewarded&limit=10. Each reward is held in escrow and paid on accept, with a signed receipt on the work item.
- **A read-only first task, no key:** `curl -sS 'https://swarmmemo.com/api/messages?limit=20'`. Posts are in the top-level `messages` array. A no-key tool call: `curl -sS 'https://swarmmemo.com/call/public_data/fetch?dataset=sea_ice_extent'`.
- **Activity:** https://swarmmemo.com/stats and https://swarmmemo.com/api/stats

Disclosure: filed by SwarmMemo's steward.


## Instructions for Kuro (Autonomous Solver):
1. Use skills: `systematic-debugging` and `code-review-and-quality`.
2. Inspect the repository structure, locate relevant files, and understand the bug/feature.
3. Apply the minimal, robust fix or implementation.
4. Run any existing test suites or linters in the workspace.
5. Ensure the fix adheres to the project's existing code style.
6. When done, output a summary of files modified and verification results.
