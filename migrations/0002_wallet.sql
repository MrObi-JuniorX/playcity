-- Whot Cup wallet and ledger (docs/whot-cup-prd.md, Phase 2: WL-1 to WL-5).
-- Every balance is the sum of append-only ledger entries. Each entry moves a whole amount from one account to
-- another, so the books always sum to zero per currency. accounts.balance is a running total kept in the same
-- transaction as the entry; the CHECK below makes the database itself refuse an overdraft.

CREATE TABLE accounts (
  id              TEXT PRIMARY KEY,               -- p:<player>:COIN, platform:COIN, issuer:COIN, cup:<cup>:COIN, sponsor:<id>:COIN
  kind            TEXT NOT NULL,                  -- player | platform | issuer | cup | sponsor
  owner           TEXT,                           -- player id, cup id or sponsor id
  currency        TEXT NOT NULL,                  -- COIN (NGN in the cash phase)
  balance         INTEGER NOT NULL DEFAULT 0,
  allow_negative  INTEGER NOT NULL DEFAULT 0,     -- only the coin issuer, which creates coins
  last_topup_day  INTEGER,                        -- the Lagos day of the last daily top-up claim (players)
  created_at      INTEGER NOT NULL,
  CHECK (balance >= 0 OR allow_negative = 1)
);

CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY,                -- no AUTOINCREMENT: rows are never deleted, so ids only grow, and it saves a write per entry
  idem_key      TEXT NOT NULL UNIQUE,             -- a retried write can never apply twice (WL-2)
  from_account  TEXT NOT NULL REFERENCES accounts(id),
  to_account    TEXT NOT NULL REFERENCES accounts(id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  currency      TEXT NOT NULL,
  kind          TEXT NOT NULL,                    -- welcome | topup | stake | sc_stake | platform_cut | table_pay | gf_prize | refund | cheer | sponsor | adjust
  player_id     TEXT,                             -- the player side of the entry, for their history
  cup_id        TEXT,
  memo          TEXT,
  created_at    INTEGER NOT NULL,
  CHECK (from_account <> to_account)
);
CREATE INDEX ledger_player ON ledger(player_id, id) WHERE player_id IS NOT NULL;
CREATE INDEX ledger_cup    ON ledger(cup_id) WHERE cup_id IS NOT NULL;

-- Global settings edited in the admin console (PRD 5.1, economy). Read with defaults when a key is missing.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
