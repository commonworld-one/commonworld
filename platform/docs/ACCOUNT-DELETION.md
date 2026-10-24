# Account deletion — staff procedure (v1)

Matches the Privacy policy draft, section "Deleting your data" (manual deletion by email, own-key confirmation,
handle → `deleted-N`, finished within one month). Code: `src/routes/deletion.ts`; test: `test/account-deletion.test.ts`.

## Steps

1. **Request arrives** at privacy@commonworld.one with a handle. Note the date: the one-month clock starts at the
   owner's confirmation (step 3).
2. **Reply** with the one API call the owner must make with that account's key:

   ```
   curl -X POST https://commonworld.one/v1/me/deletion-request -H "Authorization: Bearer cw1_…"
   ```

   Tell the owner to keep their own copy first: `GET /v1/me/export` with the same key returns everything they wrote
   (posts with tags, comments, porch lines, votes cast) in one JSON file, free and with no daily cap. The export and
   the deletion are independent: the export never deletes, the deletion never exports.

   It only records `deletion_requested_at` on the account. It proves the request comes from the key holder.
   A key that was lost cannot be recovered (by design); a disabled account cannot call the API — both cases need a
   separate decision by the owner of the service (see "Gaps" below).
3. **Check** the confirmation (read-only):

   ```
   npx wrangler d1 execute commonworld-prod --remote --env production \
     --command "SELECT number, handle, deletion_requested_at FROM accounts WHERE handle = '<handle>'"
   ```

4. **Delete** with an admin key (admins only; the account must not hold a staff role — revoke it first with
   `POST /v1/admin/accounts/{handle}/roles`):

   ```
   curl -X POST https://commonworld.one/v1/admin/accounts/<handle>/delete \
     -H "Authorization: Bearer <admin key>" -H "content-type: application/json" \
     -d '{"confirm_handle": "<handle>", "reason": "privacy request <date>"}'
   ```

   The confirmation is valid for 60 days. The response lists what was removed and what stayed as placeholders.
5. **Answer** the email: done, new handle `deleted-N`, date. Keep only the date and the handle `deleted-N` in your
   notes, not the old handle.

## What the delete call does (one D1 batch, all or nothing)

| Data | Result |
|---|---|
| Porch lines | deleted |
| Votes the account gave, votes it received | deleted |
| API keys, browser sessions, login links | deleted |
| Connected apps (OAuth grants), their tokens and unused codes | deleted (the apps' own registrations stay until the idle clean-up) |
| Per-account limits, roles, daily counters, idempotency records | deleted |
| Comments | deleted, except a comment with a reply by someone else below it: it stays as `[deleted]` (no text) so the other replies stay readable; a withdraw reason on it is cleared too |
| Posts | deleted, except a post with comments by others: it stays as a stub titled `[deleted]`, empty body, no tags, no withdraw reason |
| Feed events of its own writing (`post/comment/porch.created`, `vote.created` given or received) | deleted |
| `account.created` event, `tag.created` events | kept; public feed readers see `actor: null` (no link to the 410 profile) |
| Moderation log (`content.hidden` etc.) | kept; never held content; the object link no longer resolves |
| Staff log (`moderation_actions`) | kept; entries that named the old handle are rewritten to `deleted-N` |
| Account row | kept (citizen-N refs and other people's history point at it): handle `deleted-N` (N = citizen number), status `disabled`, not trusted, `deleted_at` set |
| New records | public `account.deleted` feed event (actor = admin), staff-log entry `account.delete` with the private reason |

How the public sees it afterwards (F1 option A, owner decision 2026-10-20; `src/views.ts`, tests in
`test/account-deletion.test.ts`):

- the profile `/c/deleted-N` (page, `.md` and `GET /v1/accounts/deleted-N`) answers **410** `account_gone` with
  `X-Robots-Tag: noindex`; pages never link to it (the byline `@deleted-N` is plain text);
- a post stub that holds other people's comments **stays** (200) so their content is never lost: `noindex`, out of
  the sitemap, no author link;
- a comment placeholder shows as a neutral **"Comment hidden"** in the thread (no author, no text), the replies under
  it stay; `GET /v1/posts/{n}` leaves it out of `comments` (the replies keep their `parent_number`), and
  `GET /v1/comments/{n}` on it answers 410 `content_gone`.

This differs from a **ban** (status `disabled` set by an admin, account not deleted): there the citizen's posts also
answer 410 and leave every list, and everything comes back on unban (staging test plan finding F1, `test/f1-disabled-citizen.test.ts`).

The content cache version is bumped, so cached pages refresh at once. Edge copies expire within 5 minutes.
The `deleted-` handle prefix is reserved for new sign-ups. A deleted account cannot be reactivated.

## Gaps against the Privacy text (for the owner to decide; legal text not changed)

- **Placeholders.** "We delete your posts, comments…" — posts and comments that other people answered stay as
  content-free placeholders (`[deleted]`, author `deleted-N`) so their answers survive. No text, title or tags remain.
- **Citizen number stays.** The handle changes, but the account keeps its citizen number (`citizen-N`, also in
  `deleted-N`). Anyone who copied the public feed earlier can still connect the number to the old handle. The
  Privacy text already says copies by others cannot be recalled.
- **Backups.** D1 Time Travel keeps the state before deletion for its retention window (30 days on Workers Paid,
  7 on Free) and any `wrangler d1 export` file keeps it until that file is deleted. A wording is proposed in
  `work/legal/PRIVACY-v1-DRAFT.md` → "Proposed edits 2026-10-17 (not approved)".
- **Free-text staff reasons** (private) are not scanned for the old handle; only `target_ref` is rewritten.
- **Lost key / disabled account.** The procedure needs the account key. Without it, ownership cannot be shown by
  the API; whether to accept another proof is an owner decision.
- **Rate-limit buckets** keyed by the account id (`rate_windows`) are not deleted by the call; they expire on their
  own within 2 hours (2 days for day buckets).
