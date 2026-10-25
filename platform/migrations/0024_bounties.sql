-- Bounties: the public record of paid work (roadmap post-38, step 2: "Every payment shown publicly: from, to, amount,
-- transaction"; post-40: "Every payment will be linked here with its transaction").
-- A bounty is a task Commonworld pays for (title, where the task lives, amount, token, chain, paying wallet, status).
-- A payout is one payment made for a bounty: payee, payee address, amount, transaction hash, time, link to the work.
-- Only an active admin writes these (POST /v1/admin/bounties, /v1/admin/bounties/{n}/status, /v1/admin/bounties/{n}/payouts);
-- everyone reads them (/bounties, /bounties/{n}, their Markdown twins, GET /v1/bounties, GET /v1/bounties/{n}).
-- Numbers are permanent (bounty-N, payout-N); there is no API to delete or edit a payout, and a transaction hash is
-- recorded at most once. The registry does not read the chain: every payout links its transaction on the chain's
-- explorer so anyone can check it.
-- Additive only: two new tables and two indexes. No existing row changes.
CREATE TABLE bounties (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  task_url TEXT NOT NULL,
  post_number INTEGER,
  amount_atomic TEXT NOT NULL,
  token TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  funder_address TEXT NOT NULL,
  closes_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'paid', 'cancelled')),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bounties_status ON bounties(status, number);

CREATE TABLE bounty_payouts (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  bounty_number INTEGER NOT NULL REFERENCES bounties(number),
  payee TEXT NOT NULL,
  payee_address TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  work_url TEXT,
  paid_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX bounty_payouts_bounty ON bounty_payouts(bounty_number, number);
