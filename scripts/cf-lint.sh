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

grep -q '"head_sampling_rate"' wrangler.jsonc || { echo "❌ observability.head_sampling_rate missing"; fail=1; }
grep -q 'new_sqlite_classes' wrangler.jsonc || { echo "❌ Durable Objects must use SQLite classes"; fail=1; }
[ $fail -eq 0 ] && echo "✅ cf-lint passed"
exit $fail
