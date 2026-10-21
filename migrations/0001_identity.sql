-- Whot Cup identity (docs/whot-cup-prd.md, Phase 1: ID-1 to ID-6, RP-2).
-- Phone numbers never appear in plain text: phone_hmac finds a player, phone_enc (AES-GCM) shows them their own
-- number, phone_last2 is all anyone else ever sees. Times are Unix milliseconds.

CREATE TABLE players (
  id                   TEXT PRIMARY KEY,
  phone_hmac           TEXT NOT NULL UNIQUE,      -- one player per number (ID-2)
  phone_enc            TEXT NOT NULL,
  phone_country        TEXT NOT NULL,
  phone_last2          TEXT NOT NULL,
  name                 TEXT,                      -- null until the player picks one
  avatar_shape         TEXT,
  avatar_color         TEXT,
  adult_at             INTEGER,                   -- when they declared they are 18 or older (ID-4)
  weekly_limit         INTEGER,                   -- entry limit per week in coins; null = none (RP-2)
  weekly_limit_next    INTEGER,                   -- a raise waits 24 hours before it applies
  weekly_limit_next_at INTEGER,
  weekly_limit_next_set INTEGER NOT NULL DEFAULT 0, -- 1 when a pending change exists (next may be null = no limit)
  cool_off_until       INTEGER,                   -- no cup entry before this (RP-2)
  flags                TEXT NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- id is the SHA-256 of the cookie token, so a copy of this table opens no sessions.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id),
  device_id    TEXT NOT NULL,
  ip_hash      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX sessions_player ON sessions(player_id);

-- One row per code sent. Kept 24 hours: it is the rate limiter's memory as well as the code store.
CREATE TABLE otp_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hmac  TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  country     TEXT NOT NULL,
  code_hmac   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used_at     INTEGER,
  superseded  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX otp_phone   ON otp_requests(phone_hmac, created_at);
CREATE INDEX otp_ip      ON otp_requests(ip_hash, created_at);
CREATE INDEX otp_country ON otp_requests(country, created_at);
CREATE INDEX otp_created ON otp_requests(created_at);

-- Dev and test mode only (AUTH_MODE=dev): where the fake SMS sender puts messages. Live mode never writes here.
CREATE TABLE dev_sms_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_hmac TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
