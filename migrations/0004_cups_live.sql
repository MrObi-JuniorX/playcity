-- Whot Cup registration, check-in and live cups (docs/whot-cup-prd.md, Phases 4 and 5).

-- One row per player per cup.
CREATE TABLE registrations (
  cup_id        TEXT NOT NULL REFERENCES cups(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  state         TEXT NOT NULL,      -- entered | waitlist | seated | playing | out | no-show | refunded | finished
  seq           INTEGER NOT NULL,   -- entry order (first-come waitlist order)
  draw_rank     INTEGER,            -- place in the random draw, when the cup used one
  entered_at    INTEGER NOT NULL,
  checked_in_at INTEGER,
  device_id     TEXT NOT NULL,      -- seating signals (PRD SE-2)
  ip_hash       TEXT NOT NULL,
  invited_by    TEXT,
  sc_bought     INTEGER NOT NULL DEFAULT 0,
  won           INTEGER NOT NULL DEFAULT 0,
  finish        TEXT,               -- how far they got, set at settlement
  PRIMARY KEY (cup_id, player_id)   -- one entry per player (maxEntriesPerPlayer = 1)
);
CREATE INDEX registrations_state ON registrations(cup_id, state);

-- The seat counter: the CHECK refuses an entry past capacity inside the same transaction as its stake.
CREATE TABLE cup_seats (
  cup_id   TEXT PRIMARY KEY REFERENCES cups(id),
  capacity INTEGER NOT NULL,
  taken    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT seats_full CHECK (taken <= capacity)
);

-- Seeds: committed (SHA-256 published) before the players they will seat are known, revealed afterwards (PRD SE-1).
CREATE TABLE seeds (
  cup_id       TEXT NOT NULL,
  slot         INTEGER NOT NULL,    -- 0 = the registration draw, 1.. = rounds
  commitment   TEXT NOT NULL,
  seed         TEXT,
  committed_at INTEGER NOT NULL,
  revealed_at  INTEGER,
  PRIMARY KEY (cup_id, slot)
);

-- Every table's result, for review and integrity checks (PRD section 10).
CREATE TABLE table_results (
  cup_id      TEXT NOT NULL,
  slot        INTEGER NOT NULL,
  draw        TEXT NOT NULL,        -- W | L | GF
  table_code  TEXT NOT NULL,
  places_json TEXT NOT NULL,        -- player ids, 1st first
  pay1        INTEGER NOT NULL,
  pay2        INTEGER NOT NULL,
  late        INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (cup_id, table_code)
);

-- What the public cup page shows: an estimate at publish, the frozen schedule at check-in close, and live progress.
ALTER TABLE cups ADD COLUMN estimate_json TEXT;
ALTER TABLE cups ADD COLUMN schedule_json TEXT;
ALTER TABLE cups ADD COLUMN live_json TEXT;
ALTER TABLE cups ADD COLUMN cancel_reason TEXT;
