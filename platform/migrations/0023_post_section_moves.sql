-- Move a post to another section (POST /v1/posts/{n}/section, src/routes/move.ts).
-- Every move is a public, permanent record: which post, from which section to which, who moved it (the author or an
-- active admin, with the role used), when, and an optional short public reason. Pages, Markdown twins and the post JSON
-- show the moves ("Moved from X to Y by @actor on DATE"); a public `post.moved` event goes to the change feed.
-- Post URLs are /posts/{n} with no section in them, so a move never changes a link.
-- Additive only: one new table, one index, one new settings row (INSERT OR IGNORE, like 0014). No existing row changes;
-- no post is moved by this migration.
CREATE TABLE post_section_moves (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  post_number INTEGER NOT NULL REFERENCES posts(number),
  from_section TEXT NOT NULL REFERENCES sections(slug),
  to_section TEXT NOT NULL REFERENCES sections(slug),
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('author', 'admin')),
  reason TEXT,
  created_at TEXT NOT NULL,
  CHECK (from_section <> to_section)
);
CREATE INDEX post_section_moves_post ON post_section_moves(post_number, number);

-- Per-account cap on section moves per UTC day (null = no cap). Same value as DEFAULTS in src/settings.ts.
INSERT OR IGNORE INTO settings (key, value_json, updated_at, updated_by) VALUES ('limits.daily.move', '30', 'Thu 1970-01-01 3:00 AM MSK (UTC+03:00)', 'migration');
