# D1 backup and restore (Commonworld v1)

Two lines of defence, in this order:

1. **D1 Time Travel** (built into Cloudflare). Rewinds the live database to any minute of the last 30 days
   (Workers Paid; 7 days on Free). First choice for "we broke the data" (bad migration, bad script, mass deletion).
2. **Our own dumps**: daily, made **by the Worker itself** (Cron Trigger, `src/backup.ts`) into the private R2 bucket
   of its environment (production `commonworld-backups`, staging `commonworld-backups-staging`), checked weekly; by hand with `scripts/d1-backup.sh`. For what Time Travel cannot do: older
   than 30 days, a copy outside the D1 database itself, restoring into a *different* database, a weekly proof that the
   backup is complete and readable.

Production DB: `commonworld-prod` (`--env production`). Staging: `commonworld-staging` (`--env staging`).
All commands run from `platform/` with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID=<CLOUDFLARE_ACCOUNT_ID>`
set (or a `wrangler login`).

---

## 1. Time Travel (first line)

Before anything risky, write down the current bookmark (it is also how you undo a restore):

```
npx wrangler d1 time-travel info commonworld-prod --env production
```

See which bookmark a moment in time maps to (read-only):

```
npx wrangler d1 time-travel info commonworld-prod --env production --timestamp=2026-11-02T14:00:00Z
```

Rewind. **This overwrites the live production DB in place** - the owner decides, and the bookmark from the first
command is written down first:

```
npx wrangler d1 time-travel restore commonworld-prod --env production --timestamp=2026-11-02T14:00:00Z
# or to an exact bookmark:
npx wrangler d1 time-travel restore commonworld-prod --env production --bookmark=<bookmark>
```

Undo the rewind: run `restore` again with the bookmark you wrote down before it.

Known bookmark: clean schema, all migrations, no data (2026-10-18):
`<bookmark>`.

---

## 2. Our dumps (second line)

### Why not just `wrangler d1 execute --file dump.sql`

Tested in the restore drill (2026-10-18, staging): the raw `wrangler d1 export` file does **not** import back.
`sections` references `section_groups`, which the dump creates later, so the import stops with a foreign-key error;
`PRAGMA defer_foreign_keys` does not help, and remote D1 commits each `--file` on its own (a failed import leaves a
half-filled database). `scripts/d1-restore.sh` does the method that works, in one command:

1. all `CREATE TABLE` first,
2. the rows, one file per table, parent tables before the tables that reference them (order worked out from
   `PRAGMA foreign_key_list` on a local sqlite copy of the dump),
3. indexes, triggers, views,
4. `sqlite_sequence` last - so AUTOINCREMENT counters (citizen numbers!) continue where they were,
5. check: every table's row count and every `sqlite_sequence` counter compared with the backup's manifest,
   then **PASS** or **FAIL** (exit code 0 / 1).

### Make a backup by hand

```
scripts/d1-backup.sh commonworld-prod --env production --out ~/cw-backups
```

Read-only for the database (`d1 export` only reads; Cloudflare docs: a running export blocks other requests to
the DB for its duration - about 6 s at staging size). It writes three files and prints their paths:

| File | What it is |
|---|---|
| `commonworld-prod-20261102T030000Z.sql.gz` | the dump, gzipped (`.sql.gz.age` when encrypted - then no plain copy is kept) |
| `commonworld-prod-20261102T030000Z.sha256` | checksum; `sha256sum -c <file>.sha256` checks the dump |
| `commonworld-prod-20261102T030000Z.manifest.json` | time (UTC), DB, env, row count per table, `sqlite_sequence` counters, last migration (id + name), size and sha256 of the dump. Counts only, no row data. |

**Encryption.** Set `AGE_RECIPIENT` to an age *public* key (`age1...`) and the dump is encrypted before it is
written; only the matching private key can open it:

```
AGE_RECIPIENT=age1... scripts/d1-backup.sh commonworld-prod --env production --out ~/cw-backups
```

Dumps contain all public content and account hashes, and deleted accounts live on in them until the file is
deleted, so: never commit them (`backups/` is gitignored), keep them encrypted outside the laptop, delete them on
schedule (retention below).

### Restore

Always into a **new, empty** database - never into the live one (the script refuses a target that already has
tables, and refuses the name `commonworld-prod` without `--i-know`).

```
npx wrangler d1 create commonworld-restore-test --location weur
scripts/d1-restore.sh ~/cw-backups/commonworld-prod-20261102T030000Z.sql.gz commonworld-restore-test
#   encrypted dump: AGE_IDENTITY_FILE=~/.age/commonworld-backup.key scripts/d1-restore.sh <file>.sql.gz.age commonworld-restore-test
```

The script finds `<same name>.manifest.json` next to the dump (or take `--manifest FILE`), checks the dump's sha256
against it, imports in about 30 steps (~2 min at staging size) and ends with `PASS: 32 tables, N rows, ...`.
If a step fails it says which one; then delete the target and start again with a fresh one.

Other flags: `--env X` (wrangler environment), `--verify-only` (only re-check counts of an already restored DB),
`--keep-workdir` (keep the generated step files for debugging - they contain row data, delete them after),
`--local` (a local `wrangler dev` DB, used for testing).

**Switching production to the restored DB** (only when Time Travel cannot help, owner decision): after PASS, put the
restored DB's `database_id` (`npx wrangler d1 info commonworld-restore-test`) into `[[env.production.d1_databases]]`
in `wrangler.toml`, keep `database_name` in sync, deploy (`npx wrangler deploy --env production`). Writes made after
the backup time are lost - check Time Travel first.

Delete a scratch DB when done:

```
npx wrangler d1 delete commonworld-restore-test
```

---

## 3. Automatic: daily backup + weekly restore check (inside Cloudflare)

Since 2026-10-19 (owner decision) this runs in the platform Worker itself, not in GitHub Actions: no GitHub secrets, no
separate API tokens, no age key. Code: `src/backup.ts`; crons in `wrangler.toml` (`[triggers]`, every env); R2 binding
`BACKUPS` → **one bucket per environment** (owner decision 2026-10-20), so the staging Worker physically cannot read
or overwrite production backups:

| Environment | `ENVIRONMENT` | R2 bucket (binding `BACKUPS`, var `BACKUPS_BUCKET`) | Key prefix | Lifecycle |
|---|---|---|---|---|
| production (`--env production`) | `production` | `commonworld-backups` | `prod/` | `expire-35d` (35 days) |
| staging (`--env staging`) | `staging` | `commonworld-backups-staging` | `staging/` | `expire-35d` (35 days) |
| local (tests, `wrangler dev`) | `local` | `commonworld-backups-local` (simulated, never created in Cloudflare) | `local/` | - |

Defence in depth: the key prefixes stay, and every job first checks that `ENVIRONMENT`, `BACKUPS_BUCKET` and the key
prefix match this table (`BACKUP_TARGETS` in `src/backup.ts`); an unset or unknown `ENVIRONMENT` counts as a
mismatch. The restore check also refuses a manifest whose artifact key is outside `<env>/d1/`. On a mismatch it reads and writes nothing and logs one
line `d1 backup REFUSED backup target mismatch (env=… bucket=… prefix=…/): …` (`console.error`); the admin endpoints
answer `503 backup_target_mismatch`. `test/backup-target.test.ts` parses `wrangler.toml` and checks that staging and
production bind different buckets and production's is `commonworld-backups`. The old GitHub workflow draft `ops/d1-backup.yml` is removed.

| When (UTC) | Job | Writes |
|---|---|---|
| daily 03:00 (before the 03:17 retention clean-up) | **backup**: every D1 table (schema from `sqlite_master` + every row, read in pages of 5000; at today's size every table is one page and all pages are one D1 batch = one consistent snapshot) → one SQL file → gzip | `<env>/d1/YYYY-MM-DD.sql.gz` + `<env>/d1/YYYY-MM-DD.manifest.json` |
| Monday 04:30 | **restore check** of the newest backup: sha256 of the `.gz` and of the SQL, every statement parsed (each row decoded, column count checked), table list + row count per table + `sqlite_sequence` counters against the manifest, newest backup ≤ 36 h old | `<env>/checks/YYYY-MM-DD.json` |

`<env>` = `prod` (production), `staging`, `local` (tests / `wrangler dev`, simulated bucket). Each env has its own bucket (table above).

**Manifest** = same format as `scripts/d1-backup.sh` (`commonworld-d1-backup/1`): `created_utc`, `db`, `env`,
`source` (`worker-cron`), `last_migration`, `table_count`, `total_rows`, `tables` (rows per table), `sqlite_sequence`,
`sql_sha256`, `sql_bytes`, `duration_ms`, `artifact` {file, key, bytes, sha256, gzip, encrypted:false}. Counts and
hashes only. So **`scripts/d1-restore.sh` restores a Worker backup unchanged** (download both files next to each other):

Production:

```
npx wrangler r2 object get commonworld-backups/prod/d1/2026-11-02.sql.gz --file 2026-11-02.sql.gz --remote
npx wrangler r2 object get commonworld-backups/prod/d1/2026-11-02.manifest.json --file 2026-11-02.manifest.json --remote
npx wrangler d1 create commonworld-restore-test --location weur
scripts/d1-restore.sh 2026-11-02.sql.gz commonworld-restore-test        # sha256 check, FK-ordered import, PASS/FAIL
```

Staging (its own bucket):

```
npx wrangler r2 object get commonworld-backups-staging/staging/d1/2026-11-02.sql.gz --file 2026-11-02.sql.gz --remote
npx wrangler r2 object get commonworld-backups-staging/staging/d1/2026-11-02.manifest.json --file 2026-11-02.manifest.json --remote
npx wrangler d1 create commonworld-restore-test --location weur
scripts/d1-restore.sh 2026-11-02.sql.gz commonworld-restore-test
```

Then delete the scratch DB (`npx wrangler d1 delete commonworld-restore-test`).

The dump is plain SQLite (`sqlite3 x.db < dump.sql` works): marker comments `-- cw:table|data|seq|index|trigger|view
<name>` before each block, one single-line `INSERT` per row (newlines inside text are written as `'…'||char(10)||'…'`),
`-- cw:end <total rows>` as the last line (a cut-off file has none).

**Where failures show up.** Every run writes one log line (Workers Logs, kept 7 days): `d1 backup OK <key> <bytes> …` /
`d1 restore check PASS …` with `console.log`; `d1 backup FAILED …` / `d1 restore check FAIL … problems: …` with
`console.error`. Logs never contain row data. And the admin endpoint:

```
curl -s -H "Authorization: Bearer $ADMIN_KEY" https://commonworld.one/v1/admin/backups | jq '{healthy, problems, latest_check}'
```

`healthy` is false when there is no backup, the newest is older than 36 h (the daily job stopped or was killed),
there is no check yet, the newest check failed, or the newest check is older than 8 days (the Monday job stopped), or a backup or check timestamp lies in the future (more than 5 min ahead). Run a job by hand (same code as the cron; a backup overwrites
today's file):

```
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"job":"backup"}' https://commonworld.one/v1/admin/backups/run | jq
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"job":"restore-check"}' https://commonworld.one/v1/admin/backups/run | jq
```

### Verify the Monday check

The check runs every Monday at 04:30 UTC (cron times are UTC all year, no daylight-saving shift). On Monday after 04:30 UTC:

1. `GET /v1/admin/backups` (admin key): `latest_check.ok` is `true`, `latest_check.checked_at` is today ~04:30 UTC,
   `latest_check.backup_key` is today's `<env>/d1/YYYY-MM-DD.sql.gz`, `problems` is empty and `healthy` is `true`.
2. The check file is in R2 (read-only, needs a token with R2 read on the bucket):
   ```
   npx wrangler r2 object get commonworld-backups/prod/checks/2026-11-02.json --pipe --remote | jq '{ok, backup_key, age_hours, table_count, total_rows, problems}'
   # staging:
   npx wrangler r2 object get commonworld-backups-staging/staging/checks/2026-11-02.json --pipe --remote | jq '{ok, backup_key, problems}'
   ```
3. Workers Logs of `commonworld-api` (dashboard → Workers → Observability, filter on the cron event): one line
   `d1 restore check PASS …`; a `FAIL` line lists the problems.

If it says FAIL: run `POST /v1/admin/backups/run {"job":"backup"}` and then `{"job":"restore-check"}`. If the fresh pair
passes, the old file was the problem (stale or cut off - usually the daily cron did not run; see CPU cap below). If it
still fails, restore the newest good backup into a scratch D1 with `scripts/d1-restore.sh` (section 2) to see which
table differs, and keep Time Travel (section 1) as the fallback.

**Locally, without Cloudflare** (no remote resources touched; local D1 and a simulated R2 under `local/`):

```
npx wrangler d1 migrations apply commonworld-dev --local
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"     # backup  -> local/d1/<today>.sql.gz + manifest
curl "http://localhost:8787/__scheduled?cron=30+4+*+*+1"    # check   -> local/checks/<today>.json, log line PASS
```

The same paths are covered in `npm test` (`test/backup.test.ts`: cron dispatch, PASS and FAIL cases, restore roundtrip).

What the weekly check does **not** do: load the dump into a real database (a Worker cannot create a scratch D1
without an API token). That proof is `scripts/d1-restore.sh` by hand (section 2) - once on launch day, then e.g. monthly.
Done on 2026-10-19 with a staging backup in the Worker format: PASS (section 5).

**CPU cap.** `[limits] cpu_ms = 100` (staging, production) applies to cron runs too. Measured on the 2026-10-19
staging backup (296 KB SQL, 1130 rows; Node, not the Workers runtime): the check's gunzip + 2× sha256 + full parse took
~10-50 ms CPU, gzip ~8 ms. Fine today; as the DB grows, watch the CPU time of the cron invocations
(dashboard → Workers → commonworld-api → Metrics / Cron Events). A run killed by the cap writes no log line of its
own - it shows up as "newest backup older than 36 h" (`healthy: false`, the weekly check FAILs). Then raise `cpu_ms`
or move the two jobs into a small separate Worker.

**Retention: 35 days** (owner decision 2026-10-18) **on both buckets**: each bucket (`commonworld-backups` and
`commonworld-backups-staging`) has the lifecycle rule `expire-35d` (all prefixes): objects deleted 35 days after upload,
unfinished multipart uploads aborted by the bucket's multipart rule. Privacy says backups are kept "for up
to 35 days" (plus D1 Time Travel 30 days). Not age-encrypted any more: the bucket is private (no r2.dev URL, no custom
domain) and R2 encrypts every object at rest.

---

## 4. Current state and launch-day history

### Current state (checked 2026-10-27)

- **Backup cron and R2 binding are deployed in production** since the first successful production deploy,
  2026-10-20 (`744fb1a`, run [39474179999](https://github.com/commonworld-one/commonworld/actions/runs/39474179999)): its deploy log lists `env.BACKUPS (commonworld-backups)`
  and the four schedules `17 3 * * *`, `7 * * * *`, `0 3 * * *`, `30 4 * * 1`. Every later production deploy carries
  them; the latest, 2026-10-26 (`26c6754`, run [40407942748](https://github.com/commonworld-one/commonworld/actions/runs/40407942748)), lists the same binding and schedules.
- **Archives in `commonworld-backups`:** not recorded in this repository or in public CI. The status is behind admin
  sign-in (`GET /v1/admin/backups` answers 401 without it), so check it there and write the result here.
- **Restore drill:** not yet recorded for production backups. What is recorded: the manual drill of 2026-10-18 and the
  staging rehearsal of 2026-10-19 (the drill note in section 2 and section 5, both before the Worker was deployed).
- **Staging:** the staging Worker config binds `commonworld-backups-staging` with the same schedules (`wrangler.toml`
  `[env.staging]`); a staging run is not recorded here.

### History: launch-day checklist (as written on 2026-10-20, kept unchanged)

The open items below were the plan before the first production deploy. The production deploy item is done (see Current
state); the others are not recorded as done.

- [x] Retention decided 2026-10-18: 35 days; Privacy N = 35.
- [x] R2 bucket `commonworld-backups` (WEUR, private) + lifecycle `expire-35d` - created 2026-10-19. Production only from
      2026-10-20 (owner decision: separate buckets).
- [x] R2 bucket `commonworld-backups-staging` + lifecycle `expire-35d` (delete after 35 days; the
      bucket's default rule aborts incomplete multipart uploads after 7 days) - created by the owner 2026-10-20.
- [x] Code: crons + `BACKUPS` binding in `wrangler.toml` for staging and production (2026-10-20, not deployed yet).
- [ ] Deploy it to staging first (owner's yes), run both jobs there, and see the next Monday check PASS on staging.
- [ ] Deploy production as usual (`../docs/DEPLOY.md`); the crons and the binding come with it. Nothing else to set.
- [ ] Right after the deploy: `POST /v1/admin/backups/run {"job":"backup"}`, then `{"job":"restore-check"}` → `ok: true`;
      `GET /v1/admin/backups` → `healthy: true`.
- [ ] Restore once by hand from R2 into a scratch D1 with `scripts/d1-restore.sh` (section 3), then delete the scratch DB.
- [ ] Next morning: `GET /v1/admin/backups` shows a backup made by the 03:00 UTC cron (`uploaded` ≈ 03:00 UTC).

## 5. Tested

2026-10-19 (Worker backup):
- Tests `test/backup.test.ts`: dump → restore into an empty second D1 gives identical rows in every table, identical
  schema and `sqlite_sequence` (text with newlines, quotes, tabs, emoji, blobs); paging = one page; manifest + R2
  keys + both sha256; restore check PASS, and FAIL on no backup / stale (> 36 h) / changed manifest count / corrupted
  file; cron dispatch (03:00 backs up, Mon 04:30 checks, the retention cron does neither); admin endpoints; no row
  content in logs. OpenAPI contract test covers both endpoints.
- Staging data, real R2: the same `src/backup.ts` code was rehearsed on staging on 2026-10-19 (staging D1 read-only,
  R2 bucket `commonworld-backups`, before the buckets were split): `staging/d1/2026-10-19.sql.gz` (24 935 B gzip,
  295 817 B SQL, 32 tables, 1130 rows), restore check PASS
  (`staging/checks/2026-10-19.json`). Independent check: Python sqlite loaded the file, counts = manifest; then
  `scripts/d1-restore.sh … commonworld-dev --local` imported it into a local D1: `PASS: 32 tables, 1130 rows, 12
  sqlite_sequence counters match`. Local copies deleted. Not yet seen: a run by the deployed Worker (cron or admin endpoint).
  The rehearsal objects under `staging/` in `commonworld-backups` expire with its 35-day rule; new staging backups go to
  `commonworld-backups-staging`.

2026-10-18 (scripts):
- Local D1 (migrations 0001-0020 + mockup seed, 32 tables / 1257 rows): raw dump import fails as in the drill
  (`no such table: main.section_groups`); `d1-backup.sh` -> `d1-restore.sh` PASS, plain and age-encrypted;
  independent check: all 97 schema objects identical and every row of every table identical.
  Refusals work: `commonworld-prod` without `--i-know`, non-empty target, encrypted dump without a key;
  a deleted row is caught (`FAIL: votes expected 458, got 457`).
- Staging (read-only): `d1-backup.sh commonworld-staging --env staging` - 197 KB export in 5 s, 32 tables / 701 rows,
  last migration 20; that dump restored into a local D1: PASS. Dump files deleted afterwards.
- `wrangler d1 time-travel info commonworld-staging --env staging` answers (bookmark returned).
- Not tested: `d1-restore.sh` against a *remote* scratch DB (the manual drill did the same method remotely).
