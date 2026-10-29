# Public external-link fixtures

Sources:
- [Original public report #146](https://github.com/commonworld-one/commonworld/issues/146), linked [run40314028376](https://github.com/commonworld-one/commonworld/actions/runs/40314028376).
- [Snapshot source at62d61483088f266c24bfa61d122bb3486c74f5dc](https://github.com/commonworld-one/commonworld/blob/62d61483088f266c24bfa61d122bb3486c74f5dc/atlas/data/snapshot-verified-2026-10-15.json), Git blob `2edfbb94aca06e5ffb22cd2dc803f53b342c9423`.

`report.md` preserves eight literal finding lines and their source headings from that older report. Its summary counts are **recomputed for this excerpt**, not the original run totals: 7 errors, 1 timeout, 8 unique links. It includes two expected API responses and negative controls (homepage, news article, TLS,404,503,timeout). Nothing in the report text is executed.

`snapshot.json` contains only the two cards' slugs, canonical URLs and relevant protocol-claim fields. Those fields are copied from the pinned public source; unrelated fields/cards are omitted deliberately.

These fixtures are not #167's newer117-error report, a fresh endpoint observation, a payment or authenticated service test. Additional malformed/dot-segment/file-alias cases in the tests are synthetic boundary fixtures, not claims about public services.

