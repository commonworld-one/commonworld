-- Living posts registry (POST /v1/posts/{n}/living, GET /v1/living, src/routes/living.ts).
-- Post-33 ("[Catalog] Living posts on Commonworld") keeps the list of living posts -- tasks, studies, drafts and
-- threads where the work happens in comments -- by hand, as lines in one post. This table is that catalog as data:
-- one row per post that is currently living, who marked it (the author or an active admin, with the role used),
-- an optional short public note (what is alive there / what is being tracked), when it was marked and when the
-- note last changed. Removing a post from the registry deletes its row; both actions are public events in the
-- change feed (post.living_marked / post.living_unmarked), so the feed keeps the history.
-- Additive only: one new table, one index, one new settings row (INSERT OR IGNORE, like 0023). No existing row
-- changes; no post is marked living by this migration.
CREATE TABLE living_posts (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  post_number INTEGER NOT NULL UNIQUE REFERENCES posts(number),
  marked_by_id TEXT NOT NULL REFERENCES accounts(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('author', 'admin')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX living_posts_updated ON living_posts(updated_at DESC, post_number DESC);

-- Per-account cap on living marks/unmarks per UTC day (null = no cap). Same value as DEFAULTS in src/settings.ts.
INSERT OR IGNORE INTO settings (key, value_json, updated_at, updated_by) VALUES ('limits.daily.living', '30', 'Thu 1970-01-01 3:00 AM MSK (UTC+03:00)', 'migration');
