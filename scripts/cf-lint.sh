#!/usr/bin/env bash
# Cost and correctness gates for Cloudflare code (docs/cloudflare-cost-protocol.md, tier T1).
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
check() { if grep -rnE "$2" src --include='*.ts' | grep -v 'cf-lint-allow'; then echo "❌ $1"; fail=1; fi; }

check "Use ctx.acceptWebSocket (hibernation), not ws.accept() in a Durable Object" '\b(server|socket)\.accept\(\)'
check "Math.random for IDs/tokens: use crypto" 'Math\.random\(\)'
check "Timers keep a Durable Object awake: use alarms or nothing" '\bset(Interval|Timeout)\('
check "passThroughOnException is banned" 'passThroughOnException'
check "Destructured ctx loses its this binding" 'const \{[^}]*waitUntil[^}]*\} *= *ctx'
check "Outbound WebSocket from a Durable Object blocks hibernation" 'new WebSocket\('
# Relay rooms and the lobby keep everything in socket attachments. A table that must outlive hibernation
# (a card game's hidden hands) may keep one small row, and must delete it when the table empties.
if grep -nE 'storage\.(put|kv|sql|setAlarm)' src/room.ts src/lobby.ts; then echo "❌ Storage in the relay room or lobby: they stay storage-free"; fail=1; fi
for f in $(grep -lE 'storage\.(put|kv\.put|sql\.exec)' src/*.ts); do
  grep -q 'deleteAll' "$f" || { echo "❌ $f stores state but never deletes it (call storage.deleteAll when the table empties)"; fail=1; }
done

# Whot Cup (docs/whot-cup-prd.md): gates hold sockets only, so an idle gate hibernates for free.
if grep -nE 'storage\.|\.sql\.' src/cup/gate.ts; then echo "❌ CupGate stays storage-free: keep state in socket attachments"; fail=1; fi
# Cup tables (Phase 6) keep one row while they run and delete it after the reveal window.
grep -q 'deleteAll' src/cup/table.ts || { echo "❌ src/cup/table.ts must delete its row (storage.deleteAll) when the table closes"; fail=1; }
# No message serialises the game (PRD 8.2 rule 2): views are built from seatView or the public view only.
if grep -nE 'JSON\.stringify\(((t|this\.t)\.)?g\b|JSON\.stringify\((t|this\.t|state)\)' src/cup/table.ts src/cup/tablecore.ts | grep -v 'cf-lint-allow'; then
  echo "❌ A cup table serialises the whole game: build messages from seatView or the public view"; fail=1; fi
# Hidden cards never reach a log (PRD 8.2 rule 4): no hand, market, deck or whole game in a console call.
if grep -rnE 'console\.[a-z]+\(.*(\bhands?\b|\bmarket\b|\bdeck\b|\bt\.g\b|[(,] *g *[,)])' src --include='*.ts' | grep -v 'cf-lint-allow'; then
  echo "❌ A console call mentions cards or a game: log ids and counts only"; fail=1; fi

# Phone numbers never reach a log (PRD T15, S-13).
if grep -rnE 'console\.[a-z]+\(.*\b(phone|e164)\b' src --include='*.ts' | grep -v 'cf-lint-allow'; then echo "❌ A console call mentions a phone number"; fail=1; fi

grep -q '"head_sampling_rate"' wrangler.jsonc || { echo "❌ observability.head_sampling_rate missing"; fail=1; }
grep -q 'new_sqlite_classes' wrangler.jsonc || { echo "❌ Durable Objects must use SQLite classes"; fail=1; }
[ $fail -eq 0 ] && echo "✅ cf-lint passed"
exit $fail
