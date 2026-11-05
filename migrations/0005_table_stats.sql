-- Phase 6: cup tables send stats with their result (docs/whot-cup-prd.md TB-5): how the table ended, moves,
-- duration, card points and cards per place, forfeits. Never a card.
ALTER TABLE table_results ADD COLUMN stats_json TEXT;
