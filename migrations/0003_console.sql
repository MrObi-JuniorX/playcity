-- Whot Cup admin console (docs/whot-cup-prd.md, Phase 3: AD-1 to AD-7, section 5).

-- Who may use the console, and as what. Owners manage staff; the first owner comes from the OWNER_PLAYER_IDS var.
CREATE TABLE staff (
  player_id  TEXT PRIMARY KEY REFERENCES players(id),
  roles      TEXT NOT NULL,                 -- comma list of: owner, cup-admin, integrity, finance
  added_by   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Passkeys (WebAuthn) for staff: the second factor on top of the phone session (AD-1).
CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,            -- credential id, base64url
  player_id    TEXT NOT NULL REFERENCES players(id),
  public_key   TEXT NOT NULL,               -- COSE public key, base64url
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,
  name         TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_player ON passkeys(player_id);

-- One-time WebAuthn challenges, deleted when used and by the daily cleanup.
CREATE TABLE webauthn_challenges (
  id         TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- register | login
  challenge  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Console sessions: 8 hours, separate from the player's own session. id is the SHA-256 of the cookie token.
CREATE TABLE console_sessions (
  id         TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id),
  passkey_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE cups (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  state            TEXT NOT NULL,           -- draft | scheduled | registration | closed | check-in | running | finals | settling | settled | paused | cancelled
  config_json      TEXT NOT NULL,
  config_hash      TEXT,                    -- SHA-256 of the canonical config, set on publish
  version          INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency: an edit names the version it read
  published_at     INTEGER,
  published_by     TEXT,
  countersigned_by TEXT,                    -- finance approver, required for naira cups
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_by       TEXT NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX cups_state ON cups(state);

CREATE TABLE cup_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Every console write: who, what, before and after (AD-6). Append-only; kept 2 years.
CREATE TABLE audit (
  id          INTEGER PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  before_json TEXT,
  after_json  TEXT,
  at          INTEGER NOT NULL
);
CREATE INDEX audit_at ON audit(at);
CREATE INDEX audit_target ON audit(target, at);
