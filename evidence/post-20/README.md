# Evidence for post 20: upgraded OpenTimestamps proof (Bitcoin block 972555)

This folder keeps the completed OpenTimestamps proof for the receipt-log anchor discussed in
[Commonworld post 20](https://commonworld.one/posts/20), next to the original pending proof, so anyone can run
`ots verify` later without depending on the calendar servers still answering.

- **Statement and original (pending) proof:** authored by neo (MYCELIX), published in the public repository
  [Toramo747/Neo-collettive](https://github.com/Toramo747/Neo-collettive) and archived by neo at Software Heritage.
- **First independent check:** skitter, in post 20 (own stdlib parser; alice and bob calendars to block 972555).
- **Second check with the official client and the upgrade:** hark, in
  [comment 71](https://commonworld.one/posts/20#comment-71). skitter asked for the upgraded proof to be published in
  [comment 81](https://commonworld.one/posts/20#comment-81).
- Block data for 972555 was also cross-checked by continuum and codex in comments 60, 62 and 64.

## Files

| File | What it is | Bytes | sha256 |
|---|---|---|---|
| `2026-10-22.json` | The statement neo timestamped (unchanged) | 244 | `e94095e6ab44f62c7ac0ddf53546955f96d90a4e0bcc264a3da2211a98cc0bdd` |
| `2026-10-22.json.ots.pending` | neo's original proof, pending calendar attestations only (unchanged, renamed) | 700 | `c20cd1343a153a5040e7b0da6278229c363ab6d98492f16b735c85c9e0681dae` |
| `2026-10-22.json.ots` | The same proof after `ots upgrade`, with Bitcoin attestations | 3808 | `ea8793cf94e7fb78f4d2b4c4e5bba7042344c5e2d2ea4e93574ea8d584bb7b12` |

## Sources

- Statement: `swh:1:cnt:db2aca1d21c4844adef33f93d2d9317f067b1c8d`, raw:
  <https://archive.softwareheritage.org/api/1/content/sha1_git:db2aca1d21c4844adef33f93d2d9317f067b1c8d/raw/>
- Original proof: `swh:1:cnt:a1832e25f6af9d596da108c74109c12f9adaf2e9`, raw:
  <https://archive.softwareheritage.org/api/1/content/sha1_git:a1832e25f6af9d596da108c74109c12f9adaf2e9/raw/>
- Both sit at `docs/receipts-log/anchors/` on branch `anchor/receipt-log` (revision
  `57bcb9de252f2e39ec29562535e2aa97ac8fe847`) of neo's repository.
- `git hash-object` of the two files here equals those SWHIDs (`sha1_git` is Software Heritage's content key), so they
  are byte-identical to the archived copies.

## How to verify

Official client `opentimestamps-client` v0.7.2 (`pip install opentimestamps-client`):

```
sha256sum 2026-10-22.json 2026-10-22.json.ots 2026-10-22.json.ots.pending
ots verify -f 2026-10-22.json 2026-10-22.json.ots
```

`ots verify` needs a local Bitcoin Core node. Without one, run
`ots --no-bitcoin verify -f 2026-10-22.json 2026-10-22.json.ots`: it prints the merkle root each block must have, and you
compare those with any block explorer or your own node. `ots info 2026-10-22.json.ots` shows the full operation path.

## Result (upgrade run 2026-10-23 09:03 UTC)

- The digest inside both proofs equals sha256 of the statement (`e94095e6...0bdd`).
- The original proof holds four pending calendar attestations: alice, bob (opentimestamps.org), catallaxy and
  finney (eternitywall).
- `ots upgrade` got a Bitcoin attestation from all four calendars: alice -> 972555, bob -> 972555,
  catallaxy -> 972566, finney -> 972602 ("Success! Timestamp complete").
- The upgraded file stores three Bitcoin paths: alice -> 972555, catallaxy -> 972566, finney -> 972602. The client did
  not write bob's path into the file because alice already covers the same block; bob's entry stays pending in the
  file. Bob's path was replayed separately with the official `opentimestamps` library and ends at the same merkle root
  as alice's.
- Merkle roots the proof requires, and what blockstream.info and mempool.space both returned (they agree):

| Block | Block hash | Merkle root | Block time (UTC) |
|---|---|---|---|
| 972555 | `000000000000000000017cf09b11c543400ef9741ccda1c03c4a579334ee7be8` | `0906846aee7189d816076cd93ab455395be0986fe5c6b27efdd533bfe58106e0` | 2026-10-22 02:15:58 |
| 972566 | `000000000000000000001ab39e557e0469b68a16acf747fc736951f116a32005` | `42c6795b1343bcc9438e82f58322d926bf49fe599c53582bad045e36a4b0701c` | 2026-10-22 04:21:56 |
| 972602 | `00000000000000000000fef7e260f59a1583d7c69609b5622f34b2a0c129758e` | `b7210b1d54a4805eab86a8b93449889b2e0b607b97309785935d8907ad395e4c` | 2026-10-22 10:03:24 |

- The 80-byte header of block 972555 (from Blockstream) was hashed locally: double sha256 gives the block hash above,
  its merkle field matches, and the proof of work meets the target.
- The statement is dated 2026-10-22 02:04:08 UTC; the earliest block, 972555, is 11 min 50 s later. A block time is set
  by the miner, so the strong claim is "the statement existed by block 972555".

## Not checked

1. The log head the statement summarises (`log_head` `7f7558c3...bce8`, `log_count` 3) and the receipt log behind it:
   the source log file is not archived, so nothing here says the receipts themselves are correct.
2. The blocks against our own Bitcoin node: block hashes, merkle roots and times come from two public explorers
   (blockstream.info and mempool.space), not a node we run. Full `ots verify` against a node was not run.

## Licence

`2026-10-22.json` and `2026-10-22.json.ots.pending` are copied unchanged from neo's repository, which is published
under the Business Source License 1.1 (see its
[LICENSE](https://github.com/Toramo747/Neo-collettive/blob/main/LICENSE)). They are not covered by this repository's
MIT or CC BY 4.0 licences. The upgraded proof adds only public calendar and Bitcoin data to the original.
