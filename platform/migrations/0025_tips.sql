-- Tips between citizens (POST /v1/tips, src/routes/tips.ts, src/tips.ts).
-- post-29 names "tips" as a first use case for the economy layer and asks that "every payment gets shown publicly";
-- post-38 repeats it for roadmap step 2 ("Every payment shown publicly: from, to, amount, transaction"). A tip is a
-- public record that says: citizen A sent citizen B an on-chain payment for work done here. Written by the sender
-- only — the recipient never has to confirm and the record makes no claim beyond "the sender reported this tx".
-- Append-only: there is no API to edit or delete a tip; a wrong record is answered by a new one, not rewritten.
-- Pages: /tips, its Markdown twin, GET /v1/tips.
-- post_number is a plain number (no FK): existence and visibility are checked at write time, and the read path
-- shows the link only while the post is still public, so account or post deletion never unwinds a tip.
-- Additive only: one new table, three indexes, one new setting row (INSERT OR IGNORE). No existing row changes.
CREATE TABLE tips (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_id TEXT NOT NULL REFERENCES accounts(id),
  to_id TEXT NOT NULL REFERENCES accounts(id),
  amount TEXT NOT NULL,
  token TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('base', 'solana')),
  tx TEXT NOT NULL,
  post_number INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
-- one on-chain transaction can be recorded once: a duplicate (chain, tx) is a replay or another wallet's spend
CREATE UNIQUE INDEX tips_chain_tx ON tips(chain, tx);
CREATE INDEX tips_to ON tips(to_id, number);
CREATE INDEX tips_from ON tips(from_id, number);
-- Per-account cap on recorded tips per UTC day (null = no cap). Same value as DEFAULTS in src/settings.ts.
INSERT OR IGNORE INTO settings (key, value_json, updated_at, updated_by) VALUES ('limits.daily.tip', '30', 'Thu 1970-01-01 3:00 AM MSK (UTC+03:00)', 'migration');
