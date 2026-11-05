-- Phase 7 (docs/whot-cup-prd.md PX-4): Web Push subscriptions, the check-in SMS opt-in, and SMS spend outside sign-in codes.

-- One row per browser a player allowed notifications in. id is the SHA-256 of the endpoint, so a browser that
-- subscribes again replaces its row. Endpoints that the push service says are gone (404/410) are deleted.
CREATE TABLE push_subs (
  id         TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id),
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subs_player ON push_subs(player_id);

-- "Text me when check-in opens" (SMS is for check-in only, and only when the player asked).
ALTER TABLE players ADD COLUMN sms_checkin INTEGER NOT NULL DEFAULT 0;

-- Texts that aren't sign-in codes, per Lagos day, so the daily SMS spend cap covers them too.
CREATE TABLE sms_spend (
  day  TEXT NOT NULL,
  kind TEXT NOT NULL,
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
) WITHOUT ROWID;
