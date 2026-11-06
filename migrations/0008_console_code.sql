-- The temporary console code (src/console/access.ts): wrong tries, kept 24 hours, so a 4-digit code can't be guessed.
CREATE TABLE console_code_attempts (
  id      INTEGER PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX console_code_attempts_at ON console_code_attempts(at);
