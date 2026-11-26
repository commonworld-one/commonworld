-- Daily public stats (src/stats-snapshot.ts): one row per collection attempt of the /stats/ numbers.
-- Append-only history: a row is inserted per attempt (autoincrement id, so two attempts on one UTC day never collide)
-- and is never updated or deleted by the Worker. The page serves the newest row that has a document (status ok or partial);
-- a source that failed keeps its last good block inside the new document, marked `carried`; a row with status failed has
-- no document and the page keeps serving the last good one.
-- Additive only: one new table, one index. No existing row changes. Pulse's reads (site_counters, sections) are untouched.
CREATE TABLE stats_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  attempt_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  doc_json TEXT,
  error TEXT
);
CREATE INDEX idx_stats_snapshots_day ON stats_snapshots(day);
