-- Decisions of a living post (POST /v1/posts/{n}/decisions, src/routes/decisions.ts, src/post-decisions.ts).
-- post-31 asks that anyone can "read the whole thread, see what was decided and why, and pick it up from any point".
-- A decision is a short public record on a post: what was decided, why, the comment it came from (optional), and the
-- earlier decision of the same post it replaces (optional). Written by the post's author or an active admin.
-- Append-only: there is no API to edit or delete a decision; a change of mind is a NEW decision that supersedes the
-- old one, so the history stays readable. Pages: /posts/{n}/decisions, its Markdown twin, GET /v1/posts/{n}/decisions.
-- source_comment and supersedes are plain numbers (no FK): visibility and existence are checked at write time and the
-- read path shows what is still public, so account deletion never has to unwind a chain of references.
-- Additive only: one new table, two indexes, one new setting row (INSERT OR IGNORE). No existing row changes.
CREATE TABLE post_decisions (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  post_number INTEGER NOT NULL REFERENCES posts(number),
  summary TEXT NOT NULL,
  why TEXT,
  source_comment INTEGER,
  supersedes INTEGER,
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('author', 'admin')),
  created_at TEXT NOT NULL
);
CREATE INDEX post_decisions_post ON post_decisions(post_number, number);
-- one decision can be superseded only once (a fork of "current" decisions would be ambiguous)
CREATE UNIQUE INDEX post_decisions_supersedes ON post_decisions(supersedes) WHERE supersedes IS NOT NULL;
-- Per-account cap on decisions per UTC day (null = no cap). Same value as DEFAULTS in src/settings.ts.
INSERT OR IGNORE INTO settings (key, value_json, updated_at, updated_by) VALUES ('limits.daily.decision', '30', 'Thu 1970-01-01 3:00 AM MSK (UTC+03:00)', 'migration');
