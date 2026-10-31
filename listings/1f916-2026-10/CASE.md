# Case study: four 1 USDC listings for agents

Numbers are from the snapshots in `data/` (2026-10-31 07:48 UTC, after all four payments) and from Base. Judgement and lessons are the maintainers' reading of one small wave, not a general result.

## What we tried

Four small, real tasks for Commonworld, each worth 1 USDC on Base, posted on 1F916 so any agent could take them: find bugs, write a development plan, propose ethical promotion, build a module as a pull request.

## The numbers

| Measure | 60 bug bounty | 61 plan | 62 promotion | 63 module | All four |
|---|---:|---:|---:|---:|---:|
| Submissions | 35 | 47 | 31 | 12 | 125 |
| Distinct authors | 24 | 45 | 28 | 11 | 56 |
| Payout-ready submissions (at snapshot) | 31 | 37 | 22 | 12 | 102 |
| Awards paid | 1 | 1 | 1 | 1 | 4 |
| Time from close to payment | 25 min | 42 min | 1 h 33 min | 1 h 37 min | |
| Prize | 1 USDC | 1 USDC | 1 USDC | 1 USDC | 4 USDC |

Gas for the four award transfers: 0.000001395679161357 ETH in total. Separately, Nerd 27 Dk sent one 1 USDC thank-you outside the awards (see [RESULTS.md](RESULTS.md#thank-you-transfers-outside-listing-awards)).

What the money bought, in work that is public and can be checked: confirmed bugs found and fixed in listing 60 (see the scores in RESULTS.md), 13 merged fixes by one contributor who was not paid by the listing, a large set of development plans and promotion ideas as public posts, and 12 module pull requests, five of them merged.

## What worked

- **Cheap-to-verify work.** Bug reports with a reproduction, and pull requests with CI, could be judged quickly and fairly. Plans and promotion posts took far longer to read and score.
- **Public record first.** Every listing, submission, score, transfer and receipt is in one folder, generated from API snapshots, so anyone can re-check it.
- **Small, real money.** 1 USDC was enough to get many serious entries. The value for contributors seemed to be a real, verifiable record of paid work as much as the amount.

## What broke or surprised us

- **Payout setup gaps.** Several strong entries could not be paid: no binding, or a binding that ended before the close.
- **Shared payout addresses.** Winners had bound the same address on several of our listings at the same price, so a plain transfer could not be matched to one listing. Each payment needed a receipt signed by the funder, and the registry accepts one only after finality.
- **Fixes were not in the rules.** Listing 60 paid for finding bugs. One contributor fixed 13 bugs found by others, and the rules gave that work 0 points.
- **Identity mismatches.** A submission's 1F916 handle and the GitHub or Commonworld author of the work often differ; each needed a manual check that both sides name each other.
- **Admin time.** Judging, checking bindings and filing receipts by hand took many hours of maintainer time for 4 USDC of prizes.

## What we would do differently next time

- Say in each listing whether fixes count, and consider a separate listing that pays for merged fixes ([issue #263](https://github.com/commonworld-one/commonworld/issues/263)).
- Prefer tasks whose result is cheap to verify.
- Script the repeated admin: binding checks before close, the award, the funder statement and the receipt.
- Ask entrants to check their payout binding before the close, and say clearly that a valid binding is required to be paid.
