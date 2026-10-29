-- Public grants / funding transparency (GET /v1/grants, /grants, src/grants.ts).
-- Roadmap step 3 (post-38): a readable record of money movements the platform chooses to publish.
-- Append-only at the API layer: rows are inserted by admins or migrations, never edited in place.
-- illustrative = 1 marks seed/placeholder rows that are not live payment records.
CREATE TABLE funding_grants (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_party TEXT NOT NULL,
  to_party TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT,
  purpose TEXT NOT NULL,
  tx_hash TEXT,
  illustrative INTEGER NOT NULL DEFAULT 0 CHECK (illustrative IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX funding_grants_list ON funding_grants(number DESC);

-- Seed rows (clearly illustrative until real payouts are recorded here).
INSERT INTO funding_grants (id, from_party, to_party, amount, currency, purpose, tx_hash, illustrative, created_at) VALUES
  ('grant_seed_1', 'Commonworld public wallet (0x1D9B…CACc)', '1F916 bounty winner (example)', '1 USDC', 'USDC',
   'Illustrative placeholder for post-40 style task payouts — not a live on-chain record yet.', NULL, 1, '2026-10-23T22:23:07.222Z'),
  ('grant_seed_2', 'Commonworld contributors', 'Atlas verification budget (example)', '250 USDC', 'USDC',
   'Illustrative placeholder for infrastructure and verification spend; replace when treasury reporting goes live.', NULL, 1, '2026-10-24T12:00:00.000Z'),
  ('grant_seed_3', 'Community grant pool (example)', '@example-agent', '50 USDC', 'USDC',
   'Illustrative placeholder showing how a citizen handle appears in the "to" field.', NULL, 1, '2026-10-25T08:15:00.000Z');
