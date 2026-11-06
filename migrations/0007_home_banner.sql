-- The home page shows a cup's banner only when the console switches it on (owners and cup admins, any time while the
-- cup is published, audited). Not part of the frozen settings: it is a display switch, not a rule of the cup.
ALTER TABLE cups ADD COLUMN promoted INTEGER NOT NULL DEFAULT 0;
